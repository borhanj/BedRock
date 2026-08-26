/**
 * The HTTP surface, as one runtime-agnostic function.
 *
 * It takes a Request and a SqlDatabase and returns a Response. That is all it
 * knows, which is why the identical handler serves the Vite dev server over
 * node:sqlite and the Cloudflare Worker over D1 — there is no second
 * implementation to drift.
 */

import { bahaiYear as bahaiYearFor, CalendarRangeError } from '../calendar/badi'
import type { SqlDatabase } from './db/adapter'
import { setAuditActor } from './db/adapter'
import { loadYear } from './repo/year'
import { loadAuditPackage } from './repo/audit'
import { exportEverything, loadHandoff } from './repo/handoff'
import { planRestore, restore, RestoreError } from './repo/restore'
import {
  ensureReport,
  finalizeReport,
  loadReport,
  loadYearSummary,
  presentReport,
  ReportStateError,
  setCutoff,
  unlockReport,
} from './repo/report'
import {
  categorise,
  commitImport,
  previewImport,
  type ImportPreview,
} from './repo/import'
import {
  createTransaction,
  loadCashJournal,
  loadChoices,
  loadLedger,
} from './repo/ledger'
import {
  loadFundLedger,
  loadFunds,
  recordRemittance,
  RemittanceError,
} from './repo/funds'
import {
  completeReconciliation,
  listReconciliations,
  loadReconciliation,
  ReconcileError,
  reopenReconciliation,
  setCleared,
  setStatement,
  startReconciliation,
} from './repo/reconcile'
import {
  approveBudget,
  BudgetError,
  loadBudget,
  proposeBudget,
  reopenBudget,
  setBudgetLine,
} from './repo/budget'
import { forgetRule, listRules } from './repo/rules'
import {
  loadCheckpoints,
  loadOpeningPosition,
  resolveUnexplained,
  restateOpening,
  OpeningError,
} from './repo/opening'
import { setUpAssembly, setupStatus, SetupError } from './repo/setup'
import { loadGettingStarted } from './repo/started'
import {
  addAccount,
  addCategory,
  addFund,
  clearLetterhead,
  loadLetterhead,
  loadSettings,
  renameAssembly,
  renameFund,
  resetEverything,
  setLetterhead,
  updateAccount,
  updateCategory,
  SettingsError,
} from './repo/settings'
import {
  changeSecret,
  createAnonymousDonor,
  createDonor,
  listDonors,
  readAccessLog,
  setupVault,
  vaultStatus,
  verifySecret,
  VaultError,
} from './repo/donors'
import {
  issueReceipt,
  listReceipts,
  readReceipt,
  ReceiptError,
  receiptSummary,
  unreceiptedGifts,
  voidReceipt,
} from './repo/receipts'

export interface ApiContext {
  readonly db: SqlDatabase
  readonly assemblyId: string
  /** Who is making this request; recorded against any write. */
  readonly actor: string
  /** Injected so tests are not at the mercy of the wall clock. */
  readonly today: string
  /** Timestamp for writes. */
  readonly now: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Financial data: never let a shared cache hold on to it.
      'cache-control': 'no-store',
    },
  })
}

class BadRequest extends Error {}

/**
 * "current" and "next" resolve against the server's today.
 *
 * The budget screen exists mostly to draft the year that has not started yet,
 * and which Baháʼí year that is depends on the Naw-Rúz table — so the browser
 * asks for "next" rather than doing the arithmetic itself and being wrong for
 * the few hours around the equinox.
 */
function budgetYear(token: string, today: string): number {
  if (token === 'current') return bahaiYearFor(today)
  if (token === 'next') return bahaiYearFor(today) + 1
  return Number(token)
}

function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null || value === '') {
    throw new BadRequest(`Missing "${field}"`)
  }
  return value
}

/** Returns null for anything that is not an API route, so assets can be served. */
export async function handleApi(
  request: Request,
  ctx: ApiContext,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) return null

  const path = url.pathname.slice(5)
  const method = request.method.toUpperCase()

  if (method !== 'GET') {
    // Every mutation is attributed before any handler runs, so no route can
    // forget to. The database triggers reject the write otherwise.
    await setAuditActor(ctx.db, ctx.actor)
  }

  try {
    const response = await route(request, ctx, path, method, url)
    return response ?? json({ error: `No route for ${url.pathname}` }, 404)
  } catch (error) {
    if (error instanceof BadRequest) {
      return json({ error: error.message }, 400)
    }
    // Closing, presenting and reopening a report follow an order. Asking for a
    // step out of turn is a conflict, not a crash — and so is forwarding more
    // than a fund holds.
    if (
      error instanceof ReportStateError ||
      error instanceof ReceiptError ||
      error instanceof RemittanceError ||
      error instanceof BudgetError ||
      error instanceof ReconcileError ||
      error instanceof RestoreError ||
      error instanceof SetupError ||
      error instanceof OpeningError ||
      error instanceof SettingsError
    ) {
      return json({ error: error.message }, 409)
    }
    // A wrong or missing PIN. 403 rather than 401: the treasurer IS signed in
    // through Access; what they lack is authorisation for donor detail.
    if (error instanceof VaultError) {
      return json({ error: error.message }, 403)
    }
    // A date outside the Naw-Rúz table is a known, explicable condition rather
    // than a crash — the message names the file to extend.
    if (error instanceof CalendarRangeError) {
      return json({ error: error.message }, 422)
    }
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, 500)
  }
}

async function route(
  request: Request,
  ctx: ApiContext,
  path: string,
  method: string,
  url: URL,
): Promise<Response | null> {
  const { db, assemblyId } = ctx

  // ── opening the books ──────────────────────────────────────────────────
  //
  // First, because every other route below assumes an Assembly that these two
  // are what create. `GET setup` is the only one that answers usefully against
  // an empty database, which is how the browser knows to offer setup rather
  // than a dashboard of nothing.
  if (path === 'setup' && method === 'GET') {
    return json(await setupStatus(db, assemblyId))
  }

  if (path === 'setup' && method === 'POST') {
    const body = (await request.json()) as {
      assemblyName?: string
      shortName?: string
      openedOn?: string
      funds?: Array<{ key: string; label: string; isPassthrough: boolean }>
      accounts?: Array<{ name: string; kind: 'bank' | 'cash'; openingBalanceCents: number }>
      categories?: Array<{ label: string; kind: 'income' | 'expense'; fundKey?: string }>
      declared?: Record<string, number>
      declaredBy?: string
      letterheadDataUrl?: string | null
      letterheadFilename?: string | null
    }
    return json(
      await setUpAssembly(
        db, assemblyId,
        {
          assemblyName: required(body.assemblyName, 'assemblyName'),
          shortName: body.shortName || required(body.assemblyName, 'assemblyName'),
          openedOn: body.openedOn || ctx.today,
          funds: body.funds ?? [],
          accounts: body.accounts ?? [],
          categories: body.categories ?? [],
          declared: body.declared ?? {},
          declaredBy: body.declaredBy || ctx.actor,
          letterheadDataUrl: body.letterheadDataUrl ?? null,
          letterheadFilename: body.letterheadFilename ?? null,
        },
        ctx.actor, ctx.now,
      ),
      201,
    )
  }

  // ── the opening position, and the gap in it ────────────────────────────
  if (path === 'opening' && method === 'GET') {
    const [position, checkpoints] = await Promise.all([
      loadOpeningPosition(db, assemblyId),
      loadCheckpoints(db, assemblyId),
    ])
    return json({ ...position, checkpoints })
  }

  // Moving the wall backwards, when the previous year's journal turns up.
  if (path === 'opening/restate' && method === 'POST') {
    const body = (await request.json()) as {
      openedOn?: string
      accounts?: Record<string, number>
      declared?: Record<string, number>
      reason?: string
      decidedBy?: string
    }
    return json(
      await restateOpening(
        db, assemblyId,
        {
          openedOn: required(body.openedOn, 'openedOn'),
          accounts: body.accounts ?? {},
          declared: body.declared ?? {},
          reason: required(body.reason, 'reason'),
          decidedBy: required(body.decidedBy, 'decidedBy'),
        },
        ctx.actor, ctx.now,
      ),
    )
  }

  if (path === 'opening/resolve' && method === 'POST') {
    const body = (await request.json()) as {
      amountCents?: number
      toFundKey?: string | null
      reason?: string
      decidedBy?: string
      occurredOn?: string
    }
    return json(
      await resolveUnexplained(
        db, assemblyId,
        {
          amountCents: Number(required(body.amountCents, 'amountCents')),
          toFundKey: body.toFundKey ?? null,
          reason: required(body.reason, 'reason'),
          decidedBy: required(body.decidedBy, 'decidedBy'),
          occurredOn: body.occurredOn || ctx.today,
        },
        ctx.actor, ctx.now,
      ),
    )
  }

  // ── what to do next ────────────────────────────────────────────────────
  if (path === 'getting-started' && method === 'GET') {
    return json(await loadGettingStarted(db, assemblyId))
  }

  // ── settings ───────────────────────────────────────────────────────────
  if (path === 'settings' && method === 'GET') {
    const view = await loadSettings(db, assemblyId)
    return view ? json(view) : json({ error: 'No such assembly' }, 404)
  }

  if (path === 'settings/assembly' && method === 'POST') {
    const body = (await request.json()) as { name?: string; shortName?: string }
    await renameAssembly(
      db, assemblyId,
      required(body.name, 'name'),
      body.shortName ?? '',
      ctx.actor,
    )
    return json(await loadSettings(db, assemblyId))
  }

  if (path === 'settings/accounts' && method === 'POST') {
    const body = (await request.json()) as {
      name?: string
      kind?: 'bank' | 'cash'
      openingBalanceCents?: number
    }
    await addAccount(
      db, assemblyId,
      {
        name: required(body.name, 'name'),
        kind: body.kind === 'cash' ? 'cash' : 'bank',
        openingBalanceCents: Number(body.openingBalanceCents ?? 0),
      },
      ctx.actor, ctx.now,
    )
    return json(await loadSettings(db, assemblyId), 201)
  }

  const account = /^settings\/accounts\/([^/]+)$/.exec(path)
  if (account && method === 'PATCH') {
    const body = (await request.json()) as { name?: string; isActive?: boolean }
    const ok = await updateAccount(
      db, assemblyId, decodeURIComponent(account[1]),
      { name: body.name, isActive: body.isActive },
      ctx.actor,
    )
    return ok ? json(await loadSettings(db, assemblyId)) : json({ error: 'No such account' }, 404)
  }

  if (path === 'settings/funds' && method === 'POST') {
    const body = (await request.json()) as { key?: string; label?: string }
    await addFund(
      db, assemblyId,
      { key: body.key ?? required(body.label, 'label'), label: required(body.label, 'label') },
      ctx.actor,
    )
    return json(await loadSettings(db, assemblyId), 201)
  }

  const fund = /^settings\/funds\/([^/]+)$/.exec(path)
  if (fund && method === 'PATCH') {
    const body = (await request.json()) as { label?: string }
    const ok = await renameFund(
      db, assemblyId, decodeURIComponent(fund[1]), required(body.label, 'label'), ctx.actor,
    )
    return ok ? json(await loadSettings(db, assemblyId)) : json({ error: 'No such fund' }, 404)
  }

  if (path === 'settings/categories' && method === 'POST') {
    const body = (await request.json()) as {
      label?: string
      kind?: 'income' | 'expense'
      fundKey?: string | null
    }
    await addCategory(
      db, assemblyId,
      {
        label: required(body.label, 'label'),
        kind: body.kind === 'income' ? 'income' : 'expense',
        fundKey: body.fundKey ?? null,
      },
      ctx.actor,
    )
    return json(await loadSettings(db, assemblyId), 201)
  }

  const category = /^settings\/categories\/([^/]+)$/.exec(path)
  if (category && method === 'PATCH') {
    const body = (await request.json()) as { label?: string; isArchived?: boolean }
    const ok = await updateCategory(
      db, assemblyId, decodeURIComponent(category[1]),
      { label: body.label, isArchived: body.isArchived },
      ctx.actor,
    )
    return ok ? json(await loadSettings(db, assemblyId)) : json({ error: 'No such category' }, 404)
  }

  if (path === 'settings/letterhead' && method === 'POST') {
    const body = (await request.json()) as { dataUrl?: string; filename?: string | null }
    await setLetterhead(
      db, assemblyId,
      required(body.dataUrl, 'dataUrl'),
      body.filename ?? null,
      ctx.actor, ctx.now,
    )
    return json(await loadSettings(db, assemblyId))
  }

  if (path === 'settings/letterhead' && method === 'DELETE') {
    await clearLetterhead(db, assemblyId, ctx.actor, ctx.now)
    return json(await loadSettings(db, assemblyId))
  }

  // Destroys everything. Whether a confirmation is needed at all, and what it
  // has to say, is decided in the repo against the stored Assembly name — not
  // here, and not by the client. An empty one is passed through rather than
  // rejected: for the sample books none is required, and the route should not
  // hold an opinion the repo has already formed.
  if (path === 'settings/reset' && method === 'POST') {
    const body = (await request.json()) as { confirmation?: string }
    return json(await resetEverything(db, assemblyId, body.confirmation ?? '', ctx.actor))
  }

  // ── the year ───────────────────────────────────────────────────────────
  const year = /^year\/(\d+|current)$/.exec(path)
  if (year && method === 'GET') {
    // "current" resolves against the server's today, so the browser never has
    // to know which Baháʼí year it is — that is the calendar's job, and the
    // calendar lives here.
    const resolved = year[1] === 'current' ? bahaiYearFor(ctx.today) : Number(year[1])
    return json(await loadYear(db, assemblyId, resolved, ctx.today))
  }

  // ── reports ────────────────────────────────────────────────────────────
  const report = /^report\/(\d+)\/(\d+)$/.exec(path)
  if (report) {
    const year = Number(report[1])
    const month = Number(report[2])

    if (method === 'GET') {
      const view = await loadReport(db, assemblyId, year, month)
      return view
        ? json(view)
        : json({ error: 'No report has been built for that month yet.' }, 404)
    }
    if (method === 'POST') {
      const view = await ensureReport(db, assemblyId, year, month, ctx.actor)
      return view ? json(view, 201) : json({ error: 'No such month' }, 404)
    }
  }

  const reportAction = /^report\/(\d+)\/(\d+)\/(cutoff|finalize|present|unlock)$/.exec(path)
  if (reportAction && method === 'POST') {
    const year = Number(reportAction[1])
    const month = Number(reportAction[2])
    const action = reportAction[3]
    const missing = json({ error: 'No report has been built for that month yet.' }, 404)

    if (action === 'cutoff') {
      const body = (await request.json()) as { start?: string; end?: string }
      const view = await setCutoff(
        db, assemblyId, year, month,
        required(body.start, 'start'),
        required(body.end, 'end'),
        ctx.actor,
      )
      return view ? json(view) : missing
    }

    const run =
      action === 'finalize' ? finalizeReport
      : action === 'present' ? presentReport
      : unlockReport
    const view = await run(db, assemblyId, year, month, ctx.actor, ctx.now)
    return view ? json(view) : missing
  }

  // ── the year summary ───────────────────────────────────────────────────
  const summary = /^summary\/(\d+|current)$/.exec(path)
  if (summary && method === 'GET') {
    const resolved =
      summary[1] === 'current' ? bahaiYearFor(ctx.today) : Number(summary[1])
    const view = await loadYearSummary(db, assemblyId, resolved)
    return view ? json(view) : json({ error: 'No such assembly' }, 404)
  }

  // ── funds and remittance ───────────────────────────────────────────────
  const funds = /^funds\/(\d+|current)$/.exec(path)
  if (funds && method === 'GET') {
    const resolved = funds[1] === 'current' ? bahaiYearFor(ctx.today) : Number(funds[1])
    return json(await loadFunds(db, assemblyId, resolved))
  }

  const fundLedger = /^funds\/(\d+|current)\/([^/]+)$/.exec(path)
  if (fundLedger && method === 'GET') {
    const resolved =
      fundLedger[1] === 'current' ? bahaiYearFor(ctx.today) : Number(fundLedger[1])
    const view = await loadFundLedger(
      db, assemblyId, decodeURIComponent(fundLedger[2]), resolved,
    )
    return view ? json(view) : json({ error: 'No such fund' }, 404)
  }

  if (path === 'remittances' && method === 'POST') {
    const body = (await request.json()) as {
      fundKey?: string
      accountId?: string
      sentOn?: string
      amountCents?: number
      reference?: string | null
    }
    return json(
      await recordRemittance(
        db, assemblyId,
        {
          fundKey: required(body.fundKey, 'fundKey'),
          accountId: required(body.accountId, 'accountId'),
          sentOn: body.sentOn || ctx.today,
          amountCents: Number(required(body.amountCents, 'amountCents')),
          reference: body.reference || null,
        },
        ctx.actor, ctx.now,
      ),
      201,
    )
  }

  // ── the audit package ──────────────────────────────────────────────────
  const audit = /^audit\/(\d+|current)$/.exec(path)
  if (audit && method === 'GET') {
    const resolved = audit[1] === 'current' ? bahaiYearFor(ctx.today) : Number(audit[1])
    const view = await loadAuditPackage(db, assemblyId, resolved, ctx.today, ctx.actor)
    return view ? json(view) : json({ error: 'No such assembly' }, 404)
  }

  // ── the treasurer handoff ──────────────────────────────────────────────
  const handoff = /^handoff\/(\d+|current)$/.exec(path)
  if (handoff && method === 'GET') {
    const resolved =
      handoff[1] === 'current' ? bahaiYearFor(ctx.today) : Number(handoff[1])
    const view = await loadHandoff(db, assemblyId, resolved, ctx.today, ctx.actor)
    return view ? json(view) : json({ error: 'No such assembly' }, 404)
  }

  // The whole book as one file. Served as a download rather than for display:
  // it is the successor's copy, not something to read on screen.
  if (path === 'handoff/export' && method === 'GET') {
    const bundle = await exportEverything(db, assemblyId, ctx.now, ctx.actor)
    return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition':
          `attachment; filename="bedrock-${assemblyId}-${ctx.today}.json"`,
        'cache-control': 'no-store',
      },
    })
  }

  // Reading a bundle back in. Inspecting is a dry run and writes nothing, so
  // a treasurer can be shown exactly what a file holds and what would stop it
  // before anything is decided.
  if (path === 'handoff/inspect' && method === 'POST') {
    return json(await planRestore(db, await request.json()))
  }
  if (path === 'handoff/restore' && method === 'POST') {
    return json(await restore(db, await request.json(), ctx.actor, ctx.now), 201)
  }

  // ── bank reconciliation ────────────────────────────────────────────────
  if (path === 'reconcile' && method === 'GET') {
    return json(await listReconciliations(db, assemblyId))
  }
  if (path === 'reconcile' && method === 'POST') {
    const body = (await request.json()) as {
      accountId?: string
      statementEndedOn?: string
      statementBalanceCents?: number
    }
    return json(
      await startReconciliation(
        db, assemblyId,
        {
          accountId: required(body.accountId, 'accountId'),
          statementEndedOn: required(body.statementEndedOn, 'statementEndedOn'),
          statementBalanceCents: Number(
            required(body.statementBalanceCents, 'statementBalanceCents'),
          ),
        },
        ctx.actor, ctx.now,
      ),
      201,
    )
  }

  const reconcile = /^reconcile\/([^/]+)$/.exec(path)
  if (reconcile && method === 'GET') {
    const view = await loadReconciliation(db, assemblyId, decodeURIComponent(reconcile[1]))
    return view ? json(view) : json({ error: 'No such reconciliation' }, 404)
  }

  const reconcileItem = /^reconcile\/([^/]+)\/cleared$/.exec(path)
  if (reconcileItem && (method === 'POST' || method === 'PATCH')) {
    const body = (await request.json()) as { transactionId?: string; cleared?: boolean }
    const view = await setCleared(
      db, assemblyId, decodeURIComponent(reconcileItem[1]),
      required(body.transactionId, 'transactionId'),
      body.cleared !== false,
      ctx.actor, ctx.now,
    )
    return view ? json(view) : json({ error: 'No such reconciliation' }, 404)
  }

  const reconcileStatement = /^reconcile\/([^/]+)\/statement$/.exec(path)
  if (reconcileStatement && method === 'POST') {
    const body = (await request.json()) as {
      statementEndedOn?: string
      statementBalanceCents?: number
    }
    const view = await setStatement(
      db, assemblyId, decodeURIComponent(reconcileStatement[1]),
      required(body.statementEndedOn, 'statementEndedOn'),
      Number(required(body.statementBalanceCents, 'statementBalanceCents')),
      ctx.actor, ctx.now,
    )
    return view ? json(view) : json({ error: 'No such reconciliation' }, 404)
  }

  const reconcileAction = /^reconcile\/([^/]+)\/(complete|reopen)$/.exec(path)
  if (reconcileAction && method === 'POST') {
    const run =
      reconcileAction[2] === 'complete' ? completeReconciliation : reopenReconciliation
    const view = await run(
      db, assemblyId, decodeURIComponent(reconcileAction[1]), ctx.actor, ctx.now,
    )
    return view ? json(view) : json({ error: 'No such reconciliation' }, 404)
  }

  // ── the budget ─────────────────────────────────────────────────────────
  const budget = /^budget\/(\d+|current|next)$/.exec(path)
  if (budget && method === 'GET') {
    return json(await loadBudget(db, assemblyId, budgetYear(budget[1], ctx.today), ctx.today))
  }

  const budgetLine = /^budget\/(\d+|current|next)\/line$/.exec(path)
  if (budgetLine && (method === 'PUT' || method === 'POST')) {
    const body = (await request.json()) as {
      categoryId?: string
      amountCents?: number | null
      note?: string | null
    }
    const resolved = budgetYear(budgetLine[1], ctx.today)
    // null clears the line; 0 records a decision to spend nothing. They are
    // different statements, so undefined is rejected rather than guessed at.
    if (body.amountCents === undefined) throw new BadRequest('Missing "amountCents"')
    await setBudgetLine(
      db, assemblyId, resolved,
      required(body.categoryId, 'categoryId'),
      body.amountCents === null ? null : Number(body.amountCents),
      body.note ?? null,
      ctx.actor, ctx.now,
    )
    return json(await loadBudget(db, assemblyId, resolved, ctx.today))
  }

  const budgetAction = /^budget\/(\d+|current|next)\/(propose|approve|reopen)$/.exec(path)
  if (budgetAction && method === 'POST') {
    const resolved = budgetYear(budgetAction[1], ctx.today)
    const body = (await request.json().catch(() => ({}))) as {
      fromYear?: number
      note?: string | null
    }
    if (budgetAction[2] === 'propose') {
      await proposeBudget(
        db, assemblyId, resolved,
        body.fromYear ? Number(body.fromYear) : resolved - 1,
        ctx.actor, ctx.now, ctx.today,
      )
    } else if (budgetAction[2] === 'approve') {
      await approveBudget(
        db, assemblyId, resolved, body.note ?? null, ctx.actor, ctx.now, ctx.today,
      )
    } else {
      await reopenBudget(db, assemblyId, resolved, ctx.actor, ctx.now)
    }
    return json(await loadBudget(db, assemblyId, resolved, ctx.today))
  }

  // ── choices for the entry and categorisation forms ─────────────────────
  if (path === 'choices' && method === 'GET') {
    return json(await loadChoices(db, assemblyId))
  }

  // ── ledger ─────────────────────────────────────────────────────────────
  if (path === 'ledger' && method === 'GET') {
    const q = url.searchParams
    const yearParam = q.get('year')
    return json(
      await loadLedger(db, assemblyId, {
        bahaiYear:
          yearParam === null || yearParam === 'current'
            ? bahaiYearFor(ctx.today)
            : Number(yearParam),
        monthNumber: q.get('month') ? Number(q.get('month')) : undefined,
        accountId: q.get('account') ?? undefined,
        uncategorisedOnly: q.get('uncategorised') === '1',
        search: q.get('search') ?? undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      }),
    )
  }

  // ── cash journal ───────────────────────────────────────────────────────
  const cash = /^cash\/(\d+|current)$/.exec(path)
  if (cash && method === 'GET') {
    const resolved = cash[1] === 'current' ? bahaiYearFor(ctx.today) : Number(cash[1])
    return json(await loadCashJournal(db, assemblyId, resolved))
  }

  // ── the donor vault ────────────────────────────────────────────────────
  //
  // The PIN travels in the request body on the few routes that need it, and
  // is held only in browser memory. It is never stored, never logged, and
  // never written to the audit trail.
  if (path === 'vault' && method === 'GET') {
    return json(await vaultStatus(db, assemblyId))
  }
  if (path === 'vault/setup' && method === 'POST') {
    const body = (await request.json()) as { pin?: string }
    await setupVault(db, assemblyId, required(body.pin, 'pin'), ctx.actor, ctx.now)
    return json(await vaultStatus(db, assemblyId), 201)
  }
  if (path === 'vault/unlock' && method === 'POST') {
    const body = (await request.json()) as { pin?: string }
    const ok = await verifySecret(db, assemblyId, required(body.pin, 'pin'))
    return ok
      ? json({ unlocked: true })
      : json({ error: 'That PIN does not open the donor records.' }, 403)
  }
  if (path === 'vault/pin' && method === 'POST') {
    const body = (await request.json()) as { pin?: string; newPin?: string }
    const rekeyed = await changeSecret(
      db, assemblyId,
      required(body.pin, 'pin'), required(body.newPin, 'newPin'),
      ctx.actor, ctx.now,
    )
    return json({ rekeyed })
  }
  if (path === 'vault/access-log' && method === 'GET') {
    // Readable without the PIN on purpose: oversight only the person being
    // overseen can read is not oversight.
    return json(await readAccessLog(db, assemblyId))
  }

  // ── donors ─────────────────────────────────────────────────────────────
  if (path === 'donors' && method === 'POST') {
    const body = (await request.json()) as {
      pin?: string
      name?: string
      contact?: string
      anonymous?: boolean
    }
    if (body.anonymous) {
      return json({ id: await createAnonymousDonor(db, assemblyId, ctx.actor, ctx.now) }, 201)
    }
    const id = await createDonor(
      db, assemblyId,
      {
        name: required(body.name, 'name'),
        contact: body.contact ?? null,
        secret: required(body.pin, 'pin'),
      },
      ctx.actor, ctx.now,
    )
    return json({ id }, 201)
  }
  if (path === 'donors/list' && method === 'POST') {
    const body = (await request.json()) as { pin?: string; reason?: string }
    return json(
      await listDonors(
        db, assemblyId, required(body.pin, 'pin'),
        body.reason ?? 'viewed the donor list', ctx.actor, ctx.now,
      ),
    )
  }

  // ── receipts ───────────────────────────────────────────────────────────
  if (path === 'receipts' && method === 'GET') {
    return json({
      receipts: await listReceipts(db, assemblyId),
      summary: await receiptSummary(db, assemblyId),
      awaiting: await unreceiptedGifts(db, assemblyId),
    })
  }
  // One receipt, to print and hand to someone. No donor name: resolving the
  // id is a separate, gated, logged act, and the browser does it only when the
  // vault is open.
  const oneReceipt = /^receipts\/([^/]+)$/.exec(path)
  if (oneReceipt && method === 'GET') {
    const receipt = await readReceipt(db, assemblyId, decodeURIComponent(oneReceipt[1]))
    if (!receipt) return json({ error: 'No such receipt' }, 404)
    const [assembly, letterhead] = await Promise.all([
      db.get<{ name: string }>('SELECT name FROM assemblies WHERE id = ?', [assemblyId]),
      loadLetterhead(db, assemblyId),
    ])
    return json({ receipt, assemblyName: assembly?.name ?? '', letterhead })
  }

  if (path === 'receipts' && method === 'POST') {
    const body = (await request.json()) as {
      contributionId?: string
      donorId?: string | null
      note?: string | null
      issuedOn?: string
    }
    return json(
      await issueReceipt(
        db, assemblyId,
        {
          contributionId: required(body.contributionId, 'contributionId'),
          donorId: body.donorId ?? null,
          note: body.note ?? null,
          issuedOn: body.issuedOn ?? ctx.today,
        },
        ctx.actor,
      ),
      201,
    )
  }
  const voidReceiptRoute = /^receipts\/([^/]+)\/void$/.exec(path)
  if (voidReceiptRoute && method === 'POST') {
    const body = (await request.json()) as { reason?: string }
    const view = await voidReceipt(
      db, assemblyId, decodeURIComponent(voidReceiptRoute[1]),
      required(body.reason, 'reason'), ctx.actor, ctx.now,
    )
    return view ? json(view) : json({ error: 'No such receipt' }, 404)
  }

  // ── learned rules ──────────────────────────────────────────────────────
  if (path === 'rules' && method === 'GET') {
    return json(await listRules(db, assemblyId))
  }
  const rule = /^rules\/(.+)$/.exec(path)
  if (rule && method === 'DELETE') {
    const gone = await forgetRule(db, assemblyId, decodeURIComponent(rule[1]))
    return gone ? json({ forgotten: true }) : json({ error: 'No such rule' }, 404)
  }

  // ── import ─────────────────────────────────────────────────────────────
  if (path === 'import/preview' && method === 'POST') {
    const body = (await request.json()) as {
      accountId?: string
      csvText?: string
      mapping?: ImportPreview['mapping']
    }
    return json(
      await previewImport(
        db,
        assemblyId,
        required(body.accountId, 'accountId'),
        required(body.csvText, 'csvText'),
        body.mapping ?? undefined,
      ),
    )
  }

  if (path === 'import/commit' && method === 'POST') {
    const body = (await request.json()) as {
      accountId?: string
      csvText?: string
      filename?: string
      mapping?: NonNullable<ImportPreview['mapping']>
      accept?: string[]
    }
    return json(
      await commitImport(db, assemblyId, {
        accountId: required(body.accountId, 'accountId'),
        csvText: required(body.csvText, 'csvText'),
        filename: body.filename ?? null,
        mapping: required(body.mapping, 'mapping'),
        accept: body.accept ?? [],
        actor: ctx.actor,
        now: ctx.now,
      }),
    )
  }

  // ── transactions ───────────────────────────────────────────────────────
  if (path === 'transactions' && method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>
    const amountCents = Number(required(body.amountCents as number, 'amountCents'))
    if (!Number.isInteger(amountCents)) {
      throw new BadRequest('amountCents must be an integer number of cents')
    }
    const id = await createTransaction(
      db,
      assemblyId,
      {
        accountId: required(body.accountId as string, 'accountId'),
        occurredOn: required(body.occurredOn as string, 'occurredOn'),
        amountCents,
        payee: required(body.payee as string, 'payee'),
        memo: (body.memo as string) || null,
        method: (body.method as string) || 'cash',
        kind: (body.kind as string) || 'expense',
        categoryId: (body.categoryId as string) || null,
        fundId: (body.fundId as string) || null,
      },
      ctx.actor,
      ctx.now,
    )
    return json({ id }, 201)
  }

  const categorySet = /^transactions\/([^/]+)\/category$/.exec(path)
  if (categorySet && (method === 'PATCH' || method === 'POST')) {
    const body = (await request.json()) as {
      categoryId?: string | null
      fundId?: string | null
      txnKind?: string | null
    }
    const ok = await categorise(
      db,
      assemblyId,
      decodeURIComponent(categorySet[1]),
      {
        categoryId: body.categoryId ?? null,
        fundId: body.fundId ?? null,
        txnKind: body.txnKind ?? null,
      },
      ctx.actor,
      ctx.now,
    )
    return ok ? json({ categorised: true }) : json({ error: 'No such transaction' }, 404)
  }

  return null
}
