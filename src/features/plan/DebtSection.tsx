import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useCardCycleAdjustments } from '@/lib/cardCycleAdjustments'
import { useCards } from '@/lib/cards'
import { debts, payoffByMonth, type CarriedCard } from '@/lib/finance/debt'
import { closedBillFor, setAside } from '@/lib/finance/balances'
import { monthlyEquivalent } from '@/lib/finance/recurrence'
import { formatBaht } from '@/lib/format'
import { useHousehold } from '@/lib/HouseholdContext'
import { useInstallments, usePostedPeriods } from '@/lib/installments'
import { ALL_TIME, monthLabel, shiftMonth } from '@/lib/month'
import { useRecurringRules } from '@/lib/recurring'
import { useTransactions } from '@/lib/transactions'
import { cn } from '@/lib/utils'
import { DebtPrototype } from './DebtPrototype'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// SPEC §4.5 / DESIGN.md §6.4: which debt to pay first (avalanche), when the
// household is debt-free, and what is left each month as plans end. "Left"
// is recurring income − recurring costs − debt due: the money free to save
// or pay down, before everyday spending.
export function DebtSection({ hideList = false }: { hideList?: boolean }) {
  const { householdId } = useHousehold()
  const { data: installments } = useInstallments(householdId)
  const { data: cards } = useCards(householdId)
  const { data: transactions } = useTransactions(householdId, ALL_TIME)
  const { data: postedPeriods } = usePostedPeriods(householdId)
  const { data: adjustments } = useCardCycleAdjustments(householdId)
  const { data: rules } = useRecurringRules(householdId)

  const model = useMemo(() => {
    const today = todayIso()
    const plans = (installments ?? []).filter((i) => i.status === 'active')

    // A card carries debt only once a bill is past due and still unpaid
    // (the same test as Balances' "past due").
    const carried: CarriedCard[] = []
    const txns = transactions ?? []
    const posted = postedPeriods?.keys ?? new Set<string>()
    for (const card of (cards ?? []).filter((c) => !c.archived)) {
      const { dueDate, cardInstallments, adjustment } = closedBillFor(card, txns, installments ?? [], posted, adjustments ?? [], today)
      if (dueDate >= today) continue
      const amount = setAside(card, txns, cardInstallments, posted, adjustment, today)
      if (amount > 0) carried.push({ id: card.id, name: card.name, annual_interest_rate: card.annual_interest_rate, amount })
    }

    const active = (rules ?? []).filter((r) => r.active)
    const income = active.filter((r) => r.kind === 'income').reduce((s, r) => s + monthlyEquivalent(r), 0)
    const costs = active.filter((r) => r.kind === 'expense').reduce((s, r) => s + monthlyEquivalent(r), 0)

    return {
      list: debts(plans, carried, today),
      months: payoffByMonth(plans, carried, today),
      income,
      net: income - costs,
    }
  }, [installments, cards, transactions, postedPeriods, adjustments, rules])

  const { list, months, income, net } = model
  if (!list.length) {
    return (
      <div className="space-y-2">
        <h2 className="px-1 text-sm font-medium">Debt</h2>
        <p className="px-1 text-sm text-muted-foreground">No debt. Nothing to pay down.</p>
      </div>
    )
  }

  const total = list.reduce((s, d) => s + d.outstanding, 0)
  const lastMonth = months.at(-1)!.month
  // A month's worth of every running plan; this month's own figure is partial (periods already posted drop out).
  const dueNow = list.filter((d) => d.kind === 'installment').reduce((s, d) => s + d.monthly, 0)
  // The months something ends, and what each month costs from the next one on.
  const milestones = months
    .filter((m) => m.ending.length)
    .map((m) => {
      const after = shiftMonth(m.month, 1)
      return { ...m, after, dueAfter: months.find((x) => x.month === after)?.due ?? 0 }
    })

  const current = (
    <div className="space-y-4">
      <h2 className="px-1 text-sm font-medium">Debt</h2>

      <dl className="grid grid-cols-3 gap-3 px-1">
        <div>
          <dt className="text-xs text-muted-foreground">Owed</dt>
          <dd className="text-xl font-semibold tracking-[-0.02em] tabular-nums">{formatBaht(total)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Debt-free after</dt>
          <dd className="text-xl font-semibold tracking-[-0.02em]">{monthLabel(lastMonth)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Left each month</dt>
          {income > 0 ? (
            <dd className="tabular-nums">
              <span className={cn('text-xl font-semibold tracking-[-0.02em]', net - dueNow < 0 && 'text-destructive')}>{formatBaht(net - dueNow)}</span>
              <span className="block text-xs text-muted-foreground">then {formatBaht(net)} debt-free</span>
            </dd>
          ) : (
            <dd className="text-xs text-muted-foreground">Add income as a recurring rule to see what's left</dd>
          )}
        </div>
      </dl>

      <section className={cn('space-y-2', hideList && 'hidden')}>
        <h3 className="px-1 text-xs font-medium text-muted-foreground">Pay first — highest interest at the top</h3>
        <ol className="overflow-hidden rounded-2xl border bg-card">
          {list.map((d, i) => {
            const high = d.rate >= 5
            return (
              <li key={d.id} className="flex items-center gap-3 border-t px-3 py-2 first:border-t-0">
                <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    {high && <AlertTriangle className="size-3.5 shrink-0 text-warning-foreground" />}
                    <span className="truncate">{d.name}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground tabular-nums">
                    {d.kind === 'card' ? 'Card bill past due' : `${formatBaht(d.monthly)}/mo · ends ${monthLabel(d.endsIn)}`}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  <span className="block text-sm tabular-nums">{formatBaht(d.outstanding)}</span>
                  {d.rate > 0 ? (
                    <Badge variant={high ? 'destructive' : 'secondary'}>{d.rate}%/yr</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">0%</span>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">As plans end</h3>
        <ol className="overflow-hidden rounded-2xl border bg-card">
          <li className="flex items-baseline gap-3 px-3 py-2">
            <span className="flex-1 text-sm">Now</span>
            <MonthFigures due={dueNow} left={income > 0 ? net - dueNow : null} />
          </li>
          {milestones.map((m) => (
            <li key={m.month} className="flex items-baseline gap-3 border-t px-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="block text-sm">From {monthLabel(m.after)}</span>
                <span className="block truncate text-xs text-muted-foreground">{m.ending.join(', ')} paid off</span>
              </div>
              <MonthFigures due={m.dueAfter} left={income > 0 ? net - m.dueAfter : null} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  )

  if (!import.meta.env.DEV || hideList) return current
  return <DebtPrototype current={current} list={list} months={months} income={income} net={net} dueNow={dueNow} milestones={milestones} />
}

export function DebtFigures({ total, lastMonth, income, net, dueNow }: { total: number; lastMonth: string; income: number; net: number; dueNow: number }) {
  return (
    <dl className="grid grid-cols-3 gap-3 px-1">
      <div>
        <dt className="text-xs text-muted-foreground">Owed</dt>
        <dd className="text-xl font-semibold tracking-[-0.02em] tabular-nums">{formatBaht(total)}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Debt-free after</dt>
        <dd className="text-xl font-semibold tracking-[-0.02em]">{monthLabel(lastMonth)}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Left each month</dt>
        {income > 0 ? (
          <dd className="tabular-nums">
            <span className={cn('text-xl font-semibold tracking-[-0.02em]', net - dueNow < 0 && 'text-destructive')}>{formatBaht(net - dueNow)}</span>
            <span className="block text-xs text-muted-foreground">then {formatBaht(net)} debt-free</span>
          </dd>
        ) : (
          <dd className="text-xs text-muted-foreground">Add income as a recurring rule to see what's left</dd>
        )}
      </div>
    </dl>
  )
}

function MonthFigures({ due, left }: { due: number; left: number | null }) {
  return (
    <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
      {formatBaht(due)} debt
      {left != null && (
        <span className={cn('block text-sm font-medium', left < 0 ? 'text-destructive' : 'text-foreground')}>{formatBaht(left)} left</span>
      )}
    </span>
  )
}
