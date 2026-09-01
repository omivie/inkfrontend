/**
 * Orders list — "Invoice sent" applies to invoiced sales ONLY (Sep 2026, ERR-199)
 * ==============================================================================
 *
 * THE HANDOFF THIS IMPLEMENTS DESCRIBES A BACKEND THAT DOES NOT EXIST YET.
 *
 * `readfirst/orders-invoice-sent-column-FE-handoff-sep2026.md` says
 * `GET /api/admin/orders` now ships `channel`, `invoice_id` and `invoice_sent`
 * per row, and that the column must read `invoice_sent` alone. Measured against
 * live production on 2026-09-01 (backend commit 01c29cba, `db: connected`):
 * all three are ABSENT — on the list, on the detail endpoint, and under every
 * opt-in param tried. `?channel=` is an accepted-and-ignored DECOY, returning
 * the full unfiltered set for `zzznope` (the ERR-151/173 family).
 *
 * That is not a reason to build nothing, and it is not a reason to build the
 * handoff literally either. Building it literally is the trap this whole file
 * exists to hold shut:
 *
 *   `invoice_sent` absent  =>  `undefined`
 *   `undefined !== null`   =>  TRUE
 *
 * so the handoff's own Rule 1 ("gate on `invoice_sent !== null`"), written out
 * as-is, marks EVERY website order applicable and prints an outstanding task on
 * all of them. And the obvious correction — `invoice_sent == null` — is worse:
 * it collapses ABSENT into NOT-APPLICABLE and blanks the entire column, which
 * looks EXACTLY like the handoff's §4 "after" table while being a dead feature.
 * A wrong answer that resembles the right one is the expensive kind.
 *
 * So absent, `null` and `{sent_at: null}` are three different claims and stay
 * three different states, the detection is `hasOwnProperty` and never
 * truthiness, and the page answers under whichever of two regimes is live:
 *
 *   SERVER  the key is on the row. Gate on `invoice_sent !== null`, ignore
 *           `channel` entirely, and issue NO lookup of any kind.
 *   LOCAL   the key is absent (today). The channel question is answered from
 *           `payment_method` — measured correct on 146 of 146 live orders —
 *           and the send record is read as it has been since ERR-175.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   §1  the three-way parse, with `undefined !== null` as its own named test
 *   §2  the ×N rule: a zero count beside a real date is UNKNOWN, not zero
 *   §3  the regime switch, including "SERVER never looks at channel" and
 *       "SERVER issues no Supabase read"
 *   §4  orderChannel() — handoff Rules 2 and 3, and the ladder underneath
 *   §5  the four renderers, and the resend that must NOT repopulate the column
 *   §6  one vocabulary with utils/send-history.js
 *   §7  POSITIVE CONTROL — the two literal readings of the handoff must FAIL
 *   §8  shipping hygiene
 *
 * Siblings: tests/admin-order-invoice-sent-aug2026.test.js (the Aug column, all
 * 62 subtests still green and untouched), tests/admin-invoice-send-count-aug2026.test.js
 * (the shared vocabulary), tests/admin-invoice-orders.test.js (the channel badge).
 * Live counterpart: `npm run probe:orders-invoice-sent`.
 *
 * Run with: node --test tests/admin-orders-invoice-sent-channel-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const READ = (p) => fs.readFileSync(p, 'utf8');

const SENT_UTIL = path.join(ADMIN, 'utils', 'order-invoice-sent.js');
const SHARED = path.join(ADMIN, 'utils', 'send-history.js');
const PROFIT_UTIL = path.join(ADMIN, 'utils', 'order-profit.js');
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');
const APP = path.join(ADMIN, 'app.js');
const ADMIN_CSS = path.join(ROOT, 'inkcartridges', 'css', 'admin.css');
const PROBE = path.join(ROOT, 'scripts', 'probe-orders-invoice-sent.mjs');
const PKG = path.join(ROOT, 'package.json');
const HANDOFF = path.join(ROOT, 'readfirst', 'orders-invoice-sent-column-FE-handoff-sep2026.md');

const ordersSrc = READ(ORDERS_PAGE);
const sentUtilSrc = READ(SENT_UTIL);
const profitUtilSrc = READ(PROFIT_UTIL);
const cssSrc = READ(ADMIN_CSS);

/**
 * The same stripEsm loader the sibling admin-util tests use. Objects built
 * inside a vm carry that context's prototypes, so compare shapes (via `plain`)
 * rather than identities.
 */
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
  stripped = stripped.replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*$/gm, '');
  stripped = stripped.replace(/export\s+\{[^}]*\}\s*;?/g, '');
  stripped = stripped.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  return stripped + '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
}

function loadModules(sentSource = READ(SENT_UTIL), profitSource = READ(PROFIT_UTIL)) {
  const sandbox = {
    console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp, Date,
    DebugLog: { warn() {}, log() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(stripEsm(READ(SHARED)), ctx, { filename: 'send-history.js' });
  vm.runInContext(stripEsm(sentSource), ctx, { filename: 'order-invoice-sent.js' });
  vm.runInContext(stripEsm(profitSource), ctx, { filename: 'order-profit.js' });
  return sandbox;
}

const M = loadModules();
const {
  SENT_STATE, SEND_REGIME, SEND_SOURCE,
  readServerInvoiceSent, orderSendRegime, resolveSentInfo,
  orderChannel, ORDER_CHANNEL, isInvoiceOrder,
} = M;

const plain = (v) => JSON.parse(JSON.stringify(v));

/** Slice a whole function body out of a source file, brace-matched. */
function functionBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces while scanning ${name}()`);
}

// A row exactly as live production returns it today: NO invoice_sent key at all.
const LIVE_WEB_ROW = Object.freeze({
  id: 'ord-1', order_number: '20260829000004', payment_method: null, status: 'processing',
});
const LIVE_INVOICE_ROW = Object.freeze({
  id: 'ord-2', order_number: 'INV-3277', payment_method: 'invoice', status: 'paid',
});

// ---------------------------------------------------------------------------
// §1  Absent, null and {sent_at:null} are three different claims
// ---------------------------------------------------------------------------

test('§1 readServerInvoiceSent — the three-way parse', async (t) => {

  // THE WHOLE BUG, as its own test. If this ever goes green against a
  // truthiness check, every website order grows a phantom outstanding task.
  await t.test('an ABSENT field is not a null one — and `undefined !== null` is TRUE', () => {
    assert.equal(undefined !== null, true,
      'the language fact this guard exists for: a literal Rule-1 gate passes on an absent field');
    const absent = readServerInvoiceSent(LIVE_WEB_ROW);
    assert.equal(absent.present, false, 'a row with no key puts the page in the LOCAL regime');
    assert.equal(absent.applicable, false);
    assert.equal('invoice_sent' in LIVE_WEB_ROW, false, 'the fixture must really lack the key');
  });

  await t.test('a key holding null is NOT applicable — the em-dash case', () => {
    const r = readServerInvoiceSent({ ...LIVE_WEB_ROW, channel: 'web', invoice_sent: null });
    assert.equal(r.present, true, 'the key is there, so the regime IS server');
    assert.equal(r.applicable, false);
    assert.equal(r.at, null);
  });

  await t.test('an explicit undefined VALUE on a present key is still the server regime', () => {
    // `{invoice_sent: undefined}` has the key. Reading it as "absent" would drop
    // the whole page back to the fallback over one sloppy row.
    const row = { ...LIVE_INVOICE_ROW, invoice_sent: undefined };
    assert.equal(readServerInvoiceSent(row).present, true);
    assert.equal(readServerInvoiceSent(row).applicable, false);
  });

  await t.test('{sent_at: null} APPLIES and is "not yet" — a real outstanding send', () => {
    const r = readServerInvoiceSent({
      ...LIVE_INVOICE_ROW, channel: 'invoice',
      invoice_sent: { sent_at: null, sent_count: 0, source: null },
    });
    assert.equal(r.present, true);
    assert.equal(r.applicable, true, 'this is the one the operator must still act on');
    assert.equal(r.at, null);
  });

  await t.test('a full record parses to a date, a count and a source', () => {
    const r = readServerInvoiceSent({
      ...LIVE_INVOICE_ROW, channel: 'invoice',
      invoice_sent: { sent_at: '2026-09-01T00:55:49.304Z', sent_count: 2, source: 'send_log' },
    });
    assert.equal(r.applicable, true);
    assert.equal(r.at, '2026-09-01T00:55:49.304Z');
    assert.equal(r.count, 2);
    assert.equal(r.countKnown, true);
    assert.equal(r.floor, false);
  });

  // A parse failure is "we could not read the answer". Rendering it as the
  // blank cell would assert "does not apply" from a shape we never understood.
  await t.test('a malformed value is FAILED, never the blank cell', () => {
    for (const junk of ['yes', 42, ['2026-09-01'], true]) {
      const r = readServerInvoiceSent({ ...LIVE_INVOICE_ROW, invoice_sent: junk });
      assert.equal(r.present, true, `${JSON.stringify(junk)}: the key is there`);
      assert.equal(r.malformed, true, `${JSON.stringify(junk)}: and unreadable`);
      const info = resolveSentInfo({ serverSent: r });
      assert.equal(info.state, SENT_STATE.FAILED,
        `${JSON.stringify(junk)} must render "Can't check", never an em-dash`);
    }
  });

  await t.test('junk input never throws', () => {
    for (const bad of [null, undefined, 0, '', 'x', []]) {
      assert.doesNotThrow(() => readServerInvoiceSent(bad));
      assert.equal(readServerInvoiceSent(bad).present, false);
    }
  });
});

// ---------------------------------------------------------------------------
// §2  ×N: a zero count beside a real date is UNKNOWN, not zero
// ---------------------------------------------------------------------------

test('§2 the count is a floor, and ×N only over a real tally', async (t) => {

  // The handoff's fourth row, and the exact bug ERR-180 shipped one page over:
  // `email_count: 0` next to a perfectly real `emailed_at` is a send that
  // predates the log, not a document sent zero times.
  await t.test('legacy_stamp: a date with sent_count 0 shows the date and NO ×N', () => {
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: '2026-07-27T02:10:07.587Z', sent_count: 0, source: 'legacy_stamp' },
      }),
    });
    assert.equal(info.state, SENT_STATE.SENT);
    assert.equal(info.countKnown, false, 'the count is UNKNOWN, so nothing may be printed from it');
    assert.equal(info.floor, true, 'and the wording has to admit that');
    assert.equal(info.count, 1, 'a date still proves at least one send — never 0');
  });

  await t.test('a zero count with NO legacy marker is unknown too', () => {
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: '2026-07-27T02:10:07.587Z', sent_count: 0, source: 'send_log' },
      }),
    });
    assert.equal(info.countKnown, false, '0 beside a date is never a real tally, whatever the source');
    assert.equal(info.count, 1);
  });

  await t.test('a legacy stamp with a positive count is STILL a floor', () => {
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: '2026-07-27T02:10:07.587Z', sent_count: 3, source: 'legacy_stamp' },
      }),
    });
    assert.equal(info.countKnown, false, 'legacy means sends exist that were never enumerated');
  });

  await t.test('send_log with a real count is known and exact', () => {
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: '2026-09-01T00:55:49.304Z', sent_count: 2, source: 'send_log' },
      }),
    });
    assert.equal(info.countKnown, true);
    assert.equal(info.floor, false);
    assert.equal(info.count, 2);
  });

  await t.test('a non-numeric count degrades to a floor of one, never NaN', () => {
    for (const n of [undefined, null, 'two', NaN, -3]) {
      const info = resolveSentInfo({
        serverSent: readServerInvoiceSent({
          invoice_sent: { sent_at: '2026-09-01T00:55:49.304Z', sent_count: n, source: 'send_log' },
        }),
      });
      assert.equal(info.count, 1, `sent_count ${JSON.stringify(n)}`);
      assert.equal(info.countKnown, false);
      assert.equal(Number.isNaN(info.count), false);
    }
  });

  // The renderer's half of the same rule.
  await t.test('the cell gates ×N on countKnown as hard as on n > 1', () => {
    const cell = functionBody(ordersSrc, 'sentCellHtml');
    assert.match(cell, /info\.countKnown && n > 1/,
      'sentCellHtml must require BOTH a real tally and more than one send before printing ×N');
    assert.match(cell, /order-sent__times/);
  });
});

// ---------------------------------------------------------------------------
// §3  The regime switch
// ---------------------------------------------------------------------------

test('§3 which regime answered, and what each one is allowed to read', async (t) => {

  await t.test('a page with no key anywhere is LOCAL', () => {
    assert.equal(orderSendRegime([LIVE_WEB_ROW, LIVE_INVOICE_ROW]), SEND_REGIME.LOCAL);
    assert.equal(orderSendRegime([]), SEND_REGIME.LOCAL);
    assert.equal(orderSendRegime(null), SEND_REGIME.LOCAL);
  });

  // ANY row carrying it means the deploy landed. Requiring ALL rows would drop
  // the page back to the fallback over one malformed row, silently changing
  // what every other cell on the page means.
  await t.test('ONE row carrying the key puts the whole page in SERVER', () => {
    assert.equal(orderSendRegime([LIVE_WEB_ROW, { ...LIVE_INVOICE_ROW, invoice_sent: null }]),
      SEND_REGIME.SERVER);
  });

  // Handoff Rule 1. The backend has already applied the channel rule; a second
  // application here is a second place to get it wrong.
  await t.test('SERVER ignores channel entirely — even a contradictory one', () => {
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        order_number: 'INV-3277', payment_method: 'invoice', channel: 'invoice',
        invoice_sent: null,
      }),
      // A caller wrongly insisting it applies must not be able to override the
      // backend's own answer.
      applicable: true,
    });
    assert.equal(info.state, SENT_STATE.NOT_APPLICABLE,
      'invoice_sent: null is the answer, whatever channel or payment_method say');
    assert.equal(info.regime, SEND_REGIME.SERVER);
  });

  await t.test('SERVER never consults the order_events scrape', () => {
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: null, sent_count: 0, source: null },
      }),
      // A whole page of our own notes, which §3 of the handoff retires.
      events: [
        { created_at: '2026-08-28T01:00:00Z', payload: { note: '[invoice-sent] x' } },
        { created_at: '2026-08-27T01:00:00Z', payload: { note: '[invoice-sent] x' } },
      ],
      invoice: { emailed_at: '2026-08-01T00:00:00Z', invoice_number: 3277 },
    });
    assert.equal(info.state, SENT_STATE.NOT_RECORDED, 'the backend said "never emailed" and wins');
    assert.deepEqual(plain(info.sends), [], 'not one scraped note leaked into the history');
    assert.equal(info.count, 0);
  });

  // LOCAL: the channel answer arrives as `applicable`, and an UNASKED question
  // is not the same as one asked and answered "no".
  await t.test('LOCAL blanks a row only when the channel rule actually said so', () => {
    assert.equal(resolveSentInfo({ applicable: false }).state, SENT_STATE.NOT_APPLICABLE);
    assert.equal(resolveSentInfo({ applicable: false }).regime, SEND_REGIME.LOCAL);
    // applicable omitted => nobody asked => the old behaviour, unchanged.
    assert.equal(resolveSentInfo({ invoice: null }).state, SENT_STATE.NO_INVOICE);
    assert.equal(resolveSentInfo({ invoice: { invoice_number: 1 } }).state, SENT_STATE.NOT_RECORDED);
  });

  // The Aug behaviour has to be bit-for-bit intact on the rows that still use it.
  await t.test('LOCAL on an invoice row is exactly the Aug 2026 behaviour', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: null, invoice_number: 3277 },
      events: [{ created_at: '2026-08-28T01:00:00Z', payload: { kind: 'invoice_sent' } }],
      applicable: true,
    });
    assert.equal(info.state, SENT_STATE.SENT);
    assert.equal(info.count, 1);
    assert.equal(info.at, '2026-08-28T01:00:00Z');
    assert.equal(info.regime, SEND_REGIME.LOCAL);
  });

  await t.test('a failed lookup still outranks an absence, under either regime', () => {
    assert.equal(resolveSentInfo({ applicable: true, invoiceFailed: true }).state, SENT_STATE.FAILED);
    assert.equal(resolveSentInfo({ applicable: true, eventFailed: true }).state, SENT_STATE.FAILED);
  });

  // The page-side half: SERVER must cost ZERO requests.
  await t.test('the page answers from the payload and skips the fan-out', () => {
    const fn = functionBody(ordersSrc, 'sentInfoWithoutLookup');
    assert.match(fn, /SEND_REGIME\.SERVER/, 'it has to branch on the regime');
    assert.match(fn, /readServerInvoiceSent\(row\)/);
    assert.match(fn, /orderChannel\(row\)/, 'and use the shared channel derivation for LOCAL');
    assert.match(fn, /return null/, 'and admit when a row genuinely needs a lookup');

    const hyd = functionBody(ordersSrc, 'hydrateInvoiceSent');
    assert.match(hyd, /const regime = orderSendRegime\(rows\)/,
      'the regime is decided ONCE per page, never per row');
    const iDirect = hyd.indexOf('sentInfoWithoutLookup');
    const iFetch = hyd.indexOf('getOrderInvoicesByOrderIds');
    assert.ok(iDirect > -1 && iFetch > -1);
    assert.ok(iDirect < iFetch, 'rows that answer for themselves must be settled before any fetch');
    assert.match(hyd, /if \(!todo\.length\) return;/,
      'a page with nothing left to look up must issue no request at all');
    assert.ok(hyd.indexOf('if (!todo.length) return;') < iFetch,
      'the early return has to come BEFORE the batched reads, or SERVER still costs two requests');
  });

  // Fail-soft must be LOUD: the fallback renders a perfectly plausible cell, so
  // the degradation is invisible from the screen alone.
  await t.test('the LOCAL fallback announces itself by name', () => {
    const hyd = functionBody(ordersSrc, 'hydrateInvoiceSent');
    assert.match(hyd, /DebugLog\?\.warn\?\./, 'a silent fallback is one nobody discovers');
    assert.match(hyd, /invoice_sent/, 'and it must name the missing field');
    assert.match(hyd, /probe:orders-invoice-sent/, 'and say how to check');
  });

  await t.test('the modal skips the invoice lookup it would only discard', () => {
    assert.match(ordersSrc, /const directSent = sentInfoWithoutLookup\(order, orderSendRegime\(\[order\]\)\);/);
    assert.match(ordersSrc, /directSent \? Promise\.resolve\(null\) : AdminAPI\.getOrderInvoicesByOrderIds/);
    assert.match(ordersSrc, /const sentInfo = directSent \|\| resolveSentInfo\(/);
  });
});

// ---------------------------------------------------------------------------
// §4  orderChannel — Rules 2 and 3, and the ladder underneath
// ---------------------------------------------------------------------------

test('§4 orderChannel is the one channel vocabulary', async (t) => {

  // Handoff Rule 2, stated as its own example in the handoff itself.
  await t.test('channel WINS over an INV- order number', () => {
    assert.equal(orderChannel({ order_number: 'INV-9999', channel: 'web' }), ORDER_CHANNEL.WEB);
    assert.equal(isInvoiceOrder({ order_number: 'INV-9999', channel: 'web' }), false);
    assert.equal(orderChannel({ order_number: '20260829000004', channel: 'invoice' }), ORDER_CHANNEL.INVOICE);
  });

  await t.test('channel WINS over payment_method too', () => {
    assert.equal(orderChannel({ payment_method: 'invoice', channel: 'web' }), ORDER_CHANNEL.WEB);
    assert.equal(orderChannel({ payment_method: 'stripe', channel: 'invoice' }), ORDER_CHANNEL.INVOICE);
  });

  await t.test('quick_order is its own channel, not a website order', () => {
    assert.equal(orderChannel({ channel: 'quick_order' }), ORDER_CHANNEL.QUICK_ORDER);
    assert.equal(isInvoiceOrder({ channel: 'quick_order' }), false,
      'a quick order is not an invoiced sale — it must not get the no-card-fee branch');
  });

  // Handoff Rule 3. Guessing "invoice" from an unknown string would put a
  // storefront order in the no-card-fee branch and overstate its profit.
  await t.test('an UNRECOGNISED channel reads as Website, never as invoice', () => {
    // Every one of these is paired with an INV- number AND payment_method
    // 'invoice', so a fallback that leaked through would answer INVOICE. Rule 3
    // says a channel the backend sent and we do not recognise is a Website
    // order: guessing "invoice" would put a storefront sale in the no-card-fee
    // branch and overstate its profit.
    for (const junk of ['pos', 'marketplace', 'zzznope', 'invoiced', 'web_order', 42, {}, []]) {
      assert.equal(
        orderChannel({ channel: junk, order_number: 'INV-3277', payment_method: 'invoice' }),
        ORDER_CHANNEL.WEB,
        `channel=${JSON.stringify(junk)} must read as Website`,
      );
    }
    // Casing and stray whitespace are NOT "unrecognised" — they are the same value.
    assert.equal(orderChannel({ channel: 'INVOICE' }), ORDER_CHANNEL.INVOICE, 'case is not the test');
    assert.equal(orderChannel({ channel: ' invoice ' }), ORDER_CHANNEL.INVOICE, 'nor is whitespace');
    assert.equal(orderChannel({ channel: 'Quick_Order' }), ORDER_CHANNEL.QUICK_ORDER);
  });

  // With `channel` absent — which is every live row today — this ladder IS the
  // feature. Removing it would be a behaviour change, not a cleanup (ERR-158).
  await t.test('with channel absent, payment_method decides — the live shape', () => {
    assert.equal(orderChannel(LIVE_INVOICE_ROW), ORDER_CHANNEL.INVOICE,
      'payment_method "invoice" on all 15 live INV- orders');
    assert.equal(orderChannel(LIVE_WEB_ROW), ORDER_CHANNEL.WEB,
      'payment_method null on all 131 live website orders');
  });

  await t.test('with both absent, the order number is the last resort', () => {
    assert.equal(orderChannel({ order_number: 'INV-3277' }), ORDER_CHANNEL.INVOICE);
    assert.equal(orderChannel({ order_number: 'inv-3277' }), ORDER_CHANNEL.INVOICE, 'case-insensitive');
    assert.equal(orderChannel({ order_number: '20260829000004' }), ORDER_CHANNEL.WEB);
  });

  await t.test('a non-invoice payment_method never falls THROUGH to the prefix', () => {
    // The ladder is ordered, not a search for any branch that says "invoice".
    assert.equal(orderChannel({ payment_method: 'stripe', order_number: 'INV-9999' }), ORDER_CHANNEL.WEB);
  });

  await t.test('null-safe, and defaults to Website', () => {
    for (const bad of [null, undefined, 0, '']) assert.equal(orderChannel(bad), ORDER_CHANNEL.WEB);
    assert.equal(isInvoiceOrder(null), false);
  });

  await t.test('isInvoiceOrder is defined ONCE, in terms of orderChannel', () => {
    assert.match(profitUtilSrc, /export function orderChannel\(/);
    assert.match(profitUtilSrc, /return orderChannel\(o\) === ORDER_CHANNEL\.INVOICE;/,
      'the money rule and the column rule must be the same derivation, not two copies');
    assert.equal((profitUtilSrc.match(/export function isInvoiceOrder\(/g) || []).length, 1);
  });

  await t.test('the badge reads the same vocabulary and covers all three', () => {
    const badge = functionBody(ordersSrc, 'channelBadge');
    assert.match(badge, /orderChannel\(o\)/, 'no prefix-sniffing left in the badge');
    assert.doesNotMatch(badge, /INV-/, 'the order number is not the badge’s business');
    for (const cls of ['admin-badge--invoice', 'admin-badge--web', 'admin-badge--quick']) {
      assert.ok(ordersSrc.includes(cls), `${cls} must exist`);
      assert.ok(cssSrc.includes('.' + cls), `${cls} must be styled`);
    }
    assert.match(cssSrc, /--violet-text:\s*#6d28d9/, 'and legible on the light deck too');
  });
});

// ---------------------------------------------------------------------------
// §5  The renderers, and the resend that must not repopulate the column
// ---------------------------------------------------------------------------

test('§5 four states, four cells, and no accidental blank', async (t) => {

  await t.test('NOT_APPLICABLE is an inert span, never the history button', () => {
    const cell = functionBody(ordersSrc, 'sentCellHtml');
    const na = cell.slice(cell.indexOf('NOT_APPLICABLE'));
    const naBranch = na.slice(0, na.indexOf('if (info.state === SENT_STATE.SENT)'));
    assert.match(naBranch, /order-sent--na/);
    assert.match(naBranch, /\$\{MISSING\}/, 'it renders the em-dash');
    assert.doesNotMatch(naBranch, /<button/, 'there is no history behind an em-dash to open');
    assert.doesNotMatch(naBranch, /sent-history/);
  });

  await t.test('the blank cell carries a sentence saying WHY it is blank', () => {
    assert.match(ordersSrc, /\[SENT_STATE\.NOT_APPLICABLE\]:/, 'NOT_APPLICABLE needs its own tooltip');
    const tip = ordersSrc.slice(ordersSrc.indexOf('[SENT_STATE.NOT_APPLICABLE]:'));
    const body = tip.slice(0, tip.indexOf('});'));
    assert.match(body, /not an invoiced sale/i);
    assert.match(body, /receipt/i, 'and says what DID go to the customer');
    assert.match(body, /no such task/i, 'and that blank is not "nothing was sent"');
  });

  // Two regimes, two words. This is how an operator can see which answer they
  // are being given without reading the source.
  await t.test('"Not sent" and "Not recorded" are different words for different claims', () => {
    assert.match(ordersSrc, /NOT_RECORDED_COPY/);
    assert.match(ordersSrc, /\[SEND_REGIME\.SERVER\]: \{\s*\n\s*label: 'Not sent'/);
    assert.match(ordersSrc, /\[SEND_REGIME\.LOCAL\]: \{\s*\n\s*label: 'Not recorded'/);
    const cell = functionBody(ordersSrc, 'sentCellHtml');
    assert.match(cell, /NOT_RECORDED_COPY\[info\.regime\]/);
    assert.match(cell, /\|\| NOT_RECORDED_COPY\[SEND_REGIME\.LOCAL\]/,
      'and an unknown regime must fall to the humbler of the two claims');
  });

  await t.test('the LOCAL "not recorded" tooltip names the Invoices-page gap', () => {
    const tip = ordersSrc.slice(ordersSrc.indexOf('[SENT_STATE.NOT_RECORDED]:'));
    const body = tip.slice(0, tip.indexOf('[SENT_STATE.NO_INVOICE]:'));
    assert.match(body, /Invoices page/,
      'the sends we cannot see are the ones that matter — say so');
    assert.match(body, /invoice_id/, 'and name the backend field that would close it');
  });

  await t.test('the history panel answers the not-applicable row too', () => {
    const fn = functionBody(ordersSrc, 'renderOrderSendHistory');
    assert.match(fn, /NOT_APPLICABLE/);
    assert.match(fn, /was not invoiced/i);
    // The Aug invariant, unchanged: a read error is answered before ANY branch
    // that renders "nothing to show".
    assert.ok(fn.indexOf('inv-hist__error') < fn.indexOf('inv-hist__empty'),
      'a failed read must never fall through to an empty-looking panel');
  });

  await t.test('the panel tells the truth about WHICH sends it cannot list', () => {
    const fn = functionBody(ordersSrc, 'renderOrderSendHistory');
    assert.match(fn, /SEND_REGIME\.SERVER/, 'the caveat differs by regime');
    assert.match(fn, /send log/i, 'SERVER: only pre-log sends are unenumerable');
    assert.match(fn, /Invoices page/, 'LOCAL: a whole surface is invisible');
  });

  // BOTH OF THESE WERE FOUND IN THE BROWSER, NOT BY A TEST — the unit suite was
  // green while the panel and the modal each printed a sentence that was not
  // true. They are pinned here so they cannot come back.

  await t.test('a send the BACKEND logged is not captioned as one we resent', () => {
    // `source` answers WHO SENT IT and is the same vocabulary under both
    // regimes; `sourceKind` carries the handoff's diagnostic. Folding the two
    // into one field shipped "recorded when resent from this page" over a send
    // the backend had logged — a claim about the operator, made from a field
    // describing the record.
    const info = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: '2026-08-31T05:21:33Z', sent_count: 1, source: 'send_log' },
      }),
    });
    assert.equal(info.source, 'server', 'the backend sent it, so the attribution is the backend');
    assert.equal(info.sourceKind, 'send_log', 'and the diagnostic keeps its own key');
    assert.notEqual(info.source, 'send_log', 'the diagnostic must never reach the attribution');
    assert.notEqual(info.source, 'admin');

    // Same for a legacy stamp: still the backend's record, not ours.
    const legacy = resolveSentInfo({
      serverSent: readServerInvoiceSent({
        invoice_sent: { sent_at: '2026-07-27T00:55:49Z', sent_count: 0, source: 'legacy_stamp' },
      }),
    });
    assert.equal(legacy.source, 'server');
    assert.equal(legacy.sourceKind, 'legacy_stamp');

    // And a LOCAL send we made ourselves is still attributed to us.
    const local = resolveSentInfo({
      invoice: { emailed_at: null, invoice_number: 1 },
      events: [{ created_at: '2026-08-28T01:00:00Z', payload: { kind: 'invoice_sent' } }],
      applicable: true,
    });
    assert.equal(local.source, 'admin');
    assert.equal(local.sourceKind, null, 'the LOCAL regime has no send-log diagnostic to report');

    // Every return carries the key, so no renderer has to guard on its presence.
    for (const info2 of [
      resolveSentInfo({ applicable: false }),
      resolveSentInfo({ serverSent: readServerInvoiceSent({ invoice_sent: null }) }),
      resolveSentInfo({ applicable: true, eventFailed: true }),
    ]) {
      assert.ok('sourceKind' in info2, 'every result must have the same shape');
    }

    // The handoff: "source is diagnostic. Use it only to decide whether to
    // append ×N; don't surface the string."
    for (const kind of ['send_log', 'legacy_stamp']) {
      assert.ok(!ordersSrc.includes(`'${kind}'`), `orders.js must never render the ${kind} string`);
    }
  });

  await t.test('the panel does not blame the send log for a count it can explain', () => {
    // A `send_log` count of 2 is a KNOWN tally that the field can only show one
    // timestamp for. Captioning it "the rest predate the send log" invents a
    // reason. That sentence belongs to `floor` alone.
    const fn = functionBody(ordersSrc, 'renderOrderSendHistory');
    assert.match(fn, /most recent send and a total/,
      'the SERVER caveat must explain the field’s SHAPE, which is the real limit');
    assert.match(fn, /info\?\.floor \?/,
      'and the pre-log sentence must be conditional on floor, not printed unconditionally');
    // The cut line fires on the count alone. `|| info.floor` printed
    // "1 recorded send or more — more than the one listed" over ONE listed send.
    assert.match(fn, /info\.count > sends\.length/);
    assert.doesNotMatch(fn, /info\.floor \|\| info\.count > sends\.length/,
      'a floor with nothing unlisted must not claim there is something unlisted');
  });

  await t.test('the modal spells the em-dash out, rather than printing a bare dash', () => {
    const fn = functionBody(ordersSrc, 'modalSentValue');
    assert.match(fn, /NOT_APPLICABLE/);
    assert.match(fn, /not an invoiced sale/);
    assert.match(fn, /SEND_REGIME\.SERVER/, 'and distinguishes "Not sent" from "Not recorded"');
  });

  // The handoff's own worked example: 20260827000003 losing its "28 Aug ×2" is
  // CORRECT, because those were receipt resends. So the resend must not put it
  // back the moment an operator uses the button.
  await t.test('a receipt resend on a website row does NOT repopulate the column', () => {
    assert.match(ordersSrc, /const stillNotApplicable = \(sentInfoWithoutLookup\(/,
      'the resend path has to ask whether this column applies at all');
    assert.match(ordersSrc, /if \(recordedAt && stillNotApplicable\) \{/);
    const branch = ordersSrc.slice(ordersSrc.indexOf('if (recordedAt && stillNotApplicable) {'));
    const body = branch.slice(0, branch.indexOf('} else if (recordedAt) {'));
    assert.doesNotMatch(body, /_sentCache\.set/, 'the cell must be left exactly as it was');
    assert.doesNotMatch(body, /patchSentCell/);
    assert.match(body, /Toast\.success/, 'but the operator is still told the email went out');
    assert.match(body, /stays blank/, 'and told why the column did not move');
  });

  await t.test('the resend button itself is NOT hidden on a website order', () => {
    // Resending a customer their receipt is a real thing an operator does, and
    // this endpoint has always done it. Removing the control would be a
    // regression dressed as a fix (ERR-158).
    assert.match(ordersSrc, /data-action="resend-invoice"/);
    const btns = ordersSrc.slice(ordersSrc.indexOf('const btns = ['));
    const list = btns.slice(0, btns.indexOf('];'));
    assert.match(list, /resend-invoice/, 'still in the unconditional button list');
  });

  await t.test('the resend rebuild uses the shared sentinel, not a string literal', () => {
    assert.doesNotMatch(ordersSrc, /payload: \{ kind: 'invoice_sent' \}/,
      'a hardcoded kind drifts silently the day INVOICE_SENT_KIND changes');
    assert.match(ordersSrc, /payload: \{ kind: INVOICE_SENT_KIND \}/);
  });
});

// ---------------------------------------------------------------------------
// §6  One vocabulary
// ---------------------------------------------------------------------------

test('§6 the count is described in one set of words', async (t) => {
  await t.test('orders.js uses the shared phrase builder', () => {
    assert.match(ordersSrc, /import \{ recordedSendsPhrase \} from '\.\.\/utils\/send-history\.js';/);
    assert.match(ordersSrc, /recordedSendsPhrase\(/);
  });

  await t.test('neither the page nor the util claims a total', () => {
    for (const [name, src] of [['orders.js', ordersSrc], ['order-invoice-sent.js', sentUtilSrc]]) {
      assert.doesNotMatch(src, /sent \$\{[^}]*\} times/, `${name} must not present a count as a total`);
    }
  });

  await t.test('the util still imports mergeSends rather than re-deriving it', () => {
    assert.match(sentUtilSrc, /import \{ mergeSends \} from '\.\/send-history\.js';/);
    assert.doesNotMatch(sentUtilSrc, /^const SAME_SEND_MS/m);
  });

  await t.test('every state in the enum is rendered somewhere', () => {
    const cell = functionBody(ordersSrc, 'sentCellHtml');
    for (const key of Object.keys(SENT_STATE)) {
      assert.ok(cell.includes(`SENT_STATE.${key}`) || key === 'NO_INVOICE',
        `SENT_STATE.${key} has no branch in sentCellHtml`);
    }
    // NO_INVOICE falls to the shared "we looked and found nothing" tail, which
    // must therefore still carry a tooltip for it.
    assert.match(ordersSrc, /\[SENT_STATE\.NO_INVOICE\]:/);
  });
});

// ---------------------------------------------------------------------------
// §7  POSITIVE CONTROL — the two literal readings of the handoff must FAIL
// ---------------------------------------------------------------------------

test('§7 POSITIVE CONTROL — a naive Rule-1 gate must break on live data', async (t) => {

  // Without these, a parse that silently stopped distinguishing the three cases
  // would go green: every assertion above would still pass against a module that
  // treats absent and null identically, because none of them would be reached.

  await t.test('reading Rule 1 literally marks every website order applicable', () => {
    // `invoice_sent !== null`, exactly as §2 words it, against the row live
    // production actually returns.
    const naive = (o) => o.invoice_sent !== null;
    assert.equal(naive(LIVE_WEB_ROW), true,
      'the naive gate says a website checkout has an outstanding invoice send');
    // And the shipped parse does not.
    assert.equal(resolveSentInfo({
      serverSent: readServerInvoiceSent(LIVE_WEB_ROW),
      applicable: false,
    }).state, SENT_STATE.NOT_APPLICABLE);
  });

  await t.test('"fixing" it with == null blanks the column and looks correct', () => {
    const looseGate = (o) => o.invoice_sent == null;   // absent AND null both true
    assert.equal(looseGate(LIVE_WEB_ROW), true, 'website row: blank — right answer');
    assert.equal(looseGate(LIVE_INVOICE_ROW), true,
      'INVOICE row: ALSO blank — the whole column dead, and indistinguishable from working');
    // The shipped code keeps them apart.
    assert.equal(readServerInvoiceSent(LIVE_WEB_ROW).present, false, 'absent');
    assert.equal(readServerInvoiceSent({ invoice_sent: null }).present, true, 'null');
  });

  await t.test('a truthiness check on the key cannot see the not-applicable case', () => {
    // `if (o.invoice_sent)` — the third way to write it, and it folds
    // "not applicable" into "no data" with no way to tell them apart.
    assert.equal(Boolean(LIVE_WEB_ROW.invoice_sent), false);
    assert.equal(Boolean({ invoice_sent: null }.invoice_sent), false);
    assert.notEqual(
      readServerInvoiceSent(LIVE_WEB_ROW).present,
      readServerInvoiceSent({ invoice_sent: null }).present,
      'the shipped parse distinguishes exactly what truthiness cannot',
    );
  });

  await t.test('the shipped detection is hasOwnProperty, not a value comparison', () => {
    assert.match(sentUtilSrc, /Object\.prototype\.hasOwnProperty\.call\(order, 'invoice_sent'\)/);
    assert.match(sentUtilSrc, /Object\.prototype\.hasOwnProperty\.call\(row, 'invoice_sent'\)/);
  });

  // A deliberately-broken module, run through the real loader. If the checks
  // above are not checking, this passes and the control fails loudly.
  await t.test('a module that collapses absent into null fails §1', () => {
    const broken = READ(SENT_UTIL).replace(
      "if (!Object.prototype.hasOwnProperty.call(order, 'invoice_sent')) return absent;",
      "if (order.invoice_sent == null) return absent;",
    );
    assert.notEqual(broken, READ(SENT_UTIL), 'the control fixture stopped being a modification');
    const bad = loadModules(broken);
    assert.equal(bad.readServerInvoiceSent({ invoice_sent: null }).present, false,
      'the broken build reports a null field as absent — which is the bug');
    assert.equal(M.readServerInvoiceSent({ invoice_sent: null }).present, true,
      'and the shipped build does not');
  });
});

// ---------------------------------------------------------------------------
// §8  Shipping hygiene
// ---------------------------------------------------------------------------

test('§8 the edited modules are actually re-fetched, and the probe is safe', async (t) => {

  await t.test('APP_VERSION advanced', () => {
    const m = READ(APP).match(/const APP_VERSION = '([^']+)'/);
    assert.ok(m, 'APP_VERSION must exist');
    assert.notEqual(m[1], '2026.09.01-invoice-header-total-spacing',
      'a page-module edit that does not bump APP_VERSION ships to a cached browser');
  });

  // ERR-124: a `?v=` on a static import is a cache key the build never restamps.
  await t.test('no ?v= token on a static import', () => {
    for (const [name, src] of [
      ['orders.js', ordersSrc], ['order-invoice-sent.js', sentUtilSrc], ['order-profit.js', profitUtilSrc],
    ]) {
      assert.doesNotMatch(src, /^import[^\n]*\?v=/m, `${name} must not pin a version on a static import`);
    }
  });

  await t.test('the inbound handoff is filed where the next reader will find it', () => {
    assert.ok(fs.existsSync(HANDOFF), 'readfirst/orders-invoice-sent-column-FE-handoff-sep2026.md');
  });

  await t.test('the probe exists, is wired up, and is READ-ONLY', () => {
    assert.ok(fs.existsSync(PROBE), 'scripts/probe-orders-invoice-sent.mjs must exist');
    const probe = READ(PROBE);
    assert.match(probe, /MODE: READ-ONLY/, 'the mode is printed, never assumed');
    // Not "does the string --record appear" — the docblock says at length that
    // there ISN'T one, and a check that forbids naming the hazard is a check
    // that forbids documenting it. Forbid the MECHANISM instead: a record mode
    // needs a flag read off argv, and a write needs a write call.
    assert.doesNotMatch(probe, /process\.argv/,
      'this probe takes no flags at all — a probe that can record may be green because it '
      + 'overwrote what it was comparing against (sweep:b2b, 2026-08-12)');
    for (const write of ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'mkdirSync', 'unlinkSync']) {
      assert.ok(!probe.includes(write), `${write} — this probe must write nothing, anywhere`);
    }
    for (const verb of ['PUT', 'PATCH', 'DELETE']) {
      assert.doesNotMatch(probe, new RegExp(`method:\\s*'${verb}'`), `${verb} has no business here`);
    }
    // Exactly one POST: the admin sign-in.
    assert.equal((probe.match(/method:\s*'POST'/g) || []).length, 1,
      'the only POST may be the sign-in');
    assert.match(READ(PKG), /"probe:orders-invoice-sent":/, 'and it needs an npm script');
  });

  await t.test('the probe is NOT under the publicly-served tree', () => {
    // inkcartridges/ is the Vercel output directory. A file there that reads
    // .env is one URL away from the internet.
    assert.equal(fs.existsSync(path.join(ROOT, 'inkcartridges', 'scripts', 'probe-orders-invoice-sent.mjs')),
      false);
  });
});
