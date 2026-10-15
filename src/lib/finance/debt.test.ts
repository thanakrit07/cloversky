import { describe, expect, it } from 'vitest'
import { avalanche, debts, endings, payoffByMonth, type Debt, type PlanLike } from './debt.ts'

const plan = (over: Partial<PlanLike>): PlanLike => ({
  id: 'p',
  name: 'Phone',
  start_date: '2026-09-05',
  total_periods: 3,
  monthly_amount: 1000,
  final_amount: null,
  annual_interest_rate: 0,
  ...over,
})

describe('debt', () => {
  it('ranks by rate, then smaller balance first', () => {
    const d = (id: string, rate: number, outstanding: number): Debt => ({ id, name: id, kind: 'installment', rate, outstanding, monthly: 0, endsIn: '' })
    expect(avalanche([d('a', 0, 100), d('b', 9.99, 5000), d('c', 9.99, 2000)]).map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })

  it('owes the periods after today, with an odd final one', () => {
    const [d] = debts([plan({ final_amount: 400 })], [], '2026-10-05')
    expect(d.outstanding).toBe(400) // Sep and 5 Oct are posted already; Nov is the odd final one
    expect(d.endsIn).toBe('2026-11')
  })

  it('finds the debt-free month and counts a carried card once', () => {
    const months = payoffByMonth(
      [plan({}), plan({ id: 'q', name: 'Laptop', start_date: '2026-10-20', total_periods: 2, monthly_amount: 500 })],
      [{ id: 'c', name: 'KTC', annual_interest_rate: 16, amount: 300 }],
      '2026-10-10',
    )
    expect(months.map((m) => [m.month, m.due, m.remaining])).toEqual([
      ['2026-10', 800, 1500], // Laptop 20 Oct + the card
      ['2026-11', 1500, 0],
    ])
    expect(months[1].ending).toEqual(['Phone', 'Laptop'])
  })

  it('says what each ending frees from the month after', () => {
    const months = payoffByMonth(
      [plan({}), plan({ id: 'q', name: 'Laptop', start_date: '2026-10-20', total_periods: 4, monthly_amount: 500 })],
      [],
      '2026-10-10',
    )
    expect(endings(months, 1500).map((e) => [e.after, e.ending, e.dueAfter, e.freed])).toEqual([
      ['2026-12', ['Phone'], 500, 1000],
      ['2027-02', ['Laptop'], 0, 500],
    ])
  })

  it('is empty with no debt', () => {
    expect(payoffByMonth([], [], '2026-10-10')).toEqual([])
  })
})
