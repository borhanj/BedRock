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
import { loadReport } from './repo/report'
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
import { forgetRule, listRules } from './repo/rules'

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
  if (report && method === 'GET') {
    const view = await loadReport(db, assemblyId, Number(report[1]), Number(report[2]))
    return view
      ? json(view)
      : json({ error: 'No report has been built for that month yet.' }, 404)
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
