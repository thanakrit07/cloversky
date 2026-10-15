import { useMemo, useState, type ReactNode } from 'react'
import { differenceInCalendarDays, parse } from 'date-fns'
import { ChevronDown, CreditCard, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DateField } from '@/components/DateField'
import { SwipeableRow } from '@/components/SwipeableRow'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { OwnerSelect } from '@/components/OwnerSelect'
import { useAccounts, useCreateAccount, useUpdateAccount, type Account, type AccountType } from '@/lib/accounts'
import { ACCOUNT_ICON } from '@/lib/accountIcons'
import { adjustmentCategory } from '@/lib/balanceAdjustments'
import { useCardCycleAdjustments, type CardCycleAdjustment } from '@/lib/cardCycleAdjustments'
import { useCards, useCreateCard, useUpdateCard, type Card } from '@/lib/cards'
import { useCategories, type Category } from '@/lib/categories'
import { accountBalance, cardOutstanding, setAside, spentThisCycle } from '@/lib/finance/balances'
import { closedCycleAsOf, cycleBill, cycleOf } from '@/lib/finance/billingCycle'
import type { PersonFilter } from '@/lib/filters'
import { useHousehold } from '@/lib/HouseholdContext'
import {
  isInstrumentBlocked,
  useDeleteInstrument,
  useInstrumentUsage,
  type InstrumentKind,
} from '@/lib/instruments'
import { formatBaht } from '@/lib/format'
import { useInstallments, usePostedPeriods, type Installment } from '@/lib/installments'
import { ALL_TIME, dayMonthLabel } from '@/lib/month'
import { useCreateTransaction, useTransactions, useUnconfirmedTransactions, type Transaction } from '@/lib/transactions'
import { useClearedItems, useSettlements, useUndoRepayment, useUnsettledShares } from '@/lib/transactionShares'
import { groupByOwner } from '@/lib/ownerGroups'
import { cn } from '@/lib/utils'
import { SettleUpSheet } from '@/features/home/SettleUpSheet'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// A row says how stale it is only once it is stale — this is the
// threshold, not a second figure competing with the balance.
const STALE_AFTER_DAYS = 30

// The most recent date the household actually confirmed this account's
// balance: either an old anchor reading (accounts reconciled before Balance
// Adjustments existed) or the date of its newest Balance Adjustment
// transaction, whichever is later. Both of Reconcile's two answers count —
// `source === 'reconcile'` is common to both regardless of which category
// the amount landed in.
function lastConfirmedDate(account: Account, transactions: Transaction[]): string | null {
  let latest = account.last_confirmed_date
  for (const t of transactions) {
    if (t.source !== 'reconcile' || t.from_account_id !== account.id) continue
    if (!latest || t.date > latest) latest = t.date
  }
  return latest
}

// §6.3c/ADR-0012: a card row leads with its most recently closed Cycle
// Bill and when it's due, not capacity — this computes that pair the same
// way CardCycleSummary and CardForecastTab do (same cycleBill call, so the
// three screens can't disagree). `postedPeriods` and `adjustments` are
// household-wide; installments get filtered to this card's active plans.
function closedBillFor(
  card: Card,
  transactions: Transaction[],
  installments: Installment[],
  postedPeriods: ReadonlySet<string>,
  adjustments: CardCycleAdjustment[],
  today: string,
) {
  const closed = closedCycleAsOf(card, today)
  const cardTxns = transactions.filter((t) => t.from_card_id === card.id || t.to_card_id === card.id)
  const cardInstallments = installments.filter((i) => i.card_id === card.id && i.status === 'active')
  const adjustment = adjustments.find((a) => a.card_id === card.id && a.cycle_start === closed.start)?.amount ?? null
  const bill = cycleBill({ cycle: closed, cardId: card.id, transactions: cardTxns, installments: cardInstallments, adjustment, postedPeriods })
  return { bill, dueDate: closed.dueDate, cardInstallments, adjustment }
}

// D-0004: debts and their repayment history live here, not on Records —
// what one person owes another is a current-state figure like an account
// balance, not something that happened in a particular month.
function BetweenUsSection() {
  const { householdId, members } = useHousehold()
  const { data: unsettled } = useUnsettledShares(householdId)
  const { data: settlements } = useSettlements(householdId)
  const undoRepayment = useUndoRepayment(householdId)
  const [settling, setSettling] = useState<{ memberA: string; memberB: string } | null>(null)

  const settlementRows = useMemo(() => {
    const pairs = new Map<
      string,
      { memberA: string; memberB: string; owedByA: number; owedByB: number; count: number }
    >()
    for (const share of unsettled ?? []) {
      const [memberA, memberB] = [share.owes_member_id, share.owed_member_id].sort()
      const key = `${memberA}|${memberB}`
      const entry = pairs.get(key) ?? { memberA, memberB, owedByA: 0, owedByB: 0, count: 0 }
      if (share.owes_member_id === memberA) entry.owedByA += share.amount
      else entry.owedByB += share.amount
      entry.count += 1
      pairs.set(key, entry)
    }
    return [...pairs.values()].map((entry) => {
      const net = entry.owedByA - entry.owedByB
      return {
        ...entry,
        owesId: net >= 0 ? entry.memberA : entry.memberB,
        owedId: net >= 0 ? entry.memberB : entry.memberA,
        amount: Math.abs(net),
      }
    })
  }, [unsettled])
  const nameOf = (memberId: string) => members.find((m) => m.id === memberId)?.display_name ?? 'Someone'
  const recentSettlements = (settlements ?? []).slice(0, 5)
  const { data: cleared } = useClearedItems(householdId, recentSettlements.map((s) => s.id))
  const { data: categories } = useCategories(householdId)

  if (settlementRows.length === 0 && recentSettlements.length === 0) return null

  return (
    <>
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Between us</h2>
        {settlementRows.length > 0 && (
          <div className="space-y-2">
            {settlementRows.map((row) => (
              <div
                key={`${row.memberA}-${row.memberB}`}
                className="flex items-center justify-between gap-3 rounded-2xl border bg-warning px-4 py-3 text-sm"
              >
                <span className="min-w-0">
                  {row.amount > 0 ? (
                    <span className="block">
                      <span className="font-medium">{nameOf(row.owesId)}</span> owes{' '}
                      <span className="font-medium">{nameOf(row.owedId)}</span>{' '}
                      <span className="font-semibold text-warning-foreground">{formatBaht(row.amount)}</span>
                    </span>
                  ) : (
                    <span className="block font-medium">
                      {nameOf(row.memberA)} and {nameOf(row.memberB)} are even
                    </span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {row.count} item{row.count === 1 ? '' : 's'}
                    {row.owedByA > 0 && row.owedByB > 0
                      ? ` · net of ${nameOf(row.memberA)} ${formatBaht(row.owedByA)} / ${nameOf(row.memberB)} ${formatBaht(row.owedByB)}`
                      : ''}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setSettling({ memberA: row.memberA, memberB: row.memberB })}
                >
                  Settle up
                </Button>
              </div>
            ))}
          </div>
        )}

        {recentSettlements.length > 0 && (
          <div className="divide-y rounded-2xl border bg-card">
            {recentSettlements.map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {nameOf(s.from_member_id)} → {nameOf(s.to_member_id)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {dayMonthLabel(s.settled_on)} · {s.share_count} item{s.share_count === 1 ? '' : 's'}
                    {s.gross_amount !== s.amount ? ` · cleared ${formatBaht(s.gross_amount)}` : ''}
                    {s.net_cleared !== s.amount ? ` · doesn't match linked debts (${formatBaht(s.net_cleared)})` : ''}
                    {s.note ? ` · ${s.note}` : ''}
                  </span>
                  {/* Each debt knows which repayment cleared it, so say which. */}
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {(cleared ?? [])
                      .filter((c) => c.settled_by_transaction_id === s.id)
                      .map((c) => (
                        <li key={c.id} className="flex justify-between gap-2">
                          <span className="truncate">
                            {dayMonthLabel(c.date)} · {c.note || c.description || categories?.find((k) => k.id === c.category_id)?.name || 'Shared expense'}
                          </span>
                          <span className="shrink-0">{formatBaht(c.amount)}</span>
                        </li>
                      ))}
                  </ul>
                </span>
                <span className="shrink-0 font-medium">{formatBaht(s.amount)}</span>
                <button
                  type="button"
                  onClick={() => undoRepayment.mutate(s.id)}
                  disabled={undoRepayment.isPending}
                  className="shrink-0 text-xs text-muted-foreground underline underline-offset-2"
                >
                  Undo
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {settling && (
        <SettleUpSheet
          open
          onOpenChange={(open) => !open && setSettling(null)}
          memberA={settling.memberA}
          memberB={settling.memberB}
        />
      )}
    </>
  )
}

interface Props {
  person: PersonFilter
  onOpenAccount: (accountId: string) => void
  onOpenCard: (cardId: string) => void
}

export function AccountsScreen({ person, onOpenAccount, onOpenCard }: Props) {
  const { householdId, members, self } = useHousehold()
  const { data: accounts } = useAccounts(householdId)
  const { data: cards } = useCards(householdId)
  const { data: transactions } = useTransactions(householdId, ALL_TIME)
  const { data: categories } = useCategories(householdId)
  // §6.3c: everything cycleBill needs, so a card row can lead with its
  // closed cycle's bill instead of capacity.
  const { data: installments } = useInstallments(householdId)
  const { data: postedPeriods } = usePostedPeriods(householdId)
  const { data: cardCycleAdjustments } = useCardCycleAdjustments(householdId)
  // §6.6/v3.9: generated rows awaiting review are excluded from every figure
  // on this screen, so it has to say so — otherwise every balance here is
  // quietly understated the moment a subscription materialises.
  const { data: pendingReview } = useUnconfirmedTransactions(householdId)
  const [editingAccount, setEditingAccount] = useState<Account | 'new' | null>(null)
  const [editingCard, setEditingCard] = useState<Card | 'new' | null>(null)
  const [reconciling, setReconciling] = useState<Account | null>(null)
  const [deleting, setDeleting] = useState<{ kind: InstrumentKind; id: string; name: string } | null>(null)

  const today = todayIso()
  const allAccounts = accounts ?? []
  const allCards = cards ?? []
  const allTxns = transactions ?? []
  const allInstallments = installments ?? []
  const allAdjustments = cardCycleAdjustments ?? []
  const postedPeriodKeys = postedPeriods?.keys ?? new Set<string>()

  function setAsideFor(card: Card) {
    const { cardInstallments, adjustment } = closedBillFor(card, allTxns, allInstallments, postedPeriodKeys, allAdjustments, today)
    return setAside(card, allTxns, cardInstallments, postedPeriodKeys, adjustment, today)
  }

  function spentThisCycleFor(card: Card) {
    const { cardInstallments, adjustment } = closedBillFor(card, allTxns, allInstallments, postedPeriodKeys, allAdjustments, today)
    const open = cycleOf(card, today)
    const openAdjustment = allAdjustments.find((a) => a.card_id === card.id && a.cycle_start === open.start)?.amount ?? null
    return spentThisCycle(card, allTxns, cardInstallments, postedPeriodKeys, adjustment, openAdjustment, today)
  }

  // D18: a Common Pot has no owner and no per-person breakdown, so it sits
  // outside every filter below — every person filter sees it, and it is
  // never one of "mine" or "theirs".
  const potAccounts = allAccounts.filter((a) => a.owner_id === null)
  const potCards = allCards.filter((c) => c.owner_id === null)

  // D19: Balances honours the person filter like every other screen — "You"
  // shows only what's yours, so the app still works as a single-person
  // ledger for someone who never opens the Between-us section.
  const visibleAccounts = person === 'all' ? allAccounts : allAccounts.filter((a) => a.owner_id === person)
  const visibleCards = person === 'all' ? allCards : allCards.filter((c) => c.owner_id === person)
  const ownedAccounts = visibleAccounts.filter((a) => a.owner_id !== null)
  const ownedCards = visibleCards.filter((c) => c.owner_id !== null)

  // ADR-0023: the cash left once every baht already spent on a card is paid —
  // closed bills (Set Aside) and the open cycle so far. Future installment
  // periods are not spending yet; they live in Card debt. One function for
  // the headline and every panel, so a person's panel and the headline can
  // never disagree about what the figure means.
  function cashPosition(panelAccounts: Account[], panelCards: Card[]) {
    const cash = panelAccounts.reduce((sum, a) => sum + accountBalance(a, allTxns, today), 0)
    const billsDue = panelCards.reduce((sum, c) => sum + setAsideFor(c), 0)
    const thisCycle = panelCards.reduce((sum, c) => sum + spentThisCycleFor(c), 0)
    return { cash, billsDue, thisCycle, afterCards: cash - billsDue - thisCycle }
  }
  const headline = cashPosition(ownedAccounts, ownedCards)
  const cardDebtTotal = ownedCards.reduce((sum, c) => sum + cardOutstanding(c, allTxns), 0)
  const overdueBills = ownedCards.filter((c) => {
    const { dueDate } = closedBillFor(c, allTxns, allInstallments, postedPeriodKeys, allAdjustments, today)
    return dueDate < today && setAsideFor(c) > 0
  }).length

  // 2026-10 redesign: owner first, instrument type second. Each person is a
  // panel with their own net worth and their accounts and cards together —
  // yours first, a former member's last (groupByOwner) — and the Common Pot
  // is a panel of its own. Filtered to one person, it is their panel alone.
  const memberIds = members.map((m) => m.id)
  const ownerGroups = groupByOwner<Account | Card>([...ownedAccounts, ...ownedCards], memberIds, self.id)
  const hasPot = potAccounts.length > 0 || potCards.length > 0

  const accountRow = (account: Account) => (
    <AccountRow
      key={account.id}
      account={account}
      balance={accountBalance(account, allTxns, today)}
      lastConfirmedDate={lastConfirmedDate(account, allTxns)}
      onOpen={() => onOpenAccount(account.id)}
      onEdit={() => setEditingAccount(account)}
      onReconcile={() => setReconciling(account)}
      onDelete={() => setDeleting({ kind: 'account', id: account.id, name: account.name })}
    />
  )
  const cardRow = (card: Card) => {
    const { bill, dueDate } = closedBillFor(card, allTxns, allInstallments, postedPeriodKeys, allAdjustments, today)
    return (
      <CardRow
        key={card.id}
        card={card}
        bill={bill}
        dueDate={dueDate}
        outstanding={cardOutstanding(card, allTxns)}
        leftToPay={setAsideFor(card)}
        nextStatement={cycleOf(card, today).end}
        onOpen={() => !card.archived && onOpenCard(card.id)}
        onEdit={() => setEditingCard(card)}
        onDelete={() => setDeleting({ kind: 'card', id: card.id, name: card.name })}
      />
    )
  }
  // A panel's footer is the headline's sum for its own instruments, in the
  // same words; parts that are zero are left out.
  const panelFooter = ({ cash, billsDue, thisCycle }: ReturnType<typeof cashPosition>) =>
    [
      `${formatBaht(cash)} cash`,
      billsDue > 0 && `${formatBaht(billsDue)} bills due`,
      thisCycle > 0 && `${formatBaht(thisCycle)} this cycle`,
    ]
      .filter(Boolean)
      .join(' · ')

  const pendingReviewTotal = (pendingReview ?? []).reduce((sum, t) => sum + t.amount, 0)

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:max-w-4xl">
      <div className="space-y-3 px-1 pt-2">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">Cash after card spending</span>
          <div className="-mt-1 flex shrink-0 gap-1">
            <Button size="sm" variant="outline" onClick={() => setEditingAccount('new')}>
              <Plus className="size-4" />
              Account
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditingCard('new')}>
              <Plus className="size-4" />
              Card
            </Button>
          </div>
        </div>
        <span
          className={cn(
            '-mt-2 block text-4xl font-semibold leading-none tracking-[-0.035em] tabular-nums',
            headline.afterCards < 0 && 'text-destructive',
          )}
        >
          {formatBaht(headline.afterCards)}
        </span>
        {/* The sum spelled out, so the big figure is never a mystery. */}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Cash in accounts</dt>
          <dd className="text-right tabular-nums">{formatBaht(headline.cash)}</dd>
          <dt className="text-muted-foreground">− Card bills due</dt>
          <dd className="text-right tabular-nums">{formatBaht(headline.billsDue)}</dd>
          <dt className="text-muted-foreground">− Spent on cards this cycle</dt>
          <dd className="text-right tabular-nums">{formatBaht(headline.thisCycle)}</dd>
        </dl>
        {overdueBills > 0 && (
          <p className="text-xs font-medium text-destructive">
            {overdueBills === 1 ? '1 card bill is' : `${overdueBills} card bills are`} past due
          </p>
        )}
        {pendingReview && pendingReview.length > 0 && (
          <p className="text-xs text-muted-foreground">{formatBaht(pendingReviewTotal)} awaiting review, not counted above.</p>
        )}
        <div className="flex items-baseline justify-between rounded-xl bg-muted/60 px-3 py-2.5 text-sm">
          <span>
            Card debt
            <span className="block text-[11px] text-muted-foreground">incl. future installments</span>
          </span>
          <span className="text-lg font-semibold tabular-nums">{formatBaht(cardDebtTotal)}</span>
        </div>
      </div>

      {/* Between Us holds the only pending action on this screen (Settle
          up) and renders nothing when no one owes anyone, so promoting it
          above the instrument panels costs nothing on a quiet day. */}
      <BetweenUsSection />

      {/* grid-cols-1 is not redundant: the implicit track is minmax(auto, 1fr),
          which grows to a card row's unwrapped secondary line and made the
          whole tab scroll sideways on a phone. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ownerGroups.map((g) => {
          const member = members.find((m) => m.id === g.ownerId)
          const groupAccounts = ownedAccounts.filter((a) => a.owner_id === g.ownerId)
          const groupCards = ownedCards.filter((c) => c.owner_id === g.ownerId)
          const position = cashPosition(groupAccounts, groupCards)
          return (
            <InstrumentPanel
              key={g.ownerId}
              title={
                <>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: member?.color ?? 'currentColor' }} />
                  <span className="truncate">
                    {member?.display_name ?? 'Former member'}
                    {g.ownerId === self.id && members.length > 1 ? ' (you)' : ''}
                  </span>
                </>
              }
              // Filtered to one person this would only repeat the headline.
              total={person === 'all' ? position.afterCards : null}
              footer={panelFooter(position)}
            >
              {groupAccounts.map(accountRow)}
              {groupCards.map(cardRow)}
            </InstrumentPanel>
          )
        })}
        {hasPot && (
          <InstrumentPanel
            title="Common pot"
            total={cashPosition(potAccounts, potCards).afterCards}
            footer={panelFooter(cashPosition(potAccounts, potCards))}
          >
            {potAccounts.map(accountRow)}
            {potCards.map(cardRow)}
          </InstrumentPanel>
        )}
        {ownerGroups.length === 0 && !hasPot && (
          <p className="px-1 text-sm text-muted-foreground">No accounts or cards yet.</p>
        )}
      </div>

      {editingAccount && (
        <AccountDialog
          key={editingAccount === 'new' ? 'new-account' : editingAccount.id}
          account={editingAccount === 'new' ? null : editingAccount}
          onClose={() => setEditingAccount(null)}
        />
      )}
      {editingCard && (
        <CardDialog
          key={editingCard === 'new' ? 'new-card' : editingCard.id}
          card={editingCard === 'new' ? null : editingCard}
          onClose={() => setEditingCard(null)}
        />
      )}
      {deleting && <DeleteInstrumentDialog target={deleting} onClose={() => setDeleting(null)} />}
      {reconciling && (
        <ReconcileDialog
          account={reconciling}
          currentBalance={accountBalance(reconciling, allTxns, today)}
          categories={categories ?? []}
          onClose={() => setReconciling(null)}
        />
      )}
    </div>
  )
}

function InstrumentPanel({
  title,
  total,
  footer,
  children,
}: {
  title: ReactNode
  total: number | null
  footer: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col rounded-2xl bg-card p-4 ring-1 ring-border">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">{title}</h2>
        {total !== null && (
          <span className={cn('text-xl font-semibold tracking-tight tabular-nums', total < 0 && 'text-destructive')}>
            {formatBaht(total)}
          </span>
        )}
      </div>
      <ul className="mt-3 space-y-0.5">{children}</ul>
      <span className="mt-auto pt-3 text-xs tabular-nums text-muted-foreground">{footer}</span>
    </section>
  )
}

function RowMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void; destructive?: boolean }[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label={`More for ${label}`}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onSelect={item.onSelect} variant={item.destructive ? 'destructive' : 'default'}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountRow({
  account,
  balance,
  lastConfirmedDate,
  onOpen,
  onEdit,
  onReconcile,
  onDelete,
}: {
  account: Account
  balance: number
  lastConfirmedDate: string | null
  onOpen: () => void
  onEdit: () => void
  onReconcile: () => void
  onDelete: () => void
}) {
  // A quiet signal, not a second figure — only shown once a reading is
  // genuinely old, and it qualifies the balance already there.
  const staleDays = lastConfirmedDate ? differenceInCalendarDays(new Date(), parse(lastConfirmedDate, 'yyyy-MM-dd', new Date())) : null
  const isStale = staleDays !== null && staleDays >= STALE_AFTER_DAYS
  const Icon = ACCOUNT_ICON[account.type]

  return (
    <li>
      <SwipeableRow onDelete={onDelete}>
        <div className="flex items-center gap-2.5 py-1.5 text-sm">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
            <Icon className="size-4" />
          </span>
          <button onClick={onOpen} disabled={account.archived} className="min-w-0 flex-1 text-left">
            <span className={cn('block truncate', account.archived && 'text-muted-foreground line-through')}>{account.name}</span>
            {isStale && <span className="block text-[11px] text-muted-foreground">Not confirmed in {staleDays} days</span>}
          </button>
          <span className="tabular-nums">{formatBaht(balance)}</span>
          <RowMenu
            label={account.name}
            items={[
              { label: 'Reconcile', onSelect: onReconcile },
              { label: 'Edit', onSelect: onEdit },
              { label: 'Delete', onSelect: onDelete, destructive: true },
            ]}
          />
        </div>
      </SwipeableRow>
    </li>
  )
}

function CardRow({
  card,
  bill,
  dueDate,
  outstanding,
  leftToPay,
  nextStatement,
  onOpen,
  onEdit,
  onDelete,
}: {
  card: Card
  // §6.3c/ADR-0012: the row's own question is "what's due next" — the
  // closed cycle's bill and its due date. Credit used / available / limit
  // are one tap away in the expanded details (ADR-0023).
  bill: number
  dueDate: string
  outstanding: number
  leftToPay: number
  nextStatement: string
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const used = Math.max(0, outstanding)
  const usedPct = card.credit_limit > 0 ? Math.min(100, Math.round((used / card.credit_limit) * 100)) : 0
  const paid = Math.max(0, bill - leftToPay)

  return (
    <li>
      <SwipeableRow onDelete={onDelete}>
        {/* Opaque and padded rather than margined: SwipeableRow's delete
            layer sits behind and would show through any gap. */}
        <div className={cn('bg-card', open && 'pb-2')}>
          <div className="flex items-center gap-2.5 py-1.5 text-sm">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning text-warning-foreground">
              <CreditCard className="size-4" />
            </span>
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 text-left">
              <span className={cn('truncate', card.archived && 'text-muted-foreground line-through')}>{card.name}</span>
              <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </button>
            {bill <= 0 ? (
              <span className="text-xs text-muted-foreground">Nothing due</span>
            ) : leftToPay === 0 ? (
              <span className="text-right leading-tight">
                <span className="block tabular-nums text-muted-foreground line-through">{formatBaht(bill)}</span>
                <span className="block text-[11px] text-good">Paid</span>
              </span>
            ) : (
              <span className="text-right leading-tight">
                <span className="block tabular-nums">{formatBaht(leftToPay)}</span>
                {dueDate < todayIso() ? (
                  <span className="block text-[11px] font-medium text-destructive">past due · {dayMonthLabel(dueDate)}</span>
                ) : (
                  <span className="block text-[11px] text-muted-foreground">due {dayMonthLabel(dueDate)}</span>
                )}
              </span>
            )}
            <RowMenu
              label={card.name}
              items={[
                { label: 'Edit', onSelect: onEdit },
                { label: 'Delete', onSelect: onDelete, destructive: true },
              ]}
            />
          </div>
          {open && (
            <div className="ml-10.5 space-y-3 rounded-xl bg-muted/50 p-3 text-sm">
              <dl className="grid grid-cols-2 gap-3">
                <CardFact
                  label={`Payment due ${dayMonthLabel(dueDate)}`}
                  value={formatBaht(bill)}
                  sub={paid > 0 && leftToPay > 0 ? `${formatBaht(paid)} paid · ${formatBaht(leftToPay)} to go` : undefined}
                />
                <CardFact label="Next statement" value={dayMonthLabel(nextStatement)} />
              </dl>
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                  <span>Credit used {usedPct}%</span>
                  <span className="tabular-nums">{formatBaht(used)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  {/* Red only near the limit — tomato is also the primary colour,
                      so a red bar at any level would read as a warning. */}
                  <div
                    className={cn('h-full rounded-full', usedPct > 90 ? 'bg-destructive' : 'bg-foreground/50')}
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-3">
                <CardFact label="Available credit" value={formatBaht(card.credit_limit - used)} />
                <CardFact label="Credit limit" value={formatBaht(card.credit_limit)} />
              </dl>
              {!card.archived && (
                <button onClick={onOpen} className="text-xs font-medium text-primary">
                  Open card →
                </button>
              )}
            </div>
          )}
        </div>
      </SwipeableRow>
    </li>
  )
}

function CardFact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
      {sub && <dd className="text-[11px] text-muted-foreground">{sub}</dd>}
    </div>
  )
}

// Shared by both dialogs below: once a balance difference is known, ask
// whether it's really something that happened (files under the household's
// ordinary "Other" category, so it reads like any other transaction) or
// just a correction (files under "Modified Bal", excluded from the picker,
// Records and every rollup — visible only on the account's own screen).
// Both answers create a real Transaction; only the category differs.
function BalanceAdjustmentStep({
  diff,
  onAnswer,
  pending,
}: {
  diff: number
  onAnswer: (visible: boolean) => void
  pending: boolean
}) {
  const kind = diff > 0 ? 'income' : 'expense'
  return (
    <>
      <DialogHeader>
        <DialogTitle>{formatBaht(Math.abs(diff))} unaccounted for</DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">
        Is this really {kind === 'income' ? 'income' : 'an expense'} — something that actually happened — or just a
        correction?
      </p>
      <DialogFooter className="flex-col gap-2 sm:flex-col">
        <Button className="w-full" onClick={() => onAnswer(true)} disabled={pending}>
          Yes, record it as {kind}
        </Button>
        <Button variant="outline" className="w-full" onClick={() => onAnswer(false)} disabled={pending}>
          No, just adjust the balance
        </Button>
      </DialogFooter>
    </>
  )
}

// A new account asks for a starting balance (Money Manager's pattern this
// whole feature is modelled on): pressing Save creates the account, and if
// that balance is non-zero, BalanceAdjustmentStep asks the same yes/no
// question Reconcile below does before recording it.
function AccountDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { householdId, self } = useHousehold()
  const { data: categories } = useCategories(householdId)
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank')
  const [ownerId, setOwnerId] = useState<string | null>(account?.owner_id ?? null)
  const [startingBalance, setStartingBalance] = useState('0')
  const [startingDate, setStartingDate] = useState(todayIso())
  const [archived, setArchived] = useState(account?.archived ?? false)
  const [newAccountId, setNewAccountId] = useState<string | null>(null)
  const create = useCreateAccount(householdId)
  const update = useUpdateAccount(householdId)
  const createTransaction = useCreateTransaction(householdId)

  async function handleSave() {
    if (account) {
      await update.mutateAsync({ id: account.id, name, type, owner_id: ownerId, archived })
      onClose()
      return
    }
    const id = await create.mutateAsync({ name, type, ownerId })
    if (Number(startingBalance) === 0) {
      onClose()
      return
    }
    setNewAccountId(id)
  }

  async function handleAdjustmentAnswer(visible: boolean) {
    if (!newAccountId || !categories) return
    const diff = Number(startingBalance)
    const category = adjustmentCategory(categories, diff > 0 ? 'income' : 'expense', visible)
    if (!category) {
      toast.error('Missing the "Other"/"Modified Bal" category for this household.')
      onClose()
      return
    }
    await createTransaction.mutateAsync({
      date: startingDate,
      kind: diff > 0 ? 'income' : 'expense',
      categoryId: category.id,
      categoryKind: category.kind,
      description: '',
      amount: Math.abs(diff),
      ownerId: self.id,
      fromAccountId: newAccountId,
      fromCardId: null,
      toAccountId: null,
      toCardId: null,
      note: 'Difference',
      source: 'reconcile',
    })
    onClose()
  }

  if (newAccountId) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <BalanceAdjustmentStep
            diff={Number(startingBalance)}
            onAnswer={handleAdjustmentAnswer}
            pending={createTransaction.isPending}
          />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? 'Edit account' : 'New account'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="account-name">Name</Label>
            <Input id="account-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as AccountType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bank">Bank</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="ewallet">E-wallet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Owner</Label>
            <OwnerSelect value={ownerId} onChange={setOwnerId} />
          </div>
          {!account && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="account-balance">Starting balance</Label>
                <Input
                  id="account-balance"
                  type="number"
                  inputMode="decimal"
                  value={startingBalance}
                  onChange={(e) => setStartingBalance(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="account-date">As of</Label>
                <DateField id="account-date" value={startingDate} onChange={setStartingDate} />
              </div>
            </div>
          )}
          {account && (
            <div className="flex items-center justify-between">
              <Label htmlFor="account-archived">Archived</Label>
              <Switch id="account-archived" checked={archived} onCheckedChange={setArchived} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || create.isPending || update.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Reconcile: type what the bank says, and if it disagrees with what the
// ledger computed, BalanceAdjustmentStep asks the same yes/no question
// account creation does before recording the difference.
function ReconcileDialog({
  account,
  currentBalance,
  categories,
  onClose,
}: {
  account: Account
  currentBalance: number
  categories: Category[]
  onClose: () => void
}) {
  const { householdId, self } = useHousehold()
  const [reading, setReading] = useState(String(currentBalance))
  const [diff, setDiff] = useState<number | null>(null)
  const createTransaction = useCreateTransaction(householdId)

  function handleContinue() {
    const d = Number(reading) - currentBalance
    if (d === 0) {
      toast.info('Already matches — nothing to record.')
      onClose()
      return
    }
    setDiff(d)
  }

  async function handleAdjustmentAnswer(visible: boolean) {
    if (diff === null) return
    const category = adjustmentCategory(categories, diff > 0 ? 'income' : 'expense', visible)
    if (!category) {
      toast.error('Missing the "Other"/"Modified Bal" category for this household.')
      onClose()
      return
    }
    await createTransaction.mutateAsync({
      date: todayIso(),
      kind: diff > 0 ? 'income' : 'expense',
      categoryId: category.id,
      categoryKind: category.kind,
      description: '',
      amount: Math.abs(diff),
      ownerId: self.id,
      fromAccountId: account.id,
      fromCardId: null,
      toAccountId: null,
      toCardId: null,
      note: 'Difference',
      source: 'reconcile',
    })
    toast.success(`Reconciled "${account.name}"`)
    onClose()
  }

  if (diff !== null) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <BalanceAdjustmentStep diff={diff} onAnswer={handleAdjustmentAnswer} pending={createTransaction.isPending} />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconcile "{account.name}"</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reconcile-balance">What does the bank app say right now?</Label>
          <Input
            id="reconcile-balance"
            type="number"
            inputMode="decimal"
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleContinue}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CardDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const { householdId } = useHousehold()
  const [name, setName] = useState(card?.name ?? '')
  const [creditLimit, setCreditLimit] = useState(String(card?.credit_limit ?? '0'))
  const [statementDay, setStatementDay] = useState(String(card?.statement_day ?? '1'))
  const [dueDay, setDueDay] = useState(String(card?.due_day ?? '1'))
  const [interestRate, setInterestRate] = useState(String(card?.annual_interest_rate ?? '0'))
  const [ownerId, setOwnerId] = useState<string | null>(card?.owner_id ?? null)
  const [archived, setArchived] = useState(card?.archived ?? false)
  const create = useCreateCard(householdId)
  const update = useUpdateCard(householdId)

  async function handleSave() {
    const payload = {
      name,
      creditLimit: Number(creditLimit),
      statementDay: Number(statementDay),
      dueDay: Number(dueDay),
      annualInterestRate: Number(interestRate),
      ownerId,
    }
    if (card) {
      await update.mutateAsync({
        id: card.id,
        name: payload.name,
        credit_limit: payload.creditLimit,
        statement_day: payload.statementDay,
        due_day: payload.dueDay,
        annual_interest_rate: payload.annualInterestRate,
        owner_id: payload.ownerId,
        archived,
      })
    } else {
      await create.mutateAsync(payload)
    }
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{card ? 'Edit card' : 'New card'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="card-name">Name</Label>
            <Input id="card-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-limit">Credit limit</Label>
            <Input id="card-limit" type="number" inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="card-statement">Statement day</Label>
              <Input
                id="card-statement"
                type="number"
                min={1}
                max={31}
                value={statementDay}
                onChange={(e) => setStatementDay(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="card-due">Due day</Label>
              <Input id="card-due" type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="card-rate">Annual interest rate (%)</Label>
            <Input
              id="card-rate"
              type="number"
              inputMode="decimal"
              value={interestRate}
              onChange={(e) => setInterestRate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Owner</Label>
            <OwnerSelect value={ownerId} onChange={setOwnerId} />
          </div>
          {card && (
            <div className="flex items-center justify-between">
              <Label htmlFor="card-archived">Archived</Label>
              <Switch id="card-archived" checked={archived} onCheckedChange={setArchived} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || create.isPending || update.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Deleting an account or card asks what should happen to its transactions,
 * because both answers are reasonable and destroy different things: a
 * mistyped account should take its rows with it, while a bank you've closed
 * has real history worth keeping. Kept rows still show the old name (see
 * useInstrumentNames), so "keep" doesn't quietly anonymise them.
 */
function DeleteInstrumentDialog({
  target,
  onClose,
}: {
  target: { kind: InstrumentKind; id: string; name: string }
  onClose: () => void
}) {
  const { householdId } = useHousehold()
  const { data: usage, isPending } = useInstrumentUsage(target.kind, target.id)
  const remove = useDeleteInstrument(householdId)
  const [withTransactions, setWithTransactions] = useState(false)

  const blocked = usage != null && isInstrumentBlocked(usage)
  const noun = target.kind === 'account' ? 'account' : 'card'

  async function handleDelete() {
    if (!usage) return
    await remove.mutateAsync({ kind: target.kind, id: target.id, withTransactions, usage })
    toast.success(
      withTransactions
        ? `Deleted "${target.name}" and ${usage.transactions} transaction${usage.transactions === 1 ? '' : 's'}`
        : `Deleted "${target.name}"`,
    )
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {noun} "{target.name}"?</DialogTitle>
        </DialogHeader>

        {isPending || !usage ? (
          <p className="text-sm text-muted-foreground">Checking what uses it…</p>
        ) : blocked ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-destructive">This {noun} is still scheduled to be used.</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {usage.recurringRules > 0 && (
                <li>
                  {usage.recurringRules} recurring rule{usage.recurringRules === 1 ? '' : 's'}
                </li>
              )}
              {usage.installments > 0 && (
                <li>
                  {usage.installments} installment plan{usage.installments === 1 ? '' : 's'}
                </li>
              )}
            </ul>
            <p className="text-muted-foreground">
              They would keep creating transactions against {target.kind === 'account' ? 'an' : 'a'} {noun} that no
              longer exists. Delete or repoint them first, then come back.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {usage.transactions === 0
                ? `Nothing is recorded against this ${noun}.`
                : `${usage.transactions} transaction${usage.transactions === 1 ? '' : 's'} reference${usage.transactions === 1 ? 's' : ''} it.`}
            </p>
            {usage.transactions > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setWithTransactions(false)}
                  className={cn(
                    'w-full rounded-lg border p-3 text-left',
                    !withTransactions ? 'border-primary bg-primary/5' : 'border-border',
                  )}
                >
                  <span className="block font-medium">Keep the transactions</span>
                  <span className="block text-xs text-muted-foreground">
                    History stays in reports and still shows "{target.name}".
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setWithTransactions(true)}
                  className={cn(
                    'w-full rounded-lg border p-3 text-left',
                    withTransactions ? 'border-destructive bg-destructive/5' : 'border-border',
                  )}
                >
                  <span className="block font-medium text-destructive">Delete them too</span>
                  <span className="block text-xs text-muted-foreground">
                    Removes {usage.transactions} record{usage.transactions === 1 ? '' : 's'} from every total.
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={blocked || isPending || remove.isPending}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
