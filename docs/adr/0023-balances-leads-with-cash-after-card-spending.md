# Balances leads with cash after card spending

The top of Balances stops showing net worth and shows **Cash After Card
Spending** (CONTEXT.md): cash in the accounts, minus the closed bills not yet
paid (Set Aside), minus what the cards have charged in their still-open cycle up
to today. The sum is written out under the figure, line by line. **Card debt** —
everything owed on the cards, future installment periods included — sits below
it as its own figure. Both honour the person filter.

A card row keeps one figure: the closed bill still to pay and its due date
("Nothing due", or the bill struck through and "Paid", when there is nothing
left). Tapping the card's name expands labelled details in place: payment due
(with paid / to go once partly paid), next statement, credit used as a
percentage and a bar, available credit, and credit limit, with a link into the
card. This amends [ADR-0012](./0012-balances-rows-answer-what-is-due-next.md),
whose secondary line "฿X owed · ฿Y left" truncated on a phone and named its
figures in words the household doesn't use; the UI now says *credit used*,
*available credit* and *credit limit*, as their banks do. The domain terms in
CONTEXT.md are unchanged.

Net worth answered "if every card were cleared today, including installments
not yet billed, where would we stand?" It did not answer either question the
household actually asks of this screen — *is there enough to pay the cards?*
and *how much is really ours to use?* — and it does not move when a bill is
paid, so it gave no feedback on the one action Balances exists to prompt.

## Considered Options

Chosen on the Balances tab from three headers and four card rows
(`prototype/balances-header-card-row` branch).

**Net worth (today's header).** Kept as each person's panel total for now; as
a headline it reads as an alarming negative that nothing on the screen helps
change.

**Cash · bills due · card debt as three equal figures.** Shows everything and
ranks nothing — the reader still has to do the subtraction that is the point.

**Set Aside alone, without the open cycle.** Simpler, but it overstates free
cash by everything swiped since the last statement: that money is already
spent, only not billed.

**Card details always visible, or one switch for all cards.** Always-visible
tiles double each card's height; a page-wide switch opens every card at once.
Per-card expand keeps the row short and the details one tap away.

## Consequences

**A new figure, `spentThisCycle`**, sits beside `setAside` in
`lib/finance/balances.ts` and shares its closed-bill/payment calculation. A
payment larger than the closed bill is read as paying the open cycle down
early, so the two never count the same baht twice.

**What the household will have *next* month is still not on Balances.** That is
a projection — open cycles, installments, recurring costs and income still to
come — and projections belong to Upcoming (ADR-0012's closed-versus-moving
split).

**Every panel uses the same figure.** A person's panel total is their own
Cash After Card Spending and its footer is the same sum in the same words
("cash · bills due · this cycle", zero parts left out), so the panels add up
to the headline. A Common Pot gets the same treatment for its own
instruments and, as before, stays out of the headline. Net worth is no longer
shown anywhere on the screen; `memberNetWorth` and its ADR-0008 definition
remain for whoever needs the figure next.

**A closed bill past its due date and still unpaid says so** — "past due" on
the card row and a count under the headline sum — since Balances exists to
prompt that payment.

**No month-over-month trend yet.** `accountBalance` at a past date reuses the
account's newest anchor, so for any account reconciled since that date it
returns the reading, not what the balance was then. A trend needs a
historical balance built from the anchor history ADR-0013 keeps.
