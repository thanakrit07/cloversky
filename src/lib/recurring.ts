import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { occurrencesBetween } from './finance/recurrence'
import type { RecurrenceFreq, MonthEndRule } from './finance/recurrence'
import { supabase } from './supabase'
import type { CategoryKind } from './categories'
import type { TransactionKind } from './transactions'
import { applyRatioSplit, computeShareRows, type RatioSplit } from './transactionShares'

export interface RecurringRule {
  id: string
  household_id: string
  name: string
  kind: TransactionKind
  category_id: string | null
  category_kind: CategoryKind | null
  amount: number
  owner_id: string | null
  from_account_id: string | null
  from_card_id: string | null
  to_account_id: string | null
  to_card_id: string | null
  note: string | null
  freq: RecurrenceFreq
  interval: number
  day_of_month: number | null
  month_of_year: number | null
  weekday: number | null
  month_end: MonthEndRule
  start_date: string
  end_date: string | null
  max_occurrences: number | null
  auto_post: boolean
  variable_amount: boolean
  active: boolean
  last_generated_date: string | null
  // A Custom split (0026), ratios summing to 1; null keeps the rule on the
  // owner_id heuristic (D13's other three cases) unchanged.
  split: RatioSplit[] | null
}

const RULE_COLUMNS =
  'id, household_id, name, kind, category_id, category_kind, amount, owner_id, from_account_id, from_card_id, to_account_id, to_card_id, note, freq, interval, day_of_month, month_of_year, weekday, month_end, start_date, end_date, max_occurrences, auto_post, variable_amount, active, last_generated_date, split'

export function useRecurringRules(householdId: string) {
  return useQuery({
    queryKey: ['recurring_rules', householdId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_recurring_rules')
        .select(RULE_COLUMNS)
        .eq('household_id', householdId)
        .order('name')
      if (error) throw error
      return data as RecurringRule[]
    },
  })
}

export type RecurringRuleInput = Omit<RecurringRule, 'id' | 'household_id' | 'last_generated_date'>

/**
 * A transaction already in the ledger that a new rule takes as one of its
 * own occurrences — typically a statement line, turned into a rule from the
 * row itself. The rule starts generating only after it, so neither it nor
 * anything before it is posted a second time.
 */
export interface AdoptedOccurrence {
  transactionId: string
  date: string
}

export function useCreateRecurringRule(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ input, adopts }: { input: RecurringRuleInput; adopts?: AdoptedOccurrence }) => {
      const { data, error } = await supabase
        .from('recurring_rules')
        // The watermark is what materialiseDue resumes from: set to the
        // adopted row's date, the past stays the ledger's.
        .insert({ household_id: householdId, ...input, ...(adopts ? { last_generated_date: adopts.date } : {}) })
        .select('id')
        .single()
      if (error) throw error
      if (adopts) {
        const { error: linkError } = await supabase
          .from('transactions')
          .update({ recurring_rule_id: data.id, occurrence_date: adopts.date })
          .eq('id', adopts.transactionId)
        // The rule exists either way; only the link is left to retry by hand.
        if (linkError) return { linkError: linkError.message }
      }
      return { linkError: null }
    },
    onSuccess: (_data, { adopts }) => {
      queryClient.invalidateQueries({ queryKey: ['recurring_rules', householdId] })
      if (adopts) queryClient.invalidateQueries({ queryKey: ['transactions', householdId] })
    },
  })
}

export function useUpdateRecurringRule(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: Partial<RecurringRuleInput> }) => {
      const { error } = await supabase.from('recurring_rules').update(input).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recurring_rules', householdId] }),
  })
}

export function useDeleteRecurringRule(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // Soft delete; already-materialised transactions are ordinary rows and
    // stay untouched (DESIGN §6.6 "keep past entries").
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('recurring_rules')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recurring_rules', householdId] }),
  })
}

function addOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y, m - 1, d + 1)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

/**
 * Materialise every occurrence due up to `today` that doesn't exist yet
 * (DESIGN §6.6). Concurrency-safe: the unique (recurring_rule_id,
 * occurrence_date) constraint plus ignoreDuplicates makes double-runs
 * harmless, so this can fire from both phones at once.
 * Returns the number of dates processed (an upper bound on rows created).
 */
export async function materialiseDue(householdId: string, rules: RecurringRule[], today: string): Promise<number> {
  const activeRules = rules.filter((r) => r.active)
  if (activeRules.length === 0) return 0

  // Fetched once for the whole run, not per rule: D13's Split needs to know
  // who fronted the money (an instrument's owner) and who's in the
  // household, and a shared/borrowed rule can occur for any of them.
  const [{ data: members, error: membersError }, { data: cards, error: cardsError }, { data: accounts, error: accountsError }] =
    await Promise.all([
      supabase.from('household_members').select('id').eq('household_id', householdId),
      supabase.from('cards').select('id, owner_id').eq('household_id', householdId),
      supabase.from('accounts').select('id, owner_id').eq('household_id', householdId),
    ])
  if (membersError) throw membersError
  if (cardsError) throw cardsError
  if (accountsError) throw accountsError
  const memberIds = (members ?? []).map((m) => m.id as string)
  const cardOwner = new Map((cards ?? []).map((c) => [c.id as string, c.owner_id as string | null]))
  const accountOwner = new Map((accounts ?? []).map((a) => [a.id as string, a.owner_id as string | null]))

  let generated = 0
  for (const rule of activeRules) {
    const from = rule.last_generated_date ? addOneDay(rule.last_generated_date) : rule.start_date
    if (from <= today) {
      const dates = occurrencesBetween(rule, from, today)
      if (dates.length > 0) {
        const rows = dates.map((date) => ({
          household_id: householdId,
          date,
          kind: rule.kind,
          category_id: rule.category_id,
          category_kind: rule.category_kind,
          amount: rule.amount,
          owner_id: rule.owner_id,
          from_account_id: rule.from_account_id,
          from_card_id: rule.from_card_id,
          to_account_id: rule.to_account_id,
          to_card_id: rule.to_card_id,
          // note is the ledger's primary label (0020): the rule's name is what
          // the ledger should show. The rule's own note becomes secondary
          // detail — description is NOT NULL, so `?? ''` rather than leaving
          // it undefined (this row's key set must stay uniform with the rest
          // of the batch; description can't be conditionally omitted here).
          note: rule.name,
          description: rule.note ?? '',
          source: 'recurring' as const,
          recurring_rule_id: rule.id,
          occurrence_date: date,
          // auto_post + fixed amount → counts immediately; anything variable
          // (or not auto-posted) waits in the review strip (§6.6).
          confirmed: rule.auto_post && !rule.variable_amount,
        }))
        // .select() after ignoreDuplicates returns only the rows genuinely
        // inserted this run — exactly the set that needs a fresh Split,
        // since an already-materialised occurrence keeps whatever Split it
        // already has (D13: the app owns those rows after they're written).
        const { data: inserted, error } = await supabase
          .from('transactions')
          .upsert(rows, { onConflict: 'recurring_rule_id,occurrence_date', ignoreDuplicates: true })
          .select('id')
        if (error) throw error
        generated += dates.length

        const frontingMemberId = rule.from_account_id
          ? (accountOwner.get(rule.from_account_id) ?? null)
          : rule.from_card_id
            ? (cardOwner.get(rule.from_card_id) ?? null)
            : null
        const shareRows = computeShareRows({
          kind: rule.kind,
          ownerId: rule.owner_id,
          frontingMemberId,
          amount: rule.amount,
          memberIds,
          custom: rule.split ? applyRatioSplit(rule.split, rule.amount) : undefined,
        })
        if (shareRows.length > 0 && inserted && inserted.length > 0) {
          const { error: shareError } = await supabase.from('transaction_shares').insert(
            inserted.flatMap((t) => shareRows.map((r) => ({ household_id: householdId, transaction_id: t.id as string, ...r }))),
          )
          if (shareError) throw shareError
        }
      }
    }

    const { error: watermarkError } = await supabase
      .from('recurring_rules')
      .update({ last_generated_date: today })
      .eq('id', rule.id)
    if (watermarkError) throw watermarkError
  }
  return generated
}
