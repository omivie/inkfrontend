/**
 * "Courier rates unavailable" on an invoice nobody had typed into yet — ERR-191
 * ============================================================================
 *
 * Opening New Invoice showed a red note beside the freight box:
 *
 *     Courier rates unavailable — type the freight manually.
 *
 * The rates were not unavailable. `npm run probe:invoice-quote` was 17/17 against
 * production at the time, check 4 reporting eight live shipping options. What the
 * operator was looking at was the editor describing a request it had DECIDED NOT
 * TO MAKE, in the words reserved for one that had failed.
 *
 * `_quoteStatus` has five values — idle | loading | ready | limited | unavailable
 * — and renderShippingRow() had three branches: loading, limited, and an `else`
 * that assumed failure. `idle` fell through it. And `idle` is not a flicker on
 * that page: quoteRequestBody() returns null until some line has a code or a
 * description (deliberately — "a quote would say nothing"), and requestQuote()
 * returned without touching the status, so the warning was the FIRST PAINT of
 * every New Invoice and stayed until something was typed.
 *
 * THE RULE. A skip is not a failure. This log has the inverse rule written down
 * a dozen times — a fail-soft must be loud — and this is its mirror: a state
 * machine's renderer needs a branch per state, because an `else` that assumes the
 * bad case will eventually describe a case that is fine. It is not cosmetic. The
 * same string covers a 5xx, an auth failure, a CORS error and an unparseable
 * payload, none of which surface anything else (js/admin/api.js only writes a
 * DebugLog line), so an operator who learns to ignore it on every empty invoice
 * has been trained to ignore it when it is true.
 *
 * What this file pins:
 *
 *   §1  THE BUG. idle says we have not asked, in words that name what to do, and
 *       says nothing about anything being unavailable.
 *   §2  THE POSITIVE CONTROL. A real failure still says "unavailable", verbatim
 *       — including the shape that produced it: a 200 whose payload has lines but
 *       no shipping block. A test that only proved the red text was gone would
 *       pass just as well if the fix had deleted the warning outright.
 *   §3  THE OTHER STATES ARE UNTOUCHED, and a good quote keeps its dropdown
 *       through a later failure ("keep the last good quote").
 *   §4  WIRING. The page actually calls the resolver, does not paint idle as an
 *       alarm, and every place that drops the quote drops the status with it.
 *
 * Run: node --test tests/admin-invoice-freight-idle-state-aug2026.test.js
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
  shippingRowState, normalizeQuote,
  QUOTE_IDLE, QUOTE_LOADING, QUOTE_READY, QUOTE_LIMITED, QUOTE_UNAVAILABLE,
  SHIPPING_ROW_IDLE, SHIPPING_ROW_LOADING, SHIPPING_ROW_LIMITED,
  SHIPPING_ROW_UNAVAILABLE, SHIPPING_ROW_OPTIONS,
} = sandbox;

// A quote with real options, in the shape normalizeQuote() produces.
const GOOD_QUOTE = normalizeQuote({
  lines: [{ position: 0, product_code: 'GLC73BK', resolved: true, quantity: 1, unit_excl_gst: 56.95 }],
  shipping: {
    weight_kg: 0.7,
    goods_total_incl_gst: 65.49,
    free_shipping_threshold: 100,
    free_shipping_eligible: false,
    suggested_key: 'auckland:urban',
    options: [
      { key: 'pickup', label: 'Pickup', freight_excl_gst: 0 },
      { key: 'auckland:urban', label: 'Auckland urban', freight_excl_gst: 6.09, fee_incl_gst: 7 },
    ],
  },
});

// ── §1 The bug ──────────────────────────────────────────────────────────────

test('§1 idle is its own state, not a failure', () => {
  const state = shippingRowState(null, QUOTE_IDLE);
  assert.equal(state.kind, SHIPPING_ROW_IDLE);
  assert.notEqual(state.kind, SHIPPING_ROW_UNAVAILABLE);
});

test('§1 the idle message claims nothing is wrong', () => {
  const { message } = shippingRowState(null, QUOTE_IDLE);
  assert.ok(message, 'idle must still SAY something — an empty row explains nothing');
  assert.doesNotMatch(message, /unavailable/i);
  assert.doesNotMatch(message, /rate limit/i);
  assert.doesNotMatch(message, /manually/i, 'nothing has failed, so do not send them to the fallback');
});

test('§1 the idle message names the condition that ends it', () => {
  const { message } = shippingRowState(null, QUOTE_IDLE);
  // quoteRequestBody()'s hasContent is `code || description` — that IS the
  // condition, and the note is only useful if it says so.
  assert.match(message, /code/i);
  assert.match(message, /description/i);
});

test('§1 a blank editor is idle, which is where the bug lived', () => {
  // Nothing has been asked and nothing has come back: exactly the state
  // bindEditorBody() paints in before scheduleQuote() has fired.
  assert.equal(shippingRowState(null, QUOTE_IDLE).kind, SHIPPING_ROW_IDLE);
});

// ── §2 The positive control ─────────────────────────────────────────────────

test('§2 a real failure still says unavailable, verbatim', () => {
  const state = shippingRowState(null, QUOTE_UNAVAILABLE);
  assert.equal(state.kind, SHIPPING_ROW_UNAVAILABLE);
  assert.equal(state.message, 'Courier rates unavailable — type the freight manually.');
});

test('§2 a 200 with lines but NO shipping block is unavailable, not idle', () => {
  // hasOptions is false here, and that is the distinction normalizeQuote exists
  // to keep: an absent `options` means "we could not read the rates", which is a
  // different sentence from "there are no rates".
  const quote = normalizeQuote({ lines: [{ position: 0, quantity: 1 }] });
  assert.equal(quote.shipping.hasOptions, false);
  assert.equal(shippingRowState(quote, QUOTE_READY).kind, SHIPPING_ROW_UNAVAILABLE);
});

test('§2 an unknown status is treated as a failure, not as idle', () => {
  // The safe direction for a value nobody planned for: over-report, never
  // under-report. Only the states we actually set may be calm.
  assert.equal(shippingRowState(null, 'something-new').kind, SHIPPING_ROW_UNAVAILABLE);
  assert.equal(shippingRowState(null, undefined).kind, SHIPPING_ROW_UNAVAILABLE);
});

// ── §3 The other states are untouched ───────────────────────────────────────

test('§3 loading and limited keep their own words', () => {
  assert.equal(shippingRowState(null, QUOTE_LOADING).kind, SHIPPING_ROW_LOADING);
  assert.match(shippingRowState(null, QUOTE_LOADING).message, /Checking courier rates/);

  const limited = shippingRowState(null, QUOTE_LIMITED);
  assert.equal(limited.kind, SHIPPING_ROW_LIMITED);
  assert.equal(limited.message, 'Rate limit reached — courier rates will refresh shortly.');
});

test('§3 options win, and a good quote survives a later failure', () => {
  assert.equal(shippingRowState(GOOD_QUOTE, QUOTE_READY).kind, SHIPPING_ROW_OPTIONS);
  // requestQuote() deliberately keeps the last good quote through a blip or a
  // 429 — the dropdown must not blank under the operator.
  for (const status of [QUOTE_LOADING, QUOTE_LIMITED, QUOTE_UNAVAILABLE, QUOTE_IDLE]) {
    assert.equal(shippingRowState(GOOD_QUOTE, status).kind, SHIPPING_ROW_OPTIONS,
      `a good quote must keep its dropdown while status is ${status}`);
  }
});

test('§3 the OPTIONS state carries no message — the caller renders a <select>', () => {
  assert.equal(shippingRowState(GOOD_QUOTE, QUOTE_READY).message, '');
});

// ── §4 Wiring ───────────────────────────────────────────────────────────────
// Comments explain; only code counts when asserting that something is WIRED.

test('§4 renderShippingRow asks the resolver instead of inlining the words', () => {
  const fn = INVOICES.slice(INVOICES.indexOf('function renderShippingRow()'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /shippingRowState\(_quote,\s*_quoteStatus\)/);
  // The literals must live in exactly one file now.
  assert.ok(!body.includes("'Courier rates unavailable"),
    'the message belongs to shippingRowState(), or the two copies will drift');
});

test('§4 idle is NOT painted as an alarm', () => {
  const fn = INVOICES.slice(INVOICES.indexOf('function renderShippingRow()'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  // The --warn class is what makes the note red. It must be conditional, and the
  // calm states must be the ones that skip it.
  assert.match(body, /SHIPPING_ROW_IDLE\s*\|\|[^;]*SHIPPING_ROW_LOADING/);
  assert.match(body, /calm\s*\?\s*''\s*:\s*' inv-freight__note--warn'/);
});

test('§4 the skipped request declares idle rather than leaving a stale status', () => {
  const fn = INVOICES.slice(INVOICES.indexOf('async function requestQuote()'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /if\s*\(!req\)\s*\{/, 'the early return must be a block that can set state');
  assert.match(body, /if\s*\(!_quote\)\s*\{\s*_quoteStatus\s*=\s*QUOTE_IDLE;\s*renderShippingRow\(\);\s*\}/);
});

test('§4 every site that drops the quote drops the status with it', () => {
  // ERR-160's lesson: "every place that does X" is a list nobody maintains, so
  // it goes in a test. `_quote = null` beside a stale 'ready' is the state that
  // renders a failure for a quote that is merely gone.
  const lines = INVOICES.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/(^|[^.\w])_quote = null/.test(line)) return;
    if (/^let _quote = null/.test(line.trim())) return;   // the declaration
    const window = lines.slice(i, i + 3).join('\n');      // same line or the next two
    if (!/_quoteStatus\s*=\s*QUOTE_IDLE/.test(window)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [], 'these drop _quote without resetting _quoteStatus');
});

test('§4 the page compares the status against the shared constants, never a literal', () => {
  // A bare string here is how a state ends up matching no branch and falling
  // through to the failure copy — the ERR-191 shape, one layer up.
  const bad = INVOICES.match(/_quoteStatus\s*(===|!==|=)\s*'[a-z]+'/g) || [];
  assert.deepEqual(bad, []);
});
