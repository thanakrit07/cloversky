import type { Instrument } from '@/components/InstrumentSelect'
import type { TransactionKind } from './transactions'

// Carries what was already typed on the transaction form into a new
// Recurring Rule or Installment Plan when Rep/Inst turns the entry being
// made into one (D9, §7.2) — so "coffee" and "new phone on 10-month plan"
// diverge only where they must, not by retyping everything from scratch.
export interface EntryPrefill {
  name: string
  kind: TransactionKind
  categoryId: string | null
  amount: number
  ownerId: string | null
  from: Instrument
  date: string
  /** How many periods, when the plan's length is already known (a statement prints it). */
  periods?: number
}
