import { describe, expect, it } from 'vitest'
import { candidatesFor, hasPlanNear, periodLineFor, type SupersededCandidate } from './superseded'

const row = (id: string, date: string, amount: number): SupersededCandidate => ({ id, date, amount, description: 'DEMO SHOP', note: null, category_id: null, owner_id: null })

describe('candidatesFor', () => {
  const orphan = { date: '2026-09-23', amount: 3500 }

  it('keeps expenses of exactly that amount, earlier than the credit, nearest first', () => {
    const rows = [row('old', '2026-07-01', 3500), row('near', '2026-09-02', 3500), row('later', '2026-09-24', 3500), row('other', '2026-09-02', 3499.99)]
    expect(candidatesFor(orphan, rows).map((r) => r.id)).toEqual(['near', 'old'])
  })

  it('does not reach back past the lookback window', () => {
    expect(candidatesFor(orphan, [row('ancient', '2026-01-01', 3500)])).toEqual([])
  })

  it('tolerates a float that is a cent-fraction off', () => {
    expect(candidatesFor(orphan, [row('x', '2026-09-01', 3500.001)])).toHaveLength(1)
  })
})

describe('periodLineFor', () => {
  const orphan = { date: '2026-09-05', amount: 6000 }
  const line = (k: number, total: number, amount: number, date: string) => ({ installment: { k, total }, amount, date, postedDate: null, id: `${k}/${total}@${amount}` })
  const startOf = (l: ReturnType<typeof line>) => l.date // period 1 lines: starts on its own date

  it('picks the line whose periods add up to the credit, give or take interest', () => {
    const lines = [line(1, 6, 1050, '2026-09-06'), line(1, 3, 500, '2026-09-06')]
    expect(periodLineFor(orphan, lines, startOf)?.id).toBe('1/6@1050')
  })
  it('prefers the plan that starts nearest the credit', () => {
    const lines = [line(1, 6, 1000, '2026-10-20'), line(1, 6, 1000, '2026-09-10')]
    expect(periodLineFor(orphan, lines, startOf)?.date).toBe('2026-09-10')
  })
  it('finds nothing when no line is that size or that close in time', () => {
    expect(periodLineFor(orphan, [line(1, 6, 100, '2026-09-06'), line(1, 6, 1000, '2027-03-01')], startOf)).toBeNull()
  })
})

describe('hasPlanNear', () => {
  it('needs a plan on the same card starting within two months of the credit', () => {
    const orphan = { instrument: 'CardX', date: '2026-09-05' }
    expect(hasPlanNear(orphan, [{ instrument: 'CardX', startDate: '2026-10-01' }])).toBe(true)
    expect(hasPlanNear(orphan, [{ instrument: 'KTC', startDate: '2026-10-01' }])).toBe(false)
    expect(hasPlanNear(orphan, [{ instrument: 'CardX', startDate: '2026-01-01' }])).toBe(false)
  })
})
