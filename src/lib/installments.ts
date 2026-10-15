import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parsePeriodSourceKey, periodSourceKey } from './installmentMaterialiser'
import { supabase } from './supabase'
import type { LabelledPlan } from './installmentLabel'
import type { RatioSplit } from './transactionShares'

export type InstallmentStatus = 'active' | 'done' | 'cancelled'

// Ticking a period twice (two devices, double tap) is a no-op, not an error.
const UNIQUE_VIOLATION = '23505'

export interface Installment {
  id: string
  household_id: string
  name: string
  category_id: string | null
  start_date: string
  total_periods: number
  monthly_amount: number
  final_amount: number | null
  card_id: string | null
  account_id: string | null
  annual_interest_rate: number
  /** The card's interest line each period, posted as its own row (0036); null = monthly_amount is everything. */
  period_interest: number | null
  is_cash_advance: boolean
  owner_id: string | null
  note: string | null
  status: InstallmentStatus
  // A Custom split (0026), ratios summing to 1; null keeps the plan on the
  // owner_id heuristic (D13's other three cases) unchanged.
  split: RatioSplit[] | null
}

export interface InstallmentPayment {
  id: string
  installment_id: string
  period_no: number
  paid_date: string
  transaction_id: string | null
}

const INSTALLMENT_COLUMNS =
  'id, household_id, name, category_id, start_date, total_periods, monthly_amount, final_amount, card_id, account_id, annual_interest_rate, is_cash_advance, owner_id, note, status, split, period_interest'

export function useInstallments(householdId: string) {
  return useQuery({
    queryKey: ['installments', householdId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_installments')
        .select(INSTALLMENT_COLUMNS)
        .eq('household_id', householdId)
        .order('start_date', { ascending: false })
      if (error) throw error
      return data as Installment[]
    },
  })
}

export function useInstallmentPayments(householdId: string) {
  return useQuery({
    queryKey: ['installment_payments', householdId],
    queryFn: async () => {
      // installment_payments has no household_id filter needed at the app
      // layer since RLS already scopes it, but we still join through
      // installments to keep the query shape simple for the client.
      const { data, error } = await supabase
        .from('installment_payments')
        .select('id, installment_id, period_no, paid_date, transaction_id')
      if (error) throw error
      return data as InstallmentPayment[]
    },
  })
}

/**
 * What the query stores: a plain object, because query data is persisted to
 * localStorage as JSON (see queryClient.ts) and `JSON.stringify(new Set())`
 * is `{}` — the rehydrated value would have no `.has`.
 * **Everything a queryFn returns must survive a JSON round-trip.**
 */
export type PostedPeriodsData = Record<string, string>

/** What callers get — Set/Map rebuilt per observer by `select`, never persisted. */
export interface PostedPeriods {
  /** "<installmentId>:<periodNo>" keys — `cycleBill`'s double-count guard. */
  keys: ReadonlySet<string>
  /** Same keys → the id of the transaction that posted that period. */
  transactionIdByKey: ReadonlyMap<string, string>
}

// Module scope so the identity is stable across renders; React Query skips
// re-running select when neither the data nor the function changed.
export function toPostedPeriods(data: PostedPeriodsData): PostedPeriods {
  return {
    keys: new Set(Object.keys(data)),
    transactionIdByKey: new Map(Object.entries(data)),
  }
}

/**
 * Which periods already exist as transactions.
 *
 * Derived from the transactions themselves, not from `installment_payments`:
 * since D11 every period is posted up front but only *settled* periods have
 * a payment row, so the two sets are no longer the same thing.
 */
export function usePostedPeriods(householdId: string) {
  return useQuery({
    queryKey: ['installment_posted_periods', householdId],
    select: toPostedPeriods,
    queryFn: async (): Promise<PostedPeriodsData> => {
      const { data, error } = await supabase
        .from('v_transactions')
        .select('id, source_key')
        .eq('household_id', householdId)
        .eq('source', 'installment')
      if (error) throw error
      const transactionIdByKey: PostedPeriodsData = {}
      for (const row of data ?? []) {
        const parsed = parsePeriodSourceKey(row.source_key as string | null)
        // The interest row posts with its period, so the period's key stands for both.
        if (!parsed || parsed.interest) continue
        transactionIdByKey[`${parsed.installmentId}:${parsed.periodNo}`] = row.id as string
      }
      return transactionIdByKey
    },
    // initialData keeps callers from having to handle undefined (they call
    // .has on every render). initialDataUpdatedAt: 0 is what stops it being
    // treated as fresh for staleTime — without it the empty set stands for
    // 30s after load, and cycleBill projects every period on top of the real
    // transactions it should have suppressed, inflating every card bill.
    initialData: {},
    initialDataUpdatedAt: 0,
  })
}

/**
 * Plan names and period counts, for labelling posted periods (ADR-0016).
 *
 * Reads the **base table, not `v_installments`**, so soft-deleted plans are
 * included. D15 leaves a plan's settled periods in the ledger when the plan
 * itself is deleted; the view filters `deleted_at`, so labelling from it would
 * blank the name on exactly those rows — history losing its description
 * because the plan that explains it was tidied away.
 */
export type InstallmentLabelsData = Record<string, LabelledPlan>

export function toPlanMap(data: InstallmentLabelsData): ReadonlyMap<string, LabelledPlan> {
  return new Map(Object.entries(data))
}

export function useInstallmentLabels(householdId: string) {
  return useQuery({
    queryKey: ['installment_labels', householdId],
    select: toPlanMap,
    queryFn: async (): Promise<InstallmentLabelsData> => {
      const { data, error } = await supabase
        .from('installments')
        .select('id, name, total_periods')
        .eq('household_id', householdId)
      if (error) throw error
      const byId: InstallmentLabelsData = {}
      for (const row of data ?? []) {
        byId[row.id as string] = { name: row.name as string, total_periods: row.total_periods as number }
      }
      return byId
    },
    // Same trap as usePostedPeriods: a Map does not survive the JSON
    // round-trip localStorage persistence puts query data through, so the
    // queryFn returns a plain object and `select` rebuilds the Map per
    // observer. initialData keeps callers off `undefined` while it loads.
    initialData: {},
    initialDataUpdatedAt: 0,
  })
}

export type InstallmentInput = Omit<Installment, 'id' | 'household_id'>

export function useCreateInstallment(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: InstallmentInput) => {
      const { error } = await supabase.from('installments').insert({ household_id: householdId, ...input })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['installments', householdId] })
      queryClient.invalidateQueries({ queryKey: ['installment_labels', householdId] })
    },
  })
}

/**
 * Saves an edit to the plan row. Nothing else moves.
 *
 * D15 is whole again (ADR-0016): a period's label is derived from this row at
 * render time, so renaming a plan is visible everywhere on the next render
 * with no transaction rewritten. The short-lived propagation this hook used to
 * do — and the pattern-matching guard it needed — are gone with the stored
 * label that made them necessary.
 */
export function useUpdateInstallment(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: Partial<InstallmentInput> }) => {
      const { error } = await supabase.from('installments').update(input).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['installments', householdId] })
      // The ledger quotes plan names it does not store, so a renamed plan has
      // to re-render the rows that borrow it.
      queryClient.invalidateQueries({ queryKey: ['installment_labels', householdId] })
    },
  })
}

export function useDeleteInstallment(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('installments')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['installments', householdId] })
      queryClient.invalidateQueries({ queryKey: ['installment_labels', householdId] })
    },
  })
}

/**
 * Toggles whether an installment period has been **settled** (DESIGN §4.5
 * D2: a payment is an event, not a counter).
 *
 * Posting and settling are separate: the materialiser already wrote every
 * period's transaction when the plan was created, so this never creates or
 * deletes a transaction — it only records that the money for that period
 * actually went out, linked to the transaction that represents the charge.
 * For card-billed plans that is the ledger checkbox (the charge is settled
 * when the statement carrying it is paid); for account-billed plans it is
 * the "mark period paid" button.
 */
export function useSetPeriodPaid(householdId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      installmentId,
      periodNo,
      transactionId,
      paidDate,
      paid,
    }: {
      installmentId: string
      periodNo: number
      transactionId: string | null
      paidDate: string
      paid: boolean
    }) => {
      if (paid) {
        // The caller's id comes from a client-side map that can legitimately
        // be empty — the period's charge may not have been posted yet when
        // the box is ticked. Resolve it here rather than storing null, or the
        // payment loses the link that §4.5 calls the source of truth for
        // whether the money actually moved.
        let linkedTransactionId = transactionId
        if (!linkedTransactionId) {
          const { data } = await supabase
            .from('v_transactions')
            .select('id')
            .eq('household_id', householdId)
            .eq('source_key', periodSourceKey(installmentId, periodNo))
            .maybeSingle()
          linkedTransactionId = data?.id ?? null
        }

        const { error } = await supabase.from('installment_payments').insert({
          household_id: householdId,
          installment_id: installmentId,
          period_no: periodNo,
          paid_date: paidDate,
          transaction_id: linkedTransactionId,
        })
        if (error && error.code !== UNIQUE_VIOLATION) throw error
      } else {
        const { error } = await supabase
          .from('installment_payments')
          .delete()
          .eq('installment_id', installmentId)
          .eq('period_no', periodNo)
        if (error) throw error
      }

      // A plan is done once every period is settled, and un-ticking the last
      // one has to reopen it — otherwise a mis-tap permanently retires a plan
      // that still owes money.
      const { data: inst } = await supabase
        .from('installments')
        .select('total_periods, status')
        .eq('id', installmentId)
        .single()
      if (!inst) return

      const { count } = await supabase
        .from('installment_payments')
        .select('id', { count: 'exact', head: true })
        .eq('installment_id', installmentId)

      const settled = (count ?? 0) >= inst.total_periods
      if (settled && inst.status === 'active') {
        await supabase.from('installments').update({ status: 'done' }).eq('id', installmentId)
      } else if (!settled && inst.status === 'done') {
        await supabase.from('installments').update({ status: 'active' }).eq('id', installmentId)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['installments', householdId] })
      queryClient.invalidateQueries({ queryKey: ['installment_payments', householdId] })
      queryClient.invalidateQueries({ queryKey: ['transactions', householdId] })
    },
  })
}
