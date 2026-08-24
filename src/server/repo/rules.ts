/**
 * Learned categorisation.
 *
 * The rule this module obeys, and the reason it never writes a category
 * directly: a suggestion the treasurer confirms is a labour saving, and a
 * category applied silently is a number in the books that nobody chose. Every
 * function here either returns a suggestion or records one the treasurer has
 * already accepted.
 */

import { normalizeDescription } from '../import/dedupe'
import type { SqlDatabase } from '../db/adapter'

export interface Suggestion {
  readonly categoryId: string | null
  readonly categoryLabel: string | null
  readonly fundId: string | null
  readonly txnKind: string | null
  /** Why this was suggested, shown to the treasurer verbatim. */
  readonly because: string
  readonly ruleId: string
}

interface RuleRow {
  id: string
  pattern: string
  match_kind: 'exact' | 'contains'
  category_id: string | null
  category_label: string | null
  fund_id: string | null
  txn_kind: string | null
  hit_count: number
}

async function allRules(db: SqlDatabase, assemblyId: string): Promise<RuleRow[]> {
  return db.all<RuleRow>(
    `SELECT r.id, r.pattern, r.match_kind, r.category_id, r.fund_id, r.txn_kind,
            r.hit_count, c.label AS category_label
       FROM rules r
       LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.assembly_id = ?
      ORDER BY r.hit_count DESC`,
    [assemblyId],
  )
}

function match(rule: RuleRow, normalised: string): boolean {
  if (rule.match_kind === 'exact') return rule.pattern === normalised
  return normalised.includes(rule.pattern)
}

/**
 * The best rule for a payee, or null.
 *
 * An exact match always beats a substring match — "city water" should not win
 * over "city water utility co" when the latter matches exactly. Within a kind,
 * the rule the treasurer has accepted most often wins, then the longest
 * (most specific) pattern.
 */
export function suggestFrom(rules: readonly RuleRow[], payee: string): Suggestion | null {
  const normalised = normalizeDescription(payee)
  if (normalised === '') return null

  const matches = rules.filter((r) => match(r, normalised))
  if (matches.length === 0) return null

  matches.sort((a, b) => {
    if (a.match_kind !== b.match_kind) return a.match_kind === 'exact' ? -1 : 1
    if (a.hit_count !== b.hit_count) return b.hit_count - a.hit_count
    return b.pattern.length - a.pattern.length
  })

  const best = matches[0]
  return {
    categoryId: best.category_id,
    categoryLabel: best.category_label,
    fundId: best.fund_id,
    txnKind: best.txn_kind,
    because:
      best.match_kind === 'exact'
        ? `you categorised "${best.pattern}" this way before`
        : `"${best.pattern}" appears in the description`,
    ruleId: best.id,
  }
}

/** Suggestions for a batch of payees, reading the rule table once. */
export async function suggestForAll(
  db: SqlDatabase,
  assemblyId: string,
  payees: readonly string[],
): Promise<Array<Suggestion | null>> {
  const rules = await allRules(db, assemblyId)
  return payees.map((payee) => suggestFrom(rules, payee))
}

/**
 * Record that the treasurer categorised this payee this way.
 *
 * Stored as an exact match on the normalised payee: narrow, predictable, and
 * easy to explain. Broader `contains` rules exist in the schema but are only
 * ever created deliberately by the treasurer, never inferred — guessing that
 * a shared word implies a shared category is how auto-categorisation starts
 * miscategorising.
 */
export async function learn(
  db: SqlDatabase,
  assemblyId: string,
  payee: string,
  target: { categoryId: string | null; fundId: string | null; txnKind: string | null },
  now: string,
): Promise<void> {
  const pattern = normalizeDescription(payee)
  if (pattern === '') return

  await db.run(
    `INSERT INTO rules
       (id, assembly_id, pattern, match_kind, category_id, fund_id, txn_kind,
        hit_count, created_at, last_used_at)
     VALUES (?, ?, ?, 'exact', ?, ?, ?, 1, ?, ?)
     ON CONFLICT (assembly_id, pattern, match_kind) DO UPDATE SET
       category_id  = excluded.category_id,
       fund_id      = excluded.fund_id,
       txn_kind     = excluded.txn_kind,
       hit_count    = rules.hit_count + 1,
       last_used_at = excluded.last_used_at`,
    [
      `rule-${assemblyId}-${pattern}`.slice(0, 120),
      assemblyId,
      pattern,
      target.categoryId,
      target.fundId,
      target.txnKind,
      now,
      now,
    ],
  )
}

export interface RuleView {
  readonly id: string
  readonly pattern: string
  readonly matchKind: 'exact' | 'contains'
  readonly categoryLabel: string | null
  readonly hitCount: number
}

/** The learned rules, for a treasurer to review and prune. */
export async function listRules(
  db: SqlDatabase,
  assemblyId: string,
): Promise<RuleView[]> {
  const rows = await allRules(db, assemblyId)
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    matchKind: r.match_kind,
    categoryLabel: r.category_label,
    hitCount: r.hit_count,
  }))
}

export async function forgetRule(
  db: SqlDatabase,
  assemblyId: string,
  ruleId: string,
): Promise<boolean> {
  const result = await db.run('DELETE FROM rules WHERE assembly_id = ? AND id = ?', [
    assemblyId,
    ruleId,
  ])
  return result.changes > 0
}
