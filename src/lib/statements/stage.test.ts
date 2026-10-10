import { describe, expect, it } from 'vitest'
import { parseCardx } from './cardx'
import { parseKbank } from './kbank'
import { parseKtc } from './ktc'
import { planCovers, planStartFor, stageStatements, withoutPeriodMarker, type StageContext } from './stage'

// Every line, name and amount below is invented.
const ASOF = '2026-09-27'
const ctx = (over: Partial<StageContext> = {}): StageContext => ({ plans: [], hints: new Map(), ...over })

const kbank = parseKbank(
  [
    '01-04-26 ยอดยกมา 100,000.00',
    '05-04-26 09:00 โอนเงิน 1,000.00 99,000.00 K PLUS เพื่อชำระ Ref X1 CardX/SCB WEALTH/FLEX',
    '06-04-26 09:00 รับโอนเงิน 30,000.00 129,000.00 K-Cash Connect Plus จาก X2 DEMO CO PAYROLL',
    '07-04-26 09:00 รับโอนเงิน 200.00 129,200.00 K PLUS จาก X3 DEMO PERSON',
    '08-04-26 09:00 ชำระเงิน 50.00 129,150.00 EDC/K SHOP/MYQR เพื่อชำระ Ref X4 DEMO CAFE',
    '30-04-26 09:00 โอนเงิน 400.00 128,750.00 K PLUS โอนไป UOBT X0521 DEMO PERSON',
  ],
  ASOF,
)!

describe('bank statement rows', () => {
  const { rows } = stageStatements([{ instrument: 'กสิกร', result: kbank }], ctx())
  it('turns a payment to a card of the household into a transfer', () => {
    expect(rows[0]).toMatchObject({ kind: 'transfer', from: 'กสิกร', to: 'CardX', amount: 1000 })
    expect(rows[4]).toMatchObject({ kind: 'transfer', to: 'UOB TMRW' })
  })
  it('reads payroll as salary and other money in as "Other" income', () => {
    expect(rows[1]).toMatchObject({ kind: 'income', category: 'Salary' })
    expect(rows[2]).toMatchObject({ kind: 'income', category: 'Other' })
  })
  it('guesses an expense category from keywords', () => {
    expect(rows[3]).toMatchObject({ kind: 'expense', category: 'Food' })
  })
})

describe('counterparty of a bank transfer line', () => {
  const lines = parseKbank(
    [
      '01-04-26 ยอดยกมา 1,000.00',
      '02-04-26 09:00 โอนเงิน 100.00 900.00 K PLUS โอนไป SCB X1111 DEMO PERSON A++',
      '03-04-26 09:00 รับโอนเงิน 50.00 950.00 K PLUS จาก X2222 DEMO PERSON B',
      '04-04-26 09:00 โอนเงิน 20.00 930.00 K PLUS โอนไป พร้อมเพย์ X3333 DEMO PERSON C++',
      '05-04-26 09:00 ชำระเงิน 10.00 920.00 EDC/K SHOP/MYQR เพื่อชำระ Ref X4444 DEMO CAFE',
    ],
    ASOF,
  )!
  it('is the name after the account, without the trailing pluses; shops paid by QR have none', () => {
    const { rows } = stageStatements([{ instrument: 'กสิกร', result: lines }], ctx())
    expect(rows.map((r) => r.counterparty)).toEqual(['DEMO PERSON A', 'DEMO PERSON B', 'DEMO PERSON C', null])
    expect(rows.every((r) => r.statement === 'กสิกร')).toBe(true)
  })
})

describe('card statement rows', () => {
  const cardx = parseCardx(
    [
      '23/09/26 1,000.00 100.00 13/10/26',
      '01/09 01/09 Payment received from Easy App -8,000.00',
      '02/09 02/09 DEMO TOLLWAY BANGKOK 45.00',
      '03/09 03/09 DEMO REFUND SHOP -75.00',
      '04/09 04/09 DEMO STORE 001/004 100.00',
      '04/09 04/09 DEMO SOFA 002/006 200.00',
      '05/09 05/09 DEMO UNKNOWN BANGKOK 9.00',
    ],
    ASOF,
  )!

  it('records a payment from an account with no statement in hand as a transfer into the card', () => {
    const { rows } = stageStatements([{ instrument: 'CardX', result: cardx }], ctx())
    expect(rows[0]).toMatchObject({ kind: 'transfer', from: 'SCB', to: 'CardX', amount: 8000 })
  })

  it('records a refund as income under Refund, never a negative expense', () => {
    const { rows } = stageStatements([{ instrument: 'CardX', result: cardx }], ctx())
    expect(rows.find((r) => r.text.includes('REFUND'))).toMatchObject({ kind: 'income', category: 'Refund', amount: 75 })
  })

  it('skips an installment the app already has a plan for, keeps and flags one it does not', () => {
    const plans = [{ instrument: 'CardX', total: 4, startDate: '2026-09-04' }]
    const { rows } = stageStatements([{ instrument: 'CardX', result: cardx }], ctx({ plans }))
    expect(rows.find((r) => r.text.includes('DEMO STORE'))).toBeUndefined() // period 1 of 4 posts on its plan's start
    expect(rows.find((r) => r.text.includes('DEMO SOFA'))).toMatchObject({ needsPlan: true }) // 2 of 6: no such plan
    const none = stageStatements([{ instrument: 'CardX', result: cardx }], ctx())
    expect(none.rows.filter((r) => r.needsPlan)).toHaveLength(2)
    expect(none.rows.find((r) => r.text.includes('DEMO STORE'))).toMatchObject({ category: 'Installments', needsPlan: true })
  })

  it('prefers what the household has taught it over a keyword', () => {
    const hints = new Map([['demo tollway bangkok', 'Other']])
    const { rows } = stageStatements([{ instrument: 'CardX', result: cardx }], ctx({ hints }))
    expect(rows.find((r) => r.text.includes('TOLLWAY'))!.category).toBe('Other')
    const plain = stageStatements([{ instrument: 'CardX', result: cardx }], ctx())
    expect(plain.rows.find((r) => r.text.includes('TOLLWAY'))!.category).toBe('Parking & tolls')
  })
})

describe('which file a row came from', () => {
  it('carries each file\'s name onto its own rows', () => {
    const a = parseKtc(['03/04/26 04/04/26 DEMO A 1.00', '03/04/26 04/04/26 DEMO B 2.00', '03/04/26 04/04/26 DEMO C 3.00'], ASOF)!
    const b = parseKtc(['05/04/26 06/04/26 DEMO D 4.00', '05/04/26 06/04/26 DEMO E 5.00', '05/04/26 06/04/26 DEMO F 6.00'], ASOF)!
    const { rows } = stageStatements([{ instrument: 'KTC', result: a, fileName: 'first.pdf' }, { instrument: 'KTC', result: b, fileName: 'second.pdf' }, ], ctx())
    expect(rows.map((r) => r.file)).toEqual(['first.pdf', 'first.pdf', 'first.pdf', 'second.pdf', 'second.pdf', 'second.pdf'])
    expect(stageStatements([{ instrument: 'KTC', result: a }], ctx()).rows[0].file).toBe('')
  })
})

describe('across files', () => {
  const ktc = parseKtc(
    [
      '03/04/26 04/04/26 Payment-KBANK Mobile - 1,000.00',
      '10/06/26 11/06/26 Payment-KBANK Mobile - 500.00',
      '20/04/26 21/04/26 DEMO JEANS BANGKOK 2,980.00',
      '26/04/26 26/04/26 TRANSFER TO FLEXI DEMO JEANS - 2,980.00',
      '26/04/26 26/04/26 01/03 DEMO JEANS BANGKOK 993.34',
      '27/04/26 27/04/26 DEMO CREDIT WITH NOTHING BEHIND IT 1.00',
    ],
    ASOF,
  )!

  it('skips a card payment the bank statement already records, keeps one outside its dates', () => {
    const { rows } = stageStatements(
      [
        { instrument: 'KTC', result: ktc },
        { instrument: 'กสิกร', result: kbank },
      ],
      ctx(),
    )
    const transfers = rows.filter((r) => r.kind === 'transfer' && r.to === 'KTC')
    expect(transfers).toHaveLength(1)
    expect(transfers[0]).toMatchObject({ from: 'กสิกร', amount: 500, date: '2026-06-10' })
  })

  it('cancels a purchase against the credit that converted it to an installment', () => {
    const { rows, issues } = stageStatements([{ instrument: 'KTC', result: ktc }], ctx({ plans: [{ instrument: 'KTC', total: 3, startDate: '2026-04-26' }] }))
    expect(rows.filter((r) => r.text.includes('DEMO JEANS'))).toHaveLength(0)
    expect(issues).toHaveLength(0)
  })

  it('says so, instead of dropping quietly, when a conversion credit has no purchase', () => {
    const orphan = parseKtc(['26/04/26 26/04/26 TRANSFER TO FLEXI DEMO NOTHING - 1,234.00', '27/04/26 27/04/26 DEMO A 1.00', '27/04/26 27/04/26 DEMO B 2.00'], ASOF)!
    const { issues } = stageStatements([{ instrument: 'KTC', result: orphan }], ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'orphan_conversion', date: '2026-04-26', amount: 1234, reason: expect.stringContaining('no matching purchase') })
  })
})

describe('making a plan from an installment line', () => {
  it('carries which period of how many onto the row', () => {
    const cardx = parseCardx(['23/09/26 1,000.00 100.00 13/10/26', '04/09 04/09 DEMO SOFA 002/006 200.00'], ASOF)!
    expect(stageStatements([{ instrument: 'CardX', result: cardx }], ctx()).rows[0]).toMatchObject({ needsPlan: true, installment: { k: 2, total: 6 } })
  })
  it('starts the plan k−1 months before the period, so the plan covers the line it came from', () => {
    expect(planStartFor('2026-09-04', 3)).toBe('2026-07-04')
    expect(planStartFor('2026-01-15', 2)).toBe('2025-12-15')
    expect(planStartFor('2026-09-04', 1)).toBe('2026-09-04')
    const plans = [{ instrument: 'CardX', total: 6, startDate: planStartFor('2026-09-04', 3) }]
    expect(planCovers(plans, 'CardX', { k: 3, total: 6 }, '2026-09-04')).toBe(true)
    expect(planCovers(plans, 'KTC', { k: 3, total: 6 }, '2026-09-04')).toBe(false)
  })
  it('names the plan after the shop, without the period marker either bank prints', () => {
    expect(withoutPeriodMarker('DEMO SOFA 002/006')).toBe('DEMO SOFA')
    expect(withoutPeriodMarker('02/06 DEMO SOFA')).toBe('DEMO SOFA')
    expect(withoutPeriodMarker('DEMO 24/7 SHOP')).toBe('DEMO 24/7 SHOP')
  })
})
