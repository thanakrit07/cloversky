// Pure recurrence math (DESIGN.md §6.6). Everything works on plain
// yyyy-MM-dd strings — dates in this app carry no timezone (§4.3).

export type RecurrenceFreq = 'weekly' | 'monthly' | 'yearly'
export type MonthEndRule = 'clamp' | 'skip'

export interface RecurrenceSchedule {
  freq: RecurrenceFreq
  interval: number
  day_of_month: number | null
  month_of_year: number | null
  weekday: number | null // 0 = Sunday
  month_end: MonthEndRule
  start_date: string
  end_date: string | null
  max_occurrences: number | null
}

function iso(year: number, month0: number, day: number): string {
  const m = String(month0 + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${year}-${m}-${d}`
}

function parts(date: string): { year: number; month0: number; day: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { year: y, month0: m - 1, day: d }
}

function daysInMonth(year: number, month0: number): number {
  // Day 0 of the next month = last day of this month.
  return new Date(year, month0 + 1, 0).getDate()
}

function dayOfWeek(date: string): number {
  const { year, month0, day } = parts(date)
  return new Date(year, month0, day).getDay()
}

function addDays(date: string, days: number): string {
  const { year, month0, day } = parts(date)
  const d = new Date(year, month0, day + days)
  return iso(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Every scheduled date of `rule` within [fromInclusive, toInclusive].
 *
 * Semantics:
 * - Occurrences start at the first candidate on/after start_date; interval
 *   anchoring counts from start_date's period (month/week/year), so a
 *   candidate that falls before start_date in the anchor period is skipped
 *   without shifting the cycle.
 * - month_end 'clamp' moves day 31 to a short month's last day; 'skip'
 *   produces no occurrence that month (and it does not count toward
 *   max_occurrences — only real occurrences count).
 * - end_date and max_occurrences are counted from the rule's beginning,
 *   independent of the requested window.
 */
export function occurrencesBetween(rule: RecurrenceSchedule, fromInclusive: string, toInclusive: string): string[] {
  const hardEnd = rule.end_date && rule.end_date < toInclusive ? rule.end_date : toInclusive
  if (hardEnd < rule.start_date) return []

  const result: string[] = []
  let count = 0

  const push = (date: string): 'stop' | 'ok' => {
    if (date > hardEnd) return 'stop'
    count++
    if (rule.max_occurrences != null && count > rule.max_occurrences) return 'stop'
    if (date >= fromInclusive) result.push(date)
    return 'ok'
  }

  if (rule.freq === 'weekly') {
    const weekday = rule.weekday ?? 0
    const offset = (weekday - dayOfWeek(rule.start_date) + 7) % 7
    let current = addDays(rule.start_date, offset)
    while (push(current) === 'ok') {
      current = addDays(current, 7 * rule.interval)
    }
    return result
  }

  if (rule.freq === 'monthly') {
    const start = parts(rule.start_date)
    const startYm = start.year * 12 + start.month0
    const endParts = parts(hardEnd)
    const endYm = endParts.year * 12 + endParts.month0
    for (let ym = startYm; ym <= endYm; ym += rule.interval) {
      const year = Math.floor(ym / 12)
      const month0 = ym % 12
      const dim = daysInMonth(year, month0)
      let day = rule.day_of_month ?? 1
      if (day > dim) {
        if (rule.month_end === 'skip') continue
        day = dim
      }
      const date = iso(year, month0, day)
      if (date < rule.start_date) continue
      if (push(date) === 'stop') break
    }
    return result
  }

  // yearly
  const start = parts(rule.start_date)
  const endYear = parts(hardEnd).year
  const month0 = (rule.month_of_year ?? 1) - 1
  for (let year = start.year; year <= endYear; year += rule.interval) {
    const dim = daysInMonth(year, month0)
    let day = rule.day_of_month ?? 1
    if (day > dim) {
      if (rule.month_end === 'skip') continue
      day = dim
    }
    const date = iso(year, month0, day)
    if (date < rule.start_date) continue
    if (push(date) === 'stop') break
  }
  return result
}

/** The next scheduled date on/after `from`, or null if the rule is finished. */
export function nextOccurrence(rule: RecurrenceSchedule, from: string): string | null {
  const { year, month0, day } = parts(from)
  // A window of ~2 years covers every legal gap (yearly rules with skip
  // can miss a year when day 29/30/31 doesn't exist, e.g. Feb 29).
  const horizon = iso(year + 2, month0, Math.min(day, 28))
  return occurrencesBetween(rule, from, horizon)[0] ?? null
}

// Approximate monthly equivalent, for fixed costs and what's left each month.
export function monthlyEquivalent(rule: { freq: RecurrenceFreq; interval: number; amount: number }): number {
  if (rule.freq === 'monthly') return rule.amount / rule.interval
  if (rule.freq === 'weekly') return (rule.amount * 52) / 12 / rule.interval
  return rule.amount / 12 / rule.interval
}
