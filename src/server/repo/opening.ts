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
        ORDER BY o.created_at, o.id`,
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
