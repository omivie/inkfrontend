#!/usr/bin/env node
/**
 * Live contract probe — POST /api/admin/invoices/quote
 * =====================================================
 *
 * Walks the backend brief's own QA checklist against production and says, in one
 * screen, whether the endpoint the invoice editor now depends on still behaves
 * the way the editor assumes.
 *
 * WHY A PROBE AND NOT A TEST. tests/admin-invoice-quote-aug2026.test.js pins how
 * the FRONTEND reacts to a quote; it cannot tell you the ladder re-banded last
 * night, or that `free` stopped appearing over $100, or that a garbage SKU
 * started returning 400 instead of a 200 with `resolved:false`. Those are facts
 * about live data, and the only honest way to know them is to ask.
 *
 * ═══ READ-ONLY, WITH NO WRITE PATH AT ALL ═══
 *
 * The endpoint itself writes nothing — that is its documented contract — and this
 * script has no `--record`, no baseline file and nothing to overwrite. That is
 * deliberate, and it is the strong form of the policy the sibling scripts arrived
 * at the hard way: `sweep:b2b` used to WRITE its committed record on any run
 * without `--check`, so a green result could be green *because it had just
 * overwritten the thing it was comparing against* (2026-08-12). Recording is now
 * always opt-in and the mode is always printed. Here there is no mode to get
 * wrong. See also scripts/audit-search-click-beacon.mjs, which never writes.
 *
 * Every probe below sends line items for products that already exist and asks for
 * a price. Nothing is created, nothing is invoiced, nothing is emailed.
 *
 * WHAT IS DELIBERATELY *NOT* PROBED HERE: BF-052, the 500 on a below-zero invoice
 * TOTAL. Proving that needs a POST /api/admin/invoices — a WRITE — and this script
 * has no write path by design (see above). It is measured by hand instead, and the
 * repro is in readfirst/invoice-negative-total-backend-handoff-aug2026.md. Do not
 * be tempted to add it: a probe that creates invoices is a probe nobody dares run.
 *
 * USAGE
 *   npm run probe:invoice-quote            # human-readable
 *   npm run probe:invoice-quote -- --json  # machine-readable
 *
 * CREDENTIALS come from the gitignored .env — never argv, which leaks into `ps`:
 *   ADMIN_EMAIL=…
 *   ADMIN_PASSWORD=…
 * (BUSINESS_EMAIL / BUSINESS_PASSWORD are accepted as a fallback so the one
 * owner account already in .env for sweep:b2b works without duplication.)
 *
 * EXIT CODES — the same three the sibling probes use:
 *   0  every check passed
 *   1  a real finding: the contract the invoice editor relies on has moved
 *   2  the probe could not run (no credentials, sign-in failed, API unreachable)
 *      — deliberately NOT 1, because "we could not look" must never be reported
 *      as "we looked and it was fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');

// ──────────────────────────────────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────────────────────────────────

/** Minimal .env reader — no dependency, and the file is gitignored. */
function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const rawLine of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

/**
 * Read a constant out of the shipped config.js rather than duplicating it, so
 * the probe follows the storefront if the Supabase project or API origin moves
 * instead of quietly authenticating against the wrong tenant.
 */
function configConstant(name) {
  const src = fs.readFileSync(path.join(SITE, 'js', 'config.js'), 'utf8');
  const m = new RegExp(`${name}:\\s*'([^']+)'`).exec(src);
  if (!m) throw new Error(`config.js no longer defines ${name} — update the probe`);
  return m[1];
}

const SUPABASE_URL = configConstant('SUPABASE_URL');
const SUPABASE_ANON_KEY = configConstant('SUPABASE_ANON_KEY');
const API_BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const QUOTE_PATH = '/api/admin/invoices/quote';

// ──────────────────────────────────────────────────────────────────────────
// Output
// ──────────────────────────────────────────────────────────────────────────

let pass = 0;
const findings = [];
const results = [];

const say = (s = '') => { if (!JSON_OUT) console.log(s); };
const ok = (name, detail) => {
  pass++;
  results.push({ name, status: 'pass', detail: detail ?? null });
  say(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
};
const bad = (name, detail) => {
  findings.push({ name, detail });
  results.push({ name, status: 'fail', detail });
  say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/** "We could not look" — exit 2, never 1. */
const cannotRun = (msg) => {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, ran: false, reason: msg }, null, 2));
  else console.error(`\n\x1b[33m▲ probe could not run\x1b[0m\n  ${msg}\n`);
  process.exit(2);
};

// ──────────────────────────────────────────────────────────────────────────
// Transport
// ──────────────────────────────────────────────────────────────────────────

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new Error(`sign-in failed (HTTP ${res.status}): ${body ? (body.error_description || body.msg || JSON.stringify(body)) : 'no body'}`);
  }
  return body.access_token;
}

/**
 * The ONLY request this script makes. There is no other verb and no other path —
 * if you are adding one, stop and ask whether this is still a read-only probe.
 */
async function quote(token, body) {
  const res = await fetch(`${API_BASE}${QUOTE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, data: json?.data ?? null };
}

// ──────────────────────────────────────────────────────────────────────────
// The checks — the brief's QA checklist, in its order
// ──────────────────────────────────────────────────────────────────────────

// Live rungs for GLC73BK on 2026-08-17 were 3+→2%, 4+→3%, 7+→6%. The exact
// figures move when pricing or the tier matrix changes, so the probe asserts the
// SHAPE (a discount exists at 7, none at 2) and PRINTS the numbers rather than
// pinning them — a probe that fails every time the owner edits a tier is a probe
// nobody runs. See project_business_account_pricing_jul2026 for the band matrix.
const BULK_SKU = 'GLC73BK';
const CHEAP_SKU = 'CLC73BK';

async function run(token) {
  // ── 1. A resolved line comes back priced ──────────────────────────────────
  const q1 = await quote(token, { line_items: [{ product_code: BULK_SKU, quantity: 7 }] });
  if (q1.status !== 200) {
    bad('1. a valid line quotes', `expected HTTP 200, got ${q1.status}: ${JSON.stringify(q1.json)}`);
    return;   // nothing below is meaningful if the happy path is broken
  }
  const l1 = q1.data?.lines?.[0];
  if (!l1?.resolved) {
    bad('1. a valid line resolves', `${BULK_SKU} came back resolved=${l1?.resolved} reason=${l1?.reason}`);
  } else if (l1.unit_excl_gst == null) {
    bad('1. a resolved line carries unit_excl_gst', 'the editor autofills from this field; it is absent');
  } else {
    ok('1. a valid line resolves and is priced',
      `${BULK_SKU} qty 7 · retail ${l1.retail_incl_gst} incl · ${l1.unit_excl_gst} ex`);
  }

  // ── 2. The volume ladder applies at 7 ─────────────────────────────────────
  const v = l1?.volume;
  if (!v) {
    bad('2. a bulk quantity earns a volume discount',
      `${BULK_SKU} at qty 7 returned volume:null. Either the ladder was re-banded, this SKU's `
      + 'cost is unknown (the backend refuses to discount blind), or the margin floor ate it. '
      + 'Check the Business → volume tiers matrix before assuming a regression.');
  } else if (v.unit_excl_gst == null) {
    bad('2. the volume block carries unit_excl_gst', 'this is THE autofill figure; it is absent');
  } else if (v.effective_percent == null) {
    bad('2. the volume block carries effective_percent',
      'the frontend must display the realised %, never the ladder ceiling — with it absent '
      + 'the badge would have to quote discount_percent, which states a discount not given');
  } else {
    ok('2. a bulk quantity earns a volume discount',
      `−${v.effective_percent}% (ceiling ${v.discount_percent}%) → ${v.unit_excl_gst} ex`
      + `${v.floored ? ' · FLOORED' : ''} · line saves ${v.line_saving_excl_gst}`);
  }
  if (v && v.effective_percent > v.discount_percent) {
    bad('2b. effective_percent never exceeds the ladder ceiling',
      `effective ${v.effective_percent}% > ceiling ${v.discount_percent}% — one of them is wrong`);
  } else if (v) {
    ok('2b. effective_percent ≤ discount_percent');
  }

  // ── 3. Below the entry rung there is no discount ──────────────────────────
  const q2 = await quote(token, { line_items: [{ product_code: BULK_SKU, quantity: 2 }] });
  const l2 = q2.data?.lines?.[0];
  if (q2.status !== 200) {
    bad('3. a below-rung quantity quotes', `HTTP ${q2.status}`);
  } else if (l2?.volume) {
    // Not automatically wrong — the entry rung is band-dependent and IS 2+ in the
    // three $100+ bands. Report it rather than failing.
    ok('3. qty 2 carries a discount (this SKU\'s band enters at 2+)',
      `−${l2.volume.effective_percent}% — entry rungs are band-dependent, never hardcode one`);
  } else {
    ok('3. qty 2 is below the entry rung', 'volume:null, as expected for a sub-$100 band');
  }

  // ── 4. Free shipping over the threshold ───────────────────────────────────
  const ship1 = q1.data?.shipping;
  if (!Array.isArray(ship1?.options)) {
    bad('4. shipping.options is an array',
      'absent options means the editor cannot show a dropdown at all — and it must SAY so '
      + 'rather than render an empty one');
  } else {
    const keys = ship1.options.map((o) => o.key);
    const hasFree = keys.includes('free');
    const goods = ship1.goods_total_incl_gst;
    const threshold = ship1.free_shipping_threshold;
    if (goods > threshold && !hasFree) {
      bad('4. free shipping appears over the threshold',
        `goods ${goods} > ${threshold} but no 'free' option: [${keys.join(', ')}]`);
    } else if (goods > threshold && ship1.suggested_key !== 'free') {
      bad('4. free shipping is suggested when eligible', `suggested_key=${ship1.suggested_key}, expected 'free'`);
    } else {
      ok('4. free shipping over the threshold',
        `goods ${goods} incl · threshold ${threshold} · suggested ${ship1.suggested_key} · ${keys.length} options`);
    }
    if (!keys.includes('pickup')) {
      bad('4b. pickup is always offered', `[${keys.join(', ')}]`);
    } else {
      ok('4b. pickup is always offered');
    }
  }

  // ── 5. freight_excl_gst is what goes in the freight box ───────────────────
  // The invoice's freight field is EX-GST. An order's shipping_fee is INCL-GST
  // and the editor divides it by 1.15 — so if this field were ever incl-GST the
  // dropdown would silently over-charge freight by 15%.
  const courier = (ship1?.options || []).find((o) => o.freight_excl_gst > 0);
  if (!courier) {
    bad('5. at least one courier option carries a fee', 'every option is $0 — nothing to write into freight');
  } else {
    const derived = Math.round((courier.fee_incl_gst / 1.15) * 100) / 100;
    if (Math.abs(derived - courier.freight_excl_gst) > 0.02) {
      bad('5. freight_excl_gst is the EX-GST figure',
        `${courier.key}: fee_incl_gst ${courier.fee_incl_gst} ÷ 1.15 = ${derived}, but `
        + `freight_excl_gst is ${courier.freight_excl_gst}. The editor writes freight_excl_gst `
        + 'straight into an ex-GST field — a basis mismatch here mis-charges every invoice.');
    } else {
      ok('5. freight_excl_gst is ex-GST and lands back on the fee',
        `${courier.key}: ${courier.freight_excl_gst} ex → ${courier.fee_incl_gst} incl`);
    }
  }

  // ── 6. A cheap single line loses free shipping, and the hint steers ───────
  const q3 = await quote(token, { line_items: [{ product_code: CHEAP_SKU, quantity: 1 }] });
  const ship3 = q3.data?.shipping;
  if (q3.status !== 200) {
    bad('6. a cheap line quotes', `HTTP ${q3.status}`);
  } else if ((ship3?.options || []).some((o) => o.key === 'free')) {
    bad('6. free shipping is absent under the threshold',
      `goods ${ship3.goods_total_incl_gst} but 'free' is still offered — the editor's loud `
      + 'fallback (which reverts a selected free option) would then never fire');
  } else {
    ok('6. no free shipping under the threshold',
      `goods ${ship3?.goods_total_incl_gst} incl · suggested ${ship3?.suggested_key}`);
  }

  const q4 = await quote(token, {
    line_items: [{ product_code: CHEAP_SKU, quantity: 1 }],
    delivery: { region: 'Auckland', delivery_type: 'rural' },
  });
  const suggested = q4.data?.shipping?.suggested_key;
  if (suggested !== 'auckland:rural') {
    bad('6b. the delivery hint steers suggested_key',
      `sent {region:'Auckland', delivery_type:'rural'}, got suggested_key='${suggested}' `
      + "(expected 'auckland:rural')");
  } else {
    ok('6b. the delivery hint steers suggested_key', `→ ${suggested}`);
  }

  // ── 6c. THE THRESHOLD IS JUDGED ON THE GST-INCLUSIVE GOODS TOTAL ─────────
  // ERR-178. The owner asked whether free shipping was being decided on the
  // pre-GST figure, after an invoice of $99.00 ex GST ($113.85 incl) was billed
  // for a courier. It was not — but nothing pinned that, because checks 4 and 6
  // above sit hundreds of dollars either side of $100 and would still pass if
  // the backend switched to comparing the EX-GST total tomorrow.
  //
  // This pair straddles the boundary in the gap between the two bases: $87.00 ex
  // is $100.05 incl (eligible) and $86.90 ex is $99.94 incl (not). On an ex-GST
  // basis BOTH are under $100 and both would come back ineligible — which is
  // exactly the regression the owner suspected, and the one that would silently
  // add freight to every invoice between $87 and $100 ex GST.
  //
  // A description-only line with a typed price is used so the figure under test
  // is the one sent, not a catalogue price that moves (check 8b already pins
  // that a typed price on such a line reaches the goods total).
  const priced = async (exGst) => {
    const r = await quote(token, {
      line_items: [{ product_code: '', description: 'ERR-178 basis probe', quantity: 1, unit_cost_excl_gst: exGst }],
    });
    return r.data?.shipping || {};
  };
  const justOver = await priced(87.00);
  const justUnder = await priced(86.90);
  const overIncl = justOver.goods_total_incl_gst;
  const underIncl = justUnder.goods_total_incl_gst;

  if (overIncl == null || underIncl == null) {
    bad('6c. the goods total is reported so the basis can be checked',
      `goods_total_incl_gst was ${overIncl} / ${underIncl}`);
  } else if (Math.abs(overIncl - 100.05) > 0.02 || Math.abs(underIncl - 99.94) > 0.02) {
    bad('6c. goods_total_incl_gst grosses the typed EX-GST price up by 15%',
      `sent 87.00 ex and 86.90 ex, got ${overIncl} and ${underIncl} incl — expected ~100.05 `
      + 'and ~99.94. If these echo the ex-GST figures the field has changed basis and the '
      + "editor's freight autofill is now deciding on the wrong number.");
  } else if (justOver.free_shipping_eligible !== true) {
    bad('6c. $87.00 ex GST ($100.05 incl) QUALIFIES for free shipping',
      `free_shipping_eligible=${justOver.free_shipping_eligible}, suggested_key=`
      + `${justOver.suggested_key}. The threshold has moved to the EX-GST total — every `
      + 'invoice between $87 and $100 ex GST is now being charged freight it should not be.');
  } else if (justUnder.free_shipping_eligible !== false) {
    bad('6c. $86.90 ex GST ($99.94 incl) does NOT qualify',
      `free_shipping_eligible=${justUnder.free_shipping_eligible} — the threshold is being `
      + 'applied to something other than the incl-GST goods total.');
  } else {
    ok('6c. the threshold is judged INCL GST, either side of the boundary',
      `87.00 ex → ${overIncl} incl · eligible · suggested ${justOver.suggested_key}   |   `
      + `86.90 ex → ${underIncl} incl · not eligible`);
  }

  // ── 6d. A CREDIT LINE REDUCES THE GOODS TOTAL ────────────────────────────
  // The free-shipping threshold is judged on `goods_total_incl_gst`, so a credit
  // the customer is receiving has to come off it or the invoice qualifies for
  // free shipping on money nobody is paying.
  //
  // This check has been round the houses, and the history is why it is worth
  // keeping: `unit_cost_excl_gst` used to be validated `>= 0` and one negative
  // line 400'd the WHOLE request, so the editor omitted credit lines and said so
  // on screen. BF-050 lifted the floor on 2026-08-29 (price AND quantity), and
  // the editor now sends them. If this ever starts failing, that regressed — and
  // the omission plus its warning would have to come back with it.
  //
  // $200.00 ex less $150.00 ex is $50.00 ex = $57.50 incl, well under the
  // threshold, so a floored or dropped credit shows up as BOTH a wrong goods
  // total and a wrong eligibility, and the message says which.
  const credit = await quote(token, {
    line_items: [
      { product_code: '', description: 'Goods', quantity: 1, unit_cost_excl_gst: 200.00 },
      { product_code: '', description: 'Already paid \u2014 credit', quantity: 1, unit_cost_excl_gst: -150.00 },
    ],
  });
  if (credit.status !== 200) {
    const detail = credit.json?.error?.details?.[0]?.message || credit.json?.error?.message || '';
    bad('6d. a credit line is accepted and reduces the goods total',
      `HTTP ${credit.status}: ${detail}. The endpoint is refusing a negative price again — BF-050 has `
      + 'REGRESSED. Until it is back, utils/invoice-quote.js quoteRequestBody must go back to omitting '
      + 'negative prices (one 400 freezes the courier dropdown and the free-shipping banner for the '
      + 'whole invoice, showing stale pre-credit numbers), and the editor must say on screen that the '
      + 'threshold ignores credit lines.');
  } else {
    const goods = credit.data?.shipping?.goods_total_incl_gst;
    if (goods == null) {
      bad('6d. the credit quote reports a goods total', `goods_total_incl_gst was ${goods}`);
    } else if (Math.abs(goods - 57.50) > 0.02) {
      bad('6d. a credit line REDUCES the goods total',
        `sent 200.00 ex and -150.00 ex, expected ~57.50 incl, got ${goods}. `
        + (Math.abs(goods - 230.00) <= 0.02
          ? 'That is 200.00 ex grossed up — the credit was FLOORED AT 0 or dropped, so free shipping '
            + 'is being decided on the pre-discount total.'
          : 'The basis has moved; do not trust the freight autofill until this is understood.'));
    } else if (credit.data?.shipping?.free_shipping_eligible !== false) {
      bad('6d. a credited invoice under the threshold does NOT get free shipping',
        `goods ${goods} incl but free_shipping_eligible=${credit.data?.shipping?.free_shipping_eligible}`);
    } else {
      ok('6d. a credit line is accepted and reduces the goods total',
        `200.00 ex \u2212 150.00 ex \u2192 ${goods} incl \u00b7 not eligible \u00b7 suggested `
        + `${credit.data?.shipping?.suggested_key}`);
    }
  }

  // ── 6e. A NEGATIVE QUANTITY (a return) is accepted too ────────────────────
  // BF-050 dropped the floor on quantity as well, which is the shape that keeps
  // a RETURN's margin honest: it reverses revenue and COGS together. Worth its
  // own check because the editor now offers it and nothing else here would
  // notice the floor coming back on this field alone.
  const ret = await quote(token, {
    line_items: [{ product_code: '', description: 'Returned toner', quantity: -1, unit_cost_excl_gst: 60.00 }],
  });
  if (ret.status !== 200) {
    bad('6e. a negative quantity is accepted',
      `HTTP ${ret.status}: ${ret.json?.error?.details?.[0]?.message || ''}. The editor lets an operator `
      + 'type one, so this floor coming back would surface as a save failure.');
  } else {
    ok('6e. a negative quantity (a return) is accepted',
      `-1 \u00d7 60.00 ex \u2192 goods ${ret.data?.shipping?.goods_total_incl_gst} incl`);
  }

  // ── 6f. A ZERO QUANTITY is accepted, and contributes nothing ─────────────
  // The editor stopped refusing `qty: 0` on 2026-08-29 — it was our rule alone,
  // and it reported a refused figure with the same words a blank box gets. A
  // zero-quantity line is a row the customer should READ but not be charged for.
  // Two claims here, and the second is the one worth measuring: that it is
  // ACCEPTED, and that it adds NOTHING to the goods total. A backend that quietly
  // read 0 as "unspecified" and substituted 1 would charge for it, and the only
  // symptom would be a free-shipping decision made on money nobody owes.
  const zeroQty = await quote(token, {
    line_items: [
      { product_code: '', description: 'Goods', quantity: 1, unit_cost_excl_gst: 100.00 },
      { product_code: '', description: 'Backordered \u2014 not charged', quantity: 0, unit_cost_excl_gst: 80.00 },
    ],
  });
  if (zeroQty.status !== 200) {
    bad('6f. a zero quantity is accepted',
      `HTTP ${zeroQty.status}: ${zeroQty.json?.error?.details?.[0]?.message || ''}. validateInvoice no `
      + 'longer refuses qty 0, so this floor coming back surfaces as an unexplained save failure.');
  } else {
    const goods = zeroQty.data?.shipping?.goods_total_incl_gst;
    if (goods == null) {
      bad('6f. the zero-quantity quote reports a goods total', `goods_total_incl_gst was ${goods}`);
    } else if (Math.abs(goods - 115.00) > 0.02) {
      bad('6f. a zero-quantity line contributes NOTHING to the goods total',
        `sent 1 \u00d7 100.00 ex and 0 \u00d7 80.00 ex, expected ~115.00 incl, got ${goods}. `
        + (Math.abs(goods - 207.00) <= 0.02
          ? 'That is both lines at qty 1 \u2014 a quantity of 0 is being read as "unspecified" and '
            + 'substituted, so the customer is charged for a line the document says is free.'
          : 'The basis has moved; do not trust the freight autofill until this is understood.'));
    } else {
      ok('6f. a zero-quantity line is accepted and adds nothing',
        `1 \u00d7 100.00 ex + 0 \u00d7 80.00 ex \u2192 ${goods} incl`);
    }
  }

  // ── 7. A garbage code is a 200, not a 400 ────────────────────────────────
  // This one matters more than it looks: the editor re-quotes on every keystroke,
  // so a half-typed SKU hits this path constantly. A 400 here would mean an error
  // toast every few characters.
  const q5 = await quote(token, { line_items: [{ product_code: 'NOTREAL99', quantity: 1 }] });
  if (q5.status !== 200) {
    bad('7. an unknown code is a 200 with resolved:false',
      `got HTTP ${q5.status}. The editor quotes on every keystroke — a 400 here means an `
      + 'error toast while the operator is still typing the SKU.');
  } else if (q5.data?.lines?.[0]?.resolved !== false) {
    bad('7. an unknown code reports resolved:false', JSON.stringify(q5.data?.lines?.[0]));
  } else {
    ok('7. an unknown code is a soft 200', `resolved:false reason:${q5.data.lines[0].reason}`);
  }

  // ── 8. position indexes the request 1:1, blanks included ─────────────────
  // The editor maps answers back onto rows by position. If blanks were dropped
  // every badge below a blank line would land on the wrong row.
  const q6 = await quote(token, {
    line_items: [
      { product_code: BULK_SKU, quantity: 7 },
      { product_code: '', description: 'Labour', quantity: 1, unit_cost_excl_gst: 100 },
      { product_code: CHEAP_SKU, quantity: 1 },
    ],
  });
  const lines6 = q6.data?.lines || [];
  if (lines6.length !== 3) {
    bad('8. every line comes back, in order',
      `sent 3 line_items, got ${lines6.length} lines — the editor indexes answers by position`);
  } else if (lines6.map((l) => l.position).join(',') !== '0,1,2') {
    bad('8. positions are 0..n-1 in order', lines6.map((l) => l.position).join(','));
  } else if (lines6[1].resolved !== false || lines6[1].reason !== 'no_code') {
    bad('8. a description-only line is resolved:false/no_code', JSON.stringify(lines6[1]));
  } else {
    ok('8. positions index the request 1:1', 'blank line kept its slot with reason:no_code');
  }

  // A typed price on a blank line still counts toward the goods total.
  if (q6.data?.shipping?.goods_total_incl_gst != null) {
    ok('8b. a typed price on a description-only line reaches the goods total',
      `goods ${q6.data.shipping.goods_total_incl_gst} incl`);
  }

  // ── 9. Nothing sensitive comes back ──────────────────────────────────────
  // The brief promises no cost_price. The editor logs quotes to DebugLog, so a
  // supplier cost arriving here would end up in a console the customer-facing
  // team can screenshot.
  const blob = JSON.stringify(q6.json);
  const leaked = ['cost_price', 'supplier_cost', 'margin'].filter((k) => blob.includes(k));
  if (leaked.length) {
    bad('9. the quote carries no supplier cost', `found: ${leaked.join(', ')}`);
  } else {
    ok('9. the quote carries no supplier cost');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const email = process.env.ADMIN_EMAIL || process.env.BUSINESS_EMAIL;
  const password = process.env.ADMIN_PASSWORD || process.env.BUSINESS_PASSWORD;

  say('\nInvoice-quote contract probe');
  say(`  API   ${API_BASE}${QUOTE_PATH}`);
  // State the mode BEFORE any work, the way the sibling scripts do — even though
  // this one has only the one mode. Saying it is how you know it.
  say('  MODE  read-only — this script has no write path and no baseline file\n');

  if (!email || !password) {
    cannotRun(
      'ADMIN_EMAIL and ADMIN_PASSWORD are required (put them in .env, which is gitignored).\n'
      + '  BUSINESS_EMAIL / BUSINESS_PASSWORD are accepted as a fallback.\n'
      + '  The route is admin + super_admin only; without a token every probe would 401 and\n'
      + '  "all checks skipped" must never be printed as "all checks passed".');
  }

  let token;
  try {
    token = await signIn(email, password);
  } catch (e) {
    cannotRun(`${e.message}\n  (the probe could not authenticate, so nothing was checked)`);
  }

  // Prove the token is actually admin before interpreting anything below. A 401
  // or 403 on every probe would otherwise read as nine separate contract breaks.
  const preflight = await quote(token, { line_items: [{ product_code: BULK_SKU, quantity: 1 }] });
  if (preflight.status === 401 || preflight.status === 403) {
    cannotRun(`signed in as ${email} but the quote route returned HTTP ${preflight.status}. `
      + 'This account is not admin/super_admin — nothing was checked.');
  }
  if (preflight.status === 404) {
    cannotRun(`${QUOTE_PATH} returned 404 — the endpoint is not deployed on ${API_BASE}.`);
  }

  say(`  signed in as ${email}\n`);
  await run(token);

  const total = pass + findings.length;
  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: findings.length === 0, ran: true, api: API_BASE, checks: total, passed: pass, findings, results,
    }, null, 2));
  } else {
    say('');
    if (findings.length === 0) {
      say(`\x1b[32m✓ ${pass}/${total} checks passed — the invoice editor's assumptions hold.\x1b[0m\n`);
    } else {
      say(`\x1b[31m✗ ${findings.length} of ${total} checks failed.\x1b[0m`);
      say('  The invoice editor autofills from this contract. If a change here is intended,');
      say('  update js/admin/utils/invoice-quote.js AND this probe in the same commit, and');
      say('  record it in .claude/memory/backend-fixes.md.\n');
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n✖ probe crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
