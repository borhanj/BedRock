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
| `npm run dev:empty` | Dev server with no worked year — what a new Assembly sees |
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

**Phase 5 — receipts and the donor vault.** Encrypted donor identity behind a PIN, gapless
receipt numbering, void-not-delete, and a log of who has looked at donor detail.

**Phase 6 — funds, budget, reconciliation.** Per-fund sub-ledgers and the remittance record
under Funds. Budget against actual by category, paced against the year, with next year's
draft proposed from this year's actuals for the Assembly to approve. Bank reconciliation
under Ledger → *Reconcile*, which is also what restores the dashboard's fourth worklist row.

**Phase 7 — audit and continuity.** The Audit Package at `/audit`: every figure an auditor
asks for in one printable document, leading with five integrity checks and an honest list of
what is not finished. The treasurer handoff at `/audit/handover` — a lossless export of every
table, and the checklist of what has to pass between two people rather than two databases.
Reading one back in is on the same screen: choosing a file inspects it and writes nothing,
and the restore is offered only once the file and the target both allow it. Plus a printable
receipt at `/receipts/:id` to hand someone.

**Phase 8 — opening the books.** Setting up an Assembly from nothing, at `/setup`: the
funds it keeps, where its money is, and what the outgoing treasurer says each fund holds.
Where those figures disagree — which is the normal case, not the exceptional one — the
difference is carried as its own line rather than absorbed, and accounting for it later is
a recorded Assembly decision. A fresh deployment redirects here instead of failing.

The opening date is a wall and the importer enforces it: a statement reaching back before
the books opened has those rows marked and refused, because the opening balance already
contains them. When the previous year's journal turns up, `/setup` on an Assembly that
already has books is where the wall moves — and moving it leaves a checkpoint, so the
history loaded behind it has to reproduce the figure the Assembly had already accepted.

**Phase 10 — getting started.** Setup is a seven-step walkthrough rather than one long
form: what to have to hand, then the Assembly, the accounts, the funds, what each holds,
the finishing touches, and a review before anything is written. Each step validates itself
so nothing is discovered at the end, and nothing is saved until the last one.

A deployment still holding the worked example says so on every screen, with the way out one
click away — a database full of a demonstration otherwise looks exactly like one in use.

**Phase 9 — settings, and starting over.** `/settings`: rename the Assembly, add and
retire bank accounts and cash journals, add and rename funds, add and archive categories,
and upload the letterhead that prints at the top of every receipt. Setup takes any number
of accounts of either kind and a letterhead of its own.

And the way out of a demonstration: *Clear these books and start again* deletes everything
and leaves a database ready to be set up, behind the Assembly's name typed back and with
the backup offered first. It is the only operation in Bedrock that destroys records.

All seven nav destinations are built, plus setup outside them. There are no placeholders
left.

### It is deployed

It runs on Cloudflare Workers behind Cloudflare Access, on D1, seeded with the worked year
of 183 B.E. Signing in is required for the API; the static shell is served to anyone and is
useless without it. The URL is not in the repository — ask whoever deployed it.

It is a personal test deployment and holds no real Assembly's books — only the fictional
Riverbend fixture. Wipe it, reseed it or redeploy over it freely. The Access tenant carries
some walterpmoore.com addresses from unrelated use; this project is not connected to that
work.

The dev server uses an in-memory database, so nothing persists between restarts. Set
`BEDROCK_DEV_DB` to a file path to keep data across restarts, which is worth doing while
working on the import flow.

The live configuration is not committed. Copy the example and fill in the three values it
marks:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

To deploy again after a change:

```bash
npm run build && npx wrangler deploy
```

To stand a fresh environment up from nothing:

```bash
npx wrangler d1 create bedrock
```

Put the returned id in your `wrangler.jsonc`, then apply the schema and load the worked year. The
seed is rendered to SQL from `src/server/seed.ts` rather than written twice, and the script
replays its own output into a second database and checks it lands on the same books before
printing anything:

```bash
npx wrangler d1 migrations apply bedrock --remote
```

```bash
npx vite-node scripts/seed-sql.ts > seed.sql && npx wrangler d1 execute bedrock --remote --file=seed.sql
```

Finally, protect the Worker: its **Access** tab in the dashboard, scope *All traffic*, with a
policy naming the treasurer(s). Copy the AUD tag and team domain from the *Application
values* panel into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in your `wrangler.jsonc` and
redeploy.
Until those are set the Worker serves the API to nobody — see below.

## Picking this up

Everything below is current as of the last commit. `npm test` should show **411 passing**;
if it does not, start there rather than with new work.

### Next, in order

Every phase in the original plan is built, and it is deployed. Nothing is half-finished and
no work is mid-flight. Pick from the lists below.

An Assembly can now open its own books and take on history from before it opened them, so
the software no longer requires a fictional community to be usable. What is left is mostly
hardening: narrowing the Access policy, the R2 binding for receipt images, and meeting a
real bank's CSV.

### Before it holds a real Assembly's books

**The Access policy is too wide.** It currently admits any member of the Cloudflare account.
It should name the treasurer(s). Everything else about the auth chain is in place.

**Nothing has met a real bank's CSV.** The worked year is 85 transactions, and no statement
any actual bank exports has been through this. What a statement *costs* is now settled — the
import, the commit and the restore no longer issue a query per row, and tests hold them to
it — but that is a different claim from having read a real file. The formats, the preamble,
the date order and the way a particular bank writes a description are all still unmet.

**The read paths at volume have not all been looked at.** The dashboard, the year summary and
the audit package were measured against the deployed D1 and fixed. The ledger and the receipt
book have not been measured the same way. Both are single queries, so neither has the shape
that went wrong before — but "has the right shape" is not "was measured".

### Smaller things left undone

- Receipt images cannot be uploaded. The dashboard counts expenses missing one, the ledger
  flags them and the audit package discloses them, but attaching needs an R2 binding.
- Automatic encrypted backup to an Assembly-owned Google Drive folder is not wired up: it
  needs OAuth credentials this project does not have. The handover page says so on its face
  rather than offering a button that would not work. The export there is the backup.
- The dev database is in-memory, so a restart resets it. `BEDROCK_DEV_DB=<path>` keeps it.

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
               access.ts         the Access JWT, verified
               seed.ts           a worked year of 183 B.E. as real rows
               dev-plugin.ts     mounts the API into Vite dev
               db/adapter.ts     the SqlDatabase interface, and batched writes
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
               repo/donors.ts    the donor vault — the only reader of `donors`
               repo/receipts.ts  gapless numbering, void-not-delete
               repo/funds.ts     sub-ledgers, the fund partition, remittance
               repo/budget.ts    planned against actual, and next year's draft
               repo/reconcile.ts the statement, ticked off
               repo/settings.ts  what setup got wrong, and clearing it all
               repo/started.ts   what a new treasurer still has to do
               repo/setup.ts     opening an Assembly's books from nothing
               repo/opening.ts   the opening position, the difference in it, and
                                 moving the wall backwards
               repo/audit.ts     the audit package, and what it cannot vouch for
               repo/handoff.ts   the export, and what has to pass between people
               repo/restore.ts   reading a bundle back in, and refusing to
               vault/crypto.ts   PBKDF2 + AES-GCM, and its threat model
  data/        api.ts            browser fetch helpers
               YearContext.tsx   the year, fetched once and shared
  components/  AppShell, NineteenMonths, WhereMoneySits, NeedsAttention,
               NextFeast, GettingStarted, Loading, ErrorPanel
  pages/       SetupPage, OpeningPage, SettingsPage, YearDashboard,
               FeastReportPage, YearSummaryPage, LedgerPage,
               ImportPage, CashJournalPage, ReceiptsPage, FundsPage,
               RemittancePage, BudgetPage, ReconcilePage, AuditPage,
               HandoffPage, ReceiptPage
  styles/      tokens.css        the palette — semantic names only
               app.css           layout; no hex literals
worker.ts      Cloudflare Worker entry
scripts/       check-contrast.mjs, dev-empty.mjs
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

The parts of the key are joined on NUL, because a separator has to be a character a bank
cannot put in a description. Joined on a space, account `acct 1` dated `2026-08-02` and
account `acct` dated `1 2026-08-02` are the same string and so the same hash. It is written
`\u0000` rather than as the byte itself: a literal NUL makes git treat the whole file as
binary and stop diffing it, which is what it had been doing since the file was written.

A test also freezes one known hash against its literal value. Every row on file is stored
under a hash this function produced, so changing how the key is built means the next statement
matches nothing, re-imports in full, and doubles the books. That change is allowed to be made;
it is not allowed to be made by accident.

**Learned rules suggest; they never apply.** Categorising a row records an exact-match rule on
the normalised payee, and the next statement carrying that payee arrives with the category
offered as a button and a plain-English reason. Accepting it is the treasurer's act. Nothing
in the system writes a category nobody chose, and broader `contains` rules are only ever
created deliberately — inferring that a shared word implies a shared category is how
auto-categorisation starts quietly miscategorising.

**Donor names are encrypted, and the reports prove they are not needed.** Identity is
AES-GCM encrypted with a key derived from the treasurer's PIN; amounts, funds and dates stay
plaintext against an opaque `donor_id`. The acceptance test renames the `donors` table out
from under the app and asserts the dashboard, the Feast report — household count included —
and the year summary all still work. Reading a name is logged, and that log is readable
without the PIN, because oversight only the overseen can inspect is not oversight.

**What the PIN does and does not protect.** §4 asks for protection "if the app is ever used
on a shared or Assembly-owned device", and that is the threat model: someone at the
treasurer's laptop. It is **not** protection against someone who obtains the database. A
six-digit PIN is a million offline guesses; 150,000 PBKDF2 rounds raise that cost without
removing it, which is why a passphrase is allowed and encouraged. What encryption buys
unconditionally is that names never sit in plaintext in the database, a backup, an export or
the audit log. The PIN is held in browser memory only — never localStorage, never a cookie.

**Receipt numbering is gapless.** A receipt is never deleted; a trigger refuses it. A mistake
is voided with a stated reason, keeps its number, and the corrected receipt takes the next one.
A gap in a receipt book reads to an auditor as a destroyed record.

**The fund partition is one query, not two that agree.** The dashboard's "where the money
sits" card and the Funds table both call `loadFundBalances`, and a test asserts they return
the same figures — not because two implementations were checked against each other, but
because there is only one. The rows are a partition: they sum to what is on hand, so money
cannot belong to two funds or to none. The cash row nets out pass-through money sitting in
the tin, since a National Fund note in the cash box is already counted by the National row,
and the Local Fund being the residual would otherwise absorb the double-count as a shortfall
that never happened.

**Forwarding money upward writes two rows or neither.** A remittance is a withdrawal from the
account *and* a discharge of the fund. Writing only the second would leave the money still in
the bank balance while the fund showed it gone. It also refuses to forward more than a fund
holds: an Assembly cannot send onward money it was never given, so a larger figure is a
miscount on the way in, and posting it would bury the discrepancy in two places at once.

**A budget is the Assembly's decision, not the treasurer's.** Drafting and approving are
separate states, and an approved year refuses edits through a trigger rather than a code
path — a raw SQL console is refused too, and a test proves it. Reopening is a further
deliberate act. Next year's draft carries this year's actuals across unrounded and
unadjusted; a proposal that quietly added ten percent would be software making a decision
that belongs to nine people in a room. Because an Assembly drafts before the year is over,
how much of the source year had actually happened is pinned at proposal time — read back a
year later, when that year looks complete, nothing else would say the figures came from
seventeen months.

**Budget lines are paced, not just compared.** Eight months in, every expense line is under
its whole-year figure, so colouring by that alone would paint the entire table as fine —
including a line at 98% of its budget in the fifth month, which is the one line worth
looking at. Amber means off pace, clay means the year's whole figure is already spent, ink
means normal. Being under budget mid-year is not an achievement and does not read as one.

**Pass-through contributions are kept out of the surplus.** A National Fund gift is income to
the account with no matching expense line, so a plain income total would overstate what the
Assembly can spend by exactly the amount it owes upward. Income categories name the fund they
feed (`categories.fund_id`), and goals for other funds are shown separately.

**The books open on a stated day, and the difference is a row rather than a plug.** A
treasurer taking over has a bank statement, a tin, and a page from their predecessor saying
what belongs to which fund. Those three rarely agree, and the disagreement is the most
interesting thing about them. Setup records what is stated and carries the remainder as its
own line — *Unaccounted for at opening* — belonging to no fund, until the Assembly decides
what it is.

It has to be carried explicitly, because the alternative is not "nothing happens". The Local
Fund is the residual of the partition, so an unexplained difference silently becomes part of
what the Assembly believes it can spend. Carving it out is what stops that, and it is the
same principle as `completeReconciliation` refusing a plug, reached from the other direction.

The remainder is signed and both signs happen. Positive is money on hand nobody has accounted
for, usually an unrecorded deposit. Negative is worse — the funds claim more than the
Assembly holds, which generally means money earmarked for another institution has been spent
on something else. Reporting the absolute value would hide which of those a treasurer is
looking at.

Nothing about it blocks setup. An Assembly whose inherited books do not balance has to be
able to say so and start work; a form that refuses to continue until the figures agree
teaches a treasurer to invent a number, and an invented number is indistinguishable from a
real one afterwards.

**Accounting for it later is an Assembly's decision, and it is append-only.** Resolving the
remainder takes a stated reason and the name of whoever decided — usually the Assembly,
minuted, not the person at the keyboard. Part of it can be settled and the rest left
standing, because finding the missing deposit and still not explaining the last $42 is the
normal shape of this. `fund_openings` refuses UPDATE and DELETE through triggers: every later
figure in the books is measured from the opening position, so an edit would move what every
report has already been computed against and leave no trace of what it was.

**Exactly one fund is the Assembly's own, and that is structural.** `loadFundBalances` builds
the partition by treating the single non-pass-through fund as the residual. A second one
would never appear in the partition at all and its money would be silently absorbed by the
first — with no error a treasurer could ever see. Setup refuses it, and says why.

**A pass-through fund can open holding money.** Without that, the first time a new Assembly
forwarded a National Fund contribution it had received before installing Bedrock, it was told
it had never received it. Fixing that surfaced a second problem worth recording: the balance
was computed in two places — the partition, and `recordRemittance`'s check that a fund is not
over-forwarded — and only one of them learned about openings. The dashboard said $250 was
held while the remittance screen refused to forward $250, with nothing on either screen to
explain the contradiction. They now share one SQL expression, `fundHeldCents`, so they cannot
drift again.

**A disabled button has to look disabled.** There was no rule for it anywhere in the
stylesheet, so every control the app switches off — the wizard's *Next*, *Save* in Settings,
the reset — stayed fully coloured and simply did nothing when clicked. Someone reasonably
concludes the app is broken rather than that they have not finished the form. This was
found by a treasurer clicking a live-looking *Delete everything* that was inert.

**The reset's ceremony scales with what is at risk.** Real books ask for the Assembly's name
typed back, because knowing which books you are destroying is the only thing worth proving.
The sample books ask for nothing at all: not one figure in them belongs to anybody, the app
has said so on every screen since the treasurer arrived, and making them transcribe a long
name they did not choose is an obstacle between a new user and a usable app rather than a
safeguard. Guarding a demonstration as though it were an Assembly's accounts teaches people
that this app's warnings are noise.

**The getting-started checklist is detected, never remembered.** No dismissed column, and
nothing ticked because a screen was visited — a step is done when the database shows it
done. That is what stops the list drifting from the books, being wrong after a restore, or
congratulating anybody for work they have not finished. It also means a step can go back to
undone, which is correct: un-approving a budget really does leave that work outstanding, and
a stored flag would have hidden it. Exactly one step is ever *next*, so the card answers
"what do I do now?" rather than presenting a list of chores, and it removes itself once
there is nothing left to say.

**A deployment full of a demonstration looks exactly like one in use.** Same screens, same
confident totals, and no reason for a treasurer who does not already know to go looking for
the way out. So `isSampleData` recognises the shipped fixture — by two marks together, since
either alone would eventually be wrong: accounts under literal ids that `setUpAssembly` never
generates, and no opening date, which books opened through setup always have. A banner then
says so on every screen until it is not true.

**The reset's ceremony is where it does some good.** It used to sit behind a disclosure and
a trip to another page for the backup, which is how a treasurer ends up unable to find the
way out of a demonstration. The backup now happens on the same card in one click and the
screen names the file it wrote, so "did I actually take one?" has a visible answer. What
stays is the Assembly's name typed back, checked on the server against the stored name.
Everything else was friction pretending to be safety, which is worse than either.

**Setup is a walkthrough because the person doing it has not done it before.** They are
holding three pieces of paper that do not agree and do not yet know which questions matter;
one page of thirty fields answers none of that. Each step validates before letting them past,
because being told at the end that something on the second screen was wrong is how people
abandon forms. And the wizard steers around the one-own-fund rule rather than waiting to
refuse it: marking a fund as the Assembly's own quietly demotes the previous one, which is
what changing your mind meant anyway.

**Rename freely, remove nothing.** An account, fund or category that has ever had money
against it is never deleted from Settings. Every past report points at these rows, and a
Feast report that has been read aloud to a community cannot be made to refer to something
that no longer exists. Retiring an account or archiving a category takes it out of the
lists a treasurer picks from and leaves every figure and every past document intact.

A fund cannot change sides either. Exactly one fund is the Assembly's own — it is the
residual of the partition — so promoting a second would silently re-partition every balance
the app has ever shown. A fund added in Settings is always one held for another institution.

**The letterhead lives in the database, and that is a deliberate compromise.** R2 is the
right home for files and is where receipt images will go, but it needs a bucket and a
binding this deployment does not have, and a feature that ships dark is not a feature. One
logo per Assembly, capped at 400kB and validated server-side for type and size, is small
enough that a database row is honest. A thousand receipt photographs would not be, which is
why they still wait for R2.

It is validated on arrival rather than trusted from the browser: the string is rendered into
an `<img src>`, and `data:text/html` there is the kind of thing that only looks harmless. It
lives in its own table rather than on `assemblies`, because that row is read by every screen
in the app to put a name in the corner and should not carry a hundred kilobytes of image.

**Clearing the books is the one thing here that destroys records.** Six triggers in this
schema refuse a DELETE — receipts, approved budget lines, balanced reconciliations and their
items, opening figures, checkpoints — and every one of them is right, because each protects
a record whose absence would read as evidence destroyed. Deleting a receipt leaves a hole in
a book; deleting the book is a different act, and one an Assembly is entitled to perform on a
database holding a demonstration.

So the guards consult `reset_guard` rather than being dropped and recreated at runtime. The
flag is raised and lowered inside the same batch, so a failure part way through rolls back to
a protected database rather than leaving one where receipts are deletable. Its absence means
protected: a missing row makes the subquery NULL, and `NULL IS NOT 1` is true, so the trigger
fires. Failing closed is the only acceptable default.

The audit trail goes too, and that is not a side effect to soften. An audit trail of books
that no longer exist is not evidence of anything, and leaving it would put entries about a
community the next Assembly has never heard of into its first report. The screen puts the
backup download above the button for that reason — the export is the only way back.

**The opening date is a wall, and the importer enforces it.** A row dated before the books
open is marked `before-opening` and never written, whatever the client asks. The reason is
not tidiness: the opening balance already accounts for everything that happened before that
day, so importing such a row counts the same money twice — once inside the opening figure
and once as a transaction — and the books end up out by exactly the amount of history that
was loaded. No index catches this, so the refusal is the only thing that does.

**The wall moves backwards, and moving it leaves something to prove.** The previous year's
cash journal turns up in a drawer, and an Assembly that cannot load it keeps two sets of
records. `restateOpening` moves the date, restates what the accounts and funds held on the
new earlier one, and writes down the figure the books used to open with as a *checkpoint*.

That checkpoint is the point. After a restatement, every figure in the books derives from
the restatement itself — except that one, which the Assembly had already accepted. The
history imported behind the wall has to add up to it. `loadCheckpoints` computes the
restated opening plus everything dated earlier than the old opening date and compares; when
it does not land, the difference is the size of what is missing or duplicated, and it is
disclosed in the audit package rather than left to be discovered. A checkpoint that fails is
never resolved by moving the checkpoint. It is resolved by finding the transactions.

Only backwards. Moving the date forwards would leave transactions already on the books
sitting before a wall saying nothing before it counts — still in every total while claiming
not to exist, which is worse than the state being fixed.

**The Assembly's own fund has to be stated even though it is never stored.** It is the
residual, so it has no row — but the unexplained remainder is derived as everything on hand
less everything the funds claim, and omitting it from that subtraction does not mean nothing
changes. It means the whole of the Assembly's own money is declared unaccounted for. The
mistake is silent, catastrophic and entirely plausible: a form built from the table of
stored openings does not think to ask for the one fund that has no entry in it. Both
`setUpAssembly` and `restateOpening` refuse without it, and the guard was written after the
restatement screen made exactly that mistake.

**An opening balance is audited now.** `accounts` was the one table carrying money with no
audit triggers on it, which was survivable only while nothing ever wrote to it after setup.
Restatement writes to it, and it is the figure every later balance is built from, so a
change to it that left no trace was not something to keep.

**Reconciliation has no adjusting entry, and never will.** A plug makes the books agree with
the bank while burying the reason they did not, and that reason is the entire point of the
exercise. `completeReconciliation` refuses anything but a difference of exactly zero and says
by how much — the amount is usually the clue, since a figure matching one transaction is a
missed tick and one divisible by nine is very often two digits transposed. What the treasurer
gets instead is a way to correct a mistyped statement figure, which is the honest fix.

**What has cleared the bank is stored beside a transaction, not on it.** Closing a Feast
report locks its transactions, and `trg_transactions_locked` aborts any update to a locked
row. But whether the bank has processed a cheque is a fact about the bank, not an edit to the
books: a payment made in Kamál may well clear in ʿIzzat, long after that report is presented.
`reconciliation_items` means reconciliation never touches a locked row, and the lock never
has to be weakened to let it.

**The worklist can say "I do not know".** The fourth row — unmatched bank items — was left
out of Phase 2 because a confident zero for a check that had never run would have been worse
than no row at all. It is here now and it still refuses to claim a zero: until a statement
has been balanced it shows a dash and says the bank has never been reconciled, which is a
different statement from "nothing to find".

**The Audit Package is composed, not re-queried.** It calls `loadYearSummary`, `loadFunds`,
`loadBudget`, `listReconciliations` and `listReceipts` — the same functions the screens read,
not equivalent ones written again for print. A pack that could disagree with the app would be
worse than no pack, because the disagreement would surface in front of an auditor and neither
figure could then be trusted. The tests assert identity, not equivalence.

**The pack leads with what it cannot vouch for.** Five checks, computed against the database
as the document is drawn rather than read from a flag: receipt numbering has no holes, every
transaction is in the audit trail attributed, the fund balances partition what is on hand, no
presented report has quietly moved, money is whole cents. Then the gaps, each with what it
means to a reader. A tidy pack that buried eleven uncategorised rows on page four would not
be a cleaner audit — only the same findings arriving later and from someone else.

**The handover's first step is the one with no second chance.** The data is easy to copy; the
donor PIN lives in one person's memory. If the outgoing treasurer leaves without passing it
on, the names are unrecoverable — by the Assembly, by this software, at all. That is the
encryption working correctly, and it is worth one plain sentence on the way out rather than a
discovery next Naw-Rúz. It is the only step marked irreversible, and a test asserts it stays
the only one.

**The export is lossless and no more readable than the database was.** Every table, including
the audit trail and the voided receipts, with a schema version. Donor names go in as the same
ciphertext they are stored as: dropping them would make the file safe to lose and useless to
keep, and decrypting them would make an export a way around the vault. `audit_actor` is
excluded — it holds who is writing right now, which means nothing in a file.

**Access is verified, not believed.** `worker.ts` reads the signed JWT in
`Cf-Access-Jwt-Assertion` and checks it against the team's published keys — signature,
algorithm, audience, issuer and expiry — rather than trusting the
`Cf-Access-Authenticated-User-Email` header, which is a string anyone reaching the Worker
directly can set for themselves. `src/server/access.ts` fails closed on every path: unset
configuration, unreachable key endpoint, unknown key id, bad signature, wrong application,
expired token. There is no "allow if we cannot check" branch, and the tests sign real tokens
with a real generated keypair to prove a forged one does not verify.

With no Access configuration at all the Worker refuses the API outright with a 503 rather
than serving it unauthenticated. A variable nobody set must not be the reason an Assembly's
books are readable.

**A trigger body must not contain `CASE ... END;`.** wrangler splits migration files on
semicolons before sending them to D1, so it reads the `END;` of a `CASE` as the end of the
trigger and ships half a statement. SQLite's own parser accepts it, so the failure appears
only against D1 — that is, only in production. The three `require_actor` guards were written
that way and are now `WHEN` clauses instead, which is also how their siblings read.

**The seed is rendered to SQL, never written twice.** `scripts/seed-sql.ts` builds a database
with the real `migrate()` and `seed()` and dumps it, then replays its own output into a second
database and refuses to print anything unless the two land on the same books. Two orderings
in it are the database's rules rather than preferences: budget lines go in before their year
(an approved year refuses new lines), and reconciliations go in open and are balanced at the
end (a balanced one refuses changes to what has cleared).

**D1 is not the SQLite the tests run against, and the differences only appear in
production.** Three of them have bitten this project, each one passing every test and
failing on deploy:

- A trigger body containing `CASE ... END;` is split in half by wrangler before it reaches
  D1. `WHEN` clauses instead.
- `sqlite_master` is refused by the authorizer the Worker's binding runs behind —
  `not authorized: SQLITE_AUTH`. `pragma_table_info` is allowed.
- A compound `SELECT` has a low cap on terms. Twenty `UNION ALL` branches is past it; a
  single row of scalar subqueries is not.

`wrangler d1 execute` is **not** a reliable check for any of this: it goes through the admin
API, which allows things the Worker binding does not — `sqlite_master` works there and fails
in the Worker. The only honest check is to deploy and call the endpoint. When touching SQL
that is unusual in any way, do that before assuming a green suite means anything.

**A query against D1 is a network round trip, and they add up.** In `node:sqlite` a query
costs microseconds, so a loop of them is invisible in the tests; against D1 each one crosses
a network and the same loop is seconds. Two places had it badly. `loadYearSummary` called
`computeReport` once per month — eight queries apiece, twenty times over — and took 1.1s on
a year of eighty-five transactions. The audit package composed that plus a drift check per
month and took 1.8s.

Both are fixed the way the dashboard already worked and the way this file already prescribes:
the database returns daily sums over the whole year and the nineteen months are bucketed in
TypeScript. The audit package additionally asks which months have a frozen snapshot — only
those can drift — and recomputes them together rather than one after another. The
handover checklist had the same shape twice over — a pragma lookup and a count query per
table, forty round trips for 2.9kB.

Measured on the deployed instance, steady state: summary 1095ms → 183ms, audit 1817ms →
771ms, the handover checklist 617ms → 111ms, the export 635ms → 301ms.

The same shape appears on the write side, and there it is worse than slow. `commitImport`
wrote a row per line of the statement; `restore` wrote a row per row of the bundle. A Worker
is allowed a bounded number of subrequests per invocation and D1 queries count against it, so
past a certain size those did not take longer — they stopped, part way through. A
thousand-line statement is an ordinary thing for a bank to export, and a bundle carrying a
real year is thousands of rows once the audit trail is in it.

`SqlDatabase.batch` is the answer: the caller hands over every statement it means to write and
the implementation sends them in chunks of a hundred, one request each, each chunk a
transaction. Counted rather than timed, on the worked year: previewing a 500-line statement
went from 502 round trips to **3**, committing it from about 1,000 to **9**, and restoring a
1,721-row bundle from about 1,730 to **21**. Tests assert the counts stay flat as the row count
rises, which is the property that matters — the millisecond figures above were measured
against the deployed instance, and these have not been.

The trap to know before reaching for the obvious alternative: **D1 caps a single statement at
100 bound parameters**, so one INSERT with a thousand placeholders is not available. It breaks
around the twentieth row of a wide table. Many statements in one request is the shape that
works; one enormous statement is not.

The rule worth keeping: **a loop that queries per row or per month is a bug against D1 even
when the tests are instant.**

**A restore goes into an empty place.** It will not merge into live books and it will not
overwrite them, and the refusal is about the target rather than the file — a perfectly sound
bundle is still refused if the Assembly is already there. Merging or overwriting is the
operation most likely to be reached for in a panic and most likely to destroy the thing it
was meant to save.

Everything is checked before anything is written: shape, format version, whole-cent money,
and every reference between tables, so a truncated file fails before it is half loaded.
That matters more than usual because the restore as a whole is not atomic: the rows go in as
batches of a hundred, and while a batch either lands or does not, a failure half way through
leaves the batches that already committed. The pre-flight makes that unlikely and the
empty-target rule makes it recoverable.

A newer bundle is refused outright rather than partially read. Loading only the parts this
version understands would produce books that look whole and are not.

**A restore keeps the original audit trail, and admits to itself.** The entries come back
with their own actors and timestamps. The rows the triggers write as the restore proceeds
are attributed to `restore by <who> from a bundle exported <when>`, so they can never be
mistaken for ordinary activity, and one further entry records the whole act as a single
findable event. `audit_log` and `donor_access_log` take new ids on the way in, because
carrying the originals would collide with the entries the restore is generating.

**The audit trail is enforced by triggers, not by convention.** An application-level rule only
covers the code paths that remember it. The triggers in `0001_core.sql` fire for any write from
any caller — including a raw SQL console — and abort outright if no actor has been set. A test
proves a hand-written INSERT still lands in `audit_log`. Receipts cannot be deleted at all, only
voided, so the numbering stays gapless.
