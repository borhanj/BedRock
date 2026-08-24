-- The donor vault, and receipts.

-- One row per Assembly. Holds the key-derivation parameters and a verifier —
-- a known sentinel encrypted with the derived key — so an unlock attempt can
-- be checked without storing the PIN or anything reversible into it.
CREATE TABLE vault (
  assembly_id    TEXT PRIMARY KEY REFERENCES assemblies(id),
  kdf_salt       TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  verifier       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Which contribution a receipt was issued for. One receipt, one contribution:
-- the receipt is the acknowledgement of that specific gift.
ALTER TABLE receipts ADD COLUMN contribution_id TEXT REFERENCES contributions(id);

-- One LIVE receipt per contribution. A voided receipt keeps its link for the
-- record, and must not block the corrected receipt that replaces it.
CREATE UNIQUE INDEX ux_receipts_contribution
  ON receipts (contribution_id)
  WHERE contribution_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX ix_receipts_issued ON receipts (assembly_id, issued_on);

-- Reading a donor's name is itself an event worth recording.
--
-- Aggregate reporting never needs it, so a decryption means someone
-- deliberately asked who gave what. §4 wants that gated; this is what makes it
-- also visible. The log records that a name was read and whose, never the name.
CREATE TABLE donor_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  assembly_id TEXT NOT NULL REFERENCES assemblies(id),
  donor_id    TEXT,
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX ix_donor_access_time ON donor_access_log (assembly_id, occurred_at);

CREATE TRIGGER trg_audit_donors_insert
AFTER INSERT ON donors
BEGIN
  INSERT INTO audit_log (assembly_id, entity, entity_id, action, before_json, after_json, actor, occurred_at)
  VALUES (
    NEW.assembly_id, 'donors', NEW.id, 'insert', NULL,
    -- The id and the anonymity flag only. A donor's name must not reach the
    -- audit log in any form, or the encryption above would be decorative.
    json_object('is_anonymous', NEW.is_anonymous),
    (SELECT actor FROM audit_actor WHERE id = 1),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  );
END;
