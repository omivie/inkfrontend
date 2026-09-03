/**
 * Security hardening (Sep 2026) — the FE half — ERR-202
 * =====================================================
 *
 * The backend shipped an OWASP pass and told us "nothing is required of the
 * frontend." Two of its claims did not survive measurement:
 *
 *   §3 said all three /api/search/* endpoints strip `, ( )`. Only /smart does.
 *      /api/search/by-part?q=TN251 returns 6 rows; ?q=(TN251) returns 0.
 *      (No live caller, so no user impact — but the rule is not the behaviour.
 *      Pinned in scripts/probe-search-escaping.mjs, which asks the live API.)
 *
 *   §4.3 said "no client-side escaping is needed (the backend handles it)."
 *      The admin SPA reaches Supabase DIRECTLY for three searches, so the
 *      backend's escaper never sees them. Each interpolated the operator's raw
 *      text into a comma/paren-delimited `.or()`. Measured against PostgREST:
 *
 *        "Smith, Ltd"           → 400 PGRST100 failed to parse logic tree
 *        "Acme (NZ)"            → 200 but [] — parens are literal to ilike
 *        "x,is_active.eq.false" → 400 invalid input syntax for boolean
 *
 * This file pins the fix: values crossing into a PostgREST filter are QUOTED,
 * not stripped, so punctuation stays searchable while injection stays inert.
 *
 * Run with: node --test tests/security-hardening-sep2026.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Import the REAL modules (the convention in the sibling party-picker suite),
// so the whole import graph is exercised — party-search.js pulling pgrst.js
// included. A string-surgery loader would not have caught a bad import path.
const mod = (...p) => import(pathToFileURL(path.join(ADMIN, ...p)).href);
const pgrstMod = mod('utils', 'pgrst.js');
const partyMod = mod('utils', 'party-search.js');

// ── 1. The escaper itself ───────────────────────────────────────────────────

test('pgrstValue quotes the value', async () => {
  const { pgrstValue } = await pgrstMod;
  assert.equal(pgrstValue('TN251'), '"TN251"');
});

test('pgrstLike wraps in % inside the quotes, not outside', async () => {
  const { pgrstLike } = await pgrstMod;
  // "%x%" — the wildcards must be INSIDE, or PostgREST reads them as syntax.
  assert.equal(pgrstLike('TN251'), '"%TN251%"');
});

test('the three characters that broke production are preserved verbatim', async () => {
  const { pgrstLike } = await pgrstMod;
  // This is the whole point of quoting over stripping: the operator's query
  // survives. "(2,500 pages)" is one of OUR OWN product-title suffixes.
  assert.equal(pgrstLike('Smith, Ltd'), '"%Smith, Ltd%"');
  assert.equal(pgrstLike('Acme (NZ)'), '"%Acme (NZ)%"');
  assert.equal(pgrstLike('Black (2,500 pages)'), '"%Black (2,500 pages)%"');
});

test('an injected filter is inert literal text, not syntax', async () => {
  const { pgrstLike } = await pgrstMod;
  const out = pgrstLike('x,is_active.eq.false');
  assert.equal(out, '"%x,is_active.eq.false%"');
  // The comma is inside the quotes, so it cannot terminate the ilike value and
  // start a new condition. Verified live: this returns 200 [] , not a 400.
  assert.ok(!/^[^"]*,/.test(out), 'no comma may sit outside the quotes');
});

test('quote and backslash — the only two characters that can break out', async () => {
  const { pgrstValue, pgrstLike } = await pgrstMod;
  assert.equal(pgrstValue('quote" inject'), '"quote\\" inject"');
  assert.equal(pgrstValue('back\\slash'), '"back\\\\slash"');
  // A closing quote followed by an injected condition must not survive.
  const evil = pgrstLike('a",is_active.eq.false,name.ilike."b');
  assert.ok(!/(^|[^\\])"[^"]*,is_active/.test(evil), 'must not break out of the quotes');
});

test('null and undefined do not become the strings "null"/"undefined"', async () => {
  const { pgrstValue, pgrstLike } = await pgrstMod;
  assert.equal(pgrstValue(null), '""');
  assert.equal(pgrstValue(undefined), '""');
  assert.equal(pgrstLike(null), '"%%"');
});

test('% and _ stay wildcards — a documented decision, not an oversight', async () => {
  const { pgrstLike } = await pgrstMod;
  // If this ever needs to change, add pgrstLikeExact with an ESCAPE clause.
  // Changing THESE two silently alters what every admin search box means.
  assert.equal(pgrstLike('50%'), '"%50%%"');
  assert.equal(pgrstLike('a_b'), '"%a_b%"');
});

// ── 2. POSITIVE CONTROL ─────────────────────────────────────────────────────
// A test that only asserts "punctuation is neutralised" would still pass if the
// escaper returned a constant. These pin that ordinary searches are UNCHANGED
// in meaning and that the built expression is still a working two-column OR.

test('positive control — a plain search still builds the same working filter', async () => {
  const { pgrstLike } = await pgrstMod;
  const q = 'TN251';
  const built = `name.ilike.${pgrstLike(q)},sku.ilike.${pgrstLike(q)}`;
  assert.equal(built, 'name.ilike."%TN251%",sku.ilike."%TN251%"');
  // Two conditions, one comma between them, at the top level.
  const topLevel = built.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  assert.equal(topLevel.length, 2, 'must remain exactly two OR arms');
  assert.ok(topLevel[0].startsWith('name.ilike.'));
  assert.ok(topLevel[1].startsWith('sku.ilike.'));
});

test('positive control — a punctuated search is still exactly two OR arms', async () => {
  const { pgrstLike } = await pgrstMod;
  const built = `name.ilike.${pgrstLike('Smith, Ltd')},sku.ilike.${pgrstLike('Smith, Ltd')}`;
  const topLevel = built.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  assert.equal(topLevel.length, 2, 'the embedded comma must not add an arm');
});

// ── 3. The call sites actually use it ───────────────────────────────────────
// The escaper existing is worth nothing if a call site still interpolates raw.

test('no admin .or() interpolates a bare ${...} into a filter', () => {
  const files = [
    'inkcartridges/js/admin/api.js',
    'inkcartridges/js/admin/pages/products.js',
  ];
  const offenders = [];
  for (const f of files) {
    for (const line of R(f).split('\n')) {
      if (!line.includes('.or(`')) continue;
      // ilike/eq values built by interpolation must go through pgrstLike.
      if (/ilike\.%\$\{/.test(line)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'raw interpolation into a PostgREST filter');
});

test('all three known call sites are escaped', () => {
  const api = R('inkcartridges/js/admin/api.js');
  const products = R('inkcartridges/js/admin/pages/products.js');
  assert.ok(api.includes('name.ilike.${pgrstLike(filters.search)}'), 'ribbon products');
  assert.ok(api.includes('full_name.ilike.${pgrstLike(search)}'), 'printer models');
  assert.ok(products.includes('name.ilike.${pgrstLike(_search)}'), 'products list');
});

// ── 4. getPrinters must not swallow a failure into an empty list ────────────

test('getPrinters returns null on failure, never an empty result', () => {
  const api = R('inkcartridges/js/admin/api.js');
  const body = api.slice(api.indexOf('async getPrinters('));
  const fn = body.slice(0, body.indexOf('\n  async ', 10));
  assert.ok(!/return \{ printers: \[\], total: 0 \}/.test(fn),
    'an unanswered search must not render as "no printers"');
  assert.ok(/return null/.test(fn), 'null = could not ask');
});

test('the printers page distinguishes null from empty', () => {
  const page = R('inkcartridges/js/admin/pages/printers.js');
  assert.ok(/res == null/.test(page), 'must branch on null');
  assert.ok(/Toast\.error/.test(page), 'and say so');
  assert.ok(!/const \{ printers, total \} = await AdminAPI\.getPrinters/.test(page),
    'destructuring the result would throw on null');
});

// ── 5. party-search: remote and local must agree ────────────────────────────



test('a comma in a typed name does not become part of a token', async () => {
  const party = await partyMod;
  assert.deepEqual(party.queryTokens('Walker, Vieland'), ['walker', 'vieland']);
  assert.deepEqual(party.queryTokens('Acme (NZ) Limited'), ['acme', 'nz', 'limited']);
});

test('THE BUG: "Walker, Vieland" must match a stored "Vieland Walker"', async () => {
  const party = await partyMod;
  const tokens = party.queryTokens('Walker, Vieland');
  assert.equal(
    party.matchesAllTokens('Vieland Walker vieland@example.com', tokens), true,
    'the local leg discarded every row the remote leg returned',
  );
});

test('a stored company keeps matching when the operator omits the brackets', async () => {
  const party = await partyMod;
  assert.equal(party.matchesAllTokens('Acme (NZ) Limited', party.queryTokens('acme nz limited')), true);
  assert.equal(party.matchesAllTokens('Acme NZ Limited', party.queryTokens('Acme (NZ) Limited')), true);
});

test('folding does not make the filter match everything', async () => {
  const party = await partyMod;
  // Negative control — the widening must still exclude a genuine non-match.
  assert.equal(party.matchesAllTokens('Bob Jones', party.queryTokens('Walker, Vieland')), false);
  assert.equal(party.matchesAllTokens('', party.queryTokens('walker')), false);
  assert.equal(party.matchesAllTokens('anything', []), false, 'no tokens = no match, not match-all');
});

test('the customers widening still only ADDS rows (its stated invariant)', async () => {
  const party = await partyMod;
  const calls = [];
  const api = {
    listContacts: async () => ({ contacts: [] }),
    getOrders: async () => [],
    getCustomers: async (f) => {
      calls.push(f.search);
      // Narrow query finds nothing; the widened one returns the real customer.
      return calls.length === 1 ? { customers: [] }
        : { customers: [{ first_name: 'Vieland', last_name: 'Walker', email: 'v@example.com' }] };
    },
  };
  const { sections, failed } = await party.searchParties('Walker, Vieland', api);
  assert.deepEqual(failed, []);
  const cust = sections.find((s) => s.title === 'Customers');
  assert.ok(cust, 'the widened search must surface the customer, not drop it');
  assert.equal(cust.items.length, 1);
});

// ── 6. Standing guarantees from §4.1 / §4.4 that must not regress ───────────

test('no service-role key is shipped in client config', () => {
  const cfg = R('inkcartridges/js/config.js');
  const jwts = cfg.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
  assert.ok(jwts.length > 0, 'expected at least the anon key');
  for (const t of jwts) {
    const claims = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf8'));
    assert.equal(claims.role, 'anon', `a non-anon key (${claims.role}) is in the bundle`);
  }
  assert.ok(!/sk_live_|sk_test_|SERVICE_ROLE/i.test(cfg), 'a secret key is in client config');
  assert.ok(/pk_live_|pk_test_/.test(cfg), 'Stripe key must be the publishable one');
});

test('the CSP keeps script-src free of unsafe-inline / unsafe-eval', () => {
  const v = JSON.parse(R('inkcartridges/vercel.json'));
  const all = v.headers.flatMap((h) => h.headers);
  const csp = all.find((h) => h.key === 'Content-Security-Policy');
  assert.ok(csp, 'CSP header must exist');
  const scriptSrc = csp.value.split(';').find((d) => d.trim().startsWith('script-src'));
  assert.ok(scriptSrc, 'script-src must be set');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline'");
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src must not allow 'unsafe-eval'");
  assert.ok(csp.value.includes("frame-ancestors 'none'"));
});

test('both /admin and /admin/* carry X-Robots-Tag noindex', () => {
  const v = JSON.parse(R('inkcartridges/vercel.json'));
  for (const src of ['/admin', '/admin/(.*)']) {
    const rule = v.headers.find((h) => h.source === src);
    assert.ok(rule, `no header rule for ${src}`);
    const tag = rule.headers.find((h) => h.key === 'X-Robots-Tag');
    assert.ok(tag && /noindex/.test(tag.value), `${src} must be noindex`);
  }
});
