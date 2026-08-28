/**
 * Invoices list — the SENT column counts RESENDS (Aug 2026)
 * =========================================================
 *
 * The column has shown a green check and a date since July 2026, and `×N` past
 * one send. Live, `×N` had never once rendered — and could not, in the case
 * that matters most.
 *
 * WHAT WAS BROKEN
 * ---------------
 * 1. `sentInfo()` returned the server record and STOPPED. The local-backstop
 *    branch below it was unreachable for any row the server had stamped, so a
 *    resend this browser had just made could not raise the number — while
 *    `writeSent()` dutifully incremented a count nothing read. That is the
 *    ERR-177 finding applied to this page: collapse at the point of DISPLAY,
 *    not at the point of READ.
 *
 * 2. Five of the thirteen live invoices carry a real `emailed_at` next to
 *    `email_count: 0` — sends made before the log table existed (probed
 *    2026-08-28: 3267, 3266, 3265, 3264, 3263). Resend one and the backend
 *    logs it, so `email_count` goes 0 → 1, `count > 1` stays false, and THE
 *    CELL RENDERS IDENTICALLY BEFORE AND AFTER THE RESEND. The one column
 *    whose job is to show a resend could not show that one.
 *
 * 3. The tooltip said "sent 4 times". Nothing on this page can know a total:
 *    the pre-log sends were never enumerated. The Orders column has said
 *    "N recorded sends" since ERR-177 and never that; two pages on one admin
 *    must not describe the same fact in two vocabularies (ERR-120/129/143).
 *
 * WHAT PINS IT
 * ------------
 * `utils/send-history.js` now holds the arithmetic and the wording both admin
 * pages agree on. pages/orders.js still spells the phrase inline — its own
 * test greps the literal — so §4 here pins the two against each other, which
 * is the only reason a shared module is worth having.
 *
 * See tests/admin-invoice-sent-indicator.test.js (the July contract, still
 * green) and tests/admin-order-invoice-sent-aug2026.test.js (the Orders side).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
// Objects built inside a vm context carry that context's prototypes, so
// assert.deepEqual reports "same structure, not reference-equal". Compare the
// shape instead of the identity.
const plain = (v) => JSON.parse(JSON.stringify(v));
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const INVOICES_SRC = READ('js/admin/pages/invoices.js');
const ORDERS_SRC = READ('js/admin/pages/orders.js');
const SHARED_SRC = READ('js/admin/utils/send-history.js');
const ORDER_UTIL_SRC = READ('js/admin/utils/order-invoice-sent.js');
const APP_SRC = READ('js/admin/app.js');

/** The shared module alone, evaluated for real. */
function loadShared() {
  const ctx = { console, Date, Math, Number, Object, Array, String, JSON };
  vm.createContext(ctx);
  vm.runInContext(
    `${SHARED_SRC.replace(/^\s*export\s+/gm, '')}
     ;this.__api = { SAME_SEND_MS, mergeSends, recordedSendsPhrase };`,
    ctx, { filename: 'send-history.js' },
  );
  return ctx.__api;
}

/**
 * The invoices.js helper prelude, on top of the shared module — the same slice
 * the two older Invoices tests take, so a refactor that moves these helpers out
 * fails loudly here rather than silently skipping the behaviour.
 */
function loadHelpers({ throwOnStorage = false, seed = {} } = {}) {
  const start = INVOICES_SRC.indexOf('const escA =');
  const end = INVOICES_SRC.indexOf('// The "Date order placed" line');
  assert.ok(start > -1 && end > start, 'helper prelude markers must exist in invoices.js');

  const store = new Map(Object.entries(seed));
  const ctx = {
    window: { Security: null, DebugLog: { warn: () => {} } },
    localStorage: {
      getItem: (k) => { if (throwOnStorage) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => { if (throwOnStorage) throw new Error('quota'); store.set(k, String(v)); },
    },
    console, Date, Math, JSON, Number, Object, String, Array, isNaN, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(SHARED_SRC.replace(/^\s*export\s+/gm, ''), ctx, { filename: 'send-history.js' });
  vm.runInContext(
    `${INVOICES_SRC.slice(start, end)}
     ;this.__api = { readSentMap, writeSent, sentInfo, sentTitle, SENT_KEY, SENT_KEY_V1, SENT_CAP, SENT_SENDS_CAP };`,
    ctx, { filename: 'invoices-prelude.js' },
  );
  return { ...ctx.__api, store };
}

// ---------------------------------------------------------------------------
// §1  mergeSends — the dedupe both pages depend on
// ---------------------------------------------------------------------------

test('§1 mergeSends folds sources into one list, newest first', async (t) => {
  const { mergeSends, SAME_SEND_MS } = loadShared();

  await t.test('sorts newest first regardless of input order', () => {
    const out = mergeSends([
      { at: '2026-08-10T00:00:00Z', source: 'a' },
      { at: '2026-08-28T00:00:00Z', source: 'b' },
      { at: '2026-08-19T00:00:00Z', source: 'c' },
    ]);
    assert.deepEqual(plain(out).map(x => x.source), ['b', 'c', 'a']);
  });

  // The moment a resend is stamped by the server AND recorded by us, one send
  // would list — and count — twice without this.
  await t.test('collapses two records of the same send', () => {
    const out = mergeSends([
      { at: '2026-08-20T02:00:00Z', source: 'server' },
      { at: '2026-08-20T02:00:01Z', source: 'local' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'server', 'the FIRST entry wins — callers pass the authority first');
  });

  await t.test('keeps two sends further apart than the window', () => {
    const out = mergeSends([
      { at: '2026-08-20T02:00:00Z', source: 'server' },
      { at: new Date(Date.parse('2026-08-20T02:00:00Z') + SAME_SEND_MS + 1).toISOString(), source: 'local' },
    ]);
    assert.equal(out.length, 2);
  });

  // A send whose time cannot be read renders as "Invalid Date" and sorts at
  // random. Dropping it is the lesser wrong; the count comes from a tally, so
  // dropping one here cannot silently lower the number the operator sees.
  await t.test('drops an entry with no readable timestamp', () => {
    assert.deepEqual(plain(mergeSends([{ at: null }, { at: '' }, { at: 'not a date' }, { at: undefined }])), []);
    assert.equal(mergeSends([{ at: 'junk' }, { at: '2026-08-20T02:00:00Z' }]).length, 1);
  });

  await t.test('tolerates a non-array', () => {
    assert.deepEqual(plain(mergeSends(null)), []);
    assert.deepEqual(plain(mergeSends(undefined)), []);
  });
});

// ---------------------------------------------------------------------------
// §2  recordedSendsPhrase — the wording
// ---------------------------------------------------------------------------

test('§2 the phrase says "recorded", and says when it is a floor', async (t) => {
  const { recordedSendsPhrase } = loadShared();

  await t.test('singular and plural', () => {
    assert.equal(recordedSendsPhrase(1), '1 recorded send');
    assert.equal(recordedSendsPhrase(3), '3 recorded sends');
    assert.equal(recordedSendsPhrase(0), '0 recorded sends');
  });

  await t.test('a floor says so, long-form and compact', () => {
    assert.equal(recordedSendsPhrase(2, { floor: true }), '2 recorded sends or more');
    assert.equal(recordedSendsPhrase(2, { floor: true, compact: true }), '2 recorded sends+');
  });

  await t.test('never claims a total', () => {
    for (const n of [0, 1, 2, 9]) {
      assert.doesNotMatch(recordedSendsPhrase(n), /times/);
      assert.doesNotMatch(recordedSendsPhrase(n, { floor: true }), /times/);
    }
  });

  await t.test('junk does not produce "NaN recorded sends"', () => {
    assert.equal(recordedSendsPhrase(undefined), '0 recorded sends');
    assert.equal(recordedSendsPhrase('x'), '0 recorded sends');
    assert.equal(recordedSendsPhrase(-4), '0 recorded sends');
    assert.equal(recordedSendsPhrase(2.7), '2 recorded sends');
  });
});

// ---------------------------------------------------------------------------
// §3  THE BUG: a resend of a legacy invoice
// ---------------------------------------------------------------------------

test('§3 a resend always moves the cell — including on a legacy invoice', async (t) => {

  // Invoice 3267 as production actually returns it: a real send date and a
  // count of 0, because the send predates the log table.
  const LEGACY = { id: 'inv-3267', emailed_at: '2026-07-27T02:10:07.587Z', email_count: 0 };

  await t.test('before the resend: one send, and the number is a floor', () => {
    const { sentInfo } = loadHelpers();
    const info = sentInfo(LEGACY);
    assert.equal(info.count, 1);
    assert.equal(info.floor, true, 'email_count 0 is UNKNOWN, not zero');
  });

  await t.test('after the resend: TWO, not one', () => {
    const { sentInfo, writeSent } = loadHelpers();
    const prior = sentInfo(LEGACY).count;
    writeSent(LEGACY.id, 'ops@inkcartridges.co.nz', prior);
    // The list refetch: the backend logged the resend, so it now says 1.
    const after = sentInfo({ ...LEGACY, emailed_at: new Date().toISOString(), email_count: 1 });
    assert.equal(after.count, 2, 'the pre-log send is not erased by the resend');
    assert.equal(after.floor, true, 'and it is still a floor — there may be more we never logged');
  });

  await t.test('the cell renders ×N off that count', () => {
    const i = INVOICES_SRC.indexOf("key: 'sent'");
    const cell = INVOICES_SRC.slice(i, INVOICES_SRC.indexOf("key: 'actions'", i));
    assert.match(cell, /info\.count > 1 \?/, '×N past one send, never over a single one');
    assert.match(cell, /inv-sent__times/);
  });

  // The single place this feature silently breaks the number it exists to show.
  await t.test('a second resend does not reset the tally to 1', () => {
    const { sentInfo, writeSent } = loadHelpers();
    let rec = { ...LEGACY };
    for (let n = 1; n <= 3; n++) {
      writeSent(rec.id, 'ops@x.co', sentInfo(rec).count);
      rec = { ...rec, emailed_at: new Date().toISOString(), email_count: n };
    }
    assert.equal(sentInfo(rec).count, 4, 'one pre-log send plus three resends');
  });

  await t.test('a never-sent invoice still reports nothing, and no ×N', () => {
    const { sentInfo } = loadHelpers();
    assert.equal(sentInfo({ id: 'inv-3274', emailed_at: null, email_count: 0 }), null);
  });

  await t.test('one send after a never-sent invoice does not print ×1', () => {
    const { sentInfo, writeSent } = loadHelpers();
    const rec = { id: 'inv-3274', emailed_at: null, email_count: 0 };
    writeSent(rec.id, 'a@b.co', 0);
    const info = sentInfo({ ...rec, emailed_at: new Date().toISOString(), email_count: 1 });
    assert.equal(info.count, 1, 'one send is one send');
    assert.equal(info.floor, false);
  });

  // The resend path must hand writeSent the prior count, or the send it just
  // made becomes the only one the browser remembers.
  await t.test('the send handler reads the prior count BEFORE it sends', () => {
    const h = INVOICES_SRC.slice(INVOICES_SRC.indexOf("data-action=\"send\"]').addEventListener"));
    const iPrior = h.indexOf('const priorCount = sentInfo(');
    const iSend = h.indexOf('AdminAPI.emailInvoice(');
    const iWrite = h.indexOf('writeSent(');
    assert.ok(iPrior > -1 && iSend > -1 && iWrite > -1);
    assert.ok(iPrior < iSend, 'the prior count is read before the send, not after');
    assert.ok(iSend < iWrite, 'and nothing is recorded until the send resolves');
    assert.match(h.slice(iWrite, iWrite + 60), /writeSent\(d\.id, to, priorCount\)/);
  });
});

// ---------------------------------------------------------------------------
// §4  One vocabulary across the two pages
// ---------------------------------------------------------------------------

test('§4 both admin pages count sends in the same words', async (t) => {
  const { recordedSendsPhrase } = loadShared();

  await t.test('the Invoices page uses the shared builder', () => {
    assert.match(INVOICES_SRC, /import \{[^}]*recordedSendsPhrase[^}]*\} from '\.\.\/utils\/send-history\.js'/);
    assert.match(INVOICES_SRC, /recordedSendsPhrase\(info\.count, \{ floor: info\.floor \}\)/);
  });

  // orders.js still spells the phrase inline and its own test greps the
  // literal. That is exactly the drift a shared module exists to catch, so
  // pin the two against each other rather than trusting them to stay equal.
  await t.test('the Orders page spells the same phrase', () => {
    assert.ok(ORDERS_SRC.includes('recorded send'), 'orders.js must still say "recorded send"');
    assert.ok(recordedSendsPhrase(2).includes('recorded send'));
    assert.match(ORDERS_SRC, /\$\{info\.truncated \? ' or more' : ''\}/, 'and marks its floor the same way');
    assert.equal(recordedSendsPhrase(2, { floor: true }).endsWith(' or more'), true);
  });

  await t.test('neither page says "sent N times"', () => {
    for (const [name, src] of [['invoices.js', INVOICES_SRC], ['orders.js', ORDERS_SRC]]) {
      assert.doesNotMatch(src, /sent \$\{[^}]*\} times/, `${name} must not present a count as a total`);
    }
  });

  await t.test('the dedupe window is defined once, not twice', () => {
    assert.match(SHARED_SRC, /export const SAME_SEND_MS = 2000;/);
    assert.doesNotMatch(ORDER_UTIL_SRC, /^const SAME_SEND_MS/m, 'the Orders util imports it now');
    assert.match(ORDER_UTIL_SRC, /import \{ mergeSends \} from '\.\/send-history\.js';/);
    assert.doesNotMatch(INVOICES_SRC, /const SAME_SEND_MS/, 'and the Invoices page never re-declares it');
  });
});

// ---------------------------------------------------------------------------
// §5  The local backstop: v1 → v2, and a tally that only grows
// ---------------------------------------------------------------------------

test('§5 the localStorage backstop', async (t) => {

  await t.test('a v1 record is migrated on read, not lost', () => {
    const { readSentMap, sentInfo } = loadHelpers({
      seed: { inv_emailed_v1: JSON.stringify({ 'inv-1': { at: '2026-07-08T00:00:00Z', to: 'a@b.co', count: 3 } }) },
    });
    const e = readSentMap()['inv-1'];
    assert.equal(e.sends.length, 1);
    assert.equal(e.sends[0].to, 'a@b.co');
    assert.equal(e.recorded, 3, 'a v1 count of 3 still floors the new one');
    assert.equal(sentInfo({ id: 'inv-1' }).count, 3);
  });

  await t.test('a v2 record wins, but never below what v1 claimed', () => {
    const { readSentMap } = loadHelpers({
      seed: {
        inv_emailed_v1: JSON.stringify({ 'inv-1': { at: '2026-07-08T00:00:00Z', to: '', count: 5 } }),
        inv_emailed_v2: JSON.stringify({ 'inv-1': { sends: [{ at: '2026-08-01T00:00:00Z', to: '' }], recorded: 2 } }),
      },
    });
    assert.equal(readSentMap()['inv-1'].recorded, 5, 'a migration must not lower a floor');
  });

  await t.test('writeSent APPENDS rather than rebuilding', () => {
    const { writeSent, readSentMap } = loadHelpers();
    writeSent('inv-1', 'a@b.co', 0);
    writeSent('inv-1', 'a@b.co', 1);
    writeSent('inv-1', 'a@b.co', 2);
    const e = readSentMap()['inv-1'];
    assert.equal(e.recorded, 3);
    assert.equal(e.sends.length, 3);
  });

  await t.test('the per-invoice list is capped, and the tally survives the cap', () => {
    const { writeSent, readSentMap, SENT_SENDS_CAP } = loadHelpers();
    for (let i = 0; i < SENT_SENDS_CAP + 5; i++) writeSent('inv-1', 'a@b.co', i);
    const e = readSentMap()['inv-1'];
    assert.equal(e.sends.length, SENT_SENDS_CAP, 'the list is trimmed');
    assert.equal(e.recorded, SENT_SENDS_CAP + 5, 'the count is not');
  });

  await t.test('writes go to v2 and leave v1 alone', () => {
    const { writeSent, store, SENT_KEY, SENT_KEY_V1 } = loadHelpers({
      seed: { inv_emailed_v1: JSON.stringify({ 'inv-9': { at: '2026-07-08T00:00:00Z', to: '', count: 1 } }) },
    });
    assert.equal(SENT_KEY, 'inv_emailed_v2');
    assert.equal(SENT_KEY_V1, 'inv_emailed_v1');
    writeSent('inv-1', 'a@b.co', 0);
    assert.ok(store.get(SENT_KEY), 'v2 written');
    assert.match(store.get(SENT_KEY_V1), /inv-9/, 'v1 untouched — a rollback must still find it');
  });

  // A browser with storage blocked must degrade to "no local record", never
  // throw through the table renderer and darken the whole page.
  await t.test('a throwing localStorage degrades instead of exploding', () => {
    const { sentInfo, writeSent, readSentMap } = loadHelpers({ throwOnStorage: true });
    assert.deepEqual(plain(readSentMap()), {});
    assert.doesNotThrow(() => writeSent('inv-1', 'a@b.co', 0));
    assert.equal(sentInfo({ id: 'inv-1' }), null);
    assert.equal(sentInfo({ id: 'inv-1', emailed_at: '2026-07-08T00:00:00Z', email_count: 1 }).count, 1,
      'the server record still answers');
  });

  await t.test('a corrupt record does not take the column down', () => {
    const { sentInfo } = loadHelpers({
      seed: { inv_emailed_v2: '{ not json' },
    });
    assert.equal(sentInfo({ id: 'inv-1' }), null);
    const { sentInfo: s2 } = loadHelpers({
      seed: { inv_emailed_v2: JSON.stringify({ 'inv-1': { sends: 'nope', recorded: 'x' } }) },
    });
    assert.equal(s2({ id: 'inv-1' }), null, 'a record with no usable send is no record');
  });
});

// ---------------------------------------------------------------------------
// §6  A server count can raise the number, never lower it
// ---------------------------------------------------------------------------

test('§6 a stale list response cannot retract a send', async (t) => {

  await t.test('the count is a max over every tally, not the server field alone', () => {
    const { sentInfo, writeSent } = loadHelpers();
    writeSent('inv-1', 'a@b.co', 2);     // 3 recorded here
    assert.equal(sentInfo({ id: 'inv-1', emailed_at: '2026-08-01T00:00:00Z', email_count: 1 }).count, 3);
  });

  await t.test('and a bigger server count still wins', () => {
    const { sentInfo, writeSent } = loadHelpers();
    writeSent('inv-1', 'a@b.co', 0);     // 1 recorded here
    assert.equal(sentInfo({ id: 'inv-1', emailed_at: '2026-08-01T00:00:00Z', email_count: 7 }).count, 7);
  });

  await t.test('the count never contradicts the list under it', () => {
    const { sentInfo, writeSent } = loadHelpers();
    writeSent('inv-1', 'a@b.co', 0);
    const info = sentInfo({ id: 'inv-1', emailed_at: '2026-07-08T00:00:00Z', email_count: 1 });
    assert.ok(info.count >= info.sends.length, 'a count below the rows shown would read as a bug');
    assert.equal(info.floor, info.count > info.sends.length || info.floor);
  });
});

// ---------------------------------------------------------------------------
// §7  Shipping hygiene
// ---------------------------------------------------------------------------

test('§7 the edited modules are actually re-fetched', async (t) => {
  await t.test('APP_VERSION advanced', () => {
    const m = APP_SRC.match(/const APP_VERSION = '([^']+)'/);
    assert.ok(m, 'APP_VERSION must exist');
    assert.notEqual(m[1], '2026.08.28-free-shipping-freight-owner',
      'a page-module edit that does not bump APP_VERSION ships to a cached browser');
  });

  // ERR-124: a `?v=` on a static import is a cache key the build never restamps.
  await t.test('no ?v= token on a static import', () => {
    for (const [name, src] of [['invoices.js', INVOICES_SRC], ['send-history.js', SHARED_SRC], ['order-invoice-sent.js', ORDER_UTIL_SRC]]) {
      assert.doesNotMatch(src, /^import[^\n]*\?v=/m, `${name} must not pin a version on a static import`);
    }
  });
});
