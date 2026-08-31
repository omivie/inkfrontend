#!/usr/bin/env node
/**
 * probe-supplier-prices.mjs — what does /api/admin/supplier-offers actually honour?
 * ================================================================================
 *
 * The Supplier Prices page (pages/supplier-prices.js, ERR-190) is shaped almost
 * entirely by what this endpoint does NOT do. Five query params a reasonable
 * person would assume exist are accepted and ignored, so the page fetches every
 * page and filters in the browser. That is a real cost, paid deliberately, and it
 * is only correct while the measurement behind it holds.
 *
 * This probe is that measurement, re-run on demand. It fails loudly in BOTH
 * directions:
 *
 *   - a decoy that starts filtering  → the page can stop fetching everything
 *   - a param that stops filtering   → the page is showing the wrong rows
 *
 * The check that matters is never "did rows come back". A backend that drops a
 * param returns rows, repaints the page, and every row is wrong (ERR-151, and
 * again on /api/admin/orders in ERR-173). So every filter here is judged against
 * an unfiltered baseline and against a nonsense token.
 *
 * ── WHAT THE PAGE DEPENDS ON, IN ORDER ──────────────────────────────────────
 *
 *  1. coverage=multi + coverage=single === coverage=all  (the tabs partition)
 *  2. brand / product_type / search / min_saving / sort ARE honoured
 *  3. supplier= / stale= / exclude_stale= / fresh_only= are NOT  (compare)
 *  4. reason= is NOT                                              (unmatched)
 *  5. data.suppliers[] stays populated when comparisons is empty
 *     — the freshness strip must survive a filter that matches nothing
 *  6. by_reason sums to the pagination total, and respects supplier=/search=
 *  7. no endpoint lists existing mappings, so undo can only be session-scoped
 *  8. the feed-files router is cron-gated, so no upload UI can be built
 *
 * It also PRINTS the stale/fresh economics every run, because that split is the
 * page's entire reason for existing and it moves as feeds are refreshed. On
 * 2026-08-31 it was: 131 rows would switch supplier, 130 of them on a 193-day-old
 * price, $96.28 of the $293.97 per-unit total backed by a current price.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. There is no --record mode, no baseline file, and this
 * probe writes nothing anywhere. In particular it NEVER calls POST /map,
 * DELETE /map/:id, or the import trigger: mapping is a permanent production write
 * and an import rewrites the offer table. A probe that can record may be green
 * because it just overwrote what it compared against (sweep:b2b ate a committed
 * fixture, 2026-08-12). The mode is printed before any work starts.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:supplier-prices          (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 *         npm run probe:supplier-prices -- --json
 * Exit:   0 = every check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

const JSON_OUT = process.argv.includes('--json');
const COMPARE = '/api/admin/supplier-offers/compare';
const UNMATCHED = '/api/admin/supplier-offers/unmatched';
/** A token no SKU or brand can plausibly carry. Proves a param is honoured. */
const NONSENSE = 'zzqxnope';

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (ch = '─') => say(ch.repeat(78));

let pass = 0;
const findings = [];
const notes = [];
const ok = (name, detail) => { pass++; say(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
  findings.push({ name, detail });
  say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/**
 * A real limit the frontend already accommodates. It must NOT redden the exit
 * code: if a soft note could fail the run, the run gets ignored, and a hard
 * failure gets ignored with it.
 */
const soft = (name, detail) => {
  notes.push(`${name} — ${detail}`);
  say(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

/** "We could not look" — exit 2, never 1, and never 0. */
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

function readEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=');
      return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
  );
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`sign-in failed (${res.status})`);
  return json.access_token;
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

async function main() {
  say('');
  rule('═');
  say('\x1b[1m  Supplier price comparison — live contract probe\x1b[0m');
  say('  \x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET. No mapping, no import,');
  say('  no --record flag, no baseline file. Nothing is written anywhere.');
  say(`  API   ${BASE}`);
  rule('═');
  say('');

  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    cannotRun('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment). '
      + 'These must be a super_admin — every route here 403s for anyone else.');
  }

  let token;
  try { token = await signIn(email, password); }
  catch (e) { cannotRun(e.message); }

  const get = async (p) => {
    const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON (gateway page) */ }
    return { status: res.status, json, text };
  };
  const compare = (qs) => get(`${COMPARE}?${qs}`);
  const total = (r) => r.json?.meta?.pagination?.total;
  const rowsOf = (r) => r.json?.data?.comparisons || [];

  say(`Signed in as ${email}\n`);

  // ── 1. The three tabs must partition the data ────────────────────────────
  say('\x1b[1m1. Coverage — the tabs must partition, not overlap\x1b[0m');
  const [multi, single, all] = await Promise.all([
    compare('coverage=multi&limit=1'), compare('coverage=single&limit=1'), compare('coverage=all&limit=1'),
  ]);
  if (multi.status !== 200 || single.status !== 200 || all.status !== 200) {
    bad('coverage reads', `HTTP ${multi.status}/${single.status}/${all.status} — cannot continue`);
    return report();
  }
  const nMulti = total(multi); const nSingle = total(single); const nAll = total(all);
  // An invariant, deliberately not a pinned count: the catalogue moves daily.
  check(nMulti + nSingle === nAll,
    `multi (${nMulti}) + single (${nSingle}) = all (${nAll})`,
    `${nMulti} + ${nSingle} = ${nMulti + nSingle}, but coverage=all reports ${nAll}. The three tabs `
    + 'do not partition the data, so a product is either double-counted or invisible.');
  check(nMulti > 0, `${nMulti} products have two or more suppliers`,
    'coverage=multi is empty — the Compare tab, which is the whole page, would render nothing');

  // ── 2. Params the page RELIES on being honoured ──────────────────────────
  say('\n\x1b[1m2. Filters the page sends — each must actually filter\x1b[0m');
  const baseline = await compare('coverage=all&limit=200');
  const baseRows = rowsOf(baseline);
  if (!baseRows.length) { bad('baseline', 'coverage=all returned no rows'); return report(); }

  const aBrand = baseRows.find((r) => r.brand)?.brand;
  const aType = baseRows.find((r) => r.product_type)?.product_type;
  const aSku = baseRows.find((r) => r.sku)?.sku;

  if (aBrand) {
    const r = await compare(`coverage=all&limit=200&brand=${encodeURIComponent(aBrand)}`);
    const rows = rowsOf(r);
    const wrong = rows.filter((x) => x.brand !== aBrand);
    check(r.status === 200 && rows.length > 0 && wrong.length === 0,
      `brand=${aBrand} → ${rows.length} rows, all that brand`,
      `HTTP ${r.status}, ${rows.length} rows, ${wrong.length} of a different brand — the Brand `
      + 'dropdown would filter to a list containing other brands');
    const nope = await compare(`coverage=all&limit=200&brand=${NONSENSE}`);
    check(rowsOf(nope).length === 0,
      'a nonsense brand returns nothing (the param is not ignored)',
      `brand=${NONSENSE} returned ${rowsOf(nope).length} rows — brand= is being IGNORED, so every `
      + 'brand-filtered view has been showing the whole catalogue');
  } else soft('brand filter', 'no row carries a brand — not probed');

  if (aType) {
    const r = await compare(`coverage=all&limit=200&product_type=${encodeURIComponent(aType)}`);
    const wrong = rowsOf(r).filter((x) => x.product_type !== aType);
    check(r.status === 200 && rowsOf(r).length > 0 && wrong.length === 0,
      `product_type=${aType} → ${rowsOf(r).length} rows, all that type`,
      `${wrong.length} row(s) of another type came back — the Type dropdown lies`);
  } else soft('product_type filter', 'no row carries a product_type — not probed');

  if (aSku) {
    const r = await compare(`coverage=all&limit=200&search=${encodeURIComponent(aSku)}`);
    check(rowsOf(r).some((x) => x.sku === aSku),
      `search=${aSku} finds that product`,
      `searching an exact SKU from the baseline returned ${rowsOf(r).length} rows and not that one`);
    const nope = await compare(`coverage=all&limit=200&search=${NONSENSE}`);
    check(rowsOf(nope).length === 0,
      'a nonsense search returns nothing (the param is not ignored)',
      `search=${NONSENSE} returned ${rowsOf(nope).length} rows — search= is IGNORED`);
  } else soft('search filter', 'no row carries a SKU — not probed');

  {
    const r = await compare('coverage=multi&limit=200&min_saving=5');
    const under = rowsOf(r).filter((x) => Number(x.saving_vs_next) < 5);
    check(r.status === 200 && total(r) <= nMulti && under.length === 0,
      `min_saving=5 → ${total(r)} of ${nMulti} rows, none below $5`,
      `${under.length} row(s) below the threshold came back, or the total did not shrink `
      + `(${total(r)} vs ${nMulti}) — min_saving is not being applied`);
  }

  // Every sort must be accepted; a rejected one is a hard 400 that blanks the page.
  for (const s of ['saving_desc', 'saving_pct_desc', 'cheapest_cost_asc', 'name_asc']) {
    const r = await compare(`coverage=multi&limit=1&sort=${s}`);
    check(r.status === 200, `sort=${s} accepted`,
      `HTTP ${r.status} — this sort is in the page's dropdown and would blank the table`);
  }

  // ── 3. THE DECOYS. This is the section the page's architecture rests on ──
  say('\n\x1b[1m3. Decoy guard — params that are accepted and IGNORED\x1b[0m');
  say('   \x1b[2mThe page fetches every page and filters in the browser BECAUSE of these.\x1b[0m');
  for (const param of ['supplier', 'cheapest_supplier', 'stale', 'exclude_stale', 'fresh_only']) {
    const value = param === 'supplier' || param === 'cheapest_supplier'
      ? encodeURIComponent(baseRows[0].cheapest_supplier || 'Augmento')
      : (param === 'stale' ? 'false' : 'true');
    const r = await compare(`coverage=multi&limit=1&${param}=${value}`);
    if (r.status !== 200) {
      soft(`${param}= now returns HTTP ${r.status}`,
        'it used to be silently ignored. Worth a look — the page never sends it either way.');
    } else if (total(r) === nMulti) {
      ok(`${param}= is still ignored (${total(r)} of ${nMulti} rows) — filtering stays client-side`);
    } else {
      // A pleasant surprise is still a contract change, and a loud one: it means
      // the page can stop pulling every page.
      soft(`${param}= NOW FILTERS (${total(r)} of ${nMulti} rows)`,
        'The backend has implemented this. utils/supplier-offers.js DECOY_PARAMS and the '
        + 'fetch-everything strategy in AdminAPI.supplierOffers can now be simplified.');
    }
  }

  // ── 4. Bad input must 400, not silently return everything ────────────────
  say('\n\x1b[1m4. Validation — a bad value must be refused, not ignored\x1b[0m');
  for (const [qs, label] of [
    ['coverage=bogus', 'coverage=bogus'],
    ['sort=bogus', 'sort=bogus'],
    ['limit=201', 'limit=201 (max is 200)'],
    ['page=0', 'page=0'],
    ['min_saving=abc', 'min_saving=abc'],
  ]) {
    const r = await compare(qs);
    check(r.status === 400, `${label} → 400`,
      `HTTP ${r.status} — an invalid value is being accepted, so a typo silently returns the wrong set`);
  }

  // ── 5. The freshness strip must survive an empty result ──────────────────
  say('\n\x1b[1m5. Empty result — the supplier strip must not vanish with the rows\x1b[0m');
  {
    const r = await compare(`coverage=multi&limit=50&search=${NONSENSE}`);
    const feeds = r.json?.data?.suppliers || [];
    check(rowsOf(r).length === 0 && feeds.length > 0,
      `a no-match filter returns 0 rows but still names ${feeds.length} supplier feed(s)`,
      `rows=${rowsOf(r).length}, suppliers=${feeds.length} — the page's freshness strip is built from `
      + 'data.suppliers[], so an empty array here would blank the one part of the header that still '
      + 'has something true to say');
    const t = r.json?.meta?.totals;
    check(t && Number(t.sum_per_unit_saving) === 0,
      'meta.totals zeroes out with the rows',
      `totals came back as ${JSON.stringify(t)} for an empty result — a saving total that survives its `
      + 'own rows would be printed against nothing');
  }
  {
    const r = await compare('coverage=multi&limit=50&page=999');
    check(r.status === 200 && rowsOf(r).length === 0,
      'a page past the end is a 200 with no rows, not an error',
      `HTTP ${r.status} — the client-side pager can overshoot after a filter narrows the set`);
  }

  // ── 6. The stale economics — printed every run, because they move ────────
  say('\n\x1b[1m6. The stale split — the reason this page is not one number\x1b[0m');
  const full = await compare('coverage=multi&limit=200');
  const all172 = rowsOf(full);
  const staleAfter = full.json?.meta?.stale_after_days;
  check(Number.isFinite(Number(staleAfter)) && Number(staleAfter) > 0,
    `meta.stale_after_days = ${staleAfter}`,
    'the staleness threshold is missing from meta — the page would fall back to a hardcoded 30 and '
    + 'silently disagree with the backend if the policy ever changed');
  check(all172.length === nMulti,
    `all ${all172.length} comparable rows fit in one request at limit=200`,
    `only ${all172.length} of ${nMulti} rows came back in one page — the page's single-request `
    + 'assumption for the Compare tab no longer holds (it pages anyway, but this is worth knowing)');

  if (all172.length) {
    let freshT = 0; let staleT = 0; let freshN = 0; let staleN = 0; let ties = 0;
    let swaps = 0; let staleSwaps = 0; let unknownCost = 0;
    for (const r of all172) {
      const sav = Number(r.saving_vs_next) || 0;
      if (sav <= 0.005) { ties++; } else if (r.cheapest_is_stale) { staleN++; staleT += sav; }
      else { freshN++; freshT += sav; }
      if (r.current_cost_price == null) unknownCost++;
      else if (Number(r.cheapest_cost) < Number(r.current_cost_price) - 0.005) {
        swaps++;
        if (r.cheapest_is_stale) staleSwaps++;
      }
    }
    say(`      fresh  ${money(freshT).padStart(9)}  across ${String(freshN).padStart(3)} products`);
    say(`      stale  ${money(staleT).padStart(9)}  across ${String(staleN).padStart(3)} products`);
    say(`      ties   ${String(ties).padStart(13)} products quoted the same by every supplier`);
    say(`      switch ${String(swaps).padStart(13)} rows would change supplier, ${staleSwaps} of them on a stale price`);
    if (unknownCost) say(`      unknown${String(unknownCost).padStart(13)} rows have no catalogue cost to compare against`);
    const serverTotal = Number(full.json?.meta?.totals?.sum_per_unit_saving || 0);
    check(Math.abs((freshT + staleT) - serverTotal) < 0.05,
      `our split (${money(freshT + staleT)}) reconciles with meta.totals.sum_per_unit_saving (${money(serverTotal)})`,
      `we compute ${money(freshT + staleT)} but the server reports ${money(serverTotal)} — the page's `
      + 'split panel and any server-sourced headline would disagree on screen');
    if (staleSwaps && swaps && staleSwaps / swaps > 0.5) {
      soft(`${staleSwaps} of ${swaps} "switch and save" rows rest on a stale price`,
        'This is the finding the page is built around. It is a NOTE, not a failure — the data is '
        + 'correct, it is the age that needs saying. Ask the supplier for a current list.');
    }
  }

  // ── 7. The review queue ──────────────────────────────────────────────────
  say('\n\x1b[1m7. Needs review — counts, and the reason= decoy\x1b[0m');
  const un = await get(`${UNMATCHED}?limit=1`);
  if (un.status !== 200) {
    bad('GET unmatched', `HTTP ${un.status} — the review tab cannot load`);
  } else {
    const unTotal = un.json?.meta?.pagination?.total;
    const byReason = un.json?.meta?.by_reason || {};
    const sum = Object.values(byReason).reduce((a, b) => a + Number(b || 0), 0);
    check(sum === unTotal,
      `by_reason sums to the total (${sum} = ${unTotal})`,
      `by_reason adds to ${sum} but pagination.total is ${unTotal} — the review tab's chips would not `
      + 'account for every row in the queue');

    const actionable = Object.entries(byReason)
      .filter(([r]) => r === 'ambiguous' || r === 'no_model_number')
      .reduce((a, [, n]) => a + Number(n || 0), 0);
    ok(`${actionable} of ${unTotal} lines need a human decision`,
      `${unTotal - actionable} are "no catalogue match", hidden behind the page's Show all toggle`);

    const unknown = Object.keys(byReason).filter((r) =>
      !['ambiguous', 'no_model_number', 'no_catalogue_match'].includes(r));
    if (unknown.length) {
      soft(`unrecognised reason(s): ${unknown.join(', ')}`,
        'The page surfaces an unknown reason as ACTIONABLE rather than filing it as noise, so these '
        + 'are visible — but REASON_META in utils/supplier-offers.js should be taught what they mean.');
    }

    // The decoy that shapes the review tab.
    const filtered = await get(`${UNMATCHED}?limit=1&reason=ambiguous`);
    const fTotal = filtered.json?.meta?.pagination?.total;
    if (filtered.status !== 200) {
      soft(`reason= now returns HTTP ${filtered.status}`, 'the page never sends it either way');
    } else if (fTotal === unTotal) {
      ok(`reason= is still ignored (${fTotal} of ${unTotal}) — the page partitions client-side`);
    } else {
      soft(`reason= NOW FILTERS (${fTotal} of ${unTotal})`,
        'The review tab can stop pulling all 345 rows and ask for the ~26 directly. '
        + 'Update DECOY_PARAMS.unmatched and AdminAPI.supplierOffers.unmatchedAll.');
    }

    // supplier= on unmatched IS honoured — the page's dropdown depends on it.
    const s0 = un.json?.data?.unmatched?.[0]?.supplier_name;
    if (s0) {
      const bySupplier = await get(`${UNMATCHED}?limit=200&supplier=${encodeURIComponent(s0)}`);
      const wrong = (bySupplier.json?.data?.unmatched || []).filter((o) => o.supplier_name !== s0);
      check(bySupplier.status === 200 && wrong.length === 0
        && bySupplier.json?.meta?.pagination?.total < unTotal,
        `supplier=${s0} narrows the queue and every row matches`,
        `${wrong.length} row(s) from another supplier came back, or the total did not shrink — the `
        + "review tab's supplier dropdown would show other suppliers' lines");
    }
  }

  // ── 8. What the page deliberately does NOT offer ─────────────────────────
  say('\n\x1b[1m8. Absent endpoints — the two features the page had to leave out\x1b[0m');
  {
    // Undo can only ever be session-scoped while this is true.
    const listRoutes = ['/map', '/mappings', '/maps', '/map/list'];
    const statuses = [];
    for (const r of listRoutes) statuses.push((await get(`/api/admin/supplier-offers${r}`)).status);
    check(statuses.every((s) => s === 404),
      `no endpoint lists existing mappings (${listRoutes.join(', ')} → ${statuses.join('/')})`,
      `one of them now answers ${statuses.join('/')} — if mappings can be listed, the page can offer a `
      + 'real undo history instead of a one-shot Undo on the success toast');
    if (!statuses.every((s) => s === 404)) {
      soft('a mappings list may now exist', 'see the line above — this would be an improvement, not a bug');
    }
  }
  {
    // GET, so read-only. The POST routes were measured 403 by hand on 2026-08-31
    // and are NOT re-probed here: a probe must not write, and an import rewrites
    // the whole offer table.
    const r = await get('/api/admin/feed-files');
    if (r.status === 403 && /CRON_SECRET/i.test(r.text)) {
      ok('the feed-files router is still cron-gated (403 CRON_SECRET)',
        'so no browser upload UI can be built — the page says so instead of shipping a dead button');
    } else if (r.status === 200) {
      soft(`GET /api/admin/feed-files now returns 200`,
        'the cron gate may have been relaxed. Re-measure POST /api/admin/feed-files/product-list and '
        + 'POST /api/admin/import/supplier-price-list BY HAND (this probe will not write) — if they '
        + 'accept an admin token, the upload + import panel in supplier-prices.js can be built for real.');
    } else {
      soft(`GET /api/admin/feed-files → HTTP ${r.status}`, 'neither the known 403 nor a 200 — worth a look');
    }
  }

  report();
}

function report() {
  say('');
  rule('─');
  if (JSON_OUT) {
    console.log(JSON.stringify({
      status: findings.length ? 'findings' : 'clean',
      mode: 'read-only', passed: pass, findings, notes,
    }, null, 2));
  } else if (notes.length) {
    say(`\x1b[33m${notes.length} note${notes.length === 1 ? '' : 's'}\x1b[0m `
      + '(real limits the frontend accommodates, not failures):\n');
    notes.forEach((n) => say(`  • ${n}`));
    say('');
  }
  if (!findings.length) {
    say(`\x1b[32m${pass} checks passed.\x1b[0m The Supplier Prices page's assumptions still hold.\n`);
    process.exit(0);
  }
  say(`\x1b[31m${findings.length} failed\x1b[0m, ${pass} passed:\n`);
  findings.forEach((f) => say(`  • ${f.name} — ${f.detail}`));
  say('');
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n✖ probe crashed: ${e?.stack || e}`);
  process.exit(2);
});
