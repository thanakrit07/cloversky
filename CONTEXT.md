# Cloversky

A shared personal-finance app for one household of two people. It answers three
questions: where the money went, how much cash to set aside before each credit
card's bill is due, and who owes whom.

## Language

### People and money holders

**Household**:
The sharing unit. Everything in the app belongs to exactly one.
_Avoid_: family, group, team

**Member**:
A person in the household. Members are the only people money can be attributed
to or owed between.
_Avoid_: user, person, account holder

**Instrument**:
Something money sits in or is charged to — a bank account, cash, an e-wallet,
or a credit card. Every Transaction names the Instrument the money came from.
_Avoid_: payment method, source, wallet

**Owner**:
The Member an Instrument or a Transaction belongs to. On an Instrument the
question it settles is who fronted the money, which is what decides whether a
Debt arises; an Instrument with no Owner is a Common Pot.
_Avoid_: holder, assignee

**Common Pot**:
An Instrument both Members put money into and pay shared costs out of — a joint
account, a joint card. It has no Owner and no per-person breakdown: money moved
into it stops being that Member's individually, and spending out of it creates
no Debt, because nothing was fronted by one person for the other. How much each
has contributed is read back from the Transfers that funded it, never stored as
a balance or a proportion.
_Avoid_: shared account (ambiguous with a Split), joint, kitty

### The ledger

**Transaction**:
A single movement of money that has been recorded — money in, money out, or
money moved between two of the household's own Instruments.
_Avoid_: entry, record, item

**Kind**:
What a Transaction did to the household's total: income, expense, or transfer.
A transfer changes neither total; it only moves value between Instruments.
_Avoid_: type, direction

**Category**:
What a Transaction was for. Two levels: a main heading, optionally broken into
subs that share its Kind. A Transaction that changes the household's total names
exactly one — the most specific one chosen — while a Transfer names none, because
moving money between the household's own Instruments is not spending on anything.
_Avoid_: type (that word already means Kind), tag, bucket, label

**Origin**:
What caused a Transaction to exist: entered by hand, generated from a Recurring
Rule, generated from an Installment Plan, written by a Reconcile, or brought in
by the one-time import of the household's old Google Sheet.
Independent of Kind — a salary is both recurring and income.
_Avoid_: source (that word already means the paying Instrument), reason

**Receipt**:
One payment — or one receipt of money — that the ledger records as more than one
Transaction, because it covered more than one Category. Its Transactions share a
date and an Instrument, since only one payment happened. It holds nothing of its
own but a name: its total is read back from its Transactions, so no figure on it
can disagree with them.
_Avoid_: basket, group, parent transaction, **split** (that word is already the
division between Members)

**Preset**:
One Member's named fill for the entry form: a Kind and a Category, and optionally
a note, an Instrument and an amount. Tapping it fills the form; it never records a
Transaction by itself, and it never decides who bears one.
_Avoid_: template (sounds like a Recurring Rule), favourite, shortcut

### Commitments

**Installment Plan**:
An agreement to pay a fixed sum in a known number of Periods. The debt exists in
full the moment the plan starts, so its Periods are certain and are recorded as
Transactions immediately, including the ones still in the future.
_Avoid_: loan, plan, financing

**Period**:
One numbered payment of an Installment Plan, e.g. "งวดที่ 3/10".
_Avoid_: instalment, month, payment

**Recurring Rule**:
A repeating expectation with no committed end — a salary, a subscription, a
utility bill. Unlike an Installment Plan it can be stopped at any time and its
amount often varies, so future Occurrences are never recorded as Transactions.
_Avoid_: schedule, subscription, standing order

**Occurrence**:
One scheduled date produced by a Recurring Rule.
_Avoid_: instance, event, repeat

**Posted**:
Written into the ledger as a real Transaction. Installment Periods are posted
ahead of time; Recurring Occurrences are posted only once their date arrives.
_Avoid_: created, materialised, generated

**Projected**:
Calculated for display only and never stored — how future Recurring Occurrences
reach screens that look ahead. Posted and Projected are also the two degrees of
certainty a forward-looking screen has to keep apart: a future Installment
Period is Posted and cannot be escaped, while a Recurring Occurrence is an
expectation that can be cancelled tomorrow and rarely costs the same twice.
_Avoid_: forecast, predicted, virtual, **committed** (an Installment Plan is
committed; a Recurring Rule is defined by having no committed end)

### Sharing and debt

**Split**:
How a Transaction's amount is divided between the Members who bear it, which is
a separate question from which Member's Instrument paid for it. Portions need
not be equal. An Installment Plan carries the Split its Periods inherit, and a
Period may depart from it.
_Avoid_: share (ambiguous with a single person's portion), allocation

**Borne**:
The portion of a Transaction a Member carries, which is what "how much did I
spend" means throughout the app. A Member who paid for something but bears none
of it has spent nothing by this measure — the money leaving their Instrument is
a separate question, answered by the Instrument's own screens.
_Avoid_: attributed, charged, assigned

**Debt**:
An amount one Member bears on a Transaction that another Member's Instrument
paid for. It covers both halves of a shared cost and a personal cost put on
someone else's card. Always between two Members — what is owed to a bank on a
card is the card Owner's alone and is never divided this way.
_Avoid_: loan, IOU, balance

**Net Worth**:
What a Member is worth: their Instruments' money, minus what their cards owe,
plus the Debts owed to them, minus the Debts they owe. Because Debts between
Members cancel out, the two people's Net Worth adds up to the household's. Unused
credit is not part of it — that is spending capacity, which is a different
question and gives a card the opposite sign.
_Avoid_: balance (that is one Instrument's own figure), total

**Cleared**:
Said of a Transaction that has been concluded — its money has left the
Instrument, or the Debt on it has been repaid, or both. Bulk actions on an
Installment Plan leave Cleared Periods untouched; only what is still open or
still in the future is theirs to remove.
_Avoid_: closed, done, paid (paid is only half of it)

**Settlement**:
A repayment that clears one or more Debts. It is an ordinary transfer between
the two Members' Instruments, so the repayment appears in the ledger like any
other movement of money.
_Avoid_: payback, reconciliation, clearing

### Account balances

**Anchor**:
A balance a Member has confirmed against the real world on a given date. An
account's current figure is its newest Anchor plus every Transaction since, so
an Anchor is the only thing an account's number rests on that the ledger did
not produce.
_Avoid_: opening balance, starting balance, snapshot

**Reconcile**:
To make an Instrument's figure agree with what the outside world says, by
entering the real number. On an account this records a new Anchor; on a credit
card it records a signed difference against one Billing Cycle. Anchors
accumulate rather than replace one another, so what the app expected and what
was really there both survive, and the gap between them can be read back.
_Avoid_: sync, correct, adjust, true-up

**Drift**:
The gap an Anchor reveals between the balance the ledger computed and the one
that was really there. It is the symptom of a Transaction nobody recorded, so
it is worth showing rather than absorbing.
_Avoid_: discrepancy, error, variance

### Credit cards

**Billing Cycle**:
The window between a card's statement days. Card money moves per cycle, not per
calendar month, so every card figure in the app is computed per cycle.
_Avoid_: statement period, month

**Cycle Bill**:
What a card's Billing Cycle actually demands: its charges in that cycle,
adjusted to agree with the real statement. A payment settles the Cycle that had
most recently closed when it was made — bills fall due only after their Cycle
has closed, so the money clearing one almost never falls inside it.
_Avoid_: statement balance, amount due

**Set Aside**:
The cash the household must already have to meet its cards' next bills: each
card's most recently closed Cycle Bill, less whatever has been paid toward it.
A Cycle still open is never counted — nothing about it is due yet — so a card
whose last bill is settled contributes nothing.
_Avoid_: amount due, upcoming, cash needed

**Cash After Card Spending**:
The cash in the household's accounts once every baht already spent on a card is
paid: Set Aside, plus what each card has charged in its still-open Cycle up to
today. Future installment periods are not in it — they are not spending yet —
so it is what is genuinely free right now, and Balances leads with it.
_Avoid_: spendable, free cash, net worth
