#!/usr/bin/env node
/**
 * probe-analytics-dashboards.mjs — do the Sep-2026 analytics dashboards still
 * rest on the contract they were built against?
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-03 the backend handed over `analytics-dashboards-FE-handoff-sep2026.md`:
 * a one-line truncation fix, two catalogue-engagement endpoints and four
 * acquisition endpoints. Every endpoint in it was live and returning real data,
 * which is unusual and worth saying.
 *
 * But four of its statements did not survive measurement, and each one, followed
 * literally, would have shipped a dashboard that lied quietly:
 *
 *   • It never mentions that the whole analytics family is RATE-LIMITED — and
 *     the headers understate the problem: 200s advertise `30;w=60` and count
 *     down to `remaining: 10`, then request #21 is refused by a second limiter
 *     at `20;w=60`. A 429 that reaches `analyticsHttpGet` becomes `null`, and
 *     `null` renders as an empty table. An outage would have been
 *     indistinguishable from a measurement of zero.
 *   • "`meta.offshore_bounce_views_excluded` reports the count either way." It
 *     does not: with the filter off it reports 0 while the row count RISES, and
 *     on /catalog/brands the key is absent entirely.
 *   • "`null` = not connected, `0` = connected and genuinely zero." False on
 *     /acquisition/search-terms, where 500 of 500 rows report `paid_cost: 0`
 *     with `google_ads.connected === false`. Rendered naively that is a claim
 *     about money nobody has spent.
 *   • The SEO double-count is 6.41× across the whole landing-pages table, not
 *     the 3× the worked example suggests.
 *
 * A green run here is the evidence that the four readers in
 * `js/admin/utils/{catalog-engagement,acquisition}.js` are still describing the
 * data production actually serves. A yellow run is the evidence that one of
 * them has drifted — and every one of these failures is INVISIBLE FROM THE
 * SCREEN, because a wrong number and a right number look identical in a table.
 *
 * WHAT IT MEASURES
 * ----------------
 *   1  ALL SIX ENDPOINTS answer 200, with a negative control that proves a 404
 *      is still reachable (so "it exists" means something).
 *   2  THE RATE LIMIT — reads the advertised budget, flags that it disagrees
 *      with the enforced one, and checks a full paint of both dashboards still
 *      fits inside the SMALLER of the two.
 *   3  NULL-VS-ZERO, BOTH BRANCHES LIVE — asserts rows with a null rate AND
 *      rows with a real 0 both still exist. A branch with no live data is a
 *      branch nobody has ever seen work (the ERR-180 lesson).
 *   4  THE OFFSHORE META — filtered vs unfiltered vs the brands endpoint, all
 *      three states, against the shipped reader.
 *   5  DECOYS — four params accepted and ignored, with a positive control first.
 *   6  THE 6.41x DOUBLE-COUNT — recomputes it and runs the SHIPPED
 *      collapseByPath over the live rows.
 *   7  THE PAID-ZERO TRAP — fails if any paid_* cell would render as money.
 *   8  JOB 1 WATCHDOG — re-derives the longest ("link:" + pathname) across the
 *      live catalogue and fails if it has outgrown ELEMENT_MAX_CHARS.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * Trust its own copy of the logic. §3–§7 load the SHIPPED util modules through
 * a `vm` sandbox and run those, so a reader that drifts from the page cannot be
 * certified green by a second implementation living in this file. Same rule,
 * same reason, as probe-tracking-requested-column.mjs loading
 * order-tracking-request.js.
 *
 * It also never sends a traffic event to test the truncation fix. Writing a row
 * into the production analytics table to check a string length would pollute
 * the very leaderboard the feature exists to report. §8 measures the catalogue
 * instead, which is where the length actually comes from.
 *
 * -- READ-ONLY. ---------------------------------------------------------------
 * Every request is a GET except the admin sign-in. This script parses no flags
 * and has no recording mode of any kind, deliberately: a probe that can record
 * may pass because it has just overwritten the thing it was comparing against
 * (sweep:b2b ate a committed fixture, 2026-08-12). The mode is PRINTED on every
 * run so it can never be assumed.
 *
 * It also PACES ITSELF. The endpoints under test are the rate-limited ones, so
 * a probe that fired freely would exhaust the budget and then report the
 * resulting 429s as contract failures — failing on its own footprint.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:analytics-dashboards   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

const CATALOG = '/api/admin/analytics/catalog';
const ACQ = '/api/admin/analytics/acquisition';

/** Params that LOOK like they filter these endpoints. Every one is ignored. */
const DECOYS = ['product_type=toner_cartridge', 'sort=views', 'offset=10', 'search=brother'];
/**
 * The budget the frontend plans against. NOT the advertised one: the 200
 * responses say `30;w=60` while a second limiter refuses request #21 with its
 * own `20;w=60`. Measured twice, 2026-09-03. See §2.
 */
const ENFORCED_LIMIT = 20;
/** What one full paint of both dashboards costs, in requests. */
const PAINT_COST = 2 /* catalogue: products + brands */ + 4 /* acquisition */ + 1 /* brand options */;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, detail) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
  failures.push(`${name} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/**
 * A real gap worth reporting that the frontend already handles correctly, so it
 * must NOT redden the exit code. If a soft note could fail the run, the run gets
 * ignored — and then a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
  notes.push(`${name} — ${detail}`);
  console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (name, why) => {
  notes.push(`SKIPPED: ${name} — ${why}`);
  console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${name}\n      ${why}`);
};

function readEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
}

/**
 * Load the SHIPPED readers rather than re-implementing them.
 *
 * The point of §3–§7 is "does the vocabulary the frontend actually renders still
 * fit the data production is serving?". A second copy of the logic in this file
 * would drift from the page and start certifying something nobody ships.
 */
function loadShippedReaders() {
  const files = ['catalog-engagement.js', 'acquisition.js'];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, Number, Object, Array, String, Boolean, JSON, Date, RegExp, Error, Map, Set, Intl,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const exposed = new Set();
  for (const f of files) {
    const file = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', f);
    if (!fs.existsSync(file)) return null;
    let src = fs.readFileSync(file, 'utf8').replace(/^\s*import\s+[^;]+;\s*$/gm, '');
    src = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
      exposed.add(id);
      return `${kw} ${id}`;
    });
    // The two modules each declare `MISSING`, `has` and `finiteOrNull`. Wrap
    // each in its own block so the second does not redeclare the first, and
    // publish onto the shared context explicitly.
    const publish = [...exposed].map((id) => `try { globalThis.${f.replace(/\W/g, '_')}_${id} = ${id}; } catch(_) {}`).join('\n');
    try {
      vm.runInContext(`{\n${src}\n${publish}\n}`, sandbox, { filename: f });
    } catch (e) {
      console.error(`could not evaluate ${f}: ${e.message}`);
      return null;
    }
    exposed.clear();
  }
  const pick = (file, id) => sandbox[`${file.replace(/\W/g, '_')}_${id}`];
  return {
    readViewToSaleRate: pick('catalog-engagement.js', 'readViewToSaleRate'),
    readOffshoreExcluded: pick('catalog-engagement.js', 'readOffshoreExcluded'),
    offshoreDisclosure: pick('catalog-engagement.js', 'offshoreDisclosure'),
    rowCountLabel: pick('catalog-engagement.js', 'rowCountLabel'),
    readSourceStatus: pick('acquisition.js', 'readSourceStatus'),
    classifyMetric: pick('acquisition.js', 'classifyMetric'),
    collapseByPath: pick('acquisition.js', 'collapseByPath'),
    seoInflationCheck: pick('acquisition.js', 'seoInflationCheck'),
  };
}

/** The shipped cap, read from the source rather than repeated here. */
function shippedElementMax() {
  const f = path.join(ROOT, 'inkcartridges', 'js', 'traffic-tracker.js');
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/const ELEMENT_MAX_CHARS = (\d+);/);
  return m ? Number(m[1]) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n\x1b[1mprobe-analytics-dashboards\x1b[0m — do the Sep-2026 analytics dashboards still rest on their contract?');
  console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GET only besides the sign-in; no recording mode exists, nothing is written)');
  console.log('\x1b[90mPaced deliberately: these endpoints are rate-limited at 20/60s and an unpaced probe fails on its own footprint.\x1b[0m\n');

  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
    console.error('These must be a super_admin — the admin analytics endpoints 403 for anyone else.');
    console.error('Nothing was verified. Do NOT read this as a pass.\n');
    process.exit(2);
  }

  const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await auth.json();
  if (!session.access_token) {
    console.error(`\x1b[31mCANNOT RUN\x1b[0m — admin sign-in failed (${auth.status}). Nothing was verified.\n`);
    process.exit(2);
  }
  const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}` };

  /** Every GET goes through here so the pacing and the 429 handling are in one place. */
  let budget = null;
  const get = async (p, gap = 900) => {
    const res = await fetch(BASE + p, { headers: H });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    const limit = Number(res.headers.get('ratelimit-limit'));
    if (Number.isFinite(limit) && limit > 0) budget = limit;
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      console.log(`      \x1b[90m…rate-limited, waiting ${wait}s\x1b[0m`);
      await sleep((wait + 2) * 1000);
      return get(p, gap);
    }
    await sleep(gap);
    return { status: res.status, json, text, headers: res.headers };
  };

  console.log(`Signed in as ${email}\n`);
  const health = await (await fetch(`${BASE}/health`)).json().catch(() => null);
  if (health?.data?.commit) console.log(`Backend commit ${health.data.commit}, db: ${health.data.db}\n`);

  const readers = loadShippedReaders();
  if (!readers || !readers.collapseByPath || !readers.readViewToSaleRate) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — the shipped util modules would not evaluate.');
    console.error('Nothing was verified. Do NOT read this as a pass.\n');
    process.exit(2);
  }
  const {
    readViewToSaleRate, readOffshoreExcluded, offshoreDisclosure, rowCountLabel,
    readSourceStatus, classifyMetric, collapseByPath, seoInflationCheck,
  } = readers;

  // ---- 1. DO ALL SIX ENDPOINTS ANSWER? ------------------------------------
  console.log('\x1b[1m1. Are all six endpoints live?\x1b[0m');

  const control = await get(`${CATALOG}/nonexistent-control?limit=1`, 300);
  if (control.status === 404) {
    ok('NEGATIVE CONTROL — an unknown analytics path 404s', 'so "200" below means the route really exists');
  } else {
    bad('NEGATIVE CONTROL FAILED', `an invented path answered ${control.status}, so the checks below prove nothing`);
  }

  const ENDPOINTS = [
    [`${CATALOG}/products?limit=1`, 'catalog/products'],
    [`${CATALOG}/brands?limit=1`, 'catalog/brands'],
    [`${ACQ}/summary`, 'acquisition/summary'],
    [`${ACQ}/landing-pages?limit=1`, 'acquisition/landing-pages'],
    [`${ACQ}/search-terms?limit=1`, 'acquisition/search-terms'],
    [`${ACQ}/timeseries`, 'acquisition/timeseries'],
  ];
  for (const [p, label] of ENDPOINTS) {
    const r = await get(p);
    if (r.status === 200 && r.json?.ok) ok(`${label} answers 200`);
    else bad(`${label} did not answer`, `${r.status} — ${r.text.slice(0, 160)}`);
  }

  // ---- 2. THE RATE LIMIT ---------------------------------------------------
  console.log('\n\x1b[1m2. The rate limit the hand-off never mentions\x1b[0m');

  const probeRes = await get(`${CATALOG}/brands?limit=1`, 200);
  const policy = probeRes.headers.get('ratelimit-policy');
  const advertised = Number(probeRes.headers.get('ratelimit-limit'));
  if (!policy && !Number.isFinite(advertised)) {
    soft('no rate-limit headers advertised',
      `the enforced limit was ${ENFORCED_LIMIT}/60s on 2026-09-03. If it has been removed, the paced fetching and `
      + 'the "Analytics is rate-limited" state are now belt-and-braces rather than load-bearing — harmless, '
      + 'but worth knowing.');
  } else {
    ok('the endpoints advertise a budget', `${policy || `${advertised} requests`}`);

    // TWO LIMITERS, AND THE HEADERS DESCRIBE THE WRONG ONE. Measured twice on
    // 2026-09-03: the 200 responses advertise `30;w=60` and count down to
    // `ratelimit-remaining: 10` — and then request #21 is refused by a SECOND
    // limiter whose own 429 headers say `20;w=60, retry-after: 44`.
    //
    // A client that trusted `ratelimit-remaining` would fire ten more requests
    // believing it had headroom and take a 429 on the first of them. So the
    // budget this code plans against is the ENFORCED one, not the advertised
    // one, and this check exists to notice if that ever changes.
    if (Number.isFinite(advertised) && advertised > ENFORCED_LIMIT) {
      soft('the advertised budget is larger than the enforced one',
        `headers say ${advertised}/60s, but a 429 arrives after ${ENFORCED_LIMIT} (measured twice, 2026-09-03; `
        + `the 429's own headers say ${ENFORCED_LIMIT};w=60). ratelimit-remaining therefore overstates the `
        + 'headroom by ' + (advertised - ENFORCED_LIMIT) + ' requests. Reported to the backend; the frontend '
        + 'plans against the smaller number and never reads ratelimit-remaining.');
    } else if (Number.isFinite(advertised)) {
      ok('the advertised and enforced budgets agree', `${advertised}/60s`);
    }

    const planning = Math.min(ENFORCED_LIMIT, Number.isFinite(advertised) ? advertised : ENFORCED_LIMIT);
    if (planning < PAINT_COST) {
      bad('a single dashboard paint no longer fits the enforced budget',
        `one paint costs ${PAINT_COST} requests and the enforced budget is ${planning}. The pages will 429 on first load.`);
    } else {
      ok('a full paint of both dashboards fits the ENFORCED budget',
        `${PAINT_COST} requests against ${planning} — ${planning - PAINT_COST} spare for filter changes`);
    }
    const retryable = probeRes.headers.get('ratelimit-reset');
    if (retryable) ok('and the window is advertised', `resets in ${retryable}s`);
  }

  // ---- 3. NULL-VS-ZERO, BOTH BRANCHES LIVE --------------------------------
  console.log('\n\x1b[1m3. Is `view_to_sale_rate: null` still a real, common state?\x1b[0m');

  const prodRes = await get(`${CATALOG}/products?limit=500`);
  const prodRows = Array.isArray(prodRes.json?.data) ? prodRes.json.data : [];
  const prodMeta = prodRes.json?.meta || {};
  if (!prodRows.length) {
    bad('the products endpoint returned no rows', 'nothing below §3 could be checked against live data');
  } else {
    const infos = prodRows.map((r) => readViewToSaleRate(r));
    const unknown = infos.filter((i) => !i.known);
    const realZero = infos.filter((i) => i.known && i.rate === 0);
    const measured = infos.filter((i) => i.known && i.rate > 0);
    const absent = infos.filter((i) => i.reason === 'absent');

    if (absent.length) {
      bad('`view_to_sale_rate` is MISSING from some rows',
        `${absent.length}/${prodRows.length}. The column renders an em-dash, which is correct, but the field `
        + 'was on every row on 2026-09-03 — this is a contract regression.');
    } else {
      ok('`view_to_sale_rate` is present on every row', `${prodRows.length}/${prodRows.length}`);
    }

    // BOTH branches must have live data. A branch nobody has ever seen is a
    // branch that has never been proven to work (ERR-180: the invoice ×N
    // indicator stood for eight months having never once rendered).
    if (unknown.length && realZero.length) {
      ok('BOTH branches have live data',
        `${unknown.length} unknown (null) and ${realZero.length} genuine 0, out of ${prodRows.length}. `
        + `Rendering null as 0% would mislabel ${(unknown.length / prodRows.length * 100).toFixed(1)}% of the table.`);
    } else if (!unknown.length) {
      soft('no null rates in this range',
        'the em-dash branch has no live data right now. It is unit-tested '
        + '(tests/catalog-engagement-sep2026.test.js §1) and nothing else. On 2026-09-03 it was 51/257.');
    } else {
      soft('no genuine zero rates in this range',
        'the "0.0%" branch has no live data right now. If it stays empty, an em-dash-everywhere bug would '
        + 'be invisible. On 2026-09-03 it was 155/257.');
    }
    if (measured.length) ok('and real rates are being computed', `${measured.length} rows with a rate above zero`);

    // Every null rate should be explained by zero views. If one is not, the
    // backend has started emitting null for a reason we do not model.
    const oddNulls = prodRows.filter((r, i) => !infos[i].known && Number(r.views) > 0);
    if (oddNulls.length) {
      soft('a null rate on a row that HAS views',
        `${oddNulls.length} row(s), e.g. ${oddNulls[0].sku} with ${oddNulls[0].views} views. The reader still `
        + 'renders an em-dash, which is safe, but "null means nothing was viewed" is no longer the whole story.');
    } else {
      ok('every null rate is explained by zero views', 'the reader\'s "no-views" reason still fits');
    }

    const label = rowCountLabel(prodRows, prodMeta, 'product');
    if (label.total === null) {
      bad('`total_products_engaged` is missing', 'the header cannot say "50 of N" and falls back to a bare count');
    } else {
      ok('the pre-limit total is reported', label.label);
    }
  }

  // ---- 4. THE OFFSHORE META ------------------------------------------------
  console.log('\n\x1b[1m4. Does the scraper filter still report itself honestly?\x1b[0m');

  const filtered = readOffshoreExcluded(prodMeta, { includeBounces: false });
  if (filtered.state === 'measured') {
    ok('filtered products report an excluded count', offshoreDisclosure(filtered));
  } else {
    bad('the filtered response did not report an excluded count',
      `state=${filtered.state}. The disclosure line degrades to "unknown", which is honest but means the `
      + 'operator can no longer see what the filter removed.');
  }

  const unfilteredRes = await get(`${CATALOG}/products?limit=1&include_offshore_bounces=true`);
  const unfilteredMeta = unfilteredRes.json?.meta || {};
  const suppressed = readOffshoreExcluded(unfilteredMeta, { includeBounces: true });
  if (suppressed.state === 'suppressed') {
    ok('THE TRAP still bites: unfiltered reports 0, not the skipped count',
      `filtered total ${prodMeta.total_products_engaged} vs unfiltered ${unfilteredMeta.total_products_engaged}, `
      + `yet offshore_bounce_views_excluded=${unfilteredMeta.offshore_bounce_views_excluded}. The reader reports `
      + 'this as SUPPRESSED and the UI never prints "0 excluded".');
  } else {
    soft('the unfiltered response now reports something else',
      `state=${suppressed.state}. If the backend has started reporting the true skipped count while unfiltered, `
      + 'readOffshoreExcluded\'s SUPPRESSED branch could be simplified — check before doing it.');
  }

  const brandRes = await get(`${CATALOG}/brands?limit=200`);
  const brandMeta = brandRes.json?.meta || {};
  const brandOff = readOffshoreExcluded(brandMeta, { includeBounces: false });
  if (brandOff.state === 'unknown') {
    ok('brands still omits the offshore key entirely', 'reported as UNKNOWN — the UI never invents a 0 for it');
  } else {
    soft('brands now reports an offshore count',
      `state=${brandOff.state}. Good news; the reader handles it already and will start showing the real number.`);
  }

  const unmatched = brandMeta.unmatched_brand_slugs;
  if (Array.isArray(unmatched) && unmatched.length) {
    bad('the storefront links to brand slugs with no brand record',
      `${unmatched.length}: ${unmatched.join(', ')}. These are dead links a customer can reach. The page shows `
      + 'a warning naming each one.');
  } else if (Array.isArray(unmatched)) {
    ok('no unmatched brand slugs', 'every brand the storefront links to has a record');
  } else {
    soft('`unmatched_brand_slugs` is not reported', 'the dead-link warning can never fire');
  }

  // ---- 5. DECOYS -----------------------------------------------------------
  console.log('\n\x1b[1m5. Is there a real filter yet? (four candidates were decoys)\x1b[0m');

  // POSITIVE CONTROL FIRST. Without proof that SOME param filters, "the decoy
  // returned everything" is equally consistent with "no param filters anything".
  const baselineTotal = prodMeta.total_products_engaged;
  const genuineRes = await get(`${CATALOG}/products?limit=500&source=genuine`);
  const genuineRows = genuineRes.json?.data || [];
  const controlWorks = genuineRows.length > 0
    && genuineRows.length < prodRows.length
    && genuineRows.every((r) => r.source === 'genuine');
  if (controlWorks) {
    ok('POSITIVE CONTROL — `?source=genuine` really does filter',
      `${genuineRows.length} of ${prodRows.length}, all genuine`);
  } else {
    bad('POSITIVE CONTROL FAILED — `?source=` did not filter',
      'so the decoy results below prove nothing. Fix this before believing §5.');
  }

  for (const param of DECOYS) {
    const name = param.split('=')[0];
    const r = await get(`${CATALOG}/products?limit=500&${param}`);
    const rows = r.json?.data || [];
    const total = r.json?.meta?.total_products_engaged;
    if (r.status === 200 && rows.length === prodRows.length && total === baselineTotal) {
      ok(`\`?${name}=\` is still a decoy`, `full ${rows.length}-row response, unchanged total`);
    } else if (r.status >= 400) {
      soft(`\`?${name}=\` is now REJECTED`, `${r.status} — better than being ignored. It can stop being avoided.`);
    } else {
      soft(`\`?${name}=\` NOW FILTERS`,
        `${rows.length} rows vs ${prodRows.length} baseline. If genuine, the page can offer it as a real control — `
        + `and for offset specifically, real pagination becomes possible.`);
    }
  }

  // ---- 6. THE 6.41x DOUBLE-COUNT ------------------------------------------
  console.log('\n\x1b[1m6. Does summing the SEO column still inflate it?\x1b[0m');

  const lpRes = await get(`${ACQ}/landing-pages?limit=200`);
  const lpRows = Array.isArray(lpRes.json?.data) ? lpRes.json.data : [];
  const lpMeta = lpRes.json?.meta || {};
  if (!lpRows.length) {
    bad('landing-pages returned no rows', '§6 could not be checked against live data');
  } else {
    const check = seoInflationCheck(lpRows);
    const collapsed = collapseByPath(lpRows);
    const multi = collapsed.filter((r) => r.channel_count > 1);
    const diverged = collapsed.filter((r) => r.seoDiverged);

    if (check.inflated) {
      ok('the double-count is real, and the shipped fix neutralises it',
        `naive sum ${check.naive.toLocaleString('en-NZ')} vs collapsed ${check.collapsed.toLocaleString('en-NZ')} `
        + `(${check.inflation}x). ${multi.length} of ${collapsed.length} paths span more than one channel.`);
    } else {
      soft('no inflation in this range',
        `every path appears on a single channel row, so collapsing changes nothing today. The guard is unit-tested `
        + '(tests/acquisition-analytics-sep2026.test.js §3) and stays.');
    }

    if (diverged.length) {
      bad('a path\'s channel rows DISAGREE about its Search Console figures',
        `${diverged.length}: ${diverged.slice(0, 5).map((r) => r.landing_path).join(', ')}. Collapsing assumes the `
        + 'repeats are identical — they were, 16/16, on 2026-09-03. If they are not, collapsing is now LOSING data '
        + 'rather than de-duplicating it, and the table flags each one.');
    } else if (multi.length) {
      ok('every multi-channel path repeats its SEO figures identically',
        `${multi.length}/${multi.length} — which is what makes collapsing safe`);
    }

    // The first-party columns must NOT be collapsed away.
    const rawSessions = lpRows.reduce((s, r) => s + (Number(r.entry_sessions) || 0), 0);
    const colSessions = collapsed.reduce((s, r) => s + (Number(r.entry_sessions) || 0), 0);
    if (rawSessions === colSessions) {
      ok('POSITIVE CONTROL — sessions still sum to the same total after collapsing',
        `${colSessions.toLocaleString('en-NZ')} either way; only the per-URL columns were de-duplicated`);
    } else {
      bad('collapsing changed the session total',
        `${rawSessions} raw vs ${colSessions} collapsed. First-party columns are per channel and MUST sum.`);
    }
  }

  // ---- 7. THE PAID-ZERO TRAP ----------------------------------------------
  console.log('\n\x1b[1m7. Would any paid_* cell render as money nobody spent?\x1b[0m');

  const stRes = await get(`${ACQ}/search-terms?limit=500`);
  const stRows = Array.isArray(stRes.json?.data) ? stRes.json.data : [];
  const stMeta = stRes.json?.meta || {};
  const adsStatus = readSourceStatus(stMeta, 'google_ads');
  const seoStatus = readSourceStatus(stMeta, 'search_console');

  console.log(`      google_ads: ${adsStatus} · search_console: ${seoStatus}`);

  if (adsStatus === 'not-connected') {
    const zeros = stRows.filter((r) => r.paid_cost === 0 || r.paid_clicks === 0).length;
    const nulls = stRows.filter((r) => r.paid_cost === null).length;
    ok('Google Ads is still unconnected, and still sends ZEROS not nulls',
      `${zeros} of ${stRows.length} rows carry paid_* = 0 (${nulls} carry null). The hand-off's rule `
      + '"null = not connected, 0 = genuinely zero" is false here, which is why the reader asks meta.sources first.');

    // The load-bearing assertion: run the SHIPPED classifier over every live row.
    const wouldPrint = stRows.filter((r) =>
      classifyMetric(r.paid_cost, adsStatus).state === 'value'
      || classifyMetric(r.paid_clicks, adsStatus).state === 'value');
    if (wouldPrint.length) {
      bad('the shipped classifier would print a paid figure anyway',
        `${wouldPrint.length} row(s), e.g. "${wouldPrint[0].term}". This is the exact bug the module exists to `
        + 'prevent — a spend claim from an integration that has never been connected.');
    } else {
      ok('not one of them would render as a figure',
        `all ${stRows.length} paid_* cells resolve to "not connected"`);
    }
  } else if (adsStatus === 'connected') {
    soft('Google Ads is now CONNECTED',
      'its zeros are real zeros from today. The reader switches automatically — nothing to change — but the '
      + '"Not connected" column note will stop appearing, which is worth expecting.');
  } else {
    bad('`meta.sources.google_ads` is no longer reported',
      'the paid columns fall back to UNKNOWN and render an em-dash. Safe, but the source strip goes blank.');
  }

  if (seoStatus === 'connected') {
    const withData = stRows.filter((r) => classifyMetric(r.organic_impressions, seoStatus).state === 'value').length;
    ok('Search Console is connected and its figures render', `${withData} of ${stRows.length} rows carry organic data`);
  } else {
    soft('Search Console is not reporting as connected', `state=${seoStatus} — every SEO column becomes an em-dash`);
  }

  // The landing-pages third state: connected, but no row for this URL.
  if (lpRows.length) {
    const lpSeo = readSourceStatus(lpMeta, 'search_console');
    const noData = lpRows.filter((r) => classifyMetric(r.seo_impressions, lpSeo).state === 'no-data').length;
    if (noData) {
      ok('the third state is live too', `${noData} of ${lpRows.length} entry-page rows are "connected, no data for this URL"`);
    } else {
      soft('no "connected but no data" rows right now',
        'that branch has no live data. It was 103/174 on 2026-09-03.');
    }
  }

  // ---- 8. JOB 1 WATCHDOG ---------------------------------------------------
  console.log('\n\x1b[1m8. Has any product URL outgrown the click-element cap?\x1b[0m');

  const MAX = shippedElementMax();
  if (!MAX) {
    bad('ELEMENT_MAX_CHARS could not be read', 'js/traffic-tracker.js no longer declares it');
  } else {
    let all = [];
    for (let page = 1; page <= 25; page++) {
      const r = await fetch(`${BASE}/api/products?limit=200&page=${page}`);
      if (r.status !== 200) break;
      const j = await r.json();
      const rows = Array.isArray(j.data) ? j.data : (j.data?.products || []);
      if (!rows.length) break;
      all = all.concat(rows);
    }
    const lens = all.filter((p) => p.canonical_url).map((p) => {
      let path_;
      try { path_ = new URL(p.canonical_url).pathname; } catch { path_ = p.canonical_url; }
      return { sku: p.sku, path: path_, len: ('link:' + path_).length };
    }).sort((a, b) => b.len - a.len);

    if (!lens.length) {
      skip('the catalogue length watchdog', 'no products carried a canonical_url, so nothing could be measured');
    } else {
      const worst = lens[0];
      const overOld = lens.filter((x) => x.len > 80).length;
      if (worst.len <= MAX) {
        ok(`the longest product element still fits in ${MAX}`,
          `${worst.len} chars (${worst.sku}), ${MAX - worst.len} to spare, across ${lens.length} products`);
      } else {
        bad(`a product URL has outgrown ELEMENT_MAX_CHARS (${MAX})`,
          `${worst.len} chars: ${worst.path}. ${lens.filter((x) => x.len > MAX).length} product(s) are being `
          + 'truncated again, and a truncated SKU is an unattributable click.');
      }
      ok('and the fix is still load-bearing',
        `${overOld} of ${lens.length} products (${(overOld / lens.length * 100).toFixed(1)}%) would still be `
        + 'truncated at the old cap of 80');
    }
  }

  // ---- 9. not checked here -------------------------------------------------
  console.log('\n\x1b[1m9. Not checked here\x1b[0m');
  skip('the truncation fix end-to-end',
    'proving it would mean POSTing a real click event into the production analytics table, which would pollute the '
    + 'very leaderboard this feature reports. §8 measures the catalogue that produces the length instead, and '
    + 'labelFor() itself is unit-tested against the longest live URL in '
    + 'tests/traffic-element-truncation-sep2026.test.js.');
  skip('the rate-limited render state',
    'exercising it against production means deliberately exhausting the operator\'s own 20/60s budget. It is '
    + 'unit-tested (tests/*-sep2026.test.js §6d/§7b) and was exercised once by hand in the browser.');

  // ---- summary -------------------------------------------------------------
  console.log(`\n${'─'.repeat(72)}`);
  console.log('\x1b[1mMODE: READ-ONLY\x1b[0m — nothing was written by this run.');
  if (budget) console.log(`\x1b[1mBUDGET: ${budget}/60s\x1b[0m — one full dashboard paint costs ${PAINT_COST}.`);
  console.log(`${pass} passed, ${failures.length} failed, ${notes.length} note(s).`);
  if (notes.length) {
    console.log('\nNotes (do not fail the run):');
    for (const n of notes) console.log(`  ~ ${n.split('\n')[0]}`);
  }
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const x of failures) console.log(`  ✗ ${x.split('\n')[0]}`);
    process.exit(1);
  }
  console.log('\n\x1b[32mAll hard checks passed.\x1b[0m\n');
  process.exit(0);
}

main().catch((e) => { console.error('Probe could not run:', e.message); process.exit(2); });
