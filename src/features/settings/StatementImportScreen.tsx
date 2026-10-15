import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CategoryOptions } from '@/components/CategoryOptions'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Checkbox } from '@/components/ui/checkbox'
import { useAccounts } from '@/lib/accounts'
import { useCards } from '@/lib/cards'
import { useCategories } from '@/lib/categories'
import { addDays } from '@/lib/finance/billingCycle'
import { formatBaht } from '@/lib/format'
import { useHousehold } from '@/lib/HouseholdContext'
import type { EntryPrefill } from '@/lib/entryPrefill'
import { useInstallments } from '@/lib/installments'
import { InstallmentSheet } from '@/features/installments/InstallmentSheet'
import { planCovers, planStartFor, withoutPeriodMarker, type PlanRef } from '@/lib/statements/stage'
import { parseCsvText } from '@/lib/import/parseCsv'
import { applyCounterparties, applyStatementRows, buildStatementRows, normalizeStatementText, SHARED, unknownNames, type StatementRow } from '@/lib/statementImport'
import {
  hintMap,
  recordStatementFiles,
  rulesFromRows,
  useCategoryHints,
  useCounterparties,
  useSaveCounterparties,
  useStatementFiles,
  type NewStatementFile,
} from '@/lib/statementMemory'
import { useTransactions } from '@/lib/transactions'
import { StatementPdfSource, type StatementWarning } from './StatementPdfSource'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { StatementReviewDesktop } from './StatementReviewDesktop'
import { StatementReviewList } from './StatementReviewList'
import { UnknownNames } from './UnknownNames'
import { WhoIsThis } from './WhoIsThis'
import { hasPlanNear, periodLineFor, removeSuperseded, useSupersededCandidates, type OrphanConversion, type SupersededCandidate } from '@/lib/superseded'

type Tab = 'review' | 'new' | 'imported'
const TAB_OF: Record<StatementRow['status'], Tab> = { error: 'review', match: 'review', review: 'review', new: 'new', imported: 'imported' }
const TAB_LABEL: Record<Tab, string> = { review: 'Needs review', new: 'New', imported: 'Already imported' }
const PAGE = 100
const EMPTY_TEXT: Record<Tab, string> = {
  review: 'Nothing needs a second look. The rest is under New.',
  new: 'No new lines. Everything here is either imported already or under Needs review.',
  imported: 'None of these lines are in your records yet.',
}

// Work in progress survives a reload but not the browser tab: sessionStorage,
// never localStorage — this is the unmasked statement.
const DRAFT_KEY = 'statement-import-draft'
interface Draft {
  csvRows: Record<string, string>[]
  accepted: number[]
  categoryOverride: [number, string][]
  whoOverride: [number, string][]
  warnings?: StatementWarning[]
  files?: NewStatementFile[]
  orphans?: OrphanConversion[]
  supersede?: string[]
}
function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as Draft) : null
  } catch {
    return null
  }
}
function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // nothing to clear
  }
}

// ADR-0019: the unmasked statement CSV is read here in the browser and written
// only on Apply. Nothing is accepted by default — "Accept all" is one tap.
export function StatementImportScreen({ onClose }: { onClose: () => void }) {
  const { householdId, self, members } = useHousehold()
  const queryClient = useQueryClient()
  const { data: accounts } = useAccounts(householdId)
  const { data: cards } = useCards(householdId)
  const { data: categories } = useCategories(householdId)
  const { data: installments } = useInstallments(householdId)
  const { data: seenFiles } = useStatementFiles(householdId)
  const { data: counterpartyRows } = useCounterparties(householdId)
  const { data: hintRows } = useCategoryHints(householdId)
  const saveCounterparties = useSaveCounterparties(householdId, self.id)
  const [draft] = useState(loadDraft)
  // Credits that turn a purchase into an installment, whose purchase is not in this
  // import: the expense already in the ledger is offered for removal, never ticked for you.
  const [orphans, setOrphans] = useState<OrphanConversion[]>(draft?.orphans ?? [])
  const [supersede, setSupersede] = useState<Set<string>>(new Set(draft?.supersede))
  const idsOf = (name: string) => ({
    accountId: (accounts ?? []).find((a) => a.name === name)?.id ?? null,
    cardId: (cards ?? []).find((c) => c.name === name)?.id ?? null,
  })
  const { data: supersededFound } = useSupersededCandidates(householdId, orphans, idsOf)
  const [csvRows, setCsvRows] = useState<Record<string, string>[] | null>(draft?.csvRows ?? null)
  const [tab, setTab] = useState<Tab>('review')
  const [accepted, setAccepted] = useState<Set<number>>(new Set(draft?.accepted))
  const [categoryOverride, setCategoryOverride] = useState<Map<number, string>>(new Map(draft?.categoryOverride))
  const [whoOverride, setWhoOverride] = useState<Map<number, string>>(new Map(draft?.whoOverride))
  const [shown, setShown] = useState(PAGE)
  // Lines the reader could not read, and rows it could not place: shown, never dropped quietly.
  const [warnings, setWarnings] = useState<StatementWarning[]>(draft?.warnings ?? [])
  // The files this review was built from, recorded when Apply succeeds.
  const [fileMeta, setFileMeta] = useState<NewStatementFile[]>(draft?.files ?? [])
  // A name the household is being asked about ("who is this?").
  const [asking, setAsking] = useState<string[] | null>(null)
  // Names ticked in the "Who are these?" list, answered together.
  const [pickedNames, setPickedNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!csvRows) return
    const next: Draft = { csvRows, accepted: [...accepted], categoryOverride: [...categoryOverride], whoOverride: [...whoOverride], warnings, files: fileMeta, orphans, supersede: [...supersede] }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next))
    } catch {
      // storage full or blocked: the screen still works, it just won't survive a reload
    }
  }, [csvRows, accepted, categoryOverride, whoOverride, warnings, fileMeta, orphans, supersede])
  const [applying, setApplying] = useState(false)
  const [confirmStartOver, setConfirmStartOver] = useState(false)
  const isDesktop = useIsDesktop()
  // The installment plan being made from this review, and the expense it replaces.
  const [planFrom, setPlanFrom] = useState<{ prefill: EntryPrefill; supersedes?: string } | null>(null)

  // What the household has said about names, applied before rows are built so a
  // transfer to its own other account is a transfer, and keys never notice.
  const rules = useMemo(
    () => rulesFromRows(counterpartyRows ?? [], { accounts: accounts ?? [], cards: cards ?? [], members, categories: categories ?? [] }),
    [counterpartyRows, accounts, cards, members, categories],
  )
  const hints = useMemo(() => {
    const names = new Map((categories ?? []).map((c) => [c.id, c.name]))
    return hintMap(hintRows ?? [], (id) => names.get(id))
  }, [hintRows, categories])
  const records = useMemo(() => (csvRows ? applyCounterparties(csvRows, rules) : null), [csvRows, rules])

  // Existing rows around the file's dates, for keys already imported and hand-entered matches.
  const range = useMemo(() => {
    const dates = (records ?? []).map((r) => r['Date']?.split('/').reverse().join('-')).filter(Boolean).sort()
    return dates.length ? { start: addDays(dates[0], -3), end: addDays(dates[dates.length - 1], 3) } : { start: '', end: '' }
  }, [records])
  const { data: existing } = useTransactions(householdId, range)

  // The plans the app already has, by the name of the card or account they sit on.
  const plans = useMemo<PlanRef[]>(
    () =>
      (installments ?? []).flatMap((i) => {
        const instrument = (cards ?? []).find((c) => c.id === i.card_id)?.name ?? (accounts ?? []).find((a) => a.id === i.account_id)?.name
        return instrument ? [{ instrument, total: i.total_periods, startDate: i.start_date }] : []
      }),
    [installments, cards, accounts],
  )

  const rows = useMemo(() => {
    if (!records || !accounts || !cards || !categories || !existing) return null
    const nameOf = (r: StatementRow) => accounts.find((a) => a.id === r.fromAccountId)?.name ?? cards.find((c) => c.id === r.fromCardId)?.name ?? ''
    // A plan made since the files were read posts these periods itself, so they leave the review.
    return buildStatementRows(records, { accounts, cards, categories, existing }).filter(
      (r) => !(r.needsPlan && r.installment && planCovers(plans, nameOf(r), r.installment, r.postedDate ?? r.date)),
    )
  }, [records, accounts, cards, categories, existing, plans])

  const liveCategories = useMemo(() => (categories ?? []).filter((c) => !c.archived && !c.system), [categories])
  const categoryById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories])
  const instrumentOwnerOf = (accountId: string | null, cardId: string | null) =>
    (accounts ?? []).find((a) => a.id === accountId)?.owner_id ?? (cards ?? []).find((c) => c.id === cardId)?.owner_id ?? null
  // Who bears it: an explicit choice on screen, else the CSV's Owner column, else whoever owns the card or account.
  const whoOf = (r: StatementRow): string => {
    const chosen = whoOverride.get(r.line)
    if (chosen) return chosen
    const hint = r.ownerHint.toLowerCase()
    if (hint === 'shared' || hint === 'แชร์') return SHARED
    const named = members.find((m) => m.display_name.toLowerCase() === hint)
    if (named) return named.id
    return instrumentOwnerOf(r.fromAccountId, r.fromCardId) ?? self.id
  }
  const instrumentName = (accountId: string | null, cardId: string | null) =>
    (accounts ?? []).find((a) => a.id === accountId)?.name ?? (cards ?? []).find((c) => c.id === cardId)?.name ?? '—'

  const startOf = (r: StatementRow) => planStartFor(r.postedDate ?? r.date, r.installment!.k)
  const totalOf = (r: StatementRow) => Math.round(r.amount * r.installment!.total * 100) / 100
  // Everything the statement line already says about the plan: card, periods, amount, start.
  const prefillFromLine = (r: StatementRow): EntryPrefill => {
    const who = whoOf(r)
    return {
      name: withoutPeriodMarker(r.description),
      kind: 'expense',
      categoryId: categoryOverride.get(r.line) ?? r.categoryId,
      amount: totalOf(r),
      ownerId: who === SHARED ? null : who,
      from: { accountId: r.fromAccountId, cardId: r.fromCardId },
      date: startOf(r),
      periods: r.installment!.total,
    }
  }
  // The purchase already in the ledger keeps its name, category and who bears it;
  // the period line it became, when it is in this import, says how long and from when.
  const prefillFromPurchase = (orphan: OrphanConversion, c: SupersededCandidate): EntryPrefill => {
    const from = idsOf(orphan.instrument)
    const sameCard = (rows ?? []).filter((r) => r.needsPlan && r.fromAccountId === from.accountId && r.fromCardId === from.cardId)
    const line = periodLineFor(orphan, sameCard, startOf)
    return {
      name: c.description || c.note || (line ? withoutPeriodMarker(line.description) : ''),
      kind: 'expense',
      categoryId: c.category_id,
      amount: line ? totalOf(line) : orphan.amount,
      ownerId: c.owner_id,
      from,
      date: line ? startOf(line) : orphan.date,
      periods: line?.installment?.total,
    }
  }

  if (!csvRows) {
    return (
      <div>
        <StatementPdfSource
          accounts={accounts ?? []}
          cards={cards ?? []}
          plans={plans}
          hints={hints}
          seen={seenFiles ?? []}
          onReady={(staged, found, files, converted) => {
            setWarnings(found)
            setFileMeta(files)
            setOrphans(converted)
            setSupersede(new Set())
            setCsvRows(staged)
          }}
        />
        <details className="mx-auto max-w-2xl p-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">From the old pipeline (CSV)</summary>
          <div className="space-y-3 pt-3">
            <p>Pick <code>statements/raw/final/transactions.csv</code> (after <code>npm run statements:unmask</code>).</p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                try {
                  setWarnings([])
                  setFileMeta([])
                  setOrphans([])
                  setSupersede(new Set())
                  setCsvRows(parseCsvText(await file.text()).rows)
                } catch (err) {
                  toast.error(`Couldn't read this CSV: ${err instanceof Error ? err.message : String(err)}`)
                }
                e.target.value = '' // picking the same file again should still fire onChange
              }}
            />
          </div>
        </details>
      </div>
    )
  }
  if (!rows) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>

  // A file column only helps when there is more than one file to tell apart.
  const showFile = new Set(rows.map((r) => r.file).filter(Boolean)).size > 1
  const unknown = unknownNames(rows, rules)
  const visible = rows.filter((r) => TAB_OF[r.status] === tab)
  const actionable = (r: StatementRow) => r.status !== 'error' && r.status !== 'imported'
  const effective = (r: StatementRow): StatementRow => {
    const categoryId = categoryOverride.get(r.line)
    return categoryId ? { ...r, categoryId } : r
  }
  const toApply = rows.filter((r) => actionable(r) && accepted.has(r.line)).map(effective)

  function update(lines: number[], accept: boolean) {
    setAccepted((prev) => {
      const next = new Set(prev)
      for (const l of lines) {
        if (accept) next.add(l)
        else next.delete(l)
      }
      return next
    })
  }
  function setCategory(lines: number[], categoryId: string) {
    setCategoryOverride((prev) => new Map([...prev, ...lines.map((l) => [l, categoryId] as const)]))
  }
  // One tick per row means "import this"; Set who / Set category act on the ticked rows in view.
  const tickedLines = visible.filter((r) => accepted.has(r.line) && actionable(r)).map((r) => r.line)
  const actionableLines = visible.filter(actionable).map((r) => r.line)
  const editable = (r: StatementRow) => actionable(r) && r.kind !== 'transfer' && r.status !== 'match'
  const unknownName = (r: StatementRow) =>
    r.counterparty && actionable(r) && !rules.has(normalizeStatementText(r.counterparty)) ? r.counterparty : null
  const onPlan = (r: StatementRow) => setPlanFrom({ prefill: prefillFromLine(r) })
  const onWho = (line: number, who: string) => setWhoOverride((prev) => new Map(prev).set(line, who))

  async function apply() {
    setApplying(true)
    try {
      const result = await applyStatementRows(householdId, toApply, {
        categoryKindOf: (id) => categoryById.get(id)?.kind ?? null,
        instrumentOwnerOf,
        memberIds: members.map((m) => m.id),
        whoOf,
      })
      await recordStatementFiles(householdId, self.id, fileMeta)
      // Only where a plan already stands in for the expense: a tick left in an older draft is not enough.
      const removable = new Set((supersededFound ?? []).filter((f) => hasPlanNear(f.orphan, plans)).flatMap((f) => f.candidates.map((c) => c.id)))
      await removeSuperseded([...supersede].filter((id) => removable.has(id)))
      await queryClient.invalidateQueries({ queryKey: ['transactions', householdId] })
      await queryClient.invalidateQueries({ queryKey: ['statement_files', householdId] })
      await queryClient.invalidateQueries({ queryKey: ['category_hints', householdId] })
      clearDraft()
      toast.success(`Imported ${result.inserted}, confirmed ${result.matched} matches`)
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setApplying(false)
    }
  }

  const notices = (
    <>
      {fileMeta.length > 0 && (
        <details className="border-b p-2 text-xs">
          <summary className="cursor-pointer font-medium">Reviewing {fileMeta.length === 1 ? '1 file' : `${fileMeta.length} files`}</summary>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {fileMeta.map((f) => (
              <li key={f.sha256} className="flex flex-wrap gap-x-2">
                <span className="break-all text-foreground">{f.fileName}</span>
                <span>
                  {(accounts ?? []).find((a) => a.id === f.accountId)?.name ?? (cards ?? []).find((c) => c.id === f.cardId)?.name ?? ''} · {f.rowCount} lines read
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {warnings.length > 0 && (
        <details className="border-b border-destructive/40 bg-destructive/5 p-2 text-xs">
          <summary className="cursor-pointer font-medium text-destructive">
            {warnings.length} {warnings.length === 1 ? 'line was' : 'lines were'} not imported: they could not be read or placed
          </summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
            {warnings.slice(0, 100).map((w, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{w.source}:</span> {w.reason} — <span className="break-all">{w.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {(supersededFound ?? []).some((f) => f.candidates.length > 0) && (
        <div className="space-y-2 border-b border-amber-500/40 bg-amber-500/5 p-2 text-xs">
          <p className="font-medium">Purchases that became installments</p>
          <p className="text-muted-foreground">
            A credit below turns an earlier purchase into an installment. That purchase is already in your records as an ordinary expense. Make it a plan and the plan replaces it, so it is not counted twice.
          </p>
          {(supersededFound ?? []).filter((f) => f.candidates.length > 0).map((f, i) => (
            <div key={i} className="space-y-1">
              <p>
                Credit of {formatBaht(f.orphan.amount)} on {f.orphan.date} ({f.orphan.instrument}):
              </p>
              {f.candidates.map((c) => (
                <div key={c.id} className="space-y-1 pl-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      Expense of {c.date}: {c.description || c.note || 'no description'} ({formatBaht(c.amount)})
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setPlanFrom({ prefill: prefillFromPurchase(f.orphan, c), supersedes: c.id })}>
                      Make it a plan
                    </Button>
                  </div>
                  {/* Removing the expense alone is only safe when a plan already stands in for it. */}
                  {hasPlanNear(f.orphan, plans) && (
                    <label className="flex items-center gap-2 text-muted-foreground">
                      <Checkbox
                        checked={supersede.has(c.id)}
                        onCheckedChange={(v) =>
                          setSupersede((prev) => {
                            const next = new Set(prev)
                            if (v) next.add(c.id)
                            else next.delete(c.id)
                            return next
                          })
                        }
                      />
                      The plan is already in the app: remove this expense on Apply
                    </label>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {!asking && unknown.length > 0 && (
        <UnknownNames
          names={unknown}
          selected={pickedNames}
          onChange={setPickedNames}
          onAnswer={() => setAsking(unknown.filter((n) => pickedNames.has(n.key)).map((n) => n.name))}
        />
      )}
    </>
  )
  const supersededCount = (supersededFound ?? []).filter((f) => f.candidates.length > 0).length
  const noticeCount = (warnings.length ? 1 : 0) + supersededCount + (unknown.length ? 1 : 0)

  const askForm = asking && (
    <WhoIsThis
      names={asking}
      accounts={accounts ?? []}
      cards={cards ?? []}
      members={members}
      categories={liveCategories}
      saving={saveCounterparties.isPending}
      onCancel={() => setAsking(null)}
      onSave={async (answer) => {
        try {
          await saveCounterparties.mutateAsync({ names: asking, answer })
          setPickedNames(new Set())
          setAsking(null)
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Could not save')
        }
      }}
    />
  )
  const instrumentLabel = (r: StatementRow) =>
    instrumentName(r.fromAccountId, r.fromCardId) + (r.kind === 'transfer' ? ` → ${instrumentName(r.toAccountId, r.toCardId)}` : '')
  const dialogs = (
    <>
        {confirmStartOver && (
          <ConfirmDialog
            title="Start over?"
            description="This review is thrown away, with everything you accepted or changed in it. Nothing has been imported yet."
            confirmLabel="Start over"
            onClose={() => setConfirmStartOver(false)}
            onConfirm={() => {
              clearDraft()
              setCsvRows(null)
              setWarnings([])
              setFileMeta([])
              setOrphans([])
              setSupersede(new Set())
              setAccepted(new Set())
              setCategoryOverride(new Map())
              setWhoOverride(new Map())
            }}
          />
        )}
        {planFrom && (
          <InstallmentSheet
            installment={null}
            prefill={planFrom.prefill}
            supersedes={planFrom.supersedes}
            onClose={() => {
              setPlanFrom(null)
              void queryClient.invalidateQueries({ queryKey: ['superseded', householdId] })
            }}
          />
        )}
    </>
  )

  if (isDesktop) {
    return (
      <div className="h-full">
        <StatementReviewDesktop
          rows={rows.map(effective)}
          accepted={accepted}
          onAccept={update}
          actionable={actionable}
          editable={editable}
          instrumentName={instrumentLabel}
          showFile={showFile}
          categories={liveCategories}
          categoryById={categoryById}
          members={members}
          whoOf={whoOf}
          onWho={(lines, who) => setWhoOverride((prev) => new Map([...prev, ...lines.map((l) => [l, who] as const)]))}
          onCategory={setCategory}
          unknownName={unknownName}
          onAsk={(name) => setAsking([name])}
          onPlan={onPlan}
          notices={notices}
          noticeCount={noticeCount}
          askForm={askForm}
          fileCount={fileMeta.length}
          toApply={toApply}
          applying={applying}
          onApply={apply}
          onStartOver={() => setConfirmStartOver(true)}
        />
        {dialogs}
      </div>
    )
  }

  // A phone scrolls the whole page: the file list, warnings and wrapped
  // toolbars can fill the screen and leave the list no room of its own.
  return (
    <div className="flex min-h-full flex-col">
      {notices}
      {askForm}
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        {(['review', 'new', 'imported'] as Tab[]).map((t) => (
          <Button key={t} size="sm" variant={tab === t ? 'default' : 'ghost'} onClick={() => { setTab(t); setShown(PAGE) }}>
            {TAB_LABEL[t]} ({rows.filter((r) => TAB_OF[r.status] === t).length})
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirmStartOver(true)}>
            Start over
          </Button>
        </div>
      </div>

      {tab !== 'imported' && (
        <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
          {tickedLines.length < actionableLines.length ? (
            <Button size="sm" variant="outline" onClick={() => update(actionableLines, true)}>
              Tick all
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => update(actionableLines, false)}>
              Untick all
            </Button>
          )}
          <span className="text-muted-foreground">{tickedLines.length} ticked:</span>
          <select
            className="h-8 rounded-md border bg-background px-2"
            disabled={!tickedLines.length}
            value=""
            onChange={(e) =>
              e.target.value &&
              setWhoOverride((prev) => new Map([...prev, ...tickedLines.map((l) => [l, e.target.value] as const)]))
            }
          >
            <option value="">Set who…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name}</option>
            ))}
            {members.length > 1 && <option value={SHARED}>Shared (split evenly)</option>}
          </select>
          <select
            className="h-8 rounded-md border bg-background px-2"
            disabled={!tickedLines.length}
            value=""
            onChange={(e) => e.target.value && setCategory(tickedLines, e.target.value)}
          >
            <option value="">Set category…</option>
            <CategoryOptions categories={liveCategories} />
          </select>
        </div>
      )}

      <div className="flex-1">
        <StatementReviewList
          rows={visible.slice(0, shown).map(effective)}
          accepted={accepted}
          onAccept={update}
          actionable={actionable}
          editable={editable}
          instrumentName={instrumentLabel}
          categories={liveCategories}
          categoryById={categoryById}
          members={members}
          whoOf={whoOf}
          onWho={onWho}
          onCategory={(line, id) => setCategory([line], id)}
          unknownName={unknownName}
          onAsk={(name) => setAsking([name])}
          onPlan={onPlan}
        />
      </div>

      {!visible.length && <p className="p-4 text-sm text-muted-foreground">{EMPTY_TEXT[tab]}</p>}
      {visible.length > shown && (
        <div className="p-3 text-center">
          <Button size="sm" variant="outline" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, visible.length - shown)} more ({visible.length - shown} left)
          </Button>
        </div>
      )}
      {/* On a phone Apply sits under the thumb, not in the toolbar at the top of a long list. */}
      <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <span className="flex-1 text-sm text-muted-foreground">
          {toApply.length ? `${toApply.length} ${toApply.length === 1 ? 'line' : 'lines'} to import` : 'Tick the lines to import'}
        </span>
        <Button disabled={!toApply.length || applying} onClick={apply}>
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      </div>
      {dialogs}
    </div>
  )
}
