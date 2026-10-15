import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CategoryPickerPanel } from '@/components/CategoryPickerPanel'
import { SwipeDecideRow } from '@/components/SwipeDecideRow'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Switch } from '@/components/ui/switch'
import type { Category } from '@/lib/categories'
import { formatBaht } from '@/lib/format'
import { SHARED, type StatementRow } from '@/lib/statementImport'
import { cn } from '@/lib/utils'

interface Props {
  /** Every row of the review, with the category chosen on screen already applied. */
  rows: StatementRow[]
  accepted: Set<number>
  onAccept: (lines: number[], accept: boolean) => void
  onCategory: (line: number, categoryId: string) => void
  whoOf: (r: StatementRow) => string
  onWho: (line: number, who: string) => void
  members: { id: string; display_name: string }[]
  categories: Category[]
  instrumentName: (accountId: string | null, cardId: string | null) => string
  /** The row's counterparty, when the household hasn't said who it is yet. */
  unknownName: (r: StatementRow) => string | null
  onAsk: (name: string) => void
  /** Files read, lines not read, purchases that became installments, names to answer: the summary shows them first. */
  notices: ReactNode
  toApply: StatementRow[]
  applying: boolean
  onApply: () => void
  onStartOver: () => void
}

type View = 'summary' | 'new' | 'review' | 'imported'

const actionable = (r: StatementRow) => r.status !== 'error' && r.status !== 'imported'
const editable = (r: StatementRow) => actionable(r) && r.kind !== 'transfer' && r.status !== 'match'
const isReview = (r: StatementRow) => r.status === 'error' || r.status === 'match' || r.status === 'review'
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

// The phone's statement review (desktop keeps the table): a summary first, so a
// normal month is a couple of taps, then the New lines as a list grouped by day
// and the lines that need a decision one at a time.
export function StatementReviewMobile(props: Props) {
  const { rows, accepted, onAccept, toApply, applying, onApply } = props
  const [view, setView] = useState<View>('summary')
  // Captured when Review opens, so answering a line (which can move it to New) doesn't reshuffle the queue under the thumb.
  const [queue, setQueue] = useState<number[]>([])
  const [editing, setEditing] = useState<number | null>(null)

  const categoryById = new Map(props.categories.map((c) => [c.id, c]))
  const categoryText = (id: string | null) => {
    const c = id ? categoryById.get(id) : undefined
    if (!c) return 'No category'
    const main = c.parent_id ? categoryById.get(c.parent_id) : undefined
    return main ? `${main.name} › ${c.name}` : c.name
  }
  const whoText = (who: string) => (who === SHARED ? 'Shared' : props.members.find((m) => m.id === who)?.display_name ?? '')
  const instrumentText = (r: StatementRow) =>
    props.instrumentName(r.fromAccountId, r.fromCardId) + (r.kind === 'transfer' ? ` → ${props.instrumentName(r.toAccountId, r.toCardId)}` : '')
  const helpers = { categoryText, whoText, instrumentText }

  const expenses = toApply.filter((r) => r.kind === 'expense').reduce((sum, r) => sum + r.amount, 0)
  const editingRow = editing == null ? null : rows.find((r) => r.line === editing) ?? null

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        {view === 'summary' && (
          <Summary
            {...props}
            {...helpers}
            onOpen={(v) => {
              if (v === 'review') setQueue(rows.filter(isReview).map((r) => r.line))
              setView(v)
            }}
          />
        )}
        {(view === 'new' || view === 'imported') && (
          <>
            <SubHeader title={view === 'new' ? 'New lines' : 'Already imported'} onBack={() => setView('summary')} />
            <DayList rows={rows.filter((r) => r.status === view)} accepted={accepted} onAccept={onAccept} onEdit={setEditing} {...helpers} />
          </>
        )}
        {view === 'review' && (
          <>
            <SubHeader title="Needs you" onBack={() => setView('summary')} />
            <OneAtATime {...props} {...helpers} queue={queue} onDone={() => setView('summary')} />
          </>
        )}
      </div>

      <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t bg-card px-3 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+0.625rem)]">
        <div className="min-w-0 flex-1 text-xs leading-tight">
          <div className="text-sm font-medium tabular-nums">{toApply.length} to apply</div>
          <div className="text-muted-foreground">{toApply.length ? `${formatBaht(expenses)} in expenses` : 'Nothing accepted yet'}</div>
        </div>
        <Button size="lg" disabled={!toApply.length || applying} onClick={onApply}>
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      </div>

      <EditDrawer
        row={editingRow}
        isAccepted={editingRow ? accepted.has(editingRow.line) : false}
        onClose={() => setEditing(null)}
        {...props}
        {...helpers}
      />
    </div>
  )
}

interface Helpers {
  categoryText: (id: string | null) => string
  whoText: (who: string) => string
  instrumentText: (r: StatementRow) => string
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 border-b px-1 py-1">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ChevronLeft className="size-4" />
        Summary
      </Button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  )
}

function Amount({ r, className }: { r: StatementRow; className?: string }) {
  return (
    <span className={cn('whitespace-nowrap tabular-nums', r.kind === 'income' && 'text-emerald-600', r.kind === 'transfer' && 'text-muted-foreground', className)}>
      {r.kind === 'income' && '+'}
      {formatBaht(r.amount)}
    </span>
  )
}

function Summary({ rows, accepted, onAccept, notices, onStartOver, categories, onOpen }: Props & Helpers & { onOpen: (v: View) => void }) {
  const review = rows.filter(isReview)
  const fresh = rows.filter((r) => r.status === 'new')
  const imported = rows.filter((r) => r.status === 'imported')
  const reviewOpen = review.filter((r) => actionable(r) && !accepted.has(r.line)).length
  const freshAll = fresh.length > 0 && fresh.every((r) => accepted.has(r.line))

  // New expenses by Main category: what the household is about to add, before it adds it.
  const byId = new Map(categories.map((c) => [c.id, c]))
  const byMain = new Map<string, number>()
  for (const r of fresh) {
    if (r.kind !== 'expense') continue
    const c = r.categoryId ? byId.get(r.categoryId) : undefined
    const main = (c?.parent_id ? byId.get(c.parent_id) : c)?.name ?? 'No category'
    byMain.set(main, (byMain.get(main) ?? 0) + r.amount)
  }
  const mains = [...byMain].sort((a, b) => b[1] - a[1])
  const top = mains[0]?.[1] ?? 0
  const income = fresh.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amount, 0)
  const transfers = fresh.filter((r) => r.kind === 'transfer').reduce((s, r) => s + r.amount, 0)
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  return (
    <div>
      {notices}
      <div className="space-y-2 p-3">
        {review.length > 0 && (
          <section className="space-y-2 rounded-xl border bg-card p-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <span className="size-2 rounded-full bg-amber-500" />
              Needs you
              <span className="ml-auto font-normal text-muted-foreground tabular-nums">{review.length}</span>
            </h3>
            <p className="text-xs text-muted-foreground">
              {[
                review.filter((r) => r.status === 'review').length && count(review.filter((r) => r.status === 'review').length, 'category to check', 'categories to check'),
                review.filter((r) => r.status === 'match').length && count(review.filter((r) => r.status === 'match').length, 'match to confirm', 'matches to confirm'),
                review.filter((r) => r.status === 'error').length && `${count(review.filter((r) => r.status === 'error').length, 'line')} that can't be imported`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <Button className="w-full" variant={reviewOpen ? 'default' : 'outline'} onClick={() => onOpen('review')}>
              {reviewOpen ? `Review ${reviewOpen}` : 'See them again'}
            </Button>
          </section>
        )}

        {fresh.length > 0 && (
          <section className="space-y-3 rounded-xl border bg-card p-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <span className="size-2 rounded-full bg-primary" />
              New, ready to go
              <span className="ml-auto font-normal text-muted-foreground tabular-nums">{fresh.length}</span>
            </h3>
            <div className="space-y-1 text-xs">
              {mains.map(([name, total]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate">{name}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-primary/60" style={{ width: `${(total / top) * 100}%` }} />
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums">{formatBaht(total)}</span>
                </div>
              ))}
              {income > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Income</span>
                  <span className="text-emerald-600 tabular-nums">+{formatBaht(income)}</span>
                </div>
              )}
              {transfers > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Transfers</span>
                  <span className="tabular-nums">{formatBaht(transfers)}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" variant="outline" onClick={() => onOpen('new')}>
                See {fresh.length}
              </Button>
              <Button className="flex-1" variant={freshAll ? 'outline' : 'default'} onClick={() => onAccept(fresh.map((r) => r.line), !freshAll)}>
                {freshAll ? 'Unaccept all' : `Accept all ${fresh.length}`}
              </Button>
            </div>
          </section>
        )}

        {imported.length > 0 && (
          <button type="button" className="flex w-full items-center gap-2 rounded-xl border bg-card p-3 text-left text-sm" onClick={() => onOpen('imported')}>
            <span className="size-2 rounded-full bg-muted-foreground" />
            Already imported
            <span className="ml-auto text-muted-foreground tabular-nums">{imported.length}</span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        )}

        <div className="pt-2 text-center">
          <Button variant="ghost" size="sm" onClick={onStartOver}>
            Start over
          </Button>
        </div>
      </div>
    </div>
  )
}

function DayList({
  rows,
  accepted,
  onAccept,
  onEdit,
  categoryText,
  instrumentText,
}: { rows: StatementRow[]; accepted: Set<number>; onAccept: Props['onAccept']; onEdit: (line: number) => void } & Helpers) {
  if (!rows.length) return <p className="p-4 text-sm text-muted-foreground">Nothing here.</p>
  const days = [...new Set(rows.map((r) => r.date))].sort()
  return (
    <div>
      {rows.some(actionable) && <p className="px-4 pt-2 text-xs text-muted-foreground">Swipe right to accept, left to skip. Tap a line to change its category.</p>}
      {days.map((day) => {
        const inDay = rows.filter((r) => r.date === day)
        const open = inDay.filter((r) => actionable(r) && !accepted.has(r.line))
        return (
          <section key={day}>
            <div className="sticky top-0 z-1 flex items-center bg-background px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
              <span className="flex-1 uppercase tracking-wide">{dayLabel(day)}</span>
              {open.length > 1 && (
                <button type="button" className="text-primary" onClick={() => onAccept(open.map((r) => r.line), true)}>
                  Accept {open.length}
                </button>
              )}
            </div>
            {inDay.map((r) => (
              <SwipeDecideRow key={r.line} disabled={!actionable(r)} onAccept={() => onAccept([r.line], true)} onSkip={() => onAccept([r.line], false)} className="border-b">
                <div className={cn('flex items-center gap-3 px-4 py-2.5', accepted.has(r.line) && actionable(r) && 'bg-primary/5')}>
                  <button type="button" className="min-w-0 flex-1 text-left" disabled={!actionable(r)} onClick={() => onEdit(r.line)}>
                    <div className="truncate text-sm">{r.description}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {instrumentText(r)} · {r.kind === 'transfer' ? 'Transfer' : categoryText(r.categoryId)}
                    </div>
                  </button>
                  <Amount r={r} className="text-sm font-medium" />
                  {actionable(r) && (
                    <Switch checked={accepted.has(r.line)} onCheckedChange={(v) => onAccept([r.line], v)} aria-label={`Accept ${r.description}`} />
                  )}
                </div>
              </SwipeDecideRow>
            ))}
          </section>
        )
      })}
    </div>
  )
}

// Who bears the line: anyone in the household, or split evenly when it's an expense.
function WhoChips({ r, members, whoOf, onWho }: Pick<Props, 'members' | 'whoOf' | 'onWho'> & { r: StatementRow }) {
  if (r.kind === 'transfer') return null
  const options = [...members.map((m) => ({ id: m.id, name: m.display_name })), ...(r.kind === 'expense' && members.length > 1 ? [{ id: SHARED, name: 'Shared' }] : [])]
  if (options.length < 2) return null
  const current = whoOf(r)
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">Who pays</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Button key={o.id} size="sm" variant={current === o.id ? 'default' : 'outline'} className="rounded-full" onClick={() => onWho(r.line, o.id)}>
            {o.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

function EditDrawer({ row, isAccepted, onClose, onAccept, onCategory, categories, members, whoOf, onWho, unknownName, onAsk, categoryText, instrumentText }: Props & Helpers & { row: StatementRow | null; isAccepted: boolean; onClose: () => void }) {
  const name = row ? unknownName(row) : null
  return (
    <Drawer open={row != null} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent>
        {row && (
          <>
            <DrawerHeader>
              <DrawerTitle className="truncate">{row.description}</DrawerTitle>
              <DrawerDescription>
                {dayLabel(row.date)} · {instrumentText(row)} · <Amount r={row} />
              </DrawerDescription>
            </DrawerHeader>
            <div className="space-y-4 px-4">
              {name && (
                <Button variant="outline" className="w-full" onClick={() => { onClose(); onAsk(name) }}>
                  Who is {name}?
                </Button>
              )}
              {editable(row) && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Category · <span className="font-medium text-foreground">{categoryText(row.categoryId)}</span>
                  </p>
                  <CategoryPickerPanel
                    categories={categories}
                    kind={row.kind as 'income' | 'expense'}
                    selectedId={row.categoryId}
                    onSelect={(c) => onCategory(row.line, c.id)}
                  />
                </div>
              )}
              {editable(row) && <WhoChips r={row} members={members} whoOf={whoOf} onWho={onWho} />}
            </div>
            <DrawerFooter className="grid grid-cols-3 gap-2">
              <Button variant="outline" size="lg" onClick={() => { onAccept([row.line], false); onClose() }}>
                Skip
              </Button>
              <Button size="lg" className="col-span-2" disabled={editable(row) && !row.categoryId} onClick={() => { onAccept([row.line], true); onClose() }}>
                {isAccepted ? 'Accepted' : 'Accept'}
              </Button>
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  )
}

function OneAtATime({
  queue,
  onDone,
  rows,
  accepted,
  onAccept,
  onCategory,
  categories,
  members,
  whoOf,
  onWho,
  unknownName,
  onAsk,
  categoryText,
  instrumentText,
}: Props & Helpers & { queue: number[]; onDone: () => void }) {
  const [index, setIndex] = useState(0)
  const r = rows.find((x) => x.line === queue[index])

  if (!r) {
    const done = queue.filter((l) => accepted.has(l)).length
    return (
      <div className="space-y-3 p-8 text-center">
        <p className="text-base font-medium">Review done</p>
        <p className="text-sm text-muted-foreground">
          {done} accepted, {queue.length - done} left out. Nothing is saved until you press Apply.
        </p>
        <div className="flex justify-center gap-2">
          {queue.length > 0 && (
            <Button variant="outline" onClick={() => setIndex(0)}>
              Go through again
            </Button>
          )}
          <Button onClick={onDone}>Back to summary</Button>
        </div>
      </div>
    )
  }

  const name = unknownName(r)
  const next = (accept: boolean | null) => {
    if (accept != null && actionable(r)) onAccept([r.line], accept)
    setIndex((i) => i + 1)
  }

  return (
    <div className="space-y-3 pb-3">
      <div className="space-y-1.5 px-4 pt-3">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {index + 1} of {queue.length}
          </span>
          {index > 0 && (
            <button type="button" className="text-primary" onClick={() => setIndex((i) => i - 1)}>
              Previous
            </button>
          )}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${(index / queue.length) * 100}%` }} />
        </div>
      </div>

      <div className="mx-3 space-y-4 rounded-2xl border bg-card p-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {dayLabel(r.date)} · {instrumentText(r)}
          </p>
          <p className="font-medium break-words">{r.description}</p>
        </div>
        <Amount r={r} className="block text-3xl font-semibold" />

        {r.status === 'error' && (
          <p className="text-sm text-destructive">
            {r.issue}. This line is left out; nothing else is affected.
          </p>
        )}
        {r.status === 'match' && (
          <p className="text-sm text-muted-foreground">
            You already entered this one by hand. Confirming links the two; nothing is added twice. It stays as {categoryText(r.categoryId)}.
          </p>
        )}
        {name && (
          <Button variant="outline" className="w-full" onClick={() => onAsk(name)}>
            Who is {name}?
          </Button>
        )}
        {editable(r) && (
          <>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                Category · <span className="font-medium text-foreground">{categoryText(r.categoryId)}</span>
              </p>
              <CategoryPickerPanel categories={categories} kind={r.kind as 'income' | 'expense'} selectedId={r.categoryId} onSelect={(c) => onCategory(r.line, c.id)} />
            </div>
            <WhoChips r={r} members={members} whoOf={whoOf} onWho={onWho} />
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 px-3">
        <Button variant="outline" size="lg" onClick={() => next(actionable(r) ? false : null)}>
          {actionable(r) ? 'Skip' : 'Next'}
        </Button>
        {actionable(r) && (
          <Button size="lg" className="col-span-2" disabled={editable(r) && !r.categoryId} onClick={() => next(true)}>
            {r.status === 'match' ? 'Confirm match' : 'Accept'}
          </Button>
        )}
      </div>
    </div>
  )
}
