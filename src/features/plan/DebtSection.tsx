import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useCardCycleAdjustments } from '@/lib/cardCycleAdjustments'
import { useCards } from '@/lib/cards'
import { debts, endings, payoffByMonth, type CarriedCard, type Debt } from '@/lib/finance/debt'
import { closedBillFor, setAside } from '@/lib/finance/balances'
import { monthlyEquivalent } from '@/lib/finance/recurrence'
import { formatBaht } from '@/lib/format'
import { useHousehold } from '@/lib/HouseholdContext'
import { useInstallments, usePostedPeriods } from '@/lib/installments'
import { ALL_TIME, monthLabel } from '@/lib/month'
import { useRecurringRules } from '@/lib/recurring'
import { useTransactions } from '@/lib/transactions'
import { cn } from '@/lib/utils'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// SPEC §4.5 / DESIGN.md §6.4: which debt to pay first (avalanche), when the
// household is debt-free, and what is left each month as plans end. "Left"
// is recurring income − recurring costs − debt due: the money free to save
// or pay down, before everyday spending.
export function useDebtModel() {
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
  return model
}

// SPEC §4.5 / DESIGN.md §6.4. Pay first ranks only what costs interest
// (and any past-due card bill): 0% plans have no order worth acting on, so
// they fold to one line. As plans end leads with what each ending frees.
export function DebtSection() {
  const { list, months, income, net } = useDebtModel()
  const [showFree, setShowFree] = useState(false)
  if (!list.length) return <p className="px-1 text-sm text-muted-foreground">No debt. Nothing to pay down.</p>

  const total = list.reduce((s, d) => s + d.outstanding, 0)
  const lastMonth = months.at(-1)!.month
  // A month's worth of every running plan; this month's own figure is partial (periods already posted drop out).
  const dueNow = list.filter((d) => d.kind === 'installment').reduce((s, d) => s + d.monthly, 0)
  const steps = endings(months, dueNow)
  const ranked = list.filter((d) => d.rate > 0 || d.kind === 'card')
  const free = list.filter((d) => !ranked.includes(d))

  return (
    <div className="space-y-4">
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

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">
          {ranked.length ? 'Pay first — highest interest at the top' : 'Nothing here costs interest'}
        </h3>
        <ol className="overflow-hidden rounded-2xl border bg-card">
          {ranked.map((d, i) => (
            <DebtRow key={d.id} debt={d} rank={i + 1} />
          ))}
          {free.length > 0 && (
            <li className="border-t first:border-t-0">
              <button
                onClick={() => setShowFree(!showFree)}
                aria-expanded={showFree}
                className="flex w-full items-center gap-3 px-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    {free.length} plan{free.length === 1 ? '' : 's'} at 0%
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">No gain in paying early — keep to schedule</span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">{formatBaht(free.reduce((s, d) => s + d.outstanding, 0))}</span>
                <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', showFree && 'rotate-180')} />
              </button>
              {showFree && (
                <ul className="border-t bg-muted/30">
                  {free.map((d) => (
                    <DebtRow key={d.id} debt={d} />
                  ))}
                </ul>
              )}
            </li>
          )}
        </ol>
      </section>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">As plans end</h3>
        <ol className="space-y-3">
          <li className="grid grid-cols-[3rem_1fr] gap-2">
            <span className="text-center text-sm font-semibold">Now</span>
            <StepFigures due={dueNow} left={income > 0 ? net - dueNow : null} />
          </li>
          {steps.map((m) => {
            const [name, year] = monthLabel(m.after).split(' ')
            return (
              <li key={m.month} className="grid grid-cols-[3rem_1fr] gap-2">
                <div className="text-center leading-none">
                  <span className="block text-sm font-semibold">{name.slice(0, 3)}</span>
                  <span className="block text-[11px] text-muted-foreground">{year}</span>
                </div>
                <div>
                  <div className="flex items-baseline justify-between gap-2 border-l pl-3 text-sm">
                    <span className="min-w-0 truncate">{m.ending.join(', ')} paid off</span>
                    <span className="shrink-0 font-medium text-good tabular-nums">+{formatBaht(m.freed)}/mo</span>
                  </div>
                  <StepFigures due={m.dueAfter} left={income > 0 ? net - m.dueAfter : null} />
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}

function DebtRow({ debt: d, rank }: { debt: Debt; rank?: number }) {
  const high = d.rate >= 5
  return (
    <li className="flex items-center gap-3 border-t px-3 py-2 first:border-t-0">
      {rank != null && <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{rank}</span>}
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
}

function StepFigures({ due, left }: { due: number; left: number | null }) {
  return (
    <span className="block border-l pl-3 text-xs text-muted-foreground tabular-nums">
      {formatBaht(due)} debt / mo
      {left != null && <span className={cn('font-medium', left < 0 ? 'text-destructive' : 'text-foreground')}> · {formatBaht(left)} left</span>}
    </span>
  )
}
