# Balances shows spending capacity per row and net worth in the headline

> **The headline is superseded by [ADR-0023](./0023-balances-leads-with-cash-after-card-spending.md)** (2026-10):
> Balances now leads with Cash After Card Spending, not net worth. Net worth's
> definition and the per-person panel totals below still stand.
>
> **Partly superseded by [ADR-0012](./0012-balances-rows-answer-what-is-due-next.md)** (v3.9).
> The per-row rule below — that every row answers "how much can I still use?" —
> no longer holds: a card row leads with its most recently closed Cycle Bill and
> due date. Everything else here stands, and the ban on summing available credit
> is stricter now than when it was written.

Every row on Balances answers "how much can I still use?" — an account shows its
money, a credit card shows the limit it has left (alongside what it currently
owes). The headline answers a different question, "how much am I worth?", and is
computed as money minus debt. **Available credit is never added into that
total**: the two questions give a card opposite signs, and only one of them is an
asset.

A card's outstanding balance belongs entirely to the card's Owner and is never
divided by Borne. A person's net worth then adds what the other Member owes them
and subtracts what they owe, which is what keeps the two people's figures summing
to the household's. A Common Pot (ADR-0007) is never folded into anyone's net
worth and always appears as its own line.

## Considered Options

Almost none of this existed. `AccountsScreen` displayed `anchor_balance` raw —
D4's reconcile pattern was never implemented, so the number froze the day it was
typed (§6.3 admits this in the doc itself). Cards displayed only their credit
limit, with no balance of any kind. The one utilisation figure in the app, inside
`CardCycleDialog`, divided a single cycle's charges by the limit rather than
§6.2's "credit used", so it understated how much of the limit was really
committed. A screen named Balances was showing almost no balances.

**Splitting a card's balance by Borne.** If Mint bears ฿500 of a ฿1,000 charge on
Earth's card, show the card as ฿500 each. Rejected: it double counts. Earth owes
the bank the whole ฿1,000 — the bank has never heard of Mint — and Mint's ฿500
is *already* modelled as a Debt to Earth. Counting it again as a share of the
card makes the same ฿500 appear in two places. This is exactly the Fronted vs
Borne distinction CONTEXT.md already draws: Fronted decides what is owed to the
bank, Borne decides what is owed between the two people.

**Leaving inter-member debts out of net worth.** Simpler, and the "Between us"
section already shows them on the same screen. Rejected because it makes the
per-person figure wrong in the very case the previous decision creates: with the
card unsplit, Earth reads as ฿1,000 in the hole when the true position is ฿500.
Including them also restores D14's invariant — inter-member debts net to zero
across the household, so `Earth (−1,000 + 500) + Mint (−500) = −1,000 = All`.
The two people's net worth adds up to the household's only if the debts are in.

**Summing available credit into the headline.** Rejected on the same grounds the
per-row choice was made: "capacity" and "worth" are both legitimate questions,
but a card is `+limit remaining` for the first and `−amount owed` for the second.
Mixing them yields a number that is neither, and treating unused credit as money
you have is precisely the habit a debt-payoff app should not encourage.

## Consequences

**Accounts and cards must be summed over different time ranges, and this is not
a detail.** Installment periods are posted for the whole plan up front
(ADR-0001), so:

* an **account** balance must be bounded by `date <= today` — a period billed to
  an account next March has not left it yet, and an unbounded sum reports a
  balance short by the rest of the plan (the trap §6.3 already warns about);
* a **card**'s outstanding must *not* be bounded — ADR-0001's whole premise is
  that the debt exists in full the moment the plan starts, and the bank blocks
  the limit for all of it. §6.2's `credit used` already says as much by including
  future installment charges.

The same figure therefore cannot be produced by one shared helper for both.

Each card row carries two numbers ("฿12,000 owed · ฿38,000 left") rather than
one. This is deliberate redundancy: the row's own question is capacity, but
showing only the remaining limit would leave the headline's negative term
invisible and unexplainable.

A Common Pot sits outside every net worth figure, including the household's own.
`Earth + Mint = All` holds for the personal figures, and the pot is reported
beside them rather than inside them — so the sum never silently disagrees with
the rows above it, which is the failure mode migration 0023 already leaves a
warning about.
