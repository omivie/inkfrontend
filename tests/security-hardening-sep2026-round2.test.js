/**
 * Security hardening round 2 (Sep 2026) — the FE half — ERR-229 … ERR-232
 * =======================================================================
 *
 * The backend's round-2 hand-off said one thing needed FE work (a footgun SQL
 * file) and that everything else was FYI with "zero impact". Measured against
 * the live site and the live database rather than read:
 *
 *   §1 UNDERSTATED. The file was not just sitting in the repo — it was
 *      PUBLISHED. https://www.inkcartridges.co.nz/sql/analytics_function_grants.sql
 *      returned 200 / application/x-sql / 5714 B, along with the other four
 *      .sql files and two dev scripts. Covered by
 *      tests/public-surface-sep2026.test.js + npm run probe:public-surface.
 *
 *   §3 TRUE. manual_retail_price really is revoked. As anon,
 *      select=id,manual_retail_price → 42501; select=id,retail_price → 200.
 *      No .select() in the repo names it. Pinned in §2 below so it stays that way.
 *
 *   §4 "ZERO IMPACT" — FALSE, twice over (ERR-231). See §1 below.
 *
 *   §5's open "CSP / Vercel host config" item — audited. Three of the site's own
 *      inline scripts were being refused in production, and the CSP was missing
 *      base-uri / object-src / form-action. See §3 below and the inline-script
 *      hash check in tests/payment-csp-paypal-sep2026.test.js §1b (ERR-230).
 *
 * Run with: node --test tests/security-hardening-sep2026-round2.test.js
 *
 * Companion to tests/security-hardening-sep2026.test.js (round 1, ERR-202).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pgrstMod = import(pathToFileURL(
  path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'pgrst.js')).href);

// ── §1. `*` — the third wildcard (ERR-231) ─────────────────────────────────
//
// PostgREST rewrites `*` into the SQL `%` inside every ilike filter, before the
// value is parsed and with no escape sequence, so round 1's "quote, never strip"
// fix cannot reach it. Measured live:
//     name.ilike."%TN2*BK%"  → GTN2130BK, CTN2345BK, CTN240BK
//     name.ilike."%TN2%BK%"  → identical
// The backend strips `*` from its own search endpoints for the same reason; our
// three admin searches go direct to Supabase, where the backend's strip never
// applies. Both halves have to agree or the party picker starts discarding rows
// the remote leg just handed it (ERR-176's failure mode).

test('§1 THE BUG: pgrstLike strips `*` — it cannot be escaped, only removed', async () => {
  const { pgrstLike } = await pgrstMod;
  assert.equal(pgrstLike('TN2*BK'), '"%TN2BK%"');
  assert.equal(pgrstLike('*'), '"%%"');
  assert.equal(pgrstLike('a*b*c'), '"%abc%"');
});

test('§1 pgrstValue does NOT strip `*` — exact lookups must stay exact', async () => {
  // `*` is only special to the pattern operators. pgrstValue also backs .eq/.in,
  // where removing a character would corrupt a SKU that legitimately has one.
  const { pgrstValue } = await pgrstMod;
  assert.equal(pgrstValue('SKU*1'), '"SKU*1"');
});

test('§1 positive control — % and _ are STILL wildcards, exactly as documented', async () => {
  // pgrst.js:43-48 calls these a decision, not an oversight. Stripping `*` must
  // not be read as licence to start stripping these.
  const { pgrstLike } = await pgrstMod;
  assert.equal(pgrstLike('50%'), '"%50%%"');
  assert.equal(pgrstLike('a_b'), '"%a_b%"');
});

test('§1 positive control — , ( ) are still PRESERVED, not stripped', async () => {
  // The whole point of round 1. "Black (2,500 pages)" is one of our own titles.
  const { pgrstLike } = await pgrstMod;
  assert.equal(pgrstLike('Black (2,500 pages)'), '"%Black (2,500 pages)%"');
  assert.equal(pgrstLike('quote" inject'), '"%quote\\" inject%"');
});

test('§1 foldFilterPunct DELETES `*` but SPACES , ( ) — measured, not guessed', async () => {
  // Live: "TN2*130" and "TN2,130" both return GTN2130BK, "TN2 130" returns
  // nothing — the backend deletes all three. The space is still right for , ( )
  // locally because they sit beside one in real text ("Walker, Vieland"), and it
  // additionally rescues the no-space case. `*` has no such convention.
  const { foldFilterPunct } = await pgrstMod;
  assert.equal(foldFilterPunct('TN*251'), 'TN251');
  assert.equal(foldFilterPunct('Walker, Vieland'), 'Walker Vieland');
  assert.equal(foldFilterPunct('Acme (NZ)'), 'Acme NZ');
  assert.equal(foldFilterPunct('Acme(NZ)'), 'Acme NZ');
});

test('§1 THE REASON: the fold is applied to the haystack too, so it must be symmetric', async () => {
  // matchesAllTokens folds BOTH sides. Spacing `*` would fold a stored "TN*251"
  // to "tn 251" and stop it matching the query "TN251" that just fetched it.
  const { foldFilterPunct } = await pgrstMod;
  const hay = foldFilterPunct('TN*251').toLowerCase();
  const token = foldFilterPunct('TN251').toLowerCase();
  assert.ok(hay.includes(token), 'a stored "TN*251" must still match a "TN251" query');
});

test('§1 party-search tokens agree with the remote leg for `*`', async () => {
  const { queryTokens, matchesAllTokens } = await import(pathToFileURL(
    path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'party-search.js')).href);
  const tokens = queryTokens('TN*251');
  assert.deepEqual(tokens, ['tn251'], 'the `*` must not survive into a token');
  assert.ok(matchesAllTokens('TN251 Supplies Ltd', tokens));
  assert.ok(matchesAllTokens('TN*251 Supplies Ltd', tokens), 'both sides fold identically');
});

test('§1 no admin .or() bypasses the escaper', () => {
  // Round 1's guard, re-asserted: a new call site that interpolates raw text
  // would also reintroduce the `*` problem.
  for (const f of ['inkcartridges/js/admin/api.js', 'inkcartridges/js/admin/pages/products.js']) {
    const src = R(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/ilike\.%\$\{/.test(src), `${f} interpolates a bare \${...} into an ilike filter`);
  }
});

// ── §2. manual_retail_price stays write-only (hand-off §3) ─────────────────

test('§2 no .select() anywhere names manual_retail_price', () => {
  // The column is revoked for anon AND authenticated (measured: 42501). Naming
  // it in a select list is not a degraded result — PostgREST fails the WHOLE
  // query with a hard 401, so one added column blanks an entire page. That is
  // exactly how ERR-193 blanked all 63 ribbon brand pages.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
        if (m[2].includes('manual_retail_price')) {
          offenders.push(`${path.relative(ROOT, p)}: ${m[2].slice(0, 60)}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'inkcartridges', 'js'));
  assert.deepEqual(offenders, [],
    'manual_retail_price is revoked for client roles; reading it 401s the whole query');
});

test('§2 positive control — the admin edit drawer still WRITES it', () => {
  // The column is write-only on purpose. If this stops being true, the owner's
  // price override silently stops saving, and §2 above would still be green.
  const src = R('inkcartridges/js/admin/pages/products.js');
  assert.ok(src.includes('data.manual_retail_price = null'), 'the clear-override path must survive');
  assert.ok(/data\.manual_retail_price = mrp/.test(src), 'the set-override path must survive');
});

// ── §3. The CSP gaps found while auditing round 1's open item ─────────────

const csp = () => {
  const cfg = JSON.parse(R('inkcartridges/vercel.json'));
  const found = [];
  for (const e of cfg.headers || []) {
    for (const h of e.headers || []) {
      if (/^content-security-policy$/i.test(h.key)) found.push(h.value);
    }
  }
  assert.equal(found.length, 1, `expected exactly one CSP, found ${found.length}`);
  return found[0];
};
const directive = (name) => csp().split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' '));

test('§3 base-uri is locked — it has NO default-src fallback', () => {
  // Without base-uri, an injected <base href="https://evil/"> repoints every
  // relative URL on the page, including the action-less <form id="payment-form">.
  // Free to set: there is no <base> tag anywhere in the repo.
  assert.equal(directive('base-uri'), "base-uri 'none'");
  const htmls = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.html')) htmls.push(p);
    }
  })(path.join(ROOT, 'inkcartridges'));
  for (const f of htmls) {
    assert.ok(!/<base\s/i.test(fs.readFileSync(f, 'utf8')),
      `${path.relative(ROOT, f)} has a <base> tag — base-uri 'none' would break it`);
  }
});

test('§3 object-src is locked', () => {
  assert.equal(directive('object-src'), "object-src 'none'");
});

test('§3 form-action allows self and the payment origins, and nothing else', () => {
  // NOT bare 'self'. PayPal's zoid layer can create a form in OUR document
  // targeting paypal.com when a popup is blocked, and #paypal-button-container
  // sits inside <form id="payment-form">. Those origins are already trusted in
  // script-src / frame-src / connect-src, so allowing them as form targets costs
  // nothing — the attack form-action stops is a post to an ATTACKER's origin,
  // blocked either way. ERR-225 is what happens when we economise here.
  const d = directive('form-action');
  assert.ok(d, 'form-action must exist — it has no default-src fallback');
  for (const need of ["'self'", 'https://www.paypal.com', 'https://*.paypal.com',
                      'https://js.stripe.com', 'https://hooks.stripe.com']) {
    assert.ok(d.includes(need), `form-action must allow ${need}`);
  }
  assert.ok(!d.includes('*') || !/form-action[^;]*\s\*(\s|$)/.test(d),
    'form-action must never be a bare wildcard');
});

test('§3 every form on the site posts same-origin, so form-action cannot break one', () => {
  const offenders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.html')) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/<form[^>]*\saction\s*=\s*["']([^"']*)["']/gi)) {
        if (/^https?:\/\//i.test(m[1])) offenders.push(`${path.relative(ROOT, p)} → ${m[1]}`);
      }
    }
  })(path.join(ROOT, 'inkcartridges'));
  assert.deepEqual(offenders, [], 'a cross-origin form action would be blocked by form-action');
});

test('§3 the round-1 guarantees are untouched', () => {
  const s = directive('script-src');
  assert.ok(!s.includes("'unsafe-inline'"), "script-src must never carry 'unsafe-inline'");
  assert.ok(!s.includes("'unsafe-eval'"), "script-src must never carry 'unsafe-eval'");
  assert.equal(directive('frame-ancestors'), "frame-ancestors 'none'");
});

test('§3 the CSP string is well formed', () => {
  const v = csp();
  assert.ok(!v.includes(';;'), 'empty directive');
  assert.ok(!v.trim().endsWith(';'), 'trailing semicolon');
  assert.ok(!v.includes('  '), 'double space');
});

// ── §4. Round 1's anon-key guard, widened ─────────────────────────────────

test('§4 site-guard.js ships an anon key too, and it must also be anon', () => {
  // Round 1 pinned config.js only. site-guard.js is deliberately self-contained
  // and carries a second copy of the key, so a bad paste there passed CI.
  for (const file of ['inkcartridges/js/config.js', 'inkcartridges/js/site-guard.js']) {
    const src = R(file);
    assert.ok(!/sk_live_|sk_test_|SERVICE_ROLE|service_role/i.test(src),
      `${file} must not contain service-role material`);
    const jwts = src.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g) || [];
    assert.ok(jwts.length > 0, `${file} should carry the anon key`);
    for (const jwt of jwts) {
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
      assert.equal(claims.role, 'anon', `${file} ships a "${claims.role}" key, not anon`);
    }
  }
});
