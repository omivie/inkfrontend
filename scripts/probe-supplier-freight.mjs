#!/usr/bin/env node
/**
 * probe-supplier-freight.mjs — is the admin reading the backend's freight
 * figure, once, and agreeing with the dashboard about it?
 * =============================================================================
 *
 * WHY THIS EXISTS, AND WHY IT CHANGED SHAPE (ERR-241 → ERR-255)
 * -------------------------------------------------------------
 * It used to check a rule the FRONTEND applied: per-supplier terms and a
 * transcribed copy of the courier ladder. Both are deleted. The backend now
 * publishes `order.supplier_freight`, so the things that can go wrong are
 * different things:
 *
 *   - We could DOUBLE-CHARGE. `shipping_absorbed` is the outbound parcel rate
 *     and `supplier_freight` prices the same parcel off the same ladder.
 *     Deducting both was the bug this migration removed. §2 re-measures the
 *     containment every run so the fix cannot rot.
 *   - The BACKEND's rate could drift from the published rate card. The owner's
 *     terms are "at the rates that we use for customers", so §1 checks the
 *     backend's own `parcel_rate_incl_gst` against live /api/settings. This is
 *     strictly stronger than the old check: it validates the number we now
 *     TRUST, rather than a copy of the table we no longer own.
 *   - The modal and the dashboard could disagree. That is the entire point of
 *     the migration, so §5 reconciles the sum of the modal's own figures
 *     against kpi-summary. A probe that doesn't check it can't tell you it
 *     worked.
 *   - The $100 threshold could have run on a different number than the
 *     Supplier-cost column shows. §6 compares the backend's per-consignment
 *     `goods_cost_ex_gst` against our own `costBySupplier`.
 *
 * WHAT IT CANNOT CHECK, AND SAYS SO BY NAME
 * -----------------------------------------
 * `complete:false`, `unpriced_consignments > 0` and a missing envelope fire on
 * 0 of 149 live orders. They are unit-tested in
 * tests/supplier-freight-sep2026.test.js and SKIPPED here. ***A SKIP IS NOT A
 * PASS*** — a green run that silently omitted three render paths is a green run
 * that lied.
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
  console.log('\x1b[1mSupplier freight — reading the backend\'s figure (ERR-241/251)\x1b[0m');
  console.log('\x1b[90mMODE: READ-ONLY. Every request is a GET except the sign-in.');
  console.log('This script has no recording flag and cannot write to production.\x1b[0m');

  // ── Load the SHIPPED modules. Never a copy of them. ──────────────────────
  let SF; let P; let SRC;
  try {
    SF = await import(path.join(SITE, 'js/admin/utils/supplier-freight.js'));
    P = await import(path.join(SITE, 'js/admin/utils/order-profit.js'));
    SRC = await import(path.join(SITE, 'js/admin/utils/sourcing.js'));
  } catch (e) {
    console.error(`\nCannot load the shipped modules: ${e.message}`);
    process.exit(2);
  }
  for (const fn of ['supplierFreightForOrder', 'freightCeilingReason']) {
    if (typeof SF[fn] !== 'function') {
      console.error(`\nutils/supplier-freight.js no longer exports ${fn} — the reader cannot be probed.`);
      process.exit(2);
    }
  }
  // The estimator's exports must STAY gone. Their return is the double-charge.
  for (const gone of ['ZONE_RATES', 'SUPPLIER_FREIGHT_RULES', 'lightestZoneRateInclGst', 'zoneRateInclGst']) {
    if (SF[gone] !== undefined) {
      bad(`utils/supplier-freight.js exports ${gone} again`,
        'the local freight derivation is back. Running it beside the backend field double-charges every order.');
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

  const listRes = await fetch(`${BASE}/api/admin/orders?limit=250`, { headers: H });
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

  // ── §1 THE LADDER, CHECKED ON THE BACKEND'S OWN NUMBER ────────────────────
  head('§1  The backend\'s parcel rate vs the live /api/settings rate card');
  let liveZones = null;
  try {
    const r = await fetch(`${BASE}/api/settings`);
    const j = await r.json();
    liveZones = (j?.data ?? j)?.shipping?.zones ?? null;
  } catch (e) { soft('fetch /api/settings', e.message); }

  if (!liveZones) {
    skip('rate-card comparison', '/api/settings returned no shipping.zones — the rate card could NOT be checked this run');
  } else {
    // Pick by which KEY exists, then canonicalise. `??` cannot do this job: the
    // live band says `max_weight_kg: null` and a shipped one says `maxKg: null`,
    // so `t.max_weight_kg ?? t.maxKg` falls THROUGH a real null to an absent key
    // and prints "undefined" against "null" — two spellings of "no upper bound",
    // reported as a drifted price list. (ERR-241: the probe's own first bug.)
    const pick = (t, snake, camel) => (Object.prototype.hasOwnProperty.call(t, snake) ? t[snake] : t[camel]);
    const rateFor = (zone, kg, area) => {
      const z = liveZones[String(zone || '').trim().toLowerCase()];
      const tiers = Array.isArray(z?.tiers) ? z.tiers : null;
      if (!tiers) return null;
      const want = area === 'rural' ? 'rural' : 'urban';
      const matching = tiers.filter((t) => pick(t, 'delivery_type', 'deliveryType') === want);
      if (!matching.length) return null;
      const w = Number(kg);
      if (!Number.isFinite(w)) return null;
      const band = matching.find((t) => {
        const lo = Number(pick(t, 'min_weight_kg', 'minKg')) || 0;
        const hi = pick(t, 'max_weight_kg', 'maxKg');
        return w >= lo && (hi == null || w < Number(hi));
      });
      return band ? Number(band.fee) : null;
    };
    let checked = 0; let mismatched = 0; const examples = [];
    for (const o of details) {
      const sf = o.supplier_freight;
      if (!sf || typeof sf !== 'object') continue;
      const want = rateFor(sf.zone, sf.parcel_weight_kg, sf.delivery_type);
      const got = Number(sf.parcel_rate_incl_gst);
      if (want == null || !Number.isFinite(got)) continue;
      checked++;
      if (Math.abs(want - got) > 0.005) {
        mismatched++;
        if (examples.length < 5) examples.push(`${o.order_number}: rate card ${money(want)} vs backend ${money(got)} (${sf.zone}/${sf.delivery_type}/${sf.parcel_weight_kg}kg)`);
      }
    }
    if (!checked) {
      skip('rate-card comparison', 'no order carried a zone + weight + delivery type to price — nothing was compared');
    } else if (mismatched) {
      bad('the backend\'s parcel rate has DRIFTED from /api/settings',
        `${mismatched} of ${checked} orders disagree with the published rate card.\n  ${examples.join('\n  ')}`);
    } else {
      ok(`${checked} orders: the backend's parcel rate matches the live rate card exactly`);
    }
  }

  // ── §2 NO DOUBLE CHARGE ───────────────────────────────────────────────────
  head('§2  One parcel, one charge — shipping_absorbed must not be deducted');
  let bothCount = 0; let absorbedOnly = 0; let identical = 0; const bigger = [];
  for (const o of details) {
    const ab = o.shipping_absorbed;
    const sf = o.supplier_freight;
    const abA = !!ab && ab.applies === true && Number(ab.amount_incl_gst) > 0;
    const frA = !!sf && sf.applies === true && Number(sf.amount_incl_gst) > 0;
    if (abA && !frA) { absorbedOnly++; continue; }
    if (!abA || !frA) continue;
    bothCount++;
    const a = Number(ab.amount_incl_gst); const f = Number(sf.amount_incl_gst);
    if (Math.abs(a - f) < 0.005) identical++;
    else if (a > f + 0.005) bigger.push(`${o.order_number}: absorbed ${money(a)} EXCEEDS freight ${money(f)}`);
  }
  console.log(`  orders carrying both blocks: ${bothCount} (amounts identical on ${identical}) | absorbed-only: ${absorbedOnly}`);
  if (absorbedOnly > 0) {
    bad('shipping_absorbed applies where supplier_freight does not',
      `${absorbedOnly} order(s). The containment that justifies dropping the absorbed deduction no longer holds — `
      + 'those orders now have a real courier cost that NOTHING deducts. Re-derive before shipping.');
  } else {
    ok(`shipping_absorbed is still contained by supplier_freight (absorbed-only = 0 of ${details.length})`);
  }
  if (bigger.length) {
    bad('an absorbed amount EXCEEDS its order\'s supplier freight',
      `${bigger.length} order(s) — the subset relationship is broken:\n  ${bigger.slice(0, 5).join('\n  ')}`);
  }
  // The engine-level assertion: absorbed must move nothing.
  let absorbedMoved = 0;
  for (const o of details) {
    const ab = o.shipping_absorbed;
    if (!ab || ab.applies !== true || !(Number(ab.amount_incl_gst) > 0)) continue;
    const withIt = P.orderProfitFromDetail(o);
    const without = P.orderProfitFromDetail({ ...o, shipping_absorbed: { applies: false } });
    if (withIt.netProfit != null && without.netProfit != null
      && Math.abs(withIt.netProfit - without.netProfit) > 0.005) absorbedMoved++;
  }
  if (absorbedMoved) {
    bad('the absorbed courier still moves take-home',
      `${absorbedMoved} order(s) change when shipping_absorbed is removed. It must be labelling only.`);
  } else {
    ok('removing shipping_absorbed changes no take-home figure — it is labelling, not arithmetic');
  }

  // ── §3 THE DECISIONS ──────────────────────────────────────────────────────
  head('§3  Every live decision the shipped reader makes');
  let applied = 0; let none = 0; let ceiling = 0; let absent = 0; let incomplete = 0;
  const affected = [];
  for (const o of details) {
    const info = P.orderProfitFromDetail(o);
    if (info.supplierFreightAbsent) absent++;
    if (info.supplierFreightComplete === false) incomplete++;
    if (info.supplierFreightCeiling) {
      ceiling++;
      console.log(`  \x1b[33m?\x1b[0m ${o.order_number}  CEILING — ${info.supplierFreightCeilingReason}`);
      if (info.netProfit == null && info.state === 'ok') {
        bad(`${o.order_number}`, 'a bounded unknown blanked take-home. It must stay a stateable CEILING (ERR-158).');
      }
    }
    if (!info.supplierFreightApplies) { none++; continue; }
    applied++;
    const b = info.breakdown;
    if (!b) continue;
    console.log(`  \x1b[36m$\x1b[0m ${o.order_number}  ${info.supplierFreightSuppliers.join(', ') || '—'}  `
      + `−${money(b.supplierFreightInclGst)}  take-home ${money(b.netProfit)}  margin ${b.netMarginPct.toFixed(1)}%`);
    affected.push({ o, info });
  }
  // The signal the migration landed: the estimate count is zero BECAUSE the
  // concept no longer exists, not because the flag happens to be false.
  const estimated = 0;
  console.log(`\n  freight applied: ${applied} (${estimated} estimated) | no freight owed: ${none} | ceiling: ${ceiling}`);
  if (applied < 20) {
    soft('freight applies to fewer orders than measured',
      `${applied} of ${details.length}. Measured 2026-09-12: 139 of 150 list rows carry applies:true. `
      + 'A sharp drop means the backend stopped billing, or the reader stopped reading.');
  }

  // Three paths cannot be reached from live data. Say so BY NAME.
  if (!incomplete) {
    skip('complete:false renders a floor and an "at most" ceiling',
      `0 of ${details.length} live orders report complete:false. Covered by `
      + 'tests/supplier-freight-sep2026.test.js §3 — this run did NOT exercise it.');
  }
  if (!absent) {
    skip('a missing supplier_freight envelope renders LOUD, never $0',
      `0 of ${details.length} live orders omit the field (it is owner-only and this probe is an owner). `
      + 'Covered by tests/supplier-freight-sep2026.test.js §2 — this run did NOT exercise it.');
  }
  const multi = details.filter((o) => (o.supplier_freight?.consignments || []).length > 1).length;
  if (!multi) {
    skip('a multi-consignment order names both suppliers',
      'no order in this sample has two consignments (3 of 149 live do). Covered by the named '
      + 'TWO_SUPPLIERS fixture in tests/supplier-freight-sep2026.test.js §5.');
  } else {
    ok(`${multi} multi-consignment order(s) in the sample — the two-parcel path ran`);
  }

  // ── §4 POSITIVE CONTROL ───────────────────────────────────────────────────
  head('§4  Positive control — a deduction that never fires must go RED, not quiet');
  if (!affected.length) {
    bad('no order in the sample owes supplier freight',
      'Measured 2026-09-12: 139 of 150 live orders do. Zero means the reader has stopped reading — '
      + 'and a deduction that never fires passes every other check in this file.');
  } else {
    ok(`${affected.length} order(s) actually carry a freight deduction`);
    let footErrors = 0; let notLower = 0;
    for (const { o, info } of affected) {
      const b = info.breakdown;
      // FOUR outflows. The absorbed courier is deliberately NOT a term — adding
      // it here would hide the very double-charge this file exists to catch.
      const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
        - b.supplierFreightInclGst - b.gstRemittedToIrd;
      if (Math.abs(foot - b.netProfit) > 0.005) { footErrors++; bad(`${o.order_number} waterfall`, `${foot} vs take-home ${b.netProfit}`); }
      const without = P.orderProfitFromDetail({ ...o, supplier_freight: { applies: false } });
      if (without.netProfit != null && !(b.netProfit < without.netProfit - 0.005)) {
        notLower++;
        bad(`${o.order_number} take-home`, `${money(b.netProfit)} is not lower than the no-freight figure ${money(without.netProfit)}`);
      }
    }
    if (!footErrors) ok('every affected order foots to the cent on four outflows');
    if (!notLower) ok('every affected order nets strictly LESS than it would without the freight');
  }

  // ── §5 THE RECONCILIATION THIS MIGRATION EXISTS FOR ───────────────────────
  head('§5  Does the modal agree with the dashboard?');
  const days = 30;
  const to = new Date(); const from = new Date(Date.now() - days * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  let kpi = null;
  try {
    const r = await fetch(`${BASE}/api/admin/analytics/kpi-summary?date_from=${iso(from)}&date_to=${iso(to)}`, { headers: H });
    const j = await r.json();
    kpi = (j?.data ?? j)?.current ?? null;
  } catch (e) { soft('fetch kpi-summary', e.message); }

  if (!kpi || kpi.supplier_freight == null) {
    skip('modal-vs-dashboard reconciliation',
      'kpi-summary did not return a supplier_freight figure for the window — nothing to reconcile against');
  } else {
    const fromMs = from.getTime();
    let ourFreightExGst = 0; let counted = 0; let skippedOrders = 0;
    for (const o of details) {
      const ts = Date.parse(o.created_at || o.createdAt || '');
      if (!Number.isFinite(ts) || ts < fromMs) continue;
      const info = P.orderProfitFromDetail(o);
      if (!info.breakdown) { skippedOrders++; continue; }
      ourFreightExGst += info.breakdown.supplierFreightExGst || 0;
      counted++;
    }
    const theirs = Number(kpi.supplier_freight);
    const delta = ourFreightExGst - theirs;
    console.log(`  our ${counted} orders in-window: ${money(ourFreightExGst)} ex-GST | kpi-summary: ${money(theirs)} | Δ ${money(delta)}`);
    if (skippedOrders) {
      soft('some in-window orders could not be priced by the engine',
        `${skippedOrders} order(s) have no breakdown (missing supplier cost), so our sum is a FLOOR, not a total.`);
    }
    // The sample is capped at SAMPLE orders, so ours is a subset unless the
    // window is fully covered. Over-reporting is the failure that matters:
    // our sum must never EXCEED the backend's for the same window.
    if (delta > 0.05) {
      bad('the modal charges MORE freight than the dashboard',
        `${money(delta)} over ${counted} orders. Over-charging is the double-charge signature — `
        + 'check that shipping_absorbed has not re-entered the deduction.');
    } else if (Math.abs(delta) <= 0.05) {
      ok(`modal and dashboard agree to the cent over ${counted} orders (${money(theirs)})`);
    } else {
      soft('the modal sums LESS freight than the dashboard for the window',
        `${money(-delta)} short over ${counted} of the window's orders. Expected when the `
        + `${SAMPLE}-order sample does not cover the whole window; a growing gap is not.`);
    }
    // The tile identity, on the backend's own numbers.
    const idLhs = Number(kpi.gross_profit) - Number(kpi.net_profit);
    const idRhs = Number(kpi.stripe_fees) + Number(kpi.operating_expenses) + theirs;
    if (Number.isFinite(idLhs) && Number.isFinite(idRhs)) {
      if (Math.abs(idLhs - idRhs) <= 0.05) ok(`tile identity holds: gross − net = stripe + opex + freight (${money(idLhs)})`);
      else bad('the tile identity no longer reconciles', `gross − net = ${money(idLhs)} but stripe + opex + freight = ${money(idRhs)}`);
    }
  }

  // ── §6 THRESHOLD PROVENANCE ───────────────────────────────────────────────
  //
  // The $100 free-freight test runs on a per-supplier goods cost. We compute the
  // same quantity for the Orders-list Supplier-cost column. If the two disagree,
  // one of them is wrong and a freight decision rests on it.
  //
  // BUT A DISAGREEMENT IS NOT AUTOMATICALLY A DEFECT, AND THE FIRST RUN OF THIS
  // CHECK PROVED IT. Two of 36 consignments disagreed and NEITHER was a backend
  // bug of the kind the blunt version implied:
  //
  //   20260821000002 — backend $18.41, our column $2.63. The order has a line
  //     naming NO supplier ($15.78). Our roll-up deliberately refuses to
  //     attribute those (ERR-241); the backend attributes them through its
  //     supplier ladder. THE BACKEND IS MORE COMPLETE HERE, not wrong — so this
  //     is a note about OUR partiality, not a failure.
  //
  //   INV-3276 — backend $0.00, our column $70.51, reason `always_billed`. The
  //     goods cost is genuinely unpopulated on this invoice-shadow order, but
  //     DSNZ bills on every purchase order, so no threshold consulted it and the
  //     $7 is right anyway. Worth reporting, not worth failing.
  //
  // So the check classifies. It fails ONLY where a wrong number could have
  // changed a billing decision: a threshold-dependent reason whose goods cost we
  // can show is wrong.
  head('§6  Did the $100 test run on the number the Supplier-cost column shows?');
  const THRESHOLD_REASONS = new Set(['goods_under_free_threshold', 'goods_at_or_over_free_threshold']);
  let compared = 0; let agreed = 0;
  const decisive = []; const ourPartial = []; const backendBlank = [];
  for (const o of details) {
    const cons = o.supplier_freight?.consignments;
    if (!Array.isArray(cons) || !cons.length) continue;
    const sourcing = SRC.orderSupplierCostFromDetail(o);
    const ours = sourcing?.costBySupplier;
    if (!ours) continue;
    // Our roll-up refuses lines that name no supplier or several. When it has,
    // our figure is a KNOWN partial and cannot arbitrate against the backend's.
    const ourRollUpIsPartial = (Number(sourcing.missingSupplierCount) || 0) > 0
      || (Number(sourcing.mixedSupplierLineCount) || 0) > 0;
    for (const c of cons) {
      const theirs = Number(c?.goods_cost_ex_gst);
      const slug = SRC.supplierSlug(c?.supplier);
      let mine = null;
      for (const [name, v] of Object.entries(ours)) {
        if (SRC.supplierSlug(name) === slug) { mine = Number(v); break; }
      }
      if (mine == null || !Number.isFinite(mine)) continue;
      compared++;
      if (Number.isFinite(theirs) && Math.abs(mine - theirs) <= 0.02) { agreed++; continue; }
      const where = `${o.order_number} / ${c.supplier}: backend ${money(theirs)} vs our column ${money(mine)}`;
      const decisionRested = THRESHOLD_REASONS.has(String(c?.reason || ''));
      if (!Number.isFinite(theirs) || theirs === 0) {
        // The backend has no goods cost. Decisive only if a threshold consulted it.
        (decisionRested ? decisive : backendBlank).push(`${where} [${c?.reason}]`);
      } else if (ourRollUpIsPartial) {
        ourPartial.push(`${where} [our roll-up refuses ${sourcing.missingSupplierCount} unattributed / ${sourcing.mixedSupplierLineCount} mixed line(s)]`);
      } else if (decisionRested) {
        decisive.push(`${where} [${c?.reason}]`);
      } else {
        backendBlank.push(`${where} [${c?.reason} — no threshold consulted it]`);
      }
    }
  }
  if (!compared) {
    skip('per-consignment goods-cost reconciliation',
      'no consignment could be matched to our own costBySupplier roll-up this run');
  } else {
    ok(`${agreed} of ${compared} consignments: the backend's goods cost matches our Supplier-cost roll-up`);
    if (decisive.length) {
      bad('a FREIGHT DECISION rested on a goods cost we can show is wrong',
        `${decisive.length} consignment(s) used a threshold, and the number it tested is not the one our `
        + `column shows:\n  ${decisive.slice(0, 5).join('\n  ')}`);
    }
    if (ourPartial.length) {
      soft('our Supplier-cost column is the PARTIAL one on these orders',
        `${ourPartial.length} consignment(s). Our roll-up refuses lines that name no supplier; the backend `
        + `attributes them through its supplier ladder, so ITS figure is the more complete one. Not a defect — `
        + `but the Orders-list column is understating those orders' goods cost:\n  ${ourPartial.slice(0, 5).join('\n  ')}`);
    }
    if (backendBlank.length) {
      soft('the backend reports no goods cost for a consignment (no decision rested on it)',
        `${backendBlank.length} consignment(s). Harmless today because the supplier bills on every order either `
        + `way — but the same gap on an Augmento consignment would read as $0 < $100 and bill freight on an `
        + `order that may owe none:\n  ${backendBlank.slice(0, 5).join('\n  ')}`);
    }
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
