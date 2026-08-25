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
      error instanceof ReconcileError
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
