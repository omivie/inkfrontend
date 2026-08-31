#!/usr/bin/env node
/**
 * probe-catalogue-pathway.mjs
 * ===========================
 * Does every product in the catalogue actually reach a customer?
 *
 * WHY A PROBE AND NOT A TEST
 * --------------------------
 * Products arrive two ways: the supplier feed creates them (reviewed through
 * Feed Sync / Pending Changes) and an owner creates them by hand. Both paths
 * can succeed — a 201, a green row in the review queue — and still leave a
 * product that no customer can ever navigate to. There is no error. The product
 * is simply not on any /shop chip, and the only symptom is a cartridge nobody
 * finds.
 *
 * A unit test cannot see this, because the thing that breaks is data, not code:
 * a null brand_id, a product_type outside the enum's /shop mapping, a SKU the
 * code extractor cannot read. Only a live read can tell you whether last night's
 * import landed.
 *
 * This is the check the frontend owes the backend for the automatic path. What
 * it reports is the backend's to fix — see
 * catalogue-pathway-backend-brief-aug2026.md.
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
 * It also needs no credentials. Every endpoint it reads is the public catalogue
 * — the same URLs a shopper's browser fetches — so anyone can run it and get
 * the same answer.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT
 * --------------------------------------
 * MEASURED: for every ACTIVE product the public catalogue returns, whether all
 * four facets that make it reachable hold, and — the subtle one — whether the
 * code it carries actually has a chip on its brand+category page.
 *
 * NOT MEASURED: inactive products. `/api/products` does not return them, and an
 * inactive product is unreachable *on purpose*. Counting deliberate absence as
 * breakage would bury the real findings. The admin's own "Check for unreachable
 * products" button covers the inactive population per brand+category, because it
 * reads the admin list rather than the public one.
 *
 * NOT MEASURED: whether a chip's product page renders. That is the storefront's
 * job and `tests/` pins it.
 *
 * THE DERIVATION IS THE SHIPPED ONE, LOADED — NEVER RE-IMPLEMENTED
 * ----------------------------------------------------------------
 * A product's chip is not simply what `/api/products` returns in
 * `series_codes`. The backend's extractor reads `manufacturer_part_number`,
 * which COMPATIBLES DO NOT HAVE — so every compatible comes back with
 * `series_codes: []` and the storefront derives its code in the browser with
 * `API._enrichSeriesCodes`. Reading only the API field reported 96 perfectly
 * reachable compatibles as codeless on this probe's second run (`CDR1070BK`
 * derives `DR1070`, and brother · drums has had a `DR1070` chip all along).
 *
 * So this script evaluates the SHIPPED `js/api.js` in a sandbox and calls the
 * real `_enrichSeriesCodes`. A probe carrying its own copy of the extractor
 * would certify a derivation the site does not perform — the same reason
 * `audit:types` loads the shipped vocabularies instead of declaring one.
 *
 * Reachability itself is then MEASURED, not inferred from those codes: the
 * final step diffs the catalogue against the SKUs /shop actually serves. See
 * loadServedSkus() for why a chip-label match is not good enough.
 *
 * If either module cannot be loaded, or the projection disappears, this script
 * says so and exits 2. It does NOT report 4,000 products as codeless: "the
 * derivation is gone" and "nothing has a code" are different sentences, and
 * collapsing them would be the exact absence-read-as-zero mistake the probe
 * exists to catch.
 *
 * USAGE
 *   npm run probe:catalogue-pathway
 *   npm run probe:catalogue-pathway -- --json     # machine-readable
 *   npm run probe:catalogue-pathway -- --limit 5  # first N brands only (quick)
 *
 * ENV
 *   API_BASE=...   optional; defaults to the Render origin
 *
 * EXIT CODES
 *   0  every active product is reachable
 *   1  a real finding: products exist that no customer can navigate to
 *   2  the probe could not run (API unreachable, catalogue short, the
 *      series_codes projection missing) — deliberately NOT 1, because
 *      "we could not look" must never be reported as "we looked and it was fine".
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  brandShopVisibility, CATEGORY_PRODUCT_TYPES_FALLBACK, categoryForType,
} from '../inkcartridges/js/admin/utils/catalogue-pathway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const ARGS = process.argv.slice(2);
const HAS = (f) => ARGS.includes(f);
const JSON_OUT = HAS('--json');
const FAST = HAS('--fast');
const BRAND_LIMIT = (() => {
  const i = ARGS.indexOf('--limit');
  return i >= 0 ? Math.max(1, parseInt(ARGS[i + 1], 10) || 0) : 0;
})();

const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const PAGE_LIMIT = 200;
const MAX_PAGES = 40;              // 8,000 products — well past the ~4,000 live
const MIN_PLAUSIBLE_PRODUCTS = 500; // a short catalogue means we did not look
const MAX_ATTEMPTS = 4;             // per request, for 429 back-off
const RATE_LIMIT_BACKOFF_MS = 20000;

/**
 * Pace between requests. This sweep is ~90 sequential GETs, and on 2026-08-31 the
 * backend reported that running it flat-out reliably 502s their whole instance —
 * health endpoint included — for several minutes. ERR-188, the same day's outage,
 * is that failure seen from this side.
 *
 * The delay lives inside get() rather than in the walk loops on purpose: in get()
 * no caller can forget it, whereas in a loop the next person who adds a walk
 * reintroduces the outage. Same shape and default as sweep-business-pricing.mjs's
 * CHUNK_DELAY_MS, which exists for the same reason against the same API.
 *
 * --fast drops it to zero for a local API_BASE. Never use it against production.
 */
const REQUEST_DELAY_MS = FAST ? 0 : Number(process.env.PROBE_DELAY_MS || 650);
const SERVER_ERROR_BACKOFF_MS = 15000;

let SHIPPED = null;   // { API, SeriesCodes } — set by loadShipped() in main()
const BRAND_ROWS = new Map();  // slug → /api/brands row, filled once in main()

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (ch = '─') => say(ch.repeat(78));

let pass = 0;
const findings = [];
const notes = [];
const ok = (name, detail) => { pass++; say(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => { findings.push({ name, detail }); say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`); };
const note = (t) => { notes.push(t); say(`  \x1b[36mi\x1b[0m ${t}`); };

/** "We could not look" — exit 2, never 1. */
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
 * The ONLY request this script makes. There is no other verb and no other
 * path — if you are adding one, stop and ask whether this is still a read-only
 * probe.
 */
async function get(pathAndQuery) {
  const url = `${API_BASE}${pathAndQuery}`;
  // The full sweep is ~70 sequential requests, which the admin/catalogue rate
  // limiter will refuse partway through. A 429 is not an answer about the
  // catalogue — it is the API asking us to wait — so back off and retry rather
  // than letting it surface as either a finding or a failed run. Same shape as
  // audit-product-types.mjs, which walks the same endpoint.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (REQUEST_DELAY_MS) await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      say(`     (rate limited, waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s…)`);
      await new Promise(r => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
      continue;
    }
    // A 5xx is the instance falling over, not an answer about the catalogue —
    // same reasoning as the 429 above. Backing off here is what lets a wobbling
    // backend finish the sweep instead of turning one bad moment into a
    // scope-wide unreachable finding (ERR-187: a flake is not a finding).
    if (res.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
      say(`     (HTTP ${res.status}, waiting ${SERVER_ERROR_BACKOFF_MS / 1000}s…)`);
      await new Promise(r => setTimeout(r, SERVER_ERROR_BACKOFF_MS));
      continue;
    }
    if (!res.ok) throw new Error(`GET ${pathAndQuery} → HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`GET ${pathAndQuery} → still rate limited after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------

/**
 * Evaluate the shipped storefront modules and hand back the real code helpers.
 *
 * `js/utils.js` and `js/api.js` are browser scripts, not ES modules — they end
 * in `window.X = X`. Running them in a `node:vm` context with a minimal window
 * shim is what lets this probe use the site's own extractor rather than an
 * approximation of it. Load order matters: api.js reaches for `SeriesCodes`.
 *
 * The shim is deliberately inert — `fetch` resolves to nothing, storage is a
 * stub. Nothing here should perform I/O; we want the pure functions only, and a
 * module that started making requests on load would be a finding in itself.
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
  // The shipped modules reach for globals BOTH bare (`location.hostname`) and
  // through `window` (`window.location.hostname`, utils.js:604). Point the
  // window shim at the same objects so neither spelling finds undefined.
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

  for (const rel of ['js/utils.js', 'js/api.js']) {
    const file = path.join(SITE, rel);
    if (!fs.existsSync(file)) cannotRun(`${rel} is missing — the shipped extractor cannot be loaded.`);
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: rel });
    } catch (e) {
      cannotRun(`${rel} could not be evaluated (${e.message}). The probe will not guess at the derivation.`);
    }
  }

  const API = sandbox.window.API || sandbox.API;
  const SeriesCodes = sandbox.window.SeriesCodes || sandbox.SeriesCodes;
  if (typeof API?._enrichSeriesCodes !== 'function') {
    cannotRun('API._enrichSeriesCodes is not a function after loading js/api.js. '
      + 'The code derivation cannot be measured — this is not "nothing has a code".');
  }
  if (typeof SeriesCodes?.collapseYieldSuffix !== 'function') {
    // utils.js still has to load cleanly (api.js reaches for SeriesCodes), but
    // matching no longer depends on the collapse — the served-set diff replaced
    // it. Kept as a load-integrity check, not a matching dependency.
    cannotRun('js/utils.js loaded but SeriesCodes is not intact — refusing to guess.');
  }
  // Let utils/catalogue-pathway.js reach the same instance, so the module the
  // ADMIN uses and the derivation this probe uses are one object, not two.
  globalThis.window = sandbox.window;
  return { API, SeriesCodes };
}

/**
 * The codes a product actually carries on /shop.
 *
 * Backend-supplied `series_codes` win when present; otherwise we run the
 * storefront's own `_enrichSeriesCodes`, which is exactly what the browser does
 * for compatibles (they have no `manufacturer_part_number` for the server-side
 * extractor to read, so the server returns an empty array for essentially all
 * of them).
 */
function codesFor(product) {
  const supplied = Array.isArray(product.series_codes) ? product.series_codes.filter(Boolean) : [];
  const norm = (c) => String(c).toUpperCase().replace(/[\s-]/g, '');
  if (supplied.length) return supplied.map(norm);
  const probe = { sku: product.sku || '', name: product.name || '', series_codes: [] };
  try { SHIPPED.API._enrichSeriesCodes(probe); } catch (_) { /* advisory */ }
  return (probe.series_codes || []).map(norm).filter(c => c.length >= 2);
}

/**
 * Walk the whole public catalogue, one page at a time.
 *
 * Returns the rows, what the API claimed the total was, and how many rows the API
 * says it dropped from the pages it served.
 *
 * The total and the walk do not agree, and since 2026-08-31 we know why rather than
 * merely that: `total` is counted BEFORE the per-page pack guard and dedup run, so a
 * page can legitimately return fewer rows than the total implies. Resetting `total`
 * would break pagination, so the backend emits `meta.removed_from_page` instead and
 * the gap reconciles exactly:
 *
 *     sum(returned) + sum(removed_from_page) === total
 *
 * We check that identity rather than restating the gap as a mystery. If it holds, the
 * catalogue is fully accounted for and nothing is hiding in the difference. If it does
 * NOT hold, the leftover is real unexplained shrinkage and is reported as such.
 */
async function loadCatalogue() {
  const products = [];
  let claimedTotal = null;
  let removedFromPage = 0;
  let sawRemovedKey = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(`/api/products?page=${page}&limit=${PAGE_LIMIT}`);
    const batch = body?.data?.products || [];
    products.push(...batch);
    const meta = body?.meta || {};
    if (claimedTotal == null && typeof meta.total === 'number') claimedTotal = meta.total;
    // Count the KEY, not a truthy value — a page that legitimately removed nothing
    // reports 0, and an endpoint that never gained the field also reads 0. Those two
    // demand opposite conclusions, so they must not collapse into one number.
    if (Object.prototype.hasOwnProperty.call(meta, 'removed_from_page')) {
      sawRemovedKey = true;
      removedFromPage += Number(meta.removed_from_page) || 0;
    }
    if (!batch.length || meta.has_next === false) break;
  }
  return { products, claimedTotal, removedFromPage, sawRemovedKey };
}

/**
 * Every SKU /shop actually SERVES for one brand+category, walked to exhaustion.
 *
 * This replaced a chip-LABEL membership test, and the upgrade matters. A
 * product can carry a code that a chip is named after and still not be served
 * by that chip: `GLC38CMY` carries `LC38`, brother · ink has an `LC38` chip, and
 * clicking it returns six products — not that one. The label test called it
 * reachable. It is not. "A code that matches a chip's name" and "a product a
 * customer can reach" are different claims, and only the second one is the
 * question being asked.
 *
 * Walking to exhaustion is not optional: a partial walk invents unreachable
 * products out of the pages it did not read.
 *
 * Retries once. A single transient failure on a long sequential walk (a 429, a
 * Render cold start) once turned into "662 products unreachable" — a flake
 * reported as a finding, which is the could-not-look mistake with the sign
 * flipped. Anything still failing is reported as UNMEASURED, never as broken.
 *
 * @returns {Set<string>|'no-such-scope'|null}  null = unmeasured
 */
async function loadServedSkus(brandSlug, category) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const served = new Set();
      for (let page = 1; page <= 30; page++) {
        const body = await get(`/api/shop?brand=${encodeURIComponent(brandSlug)}`
          + `&category=${encodeURIComponent(category)}&page=${page}&limit=200`);
        if (body?.ok === false) return page === 1 ? 'no-such-scope' : served;
        const list = body?.data?.products || [];
        for (const p of list) if (p.sku) served.add(String(p.sku).toUpperCase());
        // ONLY an empty page ends this walk. Two measured reasons:
        //   1. /api/shop emits no `meta`, so the `has_next === false` test that used
        //      to sit here could never fire — it was dead code reading undefined.
        //   2. A SHORT page is normal here and must not end it. The pack guard and
        //      dedup drop rows per page (that is what /api/products reports as
        //      `removed_from_page`), so `list.length < limit` would truncate the walk
        //      and invent "not served" findings for everything past the cut — ERR-134,
        //      and the same false-positive class this probe was wrong about four times.
        if (!list.length) break;
      }
      return served;
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 2500)); continue; }
      return null;  // unmeasured
    }
  }
  return null;
}


async function main() {
  say('');
  rule('═');
  say('  CATALOGUE PATHWAY PROBE — is every product reachable on /shop?');
  rule('═');
  say(`  MODE: \x1b[1mREAD-ONLY\x1b[0m (no write path, no baseline file, no credentials)`);
  // State the pace on every run, next to the mode. A sweep that quietly went
  // flat-out is the one that takes the backend down (ERR-188), so "how fast did
  // this run" must be as visible as "did it write anything".
  say(`  PACE: \x1b[1m${REQUEST_DELAY_MS ? REQUEST_DELAY_MS + 'ms between requests' : 'NO DELAY (--fast)'}\x1b[0m`
    + `${REQUEST_DELAY_MS ? '' : ' \x1b[31m← never use this against production\x1b[0m'}`);
  say(`  API : ${API_BASE}`);
  say('');

  // ── 1-2. Load the extractor, read the catalogue ──────────────────────────
  say('1. Loading the shipped code extractor');
  SHIPPED = loadShipped();
  ok('shipped modules evaluated', 'js/utils.js + js/api.js (the site\'s own derivation)');

  say('');
  say('2. Reading the public catalogue');
  let products, claimedTotal, removedFromPage, sawRemovedKey;
  try {
    ({ products, claimedTotal, removedFromPage, sawRemovedKey } = await loadCatalogue());
  } catch (e) {
    cannotRun(`the catalogue could not be read — ${e.message}`);
  }
  if (products.length < MIN_PLAUSIBLE_PRODUCTS) {
    cannotRun(`only ${products.length} products came back (expected >= ${MIN_PLAUSIBLE_PRODUCTS}). `
      + 'A short catalogue is an unanswered question, not a clean run.');
  }
  ok('catalogue read', `${products.length} active products`);

  // The brand grid's membership is a column now, so it has to be READ. There is
  // no other source: inferring it would put a frontend guess in front of a
  // backend fact, which is the whole reason the allowlist was removed.
  try {
    const body = await get('/api/brands');
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (!rows.length) cannotRun('/api/brands returned no rows — brand visibility cannot be checked.');
    for (const b of rows) if (b && b.slug) BRAND_ROWS.set(String(b.slug).toLowerCase(), b);
    ok('brand rows read', `${BRAND_ROWS.size} brands, ${rows.filter(b => b.show_on_shop === true).length} on the /shop grid`);
  } catch (e) {
    cannotRun(`/api/brands could not be read (${e.message}) — brand visibility is a facet, not a guess.`);
  }
  if (typeof claimedTotal === 'number' && claimedTotal > products.length) {
    const gap = claimedTotal - products.length;
    if (!sawRemovedKey) {
      note(`the API claims ${claimedTotal} products but served ${products.length} — `
        + `${gap} row(s) are counted and never returned, and no page carried a `
        + '`meta.removed_from_page` key to explain them. Anything living only in that '
        + 'gap was NOT checked by this run.');
    } else if (removedFromPage === gap) {
      ok('catalogue total reconciles',
        `${products.length} returned + ${removedFromPage} removed_from_page = ${claimedTotal}`);
    } else {
      note(`the API claims ${claimedTotal} products, served ${products.length} and `
        + `reported ${removedFromPage} removed from pages — which leaves `
        + `${gap - removedFromPage} row(s) unaccounted for. The reconciliation the backend `
        + 'documents does NOT close, so some rows are still counted and never served. '
        + 'Anything living only in that remainder was NOT checked by this run.');
    }
  } else if (sawRemovedKey && removedFromPage > 0) {
    note(`${removedFromPage} row(s) were removed from their pages by the pack guard/dedup, `
      + 'and the walk still reached the claimed total.');
  }

  // /api/shop cannot be reconciled the same way, and saying so is the point.
  // The backend's note says both /shop and /products emit `meta.removed_from_page`.
  // Measured 2026-08-31: /api/shop returns { products, series, counts, facets } and
  // NO meta object at all, so there is no total and no removal count to check there.
  // An unverifiable claim reported as verified is the exact failure this probe exists
  // to avoid, so the gap is stated rather than quietly skipped.
  note('/api/shop exposes no `meta`, so the returned+removed=total identity is checked '
    + 'on /api/products only — the served-SKU diff below is what covers /shop.');

  // ── 3. Is series_codes still projected? ──────────────────────────────────
  //
  // Count the rows that CARRY THE KEY, not the rows with a non-empty value.
  // A field that has silently stopped being projected looks exactly like a
  // catalogue where nothing has a code, and the two demand opposite responses.
  say('');
  say('3. Checking the series_codes projection is still there');
  const withKey = products.filter(p => Object.prototype.hasOwnProperty.call(p, 'series_codes')).length;
  if (withKey === 0) {
    cannotRun('no product row carries a `series_codes` key. The backend has stopped '
      + 'projecting it on /api/products, so code reachability cannot be measured at all. '
      + 'This is not "every product is codeless".');
  }
  const withCodes = products.filter(p => Array.isArray(p.series_codes) && p.series_codes.length).length;
  ok('series_codes projected', `${withKey}/${products.length} rows carry the key, ${withCodes} have a value`);

  // ── 4. Per-product facets ────────────────────────────────────────────────
  say('');
  say('4. Walking every product through the four reachability facets');

  const byFacet = new Map();
  const failFor = (facet, product, detail) => {
    if (!byFacet.has(facet)) byFacet.set(facet, []);
    byFacet.get(facet).push({ sku: product.sku, name: product.name, detail });
  };

  const scopes = new Map();   // "brand|category" → Set(codes) | null
  const needChips = new Set();
  let paperSkipped = 0;       // reachable without a code — /shop has no code level for paper
  let ribbonWithCodes = 0;    // owner-assigned; routed via /ribbons, not the chip grid

  for (const p of products) {
    const slug = p.brand?.slug || '';
    if (!slug) { failFor('brand_id', p, 'no brand assigned'); continue; }
    const type = p.product_type || '';
    if (!type) { failFor('product_type', p, 'no product_type set'); continue; }
    const isRibbon = CATEGORY_PRODUCT_TYPES_FALLBACK.ribbons.includes(type);

    // The /shop brand grid is not a ribbon's route. Ribbon-family products are
    // reached through /ribbons?printer_brand=, which is driven by the
    // `ribbon_brands` table and the product_ribbon_brands junction — a
    // different universe with different storage. Reporting Olivetti's
    // correction tape as unreachable because "olivetti" is missing from a
    // cartridge-brand allowlist would be measuring it against the wrong route.
    if (!isRibbon) {
      // Read the brand's OWN row. This used to compare the slug against a
      // hardcoded allowlist copied from shop-page.js; since 2026-08-31 /shop
      // filters on `brands.show_on_shop`, so the allowlist would have been a
      // frontend opinion about a backend fact. An absent row is reported as
      // UNMEASURED, never as hidden — a product is only called unreachable on
      // evidence we actually read.
      const vis = brandShopVisibility(BRAND_ROWS.get(slug));
      if (vis.visible === false) {
        failFor('brand_on_shop', p, `brand "${slug}" has show_on_shop = false — it renders no tile`);
      } else if (vis.visible === null) {
        failFor('brand_visibility_unknown', p,
          `brand "${slug}" is not in /api/brands, so its /shop tile was NOT checked`);
      }
    }
    const category = categoryForType(type);
    if (!category) { failFor('product_type', p, `product_type "${type}" maps to no /shop category`); continue; }

    // PAPER HAS NO CODE LEVEL. /shop skips the code stage entirely for the
    // paper category and renders its products straight into the grid
    // (shop-page.js). A photo_paper row with empty series_codes is therefore
    // perfectly reachable, and flagging it would be measuring it against a
    // stage that does not exist on its route. 74 of the first run's 104
    // "codeless" findings were paper.
    if (category === 'paper') { paperSkipped++; continue; }

    // RIBBONS DO NOT USE THE CHIP WALK EITHER. Their route is
    // /ribbons?printer_brand=, driven by ribbon_brands + the
    // product_ribbon_brands junction — /api/shop cannot even address some of
    // their brands (measured: brand=star&category=ribbons → ok:false). A
    // ribbon's codes are owner-assigned and optional by design (ERR-085/086),
    // so the only thing worth reporting is that none is assigned.
    const codes = codesFor(p);
    if (isRibbon) {
      if (!codes.length) failFor('ribbon_unassigned', p, `no code on sku "${p.sku || ''}"`);
      else ribbonWithCodes++;
      continue;
    }

    if (!codes.length) {
      failFor('code', p, `no code on sku "${p.sku || ''}"`);
      continue;
    }
    needChips.add(`${slug}|${category}`);
    p._scope = `${slug}|${category}`;
    p._codes = codes;
  }

  // ── 5. Is each product actually SERVED by its brand+category page? ───────
  //
  // The quiet failure this catches: a product HAS a code, and a chip with that
  // name exists, so every simple check passes — but clicking the chip does not
  // return it. Only a diff against what the storefront really serves sees that.
  say('');
  const scopeList = [...needChips].sort();
  const scopesToWalk = BRAND_LIMIT ? scopeList.slice(0, BRAND_LIMIT * 6) : scopeList;
  say(`5. Diffing against what /shop actually serves (${scopesToWalk.length} brand+category pages)`);

  for (const scope of scopesToWalk) {
    const [slug, category] = scope.split('|');
    scopes.set(scope, await loadServedSkus(slug, category));
  }

  let chipChecked = 0;
  let unmeasured = 0;
  const unmeasuredScopes = new Set();
  for (const p of products) {
    if (!p._scope || !scopes.has(p._scope)) continue;
    const served = scopes.get(p._scope);
    if (served === null) { unmeasured++; unmeasuredScopes.add(p._scope); continue; }
    if (served === 'no-such-scope') {
      // The endpoint answered, and its answer was "there is no such page". That
      // is a real result: the product's brand+category has no /shop route.
      failFor('no_shop_page', p, `/shop has no ${p._scope.replace('|', ' · ')} page`);
      continue;
    }
    chipChecked++;
    if (!served.has(String(p.sku || '').toUpperCase())) {
      failFor('not_served', p,
        `carries ${p._codes.join(', ')} but ${p._scope.replace('|', ' · ')} does not serve it`);
    }
  }
  ok('served-set diff complete', `${chipChecked} products across ${scopesToWalk.length} pages`);
  if (unmeasured) {
    note(`${unmeasured} products in ${unmeasuredScopes.size} scope(s) were NOT checked — `
      + `/api/shop failed twice for ${[...unmeasuredScopes].map(x => x.replace('|', ' · ')).join(', ')}. `
      + 'These are unmeasured, not broken.');
  }
  if (BRAND_LIMIT) note(`--limit ${BRAND_LIMIT} was passed: only ${scopesToWalk.length} of ${scopeList.length} pages were walked. This run is a sample, not a sweep.`);

  // ── 6. Report ────────────────────────────────────────────────────────────
  say('');
  rule();
  say('  RESULT');
  rule();

  const FACET_LABEL = {
    brand_id:          'no brand assigned',
    brand_on_shop:     'brand has show_on_shop = false — renders no /shop tile',
    brand_visibility_unknown: 'brand missing from /api/brands — /shop tile NOT checked',
    product_type:      'product_type missing or unmapped',
    code:              'no code derivable from the SKU',
    not_served:        'in the catalogue, but /shop does not serve it',
    ribbon_unassigned: 'ribbon with no code assigned (owner-manual, by design)',
    no_shop_page:      '/shop has no page for that brand+category',
  };

  let broken = 0;
  for (const [facet, rows] of [...byFacet.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const label = FACET_LABEL[facet] || facet;
    if (facet === 'ribbon_unassigned') {
      note(`${rows.length} ${label} — expected; assign codes in the product editor if they should appear on /shop`);
      continue;
    }
    broken += rows.length;
    bad(`${rows.length} × ${label}`, rows.slice(0, 8).map(r => `${r.sku}: ${r.detail}`).join('\n      ')
      + (rows.length > 8 ? `\n      …and ${rows.length - 8} more` : ''));
  }

  // State the exemptions. A count that quietly excludes a population is the
  // same mistake as a count that quietly includes one — say what was not asked.
  if (paperSkipped) note(`${paperSkipped} paper products were not code-checked — /shop has no code level for paper`);
  if (ribbonWithCodes) note(`${ribbonWithCodes} ribbons carry owner-assigned codes — routed via /ribbons, not the chip grid`);

  const reachable = products.length - broken;
  say('');
  say(`  ${reachable}/${products.length} active products are reachable by walking /shop or /ribbons.`);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      status: findings.length ? 'findings' : 'clean',
      mode: 'read-only',
      total: products.length,
      reachable,
      sampled: !!BRAND_LIMIT,
      facets: Object.fromEntries([...byFacet].map(([k, v]) => [k, v.length])),
      detail: Object.fromEntries([...byFacet].map(([k, v]) => [k, v.slice(0, 50)])),
      notes,
    }, null, 2));
  } else if (findings.length) {
    say('');
    say('  Every row above is a product a customer cannot navigate to.');
    say('  The facets are the backend\'s contract — see');
    say('  catalogue-pathway-backend-brief-aug2026.md, §1.');
    say('');
  } else if (!unmeasured) {
    say('');
    say('  \x1b[32mClean.\x1b[0m Every active product resolves at brand → category → code.');
    say('');
  }

  // A partial sweep is neither a pass nor a findings list. If nothing was found
  // but part of the catalogue could not be read, that is "we could not look" —
  // exit 2. Real findings still win, so a flake can never hide them.
  if (findings.length) process.exit(1);
  if (unmeasured) {
    say(`  \x1b[33mNot clean — not measured.\x1b[0m ${unmeasured} products could not be checked.`);
    say('');
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✖ probe crashed: ${err?.stack || err}`);
  process.exit(2);
});
