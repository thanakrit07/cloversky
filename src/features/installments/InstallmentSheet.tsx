import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { AmountField } from '@/components/AmountField'
import { CategoryIcon } from '@/lib/categoryIcons'
import { CategoryPickerPanel } from '@/components/CategoryPickerPanel'
import { DatePickerPanel } from '@/components/DatePickerPanel'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EntryPage } from '@/components/EntryPage'
import { EntryRow } from '@/components/EntryRow'
import { InstrumentPickerPanel } from '@/components/InstrumentPickerPanel'
import { type Instrument } from '@/components/InstrumentSelect'
import { Keypad } from '@/components/Keypad'
import { PlanWhoBears, type PlanWhoBearsValue } from '@/components/PlanWhoBears'
import { useAmountEntry } from '@/hooks/useAmountEntry'
import { useEntryPanel } from '@/hooks/useEntryPanel'
import { useAccounts } from '@/lib/accounts'
import { useCards } from '@/lib/cards'
import { categoryPath, useCategories, type Category } from '@/lib/categories'
import type { EntryPrefill } from '@/lib/entryPrefill'
import { formatBaht } from '@/lib/format'
import { useHousehold } from '@/lib/HouseholdContext'
import { toBuddhistYear } from '@/lib/month'
import { useDeleteTransaction } from '@/lib/transactions'
import { isValidSplit } from '@/lib/transactionShares'
import {
  useCreateInstallment,
  useDeleteInstallment,
  useUpdateInstallment,
  type Installment,
  type InstallmentInput,
} from '@/lib/installments'
import { cn } from '@/lib/utils'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function dateRowLabel(value: string): string {
  if (value === today()) return 'Today'
  const d = new Date(`${value}T00:00:00`)
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${toBuddhistYear(d.getFullYear())}`
}

// The whole point of totalling is not doing this division by hand. The last
// period absorbs whatever the split doesn't divide evenly — same rounding
// rule as an even Split (computeShareRows) — so every period's amount sums
// back to exactly the total, in satang, not just in the common case.
function splitTotal(total: number, periods: number): { monthly: number; final: number } {
  if (periods <= 0) return { monthly: 0, final: 0 }
  const totalCents = Math.round(total * 100)
  const monthlyCents = Math.floor(totalCents / periods)
  const finalCents = totalCents - monthlyCents * (periods - 1)
  return { monthly: monthlyCents / 100, final: finalCents / 100 }
}

type AmountMode = 'total' | 'per-period'
type PanelKey = 'amount' | 'category' | 'instrument' | 'start'

interface Props {
  installment: Installment | null
  onClose: () => void
  // Set only when opened from Rep/Inst on the transaction form (D9) — what
  // was already typed there, carried over rather than retyped.
  prefill?: EntryPrefill
  // The expense this plan stands in for, when it was opened from a row already
  // saved: the plan posts every period itself, so keeping the original would
  // count the purchase twice. Removed (soft-deleted) once the plan is saved.
  supersedes?: string
}

export function InstallmentSheet({ installment, onClose, prefill, supersedes }: Props) {
  const { householdId, self, members } = useHousehold()
  const { data: categories } = useCategories(householdId)
  const { data: accounts } = useAccounts(householdId)
  const { data: cards } = useCards(householdId)
  const create = useCreateInstallment(householdId)
  const update = useUpdateInstallment(householdId)
  const remove = useDeleteInstallment(householdId)
  const removeExpense = useDeleteTransaction(householdId)
  const panel = useEntryPanel<PanelKey>()

  const [name, setName] = useState(installment?.name ?? prefill?.name ?? '')
  const [categoryId, setCategoryId] = useState<string | null>(installment?.category_id ?? prefill?.categoryId ?? null)
  const [startDate, setStartDate] = useState(installment?.start_date ?? prefill?.date ?? today())
  const [totalPeriods, setTotalPeriods] = useState(String(installment?.total_periods ?? prefill?.periods ?? 12))
  // Total is the primary way in (whatever the price tag said); typing a
  // known per-period figure instead — the bank's own wording — works too,
  // and whichever one wasn't typed is only ever a computed preview, never
  // stored separately (§7.2, "enter it either way round").
  const [amountMode, setAmountMode] = useState<AmountMode>('total')
  const periodsNum = Number(totalPeriods) || 0
  const initialAmount = installment
    ? installment.monthly_amount * installment.total_periods -
      installment.monthly_amount +
      (installment.final_amount ?? installment.monthly_amount)
    : prefill
      ? prefill.amount
      : 0
  const amount = useAmountEntry(installment || prefill ? String(initialAmount) : '')
  const { monthly: previewMonthly, final: previewFinal } =
    amountMode === 'total' ? splitTotal(amount.value, periodsNum) : { monthly: amount.value, final: amount.value }
  const previewTotal = amountMode === 'total' ? amount.value : amount.value * periodsNum
  const [instrument, setInstrument] = useState<Instrument>({
    accountId: installment?.account_id ?? prefill?.from.accountId ?? null,
    cardId: installment?.card_id ?? prefill?.from.cardId ?? null,
  })
  // Interest the way a Thai card plan quotes it: a flat % of the price per
  // month, billed as its own line every period. The baht figure follows the
  // rate until typed over (to match a statement to the satang); the stored
  // annual rate is the same % × 12, for the payoff ranking (DESIGN §6.4).
  const [monthlyRate, setMonthlyRate] = useState(() => {
    if (installment) return String(Math.round((installment.annual_interest_rate / 12) * 10000) / 10000)
    if (prefill?.periodInterest && prefill.amount > 0) return String(Math.round((prefill.periodInterest / prefill.amount) * 1000000) / 10000)
    return '0'
  })
  const [interestTyped, setInterestTyped] = useState<string | null>(() => {
    if (installment) return installment.period_interest == null ? '' : String(installment.period_interest)
    return prefill?.periodInterest != null ? String(prefill.periodInterest) : null
  })
  const rateInterest = Math.round(previewTotal * (Number(monthlyRate) || 0)) / 100
  // A plan made before 0036 keeps an empty field: its monthly amount already is the whole charge.
  const periodInterest = interestTyped === null ? rateInterest : interestTyped === '' ? 0 : Number(interestTyped) || 0
  const [isCashAdvance, setIsCashAdvance] = useState(installment?.is_cash_advance ?? false)
  const [whoBears, setWhoBears] = useState<PlanWhoBearsValue>({
    ownerId: installment ? installment.owner_id : (prefill?.ownerId ?? self.id),
    split: installment?.split ?? null,
  })
  const [note, setNote] = useState(installment?.note ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const relevantCategories = (categories ?? []).filter((c) => !c.archived && !c.system && c.kind === 'expense')
  const selectedCategory: Category | null = categoryId ? (relevantCategories.find((c) => c.id === categoryId) ?? null) : null

  function instrumentLabel(i: Instrument): string {
    if (i.accountId) return accounts?.find((a) => a.id === i.accountId)?.name ?? '…'
    if (i.cardId) return cards?.find((c) => c.id === i.cardId)?.name ?? '…'
    return ''
  }

  // Category is required, not a nicety: every period posts as an expense, and
  // transactions' category_iff_not_transfer check rejects an expense with no
  // category — so a plan saved without one silently never posts.
  const canSave =
    name.trim().length > 0 &&
    periodsNum > 0 &&
    amount.value > 0 &&
    categoryId != null &&
    Boolean(instrument.accountId || instrument.cardId) &&
    isValidSplit(whoBears.split)

  async function handleSave() {
    // The final period only ever differs from the rest by however the total
    // failed to divide evenly (splitTotal) — never a separately typed figure
    // (§7.2 v3.5: one amount field, entered either way round). null when the
    // two happen to match, matching the column's existing "null = same" rule.
    const input: InstallmentInput = {
      name: name.trim(),
      category_id: categoryId,
      start_date: startDate,
      total_periods: periodsNum,
      monthly_amount: previewMonthly,
      final_amount: previewFinal !== previewMonthly ? previewFinal : null,
      card_id: instrument.cardId,
      account_id: instrument.accountId,
      annual_interest_rate: Math.round((Number(monthlyRate) || 0) * 12 * 10000) / 10000,
      period_interest: periodInterest > 0 ? periodInterest : null,
      is_cash_advance: isCashAdvance,
      owner_id: whoBears.ownerId,
      split: whoBears.split,
      note: note || null,
      status: installment?.status ?? 'active',
    }
    if (installment) {
      // Saving also relabels the periods this plan already posted (D15/v4.3) —
      // including ones that drifted out of sync before this existed.
      await update.mutateAsync({ id: installment.id, input })
    } else {
      await create.mutateAsync(input)
      if (supersedes) {
        try {
          await removeExpense.mutateAsync(supersedes)
        } catch (e) {
          // The plan exists; only the original is left to remove by hand.
          toast.error(`The plan was saved, but the original expense could not be removed: ${e instanceof Error ? e.message : 'unknown error'}`)
        }
      }
    }
    onClose()
  }

  async function handleDelete() {
    if (!installment) return
    await remove.mutateAsync(installment.id)
    onClose()
  }

  return (
    <>
    <EntryPage
      title={installment ? 'Edit installment' : 'New installment'}
      onClose={onClose}
      panelOpen={panel.active !== null}
      footer={
        panel.active === 'amount' ? (
          <Keypad onKey={amount.press} onEquals={amount.pressEquals} onDone={panel.close} />
        ) : panel.active === 'category' ? (
          <CategoryPickerPanel
            categories={categories ?? []}
            kind="expense"
            selectedId={categoryId}
            onSelect={(c, hasSubs) => {
              setCategoryId(c.id)
              if (!hasSubs) panel.close()
            }}
          />
        ) : panel.active === 'instrument' ? (
          <InstrumentPickerPanel
            value={instrument}
            onChange={(next) => {
              setInstrument(next)
              panel.close()
            }}
          />
        ) : panel.active === 'start' ? (
          <DatePickerPanel
            value={startDate}
            onChange={(d) => {
              setStartDate(d)
              panel.close()
            }}
          />
        ) : (
          <div className="flex gap-2">
            {installment && (
              <Button variant="outline" size="icon" onClick={() => setConfirmingDelete(true)} aria-label="Delete installment">
                <Trash2 className="size-4" />
              </Button>
            )}
            <Button className="flex-1" onClick={handleSave} disabled={!canSave || create.isPending || update.isPending}>
              Save
            </Button>
          </div>
        )
      }
    >
      {supersedes && (
        <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          This plan replaces the expense you were editing: once it is saved, that expense is removed, because the plan posts every period itself.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="inst-name">Name</Label>
        {/* No autoFocus: opening the system keyboard the instant the sheet
            mounts is what shoved the whole sheet off-screen on iOS
            (DESIGN §7.2 D9 — same bug the amount keypad exists to avoid).
            Tapping the field remains a deliberate, expected keyboard open. */}
        <Input id="inst-name" value={name} onChange={(e) => setName(e.target.value)} onFocus={panel.close} />
      </div>

      <EntryRow
        label="Category"
        placeholder={!selectedCategory}
        active={panel.active === 'category'}
        onClick={() => panel.toggle('category')}
        value={
          selectedCategory ? (
            <span className="flex items-center gap-1.5">
              <CategoryIcon icon={selectedCategory.icon} color={selectedCategory.color} className="size-4" />
              {categoryPath(selectedCategory, categories ?? [])}
            </span>
          ) : (
            'Choose a category'
          )
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <EntryRow label="Start date" active={panel.active === 'start'} onClick={() => panel.toggle('start')} value={dateRowLabel(startDate)} />
        <div className="space-y-1.5">
          <Label htmlFor="inst-periods">Total periods</Label>
          <Input id="inst-periods" type="number" min={1} value={totalPeriods} onChange={(e) => setTotalPeriods(e.target.value)} onFocus={panel.close} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>{amountMode === 'total' ? 'Total amount' : 'Amount per period'}</Label>
          <div className="flex gap-1 rounded-lg border p-0.5 text-xs">
            {(['total', 'per-period'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setAmountMode(m)}
                className={cn(
                  'rounded-md px-2 py-1 transition-colors',
                  amountMode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                {m === 'total' ? 'Total' : 'Per period'}
              </button>
            ))}
          </div>
        </div>
        <AmountField expr={amount.expr} active={panel.active === 'amount'} onActivate={() => panel.toggle('amount')} size="lg" />
        {/* Whichever half wasn't typed — the split, or the total it adds
            up to — so entering it "the bank's way round" still shows
            what the plan actually commits to (§7.2 v3.5). */}
        {amount.value > 0 && periodsNum > 0 && (
          <p className="text-xs text-muted-foreground">
            {amountMode === 'total'
              ? previewFinal === previewMonthly
                ? `${formatBaht(previewMonthly)} × ${periodsNum}`
                : `${formatBaht(previewMonthly)} × ${periodsNum - 1}, last period ${formatBaht(previewFinal)}`
              : `${formatBaht(previewTotal)} total`}
          </p>
        )}
      </div>

      <EntryRow
        label="Billed to"
        placeholder={!instrument.accountId && !instrument.cardId}
        active={panel.active === 'instrument'}
        onClick={() => panel.toggle('instrument')}
        value={instrument.accountId || instrument.cardId ? instrumentLabel(instrument) : 'Select account or card'}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="inst-rate">Interest (% per month)</Label>
          <Input id="inst-rate" type="number" inputMode="decimal" value={monthlyRate} onChange={(e) => setMonthlyRate(e.target.value)} onFocus={panel.close} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inst-interest">Interest per period</Label>
          <Input
            id="inst-interest"
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            value={interestTyped ?? (rateInterest > 0 ? String(rateInterest) : '')}
            onChange={(e) => setInterestTyped(e.target.value)}
            onFocus={panel.close}
          />
        </div>
      </div>
      {periodInterest > 0 && periodsNum > 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {(Math.round((Number(monthlyRate) || 0) * 12 * 100) / 100).toString()}%/yr · {formatBaht(periodInterest * periodsNum)} interest in all, posted as its own line each period ·{' '}
          {formatBaht(previewTotal + periodInterest * periodsNum)} with the price
        </p>
      )}

      <div className="space-y-1.5">
        <Label>Responsible</Label>
        <PlanWhoBears members={members} selfId={self.id} value={whoBears} onChange={setWhoBears} referenceAmount={previewMonthly} />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <Label htmlFor="inst-cash-advance">Cash advance</Label>
          <p className="text-xs text-muted-foreground">Floats to the top of the payoff ranking</p>
        </div>
        <Switch id="inst-cash-advance" checked={isCashAdvance} onCheckedChange={setIsCashAdvance} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="inst-note">Note (optional)</Label>
        <Input id="inst-note" value={note} onChange={(e) => setNote(e.target.value)} onFocus={panel.close} />
      </div>
    </EntryPage>
    {confirmingDelete && (
      <ConfirmDialog
        title="Delete this installment plan?"
        description="Its periods stay in the ledger as ordinary transactions — this only removes the plan itself."
        onConfirm={handleDelete}
        onClose={() => setConfirmingDelete(false)}
      />
    )}
    </>
  )
}
