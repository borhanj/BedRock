-- The budget: what the Assembly planned, against what happened.

-- Which fund an income category feeds.
--
-- Needed the moment a budget exists. Contributions to the National Fund are
-- income to the Assembly's account and none of it is the Assembly's to spend:
-- counted in a plain income total they inflate the planned surplus by exactly
-- the amount owed upward, which is the one figure a budget must not get wrong.
-- Null for expense categories, and for any income the Assembly does keep.
ALTER TABLE categories ADD COLUMN fund_id TEXT REFERENCES funds(id);

-- One row per Bahá'í year, holding the state of that year's budget as a whole.
--
-- A budget is a decision of the Assembly, not of the treasurer. Until it is
-- approved it is a draft the treasurer is preparing; once approved it is what
-- the community agreed to, and changing it is a further decision rather than
-- an edit. That distinction is the reason this table exists at all instead of
-- the lines standing alone.
CREATE TABLE budget_years (
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id),
  bahai_year   INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
  approved_on  TEXT,
  approved_by  TEXT,
  note         TEXT,
  -- Which year's actuals this draft was proposed from, and how many of that
  -- year's nineteen months had ended when it was proposed.
  --
  -- The count is pinned at proposal time on purpose. An Assembly sets next
  -- year's budget before this one has finished, so a draft is normally built
  -- from a part-year — and read back later, when that year is complete and its
  -- actuals are final, there would be nothing left to say the figures were
  -- extrapolated from seventeen months unless it had been recorded.
  proposed_from_year   INTEGER,
  proposed_from_months INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (assembly_id, bahai_year)
);

-- One planned figure, per category, per year. Cents, like everything else.
CREATE TABLE budgets (
  id           TEXT PRIMARY KEY,
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id),
  bahai_year   INTEGER NOT NULL,
  category_id  TEXT NOT NULL REFERENCES categories(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (assembly_id, bahai_year, category_id)
);

CREATE INDEX ix_budgets_year ON budgets (assembly_id, bahai_year);

-- A budget moves money in the sense that matters to an audit: it is the
-- authority under which the treasurer spends. Who set a figure, and when it
-- changed, belongs in the trail for the same reason a transaction does.

CREATE TRIGGER trg_require_actor_budgets
BEFORE INSERT ON budgets
BEGIN
  SELECT CASE WHEN (SELECT actor FROM audit_actor WHERE id = 1) IS NULL
    THEN RAISE(ABORT, 'No audit actor set: call setAuditActor() before writing')
  END;
END;

CREATE TRIGGER trg_audit_budgets_insert
AFTER INSERT ON budgets
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'budgets', NEW.id, 'insert', NULL,
    json_object('bahai_year', NEW.bahai_year, 'category_id', NEW.category_id,
                'amount_cents', NEW.amount_cents),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_budgets_update
AFTER UPDATE ON budgets
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'budgets', NEW.id, 'update',
    json_object('amount_cents', OLD.amount_cents, 'note', OLD.note),
    json_object('amount_cents', NEW.amount_cents, 'note', NEW.note),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_budgets_delete
AFTER DELETE ON budgets
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    OLD.assembly_id, 'budgets', OLD.id, 'delete',
    json_object('bahai_year', OLD.bahai_year, 'category_id', OLD.category_id,
                'amount_cents', OLD.amount_cents),
    NULL,
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_budget_years_insert
AFTER INSERT ON budget_years
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'budget_years', CAST(NEW.bahai_year AS TEXT), 'insert', NULL,
    json_object('status', NEW.status, 'proposed_from_year', NEW.proposed_from_year),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_budget_years_update
AFTER UPDATE ON budget_years
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'budget_years', CAST(NEW.bahai_year AS TEXT), 'update',
    json_object('status', OLD.status, 'approved_on', OLD.approved_on),
    json_object('status', NEW.status, 'approved_on', NEW.approved_on),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- An approved budget is a decision the Assembly made and the community heard.
--
-- Enforced here rather than in the application for the same reason the audit
-- triggers are: a rule that lives only in one code path is a rule until
-- somebody writes a second code path. Reopening the year to draft is a
-- deliberate, audited act, and these fire regardless of who is writing.

CREATE TRIGGER trg_budgets_approved_no_insert
BEFORE INSERT ON budgets
WHEN (SELECT status FROM budget_years
       WHERE assembly_id = NEW.assembly_id AND bahai_year = NEW.bahai_year) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'This budget has been approved. Reopen the year before adding to it.');
END;

CREATE TRIGGER trg_budgets_approved_no_update
BEFORE UPDATE ON budgets
WHEN (SELECT status FROM budget_years
       WHERE assembly_id = OLD.assembly_id AND bahai_year = OLD.bahai_year) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'This budget has been approved. Reopen the year before changing it.');
END;

CREATE TRIGGER trg_budgets_approved_no_delete
BEFORE DELETE ON budgets
WHEN (SELECT status FROM budget_years
       WHERE assembly_id = OLD.assembly_id AND bahai_year = OLD.bahai_year) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'This budget has been approved. Reopen the year before removing a line.');
END;
