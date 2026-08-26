-- Settings, a letterhead, and starting over.
--
-- Three things a treasurer needs that the books themselves do not: somewhere to
-- correct what was typed during setup, somewhere to put the Assembly's
-- letterhead so a receipt looks like it came from them, and a way to clear a
-- database that was only ever filled with a demonstration.

-- The Assembly's letterhead, for the top of a receipt.
--
-- Its own table rather than a column on `assemblies`, because it is a hundred
-- kilobytes of image and that row is read by every screen in the app to put a
-- name in the top-left corner. A blob living there would be fetched thousands
-- of times a year to be discarded.
--
-- Stored as a data URL. R2 is the right home for files and is where receipt
-- images will go, but it needs a bucket and a binding that this deployment does
-- not have, and a feature that ships dark is not a feature. One logo per
-- Assembly is small enough that the database is an honest place for it; a
-- thousand receipt photographs would not be.
CREATE TABLE branding (
  assembly_id          TEXT PRIMARY KEY REFERENCES assemblies(id),
  letterhead_data_url  TEXT,
  -- What the treasurer called the file, so the settings screen can say which
  -- image is loaded without decoding it.
  letterhead_filename  TEXT,
  letterhead_bytes     INTEGER,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT
);

-- Standing the guards down, deliberately and briefly.
--
-- Six triggers in this schema refuse a DELETE: receipts, approved budget lines,
-- balanced reconciliations and their items, opening figures and checkpoints.
-- Every one of them is right — each protects a record whose absence would read
-- to an auditor as evidence destroyed.
--
-- Clearing the database entirely is the one operation where that reasoning does
-- not apply. Deleting a receipt leaves a hole in a book; deleting the book is a
-- different act, and one an Assembly is entitled to perform on a database that
-- holds a demonstration rather than its accounts.
--
-- So the guards consult a flag instead of being dropped and recreated at
-- runtime. The flag is set inside the reset, cleared immediately after, and its
-- absence means protected — a missing row makes the subquery NULL, and
-- `NULL IS NOT 1` is true, so the trigger fires. Failing closed is the only
-- acceptable default for something like this.
CREATE TABLE reset_guard (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  resetting INTEGER NOT NULL DEFAULT 0
);

DROP TRIGGER trg_receipts_no_delete;
CREATE TRIGGER trg_receipts_no_delete
BEFORE DELETE ON receipts
WHEN (SELECT resetting FROM reset_guard WHERE id = 1) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'Receipts cannot be deleted. Set voided_at to void one, so the numbering stays gapless.');
END;

DROP TRIGGER trg_budgets_approved_no_delete;
CREATE TRIGGER trg_budgets_approved_no_delete
BEFORE DELETE ON budgets
WHEN (SELECT status FROM budget_years
       WHERE assembly_id = OLD.assembly_id AND bahai_year = OLD.bahai_year) = 'approved'
 AND (SELECT resetting FROM reset_guard WHERE id = 1) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'This budget has been approved. Reopen the year before removing a line.');
END;

DROP TRIGGER trg_reconciliation_items_balanced_delete;
CREATE TRIGGER trg_reconciliation_items_balanced_delete
BEFORE DELETE ON reconciliation_items
WHEN (SELECT status FROM reconciliations WHERE id = OLD.reconciliation_id) = 'balanced'
 AND (SELECT resetting FROM reset_guard WHERE id = 1) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'This reconciliation is balanced. Reopen it before changing what has cleared.');
END;

DROP TRIGGER trg_reconciliations_no_delete_balanced;
CREATE TRIGGER trg_reconciliations_no_delete_balanced
BEFORE DELETE ON reconciliations
WHEN OLD.status = 'balanced'
 AND (SELECT resetting FROM reset_guard WHERE id = 1) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'A balanced reconciliation cannot be deleted. Reopen it instead.');
END;

DROP TRIGGER trg_fund_openings_no_delete;
CREATE TRIGGER trg_fund_openings_no_delete
BEFORE DELETE ON fund_openings
WHEN (SELECT resetting FROM reset_guard WHERE id = 1) IS NOT 1
BEGIN
  SELECT RAISE(ABORT,
    'An opening figure cannot be deleted. Append a correction that says why instead.');
END;

DROP TRIGGER trg_opening_checkpoints_no_delete;
CREATE TRIGGER trg_opening_checkpoints_no_delete
BEFORE DELETE ON opening_checkpoints
WHEN (SELECT resetting FROM reset_guard WHERE id = 1) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'A checkpoint records what the books already said. It cannot be deleted.');
END;

-- Settings edits are edits to the books' own description of themselves, and
-- they were not audited because until now nothing could make them. Renaming a
-- fund changes what every past report appears to say it was about.
CREATE TRIGGER trg_audit_assemblies_update
AFTER UPDATE ON assemblies
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.id, 'assemblies', NEW.id, 'update',
    json_object('name', OLD.name, 'short_name', OLD.short_name, 'opened_on', OLD.opened_on),
    json_object('name', NEW.name, 'short_name', NEW.short_name, 'opened_on', NEW.opened_on),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_funds_update
AFTER UPDATE ON funds
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'funds', NEW.id, 'update',
    json_object('key', OLD.key, 'label', OLD.label, 'is_passthrough', OLD.is_passthrough),
    json_object('key', NEW.key, 'label', NEW.label, 'is_passthrough', NEW.is_passthrough),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_categories_update
AFTER UPDATE ON categories
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'categories', NEW.id, 'update',
    json_object('label', OLD.label, 'is_archived', OLD.is_archived),
    json_object('label', NEW.label, 'is_archived', NEW.is_archived),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;
