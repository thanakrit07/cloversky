// ADR-0019's staging rules, applied to parsed statements: what becomes a
// transfer, what is skipped because the app already has it, what a refund is.
// Pure: no database. The household-specific lists at the top (which words mean
// which of its accounts) are the part that moves into `counterparties`
// (ADR-0020) once the review screen can fill them in.
import { periodDate } from '../finance/billingCycle'
import { formatBaht } from '../format'
import { normalizeStatementText } from '../statementImport'
import type { ParseResult, StatementLine } from './types'

export interface StagedRow {
  date: string
  postedDate: string | null
  kind: 'income' | 'expense' | 'transfer'
  amount: number
  /** Category name, '' for a transfer. */
  category: string
  from: string
  to: string
  text: string
  /** An installment the app has no plan for: shown in review, not imported. */
  needsPlan: boolean
  /** Which period of how many, for an installment line. */
  installment: { k: number; total: number } | null
  /** The card's interest line for this period, when it printed one beside it. */
  periodInterest?: number
  /** The account or card whose statement this line came from; keeps the line's key stable. */
  statement: string
  /** The name after the account on a bank transfer line, as printed. */
  counterparty: string | null
  /** The file the line was read from, as shown to the household. */
  file: string
}

export interface StageIssue {
  /** What went wrong, for a caller that wants to act on it rather than just show it. */
  code: 'orphan_conversion' | 'plan_amount_differs'
  /** The day of the line the issue is about. */
  date: string
  instrument: string
  reason: string
  text: string
  amount: number
}

export interface PlanRef {
  instrument: string
  total: number
  startDate: string
  /** What the plan posts each period, and its last period when that differs; checked against what the card charged. */
  monthly?: number
  final?: number | null
  /** The interest line it posts beside each period (0036); null when monthly is the whole charge. */
  interest?: number | null
}

export interface StageContext {
  plans: PlanRef[]
  /** normalised description -> category name, from v_category_hints. */
  hints: ReadonlyMap<string, string>
}

export interface StageInput {
  /** The account or card this file is a statement of, by name. */
  instrument: string
  /** The file's display name, carried onto each row so the review can say where it came from. */
  fileName?: string
  result: ParseResult
}

// ponytail: names of this household's accounts, matched on the words a card
// statement prints beside a payment. Moves into counterparties.
const PAYERS: { re: RegExp; account: string }[] = [
  { re: /KBANK/i, account: 'กสิกร' },
  { re: /TMRW|UOBT/i, account: 'UOB TMRW' },
  { re: /Easy App/i, account: 'SCB' },
]
const PAYMENT = /^Payment|PAYMENT THANK YOU/i
// A credit that undoes a purchase because it was turned into an installment.
const CONVERSION = /IPP SETUP|TRANSFER TO FLEXI|PAYLATER|CR ADJUST/i
// ponytail: this household's card payments as a bank statement prints them.
const BANK_CARD_PAYMENTS: { re: RegExp; to: string }[] = [
  { re: /CardX\/SCB WEALTH/, to: 'CardX' },
  { re: /KRUNGTHAI CARD|บัตรเครดิต KTC/, to: 'KTC' },
  { re: /โอนไป UOBT/, to: 'UOB TMRW' },
]

const KEYWORDS: [RegExp, string][] = [
  [/EXPRES|TOLLWAY|CHALERM MAHA|CHALONG RAT|SRI RAT|UDON RATTHAYA|PRACHIM RATTAYA|DON MUANG TOLL/i, 'Parking & tolls'],
  [/\bMRT\b|\bBTS\b|TMG MRT|ALP\*.*METRO|TRANSIT|GUIDAO|SUBWAY/i, 'Public transit'],
  [/GRAB|BOLT|LINE MAN RIDE|TAXI/i, 'Taxi & ride-hailing'],
  [/PTTST|BANGCHAK|SHELL|ESSO|CALTEX|EVST|EV STATION/i, 'Fuel'],
  [/TAOBAO|LAZADA|SHOPEE|ช้อปปี้|AMZ|PANDUO|TEMU|ALIEXPRESS/i, 'Marketplace'],
  [/HELLO ?BIKE|DIDI/i, 'Transport'],
  [/KFC|MCDONALD|BONCHON|SUSHIRO|YAYOI|BAR BQ|\bMK\b|SUKI|สุกี้|CAFE|COFFEE|คอฟฟี่|คาเฟ่|LINEPAY|LINE MAN|FOODPANDA|RESTAURANT|MAXVALU|TOPS|LOTUS|BIG C|MAKRO|7-ELEVEN|ซีพี แอ็กซ์ตร้า|ร้านอาหาร|JUICE|SUPERM|SNACK|VENDING|LUCKIN|MIXUE/i, 'Food'],
  [/APPLE\.COM|GOOGLE|NETFLIX|SPOTIFY|YOUTUBE|BILIBILI|MKONEPASS|CANVA/i, 'Subscriptions'],
  [/FITNESS|FITWHEY|GYM/i, 'Fitness'],
  [/DENTAL|ทันต/i, 'Dental'],
  [/CLINIC|คลินิก|HOSPITAL|โรงพยาบาล/i, 'Doctor & clinic'],
  [/WATSONS|BOOTS|PHARMA/i, 'Pharmacy'],
  [/ADVANCED WIRELESS|TRUEMOVE|DTAC|UNICOM|CHINA MOBILE/i, 'Mobile'],
  [/AIATH|ALLIANZ|MUANG THAI LIFE/i, 'Life'],
  [/AGODA|AIRASIA|THAI AIRWAYS|NOK ?AIR|TRIP\.?COM|TRIPCOM|BOOKING/i, 'Travel'],
  [/UNIVERSI|มหาวิทยาลัย/i, 'Courses'],
  [/HOME PRODUCT|IKEA|HOMEPRO|INDEX LIVING/i, 'Home & furniture'],
  [/SHOES|FASHION|UNIQLO|H&M|ZARA|JEANS/i, 'Clothing & shoes'],
  [/Cash Adv Fee/i, 'Cash advance fee'],
]

/** "โอนไป SCB X1234 <name>" or "จาก X1234 <name>": the name, without the trailing +s. */
const COUNTERPARTY = /(?:โอนไป|จาก)\s+(?:[A-Za-zก-๙]{2,12}\s+)?X\w{3,4}\s+(\S.*?)\s*\+*\s*$/
// Kept prints where money went as a bank and a partly hidden account ("KBANK 1xx-2-xxx45-6")
// or a hidden phone number, with the name on a later line the parser folds into the text.
const KEPT_COUNTERPARTY = /\b[A-Za-z]{2,5}\s+[0-9xX]{3}-[0-9xX]-[0-9xX]{5}-[0-9xX]|\b[0-9xX]{3}-[0-9xX]{3}-[0-9]{4}\b/
function counterpartyOf(text: string, layout: string): string | null {
  if (layout === 'kept') return KEPT_COUNTERPARTY.exec(text)?.[0] ?? null
  return COUNTERPARTY.exec(text)?.[1].trim() || null
}

function guessCategory(text: string, hints: ReadonlyMap<string, string>): string {
  const remembered = hints.get(normalizeStatementText(text))
  if (remembered) return remembered
  return KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'Other'
}

const isBank = (layout: string) => layout === 'kbank' || layout === 'kept'
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000
const PLAN_WINDOW_DAYS = 20

/** A plan with the same number of periods whose period k falls about when this line posted. */
function coveringPlan(plans: PlanRef[], instrument: string, { k, total }: { k: number; total: number }, when: string): PlanRef | undefined {
  return plans.find((p) => p.instrument === instrument && p.total === total && days(periodDate(p.startDate, k), when) <= PLAN_WINDOW_DAYS)
}
export const planCovers = (...args: Parameters<typeof coveringPlan>) => coveringPlan(...args) !== undefined

/** The start date a plan needs for its period k to fall on `when`: k−1 months earlier. */
export const planStartFor = (when: string, k: number) => periodDate(when, 2 - k)

/** The shop's name without the "002/006" or "02/06" a card prints for the period. */
export const withoutPeriodMarker = (text: string) => text.replace(/^\d{2,3}\/\d{2,3}\s+|\s+\d{2,3}\/\d{2,3}$/g, '').trim()

export function stageStatements(files: StageInput[], ctx: StageContext): { rows: StagedRow[]; issues: StageIssue[] } {
  const rows: StagedRow[] = []
  const issues: StageIssue[] = []

  // The days a bank statement vouches for, per account: a card's "payment
  // received" inside one is already recorded from the bank's side.
  const bankWindows = new Map<string, [string, string]>()
  for (const f of files) {
    if (isBank(f.result.layout) && f.result.periodStart && f.result.periodEnd) bankWindows.set(f.instrument, [f.result.periodStart, f.result.periodEnd])
  }
  const bankCovers = (account: string, date: string) => {
    const w = bankWindows.get(account)
    return w !== undefined && date >= w[0] && date <= w[1]
  }

  // A conversion credit cancels the purchase it converted, wherever in the
  // same card's files that purchase is.
  const dropped = new Set<StatementLine>()
  const byInstrument = new Map<string, StatementLine[]>()
  for (const f of files) byInstrument.set(f.instrument, [...(byInstrument.get(f.instrument) ?? []), ...f.result.lines])
  for (const [instrument, lines] of byInstrument) {
    for (const credit of lines.filter((l) => l.direction === 'credit' && CONVERSION.test(l.text))) {
      dropped.add(credit)
      const purchase = lines
        .filter((l) => l.direction === 'debit' && !dropped.has(l) && !l.installment && Math.abs(l.amount - credit.amount) < 0.005 && l.date <= credit.date)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0]
      if (purchase) dropped.add(purchase)
      else issues.push({ code: 'orphan_conversion', date: credit.date, instrument, reason: 'A credit that converts a purchase to an installment has no matching purchase in these files, so it was not imported', text: credit.text, amount: credit.amount })
    }
  }

  // A card that prints a period's interest on its own line ("IPP Interest
  // 003/006") bills the period as two lines. A plan posts the same two rows
  // (0036), so the interest line rides along with its period: a plan is made
  // with it and checked against it. Paired by card, period and posting day,
  // and only when that day has one such period.
  const periodKey = (instrument: string, l: StatementLine) => `${instrument}|${l.installment!.k}/${l.installment!.total}|${l.postedDate ?? l.date}`
  const principals = new Map<string, number>()
  const interest = new Map<string, number>()
  for (const [instrument, lines] of byInstrument) {
    for (const l of lines) {
      if (!l.installment || l.direction !== 'debit' || dropped.has(l)) continue
      const key = periodKey(instrument, l)
      if (l.isInterest) interest.set(key, (interest.get(key) ?? 0) + l.amount)
      else principals.set(key, (principals.get(key) ?? 0) + 1)
    }
  }
  const paired = (key: string) => principals.get(key) === 1 && interest.has(key)

  for (const { instrument, result, fileName } of files) {
    for (const l of result.lines) {
      if (dropped.has(l)) continue
      const base = { date: l.date, postedDate: l.postedDate, amount: l.amount, text: l.text, statement: instrument, file: fileName ?? '', counterparty: isBank(result.layout) ? counterpartyOf(l.text, result.layout) : null }

      if (isBank(result.layout)) {
        if (l.direction === 'debit') {
          const card = BANK_CARD_PAYMENTS.find((p) => p.re.test(l.text))
          if (card) rows.push({ ...base, kind: 'transfer', category: '', from: instrument, to: card.to, needsPlan: false, installment: null })
          else rows.push({ ...base, kind: 'expense', category: guessCategory(l.text, ctx.hints), from: instrument, to: '', needsPlan: false, installment: null })
        } else {
          rows.push({ ...base, kind: 'income', category: /PAYROLL|เงินเดือน/i.test(l.text) ? 'Salary' : 'Other', from: instrument, to: '', needsPlan: false, installment: null })
        }
        continue
      }

      if (l.installment) {
        const key = periodKey(instrument, l)
        if (l.isInterest && paired(key)) continue // rides along with its period
        const lineInterest = !l.isInterest && paired(key) ? interest.get(key)! : 0
        const plan = coveringPlan(ctx.plans, instrument, l.installment, l.postedDate ?? l.date)
        if (plan) {
          // The app posts these itself; say so when the period costs a different amount
          // from the card's. Compared in total, so a plan from before 0036 whose monthly
          // amount already holds the interest still agrees.
          const { k, total } = l.installment
          const principal = k === total ? (plan.final ?? plan.monthly) : plan.monthly
          const charged = Math.round((l.amount + lineInterest) * 100) / 100
          const posts = principal == null ? null : Math.round((principal + (plan.interest ?? 0)) * 100) / 100
          if (!l.isInterest && posts != null && Math.abs(posts - charged) >= 0.01) {
            issues.push({
              code: 'plan_amount_differs',
              date: l.postedDate ?? l.date,
              instrument,
              reason: `The card charged ${formatBaht(charged)} for period ${k} of ${total}${lineInterest ? ` (${formatBaht(lineInterest)} of it interest)` : ''}, but the plan posts ${formatBaht(posts)}. Delete the plan and make it again at the card's amounts so the two agree`,
              text: l.text,
              amount: charged,
            })
          }
          continue
        }
        rows.push({ ...base, kind: 'expense', category: l.isInterest ? 'Card interest' : 'Installments', from: instrument, to: '', needsPlan: true, installment: l.installment, ...(lineInterest ? { periodInterest: lineInterest } : {}) })
        continue
      }
      if (l.isInterest) {
        rows.push({ ...base, kind: 'expense', category: 'Card interest', from: instrument, to: '', needsPlan: false, installment: null })
        continue
      }
      if (l.direction === 'credit') {
        if (PAYMENT.test(l.text)) {
          const payer = PAYERS.find((p) => p.re.test(l.text))?.account ?? ''
          if (payer && bankCovers(payer, l.date)) continue // recorded from the bank's statement
          rows.push({ ...base, kind: 'transfer', category: '', from: payer, to: instrument, needsPlan: false, installment: null })
        } else {
          rows.push({ ...base, kind: 'income', category: 'Refund', from: instrument, to: '', needsPlan: false, installment: null })
        }
        continue
      }
      rows.push({ ...base, kind: 'expense', category: guessCategory(l.text, ctx.hints), from: instrument, to: '', needsPlan: false, installment: null })
    }
  }
  return { rows, issues }
}
