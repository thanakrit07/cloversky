import { describe, expect, it } from 'vitest'
import {
  closedCycleAsOf,
  cycleBill,
  cycleDueInMonth,
  cycleOf,
  installmentChargeInCycle,
  periodDate,
  projectedRecurringInCycle,
} from './billingCycle'

describe('cycleOf', () => {
  it('places a date after the statement day in the cycle ending next month', () => {
    const card = { statement_day: 5, due_day: 20 }
    expect(cycleOf(card, '2026-01-10')).toEqual({
      start: '2026-01-06',
      end: '2026-02-05',
      dueDate: '2026-02-20',
    })
  })

  it('places a date on/before the statement day in the cycle ending this month', () => {
    const card = { statement_day: 5, due_day: 20 }
    expect(cycleOf(card, '2026-01-05')).toEqual({
      start: '2025-12-06',
      end: '2026-01-05',
      dueDate: '2026-01-20',
    })
  })

  it('rolls the due date into the next month when due_day <= statement_day', () => {
    // Due day (3) is before statement day (25) in calendar terms, so the
    // payment for the cycle ending in month M falls in month M+1.
    const card = { statement_day: 25, due_day: 3 }
    const cycle = cycleOf(card, '2026-01-10')
    expect(cycle).toEqual({ start: '2025-12-26', end: '2026-01-25', dueDate: '2026-02-03' })
  })

  it('clamps statement_day 31 in a 30-day month', () => {
    const card = { statement_day: 31, due_day: 15 }
    // April has 30 days, so the statement closes on the 30th; March (31
    // days) needs no clamping, so the cycle starts the day after March 31.
    expect(cycleOf(card, '2026-04-15')).toEqual({
      start: '2026-04-01',
      end: '2026-04-30',
      dueDate: '2026-05-15',
    })
  })

  it('clamps statement_day 31 around February in a non-leap year', () => {
    const card = { statement_day: 31, due_day: 15 }
    // January (31 days) needs no clamping, so the cycle starts Feb 1.
    expect(cycleOf(card, '2026-02-15')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
      dueDate: '2026-03-15',
    })
  })

  it('clamps statement_day 31 around February in a leap year', () => {
    const card = { statement_day: 31, due_day: 15 }
    expect(cycleOf(card, '2028-02-15')).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
      dueDate: '2028-03-15',
    })
  })

  it('a date exactly on the statement day starts the next cycle the following day', () => {
    const card = { statement_day: 5, due_day: 20 }
    const cycle = cycleOf(card, '2026-01-06')
    expect(cycle.start).toBe('2026-01-06')
    expect(cycle.end).toBe('2026-02-05')
  })
})

describe('closedCycleAsOf', () => {
  const card = { statement_day: 5, due_day: 20 }
  // Cycle A: 2025-12-06 – 2026-01-05, due 2026-01-20.
  // Cycle B: 2026-01-06 – 2026-02-05, due 2026-02-20.

  it('attributes a payment made on the due date to the cycle that is due, not the cycle its date falls inside', () => {
    // 2026-01-20 (cycle A's due date) is inside cycle B's window — the bug
    // this exists to fix would have attributed the payment to cycle B.
    expect(closedCycleAsOf(card, '2026-01-20').start).toBe('2025-12-06')
  })

  it('attributes a payment made exactly on the closing statement day to the cycle that just closed', () => {
    expect(closedCycleAsOf(card, '2026-01-05')).toEqual(cycleOf(card, '2026-01-05'))
  })

  it('attributes a payment made the day after close to the cycle that just closed, not the new one that just started', () => {
    expect(closedCycleAsOf(card, '2026-01-06').start).toBe('2025-12-06')
  })

  it('attributes a payment made well into the next cycle to the same most-recently-closed cycle', () => {
    expect(closedCycleAsOf(card, '2026-01-15').start).toBe('2025-12-06')
  })
})

describe('cycleDueInMonth', () => {
  it('returns the cycle closing in the same month when due_day > statement_day', () => {
    // KTC-style: statement 19th, due 25th — the 20 Jul–19 Aug cycle is due 25 Aug.
    const card = { statement_day: 19, due_day: 25 }
    expect(cycleDueInMonth(card, '2026-08')).toEqual({
      start: '2026-07-20',
      end: '2026-08-19',
      dueDate: '2026-08-25',
    })
  })

  it('returns the previous month\'s cycle when due_day <= statement_day', () => {
    // Due date rolls past the statement, so August's payment settles the
    // cycle that closed in July.
    const card = { statement_day: 19, due_day: 5 }
    expect(cycleDueInMonth(card, '2026-08')).toEqual({
      start: '2026-06-20',
      end: '2026-07-19',
      dueDate: '2026-08-05',
    })
  })

  it('crosses the year boundary when the due month is January', () => {
    const card = { statement_day: 19, due_day: 5 }
    expect(cycleDueInMonth(card, '2027-01')).toEqual({
      start: '2026-11-20',
      end: '2026-12-19',
      dueDate: '2027-01-05',
    })
  })

  it('clamps statement_day 31 into a short closing month', () => {
    const card = { statement_day: 31, due_day: 15 }
    // Closes 31 Mar (due 15 Apr); the cycle starts the day after February's
    // clamped statement date (28 Feb in 2026).
    expect(cycleDueInMonth(card, '2026-04')).toEqual({
      start: '2026-03-01',
      end: '2026-03-31',
      dueDate: '2026-04-15',
    })
  })

  it('agrees with cycleOf: the returned cycle is really due in the asked month', () => {
    const card = { statement_day: 19, due_day: 25 }
    const cycle = cycleDueInMonth(card, '2026-08')
    expect(cycleOf(card, cycle.end)).toEqual(cycle)
    expect(cycle.dueDate.slice(0, 7)).toBe('2026-08')
  })
})

describe('periodDate', () => {
  it('adds (n-1) months to start_date', () => {
    expect(periodDate('2026-01-15', 1)).toBe('2026-01-15')
    expect(periodDate('2026-01-15', 3)).toBe('2026-03-15')
  })

  it('clamps 31 Jan + 1 month to the end of February', () => {
    expect(periodDate('2026-01-31', 2)).toBe('2026-02-28')
  })

  it('clamps to Feb 29 in a leap year', () => {
    expect(periodDate('2028-01-31', 2)).toBe('2028-02-29')
  })
})

describe('installmentChargeInCycle', () => {
  it('sums only the periods whose date falls inside the cycle', () => {
    const installment = { id: 'inst-1', start_date: '2026-01-15', total_periods: 12, monthly_amount: 1000, final_amount: null }
    const cycle = { start: '2026-02-06', end: '2026-03-05', dueDate: '2026-03-20' }
    // Only period 2 (2026-02-15) falls in this cycle.
    expect(installmentChargeInCycle(installment, cycle)).toBe(1000)
  })

  it('uses final_amount for the last period', () => {
    const installment = { id: 'inst-1', start_date: '2026-01-15', total_periods: 2, monthly_amount: 1000, final_amount: 750 }
    const cycle = { start: '2026-02-06', end: '2026-03-05', dueDate: '2026-03-20' }
    expect(installmentChargeInCycle(installment, cycle)).toBe(750)
  })

  it('adds the interest line the card bills beside each period', () => {
    const installment = { id: 'inst-1', start_date: '2026-01-15', total_periods: 2, monthly_amount: 1000, final_amount: 750, period_interest: 26.13 }
    const cycle = { start: '2026-02-06', end: '2026-03-05', dueDate: '2026-03-20' }
    expect(installmentChargeInCycle(installment, cycle)).toBe(776.13)
  })

  it('excludes a period already posted as a real transaction (D11 double-count guard)', () => {
    const installment = { id: 'inst-1', start_date: '2026-01-15', total_periods: 12, monthly_amount: 1000, final_amount: null }
    const cycle = { start: '2026-02-06', end: '2026-03-05', dueDate: '2026-03-20' }
    expect(installmentChargeInCycle(installment, cycle, new Set(['inst-1:2']))).toBe(0)
  })

  it('does not exclude another installment\'s period of the same number', () => {
    const installment = { id: 'inst-1', start_date: '2026-01-15', total_periods: 12, monthly_amount: 1000, final_amount: null }
    const cycle = { start: '2026-02-06', end: '2026-03-05', dueDate: '2026-03-20' }
    expect(installmentChargeInCycle(installment, cycle, new Set(['inst-2:2']))).toBe(1000)
  })
})

describe('projectedRecurringInCycle', () => {
  const cycle = { start: '2026-01-06', end: '2026-02-05', dueDate: '2026-02-20' }
  const cardId = 'card-1'
  const monthly = {
    freq: 'monthly' as const,
    interval: 1,
    day_of_month: 15,
    month_of_year: null,
    weekday: null,
    month_end: 'clamp' as const,
    start_date: '2025-01-15',
    end_date: null,
    max_occurrences: null,
    amount: 350,
    kind: 'expense' as const,
    from_card_id: cardId,
    active: true,
    last_generated_date: null,
  }

  it('projects an occurrence falling inside the cycle', () => {
    expect(projectedRecurringInCycle([monthly], cycle, cardId)).toBe(350)
  })

  it('ignores rules charged to a different card', () => {
    expect(projectedRecurringInCycle([{ ...monthly, from_card_id: 'card-2' }], cycle, cardId)).toBe(0)
  })

  it('ignores inactive rules', () => {
    expect(projectedRecurringInCycle([{ ...monthly, active: false }], cycle, cardId)).toBe(0)
  })

  it('ignores income — it does not charge the card', () => {
    expect(projectedRecurringInCycle([{ ...monthly, kind: 'income' }], cycle, cardId)).toBe(0)
  })

  it('skips occurrences already materialised, up to the watermark', () => {
    // The 15 Jan occurrence is already a real transaction, so projecting it
    // again would double-count it against the transaction total.
    expect(projectedRecurringInCycle([{ ...monthly, last_generated_date: '2026-01-20' }], cycle, cardId)).toBe(0)
  })

  it('still projects a later occurrence when the watermark is mid-cycle', () => {
    // Watermark before the 15th: that occurrence has not been posted yet.
    expect(projectedRecurringInCycle([{ ...monthly, last_generated_date: '2026-01-10' }], cycle, cardId)).toBe(350)
  })

  it('counts every occurrence when several fall in one cycle', () => {
    const weekly = { ...monthly, freq: 'weekly' as const, weekday: 1, day_of_month: null, amount: 100 }
    // Mondays between 6 Jan and 5 Feb 2026: 12, 19, 26 Jan and 2 Feb.
    expect(projectedRecurringInCycle([weekly], cycle, cardId)).toBe(400)
  })
})

describe('cycleBill', () => {
  const cycle = { start: '2026-01-06', end: '2026-02-05', dueDate: '2026-02-20' }
  const cardId = 'card-1'

  it('sums card transactions in the cycle, excludes transfers paying it off', () => {
    const transactions = [
      { amount: 500, date: '2026-01-10', kind: 'expense' as const, to_card_id: null, confirmed: true },
      { amount: 300, date: '2026-01-20', kind: 'expense' as const, to_card_id: null, confirmed: true },
      // A transfer TO this card is a bill payment — it settles the bill,
      // not a charge on it (D7).
      { amount: 800, date: '2026-01-25', kind: 'transfer' as const, to_card_id: cardId, confirmed: true },
      // Outside the cycle window.
      { amount: 999, date: '2026-02-10', kind: 'expense' as const, to_card_id: null, confirmed: true },
    ]
    expect(cycleBill({ cycle, cardId, transactions, installments: [] })).toBe(800)
  })

  it('places a statement-vouched row by its posting date, not its purchase date', () => {
    const transactions = [
      // Bought on the previous cycle's statement day, posted inside this one.
      { amount: 120, date: '2026-01-05', posted_date: '2026-01-06', kind: 'expense' as const, to_card_id: null, confirmed: true },
      // Bought on this cycle's statement day, posts onto the next bill.
      { amount: 70, date: '2026-02-05', posted_date: '2026-02-06', kind: 'expense' as const, to_card_id: null, confirmed: true },
      // Hand-entered, no statement yet: purchase date decides.
      { amount: 30, date: '2026-02-05', posted_date: null, kind: 'expense' as const, to_card_id: null, confirmed: true },
    ]
    expect(cycleBill({ cycle, cardId, transactions, installments: [] })).toBe(150)
  })

  it('excludes unconfirmed rows — they are excluded from every total in the app (§6.6), not just the callers that remember to filter', () => {
    const transactions = [
      { amount: 500, date: '2026-01-10', kind: 'expense' as const, to_card_id: null, confirmed: true },
      { amount: 999, date: '2026-01-12', kind: 'expense' as const, to_card_id: null, confirmed: false },
    ]
    expect(cycleBill({ cycle, cardId, transactions, installments: [] })).toBe(500)
  })

  it('adds installment charges falling in the cycle', () => {
    const installments = [{ id: 'inst-1', start_date: '2026-01-06', total_periods: 3, monthly_amount: 200, final_amount: null }]
    expect(cycleBill({ cycle, cardId, transactions: [], installments })).toBe(200)
  })

  it('applies the signed adjustment on top', () => {
    expect(cycleBill({ cycle, cardId, transactions: [], installments: [], adjustment: -150 })).toBe(-150)
  })

  it('combines transactions, installments, and the adjustment', () => {
    const transactions = [{ amount: 500, date: '2026-01-10', kind: 'expense' as const, to_card_id: null, confirmed: true }]
    const installments = [{ id: 'inst-1', start_date: '2026-01-06', total_periods: 3, monthly_amount: 200, final_amount: null }]
    expect(cycleBill({ cycle, cardId, transactions, installments, adjustment: 50 })).toBe(750)
  })

  it('does not double-count a period already posted as a transaction (D11)', () => {
    // The materialiser already turned period 1 into a real transaction on
    // the card — it must appear in txnTotal only, not in both terms.
    const transactions = [{ amount: 200, date: '2026-01-06', kind: 'expense' as const, to_card_id: null, confirmed: true }]
    const installments = [{ id: 'inst-1', start_date: '2026-01-06', total_periods: 3, monthly_amount: 200, final_amount: null }]
    expect(cycleBill({ cycle, cardId, transactions, installments, postedPeriods: new Set(['inst-1:1']) })).toBe(200)
  })

  it('leaves recurring out of the total unless rules are supplied', () => {
    const rule = {
      freq: 'monthly' as const, interval: 1, day_of_month: 15, month_of_year: null, weekday: null,
      month_end: 'clamp' as const, start_date: '2025-01-15', end_date: null, max_occurrences: null,
      amount: 350, kind: 'expense' as const, from_card_id: cardId, active: true, last_generated_date: null,
    }
    expect(cycleBill({ cycle, cardId, transactions: [], installments: [] })).toBe(0)
    expect(cycleBill({ cycle, cardId, transactions: [], installments: [], recurringRules: [rule] })).toBe(350)
  })
})
