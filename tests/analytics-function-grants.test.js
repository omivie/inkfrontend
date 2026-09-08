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
 * So the contract is now inverted. This suite fails if the wide grant, the
 * default privileges, or the event trigger EVER come back, and it fails if the
 * file returns to the publicly-served tree.
 *
 * Run with: node --test tests/analytics-function-grants.test.js
 *
 * Logged as errors.md ERR-229. Prior incidents: ERR-010 / ERR-029 / ERR-035.
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

// ── §3. …but it must still do its job ───────────────────────────────────────

test('§3 grants EXECUTE on each of the six analytics RPCs, by name', () => {
  const sql = flat();
  assert.match(sql, /grant\s+execute\s+on\s+function/, 'must still grant the analytics RPCs');
  for (const fn of ALLOWED_FUNCTIONS) {
    assert.ok(sql.includes(`public.${fn}(`), `${fn} must be granted with an explicit signature`);
  }
  assert.match(sql, /to\s+authenticated,\s*service_role/, 'both roles still need EXECUTE');
});

test('§3 the allow-list is EXACTLY six functions — no quiet additions', () => {
  // Every `public.<name>(` in executable SQL must be one of the six. This is the
  // assertion that catches a seventh function being slipped into the list.
  const named = [...flat().matchAll(/public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]);
  const unique = [...new Set(named)];
  assert.deepEqual(
    unique.slice().sort(),
    ALLOWED_FUNCTIONS.slice().sort(),
    `executable SQL names ${unique.length} function(s); expected exactly the six analytics RPCs`
  );
});

test('§3 reloads the PostgREST schema cache so the grant is visible immediately', () => {
  assert.match(flat(), /notify pgrst, 'reload schema'/);
});

test('§3 targets the documented Supabase project so it is applied to the right DB', () => {
  assert.match(loadSql(), /lmdlgldjgcanknsjrcxh/);
});

// ── §4. Positive controls — the suite must not pass on an empty file ────────

test('§4 positive control — the file is real, not empty or truncated', () => {
  // Without this, deleting the file's contents would turn every doesNotMatch
  // above green. "Nothing dangerous found" and "nothing found" are not the same
  // answer, and only one of them is a pass.
  const sql = loadSql();
  assert.ok(sql.length > 1000, `migration is suspiciously short (${sql.length} bytes)`);
  assert.ok(executableSql(sql).trim().length > 100, 'file has no executable SQL left in it');
});

test('§4 positive control — the header still warns the next reader off widening', () => {
  // The remedy for a 42501 recurrence is backend migration 163, not a wider
  // grant. If that sentence is ever edited out, the footgun is one helpful
  // person away from being reloaded.
  const sql = loadSql();
  assert.match(sql, /migration 163/i, 'header must point the recurrence fix at backend migration 163');
  assert.match(sql, /set_business_contract_price/, 'header must name what a wide grant would expose');
});
