-- Moving the wall backwards.
--
-- The books open on a date and nothing before it counts. That is the right
-- default and the wrong permanent arrangement: the previous year's cash
-- journal turns up in a drawer three months later, and an Assembly that
-- cannot load it has to keep two sets of records — the thing this software
-- exists to stop.
--
-- Restating the opening position is that act. It moves the date, restates what
-- the accounts held on the new earlier date, and leaves behind a checkpoint:
-- the figure the Assembly had already accepted as true, at the date it was
-- true, so the history loaded afterwards can be proved against it rather than
-- merely assumed to fit.

-- An opening balance is the single most load-bearing figure in the books:
-- every later balance is it plus everything since. Until now it could be
-- changed with no trace at all — `accounts` was the one table carrying money
-- with no audit triggers on it. That was survivable while nothing ever wrote
-- to it after setup. Restatement writes to it, so it is not survivable now.
CREATE TRIGGER trg_require_actor_accounts
BEFORE INSERT ON accounts
WHEN (SELECT actor FROM audit_actor WHERE id = 1) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'No audit actor set: call setAuditActor() before writing');
END;

CREATE TRIGGER trg_audit_accounts_insert
AFTER INSERT ON accounts
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'accounts', NEW.id, 'insert', NULL,
    json_object('name', NEW.name, 'kind', NEW.kind,
                'opening_balance_cents', NEW.opening_balance_cents,
                'is_active', NEW.is_active),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_accounts_update
AFTER UPDATE ON accounts
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'accounts', NEW.id, 'update',
    json_object('name', OLD.name,
                'opening_balance_cents', OLD.opening_balance_cents,
                'is_active', OLD.is_active),
    json_object('name', NEW.name,
                'opening_balance_cents', NEW.opening_balance_cents,
                'is_active', NEW.is_active),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- A figure the Assembly has already accepted, kept so it can be proved later.
--
-- When the wall moves from 1 August back to Naw-Rúz, the old opening balance
-- does not become wrong — it becomes a claim about 1 August that the newly
-- loaded history has to reproduce. If the transactions between Naw-Rúz and 1
-- August, added to the restated opening, do not land on it, something in
-- between is missing or duplicated.
--
-- Storing it is what makes that check possible at any later moment rather than
-- only in the minutes after the restatement. Discarding it would throw away
-- the one independent figure available — every other number in the books after
-- a restatement is derived from the restatement itself.
CREATE TABLE opening_checkpoints (
  id            TEXT PRIMARY KEY,
  assembly_id   TEXT NOT NULL REFERENCES assemblies(id),
  -- The books held `expected_cents` immediately before this date.
  as_of         TEXT NOT NULL,
  expected_cents INTEGER NOT NULL,
  -- What the wall moved to, so a reader can see which act created this.
  moved_to      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  decided_by    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX ix_opening_checkpoints ON opening_checkpoints (assembly_id, as_of);

CREATE TRIGGER trg_require_actor_opening_checkpoints
BEFORE INSERT ON opening_checkpoints
WHEN (SELECT actor FROM audit_actor WHERE id = 1) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'No audit actor set: call setAuditActor() before writing');
END;

CREATE TRIGGER trg_audit_opening_checkpoints_insert
AFTER INSERT ON opening_checkpoints
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'opening_checkpoints', NEW.id, 'insert', NULL,
    json_object('as_of', NEW.as_of, 'expected_cents', NEW.expected_cents,
                'moved_to', NEW.moved_to, 'reason', NEW.reason,
                'decided_by', NEW.decided_by),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- A checkpoint is a record that a figure was once accepted. Editing or
-- deleting one would remove the only independent thing left to check the
-- restated books against.
CREATE TRIGGER trg_opening_checkpoints_no_update
BEFORE UPDATE ON opening_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'A checkpoint records what the books already said. It cannot be edited.');
END;

CREATE TRIGGER trg_opening_checkpoints_no_delete
BEFORE DELETE ON opening_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'A checkpoint records what the books already said. It cannot be deleted.');
END;
