# Balances rows answer what is due next, not what is left to spend

> **Amended by [ADR-0023](./0023-balances-leads-with-cash-after-card-spending.md)** (2026-10): owed/left
> move off the row into tap-to-expand details, worded as credit used, available
> credit and credit limit. The row still leads with the closed bill and its due date.

[CONTEXT.md](../../CONTEXT.md) opens by naming the three questions this app exists
to answer. The second — *how much cash to set aside before each credit card's
bill is due* — had no home on any screen. Balances is the "right now" tab
(§7.3), and a bill whose cycle has closed is an obligation that exists right
now, so that is where it belongs.

A card row therefore leads with its most recently closed **Cycle Bill** and the
date it falls due; what it owes in total and what limit remains drop to a
secondary line. The **Accounts** section totals the money held; the **Credit
cards** section totals **Set Aside** — the part of those closed bills not yet
paid. Read as a pair, the two totals answer the question: *this is what we have,
this is what is already spoken for.*

This supersedes [ADR-0008](./0008-balances-shows-capacity-per-row-and-net-worth-in-the-headline.md)'s
rule that every row answers "how much can I still use?". The rest of ADR-0008
stands unchanged, and one part of it gets stronger: **available credit is still
never summed anywhere**, and now it is not even the row's headline figure.

A payment settles the Cycle that had most recently closed when it was made.
Bills fall due only *after* their cycle closes, so the money that clears one
almost never falls inside it.

## Considered Options

**Keeping capacity as the row's question, and adding a section total for it.**
Rejected on ADR-0008's own grounds — summing available credit is the number that
decision exists to prevent, and it would have been the natural total for a
section whose rows all read "฿38,000 left".

**Totalling `cardOutstanding` instead.** Rejected, and this is the sharper trap.
Outstanding is deliberately *not* bounded by today ([ADR-0001](./0001-installments-post-ahead-recurring-does-not.md):
the debt exists in full from day one and the issuer blocks the limit for all of
it), which is correct for a question about capacity and wrong for a question
about cash. A card carrying an installment plan can read "฿12,000 owed" while
the bill it will actually present next is ฿3,000. A household setting aside
฿12,000 has over-provisioned by four times, on a number the screen presented as
authoritative.

**Leaving the question to Upcoming.** Rejected: it splits one question across
two tabs. The boundary that does hold is *closed versus still moving* — a bill
whose cycle has closed cannot change and is Balances', while everything still
accumulating or merely projected is Upcoming's. `CardForecastTab` keeps showing
the current month; the two screens compute it from the same `cycleBill`, so a
figure appearing at two scales is continuity, not duplication.

**Attributing a payment to the cycle whose window it falls inside.** Rejected —
this is what the code already did, and it is why `CardCycleSummary` could show
"฿0 paid" on a bill that had been settled in full. Because due dates land after
their cycle closes, a payment lands in the *following* cycle's window nearly
every time, so the figure labelled "paid" on cycle N was in practice the money
that cleared cycle N−1.

## Consequences

**Balances has to load what `cycleBill` needs.** It fetched only transactions;
it now also needs installments, posted periods, cycle adjustments and recurring
rules. These are the same React Query keys the Plan tab already populates, so
the cost lands only on a cold cache — but it is four queries on a screen that
had one, and that is a real change to the app's cheapest tab.

**Balances and Upcoming cannot disagree.** Both go through `cycleBill`, so the
figure on the Balances card row and the current-month row of `CardForecastTab`
are the same computation, not two implementations that have to be kept in step.

**`paidSoFar` changes meaning**, and existing screens that render it change with
it. This is a fix rather than a migration — no stored data is affected, because
the attribution was always derived.

**`cycleBill` alone is still not Set Aside.** It reports what a cycle charged
and deliberately excludes payments; the unpaid remainder is a separate step on
top of it. Anything that treats the two as interchangeable will overstate what
the household needs.
