-- Opening the books.
--
-- Everything before this migration assumes the books already exist. They do
-- for Riverbend, because the fixture wrote them; they do not for an Assembly
-- installing this for the first time, which has a bank balance, a tin with
-- some money in it, and a page from the last treasurer saying what belongs to
-- which fund. Those three things rarely agree, and making them agree is not
-- the software's decision to take.

-- The day the books opened. NULL means they never formally were — true of any
-- database that predates this migration, and worth being able to say.
--
-- It is a wall: nothing dated before it is part of these books. The wall can
-- be moved backwards later, when the previous year's cash journal turns up in
-- a drawer, which is a restatement of the opening position rather than an
-- ordinary edit.
ALTER TABLE assemblies ADD COLUMN opened_on TEXT;

-- What each fund held on the day the books opened, and what nobody could
-- account for.
--
-- Append-only, and the sum is the answer. A declaration that turns out to be
-- wrong is corrected by appending a correction that says why, never by editing
-- the original — the same reason a receipt is voided rather than deleted. The
-- history of what the Assembly believed, and when it changed its mind, is
-- itself part of the record.
--
-- A NULL fund_id is the row this table exists for: money that was on hand at
-- opening and that no fund claimed. It is deliberately not a fund, because
-- assigning it to one is the very decision nobody has taken yet. Bedrock
-- carries it as its own line until someone decides, and the alternative —
-- letting the Local Fund absorb it, since the Local Fund is the residual — is
-- the plug that `completeReconciliation` refuses on principle, arrived at from
-- the other direction.
--
-- The Local Fund gets no row here. It is the residual of the partition in
-- repo/funds.ts, so giving it a stored opening as well would count the same
-- money twice. What the treasurer states for it at setup is an input to
-- deriving the unexplained remainder, and is recorded in the audit trail as
-- part of the declaration.
CREATE TABLE fund_openings (
  id           TEXT PRIMARY KEY,
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id),
  -- NULL is the unexplained remainder. See above.
  fund_id      TEXT REFERENCES funds(id),
  amount_cents INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('declared', 'resolved', 'restated')),
  -- Why, in the treasurer's own words. Required for anything that changes a
  -- figure the Assembly has already been shown: a number that moved with no
  -- reason beside it is the thing an auditor asks about and nobody remembers.
  reason       TEXT,
  -- Who decided. For a declaration this is the treasurer; for a resolution it
  -- is whoever the Assembly minuted, which is often not the same person as the
  -- one operating the software.
  decided_by   TEXT,
  occurred_on  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK (kind = 'declared' OR (reason IS NOT NULL AND TRIM(reason) <> ''))
);

CREATE INDEX ix_fund_openings ON fund_openings (assembly_id, fund_id);

CREATE TRIGGER trg_require_actor_fund_openings
BEFORE INSERT ON fund_openings
WHEN (SELECT actor FROM audit_actor WHERE id = 1) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'No audit actor set: call setAuditActor() before writing');
END;

CREATE TRIGGER trg_audit_fund_openings_insert
AFTER INSERT ON fund_openings
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'fund_openings', NEW.id, 'insert', NULL,
    json_object('fund_id', NEW.fund_id,
                'amount_cents', NEW.amount_cents,
                'kind', NEW.kind,
                'reason', NEW.reason,
                'decided_by', NEW.decided_by,
                'occurred_on', NEW.occurred_on),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- Append-only, enforced here rather than by convention.
--
-- The opening position is what every later figure is measured from. An UPDATE
-- would move a starting point that the Feast reports, the fund balances and
-- the audit package have all already been computed against, leaving no trace
-- of what they were computed against before. A DELETE would remove the record
-- that a gap ever existed, which is precisely the fact worth keeping.
CREATE TRIGGER trg_fund_openings_no_update
BEFORE UPDATE ON fund_openings
BEGIN
  SELECT RAISE(ABORT,
    'An opening figure cannot be edited. Append a correction that says why instead.');
END;

CREATE TRIGGER trg_fund_openings_no_delete
BEFORE DELETE ON fund_openings
BEGIN
  SELECT RAISE(ABORT,
    'An opening figure cannot be deleted. Append a correction that says why instead.');
END;
