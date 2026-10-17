// UOB card: posting "dd MON" · purchase "dd MON" · description · amount, a
// credit marked "CR" after it. No year anywhere on the line.
import { inferYear, isoDate, money, periodOf } from './dates'
import type { Parser, StatementLine, Unreadable } from './types'

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }
const STARTS_LIKE_LINE = /^\d{2} [A-Z]{3} \d{2} [A-Z]{3} /
const LINE = /^(\d{2}) ([A-Z]{3}) (\d{2}) ([A-Z]{3}) (.+?) ([\d,]+\.\d{2})( CR)?$/
// "01/06" on a plan's lines; k ≤ total keeps a shop name ending in a date out.
const MARKER = /(?:^| )(\d{2,3})\/(\d{2,3})$/

export const parseUob: Parser = (rawLines, asOf) => {
  const lines: StatementLine[] = []
  const unreadable: Unreadable[] = []
  rawLines.forEach((raw, i) => {
    const text = raw.trim()
    const m = LINE.exec(text)
    if (!m) {
      if (STARTS_LIKE_LINE.test(text)) unreadable.push({ line: i + 1, text, reason: 'Looks like a transaction but has no amount at the end' })
      return
    }
    const pm = MONTHS[m[2]]
    const tm = MONTHS[m[4]]
    const amount = money(m[6])
    const posted = pm ? isoDate(inferYear(pm, Number(m[1]), asOf), pm, Number(m[1])) : null
    const date = tm ? isoDate(inferYear(tm, Number(m[3]), asOf), tm, Number(m[3])) : null
    if (!posted || !date || amount === null) {
      unreadable.push({ line: i + 1, text, reason: 'Date or amount is not valid' })
      return
    }
    const marker = MARKER.exec(m[5])
    const installment = marker && Number(marker[1]) <= Number(marker[2]) ? { k: Number(marker[1]), total: Number(marker[2]) } : null
    lines.push({
      line: i + 1,
      date,
      postedDate: posted,
      amount,
      direction: m[7] ? 'credit' : 'debit',
      text: m[5],
      installment,
      // A plan's period prints as "<shop> PRIN 01/06" and its interest as "<shop> INT 01/06".
      isInterest: /INTEREST/i.test(m[5]) || (!!installment && /\sINT\s+\d{2,3}\/\d{2,3}$/.test(m[5])),
    })
  })
  if (lines.length === 0) return null
  return { layout: 'uob', lines, unreadable, ...periodOf(lines.map((l) => l.date)) }
}
