import { describe, expect, it } from 'vitest'
import { interestSourceKey, parsePeriodSourceKey, periodSourceKey } from './installmentMaterialiser'

describe('periodSourceKey', () => {
  it('round-trips through the parser', () => {
    const key = periodSourceKey('abc-123', 7)
    expect(parsePeriodSourceKey(key)).toEqual({ installmentId: 'abc-123', periodNo: 7, interest: false })
  })
  it('tells a period\'s interest line from the period, under the same period number', () => {
    expect(parsePeriodSourceKey(interestSourceKey('abc-123', 7))).toEqual({ installmentId: 'abc-123', periodNo: 7, interest: true })
  })
})

describe('parsePeriodSourceKey', () => {
  it('rejects keys from other sources', () => {
    // Sheet-import keys share the column but not the meaning (§9).
    expect(parsePeriodSourceKey('transactions:row-42')).toBeNull()
  })

  it('rejects a null key', () => {
    expect(parsePeriodSourceKey(null)).toBeNull()
  })

  it('rejects a non-numeric period', () => {
    expect(parsePeriodSourceKey('installment:abc:notanumber')).toBeNull()
  })

  it('rejects a missing installment id', () => {
    expect(parsePeriodSourceKey('installment::3')).toBeNull()
  })
})
