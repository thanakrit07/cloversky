import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Instrument } from '@/components/InstrumentSelect'
import { supabase } from './supabase'
import type { TransactionKind } from './transactions'

export interface TransactionShare {
  id: string
  household_id: string
  transaction_id: string
  member_id: string
  share_amount: number
  settled_by_transaction_id: string | null
  created_at: string
}

// One debt between two people, carrying enough of its transaction to list and
// pick items without a second round trip (v_unsettled_shares, migration 0023).
// `debt_kind` is 'split' (a shared expense) or 'borrow' (something personal
// put on someone else's card/account) — the same shape, different story.
export interface UnsettledShare {
  id: string
  household_id: string
  transaction_id: string
  settled_by_transaction_id: string | null
  owes_member_id: string
  owed_member_id: string
  amount: number
  debt_kind: 'split' | 'borrow'
  date: string
  transaction_amount: number
  note: string | null
  description: string
  category_id: string | null
}

// A repayment — really just a `transfer` transaction, read back with the
// debts it covers attached (v_settlements, migration 0023). `id` is that
// transaction's own id: there is no separate settlement record to keep in
// sync with it. `amount` is the cash that actually moved; `gross_amount` is
// everything it cleared; they can only disagree if the transfer was edited
// after the fact.
export interface Settlement {
  id: string
  household_id: string
  settled_on: string
  note: string | null
  created_at: string
  created_by: string | null
  from_member_id: string
  to_member_id: string
  amount: number
  gross_amount: number
  net_cleared: number
  share_count: number
}

export interface ShareRow {
  member_id: string
  share_amount: number
}

// D13/ADR-0002: the application computes and writes a transaction's Split —
// nothing in the database infers one from a null owner anymore (0024).
// `custom` is the Who-bears panel's explicit breakdown (used verbatim, for
// "Just you" — an empty array, the not-a-debt case — as much as for an
// uneven split); omitting it falls back to the heuristic the interactive
// form used before Who-bears existed, still used by the recurring and
// installment materialisers:
//   owner = null, 2+ members   → split evenly, one row per member
//   owner = X, fronted by Y≠X  → X owes the full amount, one row (a borrow)
//   otherwise                  → no rows; nothing is owed
// Income is never split (ADR-0002): the earner owns it outright, no matter
// what owner/fronting/custom combination is passed in.
export function computeShareRows(params: {
  kind: TransactionKind
  ownerId: string | null
  frontingMemberId: string | null
  amount: number
  memberIds: string[]
  custom?: ShareRow[]
}): ShareRow[] {
  const { kind, ownerId, frontingMemberId, amount, memberIds, custom } = params
  if (kind !== 'expense') return []
  if (custom) return custom.filter((r) => r.share_amount > 0)

  if (ownerId === null) {
    if (memberIds.length < 2) return []
    const totalCents = Math.round(amount * 100)
    const base = Math.floor(totalCents / memberIds.length)
    const remainder = totalCents - base * memberIds.length
    // A remainder cent short of dividing evenly (e.g. ฿0.01 between two
    // people) would otherwise produce a zero-amount row that fails the
    // table's positive-amount check without changing the total.
    return memberIds
      .map((id, i) => ({ member_id: id, share_amount: (base + (i < remainder ? 1 : 0)) / 100 }))
      .filter((r) => r.share_amount > 0)
  }

  if (frontingMemberId !== null && frontingMemberId !== ownerId) {
    return [{ member_id: ownerId, share_amount: amount }]
  }

  return []
}

// A Recurring Rule's or Installment Plan's own Custom split (0026): ratios,
// not fixed amounts, because a plan's periods don't all charge the same
// figure (the final period absorbs a rounding remainder, ADR-0001) and a
// rule's own amount can vary occurrence to occurrence — applying the same
// ratios to whatever a given period/occurrence actually charges is what
// keeps every instance proportional to the one the plan was set up with.
export interface RatioSplit {
  member_id: string
  ratio: number
}

// The save gate for a Custom split: `null` (the heuristic path) is always
// valid; a real split's ratios must actually sum to the whole thing. Without
// this, a mistyped Custom entry saves the plan successfully and then fails
// silently at every period — the materialiser only logs a sum-mismatch
// error (the database's own check, 0022), never surfaces it to the user.
export function isValidSplit(split: RatioSplit[] | null): boolean {
  if (split === null) return true
  if (split.length === 0) return false
  const sum = split.reduce((s, r) => s + r.ratio, 0)
  return Math.abs(sum - 1) < 0.001
}

// Largest-remainder method: floor every member's cents, then hand the
// leftover cents one at a time to whoever's floor cut the most off their
// share — fairer than always crediting the same position, and still exact
// (every period's shares sum to that period's own amount, ADR-0001).
export function applyRatioSplit(split: RatioSplit[], amount: number): ShareRow[] {
  if (split.length === 0) return []
  const totalCents = Math.round(amount * 100)
  const raw = split.map((s) => totalCents * s.ratio)
  const cents = raw.map(Math.floor)
  let remainder = totalCents - cents.reduce((sum, c) => sum + c, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - cents[i] }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (remainder <= 0) break
    cents[i] += 1
    remainder -= 1
  }
  return split
    .map((s, i) => ({ member_id: s.member_id, share_amount: cents[i] / 100 }))
    .filter((r) => r.share_amount > 0)
}

// A Split carried over to a new amount: each member keeps the same fraction of
// the whole, so a custom 70/30 stays 70/30 and a borrow stays the full amount.
// For a recurring occurrence whose amount was a guess (variable_amount) until
// the statement said what was actually charged. No rows in, no rows out.
export function rescaleShares(shares: ShareRow[], fromAmount: number, toAmount: number): ShareRow[] {
  if (shares.length === 0 || fromAmount <= 0) return []
  return applyRatioSplit(
    shares.map((s) => ({ member_id: s.member_id, ratio: s.share_amount / fromAmount })),
    toAmount,
  )
}

// Replaces a transaction's Split with a freshly computed one. A share that
// is already settled blocks the delete (the guard trigger in 0024) rather
// than silently rewriting a repayment's basis — that's left exactly as it
// was, and the caller's other field changes (note, category, ...) still go
// through since this runs after the transaction row itself is saved.
export async function syncTransactionShares(params: {
  householdId: string
  transactionId: string
  kind: TransactionKind
  ownerId: string | null
  frontingMemberId: string | null
  amount: number
  memberIds: string[]
  custom?: ShareRow[]
}): Promise<void> {
  const rows = computeShareRows(params)

  const { error: deleteError } = await supabase.from('transaction_shares').delete().eq('transaction_id', params.transactionId)
  if (deleteError) {
    if (deleteError.message.includes('settled up')) return
    throw deleteError
  }
  if (rows.length === 0) return

  const { error: insertError } = await supabase.from('transaction_shares').insert(
    rows.map((r) => ({ household_id: params.householdId, transaction_id: params.transactionId, ...r })),
  )
  if (insertError) throw insertError
}

const SHARE_KEYS = ['transaction_shares', 'unsettled_shares', 'settlements', 'cleared_items'] as const

// Exported for syncTransactionShares' own callers: that function is a plain
// async write, not a mutation hook, so it can't invalidate its own cache —
// the caller has to, or the split rows it just wrote are invisible (no
// "shared with" dots, no unsettled total) until something unrelated
// happens to refetch the query, e.g. switching tabs.
export function invalidateShareQueries(queryClient: ReturnType<typeof useQueryClient>, householdId: string) {
  for (const key of SHARE_KEYS) queryClient.invalidateQueries({ queryKey: [key, householdId] })
  // A repayment or an exemption toggle is itself a transactions write, so the
  // ledger and any screen reading it (day totals, card cycles) must refresh.
  queryClient.invalidateQueries({ queryKey: ['transactions', householdId] })
}

export function useTransactionShares(householdId: string) {
  return useQuery({
    queryKey: ['transaction_shares', householdId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_transaction_shares')
        .select('id, household_id, transaction_id, member_id, share_amount, settled_by_transaction_id, created_at')
        .eq('household_id', householdId)
      if (error) throw error
      return data as TransactionShare[]
    },
  })
}

export function useUnsettledShares(householdId: string) {
  return useQuery({
    queryKey: ['unsettled_shares', householdId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_unsettled_shares')
        .select(
          'id, household_id, transaction_id, settled_by_transaction_id, owes_member_id, owed_member_id, amount, debt_kind, date, transaction_amount, note, description, category_id',
        )
        .eq('household_id', householdId)
        .order('date', { ascending: false })
      if (error) throw error
      return data as UnsettledShare[]
    },
  })
}

// The log — every repayment, newest first, undoable.
export function useSettlements(householdId: string) {
  return useQuery({
    queryKey: ['settlements', householdId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_settlements')
        .select(
          'id, household_id, settled_on, note, created_at, created_by, from_member_id, to_member_id, amount, gross_amount, net_cleared, share_count',
        )
        .eq('household_id', householdId)
        .order('settled_on', { ascending: false })
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as Settlement[]
    },
  })
}

export const SETTLE_KEY_PREFIX = 'settle:'
export const isSettleKey = (key: string | null | undefined) => Boolean(key?.startsWith(SETTLE_KEY_PREFIX))

export interface TransferLike {
  id: string
  date: string
  amount: number
  note: string | null
  description: string
  from_account_id: string | null
  from_card_id: string | null
  to_account_id: string | null
  to_card_id: string | null
}

/**
 * Transfers already in the ledger that could stand as a repayment from one
 * member to another: from an instrument of the payer's to one of the payee's,
 * and not already clearing something. Newest first.
 */
export function repaymentCandidates<T extends TransferLike>(
  transfers: T[],
  ownerOf: (accountId: string | null, cardId: string | null) => string | null,
  payerId: string,
  payeeId: string,
  alreadyUsed: ReadonlySet<string>,
): T[] {
  return transfers
    .filter((t) => !alreadyUsed.has(t.id) && ownerOf(t.from_account_id, t.from_card_id) === payerId && ownerOf(t.to_account_id, t.to_card_id) === payeeId)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

// Points the chosen debts at a transfer that already exists, instead of making
// a new one: a repayment is a real transfer either way, and the ledger stays the
// only record. The amount may differ from what the debts come to (ADR-0003).
export function useLinkRepayment(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { shareIds: string[]; transactionId: string }) => {
      const { error } = await supabase
        .from('transaction_shares')
        .update({ settled_by_transaction_id: input.transactionId })
        .in('id', input.shareIds)
      if (error) throw error
    },
    onSuccess: () => invalidateShareQueries(queryClient, householdId),
  })
}

export interface ClearedItem {
  id: string
  settled_by_transaction_id: string
  amount: number
  date: string
  debt_kind: 'split' | 'borrow'
  note: string | null
  description: string
  category_id: string | null
  owes_member_id: string
}

/** What each repayment cleared: the debts that point at it, so an item knows which payment settled it. */
export function useClearedItems(householdId: string, transferIds: string[]) {
  return useQuery({
    queryKey: ['cleared_items', householdId, transferIds],
    enabled: transferIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_share_debts')
        .select('id, settled_by_transaction_id, amount, date, debt_kind, note, description, category_id, owes_member_id')
        .eq('household_id', householdId)
        .in('settled_by_transaction_id', transferIds)
        .order('date', { ascending: false })
      if (error) throw error
      return data as ClearedItem[]
    },
  })
}

// Records a repayment by creating a real transfer transaction and pointing
// the chosen shares at it — the transfer *is* the settlement record, so it
// shows up in the ledger like any other movement of money and there's
// nothing else that could drift from it. `fromMemberId` must be the owner of
// `from` (the transaction's own `owner_id`); the caller works that out from
// whichever side of the selection came out heavier.
export function useRecordRepayment(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      shareIds: string[]
      fromMemberId: string
      from: Instrument
      to: Instrument
      amount: number
      date: string
      note: string | null
    }) => {
      const { data, error } = await supabase
        .from('transactions')
        .insert({
          household_id: householdId,
          date: input.date,
          kind: 'transfer',
          category_id: null,
          category_kind: null,
          description: '',
          amount: input.amount,
          owner_id: input.fromMemberId,
          from_account_id: input.from.accountId,
          from_card_id: input.from.cardId,
          to_account_id: input.to.accountId,
          to_card_id: input.to.cardId,
          note: input.note,
          // Marks this transfer as made by Settle up, so Undo knows it may delete it;
          // a transfer that was already in the ledger and merely linked is only unlinked.
          source_key: `${SETTLE_KEY_PREFIX}${crypto.randomUUID()}`,
        })
        .select('id')
        .single()
      if (error) throw error
      const transactionId = data.id as string

      const { error: linkError } = await supabase
        .from('transaction_shares')
        .update({ settled_by_transaction_id: transactionId })
        .in('id', input.shareIds)
      if (linkError) {
        // Leaving the transfer behind would show up in the ledger as a
        // payment that cleared nothing, so undo it rather than half-commit.
        await supabase.from('transactions').delete().eq('id', transactionId)
        throw linkError
      }
      return transactionId
    },
    onSuccess: () => invalidateShareQueries(queryClient, householdId),
  })
}

// Undo: soft-deleting the transfer is enough — v_unsettled_shares ignores a
// settled_by_transaction_id whose transaction is gone, so every share it
// covered goes back to owed on its own.
export function useUndoRepayment(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (transactionId: string) => {
      const { data: transfer, error: readError } = await supabase.from('transactions').select('source_key').eq('id', transactionId).single()
      if (readError) throw readError
      // Whatever the transfer is, the debts it cleared go back to owed.
      const { error: unlinkError } = await supabase
        .from('transaction_shares')
        .update({ settled_by_transaction_id: null })
        .eq('settled_by_transaction_id', transactionId)
      if (unlinkError) throw unlinkError
      // Only a transfer Settle up itself made is deleted: one that was already in the
      // ledger (a bank line, say) is real money that moved, and stays.
      if (isSettleKey(transfer.source_key)) {
        const { error } = await supabase.from('transactions').update({ deleted_at: new Date().toISOString() }).eq('id', transactionId)
        if (error) throw error
      }
    },
    onSuccess: () => invalidateShareQueries(queryClient, householdId),
  })
}
