// PROTOTYPE — throwaway. Question: "Upcoming is getting long — how should it
// hold this much?" Four layouts of the same page on ?upcoming=A|B|C|D
// (Shift+←/→ or the bar). A = current. Every variant reuses the real
// sections (CardForecastTab, ComingUpSection, DebtSection, RecurringTab,
// InstallmentsScreen) and keeps D-0004 (no sub-tabs) and §7.3 (Posted and
// Projected at once). Dev only; delete once a layout wins.
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FullScreenPage } from '@/components/FullScreenPage'
import { InstallmentsScreen } from '@/features/installments/InstallmentsScreen'
import { debts, payoffByMonth } from '@/lib/finance/debt'
import { periodCharge } from '@/lib/finance/billingCycle'
import { monthlyEquivalent } from '@/lib/finance/recurrence'
import { formatBaht } from '@/lib/format'
import { useHousehold } from '@/lib/HouseholdContext'
import { useInstallmentPayments, useInstallments } from '@/lib/installments'
import { monthLabel } from '@/lib/month'
import { useRecurringRules, type RecurringRule } from '@/lib/recurring'
import { CardForecastTab } from './CardForecastTab'
import { DebtSection } from './DebtSection'
import { ComingUpSection, HORIZON_DAYS, RecurringTab, useComingUpRows, type TimelineRow } from './PlanScreen'

const VARIANTS = { A: 'Current', B: 'Fold in place', C: 'Hub → pages', D: 'Merge debt + plans' } as const
type Key = keyof typeof VARIANTS
const KEYS = Object.keys(VARIANTS) as Key[]
const PEEK = 5

function readVariant(): Key {
  const v = new URLSearchParams(location.search).get('upcoming')
  return v && v in VARIANTS ? (v as Key) : 'A'
}

interface Props {
  current: ReactNode
  onEditRecurring: (rule: RecurringRule) => void
}

export function UpcomingDensityPrototype({ current, onEditRecurring }: Props) {
  const [variant, setVariant] = useState<Key>(readVariant)
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('upcoming', variant)
    history.replaceState(history.state, '', url)
  }, [variant])
  const step = (d: number) => setVariant((v) => KEYS[(KEYS.indexOf(v) + d + KEYS.length) % KEYS.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]') || !e.shiftKey) return
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const btn = 'px-3 py-1.5 rounded-full hover:bg-white/15'
  return (
    <>
      {variant === 'A' && current}
      {variant === 'B' && <Fold onEditRecurring={onEditRecurring} />}
      {variant === 'C' && <Hub onEditRecurring={onEditRecurring} />}
      {variant === 'D' && <Merge onEditRecurring={onEditRecurring} />}
      <div className="fixed bottom-48 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1 py-1 font-mono text-xs text-cyan-300 shadow-lg ring-1 ring-cyan-300/40 md:bottom-16">
        <button className={btn} onClick={() => step(-1)} aria-label="Previous layout">←</button>
        <span className="whitespace-nowrap px-1">upcoming {variant} — {VARIANTS[variant]}</span>
        <button className={btn} onClick={() => step(1)} aria-label="Next layout">→</button>
      </div>
    </>
  )
}

// One-line figures for a folded section or a hub row. Debt ignores carried
// card bills here (DebtSection itself still counts them).
function useSummaries() {
  const { householdId } = useHousehold()
  const { data: installments } = useInstallments(householdId)
  const { data: payments } = useInstallmentPayments(householdId)
  const { data: rules } = useRecurringRules(householdId)
  const today = new Date().toISOString().slice(0, 10)

  const plans = (installments ?? []).filter((i) => i.status === 'active')
  const owed = debts(plans, [], today).reduce((s, d) => s + d.outstanding, 0)
  const lastMonth = payoffByMonth(plans, [], today).at(-1)?.month
  const paid = new Map<string, number>()
  for (const p of payments ?? []) paid.set(p.installment_id, (paid.get(p.installment_id) ?? 0) + 1)
  let planLeft = 0
  for (const i of plans) for (let n = (paid.get(i.id) ?? 0) + 1; n <= i.total_periods; n++) planLeft += periodCharge(i, n)

  const active = (rules ?? []).filter((r) => r.active)
  const fixed = active.filter((r) => r.kind === 'expense' && !r.from_card_id).reduce((s, r) => s + monthlyEquivalent(r), 0)

  return {
    debt: owed > 0 ? `${formatBaht(owed)} owed · debt-free after ${lastMonth ? monthLabel(lastMonth) : '—'}` : 'No debt',
    recurring: `${active.length} active · ${formatBaht(fixed)}/mo fixed`,
    installments: `${plans.length} running · ${formatBaht(planLeft)} left`,
  }
}

function Headline({ rows }: { rows: TimelineRow[] }) {
  const posted = rows.reduce((s, r) => s + r.posted, 0)
  const projected = rows.reduce((s, r) => s + r.projected, 0)
  return (
    <div className="px-1 pt-2">
      <span className="text-[13px] text-muted-foreground">Due in the next {HORIZON_DAYS} days</span>
      <span className="mt-1 block text-[42px] font-semibold leading-none tracking-[-0.035em] tabular-nums">{formatBaht(posted + projected)}</span>
      <span className="mt-2.5 block text-[13px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{formatBaht(posted)}</span> posted
        <span className="mx-2 text-border">/</span>
        {formatBaht(projected)} projected
      </span>
    </div>
  )
}

// Coming up, cut to the first few rows with "show all" — the timeline is the
// part that grows with every rule and plan.
function ComingUpPeek({ rows, onEditRecurring }: { rows: TimelineRow[]; onEditRecurring: (rule: RecurringRule) => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, PEEK)
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-sm font-medium">Coming up</h2>
      <ComingUpSection rows={shown} onEditRecurring={onEditRecurring} />
      {rows.length > PEEK && (
        <button onClick={() => setAll(!all)} className="w-full py-1 text-center text-xs text-muted-foreground">
          {all ? 'Show less' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  )
}

function ForwardView({ rows, onEditRecurring, peek }: { rows: TimelineRow[]; onEditRecurring: (rule: RecurringRule) => void; peek?: boolean }) {
  return (
    <>
      <Headline rows={rows} />
      <section className="space-y-2">
        <h2 className="px-1 text-sm font-medium">Card bills by month</h2>
        <CardForecastTab />
      </section>
      {peek ? (
        <ComingUpPeek rows={rows} onEditRecurring={onEditRecurring} />
      ) : (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-medium">Coming up</h2>
          <ComingUpSection rows={rows} onEditRecurring={onEditRecurring} />
        </section>
      )}
    </>
  )
}

// B — the forward view stays open; everything below it folds to one line
// with its key figure, expanded in place. Nothing leaves the screen.
function Fold({ onEditRecurring }: { onEditRecurring: (rule: RecurringRule) => void }) {
  const rows = useComingUpRows()
  const s = useSummaries()
  const folds = [
    { key: 'debt', title: 'Debt', line: s.debt, body: <DebtSection /> },
    { key: 'recurring', title: 'Recurring', line: s.recurring, body: <RecurringTab /> },
    { key: 'installments', title: 'Installment plans', line: s.installments, body: <InstallmentsScreen /> },
  ]
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <ForwardView rows={rows} onEditRecurring={onEditRecurring} peek />
      <div className="divide-y rounded-2xl border bg-card">
        {folds.map((f) => (
          <Collapsible key={f.key} className="group" defaultOpen={f.key === 'debt'}>
            <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{f.title}</span>
                <span className="block truncate text-xs text-muted-foreground tabular-nums">{f.line}</span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-3 pb-4">{f.body}</CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </div>
  )
}

// C — Upcoming answers only "what's coming"; managing what generates it is
// one tap away on its own pushed page, like Settings.
function Hub({ onEditRecurring }: { onEditRecurring: (rule: RecurringRule) => void }) {
  const rows = useComingUpRows()
  const s = useSummaries()
  const [open, setOpen] = useState<'debt' | 'recurring' | 'installments' | null>(null)
  const pages = {
    debt: { title: 'Debt', line: s.debt, body: <DebtSection /> },
    recurring: { title: 'Recurring', line: s.recurring, body: <RecurringTab /> },
    installments: { title: 'Installment plans', line: s.installments, body: <InstallmentsScreen /> },
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <ForwardView rows={rows} onEditRecurring={onEditRecurring} />
      <section className="space-y-2">
        <h2 className="px-1 text-sm font-medium">Manage</h2>
        <ul className="divide-y rounded-2xl border bg-card">
          {(Object.keys(pages) as (keyof typeof pages)[]).map((k) => (
            <li key={k}>
              <button onClick={() => setOpen(k)} className="flex w-full items-center gap-3 px-3 py-3 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{pages[k].title}</span>
                  <span className="block truncate text-xs text-muted-foreground tabular-nums">{pages[k].line}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </section>
      {open && (
        <FullScreenPage title={pages[open].title} onClose={() => setOpen(null)}>
          <div className="mx-auto max-w-2xl p-4">{pages[open].body}</div>
        </FullScreenPage>
      )}
    </div>
  )
}

// D — Debt's "pay first" list and Installment plans list the same plans in
// the same order (highest interest first). Keep one: Debt's figures and
// milestones, then the installment cards as the list. Recurring folds.
// (Carried card bills drop out of the list here — prototype only.)
function Merge({ onEditRecurring }: { onEditRecurring: (rule: RecurringRule) => void }) {
  const rows = useComingUpRows()
  const s = useSummaries()
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <ForwardView rows={rows} onEditRecurring={onEditRecurring} peek />
      <section className="space-y-4">
        <DebtSection hideList />
        <InstallmentsScreen />
      </section>
      <Collapsible className="group rounded-2xl border bg-card">
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-3 text-left">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Recurring</span>
            <span className="block truncate text-xs text-muted-foreground tabular-nums">{s.recurring}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-4">
          <RecurringTab />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
