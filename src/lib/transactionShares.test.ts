import { describe, expect, it } from 'vitest'
import { applyRatioSplit, computeShareRows, isValidSplit, rescaleShares } from './transactionShares'

const A = 'member-a'
const B = 'member-b'
const C = 'member-c'

describe('computeShareRows', () => {
  it('splits evenly across every member when owner is null', () => {
    expect(
      computeShareRows({ kind: 'expense', ownerId: null, frontingMemberId: A, amount: 100, memberIds: [A, B] }),
    ).toEqual([
      { member_id: A, share_amount: 50 },
      { member_id: B, share_amount: 50 },
    ])
  })

  it('gives the remainder cent to the earliest members so the split still sums to the total', () => {
    const rows = computeShareRows({ kind: 'expense', ownerId: null, frontingMemberId: A, amount: 10, memberIds: [A, B, C] })
    expect(rows).toEqual([
      { member_id: A, share_amount: 3.34 },
      { member_id: B, share_amount: 3.33 },
      { member_id: C, share_amount: 3.33 },
    ])
    expect(rows.reduce((sum, r) => sum + r.share_amount, 0)).toBeCloseTo(10, 2)
  })

  it('drops a member whose even split would round to zero', () => {
    const rows = computeShareRows({ kind: 'expense', ownerId: null, frontingMemberId: A, amount: 0.01, memberIds: [A, B] })
    expect(rows).toEqual([{ member_id: A, share_amount: 0.01 }])
  })

  it('does not split when owner is null but there is only one member', () => {
    expect(computeShareRows({ kind: 'expense', ownerId: null, frontingMemberId: A, amount: 100, memberIds: [A] })).toEqual([])
  })

  it('creates a single full-amount borrow row when the owner differs from who fronted it', () => {
    expect(
      computeShareRows({ kind: 'expense', ownerId: A, frontingMemberId: B, amount: 690, memberIds: [A, B] }),
    ).toEqual([{ member_id: A, share_amount: 690 }])
  })

  it('creates no rows for a personal expense (owner matches who fronted it)', () => {
    expect(computeShareRows({ kind: 'expense', ownerId: A, frontingMemberId: A, amount: 65, memberIds: [A, B] })).toEqual([])
  })

  it('creates no rows when nothing fronted the money is known', () => {
    expect(computeShareRows({ kind: 'expense', ownerId: A, frontingMemberId: null, amount: 65, memberIds: [A, B] })).toEqual([])
  })

  it('never splits income, even shaped like a shared or borrowed expense', () => {
    expect(computeShareRows({ kind: 'income', ownerId: null, frontingMemberId: A, amount: 50000, memberIds: [A, B] })).toEqual([])
    expect(computeShareRows({ kind: 'income', ownerId: A, frontingMemberId: B, amount: 50000, memberIds: [A, B] })).toEqual([])
  })

  it('never splits a transfer', () => {
    expect(computeShareRows({ kind: 'transfer', ownerId: null, frontingMemberId: A, amount: 500, memberIds: [A, B] })).toEqual([])
  })

  describe('custom (the Who-bears panel)', () => {
    it('uses the explicit breakdown verbatim instead of the owner/fronting heuristic', () => {
      expect(
        computeShareRows({
          kind: 'expense',
          ownerId: A,
          frontingMemberId: A,
          amount: 200,
          memberIds: [A, B],
          custom: [
            { member_id: A, share_amount: 120 },
            { member_id: B, share_amount: 80 },
          ],
        }),
      ).toEqual([
        { member_id: A, share_amount: 120 },
        { member_id: B, share_amount: 80 },
      ])
    })

    it('an empty custom array is "Just you" — no rows, regardless of who fronted it', () => {
      expect(
        computeShareRows({ kind: 'expense', ownerId: A, frontingMemberId: B, amount: 200, memberIds: [A, B], custom: [] }),
      ).toEqual([])
    })

    it('drops a zero-amount row from a custom breakdown', () => {
      expect(
        computeShareRows({
          kind: 'expense',
          ownerId: A,
          frontingMemberId: A,
          amount: 200,
          memberIds: [A, B],
          custom: [
            { member_id: A, share_amount: 0 },
            { member_id: B, share_amount: 200 },
          ],
        }),
      ).toEqual([{ member_id: B, share_amount: 200 }])
    })

    it('still never splits income even with an explicit custom breakdown', () => {
      expect(
        computeShareRows({
          kind: 'income',
          ownerId: A,
          frontingMemberId: A,
          amount: 200,
          memberIds: [A, B],
          custom: [{ member_id: B, share_amount: 200 }],
        }),
      ).toEqual([])
    })
  })
})

describe('applyRatioSplit', () => {
  it('applies fixed ratios to a given amount', () => {
    expect(
      applyRatioSplit(
        [
          { member_id: A, ratio: 0.6 },
          { member_id: B, ratio: 0.4 },
        ],
        200,
      ),
    ).toEqual([
      { member_id: A, share_amount: 120 },
      { member_id: B, share_amount: 80 },
    ])
  })

  it('gives the rounding remainder to the last member in the split, keeping every period proportional to its own amount', () => {
    // A plan's final period rarely matches its regular ones (ADR-0001) — the
    // same ratios must still sum back to whatever that period actually is.
    const split = [
      { member_id: A, ratio: 0.6 },
      { member_id: B, ratio: 0.4 },
    ]
    const regular = applyRatioSplit(split, 1333.33)
    expect(regular.reduce((sum, r) => sum + r.share_amount, 0)).toBeCloseTo(1333.33, 2)
    const final = applyRatioSplit(split, 1333.36)
    expect(final.reduce((sum, r) => sum + r.share_amount, 0)).toBeCloseTo(1333.36, 2)
  })

  it('drops a member whose ratio rounds to zero', () => {
    expect(applyRatioSplit([{ member_id: A, ratio: 1 }], 0.01)).toEqual([{ member_id: A, share_amount: 0.01 }])
    expect(
      applyRatioSplit(
        [
          { member_id: A, ratio: 0.999 },
          { member_id: B, ratio: 0.001 },
        ],
        0.01,
      ),
    ).toEqual([{ member_id: A, share_amount: 0.01 }])
  })

  it('returns nothing for an empty split', () => {
    expect(applyRatioSplit([], 200)).toEqual([])
  })
})

describe('isValidSplit', () => {
  it('accepts null — the heuristic path needs no ratios', () => {
    expect(isValidSplit(null)).toBe(true)
  })

  it('accepts ratios that sum to 1', () => {
    expect(
      isValidSplit([
        { member_id: A, ratio: 0.6 },
        { member_id: B, ratio: 0.4 },
      ]),
    ).toBe(true)
  })

  it('rejects an empty array — a Custom split with nobody in it', () => {
    expect(isValidSplit([])).toBe(false)
  })

  it('rejects ratios that overshoot or undershoot 1 — the mistyped-Custom-panel case', () => {
    // The bug this guards: typing amounts against the wrong reference (e.g.
    // the plan's total instead of its per-period figure) produces ratios
    // like 7.0 + 3.0 instead of 0.7 + 0.3 — silently saves the plan, then
    // fails every period's share write with no visible error unless this
    // gate catches it first.
    expect(
      isValidSplit([
        { member_id: A, ratio: 7 },
        { member_id: B, ratio: 3 },
      ]),
    ).toBe(false)
    expect(isValidSplit([{ member_id: A, ratio: 0.5 }])).toBe(false)
  })
})

describe('rescaleShares', () => {
  it('keeps each member’s fraction of the whole at the new amount, to the cent', () => {
    const shares = [
      { member_id: 'a', share_amount: 70 },
      { member_id: 'b', share_amount: 30 },
    ]
    expect(rescaleShares(shares, 100, 1450)).toEqual([
      { member_id: 'a', share_amount: 1015 },
      { member_id: 'b', share_amount: 435 },
    ])
  })

  it('sums exactly to the new amount when it does not divide evenly', () => {
    const shares = [
      { member_id: 'a', share_amount: 50 },
      { member_id: 'b', share_amount: 50 },
    ]
    const next = rescaleShares(shares, 100, 100.01)
    expect(next.reduce((sum, s) => sum + Math.round(s.share_amount * 100), 0)).toBe(10001)
  })

  it('carries a borrow (one person, the whole amount) across', () => {
    expect(rescaleShares([{ member_id: 'b', share_amount: 99 }], 99, 120)).toEqual([{ member_id: 'b', share_amount: 120 }])
  })

  it('returns nothing for a row with no Split', () => {
    expect(rescaleShares([], 100, 120)).toEqual([])
  })
})
