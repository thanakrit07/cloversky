import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { CategoryKind } from './categories'

export type TransactionKind = 'income' | 'expense' | 'transfer'

// 'reconcile': a Balance Adjustment (see balanceAdjustments.ts) — the
// household confirmed an instrument's real balance and the difference from
// what the ledger predicted became this transaction, rather than a silently
// moved anchor. Every other source predates that and is unrelated to it.
export type TransactionSource = 'manual' | 'recurring' | 'installment' | 'import' | 'reconcile'

export interface Transaction {
  id: string
  household_id: string
  date: string
  kind: TransactionKind
  category_id: string | null
  category_kind: CategoryKind | null
  description: string
  amount: number
  owner_id: string | null
  from_account_id: string | null
  from_card_id: string | null
  to_account_id: string | null
  to_card_id: string | null
  note: string | null
  confirmed: boolean
  source: TransactionSource
  source_key: string | null
  /** D22: set when this transaction is one line of a Receipt (ADR-0015). */
  receipt_id: string | null
  /** When a statement says the bank posted it; decides a card row's billing cycle (ADR-0019). */
  posted_date: string | null
  /** The recurring rule this row is an occurrence of — posted by it, or adopted when the rule was made from it. */
  recurring_rule_id: string | null
}

export interface TransactionInput {
  date: string
  kind: TransactionKind
  categoryId: string | null
  categoryKind: CategoryKind | null
  description: string
  amount: number
  ownerId: string | null
  fromAccountId: string | null
  fromCardId: string | null
  toAccountId: string | null
  toCardId: string | null
  note: string | null
  /** Defaults to 'manual' at the DB level when omitted. */
  source?: TransactionSource
}

function toRow(householdId: string, input: TransactionInput) {
  return {
    household_id: householdId,
    date: input.date,
    kind: input.kind,
    category_id: input.categoryId,
    category_kind: input.categoryKind,
    description: input.description,
    amount: input.amount,
    owner_id: input.ownerId,
    from_account_id: input.fromAccountId,
    from_card_id: input.fromCardId,
    to_account_id: input.toAccountId,
    to_card_id: input.toCardId,
    note: input.note,
    ...(input.source ? { source: input.source } : {}),
  }
}

export function useTransactions(householdId: string, range: { start: string; end: string }) {
  return useQuery({
    queryKey: ['transactions', householdId, range.start, range.end],
    // An empty bound (a screen with nothing to show yet) is a 400 from PostgREST, not "no rows".
    enabled: Boolean(range.start && range.end),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_transactions')
        .select(
          'id, household_id, date, kind, category_id, category_kind, description, amount, owner_id, from_account_id, from_card_id, to_account_id, to_card_id, note, confirmed, source, source_key, receipt_id, posted_date, recurring_rule_id',
        )
        .eq('household_id', householdId)
        .gte('date', range.start)
        .lte('date', range.end)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as Transaction[]
    },
  })
}

export function useCreateTransaction(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // Returns the new row's id so the caller can offer undo (soft delete).
    mutationFn: async (input: TransactionInput) => {
      const { data, error } = await supabase
        .from('transactions')
        .insert(toRow(householdId, input))
        .select('id')
        .single()
      if (error) throw error
      return data.id as string
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', householdId] }),
  })
}

export function useUpdateTransaction(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // `confirm: true` additionally marks a generated (unconfirmed) row as
    // reviewed — editing an amount in the review strip confirms it (§6.6).
    mutationFn: async ({ id, input, confirm }: { id: string; input: TransactionInput; confirm?: boolean }) => {
      const row = { ...toRow(householdId, input), ...(confirm ? { confirmed: true } : {}) }
      const { error } = await supabase.from('transactions').update(row).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', householdId] }),
  })
}

// Generated rows awaiting review (§6.6) — not limited to the visible
// month, so a missed review from last month still surfaces.
export function useUnconfirmedTransactions(householdId: string) {
  return useQuery({
    queryKey: ['transactions', householdId, 'unconfirmed'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_transactions')
        .select(
          'id, household_id, date, kind, category_id, category_kind, description, amount, owner_id, from_account_id, from_card_id, to_account_id, to_card_id, note, confirmed, source, source_key, receipt_id, posted_date, recurring_rule_id',
        )
        .eq('household_id', householdId)
        .eq('confirmed', false)
        .order('date')
      if (error) throw error
      return data as Transaction[]
    },
  })
}

export function useConfirmTransaction(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('transactions').update({ confirmed: true }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', householdId] }),
  })
}

// v3.9: a fixed-amount subscription has nothing to review, so the strip can
// clear itself in one tap instead of one-by-one.
export function useConfirmAllTransactions(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('transactions')
        .update({ confirmed: true })
        .eq('household_id', householdId)
        .eq('confirmed', false)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', householdId] }),
  })
}

export function useDeleteTransaction(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('transactions').update({ deleted_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', householdId] }),
  })
}
