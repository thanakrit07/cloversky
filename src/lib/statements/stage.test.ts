import { describe, expect, it } from 'vitest'
import { parseCardx } from './cardx'
import { parseKbank } from './kbank'
import { parseKtc } from './ktc'
import { parseUob } from './uob'
import { planStartFor, plansFor, stageStatements, withoutPeriodMarker, type StageContext } from './stage'

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
    const covers = (instrument: string) => plansFor(plans, [{ instrument, installment: { k: 3, total: 6 }, when: '2026-09-04', charged: 0, name: '' }], true)[0] !== undefined
    expect(covers('CardX')).toBe(true)
    expect(covers('KTC')).toBe(false)
  })
  const withInterest = parseCardx(['23/09/26 1,000.00 100.00 13/10/26', '04/09 04/09 DEMO SOFA 003/006 200.00', '04/09 04/09 IPP Interest 003/006 26.13'], ASOF)!
  it('carries the interest line on its period, to make the plan with', () => {
    const { rows } = stageStatements([{ instrument: 'CardX', result: withInterest }], ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ needsPlan: true, amount: 200, periodInterest: 26.13, installment: { k: 3, total: 6 } })
  })
  it('warns when a plan posts a different amount from what the card charged, and is quiet when they agree', () => {
    const plan = { instrument: 'CardX', total: 6, startDate: planStartFor('2026-09-04', 3) }
    const off = stageStatements([{ instrument: 'CardX', result: withInterest }], ctx({ plans: [{ ...plan, monthly: 200, final: null }] }))
    expect(off.rows).toHaveLength(0)
    expect(off.issues).toEqual([expect.objectContaining({ code: 'plan_amount_differs', amount: 226.13, reason: expect.stringContaining('posts 200.00') })])
    expect(stageStatements([{ instrument: 'CardX', result: withInterest }], ctx({ plans: [{ ...plan, monthly: 200, final: null, interest: 26.13 }] })).issues).toEqual([])
    // A plan from before 0036 holds the interest inside its monthly amount: that agrees too.
    expect(stageStatements([{ instrument: 'CardX', result: withInterest }], ctx({ plans: [{ ...plan, monthly: 226.13, final: null }] })).issues).toEqual([])
  })
  // Two plans at the same period, posted the same day: the card's date and
  // period no longer tell their interest lines apart.
  const interestOf = (rows: { text: string; periodInterest?: number }[]) => rows.map((r) => [r.text, r.periodInterest ?? 0])
  it('pairs CardX interest with the period printed just above it', () => {
    const cardx = parseCardx(
      [
        '23/09/26 1,000.00 100.00 13/10/26',
        '04/09 04/09 DEMO SOFA 003/006 200.00',
        '04/09 04/09 IPP Interest 003/006 26.13',
        '04/09 04/09 DEMO PHONE 003/006 500.00',
        '04/09 04/09 IPP Interest 003/006 41.50',
      ],
      ASOF,
    )!
    expect(interestOf(stageStatements([{ instrument: 'CardX', result: cardx }], ctx()).rows)).toEqual([
      ['DEMO SOFA 003/006', 26.13],
      ['DEMO PHONE 003/006', 41.5],
    ])
  })
  it('pairs KTC interest by the shop name it repeats, cut short', () => {
    const ktc = parseKtc(
      [
        '02/01/26 02/01/26 02/06 DEMO TRAVEL FD Internet 1,420.11',
        '02/01/26 02/01/26 02/06 DEMO PHONE SHOP 900.00',
        '02/01/26 02/01/26 02/06 DEMO PHONE S INT00.74% 40.00',
        '02/01/26 02/01/26 02/06 DEMO TRAVEL FD I INT00.74% 63.05',
      ],
      ASOF,
    )!
    expect(interestOf(stageStatements([{ instrument: 'KTC', result: ktc }], ctx()).rows)).toEqual([
      ['02/06 DEMO TRAVEL FD Internet', 63.05],
      ['02/06 DEMO PHONE SHOP', 40],
    ])
  })
  it('reads UOB\'s INT line as interest and pairs it with the PRIN line of the same name', () => {
    const uob = parseUob(
      [
        '04 SEP 04 SEP DEMO SOFA PRIN 03/06 200.00',
        '04 SEP 04 SEP DEMO PHONE PRIN 03/06 500.00',
        '04 SEP 04 SEP DEMO PHONE INT 03/06 41.50',
        '04 SEP 04 SEP DEMO SOFA INT 03/06 26.13',
      ],
      ASOF,
    )!
    expect(uob.lines.map((l) => l.isInterest)).toEqual([false, false, true, true])
    expect(uob.lines[0].installment).toEqual({ k: 3, total: 6 })
    expect(interestOf(stageStatements([{ instrument: 'UOB TMRW', result: uob }], ctx()).rows)).toEqual([
      ['DEMO SOFA PRIN 03/06', 26.13],
      ['DEMO PHONE PRIN 03/06', 41.5],
    ])
  })
  it('pairs KTC interest that repeats the shop name in full', () => {
    const ktc = parseKtc(['02/01/26 02/01/26 02/06 DEMO PAY ABC 900.00', '02/01/26 02/01/26 02/06 DEMO PAY ABC INT00.74% 40.00', '02/01/26 02/01/26 02/06 DEMO PAY XYZ 300.00'], ASOF)!
    expect(interestOf(stageStatements([{ instrument: 'KTC', result: ktc }], ctx()).rows)).toEqual([
      ['02/06 DEMO PAY ABC', 40],
      ['02/06 DEMO PAY XYZ', 0],
    ])
  })
  it('still pairs the only period that day when the names do not agree, and never pairs a guess', () => {
    const lone = parseKtc(['02/01/26 02/01/26 02/06 DEMO SHOP 900.00', '02/01/26 02/01/26 02/06 OTHER NAME INT00.74% 40.00'], ASOF)!
    expect(interestOf(stageStatements([{ instrument: 'KTC', result: lone }], ctx()).rows)).toEqual([['02/06 DEMO SHOP', 40]])
    const first = parseCardx(['23/09/26 1,000.00 100.00 13/10/26', '04/09 04/09 IPP Interest 003/006 26.13', '04/09 04/09 DEMO SOFA 003/006 200.00', '04/09 04/09 DEMO PHONE 003/006 500.00'], ASOF)!
    const { rows } = stageStatements([{ instrument: 'CardX', result: first }], ctx())
    expect(rows.filter((r) => r.periodInterest)).toEqual([])
    expect(rows).toHaveLength(3) // the unpaired interest line stays its own row, as before
  })
  // Two plans on one card, both at period 3 of 6 on the same day.
  const twoPlans = parseCardx(['23/09/26 1,000.00 100.00 13/10/26', '04/09 04/09 DEMO SOFA 003/006 200.00', '04/09 04/09 DEMO PHONE 003/006 500.00'], ASOF)!
  const start = planStartFor('2026-09-04', 3)
  const sofa = { instrument: 'CardX', total: 6, startDate: start, monthly: 200, final: null, name: 'DEMO SOFA' }
  const phone = { instrument: 'CardX', total: 6, startDate: start, monthly: 500, final: null, name: 'My phone' }
  it('gives each period line the plan whose amount agrees, whatever order the plans come in', () => {
    expect(stageStatements([{ instrument: 'CardX', result: twoPlans }], ctx({ plans: [phone, sofa] }))).toEqual({ rows: [], issues: [] })
  })
  it('leaves a line for the plan still to be made, instead of handing it the other plan', () => {
    const { rows, issues } = stageStatements([{ instrument: 'CardX', result: twoPlans }], ctx({ plans: [sofa] }))
    expect(rows).toEqual([expect.objectContaining({ text: 'DEMO PHONE 003/006', needsPlan: true })])
    expect(issues).toEqual([])
  })
  it('in review, hides only the line a new plan was made from — by amount, else by name', () => {
    const line = (name: string, charged: number) => ({ instrument: 'CardX', installment: { k: 3, total: 6 }, when: '2026-09-04', charged, name })
    expect(plansFor([sofa], [line('DEMO SOFA 003/006', 200), line('DEMO PHONE 003/006', 500)], false)).toEqual([sofa, undefined])
    expect(plansFor([{ ...sofa, monthly: 210 }], [line('DEMO SOFA 003/006', 200)], false)).toEqual([{ ...sofa, monthly: 210 }])
    expect(plansFor([phone], [line('DEMO SOFA 003/006', 200)], false)).toEqual([undefined])
    // Staging still hands the one plan left to a line, so a plan at the wrong amount is warned about.
    expect(plansFor([phone], [line('DEMO SOFA 003/006', 200)], true)).toEqual([phone])
  })
  it('names the plan after the shop, without the period marker either bank prints', () => {
    expect(withoutPeriodMarker('DEMO SOFA 002/006')).toBe('DEMO SOFA')
    expect(withoutPeriodMarker('02/06 DEMO SOFA')).toBe('DEMO SOFA')
    expect(withoutPeriodMarker('DEMO 24/7 SHOP')).toBe('DEMO 24/7 SHOP')
    expect(withoutPeriodMarker('DEMO SOFA PRIN 01/06')).toBe('DEMO SOFA')
  })
})
