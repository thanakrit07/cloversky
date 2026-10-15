import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useHousehold } from '@/lib/HouseholdContext'
import { formatBaht } from '@/lib/format'
import { fullDateLabel } from '@/lib/month'
import { useConfirmAllTransactions, useConfirmTransaction, useUnconfirmedTransactions, type Transaction } from '@/lib/transactions'

interface Props {
  onEdit: (transaction: Transaction) => void
}

// Generated recurring rows awaiting review (DESIGN §6.6/§7.3): confirm in
// one tap, or tap the row to adjust the amount first (saving confirms).
// Confirm all clears the strip in one go — a fixed-amount subscription has
// nothing to review. The list collapses to its header; the choice is
// remembered per device.
const OPEN_KEY = 'cloversky.reviewStrip.open'

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

export function ReviewStrip({ onEdit }: Props) {
  const { householdId } = useHousehold()
  const { data: pending } = useUnconfirmedTransactions(householdId)
  const confirm = useConfirmTransaction(householdId)
  const confirmAll = useConfirmAllTransactions(householdId)
  const [open, setOpen] = useState(readOpen)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, String(next))
    } catch {
      // Storage unavailable (private mode) — just don't remember it.
    }
  }

  if (!pending || pending.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} asChild>
      <section className="mb-4 space-y-1.5 rounded-2xl border border-warning-foreground/25 bg-warning p-3">
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger className="group -m-1 flex min-w-0 flex-1 items-center gap-1 rounded-md p-1 text-left hover:bg-warning-foreground/10">
            <ChevronDown className="size-4 shrink-0 text-warning-foreground transition-transform group-data-[state=closed]:-rotate-90" />
            <h3 className="font-heading text-xs font-medium text-warning-foreground">
              To review ({pending.length})
            </h3>
          </CollapsibleTrigger>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 border-warning-foreground/30 px-2 text-xs text-warning-foreground hover:bg-warning-foreground/10"
            onClick={() => confirmAll.mutate()}
            disabled={confirmAll.isPending}
          >
            Confirm all
          </Button>
        </div>
        <CollapsibleContent asChild>
          <ul className="space-y-1">
            {pending.map((t) => {
              const label = t.note || t.kind
              return (
                <li key={t.id} className="flex items-center gap-2">
                  <button onClick={() => onEdit(t)} className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-warning-foreground/10">
                    <span className="block truncate">{label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {fullDateLabel(t.date)} · {formatBaht(t.amount)}
                    </span>
                  </button>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-8 shrink-0 border-warning-foreground/30 text-warning-foreground hover:bg-warning-foreground/10"
                    onClick={() => confirm.mutate(t.id)}
                    disabled={confirm.isPending}
                    aria-label={`Confirm ${label}`}
                  >
                    <Check className="size-4" />
                  </Button>
                </li>
              )
            })}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
