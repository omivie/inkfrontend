/**
 * analytics-rpc-retirement-sep2026.test.js — ERR-247
 * ==================================================
 *
 * THE BROWSER NO LONGER CALLS A SECURITY DEFINER FUNCTION. THAT IS THE WHOLE
 * CONTRACT, AND IT IS THE ONLY ONE THAT ENDS THIS RECURRENCE.
 *
 * Four times — ERR-010, ERR-029, ERR-035, ERR-232 — the admin dashboard went
 * dark with `42501 permission denied for function`, and four times it was fixed
 * by restoring `GRANT EXECUTE … TO authenticated` on six analytics RPCs. The
 * fourth was not a regression. The grant had been revoked ON PURPOSE on
 * 2026-09-07, after a plain customer account read the live P&L
 * (revenue 24189.36 / gross_profit 5124.29 / aov 167.98) straight out of
 * PostgREST with the publishable anon key plus its own JWT, because the guard
 * inside the functions read
 *
 *     auth.uid() IS NOT NULL AND NOT is_owner()
 *
 * which SKIPS ITSELF when uid is null.
 *
 * Granting `authenticated` is roughly six times wider than the need, and every
 * previous round was closed exactly that way — which is why there was a fourth.
 * The backend built seven `requireAdmin` + service_role routes instead. This
 * suite pins the frontend onto them.
 *
 * MEASURED 2026-09-12 with a real owner JWT, and with the control that makes
 * the measurement mean anything: each function called with its REAL named
 * params, because an empty `{}` answers 404 PGRST202 (signature mismatch) and a
 * 404 here proves NOTHING —
 *
 *     POST /rest/v1/rpc/analytics_kpi_summary      403  42501
 *     POST /rest/v1/rpc/analytics_brand_breakdown  403  42501
 *     POST /rest/v1/rpc/get_suppliers              403  42501
 *     GET  /api/admin/analytics/kpi-summary        200  {current,previous}
 *     GET  /api/admin/analytics/revenue-series     200  {series,previous_series}
 *     GET  /api/admin/analytics/refunds-series     200  {series,reasons}
 *     GET  /api/admin/analytics/customer-stats     200  {current,previous}
 *     GET  /api/admin/analytics/top-products-rpc   200  array[10]
 *     GET  /api/admin/analytics/brand-breakdown    200  {brands}
 *     GET  /api/admin/analytics/suppliers          200  array[0]
 *
 * §1 no analytics RPC name reaches the rpc() transport
 * §2 `rpc()` itself survives — it has a legitimate non-analytics caller
 * §3 the seven routes are each named exactly once, by the right method
 * §4 brand-breakdown keeps its { brands } OBJECT shape
 * §5 every failure is NAMED, not swallowed into a bare null
 * §6 the 401 refresh is not skipped (this is why a raw fetch was not used)
 * §7 positive controls
 *
 * Run: node --test tests/analytics-rpc-retirement-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'api.js'), 'utf8');

/** The six analytics RPCs plus get_suppliers — all seven now reached by route. */
const RETIRED_RPCS = [
  'analytics_kpi_summary',
  'analytics_revenue_series',
  'analytics_refunds_series',
  'analytics_top_products',
  'analytics_customer_stats',
  'analytics_brand_breakdown',
  'get_suppliers',
];

const ROUTES = [
  '/api/admin/analytics/kpi-summary',
  '/api/admin/analytics/revenue-series',
  '/api/admin/analytics/refunds-series',
  '/api/admin/analytics/customer-stats',
  '/api/admin/analytics/top-products-rpc',
  '/api/admin/analytics/brand-breakdown',
  '/api/admin/analytics/suppliers',
];

/**
 * Strip line comments so we assert against EXECUTED code, never prose.
 * This file deliberately quotes `rpc('analytics_…')` in its own explanation of
 * what was removed, so a naive substring search would fail on the tombstone.
 * Same hazard, same remedy, as tests/analytics-function-grants.test.js.
 */
function executable(src) {
  return src
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i === -1) return line;
      // Don't cut inside a string/template that merely contains "//" (URLs).
      const before = line.slice(0, i);
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const CODE = executable(SRC);

// ── §1 no analytics RPC name reaches the rpc() transport ────────────────────

test('§1 not one of the seven retired RPC names appears in executable code', () => {
  for (const fn of RETIRED_RPCS) {
    assert.ok(
      !CODE.includes(`'${fn}'`) && !CODE.includes(`"${fn}"`),
      `${fn} is still named in executable code — the browser must not call it (ERR-247)`
    );
  }
});

test('§1 there is no rpc( call whose first argument starts with analytics_', () => {
  const calls = [...CODE.matchAll(/\brpc\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);
  const analytics = calls.filter((n) => n.startsWith('analytics_') || n === 'get_suppliers');
  assert.deepEqual(analytics, [], `these RPC calls must be routes now: ${analytics.join(', ')}`);
});

// ── §2 the transport itself survives ───────────────────────────────────────

test('§2 rpc() is NOT deleted — it still has a legitimate non-analytics caller', () => {
  // Removing the helper along with its analytics callers would be the
  // present→absent mistake ERR-158 warns about, in the other direction: it is
  // still the transport for admin_force_order_status, and for PostgREST writes
  // that have no REST route. Only the ANALYTICS callers were retired.
  assert.match(CODE, /async function rpc\(/, 'the rpc() helper must still exist');
  const calls = [...CODE.matchAll(/\brpc\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'rpc() must still be called by something, or it is dead code');
  assert.ok(
    calls.includes('admin_force_order_status'),
    `expected admin_force_order_status to still use rpc(); found: ${calls.join(', ') || '(none)'}`
  );
});

// ── §3 the seven routes, each named once ───────────────────────────────────

/**
 * Match a route as a WHOLE VALUE, never as a substring.
 *
 * `/api/admin/analytics/suppliers` is a PREFIX of
 * `/api/admin/analytics/suppliers/revenue` and `/suppliers/problem-rate`, both
 * of which are different endpoints that legitimately still use the quiet
 * getter. A `.includes()` scores three hits and then "fixes" two innocent
 * lines. This is the same shape as the printer-slug trap measured the same day
 * (`oki-mc-362dn` is a substring of `oki-mc-362dnw`, a different printer) and
 * as ERR-198, where no order number may be a prefix of another.
 *
 * A route ends at a quote, a backtick, or a `?`.
 */
function routeLines(route) {
  const re = new RegExp(route.replace(/[/]/g, '\\/') + `(?=[?'"\`])`);
  return CODE.split('\n').filter((l) => re.test(l));
}

test('§3 each of the seven replacement routes is present exactly once', () => {
  for (const route of ROUTES) {
    const lines = routeLines(route);
    assert.equal(
      lines.length, 1,
      `${route} should appear exactly once in executable code, found ${lines.length}:\n${lines.join('\n')}`
    );
  }
});

test('§3 the route matcher is whole-value — a prefix of another route is not a hit', () => {
  // Positive control for routeLines itself. /suppliers must NOT collect
  // /suppliers/revenue, or every assertion built on it is measuring the wrong
  // lines while looking perfectly green.
  assert.ok(
    CODE.includes('/api/admin/analytics/suppliers/revenue'),
    'the sibling endpoint must exist, or this control proves nothing'
  );
  const lines = routeLines('/api/admin/analytics/suppliers');
  assert.equal(lines.length, 1, 'the prefix must match only the exact route');
  assert.ok(!lines[0].includes('/suppliers/revenue'), 'and it must not be the sibling line');
});

test('§3 brand-breakdown and suppliers use the SHARED getter — they are new load', () => {
  // These two are requests the dashboard did not previously make over HTTP.
  // All seven sit under a 20/min limiter (measured `ratelimit-limit: 20`,
  // 2026-09-12) and the dashboard fans out ~16 calls per paint, so adding two
  // uncached ones is how a re-filter starts 429ing.
  for (const route of ['/api/admin/analytics/brand-breakdown', '/api/admin/analytics/suppliers']) {
    const [line] = routeLines(route);
    assert.ok(line, `${route} not found`);
    assert.match(
      line, /analyticsNamedShared/,
      `${route} must go through analyticsNamedShared (dedupe + TTL) — it is new load on a 20/min budget`
    );
  }
});

// ── §4 brand-breakdown keeps its { brands } shape ──────────────────────────

test('§4 getBrandBreakdown returns an OBJECT with .brands, never a bare array', async () => {
  // renderBrandTable() in pages/analytics.js reads `data.brands.length`.
  // "Unwrapping" to the array — the obvious tidy-up — renders
  // "Brand data unavailable" over a perfectly good payload. The old RPC
  // produced the object only because rpc() unwraps a single-element RETURNS
  // TABLE result: the shape was an accident of a transport we just removed.
  const { AdminAPI } = await import('../inkcartridges/js/admin/api.js');
  const calls = [];
  globalThis.window = {
    API: {
      get: async (p) => { calls.push(p); return { ok: true, data: { brands: [{ brand: 'HP', current_revenue: 1 }] } }; },
    },
    Auth: { session: { access_token: 't' } },
  };
  const out = await AdminAPI.getBrandBreakdown(new URLSearchParams({ from: '2026-08-01', to: '2026-09-12' }), 'revenue');
  assert.ok(out && !Array.isArray(out), 'must not be a bare array');
  assert.ok(Array.isArray(out.brands), 'must expose .brands');
  assert.equal(out.brands[0].brand, 'HP');
  assert.match(calls[0], /\/api\/admin\/analytics\/brand-breakdown\?/);
  assert.match(calls[0], /metric=revenue/, 'metric must reach the route');
});

test('§4 a bare array from the route is re-wrapped, not passed through', async () => {
  const { AdminAPI } = await import('../inkcartridges/js/admin/api.js');
  globalThis.window = {
    API: { get: async () => ({ ok: true, data: [{ brand: 'Brother' }] }) },
    Auth: { session: { access_token: 't' } },
  };
  // A different date range, or the 20s TTL from the previous test serves a hit.
  const out = await AdminAPI.getBrandBreakdown(new URLSearchParams({ from: '2020-01-01', to: '2020-01-02' }), 'orders');
  assert.ok(out && Array.isArray(out.brands), 'a future backend reshape must not blank the table');
  assert.equal(out.brands[0].brand, 'Brother');
});

// ── §5 failures are NAMED ──────────────────────────────────────────────────

test('§5 a 403 is reported by name, not swallowed into a bare null', async () => {
  const { AdminAPI, analyticsHealthSnapshot, describeAnalyticsFailure } =
    await import('../inkcartridges/js/admin/api.js');
  globalThis.window = {
    API: { get: async () => ({ ok: false, code: 'FORBIDDEN', error: 'denied' }) },
    Auth: { session: { access_token: 't' } },
  };
  const out = await AdminAPI.getRevenueSeries(new URLSearchParams({ from: '2026-08-01', to: '2026-09-12' }));
  assert.equal(out, null, 'the caller still gets null — the RENDER contract did not change');
  const health = analyticsHealthSnapshot()['revenue-series'];
  assert.ok(health, 'the failure must be recorded');
  assert.equal(health.res.status, 403);
  assert.match(health.message, /403|refused/i, 'and it must produce a sentence a page can show');
});

test('§5 describeAnalyticsFailure separates every named cause', async () => {
  const { describeAnalyticsFailure } = await import('../inkcartridges/js/admin/api.js');
  const ok = describeAnalyticsFailure({ ok: true, data: [] });
  assert.equal(ok, null, 'a SUCCESS that returned no rows is not a failure — positive control');

  const aborted = describeAnalyticsFailure({ ok: false, aborted: true });
  assert.equal(aborted, null, 'the operator changing a filter is not news');

  const limited = describeAnalyticsFailure({ ok: false, rateLimited: true, retryAfter: 44 });
  const forbidden = describeAnalyticsFailure({ ok: false, status: 403 });
  const expired = describeAnalyticsFailure({ ok: false, status: 401 });
  const offline = describeAnalyticsFailure({ ok: false, network: true, message: 'x' });

  const all = [limited, forbidden, expired, offline];
  for (const m of all) assert.ok(m && m.length > 20, 'every named cause gets a real sentence');
  assert.equal(new Set(all).size, all.length, 'four causes must produce four DIFFERENT sentences');
  assert.match(limited, /44/, 'a rate limit must carry its retry-after, not a guessed default');
});

// ── §6 the 401 refresh is not skipped ──────────────────────────────────────

test('§6 the seven go through window.API.get, NOT a raw fetch', () => {
  // analyticsHttpGetLoud does its own fetch() and therefore skips
  // API.request()'s one-shot 401 token refresh. An admin leaves the dashboard
  // open for hours, so an expiring access token is the COMMON case: routing
  // around the refresh would empty the KPI strip and tell someone who is signed
  // in to sign in again. analyticsHttpGetLoud keeps its raw fetch for the
  // ERR-204 catalogue/acquisition endpoints, which need `meta` un-stapled.
  assert.match(CODE, /async function analyticsHttpGetNamed\(/);
  const body = CODE.slice(CODE.indexOf('async function analyticsHttpGetNamed('));
  const named = body.slice(0, body.indexOf('\n}'));
  assert.match(named, /window\.API\.get\(/, 'must use the client that refreshes a 401');
  assert.ok(!/\bfetch\(/.test(named), 'must not do its own fetch — that is what skips the refresh');
});

test('§6 no analytics method calls analyticsHttpGetLoud any more', () => {
  // Not a style point: Loud is the raw-fetch one. If one of the seven drifts
  // back onto it, the 401 refresh silently stops covering that panel.
  for (const route of ROUTES) {
    const [line] = routeLines(route);
    assert.ok(line, `${route} not found`);
    assert.ok(
      !/analyticsHttpGetLoud/.test(line),
      `${route} must not use analyticsHttpGetLoud — it skips the 401 refresh`
    );
  }
});

// ── §7 positive controls ───────────────────────────────────────────────────

test('§7 positive control — the source really was read', () => {
  assert.ok(SRC.length > 50000, `admin/api.js is suspiciously short (${SRC.length} bytes)`);
  assert.ok(CODE.length > 20000, 'the comment stripper ate the file');
  assert.match(CODE, /const AdminAPI = \{/, 'the object under test must still be there');
});

test('§7 positive control — the stripper removes comments but keeps code', () => {
  const sample = executable([
    "const a = 1; // rpc('analytics_kpi_summary')",
    "/* rpc('get_suppliers') */",
    "const url = 'https://example.com/x'; // trailing",
    "const keep = rpc('admin_force_order_status');",
  ].join('\n'));
  assert.ok(!sample.includes('analytics_kpi_summary'), 'line comment must be stripped');
  assert.ok(!sample.includes('get_suppliers'), 'block comment must be stripped');
  assert.ok(sample.includes('https://example.com/x'), 'a // inside a string must survive');
  assert.ok(sample.includes('admin_force_order_status'), 'real code must survive');
});

test('§7 positive control — the tombstone explanation is still in the file', () => {
  // The measurements and the reasoning live in the source comments. If they are
  // edited out, the next person to see a blank chart has nothing to read and
  // reaches for the grant, which is how this recurred four times.
  assert.match(SRC, /42501/, 'the error someone will be googling must be named');
  assert.match(SRC, /ERR-247/, 'the entry must be findable');
  assert.match(SRC, /ERR-158/, 'the removing-a-fallback rule must still be cited');
});
