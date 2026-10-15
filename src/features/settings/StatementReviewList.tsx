import { useState } from 'react'
import { ArrowRightLeft, Check } from 'lucide-react'
import { CategoryPickerPanel } from '@/components/CategoryPickerPanel'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import type { Category } from '@/lib/categories'
import { CategoryIcon } from '@/lib/categoryIcons'
import { formatBaht } from '@/lib/format'
import type { HouseholdMember } from '@/lib/household'
import { dayOfMonthLabel, fullDateLabel, weekdayLabel } from '@/lib/month'
import { SHARED, type StatementRow } from '@/lib/statementImport'
import { cn } from '@/lib/utils'

interface Props {
  rows: StatementRow[]
  accepted: Set<number>
  onAccept: (lines: number[], accept: boolean) => void
  actionable: (r: StatementRow) => boolean
  // Category and Responsible can be changed: not a transfer, not a match to a row already entered.
  editable: (r: StatementRow) => boolean
  instrumentName: (r: StatementRow) => string
  categories: Category[]
  categoryById: Map<string, Category>
  members: HouseholdMember[]
  whoOf: (r: StatementRow) => string
  onWho: (line: number, who: string) => void
  onCategory: (line: number, categoryId: string) => void
  // The counterparty when the household hasn't said who it is yet.
  unknownName: (r: StatementRow) => string | null
  onAsk: (name: string) => void
  onPlan: (r: StatementRow) => void
}

const STATUS_CHIP: Partial<Record<StatementRow['status'], { label: string; className: string }>> = {
  error: { label: "Can't import", className: 'bg-destructive/10 text-destructive' },
  match: { label: 'Already entered?', className: 'bg-warning text-warning-foreground' },
  review: { label: 'Check category', className: 'bg-warning text-warning-foreground' },
  imported: { label: 'Imported', className: 'bg-muted text-muted-foreground' },
}

// The review on a phone: Records' day timeline, one tick per row meaning
// "import this", and everything else about a row in a drawer — a nine-column
// table only works where there is width to scan it.
export function StatementReviewList(props: Props) {
  const { rows, accepted, onAccept, actionable, editable, instrumentName, categoryById, members, whoOf } = props
  const [openLine, setOpenLine] = useState<number | null>(null)
  const open = rows.find((r) => r.line === openLine) ?? null

  const groups = new Map<string, StatementRow[]>()
  for (const r of rows) groups.set(r.date, [...(groups.get(r.date) ?? []), r])
  const whoName = (id: string) => (id === SHARED ? 'Shared' : (members.find((m) => m.id === id)?.display_name ?? ''))

  return (
    <div>
      {[...groups].map(([date, items]) => (
        <section key={date} className="grid grid-cols-[3rem_1fr] border-t first:border-t-0">
          <header className="pr-2 pt-2.5 text-center">
            {date ? (
              <>
                <p className="text-xl font-semibold leading-none tracking-[-0.02em] tabular-nums">{dayOfMonthLabel(date)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{weekdayLabel(date)}</p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">No date</p>
            )}
          </header>
          <ul className="min-w-0 border-l py-1 [&>li:first-child]:border-t-0 [&>li]:border-border/60">
            {items.map((r) => {
              const category = r.categoryId ? categoryById.get(r.categoryId) : undefined
              const chip = r.needsPlan ? { label: 'Needs a plan', className: 'bg-warning text-warning-foreground' } : STATUS_CHIP[r.status]
              const details = [
                instrumentName(r),
                r.kind !== 'transfer' && category?.name,
                editable(r) && whoName(whoOf(r)),
              ].filter(Boolean)
              return (
                <li key={r.line} className={cn('flex items-center border-t', accepted.has(r.line) && actionable(r) && 'bg-primary/5')}>
                  {actionable(r) ? (
                    <label className="flex size-11 shrink-0 items-center justify-center">
                      <Checkbox
                        checked={accepted.has(r.line)}
                        onCheckedChange={(v) => onAccept([r.line], v === true)}
                        aria-label={`Import ${r.description}`}
                      />
                    </label>
                  ) : (
                    <span className="size-11 shrink-0" />
                  )}
                  <button
                    type="button"
                    onClick={() => setOpenLine(r.line)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-3 text-left transition-colors active:bg-accent/60"
                  >
                    {r.kind === 'transfer' ? (
                      <ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <CategoryIcon icon={category?.icon ?? null} color={category?.color} className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('truncate text-sm', !actionable(r) && 'text-muted-foreground')}>{r.description}</span>
                        {chip && <span className={cn('shrink-0 rounded-full px-1.5 text-[10px]', chip.className)}>{chip.label}</span>}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">{details.join(' · ')}</span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 text-sm tabular-nums',
                        r.kind === 'income' ? 'text-good' : r.kind === 'transfer' ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {r.kind === 'income' ? '+' : r.kind === 'expense' ? '-' : ''}
                      {formatBaht(r.amount)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      <Drawer open={open != null} onOpenChange={(o) => !o && setOpenLine(null)}>
        <DrawerContent>{open && <RowDetail {...props} r={open} onDone={() => setOpenLine(null)} />}</DrawerContent>
      </Drawer>
    </div>
  )
}

function RowDetail({
  r,
  onDone,
  accepted,
  onAccept,
  actionable,
  editable,
  instrumentName,
  categories,
  members,
  whoOf,
  onWho,
  onCategory,
  unknownName,
  onAsk,
  onPlan,
}: Props & { r: StatementRow; onDone: () => void }) {
  const isAccepted = accepted.has(r.line)
  const asked = unknownName(r)
  const who = whoOf(r)
  const whoChoices = [
    ...members.map((m) => ({ id: m.id, label: m.display_name, color: m.color })),
    ...(r.kind === 'expense' && members.length > 1 ? [{ id: SHARED, label: 'Shared', color: null }] : []),
  ]

  return (
    <>
      <DrawerHeader className="pb-0">
        <DrawerTitle className="break-words">{r.description}</DrawerTitle>
        <DrawerDescription>
          {[r.date && fullDateLabel(r.date), instrumentName(r)].filter(Boolean).join(' · ')}
        </DrawerDescription>
        <p className={cn('pt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums', r.kind === 'income' && 'text-good')}>
          {r.kind === 'income' ? '+' : r.kind === 'expense' ? '-' : ''}
          {formatBaht(r.amount)}
        </p>
      </DrawerHeader>

      <div className="space-y-4 px-4">
        {r.status === 'error' && <p className="rounded-lg bg-destructive/10 p-2.5 text-destructive">{r.issue}</p>}
        {r.status === 'imported' && <p className="text-muted-foreground">This line is already in your records.</p>}
        {r.status === 'match' && (
          <p className="text-muted-foreground">
            You already entered a row like this by hand. Accept it to mark that row as confirmed by the statement, rather than adding it twice.
          </p>
        )}
        {r.needsPlan && r.installment && (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              Period {r.installment.k} of {r.installment.total} of an installment the app has no plan for. Make the plan and it posts every period itself.
            </p>
            <Button variant="outline" onClick={() => { onDone(); onPlan(r) }}>
              Create plan
            </Button>
          </div>
        )}
        {asked && (
          <Button variant="outline" onClick={() => { onDone(); onAsk(asked) }}>
            Who is {asked}?
          </Button>
        )}

        {editable(r) && (
          <>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Responsible</p>
              <div className="flex flex-wrap gap-2">
                {whoChoices.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onWho(r.line, c.id)}
                    className={cn(
                      'flex h-9 items-center gap-1.5 rounded-full border px-3 transition-colors',
                      who === c.id ? 'border-primary bg-primary/10' : 'border-border active:bg-accent',
                    )}
                  >
                    {c.color && <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />}
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Category</p>
              <CategoryPickerPanel
                categories={categories}
                kind={r.kind as 'income' | 'expense'}
                selectedId={r.categoryId}
                onSelect={(c) => onCategory(r.line, c.id)}
              />
            </div>
          </>
        )}
      </div>

      <DrawerFooter>
        {actionable(r) ? (
          <Button
            variant={isAccepted ? 'outline' : 'default'}
            onClick={() => {
              onAccept([r.line], !isAccepted)
              onDone()
            }}
          >
            {isAccepted ? (
              'Don’t import this line'
            ) : (
              <>
                <Check className="size-4" />
                {r.status === 'match' ? 'Confirm' : 'Import this line'}
              </>
            )}
          </Button>
        ) : (
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
        )}
      </DrawerFooter>
    </>
  )
}
