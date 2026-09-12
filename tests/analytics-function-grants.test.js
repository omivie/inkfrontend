/**
 * analytics_function_grants.sql — the grant must stay NARROW (ERR-229)
 * ====================================================================
 *
 * THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT WAS THE BUG.
 *
 * Until Sep 2026 this file pinned a blanket
 *
 *     grant execute on all functions in schema public to authenticated, service_role;
 *
 * plus ALTER DEFAULT PRIVILEGES for four roles and an event trigger that
 * re-granted EXECUTE on ANY function the moment it was created or altered. Its
 * own docstring said, in as many words, "if someone NARROWS THE GRANT this test
 * fails" — so the suite that was supposed to protect the dashboard was standing
 * guard over a privilege-escalation footgun. Backend migration 165 later added
 *
 *     set_business_contract_price(...)      arbitrary negotiated price on ANY
 *                                           product for ANY business account
 *     remove_business_contract_price(...)   delete another account's pricing
 *
 * both `SECURITY DEFINER` with no internal is_owner() guard, because the grant
 * WAS the control. `all functions in schema public` included them. One paste of
 * the old file handed both to every signed-in customer, and replaced the live
 * DB's narrowed trigger (backend migration 163) while it was at it.
 *
 * A test can only pin the behaviour it was told to pin. This one was told the
 * wrong thing for four months and stayed green the whole time — the same shape
 * as ERR-217, where the old test pinned the off-screen dropdown.
 *
 * So the contract was inverted. This suite fails if the wide grant, the default
 * privileges, or the event trigger EVER come back, and it fails if the file
 * returns to the publicly-served tree.
 *
 * ── INVERTED A SECOND TIME, 2026-09-12 (ERR-247) ───────────────────────────
 *
 * §3 used to assert that the file still GRANTED the six by name, `to
 * authenticated, service_role`. That was right while the browser called those
 * RPCs directly. It no longer does: all seven now reach the dashboard through
 * `requireAdmin` + service_role routes (GET /api/admin/analytics/*), so the
 * narrow grant is not narrow-enough-and-necessary, it is unnecessary.
 *
 * Read that as the lesson it is, not as this file being flaky. §3 was CORRECT
 * WHEN WRITTEN, exactly like the two tests ERR-237 had to invert. What changed
 * is the world, and the test moved after it — which is the whole point of
 * pinning a contract rather than a constant. The measurement that authorises
 * this inversion is in the SQL file's header and in errors.md ERR-247: with a
 * real owner JWT and each function's REAL named params, all three sampled RPCs
 * answer 403/42501 while all seven routes answer 200 with data.
 *
 * The §4 positive controls survive both inversions untouched, because "nothing
 * dangerous found" and "nothing found" are still not the same answer.
 *
 * Run with: node --test tests/analytics-function-grants.test.js
 *
 * Logged as errors.md ERR-229, then ERR-247. Prior: ERR-010 / 029 / 035 / 232.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SQL_PATH = path.join(ROOT, 'sql', 'analytics_function_grants.sql');

/** The six analytics RPCs the admin Dashboard calls directly. Nothing else. */
const ALLOWED_FUNCTIONS = [
  'analytics_kpi_summary',
  'analytics_revenue_series',
  'analytics_refunds_series',
  'analytics_top_products',
  'analytics_customer_stats',
  'analytics_brand_breakdown',
];

function loadSql() {
  assert.ok(fs.existsSync(SQL_PATH), `migration missing at ${SQL_PATH}`);
  return fs.readFileSync(SQL_PATH, 'utf8');
}

/**
 * Strip SQL line comments so we assert against *executed* statements, never
 * prose. This matters more now than it did before: the file's header
 * deliberately QUOTES the dangerous statements in order to warn about them, so
 * a naive substring search over the raw text would fail on the warning itself.
 */
function executableSql(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const flat = () => executableSql(loadSql()).toLowerCase().replace(/\s+/g, ' ');

// ── §1. The file must not be publicly served ────────────────────────────────

test('§1 the migration lives OUTSIDE inkcartridges/ — that tree is deployed', () => {
  // inkcartridges/ is the Vercel project root with outputDirectory ".", so every
  // file in it is downloadable. This one was, at
  // https://www.inkcartridges.co.nz/sql/analytics_function_grants.sql — 200,
  // application/x-sql, 5714 bytes — publishing a recipe for minting an
  // `authenticated` JWT next to the note that the RPCs are SECURITY DEFINER.
  assert.ok(
    !SQL_PATH.includes(`${path.sep}inkcartridges${path.sep}`),
    'analytics_function_grants.sql must not live under inkcartridges/ — it would be served publicly'
  );
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'inkcartridges', 'sql')),
    'inkcartridges/sql/ must not exist — the whole directory is publicly fetchable'
  );
});

// ── §2. The grant must be NARROW ────────────────────────────────────────────

test('§2 THE BUG: no blanket grant on all functions in schema public', () => {
  assert.doesNotMatch(
    flat(),
    /grant\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+public/,
    'a blanket grant hands set_business_contract_price to every signed-in customer'
  );
});

test('§2 no ALTER DEFAULT PRIVILEGES — it would grant every FUTURE function too', () => {
  assert.doesNotMatch(
    flat(),
    /alter\s+default\s+privileges/,
    'default privileges outlive the run: every function created afterwards inherits EXECUTE'
  );
});

test('§2 no event trigger — ours would REPLACE the backend migration 163 allow-list', () => {
  const sql = flat();
  assert.doesNotMatch(sql, /create\s+event\s+trigger/, 'no event trigger may be installed from this repo');
  assert.doesNotMatch(sql, /pg_event_trigger_ddl_commands/, 'no DDL-command hook');
  assert.doesNotMatch(
    sql,
    /grant_execute_on_public_functions/,
    'the wide re-granting function must not come back'
  );
});

test('§2 nothing here is SECURITY DEFINER — this file only grants, it defines nothing', () => {
  assert.doesNotMatch(flat(), /security\s+definer/);
});

test('§2 the two migration-165 write RPCs are never granted', () => {
  const sql = flat();
  for (const fn of ['set_business_contract_price', 'remove_business_contract_price']) {
    assert.ok(!sql.includes(fn), `${fn} must never appear in an executable grant`);
  }
});

// ── §3. …and now it must grant NOTHING AT ALL ──────────────────────────────

test('§3 THE SECOND INVERSION: no EXECUTE grant survives in executable SQL', () => {
  // The browser reads analytics over GET /api/admin/analytics/* now. A grant
  // here would hand `authenticated` EXECUTE on SECURITY DEFINER functions for
  // a caller that has no use for it — and mig 163's event trigger would then
  // keep re-granting them on every CREATE/ALTER.
  assert.doesNotMatch(
    flat(),
    /grant\s+execute\s+on\s+function/,
    'the grant was retired in ERR-247 — the dashboard no longer calls these RPCs from the browser'
  );
  assert.doesNotMatch(flat(), /\bgrant\s+execute\b/, 'no EXECUTE grant of any shape');
});

test('§3 no analytics function is named in executable SQL, by any spelling', () => {
  // The §2 checks are about DANGEROUS statements. This one is about the file
  // doing nothing at all: with the grant gone, an executable line naming one of
  // these is by definition something nobody decided to add.
  const sql = flat();
  const named = [...sql.matchAll(/public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(named, [], `executable SQL still names ${named.join(', ')}`);
  for (const fn of ALLOWED_FUNCTIONS) {
    assert.ok(!sql.includes(`${fn}(`), `${fn} must not appear in executable SQL`);
  }
});

test('§3 no schema reload either — there is nothing left to make visible', () => {
  assert.doesNotMatch(flat(), /notify pgrst/, 'nothing is granted, so nothing needs a cache reload');
});

test('§3 every retired RPC is named in the PROSE, with its replacement route', () => {
  // The file is kept rather than deleted so that this explanation is what the
  // next person finds when they go looking for the grant. If the header stops
  // naming the replacements, the file has become a blank where a footgun was,
  // and the next outage gets "fixed" by pasting the grant back.
  const sql = loadSql();
  for (const fn of ALLOWED_FUNCTIONS.concat(['get_suppliers'])) {
    assert.ok(sql.includes(fn), `the header must still name ${fn} and where it went`);
  }
  assert.match(sql, /\/api\/admin\/analytics\//, 'the header must name the replacement routes');
  assert.match(sql, /172/, 'the header must say migration 172 is never to be applied');
});

// ── §4. Positive controls — the suite must not pass on an empty file ────────

test('§4 positive control — the file is real, not empty or truncated', () => {
  // Without this, deleting the file's contents would turn every doesNotMatch
  // above green. "Nothing dangerous found" and "nothing found" are not the same
  // answer, and only one of them is a pass.
  //
  // 🚨 THE CONTROL HAD TO CHANGE SHAPE WITH THE CONTRACT (ERR-247). It used to
  // read `executableSql(sql).trim().length > 100` — "there is still real SQL
  // here" — which was a perfect emptiness check while the file's job was to run
  // a grant. Now the file's job is to run NOTHING, so that assertion fails on a
  // correct file and, worse, the thing it was protecting against (an emptied
  // file silencing every doesNotMatch) is now indistinguishable from success by
  // that measure. The guard therefore moves onto the PROSE, which is what this
  // file now exists to carry. Delete the explanation and this suite goes red —
  // which is the only way "the grant is gone" stays different from "the file is
  // gone", and the next person to hit a 42501 finds the reasoning instead of a
  // blank where a footgun used to be.
  const sql = loadSql();
  assert.ok(sql.length > 2000, `file is suspiciously short (${sql.length} bytes)`);
  const commentary = sql
    .split('\n')
    .filter((line) => line.trim().startsWith('--'))
    .join('\n');
  assert.ok(
    commentary.trim().length > 1500,
    `the explanation is the file's remaining job; only ${commentary.trim().length} bytes of it left`
  );
  // And the emptiness check the §2/§3 doesNotMatch assertions actually need:
  // prove the matcher still sees the file, by matching something that IS there.
  assert.match(sql, /analytics_function_grants/, 'the file must still identify itself');
});

test('§4 positive control — the header still warns the next reader off widening', () => {
  // A 42501 from a browser RPC is no longer a thing this repo can cause OR fix:
  // the dashboard does not make that call any more. What the header must keep
  // saying is (a) what a wide grant would expose, and (b) where to actually
  // look when analytics goes dark, so nobody reaches for SQL again.
  const sql = loadSql();
  assert.match(sql, /set_business_contract_price/, 'header must name what a wide grant would expose');
  assert.match(sql, /42501/, 'header must still name the error someone will be googling');
  assert.match(sql, /migration 163/i, 'header must explain the event trigger that re-grants on DDL');
  assert.match(
    sql, /401|403|429/,
    'header must point a dark dashboard at the ROUTE\u2019s own answers, not at a grant'
  );
});
