#!/usr/bin/env node
/**
 * probe-orders-supplier-columns.mjs — are the Orders list's Supplier and
 * Supplier cost columns reading a real field, and is the field that LOOKS like
 * a shortcut still lying?
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-03 the Orders list gained two columns beside Profit: who an order
 * was sourced from, and what it cost us ex-GST (ERR-203). Neither value is on
 * the list payload; both are read out of the per-row detail fetch the Profit
 * column already makes.
 *
 * The reason this is a probe rather than a note saying "verified" is a field
 * called `order.supplier_fulfillment`. It is owner-only, already on the API,
 * shaped `{ selected_supplier, total_supplier_cost, line_details[] }` — exactly
 * the two columns, pre-computed — and it is WRONG often enough to be dangerous:
 *
 *     populated on 13 of 45 non-cancelled orders (29%), against 87% for the
 *     line items; and on 2026090102, the one order in the sample sourced from
 *     two suppliers, it reported `selected_supplier: "Augmento"` with
 *     `total_supplier_cost: 27.07` for an order whose lines are DSNZ + Augmento
 *     costing $97.58. One supplier's slice, presented as the order's whole.
 *
 * A test bans the identifier in the frontend. A test cannot notice the day the
 * backend fixes it — or the day the LINE fields regress and the banned field
 * becomes the only source left. That is what §2 is for. The failure this whole
 * file guards against is invisible from the screen: an order list rendering
 * confident supplier names that are quietly missing a supplier looks exactly
 * like one that is right.
 *
 * WHAT IT MEASURES
 * ----------------
 *   1  THE REGIME — are `suppliers[]` / `supplier_cost_snapshot` on the DETAIL?
 *      are they still absent from the LIST? (Both halves matter: if they ever
 *      arrive on the list, the whole per-row fan-out can be deleted.)
 *   2  RECONCILE OR REFUSE — every order carrying `supplier_fulfillment`,
 *      compared against the line-item answer in BOTH directions, by name and by
 *      cost, with the disagreements printed by order number. This is the
 *      watchdog on the finding above.
 *   3  BRANCH COVERAGE — which of the cells' render branches have ANY live data.
 *      A branch with none is named as unexercised rather than assumed working.
 *   4  DECOYS — four list params that look like a supplier filter. Every one is
 *      accepted and ignored, with a real filter as the positive control.
 *   5  AGREEMENT — the shipped cost roll-up vs the shipped profit engine's own
 *      sum, over live orders. Two functions, same numbers, must not drift.
 *
 * It loads the SHIPPED readers (utils/sourcing.js, utils/order-profit.js)
 * rather than re-implementing them. A second copy of the parse in this file
 * would drift from the page and start certifying something nobody ships.
 *
 * -- READ-ONLY. ---------------------------------------------------------------
 * Every request is a GET except the admin sign-in. This script parses no flags
 * and has no recording mode of any kind, deliberately: a probe that can record
 * may pass because it has just overwritten the thing it was comparing against
 * (sweep:b2b ate a committed fixture, 2026-08-12). The mode is PRINTED on every
 * run so it can never be assumed.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:orders-supplier   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'inkcartridges');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** Params that LOOK like a supplier filter on the orders list. All ignored. */
const DECOYS = ['supplier=dsnz', 'supplier=DSNZ', 'supplier_name=DSNZ', 'cheapest_supplier=DSNZ'];
/** A value no backend could plausibly honour — proves a param is not read. */
const NONSENSE = 'supplier=zzznope';
const LIST_LIMIT = 100;
/** Detail fetches. 60/min limiter; 5 at a time with a pause between batches. */
const DETAIL_SAMPLE = 45;
const DETAIL_BATCH = 5;
const BATCH_PAUSE_MS = 1100;
/** Costs are money: agree to the cent, not to the float. */
const CENT = 0.011;

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
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  console.log('\x1b[1mOrders list — Supplier + Supplier cost columns (ERR-203)\x1b[0m');
  console.log('\x1b[90mMODE: READ-ONLY. Every request is a GET except the sign-in.');
  console.log('This script has no recording flag and cannot write to production.\x1b[0m');

  // ── Load the SHIPPED readers ────────────────────────────────────────────
  let S;
  let P;
  try {
    S = await import(path.join(SITE, 'js/admin/utils/sourcing.js'));
    P = await import(path.join(SITE, 'js/admin/utils/order-profit.js'));
  } catch (e) {
    console.error(`\nCannot load the shipped readers: ${e.message}`);
    process.exit(2);
  }
  for (const fn of ['orderSuppliersFromDetail', 'orderSupplierCostFromDetail']) {
    if (typeof S[fn] !== 'function') {
      console.error(`\nutils/sourcing.js no longer exports ${fn} — the columns cannot be probed.`);
      process.exit(2);
    }
  }

  const env = readEnv();
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.error('\nADMIN_EMAIL / ADMIN_PASSWORD missing from .env — cannot sign in.');
    process.exit(2);
  }

  let token;
  try {
    const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    });
    token = (await r.json())?.access_token;
  } catch (e) {
    console.error(`\nSign-in failed: ${e.message}`);
    process.exit(2);
  }
  if (!token) { console.error('\nSign-in returned no access token.'); process.exit(2); }
  const H = { Authorization: `Bearer ${token}` };

  const getJson = async (url) => {
    const r = await fetch(url, { headers: H });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const rowsOf = (b) => (Array.isArray(b?.data) ? b.data : (b?.data?.orders || []));
  const totalOf = (b) => b?.meta?.total ?? b?.data?.pagination?.total ?? null;

  // ── §1 THE REGIME ───────────────────────────────────────────────────────
  head('1. The regime — which endpoint carries the sourcing fields?');

  const list = await getJson(`${BASE}/api/admin/orders?limit=${LIST_LIMIT}`);
  if (list.status !== 200) {
    console.error(`\nGET /api/admin/orders returned ${list.status} — cannot continue.`);
    process.exit(2);
  }
  const listRows = rowsOf(list.body);
  const listTotal = totalOf(list.body);
  ok('orders list reachable', `${listRows.length} rows of ${listTotal} total`);

  let listItems = 0;
  let listWithFields = 0;
  for (const r of listRows) {
    for (const it of (r.items || r.order_items || [])) {
      listItems++;
      if (Array.isArray(it.suppliers) || it.supplier_cost_snapshot != null || it.origin) listWithFields++;
    }
  }
  if (listWithFields === 0) {
    ok('the LIST payload still carries no sourcing fields',
      `0 of ${listItems} list items have suppliers/origin/supplier_cost_snapshot — the per-row fan-out is still required`);
  } else {
    soft('THE LIST HAS GAINED THE SOURCING FIELDS',
      `${listWithFields} of ${listItems} list items now carry them. This is GOOD NEWS and an action:\n`
      + 'hydrateRowDetail() in pages/orders.js can stop fanning out one detail GET per row for these\n'
      + 'two columns. Check whether supplier_cost_snapshot is complete before removing anything.');
  }

  const nonCancelled = listRows.filter((r) => String(r.status || '').toLowerCase() !== 'cancelled');
  const sample = nonCancelled.slice(0, DETAIL_SAMPLE);
  if (!sample.length) {
    skip('everything below', 'the list returned no non-cancelled orders to inspect');
    return report();
  }

  // ── Fetch the details once; every section below reads this one sample ────
  const details = [];
  for (let i = 0; i < sample.length; i += DETAIL_BATCH) {
    const batch = sample.slice(i, i + DETAIL_BATCH);
    const res = await Promise.all(batch.map((r) =>
      getJson(`${BASE}/api/admin/orders/${r.id}`).catch(() => null)));
    res.forEach((x, j) => {
      const o = x?.body?.data?.order ?? x?.body?.data;
      if (o) details.push({ row: batch[j], order: o });
    });
    if (i + DETAIL_BATCH < sample.length) await sleep(BATCH_PAUSE_MS);
  }
  if (details.length < sample.length) {
    soft('some detail fetches did not return', `${details.length} of ${sample.length} resolved`);
  }

  let detailItems = 0;
  let withSuppliers = 0;
  let withCost = 0;
  for (const { order } of details) {
    for (const it of (order.items || order.order_items || [])) {
      detailItems++;
      if (Array.isArray(it.suppliers) && it.suppliers.some((s) => s && s.name)) withSuppliers++;
      if (it.supplier_cost_snapshot != null) withCost++;
    }
  }
  if (detailItems === 0) {
    bad('the DETAIL payload has no line items at all', 'both columns would render em-dashes for every order');
  } else if (withSuppliers === 0) {
    bad('the DETAIL payload no longer carries suppliers[]',
      `0 of ${detailItems} items. The Supplier column is rendering em-dashes for EVERY order,\n`
      + 'which on screen is indistinguishable from "we have no suppliers recorded".');
  } else {
    ok('detail items carry suppliers[]', `${withSuppliers} of ${detailItems} items`);
  }
  if (withCost === 0 && detailItems > 0) {
    bad('the DETAIL payload no longer carries supplier_cost_snapshot',
      'the Supplier cost column is UNKNOWN for every order, and so is Profit');
  } else if (detailItems > 0) {
    ok('detail items carry supplier_cost_snapshot', `${withCost} of ${detailItems} items`);
  }

  // ── §2 RECONCILE OR REFUSE ──────────────────────────────────────────────
  head('2. supplier_fulfillment vs the line items — the watchdog');

  let sfPresent = 0;
  let sfNameAgree = 0;
  let sfCostAgree = 0;
  let sfNullButLinesKnow = 0;
  const sfDisagreements = [];

  for (const { order } of details) {
    const sup = S.orderSuppliersFromDetail(order);
    const cost = S.orderSupplierCostFromDetail(order);
    const sf = order.supplier_fulfillment;
    const num = order.order_number || order.id;

    if (!sf || sf.selected_supplier == null) {
      if (sup.names.length) sfNullButLinesKnow++;
      continue;
    }
    sfPresent++;

    // The field names ONE supplier. The lines may name several. Agreement means
    // the field accounts for every supplier the order actually used.
    const lineAnswer = sup.names.slice().sort().join('+');
    if (lineAnswer === String(sf.selected_supplier)) sfNameAgree++;
    else sfDisagreements.push(`${num}: lines say [${lineAnswer || 'none'}], supplier_fulfillment says "${sf.selected_supplier}"`);

    const sfCost = Number(sf.total_supplier_cost);
    if (cost.costExGst != null && Number.isFinite(sfCost) && Math.abs(sfCost - cost.costExGst) < CENT) {
      sfCostAgree++;
    } else {
      sfDisagreements.push(`${num}: lines cost ${cost.costExGst == null ? 'UNKNOWN' : cost.costExGst.toFixed(2)}, `
        + `supplier_fulfillment says ${Number.isFinite(sfCost) ? sfCost.toFixed(2) : String(sf.total_supplier_cost)}`);
    }
  }

  if (sfPresent === 0) {
    soft('supplier_fulfillment is not populated on any sampled order',
      'nothing to reconcile. The ban in utils/sourcing.js stands unchallenged.');
  } else if (sfNameAgree === sfPresent && sfCostAgree === sfPresent && sfNullButLinesKnow === 0) {
    // Not a failure — a promotion opportunity, and it must be loud.
    soft('supplier_fulfillment NOW AGREES WITH THE LINES EVERYWHERE',
      `${sfPresent}/${sfPresent} on name AND cost, with no order where the lines know and it does not.\n`
      + 'The reason for the ban in utils/sourcing.js may have been fixed backend-side. RE-MEASURE over a\n'
      + 'larger sample (this one is capped at ' + DETAIL_SAMPLE + ') before trusting it — and note that a\n'
      + 'sample containing no multi-supplier order cannot exonerate a field that failed on exactly that case.');
  } else {
    ok('supplier_fulfillment still disagrees with the lines — the ban is still correct',
      `name ${sfNameAgree}/${sfPresent}, cost ${sfCostAgree}/${sfPresent}, `
      + `plus ${sfNullButLinesKnow} orders whose lines name a supplier while the field is null`);
    for (const d of sfDisagreements.slice(0, 8)) console.log(`      \x1b[90m${d}\x1b[0m`);
    if (sfDisagreements.length > 8) console.log(`      \x1b[90m…and ${sfDisagreements.length - 8} more\x1b[0m`);
  }

  // ── §3 BRANCH COVERAGE ──────────────────────────────────────────────────
  head('3. Which render branches have live data?');

  const branch = { ok: 0, partial: 0, noSupplier: 0, noItems: 0, costUnknown: 0, multiSupplier: 0 };
  for (const { order } of details) {
    const sup = S.orderSuppliersFromDetail(order);
    const cost = S.orderSupplierCostFromDetail(order);
    if (!sup.itemCount) { branch.noItems++; continue; }
    if (!sup.names.length) branch.noSupplier++;
    else if (sup.missingSupplierCount > 0) branch.partial++;
    else branch.ok++;
    if (sup.names.length > 1) branch.multiSupplier++;
    if (cost.costExGst == null && cost.itemCount) branch.costUnknown++;
  }
  console.log(`      fully supplied ${branch.ok} · PARTIAL ${branch.partial} · no supplier ${branch.noSupplier} `
    + `· no items ${branch.noItems} · multi-supplier ${branch.multiSupplier} · cost UNKNOWN ${branch.costUnknown}`);

  // Each branch that has never been seen is NAMED. An unexercised branch is not
  // a passing branch; saying so is the difference between evidence and a guess.
  for (const [label, n, why] of [
    ['fully-supplied', branch.ok, 'the ordinary case — if this is 0 the column is showing nothing useful'],
    ['PARTIAL (some lines unsupplied)', branch.partial, 'the loud "+N?" marker'],
    ['no supplier on any line', branch.noSupplier, 'the "not the same as having no supplier" tooltip'],
    ['multi-supplier', branch.multiSupplier, 'the comma-joined names — and the exact case supplier_fulfillment gets wrong'],
    ['cost UNKNOWN', branch.costUnknown, 'the "UNKNOWN, not $0" tooltip'],
  ]) {
    if (n === 0) skip(`branch: ${label}`, `no live order exercises it in this sample — ${why}`);
    else ok(`branch: ${label}`, `${n} order${n === 1 ? '' : 's'}`);
  }
  if (branch.ok === 0) {
    bad('NO order in the sample renders a supplier name',
      'the column is an em-dash everywhere, which looks identical to a working column with no data');
  }

  // ── §4 DECOYS ───────────────────────────────────────────────────────────
  head('4. Params that look like a supplier filter');

  const baseline = totalOf((await getJson(`${BASE}/api/admin/orders?limit=1`)).body);
  if (baseline == null) {
    skip('decoy checks', 'the list envelope carried no total to compare against');
  } else {
    // Positive control FIRST: if a filter we know works does not change the
    // total, the whole method is broken and the decoy results mean nothing.
    const control = totalOf((await getJson(`${BASE}/api/admin/orders?limit=1&status=cancelled`)).body);
    if (control == null || control === baseline) {
      skip('decoy checks', `positive control failed — ?status=cancelled returned ${control} against a baseline of ${baseline}, `
        + 'so this method cannot tell a working filter from an ignored one');
    } else {
      ok('positive control', `?status=cancelled narrows ${baseline} → ${control}`);
      for (const q of [...DECOYS, NONSENSE]) {
        const t = totalOf((await getJson(`${BASE}/api/admin/orders?limit=1&${q}`)).body);
        if (t === baseline) ok(`?${q} is a decoy`, `ignored, still ${t} rows`);
        else soft(`?${q} CHANGED THE RESULT`, `${baseline} → ${t}. The orders list may have gained a supplier filter; `
          + 'if so the Supplier column could become server-filterable and sortable.');
      }
    }
  }

  // ── §5 AGREEMENT ────────────────────────────────────────────────────────
  head('5. The two shipped cost sums must agree');

  let compared = 0;
  let drifted = 0;
  for (const { order } of details) {
    const mine = S.orderSupplierCostFromDetail(order);
    const theirs = P.orderProfitFromDetail(order);
    if (mine.costExGst == null || theirs.totalCostExGst == null) continue;
    compared++;
    if (Math.abs(mine.costExGst - theirs.totalCostExGst) >= CENT) {
      drifted++;
      console.log(`      \x1b[90m${order.order_number}: sourcing ${mine.costExGst.toFixed(2)} `
        + `vs order-profit ${theirs.totalCostExGst.toFixed(2)}\x1b[0m`);
    }
  }
  if (compared === 0) {
    skip('cost agreement', 'no sampled order had a stateable cost in BOTH readers');
  } else if (drifted === 0) {
    ok('orderSupplierCostFromDetail agrees with the profit engine', `${compared}/${compared} orders, to the cent`);
  } else {
    bad('the two cost sums have drifted',
      `${drifted} of ${compared} orders disagree. The Supplier cost column and the Profit column are\n`
      + 'quoting different costs for the same order — one of them is wrong on screen right now.');
  }

  return report();
}

function report() {
  console.log(`\n\x1b[1m${pass} check${pass === 1 ? '' : 's'} passed, ${failures.length} failed, ${notes.length} note${notes.length === 1 ? '' : 's'}.\x1b[0m`);
  if (notes.length) {
    console.log('\nNotes (not failures):');
    for (const n of notes) console.log(`  ~ ${n}`);
  }
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nProbe could not run: ${e.stack || e.message}`);
  process.exit(2);
});
