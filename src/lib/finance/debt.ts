// Debt payoff (SPEC §4.5, DESIGN.md §6.4): which debt to pay first, when the
// household is debt-free, and what is left each month once debts are paid.
// A plan owes its periods dated after today: every period is already a
// posted row (ADR-0001), so a past one is either paid or sits on a card bill.
// A card counts only a bill carried past its due date — never
// cardOutstanding, which already holds every future period and would count
// each plan twice.

import { periodDate } from './billingCycle.ts'

export interface PlanLike {
  id: string
  name: string
  start_date: string
  total_periods: number
  monthly_amount: number
  final_amount: number | null
  annual_interest_rate: number
}

export interface Debt {
  id: string
  name: string
  kind: 'installment' | 'card'
  /** % per year (DESIGN.md §6.4). */
  rate: number
  outstanding: number
  /** What it takes each month; a carried card bill is due in full. */
  monthly: number
  /** yyyy-MM of the last payment. */
  endsIn: string
}

export interface CarriedCard {
  id: string
  name: string
  annual_interest_rate: number
  amount: number
}

function futurePeriods(p: PlanLike, today: string) {
  const out: { month: string; amount: number }[] = []
  for (let n = 1; n <= p.total_periods; n++) {
    const date = periodDate(p.start_date, n)
    if (date <= today) continue
    out.push({ month: date.slice(0, 7), amount: n === p.total_periods ? (p.final_amount ?? p.monthly_amount) : p.monthly_amount })
  }
  return out
}

export function debts(plans: PlanLike[], carried: CarriedCard[], today: string): Debt[] {
  const list: Debt[] = []
  for (const p of plans) {
    const periods = futurePeriods(p, today)
    if (!periods.length) continue
    list.push({
      id: p.id,
      name: p.name,
      kind: 'installment',
      rate: p.annual_interest_rate,
      outstanding: periods.reduce((s, x) => s + x.amount, 0),
      monthly: p.monthly_amount,
      endsIn: periods[periods.length - 1].month,
    })
  }
  for (const c of carried) {
    if (c.amount <= 0) continue
    list.push({ id: c.id, name: c.name, kind: 'card', rate: c.annual_interest_rate, outstanding: c.amount, monthly: c.amount, endsIn: today.slice(0, 7) })
  }
  return avalanche(list)
}

/** Most expensive first; on a tie the smaller one, so a debt actually closes (§6.4). */
export function avalanche(list: Debt[]): Debt[] {
  return [...list].sort((a, b) => b.rate - a.rate || a.outstanding - b.outstanding)
}

export interface DebtMonth {
  month: string
  due: number
  /** Owed after this month's payments. */
  remaining: number
  /** Plans whose last payment is this month. */
  ending: string[]
}

/** Month by month from this month until the last debt is paid; empty when there is no debt. */
export function payoffByMonth(plans: PlanLike[], carried: CarriedCard[], today: string): DebtMonth[] {
  const thisMonth = today.slice(0, 7)
  const due = new Map<string, number>()
  const ending = new Map<string, string[]>()
  const add = (month: string, amount: number) => due.set(month, (due.get(month) ?? 0) + amount)
  for (const p of plans) {
    const periods = futurePeriods(p, today)
    for (const x of periods) add(x.month, x.amount)
    if (periods.length) {
      const last = periods[periods.length - 1].month
      ending.set(last, [...(ending.get(last) ?? []), p.name])
    }
  }
  for (const c of carried) if (c.amount > 0) add(thisMonth, c.amount)
  if (!due.size) return []

  const last = [...due.keys()].sort().at(-1)!
  let remaining = [...due.values()].reduce((s, x) => s + x, 0)
  const months: DebtMonth[] = []
  for (let m = thisMonth; m <= last; m = nextMonth(m)) {
    const d = due.get(m) ?? 0
    remaining -= d
    months.push({ month: m, due: d, remaining: Math.max(0, Math.round(remaining * 100) / 100), ending: ending.get(m) ?? [] })
  }
  return months
}

function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}
