/**
 * The Stripe-basis divergence is DISCLOSED, on both screens (ERR-255)
 * ===================================================================
 *
 * ERR-255 made the order modal and the Dashboard agree about supplier freight.
 * They still disagree about the Stripe fee, and that disagreement is deliberate:
 *
 *   modal     deducts Stripe's published 2.65% + $0.30 as the EX-GST fee, the
 *             convention the owner set on 2026-05-17 (profitability.js:4-14)
 *   backend   divides the same figure by 1.15, treating it as GST-INCLUSIVE
 *
 * Measured over the live 30 days to 2026-09-15: the modal's convention sums to
 * $169.90 where kpi-summary reports $147.74, and 169.90 / 1.15 = 147.74 to the
 * cent. So the reconciliation is exact — and it establishes only WHAT THE
 * BACKEND DOES, never what Stripe charges. That is a fact about a Stripe
 * invoice, so the owner declined the change pending a real payout line.
 *
 * ***A KNOWN DIFFERENCE BETWEEN TWO MONEY SCREENS IS ONLY DEFENSIBLE WHILE IT
 * IS ON THE SCREEN.*** An operator comparing a modal take-home against the Net
 * Profit tile sees roughly $0.47 per card order of unexplained gap, and
 * unexplained gaps between money screens are what the rest of ERR-255 was spent
 * removing. These tests pin the disclosure, on both sides of it.
 *
 * They do NOT pin the arithmetic — deliberately. If the payout answer arrives
 * and the convention changes, the numbers move and these tests should still
 * pass, because what they protect is that the difference is NAMED, not that it
 * has a particular size.
 *
 * Run with: node --test tests/stripe-basis-disclosure-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ORDERS_PATH = path.join(ROOT, 'inkcartridges/js/admin/pages/orders.js');
const PROF_PATH = path.join(ROOT, 'inkcartridges/js/admin/utils/profitability.js');
const DASH_PATH = path.join(ROOT, 'inkcartridges/js/admin/pages/dashboard.js');

const ordersSrc = fs.readFileSync(ORDERS_PATH, 'utf8');
const dashSrc = fs.readFileSync(DASH_PATH, 'utf8');

function stripEsm(src) {
  const exposed = new Set();
  const stripped = src.replace(
    /export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; }
  );
  return stripped + '\n;' + [...exposed]
    .map((id) => `try { globalThis.${id} = ${id}; } catch(_) {}`)
    .join('\n');
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(PROF_PATH, 'utf8')), sandbox, { filename: 'profitability.js' });
const { computeProfitBreakdown, GST_RATE } = sandbox;

/**
 * Execute the SHIPPED card-fee block rather than grepping it.
 *
 * Same machinery as the freight row's tests: a grep proves the characters are
 * present, not that the row renders them. This lifts the real
 * `if (isInvoiceOrder(o)) { … } else { … }` out of pages/orders.js and runs it
 * with the helpers it actually closes over. Brace-matching has to walk TWO
 * blocks here — the if and the else — or the extract stops halfway and the
 * else-branch silently never gets tested.
 */
function renderCardFeeRow(breakdown, { isInvoice }) {
  const start = ordersSrc.indexOf('if (isInvoiceOrder(o)) {');
  assert.ok(start > -1, 'the card-fee block must exist to be executed');
  const walk = (from) => {
    let depth = 0;
    for (let i = ordersSrc.indexOf('{', from); i < ordersSrc.length; i++) {
      if (ordersSrc[i] === '{') depth++;
      else if (ordersSrc[i] === '}') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  const ifEnd = walk(start);
  assert.ok(ifEnd > start, 'the if-block must be brace-balanced');
  const after = ordersSrc.slice(ifEnd, ifEnd + 20);
  assert.match(after, /^\s*else\s*\{/, 'the else-branch must follow, or only half the block is under test');
  const end = walk(ifEnd);
  assert.ok(end > ifEnd, 'the else-block must be brace-balanced');
  const block = ordersSrc.slice(start, end);

  const fn = new Function(
    'b', 'o', 'isInvoiceOrder', 'formatPrice', 'esc', 'muted', 'pbRow', 'neg', 'GST_RATE', `
    let profitBreakdownInner = '';
    ${block}
    return profitBreakdownInner;
  `);
  return fn(
    breakdown,
    {},
    () => isInvoice,
    (v) => `$${Number(v).toFixed(2)}`,
    (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c])),
    (t) => `<span class="admin-text-muted">${t}</span>`,
    (label, value) => `<div class="om-meta-row"><span>${label}</span><span class="mono">${value}</span></div>`,
    (v) => `−$${Math.abs(v).toFixed(2)}`,
    GST_RATE,
  );
}

// The live worked example: 2026090902, a $134.49 charge.
const CARD = computeProfitBreakdown(116.95, 76.00, {
  customerPaidInclGst: 134.49,
  supplierFreight: { applies: true, amount_incl_gst: 14, gst_component: 1.83, complete: true },
});
// An invoiced sale settles by bank transfer — NO_PAYMENT_FEES zeroes the card fee.
const INVOICED = computeProfitBreakdown(116.95, 76.00, {
  customerPaidInclGst: 134.49, stripeRate: 0, stripeFixed: 0,
  supplierFreight: { applies: true, amount_incl_gst: 14, gst_component: 1.83, complete: true },
});

// ───────────────────────────────────────────────────────────────────────────
// §1  The card row discloses the divergence
// ───────────────────────────────────────────────────────────────────────────

test('the Stripe row renders, with the fee as a negative outflow', () => {
  const html = renderCardFeeRow(CARD, { isInvoice: false });
  assert.match(html, /Paid to Stripe/);
  assert.match(html, /−\$/, 'the fee must render as an outflow');
});

test('🚨 the Stripe row carries a tooltip that NAMES the disagreement', () => {
  // The whole point. Before this, "Paid to Stripe" was the only row in the
  // waterfall with no tooltip at all, while seven of its neighbours had one —
  // and the one row that needed an explanation was the one without.
  const html = renderCardFeeRow(CARD, { isInvoice: false });
  assert.match(html, /<span title="/, 'the row must carry a title attribute');
  assert.match(html, /KNOWN DIFFERENCE/, 'the divergence must be named, not merely implied');
  assert.match(html, /Dashboard/i, 'it must say WHICH other screen disagrees');
  assert.match(html, /1\.15/, 'it must say HOW the other screen differs');
  assert.match(html, /ⓘ/, 'the ⓘ affordance tells the operator a tooltip exists');
});

test('it states the per-order size of the difference, not just that one exists', () => {
  // "These two screens differ" is not actionable. "They differ by $0.50 on THIS
  // order" is. The delta is fee − fee/1.15, which on the live 2026090902 example
  // is ~$0.50 — and it does not shrink with order size, so it is worth a number.
  const html = renderCardFeeRow(CARD, { isInvoice: false });
  const expected = CARD.stripeFeeExGst - CARD.stripeFeeExGst / (1 + GST_RATE);
  assert.ok(expected > 0.4 && expected < 0.6, `sanity: expected ~$0.50, got ${expected}`);
  assert.match(html, new RegExp(`\\$${expected.toFixed(2)}`),
    `the tooltip must quote the actual delta ($${expected.toFixed(2)})`);
});

test('it names the check that settles it, in terms someone can act on', () => {
  // A disclosure that does not say how to resolve it becomes folklore. The
  // settling evidence is one line on a real payout, and the tooltip quotes both
  // candidate figures so the reader can just look.
  const html = renderCardFeeRow(CARD, { isInvoice: false });
  assert.match(html, /payout/i, 'it must name the evidence that settles it');
  const ours = CARD.stripeFeeExGst;
  const theirs = CARD.stripeFeeExGst / (1 + GST_RATE);
  assert.match(html, new RegExp(`\\$${ours.toFixed(2)}`), 'our figure must be quoted');
  assert.match(html, new RegExp(`\\$${theirs.toFixed(2)}`), "the backend's figure must be quoted");
});

test('the tooltip is escaped, like every other dynamic title in this file', () => {
  const html = renderCardFeeRow(CARD, { isInvoice: false });
  const title = html.match(/title="([^"]*)"/);
  assert.ok(title, 'a title must be present to check');
  assert.ok(!/[<>]/.test(title[1]), 'no raw angle brackets may survive into the attribute');
});

// ───────────────────────────────────────────────────────────────────────────
// §2  Negative control — an invoiced sale has no divergence to disclose
// ───────────────────────────────────────────────────────────────────────────

test('🚨 an invoiced sale gets NO divergence note — there is no card fee to disagree about', () => {
  // The control that proves §1 is exercising the card branch rather than the
  // template. An invoiced order settles by bank transfer, so both screens deduct
  // exactly $0 and agree perfectly. Warning about a difference that cannot exist
  // would be noise on the majority-correct path.
  const html = renderCardFeeRow(INVOICED, { isInvoice: true });
  assert.match(html, /bank transfer/i, 'the invoiced branch must render its own row');
  assert.ok(!/KNOWN DIFFERENCE/.test(html), 'no divergence note on a sale that never touched Stripe');
  assert.ok(!/1\.15/.test(html), 'and no basis explanation either');
});

test('the two branches are genuinely different renders', () => {
  const card = renderCardFeeRow(CARD, { isInvoice: false });
  const inv = renderCardFeeRow(INVOICED, { isInvoice: true });
  assert.notEqual(card, inv, 'if these matched, the guard would not be under test');
});

// ───────────────────────────────────────────────────────────────────────────
// §3  The Dashboard names it too — both sides, or whoever starts from the
//     other screen re-derives it
// ───────────────────────────────────────────────────────────────────────────

test('🚨 the Net Profit tile tooltip names the same divergence', () => {
  const start = dashSrc.indexOf('Gross profit − Stripe fees');
  assert.ok(start > -1, 'the Net Profit tile tooltip must exist');
  const tip = dashSrc.slice(start, start + 800);
  assert.match(tip, /KNOWN DIFFERENCE/, 'the tile must name the divergence');
  assert.match(tip, /1\.15/, 'and say that this side divides by 1.15');
  assert.match(tip, /modal/i, 'and say which other screen it differs from');
});

test('neither screen claims the other is wrong', () => {
  // Both conventions are defensible until the payout is read. A tooltip that
  // said "the Dashboard is wrong" would be asserting the very thing the owner
  // declined to decide.
  const modal = renderCardFeeRow(CARD, { isInvoice: false });
  const start = dashSrc.indexOf('Gross profit − Stripe fees');
  const tile = dashSrc.slice(start, start + 800);
  for (const [name, text] of [['modal', modal], ['tile', tile]]) {
    assert.ok(!/\b(incorrect|wrong|bug|error)\b/i.test(text),
      `${name} tooltip must not adjudicate a question the owner left open`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// §4  The arithmetic is UNCHANGED — this commit disclosed, it did not decide
// ───────────────────────────────────────────────────────────────────────────

test('🚨 profitability.js still deducts the published fee as-is', () => {
  // The owner declined the ÷1.15 on 2026-09-10 pending a real payout. If this
  // test goes red because the convention changed, that is fine — but it must be
  // a deliberate decision with the payout in hand, not a drive-by alignment.
  const fee = 134.49 * 0.0265 + 0.30;
  assert.ok(Math.abs(CARD.stripeFeeExGst - fee) < 0.005,
    `expected the published fee ${fee.toFixed(4)}, got ${CARD.stripeFeeExGst}`);
  assert.ok(Math.abs(CARD.stripeFeeExGst - fee / 1.15) > 0.4,
    'the fee must NOT have been divided by 1.15 — that is the change the owner declined');
});

test('take-home on the live worked example is unmoved by the disclosure', () => {
  // 2026090902: $24.92 at 21.3%, the ERR-255 acceptance figure. A tooltip must
  // not move a number.
  assert.ok(Math.abs(CARD.netProfit - 24.92) < 0.02, `expected $24.92, got ${CARD.netProfit}`);
  assert.ok(Math.abs(CARD.netMarginPct - 21.3) < 0.1, `expected 21.3%, got ${CARD.netMarginPct}`);
});
