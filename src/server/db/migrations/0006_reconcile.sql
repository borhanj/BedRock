-- Bank reconciliation: proving the ledger against the statement.

-- One statement, checked off.
--
-- A reconciliation is balanced only when the difference is exactly zero. There
-- is deliberately no adjustment, plug or force-balance anywhere in this
-- schema: a plug entry makes the books agree with the bank while hiding the
-- reason they did not, which is the one thing reconciliation exists to find.
CREATE TABLE reconciliations (
  id                      TEXT PRIMARY KEY,
  assembly_id             TEXT NOT NULL REFERENCES assemblies(id),
  account_id              TEXT NOT NULL REFERENCES accounts(id),
  statement_ended_on      TEXT NOT NULL,
  statement_balance_cents INTEGER NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('open', 'balanced')),
  completed_at            TEXT,
  completed_by            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (assembly_id, account_id, statement_ended_on)
);

CREATE INDEX ix_reconciliations_account
  ON reconciliations (assembly_id, account_id, statement_ended_on);

-- Which rows the bank has actually processed.
--
-- A child table rather than a `cleared_on` column on `transactions`, for a
-- reason worth stating: closing a Feast report locks its transactions, and
-- trg_transactions_locked aborts any update to a locked row. But whether the
-- bank has processed a cheque is a fact about the bank, not an edit to the
-- books — a payment made in Kamál may well clear in ʿIzzat, long after that
-- report is presented. Storing it here means reconciliation never has to touch
-- a locked row, and the lock never has to be weakened to let it.
CREATE TABLE reconciliation_items (
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  transaction_id    TEXT NOT NULL REFERENCES transactions(id),
  cleared_on        TEXT NOT NULL,
  PRIMARY KEY (reconciliation_id, transaction_id)
);

-- A transaction clears the bank once. Without this a row could be ticked on
-- two statements and counted twice toward the reconciled balance.
CREATE UNIQUE INDEX ux_reconciliation_items_txn
  ON reconciliation_items (transaction_id);

CREATE TRIGGER trg_require_actor_reconciliations
BEFORE INSERT ON reconciliations
BEGIN
  SELECT CASE WHEN (SELECT actor FROM audit_actor WHERE id = 1) IS NULL
    THEN RAISE(ABORT, 'No audit actor set: call setAuditActor() before writing')
  END;
END;

CREATE TRIGGER trg_audit_reconciliations_insert
AFTER INSERT ON reconciliations
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'reconciliations', NEW.id, 'insert', NULL,
    json_object('account_id', NEW.account_id,
                'statement_ended_on', NEW.statement_ended_on,
                'statement_balance_cents', NEW.statement_balance_cents,
                'status', NEW.status),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_reconciliations_update
AFTER UPDATE ON reconciliations
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'reconciliations', NEW.id, 'update',
    json_object('statement_balance_cents', OLD.statement_balance_cents,
                'status', OLD.status, 'completed_at', OLD.completed_at),
    json_object('statement_balance_cents', NEW.statement_balance_cents,
                'status', NEW.status, 'completed_at', NEW.completed_at),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- A balanced reconciliation is a statement made: these books agreed with that
-- bank statement on that date. Reopening it is a deliberate, audited act, and
-- ticking a row inside one behind its back is not an act at all.

CREATE TRIGGER trg_reconciliation_items_balanced_insert
BEFORE INSERT ON reconciliation_items
WHEN (SELECT status FROM reconciliations WHERE id = NEW.reconciliation_id) = 'balanced'
BEGIN
  SELECT RAISE(ABORT, 'This reconciliation is balanced. Reopen it before changing what has cleared.');
END;

CREATE TRIGGER trg_reconciliation_items_balanced_delete
BEFORE DELETE ON reconciliation_items
WHEN (SELECT status FROM reconciliations WHERE id = OLD.reconciliation_id) = 'balanced'
BEGIN
  SELECT RAISE(ABORT, 'This reconciliation is balanced. Reopen it before changing what has cleared.');
END;

-- A balanced reconciliation is not deleted, for the same reason a receipt is
-- not: its absence would read as a check that was never run.
CREATE TRIGGER trg_reconciliations_no_delete_balanced
BEFORE DELETE ON reconciliations
WHEN OLD.status = 'balanced'
BEGIN
  SELECT RAISE(ABORT, 'A balanced reconciliation cannot be deleted. Reopen it instead.');
END;
