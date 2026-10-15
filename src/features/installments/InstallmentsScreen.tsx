import { useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { periodCharge, periodDate } from '@/lib/finance/billingCycle'
import { useHousehold } from '@/lib/HouseholdContext'
import { formatBaht } from '@/lib/format'
import {
  useInstallmentPayments,
  useInstallments,
  usePostedPeriods,
  useSetPeriodPaid,
  type Installment,
} from '@/lib/installments'
import { InstallmentSheet } from './InstallmentSheet'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function InstallmentsScreen() {
  const { householdId } = useHousehold()
  const { data: installments } = useInstallments(householdId)
  const { data: payments } = useInstallmentPayments(householdId)
  const { data: posted } = usePostedPeriods(householdId)
  const setPaid = useSetPeriodPaid(householdId)
  const [editing, setEditing] = useState<Installment | 'new' | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Settled periods, keyed "<installmentId>:<periodNo>" — the paid counter is
  // derived from these events, never stored (D2).
  const paidKeys = useMemo(
    () => new Set((payments ?? []).map((p) => `${p.installment_id}:${p.period_no}`)),
    [payments],
  )
  const paidDateByKey = useMemo(
    () => new Map((payments ?? []).map((p) => [`${p.installment_id}:${p.period_no}`, p.paid_date])),
    [payments],
  )
  const paidCountByInstallment = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of payments ?? []) {
      map.set(p.installment_id, (map.get(p.installment_id) ?? 0) + 1)
    }
    return map
  }, [payments])

  const active = (installments ?? [])
    .filter((i) => i.status === 'active')
    .sort((a, b) => b.annual_interest_rate - a.annual_interest_rate)
  const finished = (installments ?? []).filter((i) => i.status !== 'active')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-sm font-medium text-muted-foreground">Installment plans</h2>
        <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      <ul className="space-y-2">
        {active.map((inst) => {
          const paid = paidCountByInstallment.get(inst.id) ?? 0
          const remaining = inst.total_periods - paid
          let outstanding = 0
          for (let n = paid + 1; n <= inst.total_periods; n++) outstanding += periodCharge(inst, n)
          const highInterest = inst.annual_interest_rate >= 5
          const isExpanded = expanded === inst.id
          return (
            <li key={inst.id} className="space-y-2 rounded-2xl border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <button onClick={() => setEditing(inst)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {inst.name}
                    {highInterest && <AlertTriangle className="size-3.5 shrink-0 text-warning-foreground" />}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {paid}/{inst.total_periods} paid · {formatBaht(outstanding)} left
                  </span>
                </button>
                {inst.annual_interest_rate > 0 && (
                  <Badge variant={highInterest ? 'destructive' : 'secondary'}>{inst.annual_interest_rate}%/yr</Badge>
                )}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${Math.min(100, (paid / inst.total_periods) * 100)}%` }}
                />
              </div>

              <button
                className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground"
                onClick={() => setExpanded(isExpanded ? null : inst.id)}
              >
                {isExpanded ? 'Hide periods' : `${remaining} period${remaining === 1 ? '' : 's'} left · tick off what's paid`}
                <ChevronDown className={`size-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              </button>

              {isExpanded && (
                <ul className="grid grid-cols-4 gap-1.5 rounded-xl bg-muted/40 p-2 sm:grid-cols-6">
                  {Array.from({ length: inst.total_periods }, (_, i) => i + 1).map((n) => {
                    const key = `${inst.id}:${n}`
                    const isPaid = paidKeys.has(key)
                    const date = periodDate(inst.start_date, n)
                    return (
                      <li key={n}>
                        <button
                          disabled={setPaid.isPending}
                          onClick={() =>
                            setPaid.mutate({
                              installmentId: inst.id,
                              periodNo: n,
                              transactionId: posted.transactionIdByKey.get(key) ?? null,
                              paidDate: date > today() ? today() : date,
                              paid: !isPaid,
                            })
                          }
                          aria-pressed={isPaid}
                          className={
                            'w-full rounded-lg border px-1.5 py-1 text-center text-[11px] transition-colors ' +
                            (isPaid
                              ? 'border-good/40 bg-good-background text-good-foreground'
                              : 'border-border text-muted-foreground active:bg-accent')
                          }
                        >
                          <span className="flex items-center justify-center gap-1 font-medium">
                            {isPaid && <Check className="size-3" />}#{n}
                          </span>
                          <span className="block">{isPaid ? (paidDateByKey.get(key) ?? date).slice(5) : date.slice(5)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
        {active.length === 0 && <p className="text-sm text-muted-foreground">No active installment plans.</p>}
      </ul>

      {finished.length > 0 && (
        <details className="rounded-2xl border bg-card p-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Finished ({finished.length})</summary>
          <ul className="mt-2 space-y-1">
            {finished.map((inst) => (
              <li key={inst.id} className="text-sm text-muted-foreground line-through">
                {inst.name}
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <InstallmentSheet
          key={editing === 'new' ? 'new' : editing.id}
          installment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
