import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRightLeft, Check, CircleHelp, CopyCheck, FileWarning, Layers, ListChecks, Sparkles, Tags } from 'lucide-react'
import { CategoryOptions } from '@/components/CategoryOptions'
import { CategoryPickerPanel } from '@/components/CategoryPickerPanel'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { Category } from '@/lib/categories'
import { CategoryIcon } from '@/lib/categoryIcons'
import { formatBaht } from '@/lib/format'
import type { HouseholdMember } from '@/lib/household'
import { fullDateLabel } from '@/lib/month'
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
  showFile: boolean
  categories: Category[]
  categoryById: Map<string, Category>
  members: HouseholdMember[]
  whoOf: (r: StatementRow) => string
  onWho: (lines: number[], who: string) => void
  onCategory: (lines: number[], categoryId: string) => void
  // The counterparty when the household hasn't said who it is yet.
  unknownName: (r: StatementRow) => string | null
  onAsk: (name: string) => void
  onPlan: (r: StatementRow) => void
  // What has to be sorted out outside the lines themselves: unreadable lines,
  // purchases that became installments, names the app doesn't know.
  notices: ReactNode
  noticeCount: number
  // The "Who is this?" form, while one is being answered.
  askForm: ReactNode
  fileCount: number
  toApply: StatementRow[]
  applying: boolean
  onApply: () => void
  onStartOver: () => void
}

// What a line is waiting on, one answer per line: the rail counts these and
// the list filters by them. Order matters — an installment period with no
// plan is also an error row, and "needs a plan" is the useful thing to say.
type Group = 'all' | 'notices' | 'plan' | 'who' | 'match' | 'review' | 'error' | 'new' | 'imported'
const GROUPS: { key: Group; label: string; hint: string; icon: typeof Layers; section: string }[] = [
  { key: 'all', label: 'All lines', hint: 'Every line in this review.', icon: ListChecks, section: '' },
  { key: 'notices', label: 'Before you apply', hint: 'Lines the reader couldn’t place, purchases that became installments, and names the app doesn’t know.', icon: FileWarning, section: 'Sort out' },
  { key: 'plan', label: 'Needs a plan', hint: 'Installment periods with no plan in the app. Make the plan and it posts each period itself; these lines are never imported.', icon: Layers, section: 'Sort out' },
  { key: 'who', label: 'Who is this?', hint: 'Transfers to a name the household hasn’t identified. Answer once and every future statement knows.', icon: CircleHelp, section: 'Sort out' },
  { key: 'match', label: 'Already entered?', hint: 'You entered a row like this by hand. Tick to confirm it rather than adding it twice.', icon: CopyCheck, section: 'Sort out' },
  { key: 'review', label: 'Check category', hint: 'The statement didn’t say a category. Set the right one, then tick.', icon: Tags, section: 'Sort out' },
  { key: 'error', label: "Can't import", hint: 'Lines the app can’t turn into a transaction. They stay out.', icon: AlertTriangle, section: 'Sort out' },
  { key: 'new', label: 'New', hint: 'Nothing to check. Tick what you want and apply.', icon: Sparkles, section: 'Ready' },
  { key: 'imported', label: 'Already imported', hint: 'These lines are in your records already.', icon: ListChecks, section: 'Done' },
]
const SECTIONS = ['', 'Sort out', 'Ready', 'Done']

function groupOf(r: StatementRow, unknownName: Props['unknownName']): Exclude<Group, 'all' | 'notices'> {
  if (r.needsPlan) return 'plan'
  if (r.status === 'error') return 'error'
  if (unknownName(r)) return 'who'
  if (r.status === 'match') return 'match'
  if (r.status === 'review') return 'review'
  if (r.status === 'imported') return 'imported'
  return 'new'
}
const CHIP: Partial<Record<Group, string>> = {
  plan: 'bg-warning text-warning-foreground',
  who: 'bg-warning text-warning-foreground',
  match: 'bg-warning text-warning-foreground',
  review: 'bg-warning text-warning-foreground',
  error: 'bg-destructive/10 text-destructive',
}

const signed = (r: StatementRow) => (r.kind === 'income' ? '+' : r.kind === 'expense' ? '-' : '') + formatBaht(r.amount)
const amountTone = (r: StatementRow) => (r.kind === 'income' ? 'text-good' : r.kind === 'transfer' ? 'text-muted-foreground' : '')
function totals(rows: StatementRow[]) {
  let out = 0
  let inn = 0
  for (const r of rows) {
    if (r.kind === 'expense') out += r.amount
    if (r.kind === 'income') inn += r.amount
  }
  return { out, inn }
}

// The review where there is width: what's left to sort out down the left,
// the lines in the middle, and the line (or lines) in hand on the right at
// full size — the phone's drawer, pinned open. Built for going through a long
// statement fast: ↑/↓ moves, Space ticks, and several lines selected the way a
// mail client does (⇧ for a range, ⌘ for one more) are edited together.
export function StatementReviewDesktop(props: Props) {
  const { rows: all, accepted, onAccept, actionable, unknownName } = props
  const [group, setGroup] = useState<Group>('all')
  const rows = group === 'all' ? all : all.filter((r) => groupOf(r, unknownName) === group)
  const [cursor, setCursor] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const current = rows.find((r) => r.line === cursor) ?? rows[0] ?? null
  const selected = rows.filter((r) => selection.has(r.line))
  const root = useRef<HTMLDivElement>(null)

  const count = (g: Group) => (g === 'notices' ? props.noticeCount : g === 'all' ? all.length : all.filter((r) => groupOf(r, unknownName) === g).length)
  const meta = GROUPS.find((g) => g.key === group)!

  const range = (from: number | null, to: number) => {
    const a = Math.max(0, rows.findIndex((r) => r.line === (from ?? current?.line)))
    const b = rows.findIndex((r) => r.line === to)
    return new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.line))
  }
  function pick(r: StatementRow, how: { shift?: boolean; add?: boolean } = {}) {
    if (how.shift) {
      setSelection(range(anchor, r.line))
    } else if (how.add) {
      const next = new Set(selection.size ? selection : current ? [current.line] : [])
      if (next.has(r.line)) next.delete(r.line)
      else next.add(r.line)
      setSelection(next)
      setAnchor(r.line)
    } else {
      setSelection(new Set())
      setAnchor(r.line)
    }
    setCursor(r.line)
  }
  function choose(g: Group) {
    setGroup(g)
    setSelection(new Set())
    setCursor(null)
    setAnchor(null)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      // Only while this screen has the keyboard: not in a field, not in a sheet opened over it.
      if (!root.current || !(t.contains(root.current) || root.current.contains(t))) return
      if (t.closest('input, textarea, select, [contenteditable], [role=checkbox]')) return
      const i = current ? rows.indexOf(current) : -1
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (step && rows[i + step]) {
        e.preventDefault()
        const to = rows[i + step]
        if (e.shiftKey) {
          setSelection(range(anchor ?? current?.line ?? null, to.line))
          setCursor(to.line)
        } else pick(to)
      } else if (e.key === ' ') {
        e.preventDefault()
        const lines = (selected.length > 1 ? selected : current ? [current] : []).filter(actionable).map((r) => r.line)
        onAccept(lines, lines.some((l) => !accepted.has(l)))
      } else if (e.key === 'Escape' && selection.size) {
        // Listening in the capture phase, so this clears the selection before Escape closes the page.
        e.preventDefault()
        e.stopPropagation()
        setSelection(new Set())
      } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSelection(new Set(rows.map((r) => r.line)))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  useEffect(() => {
    if (current) document.getElementById(`statement-line-${current.line}`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const tickable = rows.filter(actionable).map((r) => r.line)
  const ticked = tickable.filter((l) => accepted.has(l))
  const sortOutLeft = GROUPS.filter((g) => g.section === 'Sort out' && g.key !== 'error').reduce((n, g) => n + count(g.key), 0)
  const days = new Map<string, StatementRow[]>()
  for (const r of rows) days.set(r.date, [...(days.get(r.date) ?? []), r])

  return (
    <div ref={root} className="grid h-full min-h-0 grid-cols-[15rem_minmax(0,1fr)_25rem]">
      <aside className="flex min-h-0 flex-col border-r bg-muted/30">
        <div className="px-4 pt-5 pb-3">
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{all.length} lines</p>
          <p className="text-xs text-muted-foreground">
            from {props.fileCount > 1 ? `${props.fileCount} files` : '1 file'} · {sortOutLeft ? `${sortOutLeft} to sort out` : 'nothing left to sort out'}
          </p>
        </div>
        <nav aria-label="Lines by what they need" className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {SECTIONS.map((section) => (
            <div key={section} className="mt-3 first:mt-0">
              {section && <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{section}</p>}
              {GROUPS.filter((g) => g.section === section).map((g) => {
                const n = count(g.key)
                // A problem with nothing in it isn't worth a row; Ready and Done always show.
                if (!n && section === 'Sort out') return null
                return (
                  <button
                    key={g.key}
                    type="button"
                    aria-current={group === g.key}
                    onClick={() => choose(g.key)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      group === g.key ? 'bg-background font-medium shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                    )}
                  >
                    <g.icon className="size-4 shrink-0" />
                    <span className="flex-1">{g.label}</span>
                    <span className={cn('text-xs tabular-nums', section === 'Sort out' && g.key !== 'error' && 'rounded bg-warning px-1.5 text-warning-foreground')}>{n}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <ApplyBar {...props} />
      </aside>

      <section className="flex min-h-0 flex-col border-r">
        <header className="flex items-center gap-3 border-b px-4 py-2.5">
          {group !== 'notices' && (
            <Checkbox
              checked={tickable.length > 0 && ticked.length === tickable.length ? true : ticked.length ? 'indeterminate' : false}
              disabled={!tickable.length}
              onCheckedChange={(v) => onAccept(tickable, v === true)}
              aria-label="Tick all"
            />
          )}
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <meta.icon className="size-4 text-muted-foreground" /> {meta.label}
            {group !== 'notices' && <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>}
          </h2>
          <span className="ml-auto text-[11px] text-muted-foreground">↑↓ move · ⇧ select several · Space tick · Esc clear</span>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {group === 'notices' ? (
            props.notices
          ) : (
            <>
              {!rows.length && <p className="p-6 text-sm text-muted-foreground">Nothing here.</p>}
              {[...days].map(([date, items]) => (
                <div key={date}>
                  <p className="sticky top-0 z-10 border-b bg-background/95 px-4 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
                    {date ? fullDateLabel(date) : 'No date'}
                  </p>
                  <ul>
                    {items.map((r) => (
                      <Line
                        key={r.line}
                        r={r}
                        props={props}
                        chip={group === 'all' || group === 'new'}
                        isSelected={selection.has(r.line)}
                        isCurrent={current?.line === r.line}
                        anySelected={selection.size > 0}
                        onPick={(how) => pick(r, how)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <aside className="min-h-0 overflow-auto bg-muted/30">
        {props.askForm ? (
          props.askForm
        ) : group === 'notices' ? (
          <p className="p-5 text-sm text-pretty text-muted-foreground">{meta.hint}</p>
        ) : selected.length > 1 ? (
          <SeveralLines rows={selected} props={props} onClear={() => setSelection(new Set())} />
        ) : current ? (
          <OneLine r={current} props={props} />
        ) : (
          <p className="p-5 text-sm text-muted-foreground">Nothing here.</p>
        )}
      </aside>
    </div>
  )
}

function Line({
  r,
  props,
  chip,
  isSelected,
  isCurrent,
  anySelected,
  onPick,
}: {
  r: StatementRow
  props: Props
  chip: boolean
  isSelected: boolean
  isCurrent: boolean
  anySelected: boolean
  onPick: (how: { shift?: boolean; add?: boolean }) => void
}) {
  const { accepted, onAccept, actionable, editable, categoryById, members, whoOf, instrumentName, unknownName } = props
  const category = r.categoryId ? categoryById.get(r.categoryId) : undefined
  const group = groupOf(r, unknownName)
  const details = [
    instrumentName(r),
    r.kind !== 'transfer' && category?.name,
    editable(r) && whoLabel(members, whoOf(r)),
  ].filter(Boolean)
  return (
    <li
      id={`statement-line-${r.line}`}
      className={cn(
        'flex items-center border-b border-border/50 transition-colors select-none',
        isSelected ? 'bg-primary/10' : isCurrent && !anySelected ? 'bg-accent' : 'hover:bg-accent/40',
        isCurrent && 'shadow-[inset_2px_0_0_var(--foreground)]',
      )}
    >
      <label className="flex size-10 shrink-0 items-center justify-center">
        {actionable(r) && (
          <Checkbox checked={accepted.has(r.line)} onCheckedChange={(v) => onAccept([r.line], v === true)} aria-label={`Import ${r.description}`} />
        )}
      </label>
      <button
        type="button"
        onClick={(e) => onPick({ shift: e.shiftKey, add: e.metaKey || e.ctrlKey })}
        className="flex min-w-0 flex-1 items-center gap-3 py-2 pr-4 text-left"
      >
        {r.kind === 'transfer' ? (
          <ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <CategoryIcon icon={category?.icon ?? null} color={category?.color} className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm', !actionable(r) && 'text-muted-foreground')}>{r.description}</span>
            {chip && CHIP[group] && (
              <span className={cn('shrink-0 rounded px-1.5 py-px text-[10px] font-medium', CHIP[group])}>{GROUPS.find((g) => g.key === group)!.label}</span>
            )}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">{details.join(' · ')}</span>
        </span>
        <span className={cn('shrink-0 text-sm tabular-nums', amountTone(r))}>{signed(r)}</span>
      </button>
    </li>
  )
}

const whoLabel = (members: HouseholdMember[], id: string) => (id === SHARED ? 'Shared' : (members.find((m) => m.id === id)?.display_name ?? ''))

function WhoChips({ members, withShared, value, onPick }: { members: HouseholdMember[]; withShared: boolean; value: string | null; onPick: (id: string) => void }) {
  const choices = [
    ...members.map((m) => ({ id: m.id, label: m.display_name, color: m.color })),
    ...(withShared && members.length > 1 ? [{ id: SHARED, label: 'Shared', color: null }] : []),
  ]
  return (
    <div className="flex flex-wrap gap-1.5">
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={value === c.id}
          onClick={() => onPick(c.id)}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors',
            value === c.id ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-accent',
          )}
        >
          {c.color && <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />}
          {c.label}
        </button>
      ))}
    </div>
  )
}

function OneLine({ r, props }: { r: StatementRow; props: Props }) {
  const { accepted, onAccept, actionable, editable, instrumentName, categories, members, whoOf, onWho, onCategory, unknownName, onAsk, onPlan, showFile } = props
  const isAccepted = accepted.has(r.line)
  const asked = unknownName(r)
  return (
    <div className="space-y-5 p-5 text-sm">
      <div>
        <p className="text-xs text-muted-foreground">
          {[r.date && fullDateLabel(r.date), instrumentName(r), showFile && r.file].filter(Boolean).join(' · ')}
        </p>
        <h2 className="mt-1 text-lg leading-snug font-semibold text-pretty break-words">{r.description}</h2>
        <p className={cn('mt-2 text-3xl font-semibold tracking-[-0.02em] tabular-nums', amountTone(r))}>{signed(r)}</p>
      </div>

      {r.needsPlan && r.installment ? (
        <div className="space-y-2 rounded-md bg-warning p-3 text-warning-foreground">
          <p>
            Period {r.installment.k} of {r.installment.total} of an installment the app has no plan for. Make the plan and it posts every period itself.
          </p>
          <Button size="sm" variant="outline" className="bg-background" onClick={() => onPlan(r)}>
            Create plan
          </Button>
        </div>
      ) : r.status === 'error' ? (
        <p className="rounded-md bg-destructive/10 p-3 text-destructive">{r.issue}</p>
      ) : null}
      {r.status === 'imported' && <p className="text-muted-foreground">This line is already in your records.</p>}
      {r.status === 'match' && (
        <p className="rounded-md bg-warning p-3 text-warning-foreground">
          You already entered a row like this by hand. Tick it to mark that row as confirmed by the statement, rather than adding it twice.
        </p>
      )}
      {asked && (
        <Button size="sm" variant="outline" onClick={() => onAsk(asked)}>
          <CircleHelp /> Who is {asked}?
        </Button>
      )}

      {editable(r) && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Responsible</p>
            <WhoChips members={members} withShared={r.kind === 'expense'} value={whoOf(r)} onPick={(id) => onWho([r.line], id)} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Category</p>
            <CategoryPickerPanel categories={categories} kind={r.kind as 'income' | 'expense'} selectedId={r.categoryId} onSelect={(c) => onCategory([r.line], c.id)} />
          </div>
        </>
      )}

      {actionable(r) && (
        <Button className="w-full" variant={isAccepted ? 'outline' : 'default'} onClick={() => onAccept([r.line], !isAccepted)}>
          {isAccepted ? (
            'Don’t import this line'
          ) : (
            <>
              <Check />
              {r.status === 'match' ? 'Confirm' : 'Import this line'}
            </>
          )}
        </Button>
      )}
    </div>
  )
}

// One change to many lines. Only lines that take a category or a person are
// changed; the rest are counted, so it's clear why they didn't move.
function SeveralLines({ rows, props, onClear }: { rows: StatementRow[]; props: Props; onClear: () => void }) {
  const { accepted, onAccept, actionable, editable, categories, members, whoOf, onWho, onCategory } = props
  const changeable = rows.filter(editable)
  const lines = changeable.map((r) => r.line)
  const tickable = rows.filter(actionable).map((r) => r.line)
  const allTicked = tickable.length > 0 && tickable.every((l) => accepted.has(l))
  const kinds = new Set(changeable.map((r) => r.kind))
  const kind = kinds.size === 1 ? ([...kinds][0] as 'income' | 'expense') : null
  const same = <T,>(xs: T[]) => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null)
  const who = same(changeable.map(whoOf))
  const categoryId = same(changeable.map((r) => r.categoryId))
  const { out, inn } = totals(rows)

  return (
    <div className="space-y-5 p-5 text-sm">
      <div>
        <p className="text-xs text-muted-foreground">
          Selected ·{' '}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onClear}>
            clear
          </button>
        </p>
        <h2 className="mt-1 text-lg font-semibold">{rows.length} lines</h2>
        <p className="mt-2 text-3xl font-semibold tracking-[-0.02em] tabular-nums">
          {out > 0 && `-${formatBaht(out)}`}
          {inn > 0 && <span className="text-good">{out > 0 && ' '}+{formatBaht(inn)}</span>}
          {!out && !inn && formatBaht(0)}
        </p>
      </div>

      {changeable.length < rows.length && (
        <p className="text-xs text-muted-foreground">
          {rows.length - changeable.length} of these can’t take a category or person — transfers, rows already entered, or lines that won’t import. Changes skip them.
        </p>
      )}

      {changeable.length > 0 && (
        <>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Responsible{who ? '' : ' · mixed'}</p>
            <WhoChips members={members} withShared={kind !== 'income'} value={who} onPick={(id) => onWho(lines, id)} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Category{categoryId ? '' : ' · mixed'}</p>
            {kind ? (
              <CategoryPickerPanel categories={categories} kind={kind} selectedId={categoryId} onSelect={(c) => onCategory(lines, c.id)} />
            ) : (
              // Income and expense lines together share no one category grid; the select lists both kinds.
              <select className="h-8 w-full rounded-md border bg-background px-2" value="" onChange={(e) => e.target.value && onCategory(lines, e.target.value)}>
                <option value="">Income and expense mixed — set category…</option>
                <CategoryOptions categories={categories} />
              </select>
            )}
          </div>
        </>
      )}

      {tickable.length > 0 && (
        <Button className="w-full" variant={allTicked ? 'outline' : 'default'} onClick={() => onAccept(tickable, !allTicked)}>
          {allTicked ? (
            `Don’t import these ${tickable.length}`
          ) : (
            <>
              <Check />
              Import {tickable.length === rows.length ? 'all' : tickable.length} of these
            </>
          )}
        </Button>
      )}
    </div>
  )
}

function ApplyBar({ toApply, applying, onApply, onStartOver }: Props) {
  const { out, inn } = totals(toApply)
  return (
    <div className="space-y-2 border-t bg-background px-4 py-3">
      <div className="text-xs leading-tight">
        <p className="font-medium">{toApply.length ? `${toApply.length} ${toApply.length === 1 ? 'line' : 'lines'} to import` : 'Nothing ticked yet'}</p>
        {toApply.length > 0 && (
          <p className="text-muted-foreground tabular-nums">
            -{formatBaht(out)} out
            {inn > 0 && (
              <>
                {' · '}
                <span className="text-good">+{formatBaht(inn)} in</span>
              </>
            )}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onStartOver}>
          Start over
        </Button>
        <Button className="ml-auto" disabled={!toApply.length || applying} onClick={onApply}>
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      </div>
    </div>
  )
}
