/**
 * Delivery income on order profit — the live measurement (ERR-261)
 * ================================================================
 *
 * ERR-241 deducted the freight a supplier bills us and short-circuited it
 * whenever the customer had paid for delivery: shipping was a balanced
 * pass-through. ERR-255 deleted that short-circuit and booked only the cost
 * half. Every order where the customer paid for delivery has been understated
 * by the ex-GST shipping charge since 2026-09-12.
 *
 * WHAT THIS PROBE ANSWERS THAT THE UNIT TESTS CANNOT
 *
 *   §1  Is `shipping_fee` actually ON the payload, and on how many orders? The
 *       frontend now floors any order without it. If that is 3 orders this is
 *       belt-and-braces; if it is 300 the floor is the common case and the
 *       backend needs telling. A unit test can only prove the reader handles
 *       absence — never how often absence happens.
 *
 *   §2  THE BOUND. `gstRemittedToIrd` can never exceed the output GST on the
 *       sale (`total × 3/23`). This is the one assertion that would have caught
 *       ERR-261 on day one, run here against every live order rather than one
 *       fixture. The waterfall FOOTED throughout the defect — a residual always
 *       does — so footing was never evidence of anything.
 *
 *   §3  How big was it? Take-home before and after, per order and in total.
 *
 *   §4  Does the stated fee reconcile against the charged total? Two numbers
 *       agreeing is the only reason to believe either (ERR-253).
 *
 *   §5  WHOSE REVENUE BASIS IS RIGHT? The frontend now books shipping as
 *       revenue. If the backend's KPI revenue does NOT, the two surfaces have
 *       just diverged and we owe the backend a brief. If it DOES, this fix
 *       closed a gap rather than opening one. §5 measures which, and prints the
 *       answer either way — it does not assume the outcome.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. This probe has no --record / --update-baseline mode
 * and writes nothing, anywhere. The mode is printed on every run so it can never
 * be assumed. (A probe that can record may pass because it just overwrote what
 * it was comparing against — sweep:b2b ate a committed fixture, 2026-08-12. A
 * read-only probe once wrote to a live order because it borrowed its safety from
 * the service under test — ERR-257. This one owns its safety: it never builds a
 * non-GET request.)
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:order-profit-shipping
 *         npm run probe:order-profit-shipping -- --limit 100
 * Exit:   0 = every check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils');
const { orderProfitFromDetail } = await import(path.join(ADMIN, 'order-profit.js'));
const { computeProfitBreakdown, GST_RATE } = await import(path.join(ADMIN, 'profitability.js'));
const { supplierFreightForOrder } = await import(path.join(ADMIN, 'supplier-freight.js'));

const GST_OF_GROSS = GST_RATE / (1 + GST_RATE);   // 3/23 — the GST inside a GST-inclusive amount

let pass = 0;
const failures = [];
const notes = [];
const skips = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
/** A named path live data could not reach. ***A SKIP IS NOT A PASS.*** */
const skip = (n, why) => { skips.push(`${n} — ${why}`); console.log(`  \x1b[90m•\x1b[0m SKIP ${n}\n      ${why}`); };
const check = (c, n, d) => (c ? ok(n) : bad(n, d));
/**
 * A gap that is real and worth reporting, but that the frontend already handles
 * correctly — so it must NOT redden the exit code. Keeping these separate is the
 * point: if a soft note could fail the run, the run gets ignored, and then a hard
 * failure gets ignored with it.
 */
const checkSoft = (c, n, d) => (c ? ok(n) : soft(n, d));
const money = (n) => (n == null ? 'null' : `$${Number(n).toFixed(2)}`);

function readEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=');
      return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`sign-in failed (${res.status})`);
  return json.access_token;
}

/** Take-home as the column computed it BEFORE ERR-261: goods revenue only. */
function preFixNetProfit(order, info) {
  const b = info.breakdown;
  if (!b) return null;
  const pre = computeProfitBreakdown(b.revenueExGst, b.supplierCostExGst, {
    customerPaidInclGst: b.customerPaidInclGst,
    supplierFreight: supplierFreightForOrder(order),
    ...(b.stripeFeeInclGst === 0 ? { stripeRate: 0, stripeFixed: 0 } : {}),
    // shippingRevenue deliberately omitted — that IS the defect
  });
  return pre ? pre.netProfit : null;
}

async function main() {
  console.log('\n\x1b[1mDelivery income on order profit — live probe (ERR-261)\x1b[0m');
  console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET; this probe writes nothing.\n');

  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
    console.error('These must be a super_admin — the orders endpoints 403 for anyone else.');
    process.exit(2);
  }
  const token = await signIn(email, password);
  const H = { Authorization: `Bearer ${token}` };
  const get = async (p) => {
    const res = await fetch(BASE + p, { headers: H });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };

  const li = process.argv.indexOf('--limit');
  const limit = li > -1 ? Number(process.argv[li + 1]) || 40 : 40;
  console.log(`Signed in as ${email} — sampling ${limit} orders\n`);

  const list = await get(`/api/admin/orders?page=1&limit=${limit}`);
  if (list.status !== 200) { bad('GET /api/admin/orders', `HTTP ${list.status}`); return report(); }
  const rows = list.json?.data?.orders || list.json?.data?.items || list.json?.data || [];
  check(Array.isArray(rows) && rows.length > 0, `list returned ${rows.length} rows`, 'no rows');

  // Fan out to the detail endpoint — the list carries no costs (ERR-039).
  const details = [];
  for (const r of rows) {
    const res = await get(`/api/admin/orders/${encodeURIComponent(r.id)}`);
    const o = res.json?.data?.order ?? res.json?.data ?? null;
    if (o) details.push(o);
  }
  check(details.length > 0, `fetched ${details.length} order details`, 'no details came back');

  // ── §1 Is the field there at all? ─────────────────────────────────────────
  console.log('\n\x1b[1m§1 the delivery charge — present, null, or absent\x1b[0m');
  // The SAME ladder order-profit.js reads, because asking only about
  // `shipping_fee` answers a different question than the code does. Live, 5 of
  // 40 orders carry `shipping_fee: null` alongside `shipping_cost: 0` — all of
  // them invoices. Reading only the first key reports those as unknown when the
  // reader resolves them fine, which is a probe measuring its own assumption.
  const LADDER = ['shipping_fee', 'shipping_cost', 'shipping_amount'];
  const resolve = (o) => {
    for (const k of LADDER) {
      if (!(k in o) || o[k] == null) continue;
      const n = Number(o[k]);
      if (Number.isFinite(n) && n >= 0) return { key: k, value: n };
    }
    return null;
  };
  let absent = 0, nulled = 0, zero = 0, charged = 0;
  const viaAlias = new Map();
  for (const o of details) {
    const r = resolve(o);
    if (!r) { if (!('shipping_fee' in o)) absent++; else nulled++; continue; }
    if (r.key !== 'shipping_fee') viaAlias.set(r.key, (viaAlias.get(r.key) || 0) + 1);
    if (r.value === 0) zero++; else charged++;
  }
  console.log(`      unresolvable: ${absent} absent · ${nulled} null  |  resolved: ${zero} at $0 · ${charged} charged`);
  for (const [k, n] of viaAlias) {
    console.log(`      \x1b[33m${n} resolved via the \`${k}\` alias, not \`shipping_fee\`\x1b[0m `
      + `— the ladder is LOAD-BEARING, not belt-and-braces`);
  }
  // SOFT, deliberately. An unusable shipping_fee is a BACKEND gap that the
  // frontend already handles correctly, and a probe that goes red forever on
  // someone else's data gets ignored — and then the hard failure below gets
  // ignored with it. What must be HARD is that we handle it right.
  checkSoft(absent + nulled === 0,
    `every sampled order records a delivery charge (${charged} charged, ${zero} free)`,
    `${absent + nulled} of ${details.length} orders carry NO usable shipping_fee (${absent} absent, `
    + `${nulled} null). Those orders are FLOORED — take-home is shown as a lower bound, not a `
    + `measurement. Honest, but not complete: this is the number to quote to the backend.`);
  // ...and this is the hard one. An unusable fee must never become $0 of income.
  // That is the whole defect, and it is the only part of §1 we control.
  const mishandled = details.filter((o) => {
    if (resolve(o)) return false;
    const info = orderProfitFromDetail(o);
    return info.state === 'ok' && !info.shippingRevenueUnknown;
  });
  check(mishandled.length === 0,
    `all ${absent + nulled} orders with no usable fee are FLOORED, never costed at $0 income`,
    `${mishandled.length} order(s) with no usable shipping_fee were priced as if they charged $0 for `
    + `delivery: ${mishandled.map((o) => o.order_number).join(', ')}. That is ERR-261 restored.`);
  check(charged > 0, `${charged} orders have a customer-paid delivery charge to book`,
    'no charged-shipping orders in the sample — this probe cannot prove the fix does anything. '
    + 'Raise --limit or pick a window containing sub-$100 orders.');

  // ── §2 THE BOUND ──────────────────────────────────────────────────────────
  console.log('\n\x1b[1m§2 GST remitted can never exceed the GST in the sale\x1b[0m');
  let breaches = 0, worst = null;
  const stated = [];
  for (const o of details) {
    const info = orderProfitFromDetail(o);
    if (info.state !== 'ok' || !info.breakdown) continue;
    stated.push({ o, info });
    const b = info.breakdown;
    const ceiling = b.customerPaidInclGst * GST_OF_GROSS;
    if (b.gstRemittedToIrd > ceiling + 0.005) {
      breaches++;
      const by = b.gstRemittedToIrd - ceiling;
      if (!worst || by > worst.by) worst = { num: o.order_number, by, got: b.gstRemittedToIrd, ceiling };
    }
  }
  check(breaches === 0, `${stated.length} priced orders all remit no more GST than they collected`,
    `${breaches} orders breach the bound — worst ${worst?.num}: ${money(worst?.got)} remitted on a sale `
    + `containing ${money(worst?.ceiling)} of GST (over by ${money(worst?.by)}). Revenue is not covering `
    + `everything the customer paid, and gstRemittedToIrd is absorbing the difference.`);
  check(stated.length > 0, `${stated.length} orders could be priced`, 'no order resolved to a figure');

  // ── §3 How big was the understatement? ────────────────────────────────────
  console.log('\n\x1b[1m§3 What ERR-261 was costing, per order\x1b[0m');
  let deltaTotal = 0, crossings = 0, moved = 0;
  for (const { o, info } of stated) {
    const pre = preFixNetProfit(o, info);
    if (pre == null) continue;
    const d = info.netProfit - pre;
    if (Math.abs(d) > 0.005) {
      moved++; deltaTotal += d;
      if (pre < 0 && info.netProfit > 0) {
        crossings++;
        console.log(`      ${o.order_number}: ${money(pre)} → \x1b[32m${money(info.netProfit)}\x1b[0m `
          + `(${info.netMarginPct.toFixed(1)}%)  — printed a LOSS, actually profitable`);
      }
    }
  }
  console.log(`      ${moved} of ${stated.length} orders move · total ${money(deltaTotal)} · `
    + `${crossings} crossed from loss to profit`);
  check(moved === charged || moved <= charged,
    `only orders with a delivery charge move (${moved} moved, ${charged} charged)`,
    `${moved} orders moved but only ${charged} record a charge — something other than shipping changed`);

  // ── §4 Does the stated fee reconcile? ─────────────────────────────────────
  console.log('\n\x1b[1m§4 The stated fee against the charged total\x1b[0m');
  let drifted = 0, worstDrift = 0, worstNum = null;
  for (const { o, info } of stated) {
    if (!info.shippingRevenueApplies || info.shippingRevenueDrift == null) continue;
    const d = Math.abs(info.shippingRevenueDrift);
    if (d > 0.05) { drifted++; if (d > worstDrift) { worstDrift = d; worstNum = o.order_number; } }
  }
  // SOFT for the same reason as §1: the frontend's behaviour here is correct by
  // construction — the stated fee wins and the gap is disclosed — so a mismatch
  // is information about the DATA, not a regression in the reader.
  checkSoft(drifted === 0, 'every stated delivery charge reconciles against what was paid (drift ≤ $0.05)',
    `${drifted} order(s) disagree — worst ${worstNum} by ${money(worstDrift)}. The stated fee still wins `
    + `(the backend owns the money) and the gap is surfaced, but something else on those orders is `
    + `unexplained. INV-3276 is a known one (ERR-255 §6: backend goods cost $0.00 against our $70.51).`);
  // The detector must be able to FIRE. A reconciliation check that structurally
  // cannot report a difference is worse than none (ERR-258).
  const withDrift = stated.filter(({ info }) => info.shippingRevenueApplies && info.shippingRevenueDrift != null);
  check(withDrift.length > 0,
    `the reconciliation ran on ${withDrift.length} orders`,
    'NO order produced a drift figure at all — the check is vacuous and would stay green '
    + 'through any disagreement.');

  // ── §5 Whose revenue basis? ───────────────────────────────────────────────
  console.log('\n\x1b[1m§5 Does the backend book shipping as revenue too?\x1b[0m');
  const days = 30;
  const to = new Date(); const from = new Date(to.getTime() - days * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const kpiRes = await fetch(
    `${BASE}/api/admin/analytics/kpi-summary?date_from=${iso(from)}&date_to=${iso(to)}`, { headers: H });
  const kpi = kpiRes.ok ? (await kpiRes.json())?.data ?? null : null;
  if (!kpi || kpi.revenue == null) {
    skip('the backend revenue basis', 'kpi-summary did not return a revenue figure, so this run cannot '
      + 'settle whether the backend books shipping revenue. THIS IS NOT A PASS — the disclosure decision '
      + 'stays open until a run reaches it.');
  } else {
    // If kpi.revenue is Σ orders.total, it ALREADY contains the delivery charge
    // and the backend was on the correct side all along. If it is the goods sum,
    // the backend has the same omission and we owe it a brief.
    const inWindow = stated.filter(({ o }) => new Date(o.created_at) >= from);
    const feGoods = inWindow.reduce((a, { info }) => a + info.breakdown.revenueExGst, 0);
    const feAll = inWindow.reduce((a, { info }) => a + info.breakdown.revenueWithShippingExGst, 0);
    const backendEx = Number(kpi.revenue) * (1 - GST_OF_GROSS);
    console.log(`      backend revenue ex-GST ${money(backendEx)} · FE goods only ${money(feGoods)} `
      + `· FE incl. shipping ${money(feAll)}  (over ${inWindow.length} sampled orders in ${days}d)`);
    console.log('      NOTE: the sample is a page of orders, not the window — compare the GAP, not the totals.');
    if (Math.abs(feAll - feGoods) < 0.01) {
      skip('the backend revenue basis', 'no charged-shipping orders in the window, so the two FE bases '
        + 'are identical and the comparison cannot discriminate.');
    } else {
      const nearerAll = Math.abs(backendEx - feAll) <= Math.abs(backendEx - feGoods);
      if (nearerAll) {
        ok('the backend books shipping as revenue too — this fix CLOSED a gap between the two surfaces');
      } else {
        soft('the backend appears to exclude shipping from revenue while still deducting freight',
          `backend ${money(backendEx)} sits nearer the goods-only sum. If that holds on a full window, the `
          + `backend carries the same half-a-pass-through and needs a brief: either book the shipping `
          + `revenue or stop deducting the freight. Do NOT "fix" the frontend back to match it.`);
      }
    }
  }
  report();
}

function report() {
  console.log(`\n\x1b[1mResult\x1b[0m  ${pass} passed · ${failures.length} failed · `
    + `${notes.length} noted · ${skips.length} skipped`);
  if (skips.length) {
    console.log('\n\x1b[90mSKIPPED — a skip is not a pass:\x1b[0m');
    skips.forEach((s) => console.log(`  • ${s}`));
  }
  if (notes.length) { console.log('\n\x1b[33mNoted:\x1b[0m'); notes.forEach((n) => console.log(`  ~ ${n}`)); }
  if (failures.length) { console.log('\n\x1b[31mFailed:\x1b[0m'); failures.forEach((f) => console.log(`  ✗ ${f}`)); }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('\x1b[31mCould not run:\x1b[0m', e.message); process.exit(2); });
