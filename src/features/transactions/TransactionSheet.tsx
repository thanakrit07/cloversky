import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Bookmark, CalendarDays, CalendarSync, CreditCard, Plus, ReceiptText, Repeat, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CategoryIcon } from '@/lib/categoryIcons'
import { CategoryPickerPanel } from '@/components/CategoryPickerPanel'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ReceiptSheet } from './ReceiptSheet'
import { DatePickerPanel } from '@/components/DatePickerPanel'
import { EntryPage } from '@/components/EntryPage'
import { FullScreenPage } from '@/components/FullScreenPage'
import { InstrumentPickerPanel } from '@/components/InstrumentPickerPanel'
import { type Instrument } from '@/components/InstrumentSelect'
import { Keypad } from '@/components/Keypad'
import { evenSplit, WhoBearsField, type WhoBearsValue } from '@/components/WhoBearsField'
import { useAmountEntry } from '@/hooks/useAmountEntry'
import { useEntryPanel } from '@/hooks/useEntryPanel'
import { categoryPath, useCategories, type Category } from '@/lib/categories'
import { useCategoryUsage } from '@/lib/categoryUsage'
import type { EntryPrefill } from '@/lib/entryPrefill'
import { usePresets, type Preset } from '@/lib/presets'
import { PresetsScreen } from '@/features/settings/PresetsScreen'
import { SavePresetDialog } from './SavePresetDialog'
import { useAccounts } from '@/lib/accounts'
import { useCards } from '@/lib/cards'
import { useHousehold } from '@/lib/HouseholdContext'
import type { BillScan } from '@/lib/scanBill'
import { installmentPeriodLabel } from '@/lib/installmentLabel'
import { useInstallmentLabels } from '@/lib/installments'
import { toBuddhistYear } from '@/lib/month'
import { supabase } from '@/lib/supabase'
import {
  useCreateTransaction,
  useDeleteTransaction,
  useUpdateTransaction,
  type Transaction,
  type TransactionInput,
  type TransactionKind,
} from '@/lib/transactions'
import { invalidateShareQueries, syncTransactionShares, useTransactionShares } from '@/lib/transactionShares'
import { cn } from '@/lib/utils'
import { InstallmentSheet } from '@/features/installments/InstallmentSheet'
import { RecurringRuleSheet } from '@/features/plan/RecurringRuleSheet'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function dateRowLabel(value: string): string {
  if (value === today()) return 'Today'
  const d = new Date(`${value}T00:00:00`)
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${toBuddhistYear(d.getFullYear())}`
}

const KINDS: { key: TransactionKind; label: string }[] = [
  { key: 'expense', label: 'Expense' },
  { key: 'income', label: 'Income' },
  { key: 'transfer', label: 'Transfer' },
]

// The settled strip's chips (§7.2): answers the app already has, one tap
// each. Same selected treatment as a Preset chip and the pickers' tiles.
function stripChip(active: boolean, placeholder: boolean): string {
  return cn(
    'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors active:scale-[0.98]',
    active ? 'bg-primary/15 ring-1 ring-primary' : 'bg-muted',
    placeholder && 'text-muted-foreground',
  )
}

// A transfer's From / To get Category's weight: they are its questions.
function instrumentBox(active: boolean, value: Instrument): string {
  const empty = !value.accountId && !value.cardId
  return cn(
    'min-w-0 flex-1 truncate rounded-2xl px-4 py-3.5 text-left transition-colors',
    active ? 'bg-primary/10 ring-1 ring-primary' : empty ? 'border-2 border-dashed text-muted-foreground' : 'bg-muted',
  )
}

type PanelKey = 'amount' | 'category' | 'from' | 'to' | 'date'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction?: Transaction
  /**
   * A bill scan's reading of the slip (ADR-0017), filling the fields it can
   * see. It cannot see which card paid — no slip says — so that row is left
   * for the household, which is also what stops this from being a way to
   * *record* a payment rather than describe one.
   */
  scan?: BillScan | null
}

export function TransactionSheet({ open, onOpenChange, transaction, scan }: Props) {
  const { householdId, self, members } = useHousehold()
  const { data: categories } = useCategories(householdId)
  const { data: usage } = useCategoryUsage(householdId)
  const { data: presets } = usePresets(householdId, self.id)
  const { data: allShares } = useTransactionShares(householdId)
  const { data: accounts } = useAccounts(householdId)
  const { data: cards } = useCards(householdId)
  const queryClient = useQueryClient()
  const create = useCreateTransaction(householdId)
  const update = useUpdateTransaction(householdId)
  const remove = useDeleteTransaction(householdId)
  // v3.9: the amount keypad opens on mount — it's the one field every entry
  // fills in, so it shouldn't cost a tap to reach. Editing an existing row
  // starts with no panel open since the amount is already set.
  const panel = useEntryPanel<PanelKey>(transaction ? null : 'amount')

  const [kind, setKind] = useState<TransactionKind>(transaction?.kind ?? 'expense')
  const amountField = useAmountEntry(
    transaction ? String(transaction.amount) : scan ? String(scan.total) : '',
  )
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.category_id ?? null)
  const [from, setFrom] = useState<Instrument>({
    accountId: transaction?.from_account_id ?? null,
    cardId: transaction?.from_card_id ?? null,
  })
  const [to, setTo] = useState<Instrument>({
    accountId: transaction?.to_account_id ?? null,
    cardId: transaction?.to_card_id ?? null,
  })
  // A scanned date only when the slip actually showed one — `toIsoDate`
  // returns null rather than inventing today's, and today's is the better
  // fallback anyway (you photograph the slip when you get home).
  const [date, setDate] = useState(transaction?.date ?? scan?.date ?? today())
  const [description, setDescription] = useState(transaction?.description ?? '')
  const [note, setNote] = useState(transaction?.note ?? scan?.merchant ?? '')

  // D13/D14: Who bears replaces Owner. Defaults to "Just you"; when editing
  // a transaction that already has a Split, it's loaded once its shares
  // arrive (they're a separate fetch, so this can't be the useState
  // initialiser — mirrors the category-expand effect below).
  const [whoBears, setWhoBears] = useState<WhoBearsValue>({ mode: 'you', custom: {} })
  const [whoBearsLoaded, setWhoBearsLoaded] = useState(false)
  useEffect(() => {
    if (whoBearsLoaded || !transaction || !allShares) return
    const mine = allShares.filter((s) => s.transaction_id === transaction.id)
    if (mine.length === 1) {
      // A single share row is exactly what the one-tap "entirely theirs"
      // pick writes (D13) — read back as `sole`, not `custom`, so reopening
      // it for edit shows the same one-tap state instead of an editable
      // breakdown that happens to have one row.
      setWhoBears({ mode: 'sole', soleBearerId: mine[0].member_id, custom: {} })
    } else if (mine.length > 1) {
      const custom: Record<string, number> = {}
      for (const s of mine) custom[s.member_id] = s.share_amount
      setWhoBears({ mode: 'custom', custom })
    }
    setWhoBearsLoaded(true)
  }, [whoBearsLoaded, transaction, allShares])

  // Rep/Inst (D9, §7.2): turns what's typed here into a Recurring Rule or an
  // Installment Plan instead of a one-off transaction.
  const [repInstOpen, setRepInstOpen] = useState(false)
  const [creating, setCreating] = useState<'recurring' | 'installment' | null>(null)

  const [detailsOpen, setDetailsOpen] = useState(Boolean(transaction?.description))
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [splitting, setSplitting] = useState(false)
  // D22: splitting is an edit, not an entry mode (ADR-0015), so it lives on
  // the row that already exists rather than on the way in. A transfer has no
  // category to divide, and an installment period's amount is the plan's to
  // decide (D15) — `split_transaction_into_receipt` refuses both, and the
  // button does not offer them in the first place.
  // ADR-0016: the period label is composed from the plan, not stored on the
  // row, so it is shown as a fact about this transaction rather than as text
  // in a field. Editing it here would mean editing one period's copy of a
  // name eleven other periods also carry — which is the drift the derived
  // label exists to make impossible.
  const { data: planById } = useInstallmentLabels(householdId)
  const periodLabel = transaction ? installmentPeriodLabel(transaction, planById) : null

  // The scan's proposal, resolved to names the household would recognise —
  // shown here only; the split form re-reads the scan itself.
  const scanLines = scan?.lines?.map((line) => {
    const category = line.categoryId ? categories?.find((c) => c.id === line.categoryId) : null
    return {
      // A line the model could not place says so, rather than rendering blank
      // — the household is about to be asked to fill it in.
      name: category ? categoryPath(category, categories ?? []) : 'Needs a category',
      // The remainder line's amount is derived by the split form, not typed.
      amount: line.amount === '' ? 'the rest' : line.amount,
    }
  })

  // Available while recording, not only while editing (ADR-0018). Reaching a
  // receipt used to mean saving a payment under one heading you already knew
  // was wrong, then reopening it to correct that — so the household had to
  // record something false on the way to recording something true.
  //
  // No new control: this is the button that was already here, ungated. The
  // form's rows are untouched, which is what keeps D9's tap budget out of it.
  const canSplit =
    transaction == null
      ? kind !== 'transfer'
      : transaction.kind !== 'transfer' &&
        transaction.source !== 'installment' &&
        transaction.receipt_id == null
  // How many rows this run of "Save & add" has written. The quick-add sheet
  // is mounted for the life of the app with `open` toggling (App.tsx), not
  // remounted per use, so this has to be cleared by hand — otherwise the
  // next trip through the FAB inherits the last one's tally.
  const [savedCount, setSavedCount] = useState(0)
  useEffect(() => {
    if (!open) setSavedCount(0)
  }, [open])
  // Once the user picks an instrument by hand (or is editing an existing
  // row), category taps must stop auto-overriding it.
  const [fromTouched, setFromTouched] = useState(Boolean(transaction))

  // CategoryPickerPanel filters out system categories (Modified Bal —
  // balanceAdjustments.ts) itself, so it's never offered as a destination.
  // A transaction already filed under one still needs to show its real
  // label when reopened for edit, though — looked up from the full list,
  // not a filtered one, or it would silently fall back to the "Choose a
  // category" placeholder.
  const selectedCategory: Category | null = categoryId ? ((categories ?? []).find((c) => c.id === categoryId) ?? null) : null

  // D27: the chip row is the person's own Presets, in the order they set —
  // replacing v3.9's top-six-by-frequency chips, which moved under the thumb
  // as counts changed. Never the only way in: the Category row and its full
  // grid stay exactly as they were (D17). A preset whose category has been
  // archived drops out here; Settings → Presets still lists it.
  const visiblePresets = useMemo(() => {
    const byId = new Map((categories ?? []).map((c) => [c.id, c]))
    return (presets ?? []).filter((p) => {
      const c = byId.get(p.category_id)
      return p.kind === kind && c != null && !c.archived && !c.system
    })
  }, [presets, categories, kind])
  const [savingPreset, setSavingPreset] = useState(false)
  const [managingPresets, setManagingPresets] = useState(false)

  function instrumentLabel(instrument: Instrument): string {
    if (instrument.accountId) return accounts?.find((a) => a.id === instrument.accountId)?.name ?? '…'
    if (instrument.cardId) return cards?.find((c) => c.id === instrument.cardId)?.name ?? '…'
    return ''
  }

  const canSave =
    amountField.value > 0 &&
    (kind === 'transfer' ? Boolean(to.accountId || to.cardId) : Boolean(categoryId)) &&
    Boolean(from.accountId || from.cardId)

  function changeKind(next: TransactionKind) {
    setKind(next)
    panel.close()
    // A category from the other kind would violate the DB's composite FK.
    const current = categories?.find((c) => c.id === categoryId)
    if (current && current.kind !== next) setCategoryId(null)
  }

  function selectCategory(category: Category) {
    setCategoryId(category.id)
    // Smart default: the instrument last used with this category.
    if (!fromTouched) {
      const last = usage?.lastInstrument.get(category.id)
      if (last && (last.accountId || last.cardId)) setFrom(last)
    }
  }

  // A tap fills, never saves (D27). Category and instrument are what the tap
  // asks for, so they replace; amount and note only fill an empty field, so
  // nothing already typed is lost. A filled amount is replaced by the first
  // digit typed (useAmountEntry.fill). A preset without an instrument falls
  // back to the usual last-used default via selectCategory.
  function applyPreset(preset: Preset) {
    const category = categories?.find((c) => c.id === preset.category_id)
    if (!category) return
    selectCategory(category)
    if (preset.account_id || preset.card_id) setFrom({ accountId: preset.account_id, cardId: preset.card_id })
    if (!note && preset.note) setNote(preset.note)
    if (amountField.value === 0 && preset.amount != null) amountField.fill(String(preset.amount))
  }

  // Clears what changes row to row and deliberately keeps what doesn't: the
  // date and the paying Instrument stay put, because several rows entered in
  // one sitting are nearly always the same day on the same card. Who bears is
  // *not* sticky — inheriting "split evenly" onto the next row would quietly
  // create a Debt nobody asked for, and D13 exists to make sharing deliberate.
  function resetForNextEntry() {
    amountField.reset()
    panel.open('amount')
    setDescription('')
    setNote('')
    setCategoryId(null)
    setDetailsOpen(false)
    setWhoBears({ mode: 'you', custom: {} })
  }

  function buildPrefill(): EntryPrefill {
    return {
      name: note || description,
      kind,
      categoryId: kind === 'transfer' ? null : categoryId,
      amount: amountField.value,
      ownerId: self.id,
      from,
      date,
    }
  }

  async function handleSave({ keepOpen = false }: { keepOpen?: boolean } = {}) {
    // The Who-bears panel is the Split's single source of truth now (D13):
    // "Just you" writes no rows at all — the not-a-debt case — "Split
    // evenly" and the one-tap "entirely theirs" (sole) are both computed
    // fresh from the live amount here, and only a real Custom breakdown is
    // typed verbatim. owner_id itself no longer carries any of that
    // meaning; it's just who this transaction defaults to when there's no
    // Split to read.
    const memberIds = members.map((m) => m.id)
    const custom =
      whoBears.mode === 'you'
        ? []
        : whoBears.mode === 'split'
          ? memberIds.map((id) => ({ member_id: id, share_amount: evenSplit(amountField.value, memberIds)[id] }))
          : whoBears.mode === 'sole'
            ? [{ member_id: whoBears.soleBearerId!, share_amount: amountField.value }]
            : Object.entries(whoBears.custom).map(([member_id, share_amount]) => ({ member_id, share_amount }))

    const input: TransactionInput = {
      date,
      kind,
      categoryId: kind === 'transfer' ? null : categoryId,
      categoryKind: kind === 'transfer' ? null : (kind as 'income' | 'expense'),
      description,
      amount: amountField.value,
      ownerId: self.id,
      fromAccountId: from.accountId,
      fromCardId: from.cardId,
      toAccountId: kind === 'transfer' ? to.accountId : null,
      toCardId: kind === 'transfer' ? to.cardId : null,
      note: note || null,
    }
    const shareParams = {
      householdId,
      kind,
      ownerId: self.id,
      frontingMemberId: null,
      amount: amountField.value,
      memberIds,
      custom,
    }
    try {
      if (transaction) {
        // Saving an unconfirmed (generated) row counts as reviewing it.
        await update.mutateAsync({ id: transaction.id, input, confirm: !transaction.confirmed })
        await syncTransactionShares({ ...shareParams, transactionId: transaction.id })
        invalidateShareQueries(queryClient, householdId)
        onOpenChange(false)
        return
      }
      const id = await create.mutateAsync(input)
      await syncTransactionShares({ ...shareParams, transactionId: id })
      invalidateShareQueries(queryClient, householdId)
      resetForNextEntry()
      if (keepOpen) {
        // Rapid entry: stay on the form, with the amount keypad already
        // reopened by resetForNextEntry, so the next row costs an amount and
        // a category and nothing else. No toast — one per row would stack up
        // over the very keypad the next row is about to be typed on, and it
        // would time out just when you looked away. The count in the header
        // says the same thing and stays said. Undo is still a swipe on the
        // row in Records.
        setSavedCount((n) => n + 1)
        return
      }
      onOpenChange(false)
      toast.success('Transaction saved', {
        action: {
          label: 'Undo',
          onClick: async () => {
            await supabase.from('transactions').update({ deleted_at: new Date().toISOString() }).eq('id', id)
            queryClient.invalidateQueries({ queryKey: ['transactions', householdId] })
          },
        },
      })
    } catch (err) {
      // Some edits are refused outright — changing the amount of a shared
      // transaction whose split is already settled, for one (0022). Those
      // messages say what to do about it, so show them instead of failing
      // silently, which is what an unhandled rejection here used to do.
      toast.error(err instanceof Error ? err.message : 'Could not save the transaction.')
    }
  }

  async function handleDelete() {
    if (!transaction) return
    await remove.mutateAsync(transaction.id)
    onOpenChange(false)
  }

  if (!open) return null

  // The running tally lives in the header because the footer is the keypad
  // for most of a rapid-entry run — resetForNextEntry reopens it — so it is
  // the one spot that stays visible between rows.
  const title = transaction
    ? 'Edit transaction'
    : savedCount > 0
      ? `Add transaction · ${savedCount} added`
      : 'Add transaction'

  return (
    <>
      <EntryPage
        title={title}
        onClose={() => onOpenChange(false)}
        panelOpen={panel.active !== null}
        headerActions={
          !transaction && kind !== 'transfer' ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSavingPreset(true)}
              disabled={!categoryId}
              aria-label="Save as preset"
            >
              <Bookmark className="size-4" />
            </Button>
          ) : null
        }
        footer={
          panel.active === 'amount' ? (
            <Keypad onKey={amountField.press} onEquals={amountField.pressEquals} onDone={panel.close} />
          ) : panel.active === 'category' ? (
            <CategoryPickerPanel
              categories={categories ?? []}
              kind={kind === 'transfer' ? 'expense' : kind}
              selectedId={categoryId}
              onSelect={(c, hasSubs) => {
                selectCategory(c)
                if (!hasSubs) panel.close()
              }}
            />
          ) : panel.active === 'from' ? (
            <InstrumentPickerPanel
              value={from}
              onChange={(next) => {
                setFrom(next)
                setFromTouched(true)
                panel.close()
              }}
            />
          ) : panel.active === 'to' ? (
            <InstrumentPickerPanel
              value={to}
              onChange={(next) => {
                setTo(next)
                panel.close()
              }}
            />
          ) : panel.active === 'date' ? (
            <DatePickerPanel
              value={date}
              onChange={(d) => {
                setDate(d)
                panel.close()
              }}
            />
          ) : (
            <div className="flex gap-2">
              {transaction && (
                <Button variant="outline" size="icon" onClick={() => setConfirmingDelete(true)} aria-label="Delete transaction">
                  <Trash2 className="size-4" />
                </Button>
              )}
              {/* Only when adding: an edit has one row by definition. */}
              {!transaction && (
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => handleSave({ keepOpen: true })}
                  disabled={!canSave || create.isPending}
                >
                  Save &amp; add
                </Button>
              )}
              <Button className="flex-1" onClick={() => handleSave()} disabled={!canSave || create.isPending || update.isPending}>
                Save
              </Button>
            </div>
          )
        }
      >
        {/* A scan lands on a form that is otherwise identical to a manual
            entry, so without this the household cannot tell whether the
            categories were read or lost — and has to press Save to find out.
            The split form is a screen away; this says so, and shows what is
            waiting on it. */}
        {scan && (
          <div className="rounded-xl bg-muted/60 p-3 text-xs">
            {scanLines ? (
              <>
                <p className="font-medium text-foreground">
                  {scanLines.length} categories read from the photo
                </p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                  {scanLines.map((line, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{line.name}</span>
                      <span className="shrink-0 tabular-nums">{line.amount}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-muted-foreground">
                  Save this payment and the split opens next, filled in — nothing is
                  recorded per category until you confirm it there.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                Only one category was found on the photo, so this saves as an ordinary
                transaction rather than a receipt.
              </p>
            )}
          </div>
        )}

        {kind !== 'transfer' && (visiblePresets.length > 0 || !transaction) && (
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5">
            {visiblePresets.map((p) => {
              const c = categories?.find((x) => x.id === p.category_id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors active:scale-[0.98]',
                    categoryId === p.category_id ? 'bg-primary/15 ring-1 ring-primary' : 'bg-muted active:bg-accent',
                  )}
                >
                  <CategoryIcon icon={c?.icon ?? null} color={c?.color ?? null} className="size-3.5 shrink-0" />
                  <span className="whitespace-nowrap">{p.name}</span>
                </button>
              )
            })}
            {visiblePresets.length === 0 && (
              <button
                type="button"
                onClick={() => setManagingPresets(true)}
                className="flex shrink-0 items-center gap-1 rounded-full border border-dashed px-3 py-1.5 text-sm text-muted-foreground active:bg-accent"
              >
                <Plus className="size-3.5" />
                Preset
              </button>
            )}
          </div>
        )}

        {/* 2026-10 redesign (§7.2): the form asks six things and two of them
            are questions, so Amount and Category carry the weight and the
            answers the app already has (kind, instrument, date) sit lighter.
            Nothing is hidden — every one stays a single tap (D17). */}
        <div className="flex justify-center">
          <div role="radiogroup" aria-label="Kind" className="inline-flex rounded-full bg-muted p-0.5 text-xs">
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                role="radio"
                aria-checked={kind === k.key}
                onClick={() => changeKind(k.key)}
                className={cn(
                  'rounded-full px-3 py-1 transition-colors',
                  kind === k.key ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <button type="button" onClick={() => panel.toggle('amount')} aria-label="Amount" className="block w-full py-1 text-center">
          <span
            className={cn(
              'inline-block max-w-full truncate border-b-2 px-2 text-5xl font-semibold tracking-[-0.03em] tabular-nums transition-colors',
              panel.active === 'amount' ? 'border-primary' : 'border-transparent',
              !amountField.expr ? 'text-muted-foreground/50' : kind === 'income' ? 'text-good' : 'text-foreground',
            )}
          >
            {amountField.expr || '0'}
          </span>
        </button>

        {kind !== 'transfer' ? (
          <button
            type="button"
            onClick={() => panel.toggle('category')}
            className={cn(
              'flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left text-base transition-colors',
              panel.active === 'category'
                ? 'bg-primary/10 ring-1 ring-primary'
                : selectedCategory
                  ? 'bg-muted'
                  : 'border-2 border-dashed',
            )}
          >
            {selectedCategory ? (
              <span className="flex min-w-0 items-center gap-2">
                <CategoryIcon icon={selectedCategory.icon} color={selectedCategory.color} className="size-5 shrink-0" />
                <span className="truncate">{categoryPath(selectedCategory, categories ?? [])}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Choose a category</span>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => panel.toggle('from')} className={instrumentBox(panel.active === 'from', from)}>
              {from.accountId || from.cardId ? instrumentLabel(from) : 'From'}
            </button>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            <button type="button" onClick={() => panel.toggle('to')} className={instrumentBox(panel.active === 'to', to)}>
              {to.accountId || to.cardId ? instrumentLabel(to) : 'To'}
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {kind !== 'transfer' && (
            <button
              type="button"
              onClick={() => panel.toggle('from')}
              className={stripChip(panel.active === 'from', !from.accountId && !from.cardId)}
            >
              <CreditCard className="size-3.5" />
              {from.accountId || from.cardId ? instrumentLabel(from) : 'Account / card'}
            </button>
          )}
          <button type="button" onClick={() => panel.toggle('date')} className={stripChip(panel.active === 'date', false)}>
            <CalendarDays className="size-3.5" />
            {dateRowLabel(date)}
          </button>
          {/* A row already saved can still become an installment (it is then replaced by the plan)
              or the first occurrence of a repeating rule (it is kept, and the rule posts what follows) —
              unless it already is one. */}
          {kind !== 'transfer' && (!transaction || transaction.source === 'manual' || transaction.source === 'import') && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setRepInstOpen((o) => !o)}
                aria-label="Repeat or instalment"
                className={stripChip(repInstOpen, false)}
              >
                <CalendarSync className="size-3.5" />
                <span className="text-muted-foreground">Repeat</span>
              </button>
              {repInstOpen && (
                <div className="absolute left-0 bottom-full z-10 mb-1.5 w-40 space-y-1 rounded-lg border bg-popover p-1.5 shadow-md">
                  {!transaction?.recurring_rule_id && (
                    <button
                      type="button"
                      onClick={() => {
                        setRepInstOpen(false)
                        setCreating('recurring')
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors active:bg-accent"
                    >
                      <Repeat className="size-4 text-muted-foreground" />
                      Repeat
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setRepInstOpen(false)
                      setCreating('installment')
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors active:bg-accent"
                  >
                    <CalendarSync className="size-4 text-muted-foreground" />
                    Instalment
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {kind === 'expense' && (
          <WhoBearsField amount={amountField.value} members={members} selfId={self.id} value={whoBears} onChange={setWhoBears} />
        )}

        {/* Read-only on purpose: this row states which period of which plan
            the charge is, and both halves belong to the plan. It sits above
            Note so the field below is unambiguously the user's own. */}
        {periodLabel && (
          <div className="rounded-xl bg-muted/60 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CalendarSync className="size-4 shrink-0 text-muted-foreground" />
              <span>{periodLabel}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              From the installment plan. Rename it there and every period follows.
            </p>
          </div>
        )}

        {/* Tapping in needs the system keyboard, not the shared panel —
            without closing it, both fight for the same screen space. */}
        <input
          id="txn-note"
          aria-label="Note"
          placeholder="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onFocus={panel.close}
          className="w-full border-b bg-transparent py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
        />

        {!detailsOpen ? (
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            + Add details
          </button>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="txn-description">Details (optional)</Label>
            <Input id="txn-description" value={description} onChange={(e) => setDescription(e.target.value)} onFocus={panel.close} />
          </div>
        )}
        {/* Set apart by a rule rather than left as a second bare text link
            under "+ Add details": that one edits a field on this form, while
            this one turns the record into something else. Wearing the same
            clothes 12px apart, they read as one two-line list of the same
            kind of action. */}
        {canSplit && (
          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setSplitting(true)}
              className="flex w-full items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-2.5 text-left transition-colors active:bg-accent/60"
            >
              <ReceiptText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">
                  {transaction ? 'Split into a receipt' : 'Create a receipt'}
                </span>
                <span className="block text-[11px] text-muted-foreground">One payment, more than one category</span>
              </span>
            </button>
          </div>
        )}
      </EntryPage>

      {creating === 'recurring' && (
        <RecurringRuleSheet
          rule={null}
          prefill={buildPrefill()}
          adopts={transaction ? { transactionId: transaction.id, date: transaction.date } : undefined}
          onClose={() => {
            setCreating(null)
            onOpenChange(false)
          }}
        />
      )}
      {creating === 'installment' && (
        <InstallmentSheet
          installment={null}
          prefill={buildPrefill()}
          supersedes={transaction?.id}
          onClose={() => {
            setCreating(null)
            onOpenChange(false)
          }}
        />
      )}
      {splitting && (
        <ReceiptSheet
          draft={
            transaction
              ? { kind: 'split', transaction }
              : {
                  kind: 'new',
                  // Whatever was typed so far comes along; nothing has to be
                  // entered twice, and nothing has been written yet.
                  payment: {
                    amount: amountField.value,
                    date,
                    instrument: from,
                    categoryId,
                    kind,
                    label: note || description,
                  },
                }
          }
          onClose={() => {
            setSplitting(false)
            onOpenChange(false)
          }}
        />
      )}
      {savingPreset && categoryId && kind !== 'transfer' && (
        <SavePresetDialog
          defaultName={note || selectedCategory?.name || ''}
          draft={{
            kind,
            category_id: categoryId,
            note: note.trim() || null,
            account_id: from.accountId,
            card_id: from.cardId,
            amount: amountField.value > 0 ? amountField.value : null,
          }}
          onClose={() => setSavingPreset(false)}
        />
      )}
      {managingPresets && (
        <FullScreenPage title="Presets" onClose={() => setManagingPresets(false)}>
          <PresetsScreen />
        </FullScreenPage>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this transaction?"
          description="Removes it from every total. This can't be undone from here."
          onConfirm={handleDelete}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </>
  )
}

