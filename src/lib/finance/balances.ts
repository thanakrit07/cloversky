// Balances (DESIGN.md §6.3b, D19, ADR-0008): what each row on the Balances
// screen shows (capacity) and what the headline shows (net worth). Kept
// separate from billingCycle.ts because the two figures deliberately use
// different time windows — see the account/card asymmetry below.

import { addDays, closedCycleAsOf, cycleBill, cycleOf, type InstallmentLike } from './billingCycle.ts'

export interface AccountLike {
  id: string
  owner_id: string | null
  anchor_balance: number
  anchor_date: string // yyyy-MM-dd
}

export interface CardLike {
  id: string
  owner_id: string | null
  credit_limit: number
  statement_day: number
  due_day: number
}

export interface TransactionLike {
  kind: 'income' | 'expense' | 'transfer'
  date: string // yyyy-MM-dd
  amount: number
  confirmed: boolean
  from_account_id: string | null
  from_card_id: string | null
  to_account_id: string | null
  to_card_id: string | null
}

export interface DebtLike {
  owes_member_id: string
  owed_member_id: string
  amount: number
}

// ADR-0013: an anchor is a log, not a column. `AccountLike.anchor_balance` /
// `anchor_date` are the *newest* anchor's baseline — callers (useAccounts)
// pick it with `newestAnchor` before handing the account to this function,
// so this function's own logic is unchanged from when those two fields were
// a raw column.
export interface AccountAnchorLike {
  account_id: string
  reading_balance: number
  reading_date: string // yyyy-MM-dd — what the household asserted
  baseline_balance: number
  baseline_date: string // yyyy-MM-dd — what accountBalance actually consumes
  created_at: string // ISO timestamp — the only field guaranteed to differ
  // between two reconciles made on the same day, where baseline_date and
  // reading_date are both derived from "today" and so land identical.
}

// The anchor `accountBalance` should start from: the one with the latest
// baseline_date. Reconciling twice in one day gives baseline_date AND
// reading_date the same value on both rows (both derive from "today"), so
// those two ties resolve nothing — created_at is the final, always-unique
// tiebreaker.
export function newestAnchor(anchors: AccountAnchorLike[], accountId: string): AccountAnchorLike | null {
  let newest: AccountAnchorLike | null = null
  for (const a of anchors) {
    if (a.account_id !== accountId) continue
    if (
      !newest ||
      a.baseline_date > newest.baseline_date ||
      (a.baseline_date === newest.baseline_date && a.reading_date > newest.reading_date) ||
      (a.baseline_date === newest.baseline_date && a.reading_date === newest.reading_date && a.created_at > newest.created_at)
    ) {
      newest = a
    }
  }
  return newest
}

// ADR-0013: a Transaction carries a date but no time, so a reading taken
// partway through today can't be compared against "everything up to today"
// without either swallowing what gets recorded later today or double
// counting what was recorded earlier today. Storing the close of the day
// *before* the reading sidesteps the question instead of picking a wrong
// answer to it: every one of today's transactions — confirmed before the
// reconcile or after it — applies on top of this baseline exactly once.
export function anchorBaseline(
  accountId: string,
  readingBalance: number,
  readingDate: string,
  transactions: TransactionLike[],
): { baselineBalance: number; baselineDate: string } {
  let todaysNet = 0
  for (const t of transactions) {
    if (!t.confirmed || t.date !== readingDate) continue
    if (t.kind === 'income' && t.from_account_id === accountId) todaysNet += t.amount
    else if (t.kind === 'expense' && t.from_account_id === accountId) todaysNet -= t.amount
    else if (t.kind === 'transfer') {
      if (t.to_account_id === accountId) todaysNet += t.amount
      if (t.from_account_id === accountId) todaysNet -= t.amount
    }
  }
  return { baselineBalance: readingBalance - todaysNet, baselineDate: addDays(readingDate, -1) }
}

// §6.3: anchor + everything since, confirmed rows only. Bounded by `today`
// (D19) — an installment period dated next month hasn't left the account yet,
// even though it already exists as a posted transaction (ADR-0001).
export function accountBalance(account: AccountLike, transactions: TransactionLike[], today: string): number {
  let balance = account.anchor_balance
  for (const t of transactions) {
    if (!t.confirmed || t.date <= account.anchor_date || t.date > today) continue
    if (t.kind === 'income' && t.from_account_id === account.id) balance += t.amount
    else if (t.kind === 'expense' && t.from_account_id === account.id) balance -= t.amount
    else if (t.kind === 'transfer') {
      if (t.to_account_id === account.id) balance += t.amount
      if (t.from_account_id === account.id) balance -= t.amount
    }
  }
  return balance
}

// D19/ADR-0008: every charge minus every payment, confirmed rows only, with
// NO date ceiling — unlike an account, a card's debt exists in full the
// moment an installment plan starts (ADR-0001), and the issuer has already
// blocked the limit for periods dated months from now. This single running
// total is mathematically the same figure §6.2 built from three parts (the
// current cycle, carried balance, and future installment charges), because
// every installment period — past, current or future — already exists as a
// real posted transaction; there is nothing left to add on top of the sum.
export function cardOutstanding(card: CardLike, transactions: TransactionLike[]): number {
  let owed = 0
  for (const t of transactions) {
    if (!t.confirmed) continue
    if (t.kind === 'expense' && t.from_card_id === card.id) owed += t.amount
    else if (t.kind === 'transfer') {
      if (t.from_card_id === card.id) owed += t.amount // cash advance / moved off the card
      if (t.to_card_id === card.id) owed -= t.amount // a bill payment
    }
  }
  return owed
}

export function creditAvailable(card: CardLike, transactions: TransactionLike[]): number {
  return card.credit_limit - cardOutstanding(card, transactions)
}

// §6.3c/ADR-0012: the cash a card's most recently closed bill still needs,
// not what it owes in total (cardOutstanding, deliberately unbounded) or
// what it charged (cycleBill, deliberately excludes payments). An open
// cycle is never counted — nothing about it is due yet, so a card between
// statements contributes ฿0 here even though it already owes something.
//
// `installments` and `postedPeriods` should already be filtered/scoped the
// way every other cycleBill caller does (CardCycleSummary, CardForecastTab):
// installments to this card's active plans, postedPeriods household-wide.
// No `recurringRules` — the closed cycle is entirely in the past, so
// anything recurring inside it has already materialised into a real
// transaction; projecting it again would double it.
export function setAside(
  card: CardLike,
  transactions: TransactionLike[],
  installments: InstallmentLike[],
  postedPeriods: ReadonlySet<string>,
  adjustment: number | null,
  today: string,
): number {
  const { bill, paid } = closedBillAndPaid(card, transactions, installments, postedPeriods, adjustment, today)
  return Math.max(0, bill - paid)
}

// ADR-0023: what a card has charged in its still-open cycle up to today —
// spending that has already happened but is on no bill yet, so Set Aside
// can't see it. Together they are every baht of card spending the cash in
// the accounts still has to cover, without the future installment periods
// cardOutstanding carries (ADR-0001). A payment larger than the closed bill
// is read as paying this cycle down early.
export function spentThisCycle(
  card: CardLike,
  transactions: TransactionLike[],
  installments: InstallmentLike[],
  postedPeriods: ReadonlySet<string>,
  closedAdjustment: number | null,
  openAdjustment: number | null,
  today: string,
): number {
  const { bill, paid } = closedBillAndPaid(card, transactions, installments, postedPeriods, closedAdjustment, today)
  const cardTxns = transactions.filter((t) => (t.from_card_id === card.id || t.to_card_id === card.id) && t.date <= today)
  const charged = cycleBill({
    cycle: cycleOf(card, today),
    cardId: card.id,
    transactions: cardTxns,
    installments,
    adjustment: openAdjustment,
    postedPeriods,
  })
  return Math.max(0, charged - Math.max(0, paid - bill))
}

function closedBillAndPaid(
  card: CardLike,
  transactions: TransactionLike[],
  installments: InstallmentLike[],
  postedPeriods: ReadonlySet<string>,
  adjustment: number | null,
  today: string,
): { bill: number; paid: number } {
  const closed = closedCycleAsOf(card, today)
  const cardTxns = transactions.filter((t) => t.from_card_id === card.id || t.to_card_id === card.id)
  const bill = cycleBill({ cycle: closed, cardId: card.id, transactions: cardTxns, installments, adjustment, postedPeriods })
  const paid = transactions
    .filter((t) => t.confirmed && t.kind === 'transfer' && t.to_card_id === card.id)
    .filter((t) => t.date > closed.end && t.date <= today)
    .reduce((sum, t) => sum + t.amount, 0)
  return { bill, paid }
}

// D19: money − card debt + what others owe this member − what this member
// owes others. Inter-member debts cancel across the household, which is
// what keeps memberNetWorth(A) + memberNetWorth(B) === householdNetWorth
// true (ADR-0008) — a Common Pot (D18) is deliberately not part of this: it
// belongs to no one member, so it is never folded into anyone's figure.
export function memberNetWorth(
  memberId: string,
  accounts: AccountLike[],
  cards: CardLike[],
  transactions: TransactionLike[],
  debts: DebtLike[],
  today: string,
): number {
  let worth = 0
  for (const a of accounts) {
    if (a.owner_id === memberId) worth += accountBalance(a, transactions, today)
  }
  for (const c of cards) {
    if (c.owner_id === memberId) worth -= cardOutstanding(c, transactions)
  }
  for (const d of debts) {
    if (d.owed_member_id === memberId) worth += d.amount
    if (d.owes_member_id === memberId) worth -= d.amount
  }
  return worth
}

// A Common Pot's balance: the accounts/cards with no owner, at face value —
// D18 gives it no per-person breakdown, so this is simply reported, never
// added into anyone's net worth or the household net-worth sum.
export function commonPotBalance(accounts: AccountLike[], cards: CardLike[], transactions: TransactionLike[], today: string): number {
  let total = 0
  for (const a of accounts) {
    if (a.owner_id === null) total += accountBalance(a, transactions, today)
  }
  for (const c of cards) {
    if (c.owner_id === null) total -= cardOutstanding(c, transactions)
  }
  return total
}
