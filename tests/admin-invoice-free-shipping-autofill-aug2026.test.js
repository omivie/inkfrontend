/**
 * Free shipping on an invoice that qualified after the freight was already set
 * ===========================================================================
 *
 * ERR-178. The owner raised a test invoice: one line at $99.00 ex GST, freight
 * $6.09, total $120.85 — an order that qualifies for free shipping ($99.00 ex is
 * $113.85 incl, over the $100 threshold) still billed for a courier. Their
 * reading was that the threshold was being applied to the pre-GST figure.
 *
 * It is not, and that matters for what this file pins. The threshold comparison
 * is the BACKEND's, on `goods_total_incl_gst`, and it was correct — measured
 * live: $99.00 ex → 113.85 incl → eligible, suggested `free`; $86.90 ex → 99.94
 * incl → not eligible. The frontend performs no comparison at all. The green
 * "qualifies for free shipping" badge in the owner's screenshot was the CORRECT
 * answer sitting next to the WRONG freight.
 *
 * The defect was WHEN freight is decided and WHOSE decision it is recorded as.
 * A quote fires on a line's code or description ALONE (`hasContent` is not about
 * price) behind a 400ms debounce, so the first quote of a session routinely
 * lands with a goods total of $0 — typing `99` passes through `9`, and an
 * unrecognised code like `lc` never resolves a price at all. At $0 the backend
 * correctly suggests a courier zone; reconcileShipping adopted it and wrote
 * `_freightChoice = suggested.key`, the field that means "the operator picked
 * this". Every later quote then skipped the adopt branch, so crossing $100 could
 * only ever raise a nudge button.
 *
 * What this file pins:
 *
 *   §1  THE BUG. The screenshot sequence end to end: adopt a courier rate at
 *       goods $0, then re-quote at $113.85 incl and land on `free` — applied,
 *       not merely offered, and ANNOUNCED.
 *   §2  OWNERSHIP IS THE WHOLE DISTINCTION. A rate the operator picked, typed,
 *       or billed as a line is never revised. They keep the offer-only path,
 *       which is deliberate: they may be charging freight on purpose.
 *   §3  THE REVERSE, AND THE ERR-174 NO-REGRESS. Falling under the threshold
 *       stays loud, and a shipping LINE still blocks the autofill entirely.
 *   §4  AN AUTHORED $0 IS NOT AN EMPTY BOX. A reopened invoice that shipped free
 *       must not acquire a courier rate. This hole predates ERR-178.
 *   §5  THE BASIS IS NAMED ON SCREEN. The threshold is judged incl-GST while the
 *       freight box beside it is ex-GST; the row must say which.
 *   §6  WIRING. The page actually calls the planner and sets ownership at every
 *       site where the operator states freight intent.
 *
 * Run: node --test tests/admin-invoice-free-shipping-autofill-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', 'inkcartridges');
const ADMIN = path.join(ROOT, 'js', 'admin');
const INVOICES = fs.readFileSync(path.join(ADMIN, 'pages', 'invoices.js'), 'utf8');

// Same ESM→sandbox trick the sibling invoice suites use (admin-invoice-quote).
function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date, RegExp };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(path.join(ADMIN, 'utils', 'invoice-quote.js'), 'utf8')),
  sandbox, { filename: 'invoice-quote.js' });

const {
  FREIGHT_CUSTOM, FREIGHT_OWNER_NONE, FREIGHT_OWNER_AUTO, FREIGHT_OWNER_OPERATOR,
  planFreightAutofill, freeShippingGapNote, freeShippingAvailable, freeShippingLost,
  resolveShippingSelection, normalizeQuote,
} = sandbox;

// Comments explain; only code counts when asserting that something is WIRED.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const CODE = stripComments(INVOICES);

/** Brace-match a top-level function body out of a source file. */
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `not found: ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`unbalanced braces after ${signature}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — the LIVE option list and figures, measured against production
// 2026-08-28 via POST /api/admin/invoices/quote. Courier rates are ex-GST
// ($6.09 ex = $7.00 incl); the goods total the threshold is judged on is INCL.
// ─────────────────────────────────────────────────────────────────────────────

const PAID_OPTIONS = [
  { key: 'pickup', label: 'Pickup', freightExclGst: 0 },
  { key: 'auckland:urban', label: 'Courier — Auckland (Urban)', freightExclGst: 6.09 },
  { key: 'auckland:rural', label: 'Courier — Auckland (Rural)', freightExclGst: 12.17 },
  { key: 'north-island:urban', label: 'Courier — North Island (Urban)', freightExclGst: 6.09 },
];
const FREE_OPTION = { key: 'free', label: 'Free shipping', freightExclGst: 0 };

/** A quote whose goods total is UNDER the threshold — no `free` in the list. */
const underThreshold = (goods = 0) => ({
  hasOptions: true,
  options: PAID_OPTIONS.slice(),
  weightKg: 0,
  goodsTotalInclGst: goods,
  freeShippingThreshold: 100,
  freeShippingEligible: false,
  suggestedKey: 'auckland:urban',
});

/** A quote OVER the threshold — `free` appears and becomes the suggestion. */
const overThreshold = (goods = 113.85) => ({
  hasOptions: true,
  options: [PAID_OPTIONS[0], FREE_OPTION, ...PAID_OPTIONS.slice(1)],
  weightKg: 0,
  goodsTotalInclGst: goods,
  freeShippingThreshold: 100,
  freeShippingEligible: true,
  suggestedKey: 'free',
});

// ═════════════════════════════════════════════════════════════════════════════
// §1  The bug, as the owner met it
// ═════════════════════════════════════════════════════════════════════════════

test('§1.1 a quote at goods $0 adopts the suggested courier rate — and marks it OURS', () => {
  const plan = planFreightAutofill(underThreshold(0), {
    owner: FREIGHT_OWNER_NONE, choice: null, freight: 0,
  });
  assert.equal(plan.apply, true, 'a brand-new draft should still need no clicks');
  assert.equal(plan.key, 'auckland:urban');
  assert.equal(plan.option.freightExclGst, 6.09);
  assert.equal(plan.owner, FREIGHT_OWNER_AUTO,
    'the pre-ERR-178 code recorded this guess as an operator pick, which is the bug');
  assert.equal(plan.announce, null, 'filling an empty box on a new draft is not news');
});

test('§1.2 typing $99.00 ex then re-quoting APPLIES free shipping, not just offers it', () => {
  // The exact numbers from the owner's screenshot.
  const shipping = overThreshold(113.85);
  const plan = planFreightAutofill(shipping, {
    owner: FREIGHT_OWNER_AUTO, choice: 'auckland:urban', freight: 6.09,
  });
  assert.equal(plan.apply, true, 'freight we chose ourselves must follow the quote');
  assert.equal(plan.key, 'free');
  assert.equal(plan.option.freightExclGst, 0, 'the invoice must total $113.85, not $120.85');
  assert.equal(plan.announce, 'free', 'money changed by itself — that has to be visible');
});

test('§1.3 the whole sequence: $0 → courier → $113.85 incl → free', () => {
  let owner = FREIGHT_OWNER_NONE;
  let choice = null;
  let freight = 0;
  const step = (shipping) => {
    const p = planFreightAutofill(shipping, { owner, choice, freight });
    if (p.apply) { owner = p.owner; choice = p.key; freight = p.option.freightExclGst; }
    return p;
  };

  step(underThreshold(0));            // typed the code `lc`; no price yet
  assert.equal(freight, 6.09);
  step(underThreshold(10.35));        // typed `9` — still under
  assert.equal(freight, 6.09);
  const last = step(overThreshold(113.85));   // typed the second `9`
  assert.equal(freight, 0, 'the invoice the owner screenshotted should have been $113.85');
  assert.equal(choice, 'free');
  assert.equal(last.announce, 'free');
});

test('§1.4 the boundary is the INCL-GST total — $86.90 ex does NOT qualify', () => {
  // Measured live: 86.90 ex = 99.94 incl → not eligible; 87.00 ex = 100.05 → eligible.
  // The frontend never compares, so this pins that it faithfully relays the two
  // different answers rather than re-deriving one from the ex-GST figure it holds.
  const under = planFreightAutofill(underThreshold(99.94), {
    owner: FREIGHT_OWNER_AUTO, choice: 'auckland:urban', freight: 6.09,
  });
  assert.equal(under.apply, false, 'nothing to change: still the suggested courier');

  const over = planFreightAutofill(overThreshold(100.05), {
    owner: FREIGHT_OWNER_AUTO, choice: 'auckland:urban', freight: 6.09,
  });
  assert.equal(over.key, 'free');
});

// ═════════════════════════════════════════════════════════════════════════════
// §2  Ownership is the whole distinction
// ═════════════════════════════════════════════════════════════════════════════

test('§2.1 a courier rate the OPERATOR picked is never overwritten', () => {
  const plan = planFreightAutofill(overThreshold(113.85), {
    owner: FREIGHT_OWNER_OPERATOR, choice: 'auckland:urban', freight: 6.09,
  });
  assert.equal(plan.apply, false, 'they may be charging freight on purpose');
  assert.equal(plan.owner, FREIGHT_OWNER_OPERATOR, 'ownership never migrates back to us');
});

test('§2.2 …and they still get the offer, exactly as before', () => {
  assert.equal(freeShippingAvailable('auckland:urban', overThreshold(113.85)), true,
    'the nudge is the operator-owned path and must not have been traded away');
});

test('§2.3 a hand-typed freight figure is never overwritten', () => {
  const plan = planFreightAutofill(overThreshold(113.85), {
    owner: FREIGHT_OWNER_OPERATOR, choice: FREIGHT_CUSTOM, freight: 22.50,
  });
  assert.equal(plan.apply, false);
});

test('§2.4 our own rate stops being ours the moment they touch it', () => {
  // Simulates onFreightOptionPick: owner flips, and the next quote lets it be.
  const afterPick = planFreightAutofill(overThreshold(113.85), {
    owner: FREIGHT_OWNER_OPERATOR, choice: 'auckland:rural', freight: 12.17,
  });
  assert.equal(afterPick.apply, false);
  assert.equal(freeShippingAvailable('auckland:rural', overThreshold(113.85)), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// §3  The reverse crossing, and the ERR-174 no-regress
// ═════════════════════════════════════════════════════════════════════════════

test('§3.1 free being withdrawn is still detected by freeShippingLost, ours or theirs', () => {
  for (const _owner of [FREIGHT_OWNER_AUTO, FREIGHT_OWNER_OPERATOR]) {
    const lost = freeShippingLost('free', underThreshold(40));
    assert.equal(lost.lost, true, 'a courier parcel must never go out billed at $0');
    assert.equal(lost.fallbackKey, 'auckland:urban');
  }
});

test('§3.2 a shipping LINE still blocks the autofill entirely (ERR-174)', () => {
  // addShippingLine() calls suppressFreightAutofill(), which sets choice
  // FREIGHT_CUSTOM *and* operator ownership. Without the second half, ERR-178's
  // re-adoption would reintroduce the double charge on the next crossing.
  const plan = planFreightAutofill(underThreshold(172.50), {
    owner: FREIGHT_OWNER_OPERATOR, choice: FREIGHT_CUSTOM, freight: 0,
  });
  assert.equal(plan.apply, false, 'a $150 freight LINE must not also collect a courier rate');

  const crossing = planFreightAutofill(overThreshold(172.50), {
    owner: FREIGHT_OWNER_OPERATOR, choice: FREIGHT_CUSTOM, freight: 0,
  });
  assert.equal(crossing.apply, false, 'and not on the way over the threshold either');
});

test('§3.3 suppressFreightAutofill takes ownership, not just the choice', () => {
  const body = fnBody(CODE, 'function suppressFreightAutofill()');
  assert.match(body, /FREIGHT_OWNER_OPERATOR/,
    'setting only _freightChoice leaves the figure revisable — the ERR-174 hole reopens');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4  An authored $0 is not an empty box
// ═════════════════════════════════════════════════════════════════════════════

test('§4.1 a reopened invoice that shipped FREE does not acquire a courier rate', () => {
  // freight 0 + choice null is byte-identical to a blank draft. Only ownership
  // tells them apart, and openEditor sets it from draft.id.
  const plan = planFreightAutofill(underThreshold(0), {
    owner: FREIGHT_OWNER_OPERATOR, choice: null, freight: 0,
  });
  assert.equal(plan.apply, false, 'this silently re-billed freight on a free-shipped invoice');
});

test('§4.2 …and the dropdown still labels that $0 box "Free", not "Custom"', () => {
  const sel = resolveShippingSelection(overThreshold(113.85), { choice: null, freight: 0 });
  assert.equal(sel.key, 'free',
    'ownership must be recorded WITHOUT stamping FREIGHT_CUSTOM, or the label regresses');
});

test('§4.3 openEditor marks a saved invoice operator-owned', () => {
  const body = fnBody(CODE, 'function openEditor(draft)');
  assert.match(body, /draft\.id.*FREIGHT_OWNER_OPERATOR/s);
});

test('§4.4 loadFromOrder marks an order-authored freight operator-owned', () => {
  assert.match(CODE, /_draft\.freight = shipIncl > 0[\s\S]{0,200}FREIGHT_OWNER_OPERATOR/,
    'an order that shipped free arrives as freight 0 — the same trap as §4.1');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5  The basis is named on screen
// ═════════════════════════════════════════════════════════════════════════════

test('§5.1 the shortfall note states the incl-GST basis', () => {
  const note = freeShippingGapNote(underThreshold(93.85));
  assert.equal(note, '$6.15 more (incl GST) for free shipping');
});

test('§5.2 no note once the order qualifies, and none when we cannot say', () => {
  assert.equal(freeShippingGapNote(overThreshold(113.85)), '');
  assert.equal(freeShippingGapNote({ hasOptions: true, options: [], goodsTotalInclGst: null, freeShippingThreshold: 100 }), '',
    'absence must print nothing, never a gap derived from a missing total');
  assert.equal(freeShippingGapNote({ hasOptions: true, options: [], goodsTotalInclGst: 40, freeShippingThreshold: null }), '');
});

test('§5.3 the "qualifies" button prints the figure it judged', () => {
  const body = fnBody(CODE, 'function renderShippingRow()');
  assert.match(body, /qualifies for free shipping \(\$\{money\(goodsIncl\)\} incl GST\)/,
    'the freight box beside this string is ex-GST; the row has to say which is which');
  assert.match(body, /freeShippingGapNote\(shipping\)/);
});

test('§5.4 goodsTotalInclGst survives normalizeQuote — the note has a source', () => {
  const q = normalizeQuote({ data: { lines: [], shipping: {
    options: [{ key: 'free', label: 'Free shipping', freight_excl_gst: 0 }],
    goods_total_incl_gst: 113.85, free_shipping_threshold: 100,
    free_shipping_eligible: true, suggested_key: 'free',
  } } });
  assert.equal(q.shipping.goodsTotalInclGst, 113.85);
  assert.equal(q.shipping.freeShippingThreshold, 100);
});

// ═════════════════════════════════════════════════════════════════════════════
// §6  Wiring — the planner is actually consulted, and ownership is actually set
// ═════════════════════════════════════════════════════════════════════════════

test('§6.1 reconcileShipping consults the planner instead of re-deriving', () => {
  const body = fnBody(CODE, 'function reconcileShipping(quote)');
  assert.match(body, /planFreightAutofill\(quote\.shipping, \{/);
  assert.match(body, /owner: _freightOwner/);
  assert.doesNotMatch(body, /suggestedKey\)\s*;/,
    'the old inline "find the suggested option" branch must be gone, not shadowed');
});

test('§6.2 the free-shipping toast names the incl-GST goods total', () => {
  const body = fnBody(CODE, 'function reconcileShipping(quote)');
  assert.match(body, /Free shipping now applies/);
  assert.match(body, /incl GST is over the/);
  assert.match(body, /goodsTotalInclGst/);
});

test('§6.3 every operator freight-intent site takes ownership', () => {
  const sites = [
    ['function onFreightOptionPick(key)', 'the dropdown'],
    ['function suppressFreightAutofill()', 'a shipping line'],
  ];
  for (const [sig, what] of sites) {
    assert.match(fnBody(CODE, sig), /FREIGHT_OWNER_OPERATOR/, `${what} must claim the figure`);
  }
  // The hand-typed branch and the apply-free-shipping click live inside larger
  // handlers, so pin them by their immediate neighbourhood.
  assert.match(CODE, /dataset\.field === 'freight'\)\s*\{[\s\S]{0,160}FREIGHT_OWNER_OPERATOR/,
    'typing in the freight box must claim it');
  assert.match(CODE, /_freightChoice = 'free';\s*_freightOwner = FREIGHT_OWNER_OPERATOR;/,
    'clicking "apply free shipping" is an explicit pick');
});

test('§6.4 _freightOwner resets with the rest of the quote state', () => {
  const body = fnBody(CODE, 'function resetQuoteState()');
  assert.match(body, /_freightOwner = FREIGHT_OWNER_NONE/,
    'carrying ownership into the next editor would freeze the new invoice\'s freight');
});

test('§6.5 _freightOwner NEVER reaches buildPayload', () => {
  const body = fnBody(CODE, 'function buildPayload(');
  assert.doesNotMatch(body, /_freightOwner|freight_owner/,
    'that key set is walked by setStatusViaFullUpdate and diffed by documentDrift');
});
