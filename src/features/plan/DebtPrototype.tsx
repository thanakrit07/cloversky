// PROTOTYPE — throwaway. Question: "how should Debt's Pay first and As plans
// end read?" Variants on ?debt=A|B|C|D (the upper bar). A = current. All take
// the same model DebtSection already computes — nothing re-derived. Dev only.
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Debt, DebtMonth } from '@/lib/finance/debt'
import { formatBaht } from '@/lib/format'
import { monthLabel } from '@/lib/month'
import { cn } from '@/lib/utils'
import { DebtFigures } from './DebtSection'

const VARIANTS = { A: 'Current', B: 'Interest first + step-down chart', C: 'Payoff bars', D: 'One next step + freed money' } as const
type Key = keyof typeof VARIANTS
const KEYS = Object.keys(VARIANTS) as Key[]

type Milestone = DebtMonth & { after: string; dueAfter: number }

interface Props {
  current: ReactNode
  list: Debt[]
  months: DebtMonth[]
  income: number
  net: number
  dueNow: number
  milestones: Milestone[]
}

function readVariant(): Key {
  const v = new URLSearchParams(location.search).get('debt')
  return v && v in VARIANTS ? (v as Key) : 'A'
}

export function DebtPrototype(props: Props) {
  const [variant, setVariant] = useState<Key>(readVariant)
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('debt', variant)
    history.replaceState(history.state, '', url)
  }, [variant])
  const step = (d: number) => setVariant((v) => KEYS[(KEYS.indexOf(v) + d + KEYS.length) % KEYS.length])

  const btn = 'px-3 py-1.5 rounded-full hover:bg-white/15'
  return (
    <>
      {variant === 'A' && props.current}
      {variant === 'B' && <InterestFirst {...props} />}
      {variant === 'C' && <PayoffBars {...props} />}
      {variant === 'D' && <NextStep {...props} />}
      <div className="fixed bottom-60 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1 py-1 font-mono text-xs text-amber-300 shadow-lg ring-1 ring-amber-300/40 md:bottom-28">
        <button className={btn} onClick={() => step(-1)} aria-label="Previous debt layout">←</button>
        <span className="whitespace-nowrap px-1">debt {variant} — {VARIANTS[variant]}</span>
        <button className={btn} onClick={() => step(1)} aria-label="Next debt layout">→</button>
      </div>
    </>
  )
}

function Header(p: Props) {
  const total = p.list.reduce((s, d) => s + d.outstanding, 0)
  return (
    <>
      <h2 className="px-1 text-sm font-medium">Debt</h2>
      <DebtFigures total={total} lastMonth={p.months.at(-1)!.month} income={p.income} net={p.net} dueNow={p.dueNow} />
    </>
  )
}

function RateBadge({ rate }: { rate: number }) {
  if (rate <= 0) return <span className="text-xs text-muted-foreground">0%</span>
  return <Badge variant={rate >= 5 ? 'destructive' : 'secondary'}>{rate}%/yr</Badge>
}

function DebtRow({ d, rank }: { d: Debt; rank?: number }) {
  return (
    <li className="flex items-center gap-3 border-t px-3 py-2 first:border-t-0">
      {rank != null && <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{rank}</span>}
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm">
          {d.rate >= 5 && <AlertTriangle className="size-3.5 shrink-0 text-warning-foreground" />}
          <span className="truncate">{d.name}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground tabular-nums">
          {d.kind === 'card' ? 'Card bill past due' : `${formatBaht(d.monthly)}/mo · ends ${monthLabel(d.endsIn)}`}
        </span>
      </div>
      <div className="shrink-0 text-right">
        <span className="block text-sm tabular-nums">{formatBaht(d.outstanding)}</span>
        <RateBadge rate={d.rate} />
      </div>
    </li>
  )
}

// B — "pay first" only means something for debt that costs interest; 0%
// plans have no order, so they fold to one line. As plans end becomes a
// step-down column chart of debt due per month, a plan's end marked under
// its last month; tap a column for that month.
function InterestFirst(p: Props) {
  const costly = p.list.filter((d) => d.rate > 0)
  const free = p.list.filter((d) => d.rate <= 0)
  const [showFree, setShowFree] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const peak = Math.max(...p.months.map((m) => m.due), 1)
  const pickedMonth = p.months.find((m) => m.month === picked)
  const H = 80

  return (
    <div className="space-y-4">
      <Header {...p} />

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">
          {costly.length ? 'Costs interest — pay these first' : 'Nothing here costs interest'}
        </h3>
        <ul className="overflow-hidden rounded-2xl border bg-card">
          {costly.map((d, i) => (
            <DebtRow key={d.id} d={d} rank={i + 1} />
          ))}
          {free.length > 0 && (
            <li className={cn(costly.length > 0 && 'border-t')}>
              <button onClick={() => setShowFree(!showFree)} className="flex w-full items-center gap-3 px-3 py-2 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{free.length} plans at 0%</span>
                  <span className="block truncate text-xs text-muted-foreground">No gain in paying early — just keep to schedule</span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">{formatBaht(free.reduce((s, d) => s + d.outstanding, 0))}</span>
                <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', showFree && 'rotate-180')} />
              </button>
              {showFree && (
                <ul className="border-t bg-muted/30">
                  {free.map((d) => (
                    <DebtRow key={d.id} d={d} />
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">Debt due each month</h3>
        <div className="overflow-x-auto px-1">
          <div className="grid min-w-full grid-flow-col auto-cols-[minmax(2rem,1fr)] items-end gap-1">
            {p.months.map((m) => (
              <button
                key={m.month}
                type="button"
                onClick={() => setPicked(picked === m.month ? null : m.month)}
                aria-pressed={picked === m.month}
                title={`${monthLabel(m.month)}: ${formatBaht(m.due)}${m.ending.length ? ` · ${m.ending.join(', ')} ends` : ''}`}
                className={cn('flex flex-col items-center gap-1 rounded-lg px-0.5 pt-1 pb-1', picked === m.month ? 'bg-muted' : 'active:bg-muted/60')}
              >
                <div className="flex w-full flex-col justify-end" style={{ height: H }}>
                  {m.due > 0 && <div className="rounded-[4px] bg-primary" style={{ height: Math.max((m.due / peak) * H, 2) }} />}
                </div>
                <span className={cn('size-1.5 rounded-full', m.ending.length ? 'bg-foreground' : 'bg-transparent')} />
                <span className="text-[10px] text-muted-foreground">{monthLabel(m.month).slice(0, 3)}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="px-1 text-[11px] text-muted-foreground">● a plan's last month — the step after it is money freed</p>
        {pickedMonth && (
          <div className="rounded-2xl bg-muted/60 p-3 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{monthLabel(pickedMonth.month)}</span>
              <span className="tabular-nums">{formatBaht(pickedMonth.due)} debt</span>
            </div>
            {p.income > 0 && <p className="text-xs text-muted-foreground tabular-nums">{formatBaht(p.net - pickedMonth.due)} left that month</p>}
            {pickedMonth.ending.length > 0 && <p className="text-xs text-muted-foreground">Last payment: {pickedMonth.ending.join(', ')}</p>}
          </div>
        )}
      </section>
    </div>
  )
}

// C — Pay first and As plans end are one picture: a bar per debt, in
// pay-first order, running from now to its last month on a shared month
// axis. Where bars stop is when money frees up.
function PayoffBars(p: Props) {
  const first = p.months[0].month
  const n = p.months.length
  const idx = (m: string) => Math.max(0, p.months.findIndex((x) => x.month === m))
  const mid = p.months[Math.floor((n - 1) / 2)].month

  return (
    <div className="space-y-4">
      <Header {...p} />
      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">Pay first at the top · bar runs to the last payment</h3>
        <ol className="space-y-2.5 rounded-2xl border bg-card p-3">
          {p.list.map((d) => {
            const width = ((idx(d.endsIn) + 1) / n) * 100
            return (
              <li key={d.id} className="space-y-1">
                <div className="flex items-baseline gap-2 text-sm">
                  {d.rate >= 5 && <AlertTriangle className="size-3.5 shrink-0 self-center text-warning-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBaht(d.monthly)}/mo</span>
                  <RateBadge rate={d.rate} />
                </div>
                <div className="relative h-2 rounded-full bg-muted" title={`${d.name}: ends ${monthLabel(d.endsIn)}, ${formatBaht(d.outstanding)} left`}>
                  <div className={cn('absolute inset-y-0 left-0 rounded-full', d.rate > 0 ? 'bg-primary' : 'bg-primary/40')} style={{ width: `${width}%` }} />
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                  <span>{formatBaht(d.outstanding)} left</span>
                  <span>ends {monthLabel(d.endsIn)}</span>
                </div>
              </li>
            )
          })}
          <li className="flex justify-between border-t pt-1.5 text-[10px] text-muted-foreground">
            <span>{monthLabel(first)}</span>
            <span>{monthLabel(mid)}</span>
            <span>{monthLabel(p.months.at(-1)!.month)}</span>
          </li>
        </ol>
        <div className="flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-primary" /> Costs interest</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-primary/40" /> 0%</span>
        </div>
      </section>
    </div>
  )
}

// D — Pay first shrinks to the one thing to act on; the rest of that list
// already lives in Installment plans below. As plans end becomes a dated
// timeline that leads with the money each ending frees.
function NextStep(p: Props) {
  const top = p.list.find((d) => d.rate > 0)
  let prevDue = p.dueNow
  const steps = p.milestones.map((m) => {
    const freed = prevDue - m.dueAfter
    prevDue = m.dueAfter
    return { ...m, freed }
  })

  return (
    <div className="space-y-4">
      <Header {...p} />

      <div className={cn('flex items-start gap-3 rounded-2xl p-3', top ? 'bg-warning/30' : 'bg-muted/60')}>
        {top && <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />}
        <div className="min-w-0 flex-1 text-sm">
          {top ? (
            <>
              <span className="block font-medium">Pay {top.name} first</span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {top.rate}%/yr on {formatBaht(top.outstanding)} — the most expensive debt. Any extra money goes here.
              </span>
            </>
          ) : (
            <>
              <span className="block font-medium">Nothing to pay early</span>
              <span className="block text-xs text-muted-foreground">Every plan is 0% — keeping to schedule costs nothing extra.</span>
            </>
          )}
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium text-muted-foreground">As plans end</h3>
        <ol className="space-y-3">
          <li className="grid grid-cols-[3rem_1fr] gap-2">
            <span className="pt-0.5 text-center text-xs font-semibold">Now</span>
            <div className="flex items-baseline justify-between gap-2 border-l pl-3 text-sm tabular-nums">
              <span>{formatBaht(p.dueNow)} debt / mo</span>
              {p.income > 0 && <span className={cn('font-medium', p.net - p.dueNow < 0 && 'text-destructive')}>{formatBaht(p.net - p.dueNow)} left</span>}
            </div>
          </li>
          {steps.map((m) => {
            const [mon, year] = monthLabel(m.after).split(' ')
            return (
              <li key={m.month} className="grid grid-cols-[3rem_1fr] gap-2">
                <div className="text-center leading-none">
                  <span className="block text-sm font-semibold">{mon.slice(0, 3)}</span>
                  <span className="block text-[10px] text-muted-foreground">{year}</span>
                </div>
                <div className="border-l pl-3">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{m.ending.join(', ')} done</span>
                    <span className="shrink-0 font-medium text-good tabular-nums">+{formatBaht(m.freed)}/mo</span>
                  </div>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {formatBaht(m.dueAfter)} debt / mo{p.income > 0 && ` · ${formatBaht(p.net - m.dueAfter)} left`}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}
