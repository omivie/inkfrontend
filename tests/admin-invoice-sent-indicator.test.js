/**
 * Invoice "Sent" indicator — July 2026
 * ====================================
 *
 * The admin Invoices list could not tell an operator whether an invoice's PDF
 * had already been emailed to the customer, which invited double-sends and
 * silent never-sends. A "Sent" column now sits between Paid and the row
 * actions: a green ✓ + short date when the invoice has gone out, a muted "—"
 * when it never has.
 *
 * The contract pinned here:
 *
 *   1. The backend owns the send history — `last_emailed_at`,
 *      `last_emailed_to`, `email_count`. Those fields are READ-ONLY to the
 *      frontend: `draftFromInvoice()` carries them through, `buildPayload()`
 *      must never send them back (a PUT would otherwise reset the history on
 *      every edit).
 *
 *   2. Until the backend ships them, a successful send is recorded in
 *      localStorage under `inv_emailed_v1` so the indicator is useful
 *      immediately. `sentInfo()` prefers the server value, so the local cache
 *      retires itself the moment the API starts returning `last_emailed_at`.
 *
 *   3. `writeSent()` runs ONLY after `AdminAPI.emailInvoice()` resolves — a
 *      failed send must leave the row unmarked.
 *
 *   4. localStorage can throw (private mode, quota); every access is guarded
 *      and degrades to "no local record", never to an exception.
 *
 * Run: node --test tests/admin-invoice-sent-indicator.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const INVOICES_SRC = READ('js/admin/pages/invoices.js');
const APP_SRC = READ('js/admin/app.js');
const CSS_SRC = READ('css/admin.css');
const SHELL_SRC = READ('html/admin/index.html');

// ─────────────────────────────────────────────────────────────────────────────
// Load the send-record helpers for real.
//
// invoices.js is an ES module (top-level `import`), so it cannot be evaluated
// wholesale in a vm. Slice out the pure-helper prelude — everything from the
// first small helper down to the end of sentTitle() — and run that. The slice
// is delimited by source markers, so a refactor that moves the helpers out of
// the prelude fails loudly here rather than silently skipping the behaviour.
// ─────────────────────────────────────────────────────────────────────────────
function loadHelpers({ throwOnStorage = false } = {}) {
  const start = INVOICES_SRC.indexOf('const escA =');
  const end = INVOICES_SRC.indexOf('// The "Date order placed" line');
  assert.ok(start > -1 && end > start, 'helper prelude markers must exist in invoices.js');
  const prelude = INVOICES_SRC.slice(start, end);

  const store = new Map();
  const localStorage = {
    getItem: (k) => { if (throwOnStorage) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (throwOnStorage) throw new Error('quota'); store.set(k, String(v)); },
  };
  const ctx = {
    window: { Security: null, DebugLog: { warn: () => {} } },
    localStorage,
    console,
    Date,
    Math,
    JSON,
    Number,
    Object,
    String,
    isNaN,
    parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(`${prelude}\n;this.__api = { readSentMap, writeSent, sentInfo, sentShort, sentTitle, SENT_CAP };`, ctx);
  return { ...ctx.__api, store };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. sentInfo(): server wins, local is the fallback, absent means never sent
// ─────────────────────────────────────────────────────────────────────────────

test('sentInfo() returns null for an invoice that has never been emailed', () => {
  const { sentInfo } = loadHelpers();
  assert.equal(sentInfo({ id: 'inv-1' }), null);
  assert.equal(sentInfo(null), null);
});

test('sentInfo() prefers the server fields over any local record', () => {
  const { sentInfo, writeSent } = loadHelpers();
  writeSent('inv-1', 'local@example.com');
  const info = sentInfo({
    id: 'inv-1',
    last_emailed_at: '2026-07-08T02:15:00Z',
    last_emailed_to: 'server@example.com',
    email_count: 3,
  });
  assert.equal(info.at, '2026-07-08T02:15:00Z', 'server timestamp wins');
  assert.equal(info.to, 'server@example.com', 'server recipient wins');
  assert.equal(info.count, 3);
});

test('sentInfo() falls back to the local record when the backend omits the fields', () => {
  const { sentInfo, writeSent } = loadHelpers();
  writeSent('inv-2', 'ian@mcgrath.co.nz');
  const info = sentInfo({ id: 'inv-2' });
  assert.ok(info, 'a locally-recorded send must surface');
  assert.equal(info.to, 'ian@mcgrath.co.nz');
  assert.equal(info.count, 1);
  assert.match(info.at, /^\d{4}-\d{2}-\d{2}T/, 'local record stamps an ISO timestamp');
});

test('sentInfo() defaults a server email_count of 0/absent to 1', () => {
  const { sentInfo } = loadHelpers();
  assert.equal(sentInfo({ id: 'x', last_emailed_at: '2026-07-08T00:00:00Z' }).count, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. writeSent(): counts up, bounds the map, never throws
// ─────────────────────────────────────────────────────────────────────────────

test('writeSent() increments the send count on repeat sends', () => {
  const { writeSent, sentInfo } = loadHelpers();
  writeSent('inv-3', 'a@b.co');
  writeSent('inv-3', 'a@b.co');
  writeSent('inv-3', 'c@d.co');
  const info = sentInfo({ id: 'inv-3' });
  assert.equal(info.count, 3);
  assert.equal(info.to, 'c@d.co', 'the LAST recipient is retained');
});

// readSentMap() builds its object inside the vm realm, so deepStrictEqual({})
// fails on the prototype check — count the keys instead.
const isEmptyMap = (m) => Object.keys(m).length === 0;

test('writeSent() ignores an invoice with no id (an unsaved draft)', () => {
  const { writeSent, readSentMap } = loadHelpers();
  writeSent(null, 'a@b.co');
  writeSent('', 'a@b.co');
  assert.ok(isEmptyMap(readSentMap()), 'nothing is recorded for an id-less draft');
});

test('writeSent() caps the map and evicts the oldest records first', () => {
  const { writeSent, readSentMap, SENT_CAP } = loadHelpers();
  for (let i = 0; i < SENT_CAP + 10; i++) writeSent(`inv-${String(i).padStart(4, '0')}`, 'a@b.co');
  const map = readSentMap();
  assert.equal(Object.keys(map).length, SENT_CAP, `map is bounded at ${SENT_CAP}`);
  assert.ok(!map['inv-0000'], 'the oldest record was evicted');
  assert.ok(map[`inv-${String(SENT_CAP + 9).padStart(4, '0')}`], 'the newest record survives');
});

test('a throwing localStorage degrades to "no local record", never an exception', () => {
  const { writeSent, readSentMap, sentInfo } = loadHelpers({ throwOnStorage: true });
  assert.doesNotThrow(() => writeSent('inv-4', 'a@b.co'));
  assert.ok(isEmptyMap(readSentMap()), 'a throwing getItem yields an empty map');
  assert.equal(sentInfo({ id: 'inv-4' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

test('sentShort() renders a compact day + month, and tolerates junk', () => {
  const { sentShort } = loadHelpers();
  assert.equal(sentShort('2026-07-08T02:15:00Z').replace(/^\d+/, (d) => d), sentShort('2026-07-08T02:15:00Z'));
  assert.match(sentShort('2026-07-08T02:15:00Z'), /^\d{1,2} Jul$/);
  assert.equal(sentShort('not-a-date'), '');
});

test('sentTitle() names the recipient, the full date, and only pluralises past one send', () => {
  const { sentTitle } = loadHelpers();
  const once = sentTitle({ at: '2026-07-08T02:15:00Z', to: 'ian@mcgrath.co.nz', count: 1 });
  assert.match(once, /Emailed to ian@mcgrath\.co\.nz on 8th July 2026$/);
  assert.doesNotMatch(once, /sent 1 times/, 'a single send must not read "sent 1 times"');

  assert.match(sentTitle({ at: '2026-07-08T02:15:00Z', to: '', count: 4 }),
    /^Emailed on 8th July 2026 · sent 4 times$/, 'no recipient => no dangling "to"');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Wiring: the column, the send handler, the read-only payload contract
// ─────────────────────────────────────────────────────────────────────────────

test('a "Sent" column sits between the Paid column and the row actions', () => {
  const iPaid = INVOICES_SRC.indexOf("key: 'paid'");
  const iSent = INVOICES_SRC.indexOf("key: 'sent'");
  const iActions = INVOICES_SRC.indexOf("key: 'actions'");
  assert.ok(iPaid > -1 && iSent > -1 && iActions > -1, 'paid, sent and actions columns all exist');
  assert.ok(iPaid < iSent && iSent < iActions, 'column order must be paid → sent → actions');
  assert.match(INVOICES_SRC, /key: 'sent', label: 'Sent'/, 'the header reads "Sent"');
});

test('the Sent cell escapes its tooltip and its date', () => {
  const cell = INVOICES_SRC.slice(INVOICES_SRC.indexOf("key: 'sent'"), INVOICES_SRC.indexOf("key: 'actions'"));
  assert.match(cell, /title="\$\{escA\(sentTitle\(info\)\)\}"/, 'tooltip goes through escA()');
  assert.match(cell, /\$\{esc\(sentShort\(info\.at\)\)\}/, 'date goes through esc()');
  assert.match(cell, /inv-sent__none/, 'the never-sent state renders the muted placeholder');
});

test('writeSent() is called only AFTER emailInvoice() resolves', () => {
  const send = INVOICES_SRC.slice(INVOICES_SRC.indexOf('await AdminAPI.emailInvoice('));
  const iWrite = send.indexOf('writeSent(');
  const iCatch = send.indexOf('} catch');
  assert.ok(iWrite > -1 && iCatch > -1, 'the send handler records the send and has a catch');
  assert.ok(iWrite < iCatch, 'writeSent() is inside the try, before the catch — a failed send records nothing');
});

test('a successful send repaints the list and the drawer hint', () => {
  const send = INVOICES_SRC.slice(INVOICES_SRC.indexOf('await AdminAPI.emailInvoice('));
  const body = send.slice(0, send.indexOf('} catch'));
  assert.match(body, /refreshSentHint\(\)/, 'the editor footer hint refreshes');
  assert.match(body, /if \(_table\) loadData\(\)/, 'the list reloads, guarded against a destroyed table');
});

test('draftFromInvoice() carries the send history; buildPayload() never sends it back', () => {
  const from = INVOICES_SRC.slice(INVOICES_SRC.indexOf('function draftFromInvoice'), INVOICES_SRC.indexOf('function computeTotals'));
  for (const f of ['last_emailed_at', 'last_emailed_to', 'email_count']) {
    assert.ok(from.includes(f), `draftFromInvoice() carries ${f} through`);
  }
  const payload = INVOICES_SRC.slice(INVOICES_SRC.indexOf('function buildPayload'));
  const body = payload.slice(0, payload.indexOf('\n}\n'));
  for (const f of ['last_emailed_at', 'last_emailed_to', 'email_count']) {
    assert.ok(!body.includes(f), `buildPayload() must NOT write ${f} — the backend owns the send history`);
  }
});

test('the drawer footer carries a hint node that collapses when empty', () => {
  assert.match(INVOICES_SRC, /id="inv-sent-hint"/, 'footer hint node exists');
  assert.match(INVOICES_SRC, /function refreshSentHint\(\)/, 'the hint can be patched in place after a send');
  assert.match(CSS_SRC, /\.inv-sent-hint:empty\s*\{\s*display:\s*none/, 'an empty hint takes no space in the footer');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Styles + cache-busting
// ─────────────────────────────────────────────────────────────────────────────

test('the Sent marker is legible on the light deck, not just the dark one', () => {
  assert.match(CSS_SRC, /\.inv-sent \{[^}]*color: var\(--success\)/, 'dark deck uses the --success token');
  assert.match(CSS_SRC, /\.admin\[data-theme="light"\] \.inv-sent \{\s*color: #15803d/,
    '--success under-contrasts on white; the light deck needs a darker green');
});

test('APP_VERSION advanced so the edited invoices.js module is re-fetched', () => {
  assert.match(APP_SRC, /APP_VERSION\s*=\s*'2026\.0[6-9]\.[0-9]{2}-[a-z0-9-]+'/,
    'APP_VERSION must be a current date-stamped token');
  assert.doesNotMatch(APP_SRC, /APP_VERSION\s*=\s*'2026\.07\.08-invoice-cost-gst'/,
    'APP_VERSION must change off the previous build');
});

test('the shell busts BOTH the admin.css and admin/app.js tokens', () => {
  // Bumping only one leaves cached browsers on a stale half of the pair —
  // the classic "works locally, broken live" failure for this SPA.
  //
  // Assert the PAIR is versioned and has moved off the known-stale values. Do NOT assert
  // the token's shape. This test used to require /admin\.css\?v=2026-07-\d{2}[a-z]/ — an
  // era-literal pin of exactly the kind ERR-067 is about, and it was doubly wrong here:
  // `scripts/stamp-versions.js` runs as Vercel's buildCommand and rewrites every ?v= to
  // md5(content)[:8], so the hand-written `2026-07-14c` form this pattern demanded is not
  // what production has ever served. It pinned a value that only exists in git.
  //
  // Sitewide token consistency and staged-change freshness are owned by
  // tests/asset-cache-tokens.test.js. Here we only assert the pair-wise property.
  assert.doesNotMatch(SHELL_SRC, /admin\.css\?v=2026-07-08e/, 'admin.css token must be bumped');
  assert.doesNotMatch(SHELL_SRC, /admin\/app\.js\?v=2026-07-08f/, 'admin/app.js token must be bumped');
  assert.match(SHELL_SRC, /admin\.css\?v=[^"']+/, 'admin.css must carry a cache token');
  assert.match(SHELL_SRC, /admin\/app\.js\?v=[^"']+/, 'admin/app.js must carry a cache token');
});
