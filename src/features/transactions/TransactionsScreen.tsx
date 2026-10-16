import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Check, ChevronRight, ReceiptText, X } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { SwipeableRow } from '@/components/SwipeableRow'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { CategoryIcon } from '@/lib/categoryIcons'
import { categoryPath, useCategories } from '@/lib/categories'
import type { Card } from '@/lib/cards'
import { cycleFetchRange, inCycle, type Cycle } from '@/lib/finance/billingCycle'
import { useInstrumentNames } from '@/lib/instruments'
import { useHousehold } from '@/lib/HouseholdContext'
import { borneAmount, matchesPersonFilter, sharesByTransaction, type PersonFilter } from '@/lib/filters'
import { formatBaht } from '@/lib/format'
import { ALL_TIME, dayOfMonthLabel, fullDateLabel, monthRange, weekdayLabel, yearOfMonth } from '@/lib/month'
import {
  describeRecordsFilter,
  isRecordsFilterActive,
  matchesRecordsFilter,
  type RecordsFilterState,
} from '@/lib/recordsFilter'
import { supabase } from '@/lib/supabase'
import { parsePeriodSourceKey } from '@/lib/installmentMaterialiser'
import { installmentPeriodLabel } from '@/lib/installmentLabel'
import { ReceiptSheet } from './ReceiptSheet'
import { useInstallmentLabels, useInstallmentPayments, useSetPeriodPaid } from '@/lib/installments'
import { useTransactionShares } from '@/lib/transactionShares'
import { entryAmount, groupByReceipt, type LedgerEntry } from '@/lib/receiptGrouping'
import { useDeleteReceipt, useReceipts, useRestoreReceipt } from '@/lib/receipts'
import { useDeleteTransaction, useTransactions, type Transaction } from '@/lib/transactions'
import { cn } from '@/lib/utils'
import { CalendarGrid } from './CalendarGrid'
import { MonthlyBreakdown } from './MonthlyBreakdown'
import { RecordsSummary } from './RecordsSummary'
import { ReviewStrip } from './ReviewStrip'
import { TransactionSheet } from './TransactionSheet'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export type RecordsView = 'daily' | 'calendar' | 'monthly'

interface Props {
  month: string
  onMonthChange: (month: string) => void
  view: RecordsView
  onViewChange: (view: RecordsView) => void
  person: PersonFilter
  search: string
  filter: RecordsFilterState
  onClearFilter?: () => void
  // A card's natural period is its billing cycle, not the calendar month
  // (§7.3 v3.8) — when set, this overrides `month` for the fetch range and
  // swaps the usual In/Out summary for CardCycleSummary's bill total.
  card?: Card | null
  cardCycle?: Cycle | null
  onClearCard?: () => void
}

export function TransactionsScreen({
  month,
  onMonthChange,
  view,
  onViewChange,
  person,
  search,
  filter,
  onClearFilter,
  card,
  cardCycle,
  onClearCard,
}: Props) {
  const { householdId, members } = useHousehold()
  // v3.9: search leaves the month. It used to just filter whatever the
  // month fetch happened to hold, so a query for something recorded in a
  // different month silently came back empty — indistinguishable from
  // "you never did that". An active query fetches the whole ledger instead.
  const isSearching = search.trim().length > 0
  // The Monthly tab (2026-09) and a card's billing-cycle view are two
  // different ways of stepping outside a single calendar month, and neither
  // makes sense layered on the other — a card's cycle table for a whole
  // year has no design yet, so viewing a card falls back to Daily.
  const isMonthly = view === 'monthly' && !isSearching && !cardCycle
  // Calendar (2026-09) stays within one month like Daily does, so it has no
  // such conflict with a card's cycle view — but a search's "whole ledger,
  // no month" range has no month to grid, so it still falls back to Daily.
  const isCalendar = view === 'calendar' && !isSearching
  const showViewToggle = !isSearching && !cardCycle
  const range = useMemo(
    () => (isSearching ? ALL_TIME : cardCycle ? cycleFetchRange(cardCycle) : monthRange(month)),
    [month, cardCycle, isSearching],
  )
  const { data: transactions } = useTransactions(householdId, range)
  const { data: categories } = useCategories(householdId)
  const { data: shares } = useTransactionShares(householdId)
  // Includes deleted accounts/cards, so a past transaction keeps naming
  // where the money actually moved (see useInstrumentNames).
  const { data: instrumentName } = useInstrumentNames(householdId)
  const isDesktop = useIsDesktop()
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<Transaction | null>(null)
  // Calendar tab: which day's bottom drawer is open, if any.
  const [calendarDrawerDate, setCalendarDrawerDate] = useState<string | null>(null)
  const remove = useDeleteTransaction(householdId)
  const { data: payments } = useInstallmentPayments(householdId)
  const setPeriodPaid = useSetPeriodPaid(householdId)
  const queryClient = useQueryClient()

  const sharesByTxn = useMemo(() => sharesByTransaction(shares), [shares])

  // Settled installment periods, keyed "<installmentId>:<periodNo>".
  const paidKeys = useMemo(
    () => new Set((payments ?? []).map((p) => `${p.installment_id}:${p.period_no}`)),
    [payments],
  )

  function installmentPeriodOf(t: Transaction) {
    if (t.source !== 'installment' || !t.from_card_id) return null
    // The paid tick sits on the period itself, not on its interest line.
    const parsed = parsePeriodSourceKey(t.source_key)
    return parsed?.interest ? null : parsed
  }

  // ADR-0016: a period's label is composed here, never read out of `note`.
  // Renaming a plan therefore changes every row that quotes it on the next
  // render, with nothing written and nothing left to drift.
  const { data: planById } = useInstallmentLabels(householdId)
  const periodLabelOf = (t: Transaction) => installmentPeriodLabel(t, planById)

  const { data: receipts } = useReceipts(householdId)
  const receiptById = useMemo(() => new Map((receipts ?? []).map((r) => [r.id, r])), [receipts])
  const removeReceipt = useDeleteReceipt(householdId)
  const restoreReceipt = useRestoreReceipt(householdId)
  const [expandedReceipts, setExpandedReceipts] = useState<Set<string>>(() => new Set())
  // The receipt open as a whole, as opposed to one merely expanded in place.
  const [editingReceipt, setEditingReceipt] = useState<Extract<LedgerEntry, { type: 'receipt' }> | null>(null)
  const [confirmingReceiptDelete, setConfirmingReceiptDelete] = useState<Extract<LedgerEntry, { type: 'receipt' }> | null>(null)

  // All of a receipt's lines or none of them (ADR-0015). The refusal comes
  // from `delete_receipt`, which names the line that has already been settled
  // up rather than removing what it can — so the message is worth showing
  // verbatim.
  async function handleDeleteReceipt(receiptId: string) {
    try {
      await removeReceipt.mutateAsync(receiptId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete this receipt')
      return
    }
    toast.success('Receipt deleted', {
      action: { label: 'Undo', onClick: () => restoreReceipt.mutate(receiptId) },
    })
  }

  async function handleDelete(t: Transaction) {
    await remove.mutateAsync(t.id)
    toast.success('Transaction deleted', {
      action: {
        label: 'Undo',
        onClick: async () => {
          await supabase.from('transactions').update({ deleted_at: null }).eq('id', t.id)
          queryClient.invalidateQueries({ queryKey: ['transactions', householdId] })
        },
      },
    })
  }

  const categoryById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories])
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])

  // Unconfirmed (generated, unreviewed) rows are excluded from every total
  // (§6.6), same as rows filed under a system category — a Balance
  // Adjustment the household said "no, just adjust the balance" to
  // (balanceAdjustments.ts) reads nowhere in Records, including when
  // filtered to the very account it's on; it belongs to that account's own
  // screen instead.
  const confirmed = useMemo(
    () => (transactions ?? []).filter((t) => t.confirmed && !categoryById.get(t.category_id ?? '')?.system),
    [transactions, categoryById],
  )

  const matchesCard = (t: Transaction) => !card || t.from_card_id === card.id || t.to_card_id === card.id
  const matchesSearch = (t: Transaction) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    const category = t.category_id ? categoryById.get(t.category_id) : null
    // The period label is derived, so searching a plan's name has to look at
    // the composed string — the ledger shows it, and `note` no longer holds it.
    const haystack = [periodLabelOf(t), t.note, t.description, category?.name, instrumentName?.[`account:${t.from_account_id}`], instrumentName?.[`card:${t.from_card_id}`]]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  }

  const filtered = confirmed.filter(
    (t) =>
      matchesPersonFilter(t, sharesByTxn, person) &&
      matchesRecordsFilter(t, filter) &&
      matchesCard(t) &&
      (!cardCycle || inCycle(t, cardCycle)) &&
      matchesSearch(t),
  )
  // D14: day totals below are what this person Borne, not the face value of
  // what they're merely listed on — full amounts would double-count a
  // shared row across both people's totals and break "A + B = All". The
  // month/category totals this fed also drive RecordsSummary now, which
  // derives them itself from the same `month`/`person`/`card`/`cardCycle`.
  const borneOf = (t: Transaction) => (person === 'all' ? t.amount : borneAmount(t, sharesByTxn, person))

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>()
    for (const t of filtered) {
      const list = map.get(t.date) ?? []
      list.push(t)
      map.set(t.date, list)
    }
    // A period's interest line (0036) posts in the same batch, so created_at
    // can't order the pair: put it straight under its period, as on the statement.
    for (const [date, list] of map) {
      const keys = new Set(list.map((t) => t.source_key))
      const isPairedInterest = (t: Transaction) => t.source_key?.endsWith(':interest') && keys.has(t.source_key.slice(0, -':interest'.length))
      const interestOf = new Map(list.filter(isPairedInterest).map((t) => [t.source_key!.slice(0, -':interest'.length), t]))
      map.set(date, list.flatMap((t) => (isPairedInterest(t) ? [] : interestOf.has(t.source_key!) ? [t, interestOf.get(t.source_key!)!] : [t])))
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [filtered])
  const groupsByDate = useMemo(() => new Map(groups), [groups])

  // Calendar tab: each real day's income/expense, same Borne math as the
  // Daily ledger's own day headers below — a cell's figure and what the
  // drawer it opens adds up to never disagree. Not memoized: `groups` (a
  // month's worth of days, already memoized) is small enough that summing
  // it per render costs less than the machinery to cache it would.
  const dailyTotals = new Map<string, { income: number; expense: number }>()
  for (const [date, items] of groups) {
    const income = items.filter((t) => t.kind === 'income').reduce((sum, t) => sum + borneOf(t), 0)
    const expense = items.filter((t) => t.kind === 'expense').reduce((sum, t) => sum + borneOf(t), 0)
    dailyTotals.set(date, { income, expense })
  }

  function instrumentLabel(t: Transaction, side: 'from' | 'to'): string {
    const accountId = side === 'from' ? t.from_account_id : t.to_account_id
    const cardId = side === 'from' ? t.from_card_id : t.to_card_id
    if (accountId) return instrumentName?.[`account:${accountId}`] ?? 'Account'
    if (cardId) return instrumentName?.[`card:${cardId}`] ?? 'Card'
    return ''
  }

  const filterActive = isRecordsFilterActive(filter)
  const filterSummary = filterActive
    ? describeRecordsFilter(filter, {
        category: (id) => categoryById.get(id)?.name,
        instrument: (id) => instrumentName?.[`account:${id}`] ?? instrumentName?.[`card:${id}`],
      })
    : ''

  // Extracted from the ledger's own map so the same row can be rendered
  // inside an expanded Receipt without a second copy of it (D22). A line of
  // a receipt is an ordinary Transaction and must look like one — only its
  // indent differs.
  const renderRow = (t: Transaction, indented = false) => {
                  const category = t.category_id ? categoryById.get(t.category_id) : null
                  const owner = t.owner_id ? memberById.get(t.owner_id) : null
                  const catPath = category ? categoryPath(category, categories ?? []) : null
                  // A period leads with its plan, not with whatever the user
                  // typed: the plan is what the charge *is*, and the note is a
                  // remark about it. When both exist the note joins the
                  // details line rather than displacing the label.
                  const periodLabel = periodLabelOf(t)
                  const title =
                    t.kind === 'transfer'
                      ? `${instrumentLabel(t, 'from')} → ${instrumentLabel(t, 'to')}`
                      : periodLabel || t.note || catPath || t.kind
                  // Category only repeats below when it isn't already the title.
                  const details = [periodLabel && t.note ? t.note : null, catPath === title ? null : catPath, instrumentLabel(t, 'from'), owner?.display_name]
                    .filter(Boolean)
                    .join(' · ')
                  // A row with an explicit Split (D13) previously looked
                  // identical to an ordinary personal one under "All" — the
                  // "yours ฿X" line only ever appeared once filtered to a
                  // specific person. One dot per member who Bears part of
                  // it, in their own colour (the same dot Settings/Balances
                  // already use for "this belongs to this person"), makes
                  // it visible without adding a new visual vocabulary.
                  const bearers = [...new Set((sharesByTxn.get(t.id) ?? []).filter((s) => s.share_amount > 0).map((s) => s.member_id))]
                    .map((id) => memberById.get(id))
                    .filter((m): m is (typeof members)[number] => m != null)
                  // Under a specific person's filter, a shared row's full
                  // amount stays the headline (the coffee cost what it cost)
                  // and their own portion shows underneath — showing only the
                  // portion would misstate what the thing cost.
                  const mine = person !== 'all' ? borneAmount(t, sharesByTxn, person) : null
                  const period = installmentPeriodOf(t)
                  const periodKey = period ? `${period.installmentId}:${period.periodNo}` : null
                  const periodPaid = periodKey != null && paidKeys.has(periodKey)
                  return (
                    <li key={t.id} className={cn('border-t', indented && 'bg-muted/30')}>
                      <SwipeableRow onDelete={() => setConfirmingDelete(t)}>
                        <div className="flex items-center">
                          <button
                            onClick={() => setEditing(t)}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left transition-colors active:bg-accent/60',
                              indented ? 'pl-10' : 'pl-3',
                            )}
                          >
                            {t.kind === 'transfer' ? (
                              <ArrowRightLeft className="size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <CategoryIcon icon={category?.icon ?? null} color={category?.color} className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className={cn('truncate text-sm', periodPaid && 'text-muted-foreground')}>
                                  {title}
                                  {t.description && <span className="text-muted-foreground"> — {t.description}</span>}
                                </span>
                                {!t.confirmed && (
                                  <span className="shrink-0 rounded-full bg-warning px-1.5 text-[10px] text-warning-foreground">
                                    Pending
                                  </span>
                                )}
                              </span>
                              {(details || bearers.length > 0) && (
                                <span className="flex items-center gap-1">
                                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                                    {details}
                                  </span>
                                  {bearers.length > 0 && (
                                    <span className="flex shrink-0 items-center gap-0.5" aria-label={`Shared with ${bearers.map((m) => m.display_name).join(', ')}`}>
                                      {bearers.map((m) => (
                                        <span key={m.id} className="size-1.5 rounded-full" style={{ backgroundColor: m.color }} />
                                      ))}
                                    </span>
                                  )}
                                </span>
                              )}
                            </span>
                            {/* `yours` used to be tacked onto the end of the
                                details line, which truncates — so on any row
                                with a long category path or instrument name it
                                was the first thing to go, which is exactly the
                                row that needed it. It sits under the amount
                                instead: never truncated, aligned with the
                                figure it is a portion of, and on a line the row
                                had already reserved for the details beside it. */}
                            <span className="shrink-0 text-right">
                              <span
                                className={cn(
                                  'block text-sm tabular-nums',
                                  t.kind === 'income'
                                    ? 'text-good'
                                    : t.kind === 'expense'
                                      ? 'text-foreground'
                                      : 'text-muted-foreground',
                                )}
                              >
                                {t.kind === 'income' ? '+' : t.kind === 'expense' ? '-' : ''}
                                {formatBaht(t.amount)}
                              </span>
                              {mine != null && mine > 0 && mine < t.amount && (
                                <span className="block text-[11px] tabular-nums text-muted-foreground">
                                  yours {formatBaht(mine)}
                                </span>
                              )}
                            </span>
                          </button>

                          {/* Card-billed installment periods only: tick when the
                              statement carrying this period has been paid. */}
                          {period ? (
                            <button
                              onClick={() =>
                                setPeriodPaid.mutate({
                                  installmentId: period.installmentId,
                                  periodNo: period.periodNo,
                                  transactionId: t.id,
                                  paidDate: t.date > todayIso() ? todayIso() : t.date,
                                  paid: !periodPaid,
                                })
                              }
                              disabled={setPeriodPaid.isPending}
                              role="checkbox"
                              aria-checked={periodPaid}
                              // The plan's own name, not `title`: the title now carries the
                              // period number itself, so reading it here announces
                              // "period 4 of Notebook (งวดที่ 4/10)".
                              aria-label={`Mark period ${period.periodNo} of ${planById.get(period.installmentId)?.name ?? 'this plan'} paid`}
                              className="shrink-0 px-3 py-1.5"
                            >
                              <span
                                className={cn(
                                  'flex size-5 items-center justify-center rounded-md border transition-colors',
                                  periodPaid
                                    ? 'border-good bg-good text-white'
                                    : 'border-muted-foreground/40 text-transparent',
                                )}
                              >
                                <Check className="size-3.5" />
                              </span>
                            </button>
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                        </div>
                      </SwipeableRow>
                    </li>
                  )
  }

  const toggleReceipt = (id: string) =>
    setExpandedReceipts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderReceipt = (entry: Extract<LedgerEntry, { type: 'receipt' }>) => {
    const receipt = receiptById.get(entry.receiptId)
    const isOpen = expandedReceipts.has(entry.receiptId)
    // Summed from the lines on screen, never from a stored figure — a Receipt
    // has none (ADR-0015). A line borne entirely by the other member never
    // reached `lines` at all, so under a person filter the row can honestly
    // read less than the till printed (D14).
    //
    // The headline is what those lines cost and `mine` is the portion this
    // person bears, which is the convention every other row in the ledger
    // already follows. Leading with the borne sum instead — which this did at
    // first — put receipts on a different footing from the rows around them.
    const total = entryAmount(entry, (line) => line.amount)
    const mine = person !== 'all' ? entryAmount(entry, borneOf) : null
    const first = entry.lines[0]
    const kind = first?.kind ?? 'expense'
    return (
      <li key={entry.receiptId} className="border-t">
        <SwipeableRow onDelete={() => setConfirmingReceiptDelete(entry)}>
          <div className="flex items-center">
            {/* Two targets on one row, the pattern the Categories screen
                already uses (DESIGN §7): the name opens the receipt, the
                chevron peeks at it without leaving the ledger. Peeking and
                editing are different jobs and deserve different taps. */}
            <button
              onClick={() => setEditingReceipt(entry)}
              className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-3 text-left transition-colors active:bg-accent/60"
            >
              {/* A Receipt has no Category, so it cannot show a category icon.
                  Borrowing the largest line's would file the whole basket
                  under one heading again — the thing this feature exists to
                  stop. */}
              <ReceiptText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{receipt?.label ?? 'Receipt'}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {entry.lines.length} {entry.lines.length === 1 ? 'item' : 'items'}
                  {first ? ` \u00b7 ${instrumentLabel(first, 'from')}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className={cn('block text-sm tabular-nums', kind === 'income' ? 'text-good' : 'text-foreground')}>
                  {kind === 'income' ? '+' : '-'}
                  {formatBaht(total)}
                </span>
                {mine != null && mine > 0 && mine < total && (
                  <span className="block text-[11px] tabular-nums text-muted-foreground">yours {formatBaht(mine)}</span>
                )}
              </span>
            </button>
            <button
              onClick={() => toggleReceipt(entry.receiptId)}
              aria-expanded={isOpen}
              aria-label={isOpen ? 'Collapse receipt' : 'Expand receipt'}
              className="flex shrink-0 items-center px-2 py-1.5 transition-colors active:bg-accent/60"
            >
              <ChevronRight
                className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
              />
            </button>
          </div>
        </SwipeableRow>
        {isOpen && <ul>{entry.lines.map((line) => renderRow(line, true))}</ul>}
      </li>
    )
  }


  // Daily/Calendar/Monthly (2026-09): a compact segmented control rather
  // than a proper Tabs component — it lives inside this screen rather than
  // AppShell so the other tabs (Balances, Upcoming) are untouched by it.
  const viewToggle = showViewToggle && (
    <div className="inline-flex gap-1 rounded-lg bg-muted p-0.5">
      {(['daily', 'calendar', 'monthly'] as const).map((v) => (
        <button
          key={v}
          onClick={() => onViewChange(v)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
            view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  )

  if (isMonthly) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-4">
        {viewToggle}
        <MonthlyBreakdown
          year={yearOfMonth(month)}
          person={person}
          filter={filter}
          onSelectMonth={(selected) => {
            onMonthChange(selected)
            onViewChange('daily')
          }}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      {viewToggle}
      {/* One line (DESIGN §7.1 v3.5): the planning figures are the reason to
          open Records, but the daily habit is "jot → check the list", so the
          summary can't push the first transaction off the screen. On
          desktop this same component renders in AppShell's summary column
          instead (App.tsx), so it isn't rendered twice. */}
      {!isDesktop && !isSearching && (
        <RecordsSummary month={month} person={person} card={card} cardCycle={cardCycle} filter={filter} />
      )}

      <ReviewStrip onEdit={setEditing} />
      {filterActive && (
        <div className="flex items-center gap-1.5 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs text-foreground">
          <span className="min-w-0 flex-1 truncate">{filterSummary}</span>
          <button onClick={onClearFilter} className="shrink-0" aria-label="Clear filters">
            <X className="size-3" />
          </button>
        </div>
      )}
      {card && (
        <button
          onClick={onClearCard}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs text-foreground"
        >
          {card.name}
          <X className="size-3" aria-label="Clear card filter" />
        </button>
      )}
      {!isCalendar && groups.length === 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {isSearching ? 'No matches.' : filterActive ? 'No records match these filters.' : 'No transactions this month.'}
          </p>
          {!isSearching && filterActive && (
            <button onClick={onClearFilter} className="text-sm font-medium text-primary">
              Clear filters
            </button>
          )}
        </div>
      )}
      {isCalendar ? (
        <CalendarGrid month={month} totals={dailyTotals} onSelectDay={setCalendarDrawerDate} />
      ) : (
        /* Timeline (2026-10 redesign): the date is a left column and the
           day's rows hang off it, so the ledger reads as one continuous
           list on the page rather than a box. The day's totals sit under
           its rows, in muted text — red is kept for things that need
           attention, not for every expense. */
        <div>
          {groups.map(([date, items]) => {
            const dayIncome = items.filter((t) => t.kind === 'income').reduce((s, t) => s + borneOf(t), 0)
            const dayExpense = items.filter((t) => t.kind === 'expense').reduce((s, t) => s + borneOf(t), 0)
            return (
              <section key={date} className="grid grid-cols-[3rem_1fr] border-t first:border-t-0">
                <header className="pr-2 pt-2.5 text-center">
                  <p className="text-xl font-semibold leading-none tracking-[-0.02em] tabular-nums">{dayOfMonthLabel(date)}</p>
                  {/* Search spans months, so the month+year replaces the weekday there. */}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {isSearching ? fullDateLabel(date).split(' ').slice(1).join(' ') : weekdayLabel(date)}
                  </p>
                </header>
                <div className="min-w-0 border-l py-1">
                  <ul className="[&>li:first-child]:border-t-0 [&>li]:border-border/60">
                    {groupByReceipt(items).map((entry) =>
                      entry.type === 'transaction' ? renderRow(entry.transaction) : renderReceipt(entry),
                    )}
                  </ul>
                  <div className="flex justify-end gap-2.5 px-3 pb-1.5 pt-0.5 text-xs tabular-nums">
                    {dayIncome > 0 && <span className="text-good">+{formatBaht(dayIncome)}</span>}
                    {dayExpense > 0 && <span className="text-muted-foreground">−{formatBaht(dayExpense)}</span>}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      )}

      <Drawer open={calendarDrawerDate != null} onOpenChange={(open) => !open && setCalendarDrawerDate(null)}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{calendarDrawerDate ? fullDateLabel(calendarDrawerDate) : ''}</DrawerTitle>
          </DrawerHeader>
          {calendarDrawerDate && (groupsByDate.get(calendarDrawerDate) ?? []).length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No transactions this day.</p>
          ) : (
            <ul>
              {calendarDrawerDate &&
                groupByReceipt(groupsByDate.get(calendarDrawerDate) ?? []).map((entry) =>
                  entry.type === 'transaction' ? renderRow(entry.transaction) : renderReceipt(entry),
                )}
            </ul>
          )}
        </DrawerContent>
      </Drawer>

      {editing && <TransactionSheet open onOpenChange={(open) => !open && setEditing(null)} transaction={editing} />}
      {editingReceipt && (
        <ReceiptSheet
          draft={{
            kind: 'edit',
            receiptId: editingReceipt.receiptId,
            label: receiptById.get(editingReceipt.receiptId)?.label ?? 'Receipt',
            lines: editingReceipt.lines,
          }}
          onClose={() => setEditingReceipt(null)}
        />
      )}

      {confirmingReceiptDelete && (
        <ConfirmDialog
          title="Delete this receipt?"
          description={`Removes all ${confirmingReceiptDelete.lines.length} of its lines from every total. You'll have a few seconds to undo right after.`}
          onConfirm={() => handleDeleteReceipt(confirmingReceiptDelete.receiptId)}
          onClose={() => setConfirmingReceiptDelete(null)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this transaction?"
          description="Removes it from every total. You'll have a few seconds to undo right after."
          onConfirm={() => handleDelete(confirmingDelete)}
          onClose={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  )
}
