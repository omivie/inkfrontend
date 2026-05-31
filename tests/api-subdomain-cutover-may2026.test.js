/**
 * API subdomain cutover (May 2026)
 * ================================
 *
 * The storefront's `/api/*` calls used to travel
 *   Browser → Cloudflare → Vercel → Render
 * via a Vercel rewrite. That extra Vercel hop was the flaky link behind the
 * /shop 504s and the multi-second skeleton-loader hangs (DB query was 3.7ms;
 * Render direct was ~0.2s; only the proxied path stalled). The fix is a direct,
 * Cloudflare-proxied, edge-cached origin: https://api.inkcartridges.co.nz.
 *
 * Frontend contract pinned here (spec: backend handoff
 * "api-subdomain-cutover-may2026.md"):
 *
 *   §1 Config.API_URL points production (www + apex) at the api subdomain, and
 *      everything else (localhost / Vercel previews) at the Render origin
 *      direct — never the empty-string relative-proxy mode anymore.
 *   §2 The `/api/:path*` rewrite is removed from vercel.json (the slow hop),
 *      while the SPA + SEO prerender rewrites are preserved.
 *   §3 CSP connect-src allows the api subdomain (else the browser blocks the
 *      cross-origin XHR), and still allows Render (dev/preview + rollback).
 *   §4 The shared fetch wrapper does NOT send cookies on anonymous reads — it
 *      attaches credentials only when an Authorization header is present, so
 *      public catalog reads keep hitting the Cloudflare edge cache. (Sending
 *      the sb-* cookie cross-origin would make Cloudflare bypass cache on every
 *      visitor — the single biggest perf gotcha in the cutover.)
 *   §5 No code makes a bare relative `/api/...` fetch (those would 404 once the
 *      rewrite is gone) and no cache-buster query param is appended to reads.
 *   §6 HTML preconnect/dns-prefetch hints target the api subdomain, not the
 *      now-unused Render origin.
 *
 * Run with: node --test tests/api-subdomain-cutover-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

const API_SUBDOMAIN = 'https://api.inkcartridges.co.nz';
const RENDER_ORIGIN = 'https://ink-backend-zaeq.onrender.com';

// ───────────────────────────────────────────────────────────────────────────
// §1  Config.API_URL
// ───────────────────────────────────────────────────────────────────────────

test('§1 production (www + apex) resolves API_URL to the api subdomain', () => {
  const c = read('js/config.js');
  assert.ok(
    c.includes(`? '${API_SUBDOMAIN}'`),
    'the production branch of API_URL must resolve to the api subdomain'
  );
  assert.ok(
    c.includes("location.hostname === 'www.inkcartridges.co.nz'") &&
      c.includes("location.hostname === 'inkcartridges.co.nz'"),
    'the prod-host gate must match BOTH www and apex (the two CORS-allowed origins)'
  );
});

test('§1 non-prod hosts (localhost / previews) fall back to Render direct', () => {
  const c = read('js/config.js');
  assert.ok(
    c.includes(`: '${RENDER_ORIGIN}'`),
    'the fallback branch of API_URL must be the Render origin'
  );
});

test('§1 API_URL is never the empty string (relative-proxy mode is gone)', () => {
  const c = read('js/config.js');
  assert.ok(
    !/API_URL:\s*\(location\.hostname[\s\S]*?\?\s*[\s\S]*?:\s*''/.test(c),
    'API_URL must always be an absolute origin now that the /api rewrite is deleted'
  );
});

// ───────────────────────────────────────────────────────────────────────────
// §2  vercel.json rewrite removal
// ───────────────────────────────────────────────────────────────────────────

test('§2 vercel.json is valid JSON', () => {
  assert.doesNotThrow(() => JSON.parse(read('vercel.json')));
});

test('§2 the /api/* rewrite is deleted (the slow Vercel → Render hop)', () => {
  const v = JSON.parse(read('vercel.json'));
  const apiRewrites = (v.rewrites || []).filter((r) =>
    String(r.source || '').startsWith('/api/')
  );
  assert.deepStrictEqual(
    apiRewrites,
    [],
    'no rewrite may proxy /api/* — the storefront calls the api subdomain directly now'
  );
});

test('§2 SPA + SEO prerender rewrites are preserved (leave other rewrites alone)', () => {
  const v = JSON.parse(read('vercel.json'));
  assert.ok(Array.isArray(v.rewrites) && v.rewrites.length > 0, 'rewrites block must remain');
  const sources = v.rewrites.map((r) => r.source);
  for (const keep of ['/shop', '/cart', '/p/:sku', '/sitemap.xml']) {
    assert.ok(sources.includes(keep), `non-API rewrite ${keep} must be preserved`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §3  CSP connect-src
// ───────────────────────────────────────────────────────────────────────────

function getHeaderCSP() {
  const v = JSON.parse(read('vercel.json'));
  for (const blk of v.headers || []) {
    for (const h of blk.headers || []) {
      if (h.key === 'Content-Security-Policy') return h.value;
    }
  }
  return '';
}

test('§3 CSP connect-src allows the api subdomain', () => {
  const csp = getHeaderCSP();
  const connect = (csp.match(/connect-src([^;]*)/) || [, ''])[1];
  assert.ok(
    connect.includes(API_SUBDOMAIN),
    'connect-src must include the api subdomain or the browser blocks the cross-origin fetch'
  );
});

test('§3 CSP connect-src still allows Render (dev/preview direct + rollback)', () => {
  const csp = getHeaderCSP();
  const connect = (csp.match(/connect-src([^;]*)/) || [, ''])[1];
  assert.ok(
    connect.includes(RENDER_ORIGIN),
    'connect-src must keep the Render origin for non-prod hosts and rollback safety'
  );
});

// ───────────────────────────────────────────────────────────────────────────
// §4  Cookie / credentials discipline (edge-cache safety)
// ───────────────────────────────────────────────────────────────────────────

test('§4 the shared fetch wrapper does not hard-code credentials:include', () => {
  const api = read('js/api.js');
  // The cutover-aware wrapper must gate credentials on auth, never force-include.
  assert.ok(
    !/signal: controller\.signal,\s*\n\s*credentials:\s*['"]include['"]/.test(api),
    '_fetchWithAuth must not unconditionally send credentials (would bust the edge cache on public reads)'
  );
});

test('§4 _fetchWithAuth gates credentials on the Authorization header', () => {
  const api = read('js/api.js');
  assert.ok(
    /credentials:\s*hasAuthHeader\s*\?\s*['"]include['"]\s*:\s*['"]omit['"]/.test(api),
    'anonymous reads must use credentials:omit (cookies dropped cross-origin → cache HIT); authed → include'
  );
});

test('§4 the raw JSON read also omits credentials when anonymous', () => {
  const api = read('js/api.js');
  assert.ok(
    /credentials:\s*token\s*\?\s*['"]include['"]\s*:\s*['"]omit['"]/.test(api),
    '_rawJsonFetch must omit cookies for the anonymous read path'
  );
});

// ───────────────────────────────────────────────────────────────────────────
// §5  No bare relative /api fetches, no cache-busters on reads
// ───────────────────────────────────────────────────────────────────────────

function walk(dir, exts, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

test('§5 no code fetches a bare relative /api/... (would 404 without the rewrite)', () => {
  const files = [
    ...walk(path.join(ICR, 'js'), ['.js']),
    ...walk(path.join(ICR, 'html'), ['.html']),
  ];
  const bareRel = /fetch\(\s*['"`]\/api\//;
  const offenders = files
    .filter((f) => bareRel.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ICR, f));
  assert.deepStrictEqual(
    offenders,
    [],
    `these files fetch a bare relative /api path that would 404 without the rewrite: ${offenders.join(', ')}`
  );
});

test('§5 no cache-buster query param on the shared API request layer', () => {
  const api = read('js/api.js');
  assert.ok(!/[?&]_t=\$\{?Date\.now/.test(api), 'no ?_t=Date.now() cache-buster in api.js');
  assert.ok(!/[?&]cb=\$\{?Date\.now/.test(api), 'no ?cb=Date.now() cache-buster in api.js');
});

// ───────────────────────────────────────────────────────────────────────────
// §6  HTML preconnect points at the host the browser actually uses
// ───────────────────────────────────────────────────────────────────────────

test('§6 no HTML preconnect/dns-prefetch still points at the Render origin', () => {
  const htmlFiles = [
    path.join(ICR, 'index.html'),
    path.join(ICR, '404.html'),
    ...walk(path.join(ICR, 'html'), ['.html']),
  ].filter((f) => fs.existsSync(f));
  const stale = htmlFiles
    .filter((f) => fs.readFileSync(f, 'utf8').includes(RENDER_ORIGIN))
    .map((f) => path.relative(ICR, f));
  assert.deepStrictEqual(
    stale,
    [],
    `these HTML files still reference the Render origin (preconnect should target the api subdomain): ${stale.join(', ')}`
  );
});

test('§6 the homepage preconnects the api subdomain', () => {
  const idx = read('index.html');
  assert.match(
    idx,
    new RegExp(`rel="preconnect"\\s+href="${API_SUBDOMAIN.replace(/\./g, '\\.')}"`),
    'index.html must preconnect the api subdomain so the first catalog call is warm'
  );
});
