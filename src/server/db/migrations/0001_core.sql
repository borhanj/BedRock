-- Bedrock core schema.
--
-- Money is INTEGER cents everywhere. There is no REAL column in this file and
-- there should never be one: a treasurer's books have to foot exactly, and
-- binary floating point cannot represent $0.10.
--
-- Dates are TEXT in ISO yyyy-mm-dd, civil dates with no clock and no timezone.
-- Timestamps are ISO 8601 UTC.
--
-- Every table carries assembly_id even though there is one Assembly today, so
-- multi-tenancy later is a config change rather than a migration.
--
-- Periods are deliberately NOT stored. The nineteen months are derived from
-- src/calendar/naw-ruz-table.ts at query time. Caching them here would let the
-- database drift out of step with the calendar the moment a Naw-Rúz date is
-- corrected, and that table is the single source of truth.

CREATE TABLE assemblies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE accounts (
  id                    TEXT PRIMARY KEY,
  assembly_id           TEXT NOT NULL REFERENCES assemblies(id),
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('bank', 'cash')),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE funds (
  id             TEXT PRIMARY KEY,
  assembly_id    TEXT NOT NULL REFERENCES assemblies(id),
  key            TEXT NOT NULL,
  label          TEXT NOT NULL,
  -- Contributed to another institution, held locally, and owed upward. Drives
  -- the "belongs to other funds" figure and remittance tracking.
  is_passthrough INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (assembly_id, key)
);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  assembly_id TEXT NOT NULL REFERENCES assemblies(id),
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (assembly_id, label)
);

-- Donor identity, and nothing else.
--
-- The confidentiality principle is enforced by this table's shape: names and
-- contact details are stored as ciphertext and amounts are not stored here at
-- all. Every aggregate report reads `contributions`, which holds plaintext
-- amounts against an opaque donor_id, so income summaries, budget variance and
-- reconciliation all work without decrypting anything. Turning a donor_id back
-- into a person requires the treasurer's PIN (Phase 5) and is itself audited.
CREATE TABLE donors (
  id                TEXT PRIMARY KEY,
  assembly_id       TEXT NOT NULL REFERENCES assemblies(id),
  name_encrypted    TEXT,
  contact_encrypted TEXT,
  is_anonymous      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE transactions (
  id           TEXT PRIMARY KEY,
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id),
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  fund_id      TEXT REFERENCES funds(id),
  category_id  TEXT REFERENCES categories(id),
  occurred_on  TEXT NOT NULL,
  -- Signed: positive is money in, negative is money out.
  amount_cents INTEGER NOT NULL,
  payee        TEXT,
  memo         TEXT,
  method       TEXT NOT NULL CHECK (method IN ('bank', 'cash', 'cheque', 'card', 'other')),
  source       TEXT NOT NULL CHECK (source IN ('import', 'manual', 'cash')),
  kind         TEXT NOT NULL CHECK (kind IN ('contribution', 'expense', 'remittance', 'transfer', 'other')),
  -- Import de-duplication. Null for hand-entered rows.
  dedupe_hash  TEXT,
  -- Set when the period's report is finalised; clearing it is an explicit,
  -- audited unlock rather than an ordinary edit.
  is_locked    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX ix_transactions_date ON transactions (assembly_id, occurred_on);
CREATE INDEX ix_transactions_kind ON transactions (assembly_id, kind, occurred_on);
-- Re-importing an overlapping CSV must not double-count. Partial index so
-- hand-entered rows, which have no hash, are unaffected.
CREATE UNIQUE INDEX ux_transactions_dedupe
  ON transactions (account_id, dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

-- One bank deposit can carry contributions to several funds, so contributions
-- are children of a transaction rather than a column on it.
CREATE TABLE contributions (
  id             TEXT PRIMARY KEY,
  assembly_id    TEXT NOT NULL REFERENCES assemblies(id),
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  -- Null for a cash gift given anonymously.
  donor_id       TEXT REFERENCES donors(id),
  fund_id        TEXT NOT NULL REFERENCES funds(id),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  receipt_id     TEXT
);

CREATE INDEX ix_contributions_txn ON contributions (transaction_id);
CREATE INDEX ix_contributions_fund ON contributions (assembly_id, fund_id);

CREATE TABLE receipts (
  id           TEXT PRIMARY KEY,
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id),
  -- Gapless per Assembly. A void is marked below, never deleted, because a
  -- missing number in an audit reads as a destroyed record.
  number       INTEGER NOT NULL,
  issued_on    TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method       TEXT NOT NULL,
  fund_id      TEXT NOT NULL REFERENCES funds(id),
  donor_id     TEXT REFERENCES donors(id),
  note         TEXT,
  voided_at    TEXT,
  void_reason  TEXT,
  UNIQUE (assembly_id, number)
);

CREATE TABLE remittances (
  id             TEXT PRIMARY KEY,
  assembly_id    TEXT NOT NULL REFERENCES assemblies(id),
  fund_id        TEXT NOT NULL REFERENCES funds(id),
  transaction_id TEXT REFERENCES transactions(id),
  sent_on        TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  reference      TEXT
);

CREATE INDEX ix_remittances_date ON remittances (assembly_id, sent_on);

-- A Feast report.
--
-- bahai_year and month_number name the Feast and never move. cutoff_start and
-- cutoff_end are the reporting window and CAN move: a bank statement posting
-- late is the normal case, not an exception. They default to the calendar
-- bounds of the month and the report keeps its Feast name either way.
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  assembly_id   TEXT NOT NULL REFERENCES assemblies(id),
  bahai_year    INTEGER NOT NULL,
  month_number  INTEGER NOT NULL CHECK (month_number BETWEEN 1 AND 19),
  cutoff_start  TEXT NOT NULL,
  cutoff_end    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'presented')),
  finalized_at  TEXT,
  -- Frozen figures as presented, so a finalised report cannot silently change
  -- if a prior-period transaction is later corrected.
  snapshot_json TEXT,
  UNIQUE (assembly_id, bahai_year, month_number)
);

-- Supporting documentation, captured at entry time rather than hunted down at
-- audit. The object itself lives in R2; this row is the link and the metadata.
CREATE TABLE attachments (
  id             TEXT PRIMARY KEY,
  assembly_id    TEXT NOT NULL REFERENCES assemblies(id),
  transaction_id TEXT REFERENCES transactions(id),
  kind           TEXT NOT NULL CHECK (kind IN ('receipt_image', 'bank_statement', 'cheque_image', 'other')),
  r2_key         TEXT NOT NULL,
  filename       TEXT,
  content_type   TEXT,
  byte_size      INTEGER,
  uploaded_at    TEXT NOT NULL
);

CREATE INDEX ix_attachments_txn ON attachments (transaction_id, kind);

-- ── the audit trail ────────────────────────────────────────────────────────

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  assembly_id TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX ix_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_time ON audit_log (occurred_at);

-- Who is writing. Set once per request by setAuditActor(); read by the
-- triggers below. One row, id = 1.
CREATE TABLE audit_actor (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  actor TEXT NOT NULL
);

-- The audit trail is enforced in the database, not in the application.
--
-- An application-level convention only covers the code paths that remember to
-- follow it. These triggers fire for any write from any caller, including a
-- raw SQL console, and abort the write outright if no actor has been set. It
-- is not possible to move money in this schema without leaving a record of who
-- moved it.

-- The guard is a WHEN clause rather than a CASE inside the body, and that is
-- not a style preference. A trigger body containing `CASE ... END;` cannot be
-- split on semicolons correctly, and wrangler splits migration files on
-- semicolons before sending them to D1: it reads the CASE's `END;` as the end
-- of the trigger and ships half a statement, which D1 rejects as "incomplete
-- input". SQLite's own parser accepts either form, so this only ever fails
-- against D1 — that is, only in production.
CREATE TRIGGER trg_require_actor_transactions
BEFORE INSERT ON transactions
WHEN (SELECT actor FROM audit_actor WHERE id = 1) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'No audit actor set: call setAuditActor() before writing');
END;

CREATE TRIGGER trg_audit_transactions_insert
AFTER INSERT ON transactions
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'transactions', NEW.id, 'insert', NULL,
    json_object('occurred_on', NEW.occurred_on, 'amount_cents', NEW.amount_cents,
                'kind', NEW.kind, 'payee', NEW.payee, 'fund_id', NEW.fund_id,
                'category_id', NEW.category_id),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_transactions_update
AFTER UPDATE ON transactions
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'transactions', NEW.id, 'update',
    json_object('occurred_on', OLD.occurred_on, 'amount_cents', OLD.amount_cents,
                'kind', OLD.kind, 'payee', OLD.payee, 'fund_id', OLD.fund_id,
                'category_id', OLD.category_id, 'is_locked', OLD.is_locked),
    json_object('occurred_on', NEW.occurred_on, 'amount_cents', NEW.amount_cents,
                'kind', NEW.kind, 'payee', NEW.payee, 'fund_id', NEW.fund_id,
                'category_id', NEW.category_id, 'is_locked', NEW.is_locked),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_transactions_delete
AFTER DELETE ON transactions
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    OLD.assembly_id, 'transactions', OLD.id, 'delete',
    json_object('occurred_on', OLD.occurred_on, 'amount_cents', OLD.amount_cents,
                'kind', OLD.kind, 'payee', OLD.payee),
    NULL,
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_contributions_insert
AFTER INSERT ON contributions
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'contributions', NEW.id, 'insert', NULL,
    -- donor_id only. A donor's name is never written to the audit log.
    json_object('transaction_id', NEW.transaction_id, 'fund_id', NEW.fund_id,
                'amount_cents', NEW.amount_cents, 'donor_id', NEW.donor_id),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_contributions_delete
AFTER DELETE ON contributions
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    OLD.assembly_id, 'contributions', OLD.id, 'delete',
    json_object('transaction_id', OLD.transaction_id, 'fund_id', OLD.fund_id,
                'amount_cents', OLD.amount_cents, 'donor_id', OLD.donor_id),
    NULL,
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_receipts_insert
AFTER INSERT ON receipts
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'receipts', NEW.id, 'insert', NULL,
    json_object('number', NEW.number, 'issued_on', NEW.issued_on,
                'amount_cents', NEW.amount_cents, 'fund_id', NEW.fund_id),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_receipts_update
AFTER UPDATE ON receipts
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'receipts', NEW.id, 'update',
    json_object('number', OLD.number, 'amount_cents', OLD.amount_cents, 'voided_at', OLD.voided_at),
    json_object('number', NEW.number, 'amount_cents', NEW.amount_cents, 'voided_at', NEW.voided_at),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- Receipts are never deleted. Void them instead, so the sequence stays gapless.
CREATE TRIGGER trg_receipts_no_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'Receipts cannot be deleted. Set voided_at to void one, so the numbering stays gapless.');
END;

CREATE TRIGGER trg_audit_remittances_insert
AFTER INSERT ON remittances
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'remittances', NEW.id, 'insert', NULL,
    json_object('fund_id', NEW.fund_id, 'sent_on', NEW.sent_on,
                'amount_cents', NEW.amount_cents, 'reference', NEW.reference),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- A locked transaction belongs to a finalised report. Editing it requires an
-- explicit unlock, which is itself an audited update.
CREATE TRIGGER trg_transactions_locked
BEFORE UPDATE ON transactions
WHEN OLD.is_locked = 1 AND NEW.is_locked = 1
BEGIN
  SELECT RAISE(ABORT, 'This period is closed. Unlock the report before editing its transactions.');
END;
