import { describe, expect, it } from 'vitest'
import {
  ALL_RECORDS_FILTERS,
  decodeRecordsFilter,
  describeRecordsFilter,
  encodeRecordsFilter,
  isRecordsFilterActive,
  matchesRecordsFilter,
  type RecordsFilterState,
} from './recordsFilter'
import type { Transaction } from './transactions'

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    household_id: 'h',
    date: '2026-08-19',
    kind: 'expense',
    category_id: 'cat-food',
    category_kind: 'expense',
    description: '',
    amount: 100,
    owner_id: null,
    from_account_id: null,
    from_card_id: 'card-ktc',
    to_account_id: null,
    to_card_id: null,
    note: null,
    confirmed: true,
    source: 'manual',
    source_key: null,
    receipt_id: null,
    posted_date: null,
    recurring_rule_id: null,
    ...overrides,
  }
}

describe('matchesRecordsFilter', () => {
  it('matches everything under the default (no restriction) filter', () => {
    expect(matchesRecordsFilter(tx(), ALL_RECORDS_FILTERS)).toBe(true)
    expect(matchesRecordsFilter(tx({ kind: 'transfer', category_id: null }), ALL_RECORDS_FILTERS)).toBe(true)
    expect(matchesRecordsFilter(tx({ category_id: null }), ALL_RECORDS_FILTERS)).toBe(true)
  })

  it('excludes a category not on the allow-list', () => {
    const filter: RecordsFilterState = { ...ALL_RECORDS_FILTERS, categoryIds: ['cat-transport'] }
    expect(matchesRecordsFilter(tx({ category_id: 'cat-food' }), filter)).toBe(false)
    expect(matchesRecordsFilter(tx({ category_id: 'cat-transport' }), filter)).toBe(true)
  })

  it('narrows to a kind purely by which categories are allowed, with no separate kind field', () => {
    // Only expense categories on the list — an income row's category_id is
    // never in it, so income rows drop out with no kind check at all.
    const filter: RecordsFilterState = { ...ALL_RECORDS_FILTERS, categoryIds: ['cat-food'] }
    expect(matchesRecordsFilter(tx({ kind: 'expense', category_id: 'cat-food' }), filter)).toBe(true)
    expect(matchesRecordsFilter(tx({ kind: 'income', category_id: 'cat-salary' }), filter)).toBe(false)
  })

  it('a transfer is governed only by includeTransfers, never by categoryIds', () => {
    const filter: RecordsFilterState = { ...ALL_RECORDS_FILTERS, categoryIds: ['cat-food'] }
    expect(matchesRecordsFilter(tx({ kind: 'transfer', category_id: null }), filter)).toBe(true)
    expect(matchesRecordsFilter(tx({ kind: 'transfer', category_id: null }), { ...filter, includeTransfers: false })).toBe(
      false,
    )
  })

  it('an uncategorized income/expense row is governed only by includeUncategorized, never by categoryIds', () => {
    const filter: RecordsFilterState = { ...ALL_RECORDS_FILTERS, categoryIds: ['cat-food'] }
    expect(matchesRecordsFilter(tx({ category_id: null }), filter)).toBe(true)
    expect(matchesRecordsFilter(tx({ category_id: null }), { ...filter, includeUncategorized: false })).toBe(false)
  })

  it('restricts to transactions touching one of the selected accounts/cards, on any of the four sides', () => {
    const filter: RecordsFilterState = { ...ALL_RECORDS_FILTERS, instrumentIds: ['acct-kbank'] }
    expect(matchesRecordsFilter(tx({ from_account_id: 'acct-kbank', from_card_id: null }), filter)).toBe(true)
    expect(matchesRecordsFilter(tx({ to_account_id: 'acct-kbank', from_card_id: null }), filter)).toBe(true)
    expect(matchesRecordsFilter(tx({ from_card_id: 'card-ktc' }), filter)).toBe(false)
  })

  it('an instrument restriction still lets a matching transfer through even when includeTransfers would otherwise block it — no: includeTransfers wins for transfers regardless', () => {
    // Transfers are always subject to includeTransfers; the instrument
    // restriction is an *additional* AND, not an override of it.
    const filter: RecordsFilterState = {
      ...ALL_RECORDS_FILTERS,
      instrumentIds: ['acct-kbank'],
      includeTransfers: false,
    }
    expect(
      matchesRecordsFilter(tx({ kind: 'transfer', category_id: null, from_account_id: 'acct-kbank' }), filter),
    ).toBe(false)
  })
})

describe('isRecordsFilterActive', () => {
  it('is false only for the untouched default', () => {
    expect(isRecordsFilterActive(ALL_RECORDS_FILTERS)).toBe(false)
    expect(isRecordsFilterActive({ ...ALL_RECORDS_FILTERS, categoryIds: ['a'] })).toBe(true)
    expect(isRecordsFilterActive({ ...ALL_RECORDS_FILTERS, instrumentIds: ['a'] })).toBe(true)
    expect(isRecordsFilterActive({ ...ALL_RECORDS_FILTERS, includeTransfers: false })).toBe(true)
    expect(isRecordsFilterActive({ ...ALL_RECORDS_FILTERS, includeUncategorized: false })).toBe(true)
  })
})

describe('URL encode/decode', () => {
  it('round-trips the default filter to empty params', () => {
    const params = encodeRecordsFilter(ALL_RECORDS_FILTERS)
    expect(params).toEqual({ cat: '', acct: '', xfer: '', unc: '' })
    expect(decodeRecordsFilter(params)).toEqual(ALL_RECORDS_FILTERS)
  })

  it('round-trips a fully populated filter', () => {
    const filter: RecordsFilterState = {
      categoryIds: ['a', 'b'],
      instrumentIds: ['x'],
      includeTransfers: false,
      includeUncategorized: false,
    }
    expect(decodeRecordsFilter(encodeRecordsFilter(filter))).toEqual(filter)
  })

  it('treats a comma-separated single id (a stale tap-through link) as a one-item list', () => {
    expect(decodeRecordsFilter({ cat: 'cat-food', acct: '', xfer: '', unc: '' }).categoryIds).toEqual(['cat-food'])
  })
})

describe('describeRecordsFilter', () => {
  const nameOf = {
    category: (id: string) => ({ 'cat-food': 'Food', 'cat-transport': 'Transport' })[id],
    instrument: (id: string) => ({ 'card-ktc': 'KTC' })[id],
  }

  it('is empty for the default filter', () => {
    expect(describeRecordsFilter(ALL_RECORDS_FILTERS, nameOf)).toBe('')
  })

  it('names a single selected category', () => {
    expect(describeRecordsFilter({ ...ALL_RECORDS_FILTERS, categoryIds: ['cat-food'] }, nameOf)).toBe('Food')
  })

  it('collapses several selections into "+N more"', () => {
    expect(
      describeRecordsFilter({ ...ALL_RECORDS_FILTERS, categoryIds: ['cat-food', 'cat-transport'] }, nameOf),
    ).toBe('Food +1 more')
  })

  it('joins multiple axes with a middle dot', () => {
    expect(
      describeRecordsFilter(
        { ...ALL_RECORDS_FILTERS, categoryIds: ['cat-food'], instrumentIds: ['card-ktc'] },
        nameOf,
      ),
    ).toBe('Food · KTC')
  })

  it('names the transfer/uncategorized toggles when off', () => {
    expect(describeRecordsFilter({ ...ALL_RECORDS_FILTERS, includeTransfers: false }, nameOf)).toBe('No transfers')
    expect(describeRecordsFilter({ ...ALL_RECORDS_FILTERS, includeUncategorized: false }, nameOf)).toBe(
      'No uncategorized',
    )
  })
})
