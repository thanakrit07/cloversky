import { describe, expect, it } from 'vitest'
import { entryAmount, groupByReceipt, type LedgerEntry } from './receiptGrouping'
import type { Transaction } from './transactions'

function tx(id: string, amount: number, receiptId: string | null = null): Transaction {
  return {
    id,
    household_id: 'h',
    date: '2026-08-19',
    kind: 'expense',
    category_id: 'cat',
    category_kind: 'expense',
    description: '',
    amount,
    owner_id: null,
    from_account_id: null,
    from_card_id: 'card',
    to_account_id: null,
    to_card_id: null,
    note: null,
    confirmed: true,
    source: 'manual',
    source_key: null,
    receipt_id: receiptId,
    posted_date: null,
    recurring_rule_id: null,
  }
}

const ids = (entries: LedgerEntry[]) =>
  entries.map((e) => (e.type === 'transaction' ? e.transaction.id : `${e.receiptId}[${e.lines.map((l) => l.id).join(',')}]`))

describe('grouping a day into ledger entries', () => {
  it('leaves transactions that belong to no receipt alone', () => {
    expect(ids(groupByReceipt([tx('a', 10), tx('b', 20)]))).toEqual(['a', 'b'])
  })

  it('gathers a receipt into one entry', () => {
    const entries = groupByReceipt([tx('a', 1200, 'r1'), tx('b', 300, 'r1'), tx('c', 300, 'r1')])
    expect(ids(entries)).toEqual(['r1[a,b,c]'])
  })

  it('keeps the receipt where its first line sat, however the lines are interleaved', () => {
    const entries = groupByReceipt([tx('x', 65), tx('a', 1200, 'r1'), tx('y', 40), tx('b', 300, 'r1')])
    expect(ids(entries)).toEqual(['x', 'r1[a,b]', 'y'])
  })

  it('keeps two receipts apart', () => {
    const entries = groupByReceipt([tx('a', 10, 'r1'), tx('c', 30, 'r2'), tx('b', 20, 'r1')])
    expect(ids(entries)).toEqual(['r1[a,b]', 'r2[c]'])
  })

  // D14: the caller has already applied the person filter, so a line borne
  // entirely by the other member never reaches this function. The receipt
  // still renders as a receipt — it is not dissolved back into a plain row.
  it('is still a receipt when the filter left it one line', () => {
    const entries = groupByReceipt([tx('a', 1200, 'r1')])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('receipt')
  })

  it('has nothing to lay out when there is nothing', () => {
    expect(groupByReceipt([])).toEqual([])
  })
})

describe('what an entry contributes', () => {
  const raw = (t: Transaction) => t.amount

  it('sums a receipt from its lines, never from a stored total', () => {
    const [entry] = groupByReceipt([tx('a', 1200, 'r1'), tx('b', 300, 'r1'), tx('c', 300, 'r1')])
    expect(entryAmount(entry!, raw)).toBe(1800)
  })

  it('reports the borne portion when that is the measure in use', () => {
    const borne: Record<string, number> = { a: 600, b: 0, c: 150 }
    const [entry] = groupByReceipt([tx('a', 1200, 'r1'), tx('b', 300, 'r1'), tx('c', 300, 'r1')])
    expect(entryAmount(entry!, (t) => borne[t.id] ?? 0)).toBe(750)
  })

  it('reports a lone transaction as itself', () => {
    const [entry] = groupByReceipt([tx('a', 65)])
    expect(entryAmount(entry!, raw)).toBe(65)
  })
})
