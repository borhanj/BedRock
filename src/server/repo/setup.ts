/**
 * Opening a new Assembly's books.
 *
 * Until this module existed there was exactly one way to get an Assembly into
 * a Bedrock database: run the seed, which writes a fictional community's
 * worked year. A treasurer installing this for the first time got a 500 on the
 * dashboard and no way forward.
 *
 * What a real treasurer actually has on day one is a bank statement, a tin
 * with some money in it, and a page from their predecessor saying what belongs
 * to which fund. Those three rarely agree. The whole design of this module is
 * about that: it takes what the treasurer can state, works out what it implies,
 * and where the figures disagree it records the disagreement instead of
 * resolving it. See repo/opening.ts for what happens to the difference.
 *
 * **Nothing is assumed.** No funds, no categories, no accounts are created
 * unless the Assembly asked for them. `SUGGESTED_FUNDS` and
 * `SUGGESTED_CATEGORIES` are offered to the setup screen as a starting list to
 * tick, never applied silently — how a particular community organises its
 * giving is its own business and not a default this software should hold an
 * opinion about.
 *
 * **It refuses to run over existing books**, for the same reason the restore
 * does. Setting up on top of a live database is the operation most likely to
 * be reached for by mistake and most likely to destroy something.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase, SqlStatement } from '../db/adapter'
import { setAuditActor } from '../db/adapter'
import { assertOwnFundStated, entryStatement } from './opening'

export class SetupError extends Error {}

/**
 * Funds an Assembly may keep, offered as a list to choose from.
 *
 * Pass-through means the money is received locally and owed upward to another
 * institution — it is never the Assembly's to spend. Only the Local Fund is.
 *
 * This list is a convenience, not a statement about Bahá'í administration. An
 * Assembly ticks what it actually keeps and adds anything missing, and nothing
 * here is created unless it does.
 */
export const SUGGESTED_FUNDS: ReadonlyArray<{
  key: string
  label: string
  isPassthrough: boolean
  note: string
}> = [
  {
    key: 'local',
    label: 'Local Fund',
    isPassthrough: false,
    note: "The Assembly's own money, and the only fund it may spend. Required.",
  },
  {
    key: 'national',
    label: 'National Fund',
    isPassthrough: true,
    note: 'Received locally, forwarded to the National Spiritual Assembly.',
  },
  {
    key: 'continental',
    label: 'Continental Fund',
    isPassthrough: true,
    note: 'Received locally, forwarded onward.',
  },
  {
    key: 'international',
    label: "Bahá'í International Fund",
    isPassthrough: true,
    note: 'Received locally, forwarded onward.',
  },
  {
    key: 'huququllah',
    label: "Huqúqu'lláh",
    isPassthrough: true,
    note:
      'Kept separate from the funds and forwarded to the Trustees. Many Assemblies ' +
      'never handle it at all; tick it only if yours does.',
  },
]

/** Expense categories most Assemblies end up with. Suggestions only. */
export const SUGGESTED_CATEGORIES: ReadonlyArray<{
  label: string
  kind: 'income' | 'expense'
}> = [
  { label: 'Rent / facility use', kind: 'expense' },
  { label: 'Feast hospitality', kind: 'expense' },
  { label: 'Utilities', kind: 'expense' },
  { label: "Children's classes", kind: 'expense' },
  { label: 'Holy Day observance', kind: 'expense' },
  { label: 'Deepening materials', kind: 'expense' },
  { label: 'Proclamation', kind: 'expense' },
  { label: 'Travel / institute', kind: 'expense' },
  { label: 'Administrative supplies', kind: 'expense' },
  { label: 'Bank fees', kind: 'expense' },
]

export interface SetupFund {
  readonly key: string
  readonly label: string
  readonly isPassthrough: boolean
}

export interface SetupAccount {
  readonly name: string
  readonly kind: 'bank' | 'cash'
  /** What it held on the opening date, as the statement or the count says. */
  readonly openingBalanceCents: Cents
}

export interface SetupCategory {
  readonly label: string
  readonly kind: 'income' | 'expense'
  /** Income only: which fund this category feeds. */
  readonly fundKey?: string
}

export interface SetupRequest {
  readonly assemblyName: string
  readonly shortName: string
  /**
   * The day the books open. A wall: nothing before it is part of these books.
   * It can be moved backwards later if the previous year's journal turns up.
   */
  readonly openedOn: string
  readonly funds: readonly SetupFund[]
  readonly accounts: readonly SetupAccount[]
  readonly categories: readonly SetupCategory[]
  /**
   * What the treasurer says each fund held on the opening date, by fund key.
   * Funds left out are taken as holding nothing, which is a statement too.
   */
  readonly declared: Readonly<Record<string, Cents>>
  /** Whose figures these are — usually the outgoing treasurer. */
  readonly declaredBy: string
}

export interface SetupResult {
  readonly assemblyId: string
  readonly openedOn: string
  readonly onHandCents: Cents
  /** What the funds were declared to hold, in total. */
  readonly declaredCents: Cents
  /**
   * On hand that no fund claimed. Zero means the statement and the funds
   * agreed, which is the happy case and not the common one.
   */
  readonly unexplainedCents: Cents
  readonly funds: number
  readonly accounts: number
  readonly categories: number
}

/** Whether these books have been opened, and what to offer if not. */
export async function setupStatus(db: SqlDatabase, assemblyId: string) {
  const assembly = await db.get<{ id: string; name: string; opened_on: string | null }>(
    'SELECT id, name, opened_on FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  return {
    assemblyId,
    isSetUp: assembly !== null,
    assemblyName: assembly?.name ?? null,
    openedOn: assembly?.opened_on ?? null,
    suggestedFunds: SUGGESTED_FUNDS,
    suggestedCategories: SUGGESTED_CATEGORIES,
  }
}

/**
 * Open the books.
 *
 * One act, one batch. Everything below is written together or none of it is:
 * an Assembly with funds but no accounts, or accounts but no opening position,
 * is a half-built state nobody should have to diagnose.
 */
export async function setUpAssembly(
  db: SqlDatabase,
  assemblyId: string,
  request: SetupRequest,
  actor: string,
  now: string,
): Promise<SetupResult> {
  const existing = await db.get<{ id: string }>('SELECT id FROM assemblies WHERE id = ?', [
    assemblyId,
  ])
  if (existing) {
    throw new SetupError(
      'These books already exist. Setting up over them would overwrite an Assembly ' +
        'that is already keeping records here — if that is really what you want, ' +
        'restore into an empty deployment instead.',
    )
  }

  validate(request)

  const onHandCents = request.accounts.reduce((sum, a) => sum + a.openingBalanceCents, 0)
  const declaredCents = Object.values(request.declared).reduce((sum, c) => sum + c, 0)

  // What no fund claimed. Signed on purpose: positive is money on hand nobody
  // has accounted for, negative is funds claiming more than the Assembly holds
  // — which is the worse of the two and must not be reported as the same
  // thing. See repo/opening.ts.
  const unexplainedCents = onHandCents - declaredCents

  const fundIds = new Map(request.funds.map((f) => [f.key, `fund-${assemblyId}-${f.key}`]))

  await setAuditActor(db, actor)

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO assemblies (id, name, short_name, created_at, opened_on)
            VALUES (?, ?, ?, ?, ?)`,
      params: [
        assemblyId,
        request.assemblyName.trim(),
        request.shortName.trim(),
        now,
        request.openedOn,
      ],
    },
  ]

  request.funds.forEach((fund, i) => {
    statements.push({
      sql: `INSERT INTO funds (id, assembly_id, key, label, is_passthrough, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        fundIds.get(fund.key)!,
        assemblyId,
        fund.key,
        fund.label.trim(),
        fund.isPassthrough ? 1 : 0,
        i,
      ],
    })
  })

  request.accounts.forEach((account, i) => {
    statements.push({
      sql: `INSERT INTO accounts
              (id, assembly_id, name, kind, opening_balance_cents, is_active)
            VALUES (?, ?, ?, ?, ?, 1)`,
      params: [
        `acct-${assemblyId}-${account.kind}-${i}`,
        assemblyId,
        account.name.trim(),
        account.kind,
        account.openingBalanceCents,
      ],
    })
  })

  request.categories.forEach((category, i) => {
    statements.push({
      sql: `INSERT INTO categories
              (id, assembly_id, label, kind, fund_id, sort_order, is_archived)
            VALUES (?, ?, ?, ?, ?, ?, 0)`,
      params: [
        `cat-${assemblyId}-${i}`,
        assemblyId,
        category.label.trim(),
        category.kind,
        category.fundKey ? (fundIds.get(category.fundKey) ?? null) : null,
        i,
      ],
    })
  })

  // Only pass-through funds get a stored opening. The Local Fund is the
  // residual of the partition in repo/funds.ts, so a stored opening for it
  // would count the same money twice — once as its own figure and once as
  // whatever is left over. What the treasurer declared for it is not lost: it
  // is in the audit entry below, which is where a statement of belief belongs.
  for (const fund of request.funds) {
    if (!fund.isPassthrough) continue
    const amount = request.declared[fund.key] ?? 0
    if (amount === 0) continue
    statements.push(
      entryStatement({
        id: `open-${assemblyId}-${fund.key}`,
        assemblyId,
        fundId: fundIds.get(fund.key)!,
        amountCents: amount,
        kind: 'declared',
        reason: null,
        decidedBy: request.declaredBy.trim() || actor,
        occurredOn: request.openedOn,
        now,
      }),
    )
  }

  if (unexplainedCents !== 0) {
    statements.push(
      entryStatement({
        id: `open-${assemblyId}-unexplained`,
        assemblyId,
        fundId: null,
        amountCents: unexplainedCents,
        kind: 'declared',
        reason: null,
        decidedBy: request.declaredBy.trim() || actor,
        occurredOn: request.openedOn,
        now,
      }),
    )
  }

  // The declaration as it was made, kept whole.
  //
  // The per-fund rows above are the arithmetic; this is the statement. It
  // holds the figure declared for the Local Fund, which has no row of its own,
  // so a later reader can see what the treasurer actually said rather than
  // only what the partition derived from it.
  statements.push({
    sql: `INSERT INTO audit_log
            (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
          VALUES (?, 'setup', ?, 'insert', NULL, ?, ?, ?)`,
    params: [
      assemblyId,
      assemblyId,
      JSON.stringify({
        opened_on: request.openedOn,
        declared_by: request.declaredBy.trim(),
        on_hand_cents: onHandCents,
        declared: request.declared,
        unexplained_cents: unexplainedCents,
        accounts: request.accounts.length,
        funds: request.funds.length,
        categories: request.categories.length,
      }),
      actor,
      now,
    ],
  })

  await db.batch(statements)

  return {
    assemblyId,
    openedOn: request.openedOn,
    onHandCents,
    declaredCents,
    unexplainedCents,
    funds: request.funds.length,
    accounts: request.accounts.length,
    categories: request.categories.length,
  }
}

function validate(request: SetupRequest): void {
  if (!request.assemblyName.trim()) throw new SetupError('The Assembly needs a name.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.openedOn)) {
    throw new SetupError('The opening date must be a calendar date, as yyyy-mm-dd.')
  }
  if (request.funds.length === 0) {
    throw new SetupError('An Assembly needs at least the Local Fund.')
  }
  if (request.accounts.length === 0) {
    throw new SetupError(
      'An Assembly needs somewhere to keep money — at least one bank account or a cash box.',
    )
  }

  // Exactly one, and it is a structural requirement rather than a preference.
  // `loadFundBalances` builds the partition by treating the single
  // non-pass-through fund as the residual — what is left once other
  // institutions' money and the tin are set aside. A second one would not
  // appear in the partition at all, and its money would be silently absorbed
  // by the first. There is no error the treasurer could see afterwards; the
  // figures would simply be wrong.
  const own = request.funds.filter((f) => !f.isPassthrough)
  if (own.length === 0) {
    throw new SetupError(
      'One fund has to be the Assembly’s own — the money it may actually spend. ' +
        'Every other fund is held for someone else.',
    )
  }
  if (own.length > 1) {
    throw new SetupError(
      `Only one fund can be the Assembly's own; ${own.map((f) => f.label).join(' and ')} ` +
        'are both marked that way. The rest are held for another institution and owed ' +
        'upward. Bedrock works out the Assembly’s own balance as whatever is left ' +
        'after those, so a second one would have no balance of its own.',
    )
  }

  const keys = new Set<string>()
  for (const fund of request.funds) {
    if (!fund.key.trim() || !fund.label.trim()) {
      throw new SetupError('Every fund needs a key and a label.')
    }
    if (keys.has(fund.key)) throw new SetupError(`Two funds share the key "${fund.key}".`)
    keys.add(fund.key)
  }

  for (const key of Object.keys(request.declared)) {
    if (!keys.has(key)) {
      throw new SetupError(`A balance was declared for "${key}", which is not a fund here.`)
    }
  }
  assertOwnFundStated(
    request.funds.map((f) => ({
      key: f.key,
      label: f.label,
      is_passthrough: f.isPassthrough ? 1 : 0,
    })),
    request.declared,
  )

  for (const category of request.categories) {
    if (category.fundKey && !keys.has(category.fundKey)) {
      throw new SetupError(
        `The category "${category.label}" feeds a fund that does not exist here.`,
      )
    }
    if (category.kind === 'expense' && category.fundKey) {
      throw new SetupError(
        `"${category.label}" is an expense, so it cannot name a fund it feeds. ` +
          'Only income categories do that.',
      )
    }
  }

  const labels = new Set<string>()
  for (const category of request.categories) {
    if (labels.has(category.label)) {
      throw new SetupError(`Two categories are both called "${category.label}".`)
    }
    labels.add(category.label)
  }
}
