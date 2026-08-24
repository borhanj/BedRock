-- CSV import and learned categorisation.

-- One CSV file, as imported. Keeps the column mapping that was used, so a
-- confusing import can be explained months later, and the file itself is
-- retained in R2 as the source document an audit will ask for.
CREATE TABLE import_batches (
  id              TEXT PRIMARY KEY,
  assembly_id     TEXT NOT NULL REFERENCES assemblies(id),
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  filename        TEXT,
  r2_key          TEXT,
  mapping_json    TEXT NOT NULL,
  row_count       INTEGER NOT NULL,
  imported_count  INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX ix_import_batches_account ON import_batches (assembly_id, account_id, created_at);

-- Which file a row came from. Null for hand-entered rows, which is how the
-- ledger tells "the bank said so" from "the treasurer typed it".
ALTER TABLE transactions ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id);

CREATE INDEX ix_transactions_batch ON transactions (import_batch_id);

-- Learned categorisation.
--
-- Deliberately a rule table and not a model. At an Assembly's volume — a few
-- hundred rows a year, with payees that repeat verbatim — matching normalised
-- payee text is both sufficient and inspectable: the treasurer can see exactly
-- why something was suggested, and delete the rule if it is wrong.
--
-- Rules only ever SUGGEST. Nothing in this schema applies a category without
-- the treasurer confirming it; see repo/rules.ts.
CREATE TABLE rules (
  id           TEXT PRIMARY KEY,
  assembly_id  TEXT NOT NULL REFERENCES assemblies(id),
  -- Normalised payee text: lower-cased, punctuation stripped, runs of
  -- whitespace collapsed. Matching happens on the same normalisation.
  pattern      TEXT NOT NULL,
  match_kind   TEXT NOT NULL CHECK (match_kind IN ('exact', 'contains')),
  category_id  TEXT REFERENCES categories(id),
  fund_id      TEXT REFERENCES funds(id),
  txn_kind     TEXT CHECK (txn_kind IN ('contribution', 'expense', 'remittance', 'transfer', 'other')),
  -- How often the treasurer has accepted this rule. Ties break toward the
  -- rule that has been right most often.
  hit_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (assembly_id, pattern, match_kind)
);

CREATE INDEX ix_rules_lookup ON rules (assembly_id, match_kind, hit_count DESC);
