import { periodDate } from './finance/billingCycle'
import type { Installment } from './installments'
import { supabase } from './supabase'
import { applyRatioSplit, computeShareRows } from './transactionShares'

// DESIGN.md §6.7/§4.5 (D11): an installment plan writes **every** period as
// a real transaction the moment the plan exists — not just the periods due
// so far. A 10-period plan is ten known, dated, unavoidable charges; hiding
// the future ones made them invisible in the months they actually land,
// which is the whole reason a plan is entered in the first place.
//
// Whether a period has been *settled* is a separate question from whether it
// has been *posted*: settlement is an `installment_payments` event, written
// by ticking the period's checkbox in the ledger (card-billed plans) or the
// "mark period paid" button (account-billed). So the materialiser never
// writes payment rows — it only posts the charge.
//
// Idempotency: each posted period gets source_key = "installment:<id>:<n>",
// covered by the (household_id, source_key) unique constraint (0014), so a
// concurrent run from the other phone resolves to a no-op rather than a
// duplicate charge.

/** The `source_key` a given period's transaction carries. */
export function periodSourceKey(installmentId: string, periodNo: number): string {
  return `${periodSourceKeyPrefix(installmentId)}${periodNo}`
}

/** The period's interest line (0036), posted beside it. */
export function interestSourceKey(installmentId: string, periodNo: number): string {
  return `${periodSourceKey(installmentId, periodNo)}:interest`
}

/** Every period of one plan, for a prefix match on `source_key`. */
export function periodSourceKeyPrefix(installmentId: string): string {
  return `installment:${installmentId}:`
}

/** Inverse of `periodSourceKey`; null when the key isn't an installment one. */
export function parsePeriodSourceKey(
  sourceKey: string | null,
): { installmentId: string; periodNo: number; interest: boolean } | null {
  if (!sourceKey) return null
  const [tag, installmentId, periodNoStr, part] = sourceKey.split(':')
  if (tag !== 'installment' || !installmentId) return null
  const periodNo = Number(periodNoStr)
  return Number.isFinite(periodNo) ? { installmentId, periodNo, interest: part === 'interest' } : null
}

export async function materialiseInstallmentsDue(
  householdId: string,
  installments: Installment[],
): Promise<number> {
  const active = installments.filter((i) => i.status === 'active' && (i.card_id || i.account_id))
  if (active.length === 0) return 0

  const [{ data: existing, error: existingError }, { data: members, error: membersError }, { data: cards, error: cardsError }, { data: accounts, error: accountsError }] =
    await Promise.all([
      supabase.from('transactions').select('source_key').eq('household_id', householdId).eq('source', 'installment').is('deleted_at', null),
      supabase.from('household_members').select('id').eq('household_id', householdId),
      supabase.from('cards').select('id, owner_id').eq('household_id', householdId),
      supabase.from('accounts').select('id, owner_id').eq('household_id', householdId),
    ])
  if (existingError) throw existingError
  if (membersError) throw membersError
  if (cardsError) throw cardsError
  if (accountsError) throw accountsError

  const postedSet = new Set((existing ?? []).map((t) => t.source_key as string))
  // D13: who fronted the money for each plan's own instrument, and who's in
  // the household to split between — fetched once, reused for every period
  // of every plan in this run.
  const memberIds = (members ?? []).map((m) => m.id as string)
  const cardOwner = new Map((cards ?? []).map((c) => [c.id as string, c.owner_id as string | null]))
  const accountOwner = new Map((accounts ?? []).map((a) => [a.id as string, a.owner_id as string | null]))

  let posted = 0
  for (const inst of active) {
    const cardBilled = Boolean(inst.card_id)

    // An expense must carry a category (transactions' category_iff_not_transfer
    // check), but a plan can be saved without one. Skipping the plan keeps a
    // single un-categorised plan from failing the batch and stalling posting
    // for every other plan — which is exactly what happened in production.
    if (!inst.category_id) {
      console.warn(`Installment "${inst.name}" has no category; its periods cannot post until one is set.`)
      continue
    }

    const rows: Record<string, unknown>[] = []
    for (let n = 1; n <= inst.total_periods; n++) {
      // The card's interest line for the period (0036), as its own row so the
      // ledger reads like the statement. Checked on its own key: a plan made
      // before 0036 never posted one, and a period posted already keeps its own.
      const interestKey = interestSourceKey(inst.id, n)
      if (inst.period_interest && !postedSet.has(interestKey)) {
        rows.push({
          household_id: householdId,
          date: periodDate(inst.start_date, n),
          kind: 'expense',
          category_id: inst.category_id,
          category_kind: 'expense',
          note: null,
          amount: inst.period_interest,
          owner_id: inst.owner_id,
          from_card_id: cardBilled ? inst.card_id : null,
          from_account_id: cardBilled ? null : inst.account_id,
          source: 'installment',
          source_key: interestKey,
          confirmed: true,
        })
      }

      const sourceKey = periodSourceKey(inst.id, n)
      if (postedSet.has(sourceKey)) continue

      rows.push({
        household_id: householdId,
        date: periodDate(inst.start_date, n),
        kind: 'expense',
        category_id: inst.category_id,
        category_kind: 'expense',
        // note, not description: note is the ledger's primary label (0020).
        // No description key here — every row in this batch omits it
        // uniformly, so PostgREST leaves the column to its NOT NULL default
        // rather than sending an explicit null.
        // No note. ADR-0016: the label is composed at render time from the
        // plan and this row's source_key, so writing it here would put a
        // stale copy of the plan's name in a column the user also types
        // into — which is precisely what made a rename need propagating.
        // `note` now belongs to the user alone.
        note: null,
        amount: n === inst.total_periods && inst.final_amount != null ? inst.final_amount : inst.monthly_amount,
        owner_id: inst.owner_id,
        from_card_id: cardBilled ? inst.card_id : null,
        from_account_id: cardBilled ? null : inst.account_id,
        source: 'installment',
        source_key: sourceKey,
        // Posted, not settled — these are scheduled charges the user already
        // committed to, so they don't need a second review tap. The paid
        // checkbox is what tracks settlement.
        confirmed: true,
      })
    }

    if (rows.length === 0) continue

    // Per plan, not one batch for all: a row Postgres refuses aborts the whole
    // statement, so batching every plan together lets one bad plan block
    // posting for all of them. upsert-ignore rather than insert because a
    // period may have been posted by the other device mid-run. .select()
    // after ignoreDuplicates returns only the periods genuinely posted this
    // run — the only ones that need a fresh Split (D13).
    const { data: inserted, error } = await supabase
      .from('transactions')
      .upsert(rows, { onConflict: 'household_id,source_key', ignoreDuplicates: true })
      .select('id, source_key')
    if (error) {
      console.error(`Could not post periods for installment "${inst.name}"`, error)
      continue
    }
    posted += rows.length

    const frontingMemberId = cardBilled
      ? (cardOwner.get(inst.card_id as string) ?? null)
      : (accountOwner.get(inst.account_id as string) ?? null)
    const amountBySourceKey = new Map(rows.map((r) => [r.source_key as string, r.amount as number]))
    const shareRowsToInsert = (inserted ?? []).flatMap((t) => {
      const amount = amountBySourceKey.get(t.source_key as string)
      if (amount == null) return []
      return computeShareRows({
        kind: 'expense',
        ownerId: inst.owner_id,
        frontingMemberId,
        amount,
        memberIds,
        // Applied per period, not once for the plan: the final period's
        // amount differs (ADR-0001's rounding remainder), and each period
        // must stay proportional to what it actually charges, not to the
        // plan's nominal monthly figure.
        custom: inst.split ? applyRatioSplit(inst.split, amount) : undefined,
      }).map((r) => ({
        household_id: householdId,
        transaction_id: t.id as string,
        ...r,
      }))
    })
    if (shareRowsToInsert.length > 0) {
      const { error: shareError } = await supabase.from('transaction_shares').insert(shareRowsToInsert)
      if (shareError) console.error(`Could not write shares for installment "${inst.name}"`, shareError)
    }
  }

  return posted
}
