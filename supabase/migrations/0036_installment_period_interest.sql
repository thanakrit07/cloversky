-- A card's installment (IPP) bills each period as two statement lines: the
-- principal ("DEMO SOFA 003/006") and the interest ("IPP Interest 003/006").
-- `period_interest` is that second line's amount, flat every period the way
-- Thai card plans charge it. When set, the materialiser posts it as its own
-- transaction beside the period (source_key installment:<id>:<n>:interest),
-- so the ledger reads line for line like the statement and what the plan
-- costs in interest stays visible on its own.
--
-- null keeps every existing plan exactly as it was: its monthly_amount is
-- already everything the period charges, interest included or none.

alter table installments add column period_interest numeric(12,2);
alter table installments add constraint installments_period_interest_nonneg check (period_interest is null or period_interest >= 0);

create or replace view v_installments with (security_invoker = true) as
  select id, household_id, name, category_id, start_date, total_periods, monthly_amount, final_amount,
         card_id, account_id, annual_interest_rate, is_cash_advance, owner_id, note, status,
         created_at, updated_at, updated_by, deleted_at, source_key, split, period_interest
  from installments
  where deleted_at is null;
