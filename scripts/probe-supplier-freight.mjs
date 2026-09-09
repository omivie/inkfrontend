#!/usr/bin/env node
/**
 * probe-supplier-freight.mjs — is the ERR-241 freight rule still standing on
 * the evidence it was built from?
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The rule "DSNZ always bills us freight, Augmento only under $100 ex-GST" is a
 * business fact, and the amount is a COPY of the courier ladder. Both can go
 * stale silently:
 *
 *   - `ZONE_RATES` in utils/supplier-freight.js is transcribed from
 *     /api/settings. If the real ladder changes, every freight figure the modal
 *     prints is wrong and nothing on screen says so. §1 re-fetches it.
 *   - The reason the module does not charge DSNZ itself is that the backend's
 *     `shipping_absorbed` already does — measured, 23 of 23 populated rows
 *     contain a DSNZ line and 6 of 6 Augmento-only free-shipping orders are
 *     {applies:false}. The day the backend starts populating Augmento orders,
 *     this module would DOUBLE-CHARGE them. §2 re-measures that split so the
 *     assumption cannot outlive its evidence.
 *
 * A unit test cannot see either of those: both live on the far side of the
 * network. That is the whole reason this file is a probe.
 *
 * WHAT IT MEASURES
 * ----------------
 *   1  THE LADDER — /api/settings shipping.zones vs the shipped ZONE_RATES,
 *      band for band. A drifted fee is a hard failure.
 *   2  THE SPLIT — for every free-shipping order, does it carry
 *      shipping_absorbed, and does it contain a DSNZ line? Any Augmento-only
 *      order that HAS an absorbed amount is the double-charge case and fails.
 *   3  THE DECISIONS — replay the SHIPPED resolver over every live order and
 *      print what it decided and why. No re-implementation: it imports the
 *      same modules the admin runs, because a probe that reimplements the thing
 *      it checks is certifying a replica (ERR-231).
 *   4  POSITIVE CONTROL — on every order where freight applies, take-home must
 *      be STRICTLY lower than the same order computed without it, and the
 *      waterfall must still foot. A rule that quietly never fires would sail
 *      through §1–§3; this is what goes red instead.
 *
 * Usage:  npm run probe:supplier-freight   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'inkcartridges');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const SAMPLE = Number(process.env.SAMPLE || 60);

const failures = [];
const notes = [];
const ok = (n) => console.log(`  \x1b[32m✓\x1b[0m ${n}`);
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${String(d).split('\n').join('\n      ')}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${String(d).split('\n').join('\n      ')}`); };
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (n, why) => { notes.push(`SKIPPED: ${n} — ${why}`); console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${n}\n      ${why}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${n.toFixed(2)}`);

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
  console.log('\x1b[1mSupplier freight on order profit (ERR-241)\x1b[0m');
  console.log('\x1b[90mMODE: READ-ONLY. Every request is a GET except the sign-in.');
  console.log('This script has no recording flag and cannot write to production.\x1b[0m');

  // ── Load the SHIPPED modules. Never a copy of them. ──────────────────────
  let SF; let P;
  try {
    SF = await import(path.join(SITE, 'js/admin/utils/supplier-freight.js'));
    P = await import(path.join(SITE, 'js/admin/utils/order-profit.js'));
  } catch (e) {
    console.error(`\nCannot load the shipped modules: ${e.message}`);
    process.exit(2);
  }
  for (const fn of ['supplierFreightForOrder', 'lightestZoneRateInclGst']) {
    if (typeof SF[fn] !== 'function') {
      console.error(`\nutils/supplier-freight.js no longer exports ${fn} — the rule cannot be probed.`);
      process.exit(2);
    }
  }

  // ── §1 THE LADDER ─────────────────────────────────────────────────────────
  head('§1  The zone ladder — is the transcription still the truth?');
  let liveZones = null;
  try {
    const r = await fetch(`${BASE}/api/settings`);
    const j = await r.json();
    liveZones = (j?.data ?? j)?.shipping?.zones ?? null;
  } catch (e) { soft('fetch /api/settings', e.message); }

  if (!liveZones) {
    skip('ladder comparison', '/api/settings returned no shipping.zones — the ladder could NOT be checked this run');
  } else {
    for (const [zone, tiers] of Object.entries(SF.ZONE_RATES)) {
      const live = liveZones[zone]?.tiers;
      if (!Array.isArray(live)) { bad(`zone ${zone}`, 'present in ZONE_RATES, absent from /api/settings'); continue; }
      // Pick by which KEY exists, then canonicalise. `??` cannot do this job:
      // the live band says `max_weight_kg: null` and the shipped one says
      // `maxKg: null`, so `live.max_weight_kg ?? live.maxKg` falls through a
      // real null to an absent key and prints "undefined" against "null" —
      // two spellings of "no upper bound", reported as a drifted ladder.
      const pick = (t, snake, camel) => (Object.prototype.hasOwnProperty.call(t, snake) ? t[snake] : t[camel]);
      const band = (v) => (v == null ? 'open' : String(Number(v)));
      const norm = (t) => `${pick(t, 'delivery_type', 'deliveryType')}|${Number(t.fee)}`
        + `|${band(pick(t, 'min_weight_kg', 'minKg'))}|${band(pick(t, 'max_weight_kg', 'maxKg'))}`;
      const a = [...live].map(norm).sort();
      const b = [...tiers].map(norm).sort();
      if (a.join(';') === b.join(';')) ok(`zone ${zone} — ${tiers.length} bands match /api/settings exactly`);
      else bad(`zone ${zone}`, `ladder has DRIFTED.\n  live:    ${a.join('\n           ')}\n  shipped: ${b.join('\n           ')}`);
    }
    for (const zone of Object.keys(liveZones)) {
      if (!SF.ZONE_RATES[zone]) bad(`zone ${zone}`, 'served by /api/settings but MISSING from ZONE_RATES — orders in it cannot be priced');
    }
  }

  // ── sign in ───────────────────────────────────────────────────────────────
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
  } catch (e) { console.error(`\nSign-in failed: ${e.message}`); process.exit(2); }
  if (!token) { console.error('\nSign-in returned no access token.'); process.exit(2); }
  const H = { Authorization: `Bearer ${token}` };

  const listRes = await fetch(`${BASE}/api/admin/orders?limit=200`, { headers: H });
  const listJson = await listRes.json();
  const rows = Array.isArray(listJson?.data) ? listJson.data : (listJson?.data?.orders || []);
  const live = rows.filter((o) => String(o.status || '').toLowerCase() !== 'cancelled').slice(0, SAMPLE);
  if (!live.length) {
    console.error('\nThe orders list returned nothing — this run proves NOTHING. Refusing to grade it.');
    process.exit(2);
  }

  const details = [];
  for (const r of live) {
    const d = await fetch(`${BASE}/api/admin/orders/${r.id}`, { headers: H });
    if (!d.ok) continue;
    const j = await d.json();
    const o = j?.data?.order || j?.data || j;
    if (o && typeof o === 'object' && Array.isArray(o.items)) details.push(o);
  }
  console.log(`\n\x1b[90m${details.length} order details fetched (of ${live.length} non-cancelled rows).\x1b[0m`);

  // ── §2 THE SPLIT ──────────────────────────────────────────────────────────
  head('§2  The split this rule rests on — does shipping_absorbed still mean DSNZ?');
  let freeShip = 0; let absorbedWithDsnz = 0; let absorbedWithout = 0; let augmentoOnlyAbsorbed = 0;
  for (const o of details) {
    const paid = Number(o.shipping_fee ?? o.shipping_cost);
    if (Number.isFinite(paid) && paid > 0) continue;
    freeShip++;
    const names = new Set();
    for (const it of o.items) for (const s of (it.suppliers || [])) if (s?.name) names.add(String(s.name));
    const hasDsnz = [...names].some((n) => String(n).toLowerCase() === 'dsnz');
    const abs = o.shipping_absorbed;
    const applies = !!abs && abs.applies === true && Number(abs.amount_incl_gst) > 0;
    if (!applies) continue;
    if (hasDsnz) absorbedWithDsnz++;
    else { absorbedWithout++; if (names.size) augmentoOnlyAbsorbed++; }
  }
  console.log(`  free-shipping orders: ${freeShip} | absorbed+DSNZ: ${absorbedWithDsnz} | absorbed WITHOUT DSNZ: ${absorbedWithout}`);
  if (absorbedWithout === 0) {
    ok('every absorbed-courier row still belongs to a DSNZ order — the no-double-charge assumption holds');
  } else {
    bad('shipping_absorbed no longer means DSNZ',
      `${absorbedWithout} free-shipping order(s) carry an absorbed amount with no DSNZ line `
      + `(${augmentoOnlyAbsorbed} of them name another supplier). supplierFreightForOrder drops ONE consignment `
      + `when absorbed applies, preferring the always-pays supplier — with no DSNZ line it drops the wrong one, `
      + `or the backend is now paying for a consignment this module also charges. Re-derive before shipping.`);
  }

  // ── §3 THE DECISIONS ──────────────────────────────────────────────────────
  head('§3  Every live decision the shipped resolver makes');
  let applied = 0; let none = 0; let unknown = 0; let estimated = 0;
  const affected = [];
  for (const o of details) {
    const info = P.orderProfitFromDetail(o);
    if (info.supplierFreightUnknown) {
      unknown++;
      console.log(`  \x1b[33m?\x1b[0m ${o.order_number}  freight OWED but not priced — ${info.supplierFreightUnknownReason}`);
      if (info.netProfit == null) {
        bad(`${o.order_number}`, 'unpriced freight blanked take-home. It must stay a stateable CEILING (ERR-158).');
      }
      continue;
    }
    if (!info.supplierFreightApplies) { none++; continue; }
    applied++;
    if (info.supplierFreightEstimated) estimated++;
    const b = info.breakdown;
    console.log(`  \x1b[36m$\x1b[0m ${o.order_number}  ${info.supplierFreightSuppliers.join(', ')}  `
      + `−${money(b.supplierFreightInclGst)}${info.supplierFreightEstimated ? ' (est)' : ''}  `
      + `take-home ${money(b.netProfit)}  margin ${b.netMarginPct.toFixed(1)}%`);
    affected.push({ o, info });
  }
  console.log(`\n  freight applied: ${applied} (${estimated} estimated) | no freight owed: ${none} | owed-but-unpriced: ${unknown}`);
  if (estimated === applied && applied > 0) {
    soft('every priced consignment is an ESTIMATE',
      'the backend sends an amount only for the consignment already covered by shipping_absorbed. '
      + 'Until the ERR-241 brief lands, each figure above is the LIGHTEST band of its zone — a floor, '
      + 'and a heavy parcel really does cost more.');
  }

  // ── §4 POSITIVE CONTROL ───────────────────────────────────────────────────
  head('§4  Positive control — a rule that never fires must go RED, not quiet');
  if (!affected.length) {
    bad('no order in the sample owes supplier freight',
      `Measured 2026-09-09, 6 of 60 did (five Augmento-only orders under $100 plus one leg of the `
      + `two-supplier order 2026090102). Zero means the rule has stopped firing — a gate that never `
      + `fires passes every other check in this file.`);
  } else {
    ok(`${affected.length} order(s) actually carry a freight deduction`);
    let footErrors = 0; let notLower = 0;
    for (const { o, info } of affected) {
      const b = info.breakdown;
      const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
        - b.absorbedShippingInclGst - b.supplierFreightInclGst - b.gstRemittedToIrd;
      if (Math.abs(foot - b.netProfit) > 0.005) { footErrors++; bad(`${o.order_number} waterfall`, `${foot} vs take-home ${b.netProfit}`); }
      // Strictly lower than the same order with the freight removed. Recomputed
      // from the SHIPPED engine, not from a remembered number.
      const without = P.orderProfitFromDetail({ ...o, delivery_zone: null, shipping_absorbed: o.shipping_absorbed });
      if (without.netProfit != null && !(b.netProfit < without.netProfit - 0.005)) {
        notLower++;
        bad(`${o.order_number} take-home`, `${money(b.netProfit)} is not lower than the no-freight figure ${money(without.netProfit)}`);
      }
    }
    if (!footErrors) ok('every affected order still foots to the cent');
    if (!notLower) ok('every affected order nets strictly LESS than it did before the freight');
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  head('Result');
  for (const n of notes) console.log(`  \x1b[33m~\x1b[0m ${n}`);
  if (failures.length) {
    console.log(`\n\x1b[31m${failures.length} FAILURE(S)\x1b[0m`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n\x1b[32mAll checks passed.\x1b[0m');
}

main().catch((e) => { console.error(e); process.exit(2); });
