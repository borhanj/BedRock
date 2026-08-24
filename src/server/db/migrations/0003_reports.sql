-- Finalising and presenting a Feast report.

-- When the report was read out at Feast, as distinct from when it was built.
-- A report can sit finalised for days waiting for the Feast to come round.
ALTER TABLE reports ADD COLUMN presented_at TEXT;

-- Who finalised it, and who last unlocked it. The audit log has the full
-- history; these are here so the report itself can say it on its face.
ALTER TABLE reports ADD COLUMN finalized_by TEXT;
ALTER TABLE reports ADD COLUMN unlocked_at TEXT;
ALTER TABLE reports ADD COLUMN unlocked_by TEXT;

CREATE INDEX ix_reports_status ON reports (assembly_id, bahai_year, status);

-- Reports are money-adjacent: finalising one locks a period, and unlocking it
-- reopens closed books. Both belong in the audit trail for the same reason
-- every transaction does.
CREATE TRIGGER trg_audit_reports_insert
AFTER INSERT ON reports
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'reports', NEW.id, 'insert', NULL,
    json_object('bahai_year', NEW.bahai_year, 'month_number', NEW.month_number,
                'cutoff_start', NEW.cutoff_start, 'cutoff_end', NEW.cutoff_end,
                'status', NEW.status),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

CREATE TRIGGER trg_audit_reports_update
AFTER UPDATE ON reports
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'reports', NEW.id, 'update',
    json_object('cutoff_start', OLD.cutoff_start, 'cutoff_end', OLD.cutoff_end,
                'status', OLD.status, 'finalized_at', OLD.finalized_at),
    json_object('cutoff_start', NEW.cutoff_start, 'cutoff_end', NEW.cutoff_end,
                'status', NEW.status, 'finalized_at', NEW.finalized_at),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;

-- A presented report is a statement made to the community. It can be
-- unlocked, which is an audited act that returns it to draft, but it cannot
-- be quietly edited in place.
CREATE TRIGGER trg_reports_presented_immutable
BEFORE UPDATE ON reports
WHEN OLD.status = 'presented' AND NEW.status = 'presented'
  AND (OLD.cutoff_start <> NEW.cutoff_start OR OLD.cutoff_end <> NEW.cutoff_end)
BEGIN
  SELECT RAISE(ABORT, 'This report has been presented at Feast. Unlock it before changing its cutoff.');
END;
