/**
 * analytics_function_grants.sql — durability contract (ERR-035 / ERR-029 / ERR-010)
 * =================================================================================
 *
 * The admin Dashboard's live analytics RPCs (analytics_kpi_summary, …) have gone
 * dark THREE times because a backend migration revoked / dropped-and-recreated
 * public functions without re-granting EXECUTE to `authenticated`, yielding
 * `42501 permission denied for function`. The frontend self-heal makes the
 * outage graceful but cannot restore the data — only a DB grant can.
 *
 * `inkcartridges/sql/analytics_function_grants.sql` is the permanent fix. The
 * single guarantee that makes the outage UN-recurring is the EVENT TRIGGER that
 * re-grants EXECUTE on every function the moment it is created/altered. If
 * someone weakens this migration — drops the event trigger, narrows the grant,
 * or breaks idempotency — this test fails and the recurrence comes back.
 *
 * Run with: node --test tests/analytics-function-grants.test.js
 *
 * Source-of-truth fix; logged as errors.md ERR-035.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SQL_PATH = path.join(__dirname, '..', 'inkcartridges', 'sql', 'analytics_function_grants.sql');

function loadSql() {
  assert.ok(fs.existsSync(SQL_PATH), `migration missing at ${SQL_PATH}`);
  return fs.readFileSync(SQL_PATH, 'utf8');
}

// Strip SQL line comments so we assert against *executed* statements, never prose.
function executableSql(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

test('migration file exists and is non-trivial', () => {
  const sql = loadSql();
  assert.ok(sql.length > 500, 'migration is suspiciously short');
});

test('restores EXECUTE on ALL public functions to authenticated + service_role', () => {
  const sql = executableSql(loadSql()).toLowerCase().replace(/\s+/g, ' ');
  assert.match(
    sql,
    /grant execute on all functions in schema public to authenticated, service_role/,
    'must re-grant EXECUTE on all public functions (restores live data now)'
  );
});

test('sets ALTER DEFAULT PRIVILEGES so future functions inherit the grant', () => {
  const sql = executableSql(loadSql()).toLowerCase();
  assert.match(sql, /alter default privileges/, 'must set default privileges');
  assert.match(sql, /grant execute on functions to authenticated, service_role/);
});

test('installs the self-defending event trigger (the durable, anti-recurrence fix)', () => {
  const sql = executableSql(loadSql()).toLowerCase().replace(/\s+/g, ' ');
  // The event-trigger function exists, is an event_trigger, security definer.
  assert.match(sql, /create or replace function public\.grant_execute_on_public_functions\(\)/);
  assert.match(sql, /returns event_trigger/);
  assert.match(sql, /security definer/);
  // It re-grants execute inside the loop over DDL commands.
  assert.match(sql, /pg_event_trigger_ddl_commands\(\)/);
  assert.match(sql, /grant execute on function .* to authenticated, service_role/);
  // The trigger itself is wired to DDL command end for function CREATE/ALTER.
  assert.match(sql, /create event trigger trg_grant_execute_on_public_functions/);
  assert.match(sql, /on ddl_command_end/);
  assert.match(sql, /when tag in \('create function', 'alter function'\)/);
});

test('is idempotent — safe to run more than once', () => {
  const sql = executableSql(loadSql()).toLowerCase();
  // create or replace for the function; drop ... if exists before create event trigger.
  assert.match(sql, /create or replace function public\.grant_execute_on_public_functions/);
  assert.match(sql, /drop event trigger if exists trg_grant_execute_on_public_functions/);
});

test('reloads PostgREST schema cache so the grant is visible immediately', () => {
  const sql = executableSql(loadSql()).toLowerCase().replace(/\s+/g, ' ');
  assert.match(sql, /notify pgrst, 'reload schema'/);
});

test('event-trigger function never aborts the user DDL transaction on grant failure', () => {
  const sql = executableSql(loadSql()).toLowerCase();
  // an exception handler guards the grant loop
  assert.match(sql, /exception when others then/);
});

test('targets the documented Supabase project so it is applied to the right DB', () => {
  // Project ref is intentionally pinned in the header so a copy-paste applies it
  // to the correct database.
  assert.match(loadSql(), /lmdlgldjgcanknsjrcxh/);
});
