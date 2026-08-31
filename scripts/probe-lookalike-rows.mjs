#!/usr/bin/env node
/**
 * probe-lookalike-rows.mjs
 * ========================
 * Can a shopper tell every two cards in the catalogue apart?
 *
 * WHY A PROBE AND NOT A TEST
 * --------------------------
 * On 2026-08-31 the backend repaired a family of look-alike duplicate rows,
 * guarded the importer against recurrence, and handed the frontend
 * `lookalike-duplicate-rows-FE-handoff-aug2026.md`. Its §7 reports that
 * identical-name, identical-name-tail and shared-slug scans "all return zero
 * across active rows", and its §2 that "the importer is guarded so it cannot
 * recur".
 *
 * Run against live production the next morning, the identical-name and
 * shared-slug scans each returned one group — `CBCI3CMY` and `CBCI6CMY`, two
 * active, separately-purchasable rows with the same name, slug, colour and
 * price, both rendering on the exact page the customer had reported. The newer
 * of the two was created at 2026-08-31T14:26:23Z, inside the repair window.
 *
 * No unit test can see this, because nothing in this repo is wrong: the code
 * printed exactly what the API gave it. The thing that breaks is data, arriving
 * nightly from a supplier feed, and the only symptom is a shopper staring at two
 * identical cards. So the frontend measures it rather than assuming it.
 *
 * A green run here is the evidence for the sentence "there are no look-alike
 * duplicate rows today". Nothing else in this repo can say that.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ-ONLY, WITH NO WRITE PATH AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 * There is no --record, no --update-baseline, no fixture file and no write verb
 * of any kind, and the mode is printed on every run. A probe that can record is
 * a probe that can pass because it just overwrote what it was comparing against
 * — that is how `sweep:b2b` ate a committed fixture on 2026-08-12. If this
 * script is ever taught to write, it stops being evidence.
 *
 * It needs no credentials either: every endpoint it reads is the public
 * catalogue, the same URLs a shopper's browser fetches.
 *
 * THE DERIVATION IS THE SHIPPED ONE, LOADED — NEVER RE-IMPLEMENTED
 * ----------------------------------------------------------------
 * Scan 4 asks the question that actually matters — "would these two render as
 * indistinguishable cards?" — and it answers it with `ProductIdentity` and
 * `ProductName.clean` evaluated out of `js/utils.js` in a vm, not with a copy.
 * A re-implementation would drift from the storefront and start reporting on a
 * page that does not exist. Same rule, same reason, as probe-catalogue-pathway.
 *
 * WHAT IT MEASURES
 * ----------------
 *   1  identical name          — the handoff's own scan
 *   2  identical name-tail     — names differing only in their lead code token
 *   3  shared slug             — two rows, one URL: a canonical collision
 *   4  identical rendered card — what §7 did not check, via the shipped code
 *   5  redirect manifest       — every §4a/§4b SKU that was claimed redirected
 *   6  endpoint disagreement   — a row /api/products lists and /api/shop hides
 *
 * WHAT IT DOES NOT MEASURE
 * ------------------------
 * Inactive products. `/api/products` does not return them and an inactive row is
 * unreachable on purpose; counting deliberate absence as breakage would bury the
 * real findings.
 *
 * Whether a duplicate is "really" a duplicate. Two rows that look identical may
 * be two genuinely different cartridges badly named — which is exactly what the
 * original Canon report turned out to be. This probe reports that a shopper
 * cannot tell them apart. Deciding which row is right is the backend's call and
 * needs the supplier feed; the storefront never merges rows on a guess.
 *
 * Usage:
 *   node scripts/probe-lookalike-rows.mjs
 *   node scripts/probe-lookalike-rows.mjs --json
 *   API_BASE=http://localhost:3001 node scripts/probe-lookalike-rows.mjs --fast
 *
 * Exit: 0 clean · 1 findings · 2 could not run (NOT a pass — nothing measured)
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The shop chip a product lands on is derived from `product_type`, NOT from the
// `category` field — that one carries the raw supplier value (`CON-INK`), which
// no /api/shop query understands. This is the shipped mapping, the same one
// probe-catalogue-pathway.mjs walks; re-deriving it by hand is how you end up
// querying `category=con-ink` and calling an empty result "undetermined".
import { categoryForType } from '../inkcartridges/js/admin/utils/catalogue-pathway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const ARGS = process.argv.slice(2);
const HAS = (f) => ARGS.includes(f);
const JSON_OUT = HAS('--json');
const FAST = HAS('--fast');

const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const PAGE_LIMIT = 200;
const MAX_PAGES = 40;               // 8,000 rows — well past the ~4,100 live
const MIN_PLAUSIBLE_PRODUCTS = 500; // a short catalogue means we did not look
const MAX_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 20000;
const SERVER_ERROR_BACKOFF_MS = 15000;

/**
 * Pace between requests. Running the catalogue sweep flat-out reliably 502s the
 * backend instance for minutes (ERR-188 is that outage seen from this side). The
 * delay lives inside get() so no caller can forget it. Same default as
 * probe-catalogue-pathway.mjs, against the same API.
 */
const REQUEST_DELAY_MS = FAST ? 0 : Number(process.env.PROBE_DELAY_MS || 650);

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (ch = '─') => say(ch.repeat(78));

let pass = 0;
const findings = [];
const notes = [];
const ok = (name, detail) => { pass++; say(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => { findings.push({ name, detail }); say(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`); };
const note = (t) => { notes.push(t); say(`  \x1b[36mi\x1b[0m ${t}`); };

/** "We could not look" — exit 2, never 1. A skip is not a pass. */
function cannotRun(msg) {
  if (JSON_OUT) console.log(JSON.stringify({ status: 'cannot_run', reason: msg }, null, 2));
  else {
    say('');
    say(`\x1b[33m⚠ Could not run: ${msg}\x1b[0m`);
    say('  This is NOT a pass. Nothing was measured.');
    say('');
  }
  process.exit(2);
}

/**
 * The ONLY request this script makes. There is no other verb and no other path —
 * if you are adding one, stop and ask whether this is still a read-only probe.
 */
async function get(pathAndQuery, { manualRedirect = false } = {}) {
  const url = `${API_BASE}${pathAndQuery}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (REQUEST_DELAY_MS) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: manualRedirect ? 'manual' : 'follow',
      });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1) return { ok: false, status: 0, error: e.message };
      continue;
    }
    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      say(`     (rate limited, waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s…)`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      continue;
    }
    if (res.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
      say(`     (${res.status}, waiting ${SERVER_ERROR_BACKOFF_MS / 1000}s…)`);
      await new Promise((r) => setTimeout(r, SERVER_ERROR_BACKOFF_MS));
      continue;
    }
    if (manualRedirect && res.status >= 300 && res.status < 400) {
      return { ok: true, status: res.status, location: res.headers.get('location') || '', json: null };
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, location: '' };
  }
  return { ok: false, status: 0, error: 'exhausted attempts' };
}

/**
 * Evaluate the shipped storefront module and hand back the real helpers.
 *
 * `js/utils.js` is a browser script, not an ES module — it ends in
 * `window.X = X`. Running it in a `node:vm` with a minimal inert window shim is
 * what lets this probe use the site's own identity derivation instead of an
 * approximation. Nothing here performs I/O; a module that started making
 * requests on load would be a finding in itself.
 */
function loadShipped() {
  const sandbox = {
    window: {}, document: { addEventListener() {}, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgent: 'node', sendBeacon() {} },
    location: {
      href: 'https://www.inkcartridges.co.nz/', origin: 'https://www.inkcartridges.co.nz',
      protocol: 'https:', hostname: 'www.inkcartridges.co.nz', host: 'www.inkcartridges.co.nz',
      pathname: '/', search: '', hash: '', port: '',
    },
    Config: { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', API_BASE_URL: API_BASE },
    DebugLog: { log() {}, warn() {}, error() {}, info() {} },
    AbortController, URLSearchParams, URL, TextEncoder, TextDecoder, crypto, performance,
  };
  Object.assign(sandbox.window, {
    location: sandbox.location, document: sandbox.document,
    localStorage: sandbox.localStorage, sessionStorage: sandbox.sessionStorage,
    navigator: sandbox.navigator, fetch: sandbox.fetch,
    Config: sandbox.Config, DebugLog: sandbox.DebugLog,
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const file = path.join(SITE, 'js/utils.js');
  if (!fs.existsSync(file)) cannotRun('js/utils.js is missing — the shipped derivation cannot be loaded.');
  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'js/utils.js' });
  } catch (e) {
    cannotRun(`js/utils.js could not be evaluated (${e.message}). The probe will not guess at the derivation.`);
  }

  const ProductIdentity = sandbox.window.ProductIdentity || sandbox.ProductIdentity;
  const ProductName = sandbox.window.ProductName || sandbox.ProductName;
  if (typeof ProductIdentity?.lookalikeGroups !== 'function') {
    cannotRun('ProductIdentity.lookalikeGroups is not a function after loading js/utils.js. '
      + 'The card-identity derivation cannot be measured — this is not "no look-alikes".');
  }
  if (typeof ProductName?.clean !== 'function') {
    cannotRun('ProductName.clean is not a function after loading js/utils.js.');
  }
  return { ProductIdentity, ProductName };
}

/** Page the public catalogue. `/api/products` returns ACTIVE rows only. */
async function walkCatalogue() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await get(`/api/products?limit=${PAGE_LIMIT}&page=${page}`);
    if (!res.ok) {
      if (page === 1) cannotRun(`/api/products?page=1 returned ${res.status || res.error}. Nothing was measured.`);
      note(`page ${page} returned ${res.status || res.error}; stopping the walk early`);
      break;
    }
    const body = res.json || {};
    const batch = (body.data && (body.data.products || body.data)) || body.products || [];
    const list = Array.isArray(batch) ? batch : [];
    for (const p of list) {
      // The endpoint reports `removed_from_page` and pages under a non-stable
      // sort, so the same row can arrive twice. De-dupe on id, or a row would
      // group with itself and manufacture a finding.
      const id = p && (p.id || p.sku);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(p);
    }
    const meta = body.meta || {};
    if (!list.length || meta.has_next === false) break;
  }
  if (all.length < MIN_PLAUSIBLE_PRODUCTS) {
    cannotRun(`only ${all.length} products came back (expected 500+). The catalogue was not fully read, `
      + 'so "no look-alikes" would be a statement about the walk, not the catalogue.');
  }
  return all;
}

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
const priceOf = (p) => {
  const n = Number(p && (p.retail_price != null ? p.retail_price : p.price));
  return Number.isFinite(n) ? n.toFixed(2) : '?';
};

/** Group rows by a key; return only the groups with more than one member. */
function collide(rows, keyFn) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  return [...buckets.values()].filter((g) => g.length > 1);
}

const describe = (g) => g.map((p) => `${String(p.sku).padEnd(14)} $${priceOf(p)}  ${p.name}`).join('\n');

/**
 * Every SKU the handoff's §4a/§4b tables claim was given a redirect, plus the
 * one it deliberately did NOT redirect — which matters just as much, because a
 * redirect there would 301 every request for a live product onto the wrong
 * cartridge.
 */
const REDIRECT_MANIFEST = [
  { from: 'CBCI3BK-2',  to: 'CBCI3BK',      expect: 'redirect', why: '§4a — the BCI-3e black, re-anchored' },
  { from: 'CBCI6CMY',   to: 'CBCI3CMY',     expect: 'redirect', why: '§4a — BCI CMY 3-pack' },
  { from: 'CBCI6KCMY',  to: 'CBCI3KCMY',    expect: 'redirect', why: '§4a — BCI KCMY 4-pack' },
  { from: 'CT073CMY',   to: 'C73NCMY',      expect: 'redirect', why: '§4b — deactivated duplicate pack' },
  { from: 'CT081CMY',   to: 'C81NCMY',      expect: 'redirect', why: '§4b — deactivated duplicate pack' },
  { from: 'CT081KCMY',  to: 'C81NKCMY',     expect: 'redirect', why: '§4b — deactivated duplicate pack' },
  { from: 'CIS365CMY',  to: 'CCLT406SCMY',  expect: 'redirect', why: '§4b — deactivated duplicate pack' },
  { from: 'CIS365KCMY', to: 'CCLT406SKCMY', expect: 'redirect', why: '§4b — deactivated duplicate pack' },
  // §3: CBCI3BK stays LIVE and must NOT redirect. The backend consults
  // sku_redirects before a direct SKU match, so a row here would send every
  // request for the live BCI-3e black to the BCI-6 black instead.
  { from: 'CBCI3BK',    to: null,           expect: 'live',     why: '§3 — deliberately NOT redirected' },
];

async function main() {
  const started = Date.now();
  rule('═');
  say('  LOOK-ALIKE DUPLICATE ROWS — live catalogue probe');
  rule('═');
  say(`  Mode: \x1b[1mREAD-ONLY\x1b[0m — this script has no write verb, no --record,`);
  say('        no baseline file and no credentials. It only GETs public URLs.');
  say(`  API : ${API_BASE}`);
  say(`  Pace: ${REQUEST_DELAY_MS}ms between requests${FAST ? '  \x1b[33m(--fast: never use against production)\x1b[0m' : ''}`);
  say('');

  const { ProductIdentity } = loadShipped();
  ok('shipped derivation loaded', 'ProductIdentity + ProductName from js/utils.js (not re-implemented)');

  say('');
  say('  Walking the active catalogue…');
  const rows = await walkCatalogue();
  ok('catalogue read', `${rows.length} active products`);

  say('');
  rule();
  say('  SCAN 1–4 — can a shopper tell every two rows apart?');
  rule();

  // ── 1. identical name ──────────────────────────────────────────────────
  const byName = collide(rows, (p) => norm(p.name));
  if (byName.length === 0) ok('identical name', 'zero groups across active rows');
  else bad('identical name', `${byName.length} group(s):\n` + byName.map(describe).join('\n\n'));

  // ── 2. identical name-tail ─────────────────────────────────────────────
  // Two names differing ONLY in their leading compact code token. This is the
  // §4c drum class: `DR233CLC …` vs `DR233CLM …` are fine, but a tail collision
  // where the lead token is the only difference means the shopper is reading a
  // 40-character sentence to find one changed letter at the very start.
  // Reported as a NOTE, not a finding: it is a legibility smell, and the
  // compact grammar the backend adopted produces it by design.
  const byTail = collide(rows, (p) => {
    const n = norm(p.name);
    const i = n.indexOf(' ');
    return i > 0 ? `${n.slice(i + 1)}|${priceOf(p)}|${norm(p.color)}` : '';
  });
  if (byTail.length === 0) ok('identical name-tail', 'zero groups');
  else note(`identical name-tail: ${byTail.length} group(s) differ only in their lead code token `
    + '(legibility smell, not a defect — the compact grammar produces this by design)');

  // ── 3. shared slug ─────────────────────────────────────────────────────
  const bySlug = collide(rows, (p) => norm(p.slug));
  if (bySlug.length === 0) ok('shared slug', 'zero groups — every active row has its own URL');
  else bad('shared slug', `${bySlug.length} group(s) — two products, one canonical URL:\n`
    + bySlug.map((g) => `  ${g[0].slug}\n` + describe(g)).join('\n\n'));

  // ── 4. identical rendered card ─────────────────────────────────────────
  const byCard = ProductIdentity.lookalikeGroups(rows);
  if (byCard.length === 0) {
    ok('identical rendered card', 'zero groups — every card is distinguishable as rendered');
  } else {
    bad('identical rendered card',
      `${byCard.length} group(s) — same cleaned title, price, colour AND pack type.\n`
      + 'A shopper is being asked to choose between these with no information:\n\n'
      + byCard.map(describe).join('\n\n'));
  }

  // ── 5. redirect manifest ───────────────────────────────────────────────
  say('');
  rule();
  say('  SCAN 5 — every SKU the handoff claims was redirected');
  rule();
  for (const entry of REDIRECT_MANIFEST) {
    const res = await get(`/api/products/${encodeURIComponent(entry.from)}`, { manualRedirect: true });
    const redirected = res.status >= 300 && res.status < 400;
    const target = redirected ? String(res.location || '').split('/').pop() : '';

    if (entry.expect === 'redirect') {
      if (redirected && target === entry.to) {
        ok(`${entry.from} → ${entry.to}`, `${res.status}`);
      } else if (redirected) {
        bad(`${entry.from} → ${entry.to}`, `${entry.why}: redirects to ${target || res.location}, not ${entry.to}`);
      } else if (res.status === 404) {
        note(`${entry.from}: 404 — the row is gone and no redirect was written. `
          + `${entry.why}. Any live link to it dead-ends instead of reaching ${entry.to}.`);
      } else {
        const p = (res.json && (res.json.data || res.json)) || {};
        bad(`${entry.from} → ${entry.to}`,
          `${entry.why}: NO redirect. Returns ${res.status} with sku=${p.sku || '?'}`
          + (p.canonical_url ? `, canonical_url=${String(p.canonical_url).split('/').pop()}` : '')
          + `.\n      A stale link keeps its old URL and Google keeps indexing both.`);
      }
    } else {
      if (redirected) {
        bad(`${entry.from} must NOT redirect`,
          `${entry.why}, but it ${res.status}s to ${target}. Every request for a LIVE product `
          + 'is being sent to a different cartridge.');
      } else if (res.ok) {
        ok(`${entry.from} stays live`, `${res.status}, no redirect (correct)`);
      } else {
        bad(`${entry.from} must stay live`, `${entry.why}, but it returns ${res.status}.`);
      }
    }
  }

  // ── 6. endpoint disagreement ───────────────────────────────────────────
  // A row the shopper-facing grid hides but /api/products still lists is either
  // an active product with no chip (unreachable — nobody can find it) or an
  // inactive one leaking into a public list. Both are worth a sentence; the FE
  // reads BOTH endpoints, so the two answers have to agree.
  say('');
  rule();
  say('  SCAN 6 — do /api/products and /api/shop agree?');
  rule();
  const suspects = REDIRECT_MANIFEST
    .filter((e) => e.expect === 'redirect')
    .map((e) => e.from)
    .filter((sku) => rows.some((p) => p.sku === sku));
  if (suspects.length === 0) {
    ok('no superseded SKU is still listed', 'every redirected/deactivated row is absent from /api/products');
  } else {
    for (const sku of suspects) {
      const row = rows.find((p) => p.sku === sku);
      const code = (row.series_codes || [])[0];
      const brandSlug = norm((row.brand && (row.brand.slug || row.brand.name)) || '').replace(/\s+/g, '-');
      const cat = categoryForType(row.product_type) || '';
      let onShop = null;
      if (code && brandSlug && cat) {
        const res = await get(`/api/shop?brand=${encodeURIComponent(brandSlug)}`
          + `&category=${encodeURIComponent(cat)}&code=${encodeURIComponent(code)}&limit=200`);
        const body = res.json || {};
        const list = (body.data && (body.data.products || body.data)) || body.products || [];
        if (Array.isArray(list) && list.length) onShop = list.some((p) => p.sku === sku);
      }
      if (onShop === null) {
        note(`${sku}: /api/products lists it, but its chip could not be queried `
          + `(brand=${brandSlug || '?'} category=${cat || '?'} code=${code || '?'}) — undetermined, not clean.`);
      } else if (onShop) {
        bad(`${sku} is still on its shop chip`,
          `The handoff says this row was superseded, but /api/shop?code=${code} still renders it to shoppers.`);
      } else {
        bad(`${sku}: the two public endpoints disagree`,
          `/api/products lists it (documented as active-only) but /api/shop?code=${code} does not. `
          + 'It is either an active product no shopper can reach, or an inactive one leaking into a '
          + 'public list — and the frontend reads both endpoints.');
      }
    }
  }

  // ── verdict ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (JSON_OUT) {
    console.log(JSON.stringify({
      status: findings.length ? 'findings' : 'clean',
      mode: 'read-only',
      api: API_BASE,
      products: rows.length,
      passed: pass,
      findings,
      notes,
      elapsed_s: Number(elapsed),
    }, null, 2));
  } else {
    say('');
    rule('═');
    if (findings.length === 0) {
      say(`  \x1b[32m✓ CLEAN\x1b[0m — ${pass} checks passed over ${rows.length} active products in ${elapsed}s.`);
      say('  Every card in the catalogue is distinguishable from every other card.');
    } else {
      say(`  \x1b[31m✗ ${findings.length} FINDING(S)\x1b[0m — ${pass} checks passed, ${rows.length} products, ${elapsed}s.`);
      say('');
      say('  These are DATA findings, not code findings. The storefront marks look-alike');
      say('  cards with their SKU so a shopper can still tell them apart (ERR-195), but');
      say('  that is a mitigation — the rows themselves are the backend\'s to resolve.');
      say('  Hand them over: lookalike-duplicate-rows-FE-response-sep2026.md');
    }
    if (notes.length) {
      say('');
      say(`  ${notes.length} note(s) above are informational and do not fail the run.`);
    }
    rule('═');
    say('');
  }
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => cannotRun(e && e.stack ? e.stack : String(e)));
