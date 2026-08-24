# Bedrock

Accounting for the treasurer of a Bahá'í Local Spiritual Assembly.

A volunteer treasurer, usually serving a one-year term and usually not an accountant, has to
import bank transactions, keep contributions confidential, present a report at each of the
nineteen Feasts, and hand clean books to a successor. Bedrock is built around that job.

Three things shape the design:

- **The Badí calendar is the organising principle.** Periods, reports and the fiscal year run
  on the nineteen Bahá'í months, not Gregorian ones.
- **Contribution confidentiality is structural.** Donor identity is encrypted and separated
  from amounts, so aggregate reporting is the frictionless default and per-donor detail is a
  deliberate, gated, logged act.
- **Audit readiness is continuous.** Documentation is captured at entry time.

The UI follows option 1b of the source design — *the calendar is the app* — in an ink & teal
palette.

## Running it

```bash
npm install
```

```bash
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server. Honours `PORT`. |
| `npm test` | Calendar, money and fixture-integrity suites |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:contrast` | Fails if any palette pairing drops below WCAG AA |
| `npm run build` | Type-check then production build |

`.claude/launch.json` starts Vite as `node node_modules/vite/bin/vite.js` rather than
`npm run dev`. The preview harness spawns scripts in an environment that does not pick up
`node_modules/.bin`, so the `vite` shim is not on its PATH. `npm run dev` from a normal
terminal works fine; the direct invocation just avoids depending on the shim.

## What is built

**Phase 0 — foundations.** Badí calendar engine, money-as-integer-cents, semantic design
tokens, contrast gate.

**Phase 1 — the design, made real.** The year dashboard and the Feast report, in the layout
of option 1b.

**Phase 2 — persistence.** SQLite schema and migrations, a query layer, the HTTP API, and an
audit trail enforced by database triggers. The dashboard reads live queries; the fixture
module is gone. Every figure on screen is computed by the server against the database — the
browser does no arithmetic on money.

**Phase 3 — transactions in.** CSV import with column mapping and de-duplication, the
ledger, the cash journal, hand entry, and learned categorisation. Under Ledger: *All
transactions*, *Cash journal*, *Import a statement*.

**Phase 4 — reports out.** The Feast report lifecycle — build, adjust the cutoff, close the
books, present at Feast, reopen — plus the year-end summary at `/report/:year` and a print
path for both.

Phases 5–7 (the donor vault, funds and budget, the Audit Package) are not built. Their nav
destinations name the phase that fills them in.

### Running against real Cloudflare

The dev server uses an in-memory database, so nothing persists between restarts. Set
`BEDROCK_DEV_DB` to a file path to keep data across restarts, which is worth doing while
working on the import flow. Deploying needs wrangler, which is not yet a dependency:

```bash
npm i -D wrangler && npx wrangler d1 create bedrock
```

Then put the returned id in `wrangler.jsonc`, apply the migrations with
`npx wrangler d1 migrations apply bedrock`, and read the two blockers listed at the bottom of
that file — an Access policy and JWT verification — before the Worker is reachable.

## Things worth knowing before you build on this

**The Naw-Rúz table is the source of truth, and it is reconciled.**
`src/calendar/naw-ruz-table.ts` decides every date in the app. From 172 B.E. the calendar is
astronomical — Naw-Rúz falls on the vernal equinox as observed in Tehran, and because the
Bahá'í day starts at sunset, an equinox landing after sunset pushes the date. There is no
formula, so nothing here is computed.

All fifty rows, 172–221 B.E. (2015–2064), were read from *Badí' dates 172 to 221 BE*, prepared
by an ad hoc committee at the Bahá'í World Centre using data from HM Nautical Almanac Office.
Three checks stand behind them: the document's own stated Ayyám-i-Há lengths agree with the
gaps between its own Naw-Rúz dates; those stated lengths agree with the lengths this engine
derives (a test asserts this for all 49 closable years); and every year yields a legal 4- or
5-day Ayyám-i-Há.

The table stops at 221 B.E. because the published one does. Past that the engine throws rather
than extrapolating, and `assertVerifiedYears(from, to)` guards anything that produces a
document an Assembly relies on.

**Money is always integer cents.** Never a float, in any layer. Parsing happens once at the
edge in `parseMoney()`; everything inland is integers. A treasurer's books have to foot. A
test asserts there is no REAL column anywhere in the schema.

**A CSV cannot always say what its dates mean.** `03/04/2026` is 3 April or 4 March, and
nothing in the file decides it. The importer detects the order where the data proves it — any
value above 12 settles the question — and reports **ambiguous** where it cannot, marking the
control and refusing to let the guess pass unexamined. Getting this wrong moves transactions
between Feast periods and silently changes what a report says.

**The identity in `worker.ts` is not yet authentication.** It reads the email header
Cloudflare Access forwards, which anyone who can reach the Worker directly can simply set
themselves. Verifying `Cf-Access-Jwt-Assertion` against the team's public keys, and locking
ingress to Access, are both required before this is exposed. Until then it is attribution for
the audit log, nothing more. See the comment on `identify()`.

## Layout

```
src/
  calendar/    naw-ruz-table.ts  the source of truth — read the header
               badi.ts           periods, Feast dates, Ayyám-i-Há, formatting
               months.ts         the nineteen month names
  lib/         money.ts          integer cents, parsing, formatting
               year-progress.ts  the dashboard headline
  shared/      types.ts          the Worker/browser contract, imported by both
  server/      api.ts            one runtime-agnostic Request -> Response
               seed.ts           a worked year of 183 B.E. as real rows
               dev-plugin.ts     mounts the API into Vite dev
               db/adapter.ts     the SqlDatabase interface
               db/node-sqlite.ts dev and tests
               db/d1.ts          production
               db/migrate.ts     Node-only runner; wrangler does this in prod
               db/migrations/    NNNN_name.sql, wrangler's convention
               import/csv.ts     RFC 4180 reader for bank exports
               import/mapping.ts columns, and the date-order problem
               import/dedupe.ts  the re-import key
               repo/year.ts      the dashboard query layer
               repo/report.ts    the Feast report query layer
               repo/ledger.ts    ledger, cash journal, hand entry
               repo/import.ts    preview and commit
               repo/rules.ts     learned categorisation
  data/        api.ts            browser fetch helpers
               YearContext.tsx   the year, fetched once and shared
  components/  AppShell, NineteenMonths, WhereMoneySits, NeedsAttention,
               NextFeast, Loading, ErrorPanel
  pages/       YearDashboard, FeastReportPage, LedgerPage,
               ImportPage, CashJournalPage, Placeholder
  styles/      tokens.css        the palette — semantic names only
               app.css           layout; no hex literals
worker.ts      Cloudflare Worker entry
scripts/       check-contrast.mjs
```

## Design notes

**Colour tokens are semantic, never named after the colour.** The source mockup shipped in a
brown parchment palette and was re-skinned to ink & teal; that swap stayed cheap only because
nothing downstream said "brown". A component references `--bd-expense`, never `--bd-clay`.

**Two teals, deliberately.** `#0e8f8f` measures 3.9:1 on white — fine for fills, chart series
and large figures, below AA for body text. `--bd-primary-deep` (`#0a7373`, 5.7:1) exists for
small text and for any solid fill carrying white text. Same split for the expense clay.
`npm run check:contrast` enforces it against both the white card and the tinted canvas.

**The Feast report inverts for print.** Dark is right projected in a room and wrong on paper,
so `@media print` flips the ground to white and keeps the layout.

**The Feast name and the reporting cutoff are separate.** The name is fixed by the calendar;
the cutoff moves, because a late bank statement is the normal case. `reports.cutoff_start` and
`cutoff_end` default to the calendar bounds and can be changed without the report losing its
Feast name.

**A finalised report keeps saying what it said.** Closing the books freezes the figures into a
snapshot and locks the period's transactions. If a later correction moves the numbers, the
report still shows what was presented and reports the divergence beside it — quietly rewriting
a report the community has already heard, and quietly serving stale figures with no warning,
are both worse than saying so. Reopening a period is a distinct, audited act, and a row
covered by a second closed report stays locked.

**The year-end summary is computed over the year, not by adding up the reports.** A gift on a
day no monthly cutoff happened to cover still belongs in the annual figures. Summing the
reports instead would let money vanish at exactly the moment an auditor is looking.

**Periods are not stored in the database.** The nineteen months are derived from the Naw-Rúz
table at query time and the daily sums are bucketed in TypeScript. Caching month boundaries in
SQL would let the database drift from the calendar the moment a Naw-Rúz date is corrected.

**No ORM.** D1 is SQLite and nearly every query here is an aggregate — SUM over a date range,
GROUP BY fund, running balances — which a query builder lengthens rather than shortens. Hand
written SQL also means the exact same statements run in the tests (`node:sqlite`) and in
production (D1), with nothing translated in between that could differ.

**Re-importing a statement adds nothing.** The de-duplication key covers the account, date,
amount and normalised description, plus an ordinal counting identical rows *within the file*.
The ordinal is what makes two genuine $20 withdrawals on the same day two rows rather than
one — and counting it within the file rather than against the database is what makes a second
import of the same file reproduce the same keys and match. Offsetting by the existing row
count seems more intuitive and breaks idempotence completely.

**Learned rules suggest; they never apply.** Categorising a row records an exact-match rule on
the normalised payee, and the next statement carrying that payee arrives with the category
offered as a button and a plain-English reason. Accepting it is the treasurer's act. Nothing
in the system writes a category nobody chose, and broader `contains` rules are only ever
created deliberately — inferring that a shared word implies a shared category is how
auto-categorisation starts quietly miscategorising.

**The audit trail is enforced by triggers, not by convention.** An application-level rule only
covers the code paths that remember it. The triggers in `0001_core.sql` fire for any write from
any caller — including a raw SQL console — and abort outright if no actor has been set. A test
proves a hand-written INSERT still lands in `audit_log`. Receipts cannot be deleted at all, only
voided, so the numbering stays gapless.
