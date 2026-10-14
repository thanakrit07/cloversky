import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useHousehold } from '@/lib/HouseholdContext'
import { toBuddhistYear } from '@/lib/month'
import { isValidSplit } from '@/lib/transactionShares'
import type { MonthEndRule, RecurrenceFreq } from '@/lib/finance/recurrence'
import {
  useCreateRecurringRule,
  useDeleteRecurringRule,
  useUpdateRecurringRule,
  type AdoptedOccurrence,
  type RecurringRule,
  type RecurringRuleInput,
} from '@/lib/recurring'
import type { TransactionKind } from '@/lib/transactions'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function dateRowLabel(value: string): string {
  if (!value) return 'Not set'
  if (value === today()) return 'Today'
  const d = new Date(`${value}T00:00:00`)
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${toBuddhistYear(d.getFullYear())}`
}

type PanelKey = 'amount' | 'category' | 'from' | 'to' | 'start' | 'end'

interface Props {
  rule: RecurringRule | null
  onClose: () => void
  // Set only when opened from Rep/Inst on the transaction form (D9) — what
  // was already typed there, carried over rather than retyped.
  prefill?: EntryPrefill
  // The saved transaction this rule is being made from: it becomes the rule's
  // occurrence on its date, and the rule posts only what comes after it.
  adopts?: AdoptedOccurrence
}

export function RecurringRuleSheet({ rule, onClose, prefill, adopts }: Props) {
  const { householdId, self, members } = useHousehold()
  const { data: categories } = useCategories(householdId)
  const { data: accounts } = useAccounts(householdId)
  const { data: cards } = useCards(householdId)
  const create = useCreateRecurringRule(householdId)
  const update = useUpdateRecurringRule(householdId)
  const remove = useDeleteRecurringRule(householdId)
  const panel = useEntryPanel<PanelKey>()

  const [name, setName] = useState(rule?.name ?? prefill?.name ?? '')
  const [kind, setKind] = useState<TransactionKind>(rule?.kind ?? prefill?.kind ?? 'expense')
  const amount = useAmountEntry(rule ? String(rule.amount) : prefill ? String(prefill.amount) : '')
  const [categoryId, setCategoryId] = useState<string | null>(rule?.category_id ?? prefill?.categoryId ?? null)
  const [from, setFrom] = useState<Instrument>({
    accountId: rule?.from_account_id ?? prefill?.from.accountId ?? null,
    cardId: rule?.from_card_id ?? prefill?.from.cardId ?? null,
  })
  const [to, setTo] = useState<Instrument>({
    accountId: rule?.to_account_id ?? null,
    cardId: rule?.to_card_id ?? null,
  })
  // Same trap as TransactionSheet: null means "shared" (§4.2), so a nullish
  // fallback would quietly reassign a shared rule to whoever edits it.
  const [whoBears, setWhoBears] = useState<PlanWhoBearsValue>({
    ownerId: rule ? rule.owner_id : (prefill?.ownerId ?? self.id),
    split: rule?.split ?? null,
  })
  const [freq, setFreq] = useState<RecurrenceFreq>(rule?.freq ?? 'monthly')
  const [interval, setIntervalValue] = useState(String(rule?.interval ?? 1))
  // A prefilled date is when this actually happens, so it is also the day
  // (and, yearly, the month) it repeats on — not the 1st by default.
  const [dayOfMonth, setDayOfMonth] = useState(String(rule?.day_of_month ?? (prefill ? Number(prefill.date.slice(8, 10)) : 1)))
  const [monthOfYear, setMonthOfYear] = useState(String(rule?.month_of_year ?? (prefill ? Number(prefill.date.slice(5, 7)) : 1)))
  const [weekday, setWeekday] = useState(String(rule?.weekday ?? 1))
  const [monthEnd, setMonthEnd] = useState<MonthEndRule>(rule?.month_end ?? 'clamp')
  const [startDate, setStartDate] = useState(rule?.start_date ?? prefill?.date ?? today())
  const [endDate, setEndDate] = useState(rule?.end_date ?? '')
  const [autoPost, setAutoPost] = useState(rule?.auto_post ?? false)
  const [variableAmount, setVariableAmount] = useState(rule?.variable_amount ?? false)
  const [active, setActive] = useState(rule?.active ?? true)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const relevantCategories = (categories ?? []).filter((c) => !c.archived && !c.system && c.kind === kind)
  const selectedCategory: Category | null = categoryId ? (relevantCategories.find((c) => c.id === categoryId) ?? null) : null

  function instrumentLabel(instrument: Instrument): string {
    if (instrument.accountId) return accounts?.find((a) => a.id === instrument.accountId)?.name ?? '…'
    if (instrument.cardId) return cards?.find((c) => c.id === instrument.cardId)?.name ?? '…'
    return ''
  }

  const canSave =
    name.trim().length > 0 &&
    amount.value > 0 &&
    Number(interval) > 0 &&
    Boolean(from.accountId || from.cardId) &&
    (kind === 'transfer' ? Boolean(to.accountId || to.cardId) : Boolean(categoryId)) &&
    (freq === 'weekly' || (Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31)) &&
    isValidSplit(whoBears.split)

  function changeKind(next: TransactionKind) {
    setKind(next)
    panel.close()
    const current = categories?.find((c) => c.id === categoryId)
    if (current && current.kind !== next) setCategoryId(null)
    // Income is never split (ADR-0002) — the Who-bears picker hides for it,
    // so a "Split evenly"/Custom/other-person choice left over from Expense
    // must not silently leave income owned by nobody.
    if (next !== 'expense' && (whoBears.ownerId !== self.id || whoBears.split)) {
      setWhoBears({ ownerId: self.id, split: null })
    }
  }

  async function handleSave() {
    const input: RecurringRuleInput = {
      name: name.trim(),
      kind,
      category_id: kind === 'transfer' ? null : categoryId,
      category_kind: kind === 'transfer' ? null : (kind as 'income' | 'expense'),
      amount: amount.value,
      owner_id: whoBears.ownerId,
      split: whoBears.split,
      from_account_id: from.accountId,
      from_card_id: from.cardId,
      to_account_id: kind === 'transfer' ? to.accountId : null,
      to_card_id: kind === 'transfer' ? to.cardId : null,
      note: null,
      freq,
      interval: Number(interval),
      day_of_month: freq === 'weekly' ? null : Number(dayOfMonth),
      month_of_year: freq === 'yearly' ? Number(monthOfYear) : null,
      weekday: freq === 'weekly' ? Number(weekday) : null,
      month_end: monthEnd,
      start_date: startDate,
      end_date: endDate || null,
      max_occurrences: null,
      auto_post: autoPost,
      variable_amount: variableAmount,
      active,
    }
    if (rule) {
      await update.mutateAsync({ id: rule.id, input })
    } else {
      const { linkError } = await create.mutateAsync({ input, adopts })
      if (linkError) toast.error(`The rule was saved, but the original transaction could not be linked to it: ${linkError}`)
    }
    onClose()
  }

  async function handleDelete() {
    if (!rule) return
    await remove.mutateAsync(rule.id)
    onClose()
  }

  return (
    <>
    <EntryPage
      title={rule ? 'Edit recurring rule' : 'New recurring rule'}
      onClose={onClose}
      panelOpen={panel.active !== null}
      footer={
        panel.active === 'amount' ? (
          <Keypad onKey={amount.press} onEquals={amount.pressEquals} onDone={panel.close} />
        ) : panel.active === 'category' ? (
          <CategoryPickerPanel
            categories={categories ?? []}
            kind={kind === 'transfer' ? 'expense' : kind}
            selectedId={categoryId}
            onSelect={(c, hasSubs) => {
              setCategoryId(c.id)
              if (!hasSubs) panel.close()
            }}
          />
        ) : panel.active === 'from' ? (
          <InstrumentPickerPanel
            value={from}
            onChange={(next) => {
              setFrom(next)
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
        ) : panel.active === 'start' ? (
          <DatePickerPanel
            value={startDate}
            onChange={(d) => {
              setStartDate(d)
              panel.close()
            }}
          />
        ) : panel.active === 'end' ? (
          <DatePickerPanel
            value={endDate}
            clearable
            onChange={(d) => {
              setEndDate(d)
              panel.close()
            }}
          />
        ) : (
          <div className="flex gap-2">
            {rule && (
              <Button variant="outline" size="icon" onClick={() => setConfirmingDelete(true)} aria-label="Delete rule">
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
      {adopts && (
        <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          The transaction you were editing becomes this rule’s occurrence on {dateRowLabel(adopts.date)}. The rule posts only what comes after it, so
          nothing already in the ledger is added twice.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="rule-name">Name</Label>
        {/* No autoFocus: opening the system keyboard the instant the sheet
            mounts is what shoved the whole sheet off-screen on iOS
            (DESIGN §7.2 D9 — same bug the amount keypad exists to avoid).
            Tapping the field remains a deliberate, expected keyboard open. */}
        <Input
          id="rule-name"
          placeholder="Salary, Netflix, Car insurance…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={panel.close}
        />
      </div>

      <Tabs value={kind} onValueChange={(v) => changeKind(v as TransactionKind)}>
        <TabsList className="w-full">
          <TabsTrigger value="expense" className="flex-1">Expense</TabsTrigger>
          <TabsTrigger value="income" className="flex-1">Income</TabsTrigger>
          <TabsTrigger value="transfer" className="flex-1">Transfer</TabsTrigger>
        </TabsList>
      </Tabs>

      <AmountField label="Amount" expr={amount.expr} active={panel.active === 'amount'} onActivate={() => panel.toggle('amount')} />

      {kind !== 'transfer' && (
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
              'Select category'
            )
          }
        />
      )}

      <EntryRow
        label={kind === 'transfer' ? 'From' : 'Account / card'}
        placeholder={!from.accountId && !from.cardId}
        active={panel.active === 'from'}
        onClick={() => panel.toggle('from')}
        value={from.accountId || from.cardId ? instrumentLabel(from) : 'Select account or card'}
      />

      {kind === 'transfer' && (
        <EntryRow
          label="To"
          placeholder={!to.accountId && !to.cardId}
          active={panel.active === 'to'}
          onClick={() => panel.toggle('to')}
          value={to.accountId || to.cardId ? instrumentLabel(to) : 'Select account or card'}
        />
      )}

      {kind === 'expense' && (
        <div className="space-y-1.5">
          <Label>Responsible</Label>
          <PlanWhoBears members={members} selfId={self.id} value={whoBears} onChange={setWhoBears} referenceAmount={amount.value} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Repeats</Label>
          <Select value={freq} onValueChange={(v) => setFreq(v as RecurrenceFreq)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-interval">Every N {freq === 'weekly' ? 'weeks' : freq === 'monthly' ? 'months' : 'years'}</Label>
          <Input id="rule-interval" type="number" min={1} value={interval} onChange={(e) => setIntervalValue(e.target.value)} onFocus={panel.close} />
        </div>
      </div>

      {freq === 'weekly' ? (
        <div className="space-y-1.5">
          <Label>Day of week</Label>
          <Select value={weekday} onValueChange={setWeekday}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d, i) => (
                <SelectItem key={d} value={String(i)}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {freq === 'yearly' && (
            <div className="space-y-1.5">
              <Label>Month</Label>
              <Select value={monthOfYear} onValueChange={setMonthOfYear}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="rule-day">Day of month</Label>
            <Input id="rule-day" type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} onFocus={panel.close} />
          </div>
          {Number(dayOfMonth) > 28 && (
            <div className="space-y-1.5">
              <Label>Short months</Label>
              <Select value={monthEnd} onValueChange={(v) => setMonthEnd(v as MonthEndRule)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="clamp">Use last day</SelectItem>
                  <SelectItem value="skip">Skip month</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <EntryRow label="Starts" active={panel.active === 'start'} onClick={() => panel.toggle('start')} value={dateRowLabel(startDate)} />
        <EntryRow
          label="Ends (optional)"
          placeholder={!endDate}
          active={panel.active === 'end'}
          onClick={() => panel.toggle('end')}
          value={dateRowLabel(endDate)}
        />
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label htmlFor="rule-autopost">Post automatically</Label>
            <p className="text-xs text-muted-foreground">Counts immediately, no review needed</p>
          </div>
          <Switch id="rule-autopost" checked={autoPost} onCheckedChange={setAutoPost} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label htmlFor="rule-variable">Amount varies</Label>
            <p className="text-xs text-muted-foreground">e.g. utilities — always asks for review</p>
          </div>
          <Switch id="rule-variable" checked={variableAmount} onCheckedChange={setVariableAmount} />
        </div>
        {rule && (
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="rule-active">Active</Label>
            <Switch id="rule-active" checked={active} onCheckedChange={setActive} />
          </div>
        )}
      </div>

      {rule && (
        <p className="text-xs text-muted-foreground">
          Changes apply to future occurrences only — entries already recorded stay as they are.
        </p>
      )}
    </EntryPage>
    {confirmingDelete && (
      <ConfirmDialog
        title="Delete this recurring rule?"
        description="Occurrences already posted as transactions stay — only future ones stop being generated."
        onConfirm={handleDelete}
        onClose={() => setConfirmingDelete(false)}
      />
    )}
    </>
  )
}
