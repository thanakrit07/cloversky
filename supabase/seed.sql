-- Local dev seed data only (never run against production). Two household
-- members (เอิร์ธ, พลอย) with cards, accounts, categories, and a mix of
-- personal, shared, and borrowed transactions -- exercising both debt_kinds
-- from 0023_shared_expense_views.sql in different settlement states -- so
-- the Overview UI can be tried against realistic data before touching real
-- data. Login for both: password "password123".
--
-- transaction_shares are inserted explicitly below, matching what
-- src/lib/transactionShares.ts's computeShareRows would write for each
-- transaction (0024 -- D13: the application computes and writes the
-- breakdown; nothing in the database infers one from a null owner anymore).

begin;

-- Auth users + identities (minimal columns GoTrue needs for email+password login).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-0000000000e1',
   'authenticated', 'authenticated', 'earth@example.com',
   extensions.crypt('password123', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(),
   '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-0000000000e2',
   'authenticated', 'authenticated', 'ploy@example.com',
   extensions.crypt('password123', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(),
   '', '', '', '', false, false);

insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values
  ('10000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-0000000000e1',
   '{"sub":"10000000-0000-0000-0000-0000000000e1","email":"earth@example.com"}', 'email', now(), now(), now()),
  ('10000000-0000-0000-0000-0000000000e2', '10000000-0000-0000-0000-0000000000e2',
   '{"sub":"10000000-0000-0000-0000-0000000000e2","email":"ploy@example.com"}', 'email', now(), now(), now());

-- Household + members
insert into households (id, name) values
  ('10000000-0000-0000-0000-000000000000', 'บ้านทดสอบ');

insert into household_members (id, household_id, user_id, display_name, color) values
  ('10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000000',
   '10000000-0000-0000-0000-0000000000e1', 'เอิร์ธ', '#3b82f6'),
  ('10000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000000',
   '10000000-0000-0000-0000-0000000000e2', 'พลอย', '#f97316');

-- One card per person (ownership convention: owner_id = a member, or null
-- meaning shared -- see 0002_accounts_cards_categories.sql).
insert into cards (id, household_id, name, credit_limit, statement_day, due_day, owner_id) values
  ('10000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000000',
   'บัตรเครดิต •• 4821', 50000, 20, 5, '10000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000000',
   'บัตรเครดิต •• 9053', 30000, 15, 3, '10000000-0000-0000-0000-0000000000a2'),
  -- Named the way the statement reader expects (LAYOUT_INSTRUMENTS in
  -- StatementPdfSource.tsx), so a CardX or KTC PDF can be imported locally.
  ('10000000-0000-0000-0000-0000000000c3', '10000000-0000-0000-0000-000000000000',
   'CardX', 80000, 23, 13, '10000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-0000000000c4', '10000000-0000-0000-0000-000000000000',
   'KTC', 60000, 25, 15, '10000000-0000-0000-0000-0000000000a1');

-- One bank account per person -- transfers, including repayments, move
-- money between these (0003_transactions_and_recurring_rules.sql).
insert into accounts (id, household_id, name, type, owner_id, anchor_balance, anchor_date) values
  ('10000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000000',
   'บัญชีธนาคาร เอิร์ธ', 'bank', '10000000-0000-0000-0000-0000000000a1', 20000, '2026-07-01'),
  ('10000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-000000000000',
   'บัญชีธนาคาร พลอย', 'bank', '10000000-0000-0000-0000-0000000000a2', 15000, '2026-07-01');

-- ADR-0013: the app reads an account's balance from account_anchors, not
-- from the accounts.anchor_balance/anchor_date columns above -- those exist
-- only so 0027_account_anchors.sql's backfill has something to read when it
-- runs against a *real*, already-populated database. On a fresh local reset,
-- migrations always apply before this seed file runs, so that backfill sees
-- an empty accounts table and produces nothing here; the two accounts above
-- need their own opening anchor or every local balance reads as zero.
insert into account_anchors (household_id, account_id, reading_balance, reading_date, baseline_balance, baseline_date) values
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-0000000000b1', 20000, '2026-07-01', 20000, '2026-07-01'),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-0000000000b2', 15000, '2026-07-01', 15000, '2026-07-01');

-- A handful of expense categories.
insert into categories (id, household_id, name, kind, sort_order) values
  ('10000000-0000-0000-0000-000000000101', '10000000-0000-0000-0000-000000000000', 'ของใช้ในบ้าน', 'expense', 0),
  ('10000000-0000-0000-0000-000000000102', '10000000-0000-0000-0000-000000000000', 'อาหาร', 'expense', 1),
  ('10000000-0000-0000-0000-000000000103', '10000000-0000-0000-0000-000000000000', 'ค่าน้ำค่าไฟ/เน็ต', 'expense', 2),
  ('10000000-0000-0000-0000-000000000104', '10000000-0000-0000-0000-000000000000', 'สัตว์เลี้ยง', 'expense', 3),
  ('10000000-0000-0000-0000-000000000105', '10000000-0000-0000-0000-000000000000', 'เดินทาง', 'expense', 4),
  ('10000000-0000-0000-0000-000000000106', '10000000-0000-0000-0000-000000000000', 'ช้อปปิ้ง', 'expense', 5),
  ('10000000-0000-0000-0000-000000000107', '10000000-0000-0000-0000-000000000000', 'สุขภาพ/ฟิตเนส', 'expense', 6);

-- Two subs of "อาหาร" (Records' Filter screen, 2026-09): nothing else in this
-- seed had a sub-category, so the checkbox tree's expand/collapse and
-- tri-state Main row had no live data to render against.
insert into categories (id, household_id, name, kind, sort_order, parent_id) values
  ('10000000-0000-0000-0000-000000000121', '10000000-0000-0000-0000-000000000000', 'มื้อเย็นนอกบ้าน', 'expense', 0, '10000000-0000-0000-0000-000000000102'),
  ('10000000-0000-0000-0000-000000000122', '10000000-0000-0000-0000-000000000000', 'กาแฟ/เครื่องดื่ม', 'expense', 1, '10000000-0000-0000-0000-000000000102');

-- This household bypasses seed_default_categories() (it's inserted directly
-- above, not via create_household()), so it never got the "Other" category
-- every real household has, or -- since 0028 -- "Modified Bal". Reconcile's
-- yes/no answer needs one or the other to exist in both kinds.
insert into categories (id, household_id, name, kind, sort_order, system) values
  ('10000000-0000-0000-0000-000000000108', '10000000-0000-0000-0000-000000000000', 'Other', 'expense', 7, false),
  ('10000000-0000-0000-0000-000000000109', '10000000-0000-0000-0000-000000000000', 'Other', 'income', 0, false),
  ('10000000-0000-0000-0000-00000000010a', '10000000-0000-0000-0000-000000000000', 'Modified Bal', 'expense', 8, true),
  ('10000000-0000-0000-0000-00000000010b', '10000000-0000-0000-0000-000000000000', 'Modified Bal', 'income', 1, true);

-- Shared transactions (owner_id null), each paid via one person's card.
insert into transactions (id, household_id, date, kind, category_id, category_kind, note, amount, owner_id, from_card_id) values
  ('10000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-000000000000', '2026-07-02', 'expense',
   '10000000-0000-0000-0000-000000000101', 'expense', 'ของใช้ในบ้าน (ซูเปอร์มาร์เก็ต)', 1240, null, '10000000-0000-0000-0000-0000000000c2'),
  ('10000000-0000-0000-0000-000000000202', '10000000-0000-0000-0000-000000000000', '2026-07-05', 'expense',
   '10000000-0000-0000-0000-000000000121', 'expense', 'อาหารเย็นนอกบ้าน', 860, null, '10000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-000000000203', '10000000-0000-0000-0000-000000000000', '2026-07-10', 'expense',
   '10000000-0000-0000-0000-000000000103', 'expense', 'ค่าอินเทอร์เน็ตบ้าน', 590, null, '10000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-000000000204', '10000000-0000-0000-0000-000000000000', '2026-07-14', 'expense',
   '10000000-0000-0000-0000-000000000104', 'expense', 'อาหารสัตว์เลี้ยง', 480, null, '10000000-0000-0000-0000-0000000000c1');

-- Personal transactions (owner_id set).
insert into transactions (id, household_id, date, kind, category_id, category_kind, note, amount, owner_id, from_card_id) values
  ('10000000-0000-0000-0000-000000000205', '10000000-0000-0000-0000-000000000000', '2026-07-03', 'expense',
   '10000000-0000-0000-0000-000000000122', 'expense', 'กาแฟ', 65, '10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-000000000206', '10000000-0000-0000-0000-000000000000', '2026-07-08', 'expense',
   '10000000-0000-0000-0000-000000000105', 'expense', 'น้ำมันรถ', 800, '10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-000000000207', '10000000-0000-0000-0000-000000000000', '2026-07-20', 'expense',
   '10000000-0000-0000-0000-000000000107', 'expense', 'ค่าฟิตเนส', 1200, '10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-000000000208', '10000000-0000-0000-0000-000000000000', '2026-07-06', 'expense',
   '10000000-0000-0000-0000-000000000106', 'expense', 'เสื้อผ้า', 1590, '10000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000c2'),
  ('10000000-0000-0000-0000-000000000209', '10000000-0000-0000-0000-000000000000', '2026-07-16', 'expense',
   '10000000-0000-0000-0000-000000000106', 'expense', 'สกินแคร์', 890, '10000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000c2');

-- A borrow (debt_kind = 'borrow'): เอิร์ธ's own laptop bag, but his card had
-- no room left so he paid with พลอย's card. owner_id (a1) differs from the
-- paying card's owner_id (a2), so the whole amount is เอิร์ธ's -- one
-- full-amount share below, same as any transaction shaped like this.
insert into transactions (id, household_id, date, kind, category_id, category_kind, note, amount, owner_id, from_card_id) values
  ('10000000-0000-0000-0000-000000000210', '10000000-0000-0000-0000-000000000000', '2026-07-18', 'expense',
   '10000000-0000-0000-0000-000000000106', 'expense', 'กระเป๋าโน้ตบุ๊ก (ยืมบัตรพลอยจ่าย)', 690, '10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000c2');

-- The breakdowns computeShareRows would write for the transactions above:
-- 201-204 split evenly (owner_id null, 2 members, divides cleanly); 210 is
-- the single-row borrow; 205-209 are personal (owner = paying instrument's
-- owner) and get no rows at all.
insert into transaction_shares (household_id, transaction_id, member_id, share_amount) values
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-0000000000a1', 620),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-0000000000a2', 620),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000202', '10000000-0000-0000-0000-0000000000a1', 430),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000202', '10000000-0000-0000-0000-0000000000a2', 430),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000203', '10000000-0000-0000-0000-0000000000a1', 295),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000203', '10000000-0000-0000-0000-0000000000a2', 295),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000204', '10000000-0000-0000-0000-0000000000a1', 240),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000204', '10000000-0000-0000-0000-0000000000a2', 240),
  ('10000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000210', '10000000-0000-0000-0000-0000000000a1', 690);

-- One repayment already happened: พลอย paid back her half of the restaurant
-- bill by transferring into เอิร์ธ's account. It's a real transfer -- kind =
-- 'transfer', moves between the accounts above -- so it shows up in the
-- ledger exactly like any other movement of money; nothing distinguishes a
-- repayment from any other transfer except which shares point at it.
insert into transactions (id, household_id, date, kind, category_id, category_kind, description, amount, owner_id, from_account_id, to_account_id, note) values
  ('10000000-0000-0000-0000-000000000301', '10000000-0000-0000-0000-000000000000', '2026-07-06', 'transfer',
   null, null, '', 430, '10000000-0000-0000-0000-0000000000a2',
   '10000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-0000000000b1', 'โอนคืนค่าอาหารเย็น');

-- Point พลอย's share of the ฿860 dinner (transaction 202) at that transfer.
-- Everything else inserted above stays open.
update transaction_shares
set settled_by_transaction_id = '10000000-0000-0000-0000-000000000301'
where transaction_id = '10000000-0000-0000-0000-000000000202'
  and member_id = '10000000-0000-0000-0000-0000000000a2';

-- Upcoming (2026-10): nothing in this seed had a recurring rule or an
-- installment plan, so Upcoming's Coming up, card forecast and both
-- management lists rendered empty locally. One of each shape that tab
-- distinguishes: card-billed vs account-billed recurring (a card-billed one
-- is Projected inside its card's bill, never a row of its own), monthly vs
-- yearly (the November spike), an income rule, and card- vs account-billed
-- installment plans (card periods post ahead, ADR-0001; one plan ≥ 5% p.a.
-- for the rate badge). Start dates sit after the seed's other data and just
-- ahead of "now" so no past occurrences materialise as pending review.
insert into categories (id, household_id, name, kind, sort_order) values
  ('10000000-0000-0000-0000-00000000010c', '10000000-0000-0000-0000-000000000000', 'เงินเดือน', 'income', 0);

insert into recurring_rules (id, household_id, name, kind, category_id, category_kind, amount, owner_id, from_account_id, from_card_id, freq, day_of_month, month_of_year, start_date) values
  -- account-billed, monthly: its own row in Coming up
  ('10000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000000', 'ค่าเน็ตบ้าน', 'expense',
   '10000000-0000-0000-0000-000000000103', 'expense', 699, '10000000-0000-0000-0000-0000000000a1',
   '10000000-0000-0000-0000-0000000000b1', null, 'monthly', 18, null, '2026-10-11'),
  ('10000000-0000-0000-0000-000000000402', '10000000-0000-0000-0000-000000000000', 'อาหารแมว', 'expense',
   '10000000-0000-0000-0000-000000000104', 'expense', 850, '10000000-0000-0000-0000-0000000000a2',
   '10000000-0000-0000-0000-0000000000b2', null, 'monthly', 25, null, '2026-10-11'),
  -- card-billed, monthly: Projected inside its card's bill
  ('10000000-0000-0000-0000-000000000403', '10000000-0000-0000-0000-000000000000', 'สตรีมมิ่งรายเดือน', 'expense',
   '10000000-0000-0000-0000-000000000106', 'expense', 419, '10000000-0000-0000-0000-0000000000a1',
   null, '10000000-0000-0000-0000-0000000000c1', 'monthly', 12, null, '2026-10-11'),
  ('10000000-0000-0000-0000-000000000404', '10000000-0000-0000-0000-000000000000', 'ค่าสมาชิกฟิตเนส', 'expense',
   '10000000-0000-0000-0000-000000000107', 'expense', 1290, '10000000-0000-0000-0000-0000000000a2',
   null, '10000000-0000-0000-0000-0000000000c2', 'monthly', 1, null, '2026-10-11'),
  -- card-billed, yearly: one month's spike
  ('10000000-0000-0000-0000-000000000405', '10000000-0000-0000-0000-000000000000', 'ประกันรถ', 'expense',
   '10000000-0000-0000-0000-000000000105', 'expense', 8940, '10000000-0000-0000-0000-0000000000a1',
   null, '10000000-0000-0000-0000-0000000000c1', 'yearly', 3, 11, '2026-10-11'),
  -- income
  ('10000000-0000-0000-0000-000000000406', '10000000-0000-0000-0000-000000000000', 'เงินเดือน', 'income',
   '10000000-0000-0000-0000-00000000010c', 'income', 38500, '10000000-0000-0000-0000-0000000000a1',
   '10000000-0000-0000-0000-0000000000b1', null, 'monthly', 25, null, '2026-10-11');

insert into installments (id, household_id, name, category_id, start_date, total_periods, monthly_amount, card_id, account_id, annual_interest_rate, owner_id) values
  -- card-billed, 0%, already three periods in
  ('10000000-0000-0000-0000-000000000501', '10000000-0000-0000-0000-000000000000', 'โทรศัพท์ใหม่', 
   '10000000-0000-0000-0000-000000000106', '2026-08-01', 10, 4190, '10000000-0000-0000-0000-0000000000c1', null, 0,
   '10000000-0000-0000-0000-0000000000a1'),
  -- card-billed, starts this month
  ('10000000-0000-0000-0000-000000000502', '10000000-0000-0000-0000-000000000000', 'เครื่องซักผ้า',
   '10000000-0000-0000-0000-000000000101', '2026-10-15', 6, 2650, '10000000-0000-0000-0000-0000000000c2', null, 0,
   '10000000-0000-0000-0000-0000000000a2'),
  -- account-billed, ≥ 5% p.a. (rate badge), first period coming up
  ('10000000-0000-0000-0000-000000000503', '10000000-0000-0000-0000-000000000000', 'โน้ตบุ๊ก',
   '10000000-0000-0000-0000-000000000106', '2026-10-28', 12, 1820, null, '10000000-0000-0000-0000-0000000000b2', 6.5,
   '10000000-0000-0000-0000-0000000000a2');

commit;
