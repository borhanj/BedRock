/**
 * The opening position — what the books held on the day they opened.
 *
 * A new treasurer arrives with three things that disagree: a bank statement, a
 * tin of cash, and a page from their predecessor saying what belongs to which
 * fund. This module is about the disagreement.
 *
 * **The difference is a row, not a plug.** If what is on hand does not equal
 * what the funds claim, the remainder is carried as its own line — belonging to
 * no fund, named as unexplained — and it stays there until somebody decides
 * what it is. Letting the Local Fund quietly absorb it, which is what happens
 * by default because the Local Fund is the residual of the partition, is the
 * adjusting entry `completeReconciliation` refuses on principle. A treasurer
 * who cannot reconcile an inherited mess on day one should be able to say so
 * and start work, not be held at a screen until they invent a number.
 *
 * **Deciding is an act, and acts have names on them.** Resolving the remainder
 * — assigning it to a fund, or writing it off as unrecoverable — takes a stated
 * reason and the name of whoever decided, because it is usually the Assembly
 * that decides and not the person at the keyboard.
 *
 * **Nothing is edited.** `fund_openings` is append-only and triggers enforce
 * it. Every later figure in these books is measured from the opening position,
 * so moving one silently would change what every report has already said
 * without leaving a trace of what it said before.
 *
 * **The wall can move backwards, and moving it leaves a checkpoint.** The
 * previous year's cash journal turns up in a drawer months later, and an
 * Assembly that cannot load it keeps two sets of records. Restating the
 * opening moves the date and the balances — and keeps the figure the Assembly
 * had already accepted, at the date it was true, so the history loaded
 * afterwards can be proved against it instead of merely assumed to fit.
 */

import type { Cents } from '../../lib/money'
import type { SqlDatabase, SqlStatement } from '../db/adapter'
import { setAuditActor } from '../db/adapter'

export class OpeningError extends Error {}

export interface FundOpeningView {
  readonly fundId: string
  readonly key: string
  readonly label: string
  readonly isPassthrough: boolean
  readonly openingCents: Cents
}

export interface OpeningEntry {
  readonly id: string
  /** Null is the unexplained remainder — see the module comment. */
  readonly fundId: string | null
  readonly fundLabel: string | null
  readonly amountCents: Cents
  readonly kind: 'declared' | 'resolved' | 'restated'
  readonly reason: string | null
  readonly decidedBy: string | null
  readonly occurredOn: string
}

export interface OpeningPosition {
  /** Null means these books were never formally opened. */
  readonly openedOn: string | null
  readonly funds: readonly FundOpeningView[]
  /** On hand at opening that no fund claimed. Signed; see below. */
  readonly unexplainedCents: Cents
  /** Every declaration and decision, oldest first. */
  readonly entries: readonly OpeningEntry[]
}

/**
 * What each fund opened with, and what nobody could account for.
 *
 * The remainder is signed and both signs happen. Positive is money on hand
 * that no fund claims — usually a deposit nobody recorded. Negative is the
 * worse one: the funds claim more than the Assembly actually holds, which
 * means money that was earmarked has been spent on something else. Reporting
 * it as an absolute value would hide which of those two an Assembly is
 * looking at.
 */
export async function loadOpeningPosition(
  db: SqlDatabase,
  assemblyId: string,
): Promise<OpeningPosition> {
  const [assembly, funds, entries] = await Promise.all([
    db.get<{ opened_on: string | null }>(
      'SELECT opened_on FROM assemblies WHERE id = ?',
      [assemblyId],
    ),
    db.all<{
      id: string
      key: string
      label: string
      is_passthrough: number
      opening_cents: number
    }>(
      `SELECT f.id, f.key, f.label, f.is_passthrough,
              COALESCE((SELECT SUM(o.amount_cents) FROM fund_openings o
                         WHERE o.fund_id = f.id), 0) AS opening_cents
         FROM funds f
        WHERE f.assembly_id = ?
        ORDER BY f.sort_order`,
      [assemblyId],
    ),
    db.all<{
      id: string
      fund_id: string | null
      fund_label: string | null
      amount_cents: number
      kind: 'declared' | 'resolved' | 'restated'
      reason: string | null
      decided_by: string | null
      occurred_on: string
    }>(
      `SELECT o.id, o.fund_id, f.label AS fund_label, o.amount_cents, o.kind,
              o.reason, o.decided_by, o.occurred_on
         FROM fund_openings o
         LEFT JOIN funds f ON f.id = o.fund_id
        WHERE o.assembly_id = ?
        -- Insertion order. Sorting by id would put a correction before the
        -- declaration it corrects, since "open-restate-" sorts before
        -- "open-riverbend-", and created_at alone cannot separate rows written
        -- in the same act.
        ORDER BY o.created_at, o.rowid`,
      [assemblyId],
    ),
  ])

  return {
    openedOn: assembly?.opened_on ?? null,
    funds: funds.map((f) => ({
      fundId: f.id,
      key: f.key,
      label: f.label,
      isPassthrough: f.is_passthrough === 1,
      openingCents: f.opening_cents,
    })),
    unexplainedCents: entries
      .filter((e) => e.fund_id === null)
      .reduce((sum, e) => sum + e.amount_cents, 0),
    entries: entries.map((e) => ({
      id: e.id,
      fundId: e.fund_id,
      fundLabel: e.fund_label,
      amountCents: e.amount_cents,
      kind: e.kind,
      reason: e.reason,
      decidedBy: e.decided_by,
      occurredOn: e.occurred_on,
    })),
  }
}

export interface ResolveRequest {
  /**
   * How much of the remainder is being accounted for. Signed, and must have
   * the same sign as the outstanding remainder — resolving part of a shortfall
   * cannot turn it into a surplus.
   */
  readonly amountCents: Cents
  /**
   * Where it belongs, by fund key — the same way a remittance names a fund.
   * Null means the Assembly's own money, which needs no row of its own: the
   * Local Fund is the residual of the partition and grows by exactly this much
   * the moment the remainder shrinks.
   */
  readonly toFundKey: string | null
  /** Why, in the Assembly's words. Required. */
  readonly reason: string
  /** Who decided. Usually the Assembly, minuted — not the person typing. */
  readonly decidedBy: string
  readonly occurredOn: string
}

/**
 * Account for some or all of the unexplained remainder.
 *
 * Two rows or one. Always a negative row against the remainder, reducing it.
 * Plus a positive row against the named fund — *unless* that fund is the
 * non-pass-through one, which is the Local Fund and is the residual. Writing a
 * stored opening for it as well would count the same money in two places: once
 * as its own opening and once as the residual that grew when the remainder
 * shrank. That is the single subtlety in this file and the reason the target
 * is looked up rather than trusted.
 *
 * Partial resolutions are allowed and expected. An Assembly that finds the
 * missing $120 deposit and still cannot explain the last $42.18 should be able
 * to record the part it knows.
 */
export async function resolveUnexplained(
  db: SqlDatabase,
  assemblyId: string,
  request: ResolveRequest,
  actor: string,
  now: string,
): Promise<OpeningPosition> {
  if (!request.reason.trim()) {
    throw new OpeningError(
      'A resolution needs a reason. A figure that moved with nothing beside it is ' +
        'what an auditor asks about and nobody remembers.',
    )
  }
  if (!request.decidedBy.trim()) {
    throw new OpeningError('A resolution needs the name of whoever decided.')
  }

  const position = await loadOpeningPosition(db, assemblyId)
  const outstanding = position.unexplainedCents

  if (outstanding === 0) {
    throw new OpeningError('There is nothing unexplained in the opening position.')
  }
  if (request.amountCents === 0) {
    throw new OpeningError('A resolution of nothing is not a resolution.')
  }
  if (Math.sign(request.amountCents) !== Math.sign(outstanding)) {
    throw new OpeningError(
      outstanding > 0
        ? 'The opening position holds money no fund claims, so a resolution has to be ' +
          'positive. A negative figure would say the opposite — that money is missing.'
        : 'The opening position is short: the funds claim more than the Assembly holds. ' +
          'A resolution has to be negative to reduce that shortfall.',
    )
  }
  if (Math.abs(request.amountCents) > Math.abs(outstanding)) {
    throw new OpeningError(
      `Only ${Math.abs(outstanding)} cents are unexplained; this accounts for ` +
        `${Math.abs(request.amountCents)}. Resolving more than is outstanding would ` +
        'create a discrepancy rather than close one.',
    )
  }

  let target: { id: string; is_passthrough: number } | null = null
  if (request.toFundKey) {
    target = await db.get<{ id: string; is_passthrough: number }>(
      'SELECT id, is_passthrough FROM funds WHERE assembly_id = ? AND key = ?',
      [assemblyId, request.toFundKey],
    )
    if (!target) throw new OpeningError(`No fund here is called "${request.toFundKey}".`)
  }

  await setAuditActor(db, actor)

  const stamp = now.replace(/[^0-9]/g, '')
  const statements: SqlStatement[] = [
    entryStatement({
      id: `open-res-${stamp}-remainder`,
      assemblyId,
      fundId: null,
      amountCents: -request.amountCents,
      kind: 'resolved',
      reason: request.reason.trim(),
      decidedBy: request.decidedBy.trim(),
      occurredOn: request.occurredOn,
      now,
    }),
  ]

  // The Local Fund is the residual and takes no stored opening. See above.
  if (target && target.is_passthrough === 1) {
    statements.push(
      entryStatement({
        id: `open-res-${stamp}-${target.id}`,
        assemblyId,
        fundId: target.id,
        amountCents: request.amountCents,
        kind: 'resolved',
        reason: request.reason.trim(),
        decidedBy: request.decidedBy.trim(),
        occurredOn: request.occurredOn,
        now,
      }),
    )
  }

  await db.batch(statements)
  return loadOpeningPosition(db, assemblyId)
}

interface EntryInput {
  id: string
  assemblyId: string
  fundId: string | null
  amountCents: Cents
  kind: 'declared' | 'resolved' | 'restated'
  reason: string | null
  decidedBy: string | null
  occurredOn: string
  now: string
}

/** One row of the opening ledger, ready for a batch. */
export function entryStatement(input: EntryInput): SqlStatement {
  return {
    sql: `INSERT INTO fund_openings
            (id, assembly_id, fund_id, amount_cents, kind, reason, decided_by,
             occurred_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      input.id,
      input.assemblyId,
      input.fundId,
      input.amountCents,
      input.kind,
      input.reason,
      input.decidedBy,
      input.occurredOn,
      input.now,
    ],
  }
}


export interface RestateRequest {
  /** The new, earlier day the books open. */
  readonly openedOn: string
  /** What each account held immediately before the new date, by account id. */
  readonly accounts: Readonly<Record<string, Cents>>
  /** What each fund held on the new date, by fund key. */
  readonly declared: Readonly<Record<string, Cents>>
  readonly reason: string
  readonly decidedBy: string
}

export interface RestateResult {
  readonly openedOn: string
  readonly previousOpenedOn: string
  readonly onHandAtOpeningCents: Cents
  readonly unexplainedCents: Cents
  /** What the books said before, now standing as something to prove. */
  readonly checkpoint: {
    readonly asOf: string
    readonly expectedCents: Cents
  }
}

/**
 * Move the opening date backwards and restate what was held on the new date.
 *
 * Only backwards. Moving it forwards would put transactions that are already
 * on the books on the far side of a wall that says nothing before it counts —
 * they would still be in every total while claiming not to exist, which is a
 * worse state than the one being fixed.
 *
 * Three things happen together. The accounts are restated to what they held on
 * the earlier date; the funds are restated to what they held then, as
 * append-only corrections rather than edits; and the figure the books used to
 * open with is written down as a checkpoint, because after this the old
 * opening balance is no longer a starting point — it is a claim about a date,
 * and the history about to be imported has to reproduce it.
 */
export async function restateOpening(
  db: SqlDatabase,
  assemblyId: string,
  request: RestateRequest,
  actor: string,
  now: string,
): Promise<RestateResult> {
  if (!request.reason.trim()) {
    throw new OpeningError('Restating the opening position needs a reason.')
  }
  if (!request.decidedBy.trim()) {
    throw new OpeningError('Restating the opening position needs the name of whoever decided.')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.openedOn)) {
    throw new OpeningError('The opening date must be a calendar date, as yyyy-mm-dd.')
  }

  const assembly = await db.get<{ opened_on: string | null }>(
    'SELECT opened_on FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  if (!assembly) throw new OpeningError('No such Assembly.')
  const previousOpenedOn = assembly.opened_on
  if (!previousOpenedOn) {
    throw new OpeningError(
      'These books record no opening date, so there is nothing to move. They predate ' +
        'the setup process.',
    )
  }
  if (request.openedOn >= previousOpenedOn) {
    throw new OpeningError(
      `The books already open on ${previousOpenedOn}. The date can only move earlier — ` +
        'moving it later would leave transactions already on the books sitting before a ' +
        'wall that says nothing before it counts, still in every total while claiming ' +
        'not to exist.',
    )
  }

  const accounts = await db.all<{ id: string; name: string; opening_balance_cents: number }>(
    'SELECT id, name, opening_balance_cents FROM accounts WHERE assembly_id = ?',
    [assemblyId],
  )
  for (const id of Object.keys(request.accounts)) {
    if (!accounts.some((a) => a.id === id)) {
      throw new OpeningError(`No account here has the id "${id}".`)
    }
  }

  const funds = await db.all<{ id: string; key: string; label: string; is_passthrough: number }>(
    'SELECT id, key, label, is_passthrough FROM funds WHERE assembly_id = ?',
    [assemblyId],
  )
  for (const key of Object.keys(request.declared)) {
    if (!funds.some((f) => f.key === key)) {
      throw new OpeningError(`A balance was restated for "${key}", which is not a fund here.`)
    }
  }
  assertOwnFundStated(funds, request.declared)

  // What the books currently say they opened with. This becomes the claim the
  // imported history has to land on, so it is read before anything changes.
  const previousOpeningCents = accounts.reduce((sum, a) => sum + a.opening_balance_cents, 0)

  const onHandAtOpeningCents = accounts.reduce(
    (sum, a) => sum + (request.accounts[a.id] ?? a.opening_balance_cents),
    0,
  )
  const declaredCents = Object.values(request.declared).reduce((sum, c) => sum + c, 0)
  const unexplainedCents = onHandAtOpeningCents - declaredCents

  const position = await loadOpeningPosition(db, assemblyId)
  const currentByFund = new Map(position.funds.map((f) => [f.key, f.openingCents]))

  await setAuditActor(db, actor)

  const stamp = now.replace(/[^0-9]/g, '')
  const statements: SqlStatement[] = [
    {
      sql: 'UPDATE assemblies SET opened_on = ? WHERE id = ?',
      params: [request.openedOn, assemblyId],
    },
  ]

  for (const account of accounts) {
    const restated = request.accounts[account.id]
    if (restated === undefined || restated === account.opening_balance_cents) continue
    statements.push({
      sql: 'UPDATE accounts SET opening_balance_cents = ? WHERE assembly_id = ? AND id = ?',
      params: [restated, assemblyId, account.id],
    })
  }

  // Corrections, not replacements: the sum is the answer, so each row carries
  // the difference between what the fund was said to hold and what it is now
  // said to have held on the earlier date.
  for (const fund of funds) {
    if (fund.is_passthrough !== 1) continue
    const target = request.declared[fund.key] ?? 0
    const delta = target - (currentByFund.get(fund.key) ?? 0)
    if (delta === 0) continue
    statements.push(
      entryStatement({
        id: `open-restate-${stamp}-${fund.key}`,
        assemblyId,
        fundId: fund.id,
        amountCents: delta,
        kind: 'restated',
        reason: request.reason.trim(),
        decidedBy: request.decidedBy.trim(),
        occurredOn: request.openedOn,
        now,
      }),
    )
  }

  const remainderDelta = unexplainedCents - position.unexplainedCents
  if (remainderDelta !== 0) {
    statements.push(
      entryStatement({
        id: `open-restate-${stamp}-remainder`,
        assemblyId,
        fundId: null,
        amountCents: remainderDelta,
        kind: 'restated',
        reason: request.reason.trim(),
        decidedBy: request.decidedBy.trim(),
        occurredOn: request.openedOn,
        now,
      }),
    )
  }

  statements.push({
    sql: `INSERT INTO opening_checkpoints
            (id, assembly_id, as_of, expected_cents, moved_to, reason, decided_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      `chk-${stamp}`,
      assemblyId,
      previousOpenedOn,
      previousOpeningCents,
      request.openedOn,
      request.reason.trim(),
      request.decidedBy.trim(),
      now,
    ],
  })

  await db.batch(statements)

  return {
    openedOn: request.openedOn,
    previousOpenedOn,
    onHandAtOpeningCents,
    unexplainedCents,
    checkpoint: { asOf: previousOpenedOn, expectedCents: previousOpeningCents },
  }
}

export interface CheckpointView {
  readonly id: string
  readonly asOf: string
  readonly movedTo: string
  readonly reason: string
  readonly decidedBy: string | null
  /** What the books said they held immediately before `asOf`. */
  readonly expectedCents: Cents
  /** What they say now, with everything loaded since. */
  readonly actualCents: Cents
  readonly differenceCents: Cents
  readonly holds: boolean
}

/**
 * Every checkpoint, against what the books now say.
 *
 * This is the payoff for keeping them. A checkpoint holds when the restated
 * opening plus everything dated before the old opening date lands exactly on
 * the figure the Assembly had already accepted for that date. When it does
 * not, the difference is the size of what is missing or duplicated in the
 * history that was loaded — and the amount is usually the clue, the same way
 * it is in a bank reconciliation.
 *
 * A checkpoint that does not hold is never resolved by moving the checkpoint.
 * It is resolved by finding the transactions.
 */
export async function loadCheckpoints(
  db: SqlDatabase,
  assemblyId: string,
): Promise<CheckpointView[]> {
  const rows = await db.all<{
    id: string
    as_of: string
    moved_to: string
    reason: string
    decided_by: string | null
    expected_cents: number
    actual_cents: number
  }>(
    // The balance immediately before `as_of`: what the accounts now open with,
    // plus every transaction dated strictly earlier. Strictly, because an
    // opening balance is the position before the day's first entry — the same
    // boundary loadCashJournal uses.
    `SELECT c.id, c.as_of, c.moved_to, c.reason, c.decided_by, c.expected_cents,
            (SELECT COALESCE(SUM(a.opening_balance_cents), 0) FROM accounts a
              WHERE a.assembly_id = c.assembly_id)
          + (SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
              WHERE t.assembly_id = c.assembly_id AND t.occurred_on < c.as_of)
            AS actual_cents
       FROM opening_checkpoints c
      WHERE c.assembly_id = ?
      ORDER BY c.as_of DESC, c.id`,
    [assemblyId],
  )

  return rows.map((r) => ({
    id: r.id,
    asOf: r.as_of,
    movedTo: r.moved_to,
    reason: r.reason,
    decidedBy: r.decided_by,
    expectedCents: r.expected_cents,
    actualCents: r.actual_cents,
    differenceCents: r.actual_cents - r.expected_cents,
    holds: r.actual_cents === r.expected_cents,
  }))
}

/** The day before which nothing is part of these books, or null. */
export async function openedOn(
  db: SqlDatabase,
  assemblyId: string,
): Promise<string | null> {
  const row = await db.get<{ opened_on: string | null }>(
    'SELECT opened_on FROM assemblies WHERE id = ?',
    [assemblyId],
  )
  return row?.opened_on ?? null
}


/**
 * The Assembly's own fund has to be stated, even though it is never stored.
 *
 * It is the residual of the partition, so it has no row of its own — but the
 * remainder is derived as everything on hand less everything the funds claim,
 * and leaving it out of that subtraction does not mean "nothing changes". It
 * means the whole of the Assembly's own money is declared unaccounted for.
 *
 * That is a silent, catastrophic and entirely plausible mistake: the figure is
 * absent from every table of stored openings, so a form that lists what is
 * stored will not think to ask for it. Refusing is the only way the caller
 * finds out.
 */
export function assertOwnFundStated(
  funds: ReadonlyArray<{ key: string; label: string; is_passthrough: number }>,
  declared: Readonly<Record<string, Cents>>,
): void {
  const own = funds.find((f) => f.is_passthrough === 0)
  if (!own) return
  if (own.key in declared) return

  throw new OpeningError(
    `Say what the ${own.label} held as well. It is the one fund with no stored figure — ` +
      'it is whatever is left over — so it is worked out by subtraction, and leaving it ' +
      'out would declare every penny of the Assembly’s own money unaccounted for.',
  )
}
