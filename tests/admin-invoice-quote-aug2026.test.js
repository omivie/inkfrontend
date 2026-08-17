/**
 * Invoice quote — freight dropdown + volume-discount autofill (Aug 2026)
 * ======================================================================
 *
 * `POST /api/admin/invoices/quote` prices two things the operator used to guess
 * at: the courier fee for a parcel, and the per-line volume discount the website
 * has given every shopper — guests included — since Aug 2026. Before this, an
 * invoice typed by hand for a bulk buyer charged flat retail, so the counter and
 * the website disagreed about what buying seven of something costs.
 *
 * FOUR LAWS, and every one of them is here because breaking it costs real money:
 *
 *   1. NEVER OVERWRITE A HAND-EDITED PRICE. Tracked as `priceSource`. And
 *      "hand-edited" is wider than "typed just now" — a SAVED invoice's prices,
 *      prices pulled off a real ORDER, and prices agreed at the counter on a
 *      quick order are all operator-authored history. Re-pricing them from
 *      today's ladder silently rewrites what a customer was charged.
 *
 *   2. NEVER CLAIM A DISCOUNT WE DID NOT GIVE. The bulk note is PRINTED on the
 *      customer's invoice. It is stamped only when we authored the price, and
 *      dropped the moment the operator takes the price over.
 *
 *   3. ALWAYS `effective_percent`, NEVER `discount_percent`. The rung's % is a
 *      ceiling; the margin floor decides what was actually given. Quoting the
 *      ceiling states a discount the customer did not get.
 *
 *   4. ABSENCE IS NOT ZERO. A missing `options` array means "we could not read
 *      the rates" and must SAY so; `[]` means "there are none". A missing
 *      `volume` on an unresolved line means "we don't know yet"; `null` means
 *      "no discount applies". Collapsing either pair is the ERR-063/068/149
 *      shape this codebase keeps paying for.
 *
 * Section 10 is the enrolment gate. When the public volume ladder shipped it went
 * missing TWICE — once at a whitelist parser (ERR-150) and once at a call site
 * nobody remembered to enrol (ERR-160), whose lesson was: "when a capability is
 * opt-in per surface, the enrolment list belongs in a test". This is that test.
 *
 * Run with: node --test tests/admin-invoice-quote-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', 'inkcartridges');
const ADMIN = path.join(ROOT, 'js', 'admin');
const QUOTE_SRC_PATH = path.join(ADMIN, 'utils', 'invoice-quote.js');
const INVOICES = fs.readFileSync(path.join(ADMIN, 'pages', 'invoices.js'), 'utf8');
const QUICK_ORDER = fs.readFileSync(path.join(ADMIN, 'pages', 'quick-order.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ADMIN, 'utils', 'quick-order-bridge.js'), 'utf8');
const ADMIN_API = fs.readFileSync(path.join(ADMIN, 'api.js'), 'utf8');
const ADMIN_CSS = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');
const BUSINESS_JS = fs.readFileSync(path.join(ROOT, 'js', 'business.js'), 'utf8');

// Same ESM→sandbox trick the sibling invoice suites use (admin-invoice-cost-math).
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
vm.runInContext(stripEsm(fs.readFileSync(QUOTE_SRC_PATH, 'utf8')), sandbox, { filename: 'invoice-quote.js' });

const {
  PRICE_AUTO, PRICE_MANUAL, FREIGHT_CUSTOM, MAX_QUOTE_LINES,
  linePrice, withLinePrice, deliveryHintFromDraft, quoteRequestBody,
  normalizeQuote, effectivePercent, formatVolumePercent, volumeBadge,
  applyQuoteToLines, clearVolume, lineDocNote,
  resolveShippingSelection, freeShippingLost, freeShippingAvailable, parcelWeightNote,
} = sandbox;

// Comments explain; only code counts when asserting that something is WIRED.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const INVOICES_CODE = stripComments(INVOICES);
const QUICK_ORDER_CODE = stripComments(QUICK_ORDER);

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

// ── A realistic quote, shaped exactly like the backend brief's example ────────
const QUOTE_PAYLOAD = {
  lines: [
    {
      position: 0, input_code: 'GLC73BK', product_code: 'GLC73BK', resolved: true,
      name: 'Brother Genuine LC73BK Ink Cartridge', source: 'genuine', is_active: true,
      quantity: 7, retail_incl_gst: 65.49, unit_excl_gst: 56.95,
      volume: {
        discount_percent: 6, effective_percent: 6, unit_incl_gst: 61.56,
        unit_excl_gst: 53.53, per_unit_saving_excl_gst: 3.42,
        line_saving_excl_gst: 23.94, floored: false,
      },
    },
    { position: 1, input_code: null, product_code: null, resolved: false, reason: 'no_code', quantity: 1 },
  ],
  shipping: {
    weight_kg: 0.7, goods_total_incl_gst: 430.92, free_shipping_threshold: 100,
    free_shipping_eligible: true, suggested_key: 'free',
    options: [
      { key: 'pickup', label: 'Pickup / no shipping', fee_incl_gst: 0, freight_excl_gst: 0 },
      { key: 'free', label: 'Free shipping (order over $100)', fee_incl_gst: 0, freight_excl_gst: 0 },
      {
        key: 'auckland:urban', label: 'Courier — Auckland (Urban)', zone: 'auckland',
        zone_label: 'Auckland', delivery_type: 'urban', tier: 'standard',
        fee_incl_gst: 5.99, freight_excl_gst: 5.21,
      },
      {
        key: 'north-island:urban', label: 'Courier — North Island (Urban)', zone: 'north-island',
        zone_label: 'North Island', delivery_type: 'urban', tier: 'standard',
        fee_incl_gst: 8.05, freight_excl_gst: 7.00,
      },
    ],
  },
};
const QUOTE = () => normalizeQuote({ data: JSON.parse(JSON.stringify(QUOTE_PAYLOAD)) });

// ─── 1. Request body ─────────────────────────────────────────────────────────

test('§1 every line is sent, blanks included — position must index the draft 1:1', () => {
  const draft = {
    lines: [
      { code: 'GLC73BK', qty: 7, unitCost: 56.95, priceSource: PRICE_AUTO },
      { code: '', description: '', qty: 1, unitCost: 0, priceSource: PRICE_AUTO },
      { code: '', description: 'Labour', qty: 1, unitCost: 100, priceSource: PRICE_MANUAL },
    ],
  };
  const { body } = quoteRequestBody(draft);
  assert.equal(body.line_items.length, 3,
    'filtering blanks here would shift every response position one row up and badge the wrong line');
  assert.equal(body.line_items[1].product_code, '');
  assert.equal(body.line_items[2].description, 'Labour');
});

test('§1 the typed price is sent ONLY for hand-edited lines', () => {
  const draft = {
    lines: [
      { code: 'A', qty: 2, unitCost: 10, priceSource: PRICE_AUTO },
      { code: 'B', qty: 2, unitCost: 99, priceSource: PRICE_MANUAL },
    ],
  };
  const { body } = quoteRequestBody(draft);
  assert.equal('unit_cost_excl_gst' in body.line_items[0], false,
    'an auto price is OUR number — sending it back would just be quoting ourselves');
  assert.equal(body.line_items[1].unit_cost_excl_gst, 99,
    'a deliberate override must reach the free-shipping goods-total check');
});

test('§1 a draft with nothing typed asks for nothing', () => {
  assert.equal(quoteRequestBody({ lines: [{ code: '', description: '', qty: 1 }] }), null);
  assert.equal(quoteRequestBody({ lines: [] }), null);
  assert.equal(quoteRequestBody(null), null);
});

test('§1 more than 200 lines truncates VISIBLY, never silently', () => {
  const lines = Array.from({ length: 205 }, (_, i) => ({ code: `SKU${i}`, qty: 1 }));
  const req = quoteRequestBody({ lines });
  assert.equal(req.body.line_items.length, MAX_QUOTE_LINES);
  assert.equal(req.truncated, 5,
    'the caller has to be able to SAY that five lines went unpriced — a quiet truncation '
    + 'looks exactly like a complete answer');
});

test('§1 the delivery hint rides along when the address has one', () => {
  const { body } = quoteRequestBody({
    lines: [{ code: 'A', qty: 1 }],
    customer: { address: '12 Queen St\nAuckland 0632' },
  });
  assert.equal(body.delivery.postal_code, '0632');
  assert.equal(body.delivery.region, 'Auckland');
});

// ─── 2. Delivery hint ────────────────────────────────────────────────────────

test('§2 the postcode is the LAST 4-digit token, not the street number', () => {
  const hint = deliveryHintFromDraft({ customer: { address: '1234 Great North Road\nAuckland 1021' } });
  assert.equal(hint.postal_code, '1021', 'NZ addresses put the postcode last; street numbers come first');
});

test('§2 the delivery address beats the billing address', () => {
  const hint = deliveryHintFromDraft({
    customer: { address: '1 Billing St\nWellington 6011' },
    delivery: { address: '9 Goods Rd\nChristchurch, Canterbury 8011' },
  });
  assert.equal(hint.postal_code, '8011');
  assert.equal(hint.region, 'Canterbury', 'goods go where the goods go');
});

test('§2 "RD 2" reads as rural — the NZ convention', () => {
  assert.equal(deliveryHintFromDraft({ customer: { address: '123 Some Rd\nRD 2\nTaupo 3378' } }).delivery_type, 'rural');
  assert.equal(deliveryHintFromDraft({ customer: { address: '12 Queen St\nAuckland 1010' } }).delivery_type, 'urban');
});

test('§2 multi-word and apostrophised regions resolve', () => {
  assert.equal(deliveryHintFromDraft({ customer: { address: 'Tauranga, Bay of Plenty 3110' } }).region, 'Bay of Plenty');
  assert.equal(deliveryHintFromDraft({ customer: { address: 'Napier, Hawkes Bay 4110' } }).region, "Hawke's Bay");
  assert.equal(deliveryHintFromDraft({ customer: { address: 'Napier, Hawke’s Bay 4110' } }).region, "Hawke's Bay");
});

test('§2 no address at all is null, not a guess', () => {
  assert.equal(deliveryHintFromDraft({}), null);
  assert.equal(deliveryHintFromDraft({ customer: { address: '   ' } }), null);
});

test('§2 an unrecognised region simply has none — a wrong hint costs one click, never a price', () => {
  const hint = deliveryHintFromDraft({ customer: { address: '1 Main St\nSpringfield 9999' } });
  assert.equal(hint.region, undefined);
  assert.equal(hint.postal_code, '9999');
});

// ─── 3. normalizeQuote — absence is not emptiness ────────────────────────────

test('§3 a well-formed payload normalises, envelope or bare', () => {
  const a = normalizeQuote({ data: QUOTE_PAYLOAD });
  const b = normalizeQuote(QUOTE_PAYLOAD);
  assert.equal(a.lines.length, 2);
  assert.equal(b.lines.length, 2);
  assert.equal(a.shipping.options.length, 4);
});

test('§3 MISSING options ≠ EMPTY options', () => {
  const missing = normalizeQuote({ data: { shipping: { weight_kg: 1 } } });
  assert.equal(missing.shipping.hasOptions, false,
    'no options array = we could not read the rates, and the UI must SAY so');

  const empty = normalizeQuote({ data: { shipping: { options: [] } } });
  assert.equal(empty.shipping.hasOptions, true,
    'an empty array is a real answer: there are no rates');
  assert.deepEqual(empty.shipping.options, []);
});

test('§3 junk returns null so the caller keeps its last good quote', () => {
  assert.equal(normalizeQuote(null), null);
  assert.equal(normalizeQuote({}), null);
  assert.equal(normalizeQuote({ data: { nothing: true } }), null);
  assert.equal(normalizeQuote('nope'), null);
});

test('§3 volume:null survives as null — not a zero-percent object', () => {
  const q = normalizeQuote({ data: { lines: [{ position: 0, resolved: true, volume: null, unit_excl_gst: 10 }] } });
  assert.equal(q.lines[0].volume, null,
    'a zero-percent object would render a "−0%" badge beside a full-price line');
});

test('§3 an option with no key is dropped rather than rendered as a blank choice', () => {
  const q = normalizeQuote({ data: { shipping: { options: [{ label: 'Nameless' }, { key: 'pickup', label: 'Pickup' }] } } });
  assert.deepEqual(q.shipping.options.map((o) => o.key), ['pickup']);
});

test('§3 is_active defaults to TRUE — absence must not flag every product inactive', () => {
  const q = normalizeQuote({ data: { lines: [{ position: 0, resolved: true }] } });
  assert.equal(q.lines[0].isActive, true);
});

// ─── 4. Percentages ──────────────────────────────────────────────────────────

test('§4 effectivePercent prefers the realised %, never the ladder ceiling', () => {
  assert.equal(effectivePercent({ discountPercent: 6, effectivePercent: 4 }), 4,
    'the floor decided what was actually given; quoting 6% claims a discount the customer did not get');
  assert.equal(effectivePercent({ discountPercent: 6, effectivePercent: null }), 6,
    'with no realised figure the ladder % is all we have');
  assert.equal(effectivePercent(null), null);
});

test('§4 formatVolumePercent never prints a zero for a real discount', () => {
  assert.equal(formatVolumePercent(6), '6%');
  assert.equal(formatVolumePercent(0.5), '0.5%');
  assert.equal(formatVolumePercent(9.937), '9.9%');
  assert.equal(formatVolumePercent(0.03), '<0.1%',
    '"" is falsy and makes the badge vanish entirely; "0%" beside a lower price is a lie');
  assert.equal(formatVolumePercent(NaN), '');
});

test('§4 it agrees with Business.formatPercent, character for character', () => {
  // A DELIBERATE PORT: business.js is a window global the admin shell never
  // loads, and a 53 KB script tag to import one five-line formatter is the wrong
  // trade. This is what stops the copy drifting from the original.
  const method = fnBody(BUSINESS_JS, 'formatPercent(pct)');
  const body = method.slice(method.indexOf('{') + 1, method.lastIndexOf('}'));
  const original = new Function('pct', body);

  const cases = [0, 0.01, 0.03, 0.04, 0.05, 0.5, 1, 2.5, 3, 6, 6.3, 9.937, 10, 15, 18, 100,
    -1, NaN, Infinity];
  for (const c of cases) {
    assert.equal(formatVolumePercent(c), original(c),
      `formatVolumePercent(${c}) must match Business.formatPercent(${c})`);
  }
});

// ─── 5. volumeBadge ──────────────────────────────────────────────────────────

test('§5 a discounted line yields a badge with the was-price and the saving', () => {
  const badge = volumeBadge(QUOTE().lines[0]);
  assert.equal(badge.percent, 6);
  assert.equal(badge.percentText, '6%');
  assert.equal(badge.unitPrice, 53.53);
  assert.equal(badge.wasPrice, 56.95);
  assert.equal(badge.lineSaving, 23.94);
  assert.equal(badge.floored, false);
});

test('§5 a rung floored back to retail yields NO badge', () => {
  const q = normalizeQuote({
    data: {
      lines: [{
        position: 0, resolved: true, quantity: 5, unit_excl_gst: 20,
        volume: { discount_percent: 3, effective_percent: 0, unit_excl_gst: 20, floored: true },
      }],
    },
  });
  assert.equal(volumeBadge(q.lines[0]), null,
    '"Volume −0%" beside the full price is worse than saying nothing');
});

test('§5 a floored-but-real discount shows the EFFECTIVE percent', () => {
  const q = normalizeQuote({
    data: {
      lines: [{
        position: 0, resolved: true, quantity: 5, unit_excl_gst: 20,
        volume: { discount_percent: 6, effective_percent: 2.5, unit_excl_gst: 19.5, floored: true },
      }],
    },
  });
  const badge = volumeBadge(q.lines[0]);
  assert.equal(badge.percent, 2.5);
  assert.equal(badge.floored, true);
});

test('§5 an unresolved line has no badge', () => {
  assert.equal(volumeBadge(QUOTE().lines[1]), null);
  assert.equal(volumeBadge(null), null);
});

// ─── 6. applyQuoteToLines — LAW 1 and LAW 2 ──────────────────────────────────

test('§6 an auto-priced line takes the volume price and is stamped with the discount', () => {
  const lines = [{ code: 'GLC73BK', qty: 7, unitCost: 56.95, priceSource: PRICE_AUTO }, { code: '', qty: 1 }];
  const out = applyQuoteToLines(lines, QUOTE());
  assert.equal(out.lines[0].unitCost, 53.53);
  assert.equal(out.lines[0].volumePercent, 6);
  assert.equal(out.lines[0].volumeSaving, 23.94);
  assert.equal(out.lines[0].volumeQuantity, 7);
  // NB Array.from: `applied` is built inside the vm realm, so a raw deepEqual
  // would fail on prototype identity rather than on content.
  assert.deepEqual(Array.from(out.applied), [0]);
  assert.equal(out.changed, true);
});

test('§6 a HAND-EDITED price is never overwritten — it becomes an offer', () => {
  const lines = [{ code: 'GLC73BK', qty: 7, unitCost: 50, priceSource: PRICE_MANUAL }];
  const out = applyQuoteToLines(lines, QUOTE());
  assert.equal(out.lines[0].unitCost, 50, 'LAW 1: the operator authored this number');
  assert.deepEqual(Array.from(out.applied), []);
  assert.equal(out.offers.length, 1);
  assert.equal(out.offers[0].position, 0);
  assert.equal(out.offers[0].badge.unitPrice, 53.53);
});

test('§6 a hand-edited price that ALREADY equals the volume price is not re-offered', () => {
  const lines = [{ code: 'GLC73BK', qty: 7, unitCost: 53.53, priceSource: PRICE_MANUAL }];
  const out = applyQuoteToLines(lines, QUOTE());
  assert.deepEqual(Array.from(out.offers), [], 'offering a button that changes nothing is noise');
});

test('§6 LAW 2: a hand-edited line loses any discount claim', () => {
  const lines = [{
    code: 'GLC73BK', qty: 7, unitCost: 50, priceSource: PRICE_MANUAL,
    volumePercent: 6, volumeSaving: 23.94, volumeQuantity: 7,
  }];
  const out = applyQuoteToLines(lines, QUOTE());
  assert.equal(out.lines[0].volumePercent, null,
    'the invoice PRINTS this — a "6% off" beside a price we did not set is a false claim');
  assert.equal(out.lines[0].volumeSaving, null);
});

test('§6 a line with no volume discount gets plain retail ex-GST and no badge', () => {
  const q = normalizeQuote({ data: { lines: [{ position: 0, resolved: true, quantity: 1, unit_excl_gst: 56.95, volume: null }] } });
  const out = applyQuoteToLines([{ code: 'GLC73BK', qty: 1, unitCost: 0, priceSource: PRICE_AUTO }], q);
  assert.equal(out.lines[0].unitCost, 56.95);
  assert.equal(out.lines[0].volumePercent, null);
});

test('§6 an UNRESOLVED code changes nothing — the operator may be mid-SKU', () => {
  const q = normalizeQuote({ data: { lines: [{ position: 0, resolved: false, reason: 'code_not_found' }] } });
  const lines = [{ code: 'GLC7', qty: 7, unitCost: 12, priceSource: PRICE_AUTO }];
  const out = applyQuoteToLines(lines, q);
  assert.equal(out.lines[0].unitCost, 12, 'blanking a price under a half-typed code would be maddening');
  assert.equal(out.changed, false);
});

test('§6 a line the quote has no answer for is left completely alone', () => {
  const lines = [
    { code: 'GLC73BK', qty: 7, unitCost: 56.95, priceSource: PRICE_AUTO },
    { code: 'NEWLY-ADDED', qty: 3, unitCost: 5, priceSource: PRICE_AUTO },
    { code: 'ALSO-NEW', qty: 1, unitCost: 9, priceSource: PRICE_AUTO },
  ];
  const out = applyQuoteToLines(lines, QUOTE());
  assert.equal(out.lines[2].unitCost, 9, 'an older quote must not touch rows it never saw');
});

test('§6 it is PURE — the caller\'s line objects are never mutated', () => {
  const original = { code: 'GLC73BK', qty: 7, unitCost: 56.95, priceSource: PRICE_AUTO };
  const lines = [original, { code: '', qty: 1 }];
  applyQuoteToLines(lines, QUOTE());
  assert.equal(original.unitCost, 56.95, 'mutating in place would defeat the render diff and the tests');
});

test('§6 re-applying the same quote reports NO change (no render loop)', () => {
  const first = applyQuoteToLines([{ code: 'GLC73BK', qty: 7, unitCost: 56.95, priceSource: PRICE_AUTO }, { code: '', qty: 1 }], QUOTE());
  const second = applyQuoteToLines(first.lines, QUOTE());
  assert.equal(second.changed, false);
});

test('§6 Quick Order lines use unitPrice and are handled by the same code path', () => {
  const lines = [{ code: 'GLC73BK', qty: 7, unitPrice: 56.95, priceSource: PRICE_AUTO }];
  const out = applyQuoteToLines(lines, QUOTE());
  assert.equal(out.lines[0].unitPrice, 53.53, 'the counter and the invoice must price a bulk sale identically');
  assert.equal(out.lines[0].unitCost, undefined, 'and must not sprout the other editor\'s field name');
});

test('§6 linePrice / withLinePrice read and write whichever name the line uses', () => {
  assert.equal(linePrice({ unitCost: 5 }), 5);
  assert.equal(linePrice({ unitPrice: 7 }), 7);
  assert.equal(linePrice({}), 0);
  assert.equal(withLinePrice({ unitPrice: 1 }, 2).unitPrice, 2);
  assert.equal(withLinePrice({ unitCost: 1 }, 2).unitCost, 2);
});

test('§6 clearVolume drops the claim and leaves the price alone', () => {
  const out = clearVolume({ unitCost: 53.53, volumePercent: 6, volumeSaving: 23.94, volumeQuantity: 7 });
  assert.equal(out.unitCost, 53.53);
  assert.equal(out.volumePercent, null);
  assert.equal(out.volumeQuantity, null);
});

// ─── 7. The customer-facing note ─────────────────────────────────────────────

test('§7 lineDocNote states the rung, not just the percent', () => {
  assert.equal(lineDocNote({ volumePercent: 6, volumeQuantity: 7 }), 'Bulk price — 6% off at 7+',
    'an invoice is read months later; "6% off" alone does not explain itself');
});

test('§7 no discount, no note — and never an empty claim', () => {
  assert.equal(lineDocNote({}), '');
  assert.equal(lineDocNote({ volumePercent: 0 }), '');
  assert.equal(lineDocNote({ volumePercent: null }), '');
  assert.equal(lineDocNote(null), '');
});

test('§7 a fractional discount still prints', () => {
  assert.equal(lineDocNote({ volumePercent: 0.5, volumeQuantity: 3 }), 'Bulk price — 0.5% off at 3+');
});

// ─── 8. Shipping selection ───────────────────────────────────────────────────

test('§8 an explicit pick wins', () => {
  const sel = resolveShippingSelection(QUOTE().shipping, { choice: 'auckland:urban', freight: 0 });
  assert.equal(sel.key, 'auckland:urban');
  assert.equal(sel.option.freightExclGst, 5.21);
});

test('§8 with no pick, the selection is DERIVED from the freight already stored', () => {
  const sel = resolveShippingSelection(QUOTE().shipping, { choice: null, freight: 5.21 });
  assert.equal(sel.key, 'auckland:urban',
    'reopening a saved invoice must label its freight, and nothing about the choice is stored');
});

test('§8 the pickup/free $0 ambiguity resolves to free when the order qualifies', () => {
  // Both cost $0, so the value alone cannot tell them apart. This is the ONLY
  // ambiguous case and it is decided in favour of the likelier meaning.
  const sel = resolveShippingSelection(QUOTE().shipping, { choice: null, freight: 0 });
  assert.equal(sel.key, 'free');

  const q = QUOTE();
  q.shipping.options = q.shipping.options.filter((o) => o.key !== 'free');
  assert.equal(resolveShippingSelection(q.shipping, { choice: null, freight: 0 }).key, 'pickup');
});

test('§8 a typed figure matching no option is Custom, not someone else\'s label', () => {
  const sel = resolveShippingSelection(QUOTE().shipping, { choice: null, freight: 12.34 });
  assert.equal(sel.isCustom, true);
  assert.equal(sel.key, FREIGHT_CUSTOM);
  assert.equal(sel.available, true);
});

test('§8 with no readable options the row is unavailable, NOT an empty dropdown', () => {
  const sel = resolveShippingSelection({ hasOptions: false, options: [] }, { choice: null, freight: 0 });
  assert.equal(sel.available, false,
    'an empty dropdown reads as "there are no shipping options" — the absence-as-zero failure');
});

test('§8 a pick that no longer exists falls back to derivation, not a dangling selection', () => {
  const sel = resolveShippingSelection(QUOTE().shipping, { choice: 'south-island:rural', freight: 5.21 });
  assert.equal(sel.key, 'auckland:urban');
});

// ─── 8b. The loud case ───────────────────────────────────────────────────────

test('§8b losing free shipping is LOUD and falls back to the suggestion', () => {
  const q = QUOTE();
  q.shipping.options = q.shipping.options.filter((o) => o.key !== 'free');
  q.shipping.freeShippingEligible = false;
  q.shipping.suggestedKey = 'north-island:urban';

  const lost = freeShippingLost('free', q.shipping);
  assert.equal(lost.lost, true,
    'doing nothing leaves $0 in the freight box and a courier parcel invoiced at nothing');
  assert.equal(lost.fallbackKey, 'north-island:urban');
  assert.equal(lost.fallbackOption.freightExclGst, 7.00);
});

test('§8b nothing is "lost" when free is still on offer, or was never chosen', () => {
  assert.equal(freeShippingLost('free', QUOTE().shipping).lost, false);
  assert.equal(freeShippingLost('auckland:urban', QUOTE().shipping).lost, false);
  assert.equal(freeShippingLost(null, QUOTE().shipping).lost, false);
});

test('§8b unreadable rates are NOT treated as free shipping disappearing', () => {
  assert.equal(freeShippingLost('free', { hasOptions: false, options: [] }).lost, false,
    'a failed quote must never rewrite the operator\'s freight');
});

test('§8b free BECOMING available is only ever offered, never applied', () => {
  assert.equal(freeShippingAvailable('auckland:urban', QUOTE().shipping), true);
  assert.equal(freeShippingAvailable('free', QUOTE().shipping), false);
  assert.equal(freeShippingAvailable('pickup', QUOTE().shipping), false,
    'pickup is a deliberate choice, not a fee to be helpfully zeroed');
});

// ─── 9. Parcel weight honesty ────────────────────────────────────────────────

test('§9 the weight note says when lines were not counted', () => {
  assert.equal(parcelWeightNote(QUOTE()), 'parcel ≈ 0.7 kg');

  const q = QUOTE();
  q.lines.push({ position: 2, inputCode: 'NOTREAL99', resolved: false, reason: 'code_not_found' });
  assert.equal(parcelWeightNote(q), 'parcel ≈ 0.7 kg — 1 unrecognised code is not counted',
    'weight counts resolved products only, so a bare number under-states the parcel — '
    + 'and an under-stated parcel is an under-charged courier');
});

test('§9 a blank line is not "unrecognised" — it was never a code', () => {
  assert.equal(parcelWeightNote(QUOTE()), 'parcel ≈ 0.7 kg');
});

test('§9 no weight, no note', () => {
  assert.equal(parcelWeightNote({ shipping: {}, lines: [] }), '');
  assert.equal(parcelWeightNote(null), '');
});

// ─── 10. ENROLMENT ───────────────────────────────────────────────────────────
//
// ERR-160's lesson, verbatim: "when a capability is opt-in per surface, the
// enrolment list belongs in a test." Every place that writes a line price must
// declare whose price it is, and every place that changes what the ladder would
// say must ask again. A new fill-from-X path that skips either is a silent
// regression to flat retail — exactly how this feature has failed before.

const PRICE_WRITERS = [
  ['invoices.js', INVOICES_CODE, ['blankLine', 'draftFromInvoice', 'loadFromOrder', 'maybeOpenFromQuickOrder']],
  ['quick-order.js', QUICK_ORDER_CODE, ['blankLine', 'draftFromRecord']],
];

test('§10 every line factory / loader declares a priceSource', () => {
  for (const [name, code] of PRICE_WRITERS) {
    // Each editor builds line objects in a handful of places; all of them must
    // say whose the price is, because the default (undefined) is treated as
    // "ours to overwrite".
    const lineObjects = code.match(/\{[^{}]*\bqty:[^{}]*\}/g) || [];
    assert.ok(lineObjects.length >= 2, `${name}: expected several line-object literals`);
    for (const obj of lineObjects) {
      assert.match(obj, /priceSource/,
        `${name}: a line object literal with no priceSource defaults to "ours to overwrite", `
        + `which would silently re-price operator-authored history:\n${obj}`);
    }
  }
});

test('§10 loaded history is MANUAL — saved invoices, real orders, counter prices', () => {
  // The three ways a price arrives already decided. Each must be manual, or the
  // ladder rewrites what a customer was actually charged.
  for (const fn of ['function draftFromInvoice(rec)', 'async function loadFromOrder(orderId)', 'function maybeOpenFromQuickOrder()']) {
    const body = fnBody(INVOICES_CODE, fn);
    assert.match(body, /priceSource:\s*PRICE_MANUAL/,
      `invoices.js ${fn} loads prices that already exist — they must be PRICE_MANUAL`);
  }
  assert.match(fnBody(QUICK_ORDER_CODE, 'function draftFromRecord(rec)'), /priceSource:\s*PRICE_MANUAL/,
    'quick-order.js draftFromRecord loads saved prices — they must be PRICE_MANUAL');
});

test('§10 a freshly picked product is OURS to price, in both editors', () => {
  for (const [name, code] of [['invoices.js', INVOICES_CODE], ['quick-order.js', QUICK_ORDER_CODE]]) {
    assert.match(code, /priceSource:\s*PRICE_AUTO/, `${name}: the product picker must set PRICE_AUTO`);
  }
});

test('§10 typing a price promotes the line to manual AND drops the discount claim', () => {
  for (const [name, code, field] of [['invoices.js', INVOICES_CODE, 'unitCost'], ['quick-order.js', QUICK_ORDER_CODE, 'unitPrice']]) {
    const body = fnBody(code, 'function onFormInput(e)');
    assert.match(body, new RegExp(`f === '${field}'`), `${name}: the price field must be handled in onFormInput`);
    assert.match(body, /priceSource = PRICE_MANUAL/, `${name}: typing a price must set PRICE_MANUAL`);
    assert.match(body, /clearVolume/, `${name}: typing a price must drop the volume claim (LAW 2)`);
  }
});

test('§10 every edit that changes what the ladder says triggers a re-quote', () => {
  for (const [name, code] of [['invoices.js', INVOICES_CODE], ['quick-order.js', QUICK_ORDER_CODE]]) {
    const input = fnBody(code, 'function onFormInput(e)');
    assert.match(input, /scheduleQuote\(\)/, `${name}: onFormInput must re-quote on code/qty/price`);
    const click = fnBody(code, 'function onFormClick(e)');
    assert.match(click, /add-line[\s\S]*?scheduleQuote\(\)/, `${name}: adding a line must re-quote`);
    assert.match(click, /remove-line[\s\S]*?scheduleQuote\(\)/, `${name}: removing a line must re-quote`);
    assert.match(code, /onPick[\s\S]{0,1400}?scheduleQuote\(\)/, `${name}: picking a product must re-quote`);
    assert.match(fnBody(code, 'function bindEditorBody(drawer)'), /scheduleQuote\(\)/,
      `${name}: opening the editor must quote once so the ladder is live immediately`);
  }
});

test('§10 removing a line drops the cached quote — positions have shifted', () => {
  for (const [name, code] of [['invoices.js', INVOICES_CODE], ['quick-order.js', QUICK_ORDER_CODE]]) {
    const click = fnBody(code, 'function onFormClick(e)');
    const removeBranch = click.slice(click.indexOf("'remove-line'"));
    assert.match(removeBranch.slice(0, 500), /_quote = null/,
      `${name}: a badge left on the wrong row after a splice is worse than no badge`);
  }
});

test('§10 the async-destroy and out-of-order guards are both present (ERR-045)', () => {
  for (const [name, code] of [['invoices.js', INVOICES_CODE], ['quick-order.js', QUICK_ORDER_CODE]]) {
    const body = fnBody(code, 'async function requestQuote()');
    assert.match(body, /editorAlive\(token\)/, `${name}: a closed drawer must never be written to`);
    assert.match(body, /seq !== _quoteSeq/,
      `${name}: replies land out of order and an older one carries an older quantity`);
  }
});

test('§10 a failed quote never clears a price or blanks the options', () => {
  const body = fnBody(INVOICES_CODE, 'async function requestQuote()');
  assert.match(body, /if \(!res\.ok\)/, 'the failure branch must exist');
  const failBranch = body.slice(body.indexOf('if (!res.ok)'), body.indexOf('if (!res.ok)') + 400);
  assert.equal(/_quote = null/.test(failBranch), false,
    'a rate limit or a blip must keep the last good quote, not blank the dropdown');
  assert.match(failBranch, /RATE_LIMITED/, 'a rate limit is distinguishable from an outage and says so');
});

test('§10 BOTH ends of the quick-order bridge whitelist carry the volume fields', () => {
  // ERR-150 was a parser of exactly this shape. Two whitelists, both hand-maintained.
  for (const field of ['volumePercent', 'volumeSaving', 'volumeQuantity']) {
    assert.match(stripComments(BRIDGE), new RegExp(`${field}:`),
      `quick-order-bridge.js buildQuickOrderPrefill drops ${field} — a bulk sale converted to `
      + 'an invoice would lose the discount it was quoted at');
    assert.match(fnBody(INVOICES_CODE, 'function maybeOpenFromQuickOrder()'), new RegExp(`${field}:`),
      `invoices.js maybeOpenFromQuickOrder drops ${field} on the receiving side`);
  }
});

test('§10 buildPayload sends the discount so the invoice can print it after a reload', () => {
  for (const [name, code] of [['invoices.js', INVOICES_CODE], ['quick-order.js', QUICK_ORDER_CODE]]) {
    const body = fnBody(code, 'function buildPayload(d)');
    assert.match(body, /volume_discount_percent/, `${name}: buildPayload must send the discount %`);
    assert.match(body, /volume_saving_excl_gst/, `${name}: buildPayload must send the line saving`);
  }
});

test('§10 the document prints the bulk note in BOTH renderers, from the same helper', () => {
  for (const fn of ['function renderPreview(d)', 'function buildInvoiceDoc(d)']) {
    const body = fnBody(INVOICES_CODE, fn);
    assert.match(body, /invoiceDocRows\(d, \{ money, note: lineDocNote \}\)/,
      `${fn} must take its rows — and its note — from the one projection`);
  }
  assert.match(fnBody(INVOICES_CODE, 'function renderPreview(d)'), /computeInvoiceVolumeSavings\(d\)/);
  assert.match(fnBody(INVOICES_CODE, 'function buildInvoiceDoc(d)'), /computeInvoiceVolumeSavings\(d\)/);
});

test('§10 the PDF folds the note into the description — it must NOT grow a column', () => {
  const body = fnBody(INVOICES_CODE, 'function buildInvoiceDoc(d)');
  assert.match(body, /\$\{description\}\\n\$\{bulkNote\}/,
    'autoTable derives its column count from the body rows, so a 5-cell row would silently '
    + 'make a 5-column table — the shape that would one day print our margin');
  // Belt and braces with admin-invoice-cost-not-on-document.test.js.
  const head = body.match(/head:\s*\[\[([^\]]*)\]\]/);
  assert.equal(head[1].split(',').filter((s) => s.trim()).length, 4);
});

test('§10 the AdminAPI method exists, is read-only, and separates its failures', () => {
  const body = fnBody(ADMIN_API, 'async quoteInvoice(body)');
  assert.match(body, /\/api\/admin\/invoices\/quote/);
  assert.match(body, /window\.API\.post/);
  assert.match(body, /resp\.code \|\| 'ERROR'/);
  assert.equal(/Toast\./.test(body), false,
    'a half-typed SKU must never raise a toast — the operator is mid-word');
});

test('§10 the freight INPUT is untouched: same data-field, same save path', () => {
  assert.match(INVOICES_CODE, /data-field="freight"/,
    'the typed freight box stays exactly as it was — the dropdown only writes into it');
  const payload = fnBody(INVOICES_CODE, 'function buildPayload(d)');
  assert.match(payload, /freight_excl_gst: round2\(num\(d\.freight\)\)/,
    'saving an invoice must not learn that a dropdown exists');
  assert.equal(/freight_option|freight_key|shipping_option/.test(payload), false,
    'the chosen option is deliberately NOT stored: buildPayload\'s key set is walked by '
    + 'setStatusViaFullUpdate() and diffed by documentDrift(), so a new key there changes '
    + 'the paid-toggle\'s full-record PUT');
});

test('§10 the line badge is a full-width grid child, never a seventh cell', () => {
  assert.match(ADMIN_CSS, /\.inv-line__note\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
    '.inv-line is a six-column grid SHARED with the Quick Order editor; a seventh cell '
    + 'would misalign every one of its rows');
  const grid = ADMIN_CSS.match(/\.inv-lines-head,\s*\.inv-line\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
  assert.equal(grid[1].trim().split(/\s+/).length, 6, 'and the grid itself must still declare six');
});

test('§10 every class the two editors render has a style', () => {
  const CLASSES = [
    'inv-freight', 'inv-freight__pick', 'inv-field--freightpick', 'inv-freight__note',
    'inv-freight__note--warn', 'inv-freight__free', 'inv-line__note',
    'inv-vol', 'inv-vol--applied', 'inv-vol--offer', 'inv-vol--warn',
    'inv-line__price--manual', 'inv-doc__line-note', 'inv-doc__savings',
  ];
  for (const c of CLASSES) {
    assert.ok(ADMIN_CSS.includes(`.${c}`), `admin.css is missing a rule for .${c}`);
  }
});

test('§10 the editors never do volume MATHS — they read the backend\'s figure', () => {
  // The standing rule: the frontend never computes a price. There is no ladder
  // interpreter in the admin and there must never be one.
  for (const [name, code] of [['invoices.js', INVOICES_CODE], ['quick-order.js', QUICK_ORDER_CODE]]) {
    assert.equal(/quantity_breaks|describeLadder|offerAtQuantity/.test(code), false,
      `${name}: the quote returns the finished figure — do not re-derive it`);
    // LAW 3. `volume_discount_percent` is the PAYLOAD field carrying the realised
    // figure we stamped on the line, so it is matched with a leading boundary that
    // excludes it — what must never appear is a read of the ladder's ceiling.
    assert.equal(/(?<![_a-z])discountPercent\b/i.test(code.replace(/volume_discount_percent/g, '')), false,
      `${name}: only effective_percent may be displayed (LAW 3), and volumeBadge already picks it`);
    assert.equal(/\.volume\.discount_percent|\bdiscount_percent\s*[,:)]/.test(code.replace(/volume_discount_percent/g, '')), false,
      `${name}: reading the ladder ceiling states a discount the customer did not get`);
  }
});
