import { useMemo, useState } from 'react'
import { CalendarSync, CreditCard, Plus, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { InstallmentsScreen } from '@/features/installments/InstallmentsScreen'
import { useCardCycleAdjustments } from '@/lib/cardCycleAdjustments'
import { useCards } from '@/lib/cards'
import { useHousehold } from '@/lib/HouseholdContext'
import { formatBaht } from '@/lib/format'
import { cycleBill, cycleOf, periodCharge, periodDate } from '@/lib/finance/billingCycle'
import { monthlyEquivalent, nextOccurrence } from '@/lib/finance/recurrence'
import { useInstallmentPayments, useInstallments, usePostedPeriods } from '@/lib/installments'
import { ALL_TIME, dayMonthLabel } from '@/lib/month'
import { useRecurringRules, useUpdateRecurringRule, type RecurringRule } from '@/lib/recurring'
import { useTransactions } from '@/lib/transactions'
import { cn } from '@/lib/utils'
import { CardForecastTab } from './CardForecastTab'
import { DebtSection } from './DebtSection'
import { RecurringRuleSheet } from './RecurringRuleSheet'
import { UpcomingDensityPrototype } from './UpcomingDensityPrototype'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// How far ahead "Coming up" looks — enough to answer "what's due soon"
// without turning into a second forecast tab (CardForecastTab already
// covers the long horizon, month by month).
export const HORIZON_DAYS = 45

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function scheduleLabel(rule: RecurringRule): string {
  const every = rule.interval > 1 ? `Every ${rule.interval} ` : ''
  if (rule.freq === 'weekly') {
    return `${every}${rule.interval > 1 ? 'weeks' : 'Weekly'} · ${WEEKDAYS[rule.weekday ?? 0]}`
  }
  if (rule.freq === 'monthly') {
    return `${every}${rule.interval > 1 ? 'months' : 'Monthly'} · day ${rule.day_of_month}`
  }
  return `${every}${rule.interval > 1 ? 'years' : 'Yearly'} · ${rule.day_of_month} ${MONTHS[(rule.month_of_year ?? 1) - 1]}`
}

export interface TimelineRow {
  key: string
  date: string
  label: string
  sublabel: string
  posted: number
  projected: number
  rule?: RecurringRule
}

// v3.9: a single forward timeline, organised by purpose (what's coming, then
// how to manage it) instead of by entity (a tab per plan type, each
// answering a slightly different question). Merges every card's next bill
// with every account-billed recurring occurrence and installment period due
// within the horizon — Posted (installment periods, unescapable) shown
// solid, Projected (recurring, cancellable) as a lighter extension, same as
// CardForecastTab. This also closes the gap where a card-billed
// subscription's cost was silently counted twice: once inside its card's
// own bill, once again inside Recurring's "Fixed costs" — Fixed costs now
// excludes anything billed to a card, since that's covered here instead.
export function useComingUpRows(): TimelineRow[] {
  const { householdId } = useHousehold()
  const { data: cards } = useCards(householdId)
  const { data: installments } = useInstallments(householdId)
  const { data: payments } = useInstallmentPayments(householdId)
  const { data: postedPeriods } = usePostedPeriods(householdId)
  const { data: adjustments } = useCardCycleAdjustments(householdId)
  const { data: rules } = useRecurringRules(householdId)
  const { data: transactions } = useTransactions(householdId, ALL_TIME)

  const today = todayIso()
  const horizon = addDaysIso(today, HORIZON_DAYS)

  const paidCountByInstallment = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of payments ?? []) map.set(p.installment_id, (map.get(p.installment_id) ?? 0) + 1)
    return map
  }, [payments])

  const rows = useMemo<TimelineRow[]>(() => {
    const list: TimelineRow[] = []
    const allTxns = transactions ?? []

    // Each active card's next bill — always shown, however far its due
    // date is, since it's the single most relevant fact for that card.
    for (const card of (cards ?? []).filter((c) => !c.archived)) {
      const cycle = cycleOf(card, today)
      const cardTxns = allTxns.filter((t) => (t.from_card_id === card.id || t.to_card_id === card.id) && t.confirmed)
      const cardInstallments = (installments ?? []).filter((i) => i.card_id === card.id && i.status === 'active')
      const adjustment = (adjustments ?? []).find((a) => a.card_id === card.id && a.cycle_start === cycle.start)
      const posted = cycleBill({
        cycle,
        cardId: card.id,
        transactions: cardTxns,
        installments: cardInstallments,
        adjustment: adjustment?.amount ?? null,
        postedPeriods: postedPeriods?.keys ?? new Set(),
      })
      const total = cycleBill({
        cycle,
        cardId: card.id,
        transactions: cardTxns,
        installments: cardInstallments,
        adjustment: adjustment?.amount ?? null,
        postedPeriods: postedPeriods?.keys ?? new Set(),
        recurringRules: rules ?? [],
      })
      if (total <= 0) continue
      list.push({
        key: `card:${card.id}`,
        date: cycle.dueDate,
        label: card.name,
        sublabel: `Due ${dayMonthLabel(cycle.dueDate)}`,
        posted,
        projected: total - posted,
      })
    }

    // Recurring occurrences not billed to a card — a card-billed rule's
    // next charge already lives inside that card's row above.
    for (const rule of (rules ?? []).filter((r) => r.active && !r.from_card_id)) {
      const next = nextOccurrence(rule, today)
      if (!next || next > horizon) continue
      list.push({
        key: `recurring:${rule.id}`,
        date: next,
        label: rule.name,
        sublabel: `${rule.kind === 'income' ? '+' : '-'}${formatBaht(rule.amount)} projected`,
        posted: 0,
        projected: rule.kind === 'income' ? 0 : rule.amount,
        rule,
      })
    }

    // Installment periods not billed to a card — Posted, since they're
    // already a real row in the ledger (card-billed periods are folded
    // into their card's cycle bill above instead).
    for (const inst of (installments ?? []).filter((i) => i.status === 'active' && !i.card_id)) {
      const paid = paidCountByInstallment.get(inst.id) ?? 0
      if (paid >= inst.total_periods) continue
      const date = periodDate(inst.start_date, paid + 1)
      if (date > horizon) continue
      list.push({
        key: `installment:${inst.id}:${paid + 1}`,
        date,
        label: inst.name,
        sublabel: `Period ${paid + 1}/${inst.total_periods} posted`,
        posted: periodCharge(inst, paid + 1),
        projected: 0,
      })
    }

    return list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }, [cards, installments, paidCountByInstallment, postedPeriods, adjustments, rules, transactions, today, horizon])
  return rows
}

const ROW_ICON = { card: CreditCard, recurring: Repeat, installment: CalendarSync } as const

// 2026-10 redesign: a dated timeline, the way Records hangs a day's rows off
// its date — the day in a left column, that day's rows beside it, each with
// Balances' icon square (amber for a card bill).
export function ComingUpSection({ rows, onEditRecurring }: { rows: TimelineRow[]; onEditRecurring: (rule: RecurringRule) => void }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing due soon.</p>
  }

  const byDate = new Map<string, TimelineRow[]>()
  for (const row of rows) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row])

  return (
    <ol className="space-y-3">
      {[...byDate.entries()].map(([date, dayRows]) => {
        const d = new Date(`${date}T00:00:00`)
        return (
          <li key={date} className="grid grid-cols-[3rem_1fr] gap-2">
            <div className="pt-1 text-center leading-none">
              <span className="block text-xl font-semibold tabular-nums">{d.getDate()}</span>
              <span className="block text-[11px] text-muted-foreground">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
            </div>
            <ul className="space-y-1 border-l pl-3">
              {dayRows.map((row) => {
                const kind = row.key.startsWith('card:') ? 'card' : row.rule ? 'recurring' : 'installment'
                const Icon = ROW_ICON[kind]
                const body = (
                  <>
                    <span
                      className={cn(
                        'grid size-8 shrink-0 place-items-center rounded-lg',
                        kind === 'card' ? 'bg-warning text-warning-foreground' : 'bg-secondary text-secondary-foreground',
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{row.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{row.sublabel}</span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {row.posted > 0 && formatBaht(row.posted)}
                      {row.posted > 0 && row.projected > 0 && <span className="text-muted-foreground"> + </span>}
                      {row.projected > 0 && <span className={row.posted > 0 ? 'text-muted-foreground' : undefined}>{formatBaht(row.projected)}</span>}
                    </span>
                  </>
                )
                return (
                  <li key={row.key}>
                    {row.rule ? (
                      <button onClick={() => onEditRecurring(row.rule!)} className="flex w-full items-center gap-3 py-1 text-left">
                        {body}
                      </button>
                    ) : (
                      <div className="flex items-center gap-3 py-1">{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}

export function RecurringTab() {
  const { householdId } = useHousehold()
  const { data: rules } = useRecurringRules(householdId)
  const updateRule = useUpdateRecurringRule(householdId)
  const [editing, setEditing] = useState<RecurringRule | 'new' | null>(null)

  const active = (rules ?? []).filter((r) => r.active)
  // Card-billed rules are counted in Card bills' Projected figure instead —
  // counting them here too would be the same charge twice.
  const monthlyExpense = active
    .filter((r) => r.kind === 'expense' && !r.from_card_id)
    .reduce((s, r) => s + monthlyEquivalent(r), 0)
  const monthlyIncome = active.filter((r) => r.kind === 'income').reduce((s, r) => s + monthlyEquivalent(r), 0)

  return (
    <div className="space-y-4">
      <div className="px-1">
        <h2 className="font-heading text-sm font-medium text-muted-foreground">Recurring per month (approx.)</h2>
        <dl className="mt-2 grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs text-muted-foreground">Fixed costs</dt>
            <dd className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">{formatBaht(monthlyExpense)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Income</dt>
            <dd className="text-2xl font-semibold tracking-[-0.02em] tabular-nums text-good">{formatBaht(monthlyIncome)}</dd>
          </div>
        </dl>
        <p className="mt-1.5 text-xs text-muted-foreground">Card-billed subscriptions count in Card bills above, not here.</p>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-sm font-medium text-muted-foreground">Recurring rules</h2>
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            Add
          </Button>
        </div>

        <ul className="overflow-hidden rounded-2xl border bg-card">
          {(rules ?? []).map((rule) => {
            const next = rule.active ? nextOccurrence(rule, todayIso()) : null
            return (
              <li key={rule.id} className="flex items-center gap-2 border-t px-3 py-2 first:border-t-0">
                <Repeat className="size-4 shrink-0 text-muted-foreground" />
                <button onClick={() => setEditing(rule)} className="min-w-0 flex-1 text-left">
                  <span className={rule.active ? 'block truncate text-sm' : 'block truncate text-sm text-muted-foreground line-through'}>
                    {rule.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {scheduleLabel(rule)}
                    {next && ` · next ${next}`}
                  </span>
                </button>
                <span className={rule.kind === 'income' ? 'text-sm text-good' : 'text-sm'}>
                  {rule.kind === 'income' ? '+' : rule.kind === 'expense' ? '-' : ''}
                  {formatBaht(rule.amount)}
                </span>
                <Switch
                  checked={rule.active}
                  onCheckedChange={(checked) => updateRule.mutate({ id: rule.id, input: { active: checked } })}
                  aria-label={`${rule.name} active`}
                />
              </li>
            )
          })}
          {rules?.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No recurring rules yet. Add salary, insurance, subscriptions — they'll be recorded automatically on schedule.
            </p>
          )}
        </ul>
      </section>

      {editing && (
        <RecurringRuleSheet
          key={editing === 'new' ? 'new' : editing.id}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// D-0004: no sub-tabs — everything sits on one scrollable screen, so a plan
// is one tap from the FAB instead of two. v3.9 reorganises it by purpose:
// the forward view leads, and the per-type management lists — Recurring
// rules, Installments — sit below for editing what generates those rows.
// 2026-10: the forward view is the headline, the card-bill chart (a spike
// seen before it's read), then Coming up as a dated timeline.
export function PlanScreen() {
  const [editingRule, setEditingRule] = useState<RecurringRule | null>(null)
  const rows = useComingUpRows()
  const posted = rows.reduce((sum, r) => sum + r.posted, 0)
  const projected = rows.reduce((sum, r) => sum + r.projected, 0)

  const current = (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      {/* 2026-10 redesign: the same headline as Records and Balances — the
          tab's one number, big — here everything due inside Coming up's
          horizon, with the Posted / Projected split under it (§7.3: both at
          once, never behind a toggle). */}
      <div className="px-1 pt-2">
        <span className="text-[13px] text-muted-foreground">Due in the next {HORIZON_DAYS} days</span>
        <span className="mt-1 block text-[42px] font-semibold leading-none tracking-[-0.035em] tabular-nums">
          {formatBaht(posted + projected)}
        </span>
        <span className="mt-2.5 block text-[13px] tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{formatBaht(posted)}</span> posted
          <span className="mx-2 text-border">/</span>
          {formatBaht(projected)} projected
        </span>
      </div>

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-medium">Card bills by month</h2>
        <CardForecastTab />
      </section>

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-medium">Coming up</h2>
        <ComingUpSection rows={rows} onEditRecurring={setEditingRule} />
      </section>

      <section>
        <DebtSection />
      </section>

      <section>
        <RecurringTab />
      </section>
      <section>
        <InstallmentsScreen />
      </section>

    </div>
  )

  return (
    <>
      {import.meta.env.DEV ? <UpcomingDensityPrototype current={current} onEditRecurring={setEditingRule} /> : current}
      {editingRule && <RecurringRuleSheet rule={editingRule} onClose={() => setEditingRule(null)} />}
    </>
  )
}
