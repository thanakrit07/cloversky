import { parsePeriodSourceKey } from './installmentMaterialiser'

// A posted installment period's label is **derived, never stored** (D15,
// ADR-0016). The transaction already says which period it is — `source =
// 'installment'` and `source_key = installment:<id>:<n>` — and the plan
// already holds the name, so composing the two at render time is strictly
// more truthful than copying the name into `note` was: renaming a plan is
// visible everywhere at once, with no rows rewritten and nothing that can
// drift out of sync.
//
// This is what removes the whole class of bug that the stored label kept
// producing. `note` had to hold both the app's label and the user's own text,
// so telling them apart meant pattern-matching prose — and a plan renamed
// before that matcher existed could never be recognised at all.

/** The plan fields a label needs. Deleted plans included — see `useInstallmentLabels`. */
export interface LabelledPlan {
  name: string
  total_periods: number
}

/** Just enough of a Transaction to label it. */
export interface LabellableTransaction {
  source: string
  source_key: string | null
}

export function formatPeriodLabel(planName: string, periodNo: number, totalPeriods: number, interest = false): string {
  return `${interest ? 'ดอกเบี้ย ' : ''}${planName} (งวดที่ ${periodNo}/${totalPeriods})`
}

/**
 * The label for a posted installment period, or null when the row is not one.
 *
 * Null is also the answer when the plan cannot be found, which is not the same
 * as "not a period": the caller falls back to the row's own note or category
 * rather than rendering a half-composed label with a missing name.
 */
export function installmentPeriodLabel(
  t: LabellableTransaction,
  planById: ReadonlyMap<string, LabelledPlan>,
): string | null {
  if (t.source !== 'installment') return null
  const parsed = parsePeriodSourceKey(t.source_key)
  if (!parsed) return null
  const plan = planById.get(parsed.installmentId)
  if (!plan) return null
  return formatPeriodLabel(plan.name, parsed.periodNo, plan.total_periods, parsed.interest)
}
