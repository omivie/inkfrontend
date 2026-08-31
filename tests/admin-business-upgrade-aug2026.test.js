/**
 * ONE-CLICK BUSINESS UPGRADE — admin FE (Aug 2026)
 * ================================================
 *
 * The sales team visits a business and upgrades that customer's account on the
 * spot: `POST /api/admin/business/accounts` (super_admin), managed afterwards
 * with `PATCH /api/admin/business/accounts/:id`. Contract:
 * `readfirst/business-one-click-upgrade-FE-handoff-aug2026.md`.
 *
 * The failure modes these tests exist to prevent, worst first:
 *
 *   1. THE IGNORED FILTER. `GET /api/admin/business-applications` accepts
 *      `user_id=` and `search=` and SILENTLY IGNORES BOTH — a bogus user id
 *      returns the entire table (verified against production 2026-08-09). The
 *      natural pre-flight would therefore have matched row 1 of the whole table
 *      and told the operator that every customer was already a business account
 *      under a stranger's company name. ERR-075 inverted: a bogus filter returns
 *      EVERYTHING. Matching must happen client-side, and the URL must never
 *      carry an identity parameter.
 *
 *   2. A LOST ACCOUNT ID. There is no GET for business accounts and the 409
 *      carries no id, so the 201 response is the only place a
 *      `business_accounts.id` ever appears. Lose it and PATCH is unreachable for
 *      that account forever. It is recorded before anything else can throw.
 *
 *   3. ABSENCE RENDERED AS A VERDICT (ERR-063/068/073/075/076/139/149/150). A
 *      page of applications can prove PRESENCE; only a complete read can prove
 *      ABSENCE. A failed or partial read must return `unknown`, never
 *      "not a business account". Likewise unreadable local storage is not
 *      "no account".
 *
 *   4. A HALF-SENT ADDRESS. The handoff calls addresses optional but does not
 *      say they are all-or-nothing: send `billing_address` at all and address1 +
 *      city + postcode all become required. A part-filled address must be
 *      dropped WITH A NOTE, never sent (400) and never dropped silently
 *      (looks saved).
 *
 *   5. EMPTY STRINGS FOR OPTIONALS. Joi accepts `''`, but the backend's
 *      documented "defaults to the user's auth email" fallback is specified for
 *      an ABSENT field. Empty optionals are omitted, not blanked.
 *
 * Run: node --test tests/admin-business-upgrade-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const ADMIN = path.join(INK, 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

const UTIL_SRC = read(path.join(ADMIN, 'utils', 'business-accounts.js'));
const COMPONENT_SRC = read(path.join(ADMIN, 'components', 'business-upgrade.js'));
const API_SRC = read(path.join(ADMIN, 'api.js'));
const APP_SRC = read(path.join(ADMIN, 'app.js'));
const PAGE_SRC = read(path.join(ADMIN, 'pages', 'business.js'));
const CUSTOMERS_SRC = read(path.join(ADMIN, 'pages', 'customers.js'));
const ADMIN_CSS = read(path.join(INK, 'css', 'admin.css'));

/** Strip comments so a literal inside a docblock can't satisfy an assertion. */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const UTIL = codeOnly(UTIL_SRC);
const COMPONENT = codeOnly(COMPONENT_SRC);
const API = codeOnly(API_SRC);
const PAGE = codeOnly(PAGE_SRC);
const CUSTOMERS = codeOnly(CUSTOMERS_SRC);

/** The util is a real ES module with no browser dependencies — import and run it. */
const loadUtil = () => import('file://' + path.join(ADMIN, 'utils', 'business-accounts.js'));

const UID = 'ebf7e960-9cc2-4941-8d05-f6b5bf5af562';
const OTHER_UID = '11111111-2222-3333-4444-555555555555';

/** Minimum valid form input. */
const baseFields = (over = {}) => ({
  user_id: UID,
  company_name: 'Acme Print Co',
  credit_limit: '0',
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Payload shape — what is sent, and more importantly what is NOT
// ═══════════════════════════════════════════════════════════════════════════

test('a minimal form produces exactly the four required keys', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload, errors } = buildUpgradePayload(baseFields());
  assert.deepEqual(errors, []);
  assert.deepEqual(payload, {
    user_id: UID,
    company_name: 'Acme Print Co',
    credit_limit: 0,
    net30_approved: false,
  });
});

test('credit_limit 0 is SENT, never dropped as falsy', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload } = buildUpgradePayload(baseFields({ credit_limit: '0' }));
  assert.ok('credit_limit' in payload,
    '0 is the right default for a cash/card business and the server requires the field — ' +
    'a truthiness test here would 400 every ordinary upgrade');
  assert.equal(payload.credit_limit, 0);
  assert.equal(typeof payload.credit_limit, 'number');
});

test('empty optionals are OMITTED, never sent as ""', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload } = buildUpgradePayload(baseFields({
    nzbn: '', contact_name: '  ', contact_email: '', ap_email: '',
  }));
  for (const k of ['nzbn', 'contact_name', 'contact_email', 'ap_email']) {
    assert.ok(!(k in payload),
      `${k} must be absent, not "": the backend's documented fallback ("defaults to the ` +
      `user's auth email") is specified for an ABSENT field, and contact_email:"" is the one ` +
      'shape that could earn the documented 400 "contact_email is required"');
  }
});

test('a complete address survives; address2/region are included only when filled', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload, notes } = buildUpgradePayload(baseFields({
    'billing_address.address1': '37A Archibald Rd',
    'billing_address.city': 'Auckland',
    'billing_address.postcode': '0602',
    'billing_address.address2': '',
    'billing_address.region': 'auckland',
  }));
  assert.deepEqual(payload.billing_address, {
    address1: '37A Archibald Rd', city: 'Auckland', postcode: '0602', region: 'auckland',
  });
  assert.ok(!('address2' in payload.billing_address));
  assert.deepEqual(notes, [], 'a complete address is not a caveat');
});

test('a PART-FILLED address is dropped WHOLE and says so — never sent, never silent', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload, errors, notes } = buildUpgradePayload(baseFields({
    'billing_address.address1': '37A Archibald Rd',
    'billing_address.city': '',
    'billing_address.postcode': '',
  }));
  assert.deepEqual(errors, [], 'a half-typed optional address is not a blocking error');
  assert.ok(!('billing_address' in payload),
    'sending it would 400: address1 alone makes city and postcode required (verified live)');
  assert.equal(notes.length, 1, 'dropping typed input silently would look saved');
  assert.match(notes[0], /Billing address not saved/);
  assert.match(notes[0], /city/);
  assert.match(notes[0], /postcode/);
});

test('an entirely blank address is omitted with NO note — nothing was typed', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload, notes } = buildUpgradePayload(baseFields({
    'billing_address.address1': '', 'billing_address.city': '', 'billing_address.postcode': '',
    'shipping_address.address1': '', 'shipping_address.city': '', 'shipping_address.postcode': '',
  }));
  assert.ok(!('billing_address' in payload));
  assert.ok(!('shipping_address' in payload));
  assert.deepEqual(notes, [], 'a caveat about something nobody typed is noise');
});

test('net30_approved is always stated explicitly, as a real boolean', async () => {
  const { buildUpgradePayload } = await loadUtil();
  assert.equal(buildUpgradePayload(baseFields()).payload.net30_approved, false);
  assert.equal(buildUpgradePayload(baseFields({ net30_approved: true })).payload.net30_approved, true);
  // A checkbox that never got rendered must not become `true` by accident.
  assert.equal(buildUpgradePayload(baseFields({ net30_approved: 'on' })).payload.net30_approved, false,
    'only a real boolean grants Net 30 — the ability to order without paying first');
});

test('billing and shipping are collected independently', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload, notes } = buildUpgradePayload(baseFields({
    'billing_address.address1': '1 Test St',
    'billing_address.city': 'Auckland',
    'billing_address.postcode': '0602',
    'shipping_address.address1': '2 Other St',   // incomplete
  }));
  assert.ok(payload.billing_address, 'a good billing address is not punished for a bad shipping one');
  assert.ok(!('shipping_address' in payload));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Shipping address not saved/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Validation parity with the live endpoint (every rule measured 2026-08-09)
// ═══════════════════════════════════════════════════════════════════════════

test('company_name: required, trimmed, ≤255', async () => {
  const { buildUpgradePayload, COMPANY_NAME_MAX } = await loadUtil();
  const err = (f) => buildUpgradePayload(baseFields(f)).errors.map((e) => e.field);
  assert.deepEqual(err({ company_name: '' }), ['company_name']);
  assert.deepEqual(err({ company_name: '   ' }), ['company_name'],
    'the server trims before checking — "   " really does 400');
  assert.deepEqual(err({ company_name: 'A'.repeat(COMPANY_NAME_MAX + 1) }), ['company_name']);
  assert.deepEqual(err({ company_name: 'A'.repeat(COMPANY_NAME_MAX) }), []);
  assert.equal(buildUpgradePayload(baseFields({ company_name: '  Acme  ' })).payload.company_name, 'Acme');
});

test('credit_limit: required, 0…1,000,000, decimals allowed', async () => {
  const { buildUpgradePayload, CREDIT_LIMIT_MAX } = await loadUtil();
  const err = (v) => buildUpgradePayload(baseFields({ credit_limit: v })).errors.map((e) => e.field);
  assert.deepEqual(err(''), ['credit_limit'], 'omitting it is a 400 — there is no server default');
  assert.deepEqual(err('abc'), ['credit_limit']);
  assert.deepEqual(err('-1'), ['credit_limit']);
  assert.deepEqual(err(String(CREDIT_LIMIT_MAX + 1)), ['credit_limit']);
  assert.deepEqual(err(String(CREDIT_LIMIT_MAX)), []);
  assert.deepEqual(err('250.55'), [], 'the endpoint accepts decimals — verified live');
  assert.equal(buildUpgradePayload(baseFields({ credit_limit: '250.55' })).payload.credit_limit, 250.55);
});

test('nzbn: 13 digits, with spaces and dashes normalised away first', async () => {
  const { buildUpgradePayload, normaliseNzbn } = await loadUtil();
  assert.equal(normaliseNzbn('9429 0123 45678'), '9429012345678');
  assert.equal(normaliseNzbn('9429-0123-45678'), '9429012345678');
  const ok = buildUpgradePayload(baseFields({ nzbn: '9429 0123 45678' }));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.payload.nzbn, '9429012345678',
    'the server rejects spaces outright, and NZBNs are written with them');
  assert.deepEqual(
    buildUpgradePayload(baseFields({ nzbn: '942901234567' })).errors.map((e) => e.field),
    ['nzbn'],
  );
});

test('emails are shape-checked before a round trip, and only when present', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const err = (f) => buildUpgradePayload(baseFields(f)).errors.map((e) => e.field);
  assert.deepEqual(err({ contact_email: 'not-an-email' }), ['contact_email']);
  assert.deepEqual(err({ ap_email: 'nope@' }), ['ap_email']);
  assert.deepEqual(err({ contact_email: 'jo@acme.co', ap_email: 'ap@acme.co' }), []);
  assert.deepEqual(err({ contact_email: '' }), [], 'blank means "use the default", not "invalid"');
});

test('user_id must be a UUID — a customer row id is the auth user id or nothing', async () => {
  const { buildUpgradePayload, isUuid } = await loadUtil();
  assert.equal(isUuid(UID), true);
  assert.equal(isUuid('42'), false);
  assert.deepEqual(buildUpgradePayload(baseFields({ user_id: '' })).errors.map((e) => e.field), ['user_id']);
  assert.deepEqual(buildUpgradePayload(baseFields({ user_id: '42' })).errors.map((e) => e.field), ['user_id']);
});

test('every error carries a message, and a failed build yields NO payload', async () => {
  const { buildUpgradePayload } = await loadUtil();
  const { payload, errors } = buildUpgradePayload({});
  assert.equal(payload, null, 'a partial payload could still be POSTed by a careless caller');
  assert.ok(errors.length >= 3);
  for (const e of errors) assert.ok(e.message && e.message.length > 5, `empty message on ${e.field}`);
});

test('buildAccountPatch mirrors PATCH: three fields, and never an empty body', async () => {
  const { buildAccountPatch, ACCOUNT_STATUSES, CREDIT_LIMIT_MAX } = await loadUtil();
  assert.deepEqual(ACCOUNT_STATUSES, ['active', 'suspended', 'closed']);

  assert.deepEqual(buildAccountPatch({ status: 'suspended' }).patch, { status: 'suspended' });
  assert.deepEqual(buildAccountPatch({ credit_limit: '500' }).patch, { credit_limit: 500 });
  assert.deepEqual(buildAccountPatch({ net30_approved: false }).patch, { net30_approved: false },
    'switching Net 30 OFF is the whole point of the control — it cannot be dropped as falsy');

  assert.deepEqual(buildAccountPatch({ status: 'approved' }).errors.map((e) => e.field), ['status'],
    'application statuses (pending/approved/rejected) are a DIFFERENT vocabulary from account statuses');
  assert.deepEqual(buildAccountPatch({ credit_limit: String(CREDIT_LIMIT_MAX + 1) }).errors.map((e) => e.field), ['credit_limit']);

  const empty = buildAccountPatch({});
  assert.equal(empty.patch, null);
  assert.equal(empty.errors.length, 1, 'the server 400s an empty body — catch it before the round trip');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE IGNORED FILTER — matching happens here, because the server will not
// ═══════════════════════════════════════════════════════════════════════════

const APPS = [
  { id: 'a1', user_id: OTHER_UID, company_name: 'Someone Else Ltd', status: 'approved', reviewed_at: '2026-04-20T00:00:00Z' },
  { id: 'a2', user_id: UID, company_name: 'Acme Print Co', status: 'pending', submitted_at: '2026-06-12T00:00:00Z' },
];

test('matchApplications matches on user_id — the server filter is a decoy', async () => {
  const { matchApplications } = await loadUtil();
  const r = matchApplications(APPS, UID, { total: 2 });
  assert.equal(r.verdict, 'pending_application');
  assert.equal(r.pending.company_name, 'Acme Print Co');
  assert.equal(r.approved, null,
    "the other customer's approved row must not leak in — that is the exact bug this prevents");
});

test('an unrelated customer in a full table is PROVEN to have no application', async () => {
  const { matchApplications } = await loadUtil();
  const r = matchApplications(APPS, '99999999-9999-9999-9999-999999999999', { total: 2 });
  assert.equal(r.verdict, 'no_application');
  assert.equal(r.complete, true);
});

test('a PARTIAL read that finds nothing is unknown, never "no application"', async () => {
  const { matchApplications } = await loadUtil();
  const r = matchApplications(APPS, '99999999-9999-9999-9999-999999999999', { total: 47 });
  assert.equal(r.complete, false);
  assert.equal(r.verdict, 'unknown',
    'a page of rows can prove PRESENCE; only a complete read can prove ABSENCE');
  assert.equal(r.seen, 2);
  assert.equal(r.total, 47);
});

test('a partial read that DOES find a match still answers — presence needs no completeness', async () => {
  const { matchApplications } = await loadUtil();
  const r = matchApplications(APPS, UID, { total: 47 });
  assert.equal(r.complete, false);
  assert.equal(r.verdict, 'pending_application');
});

test('an unreadable list is unknown, not empty', async () => {
  const { matchApplications } = await loadUtil();
  for (const bad of [null, undefined, 'nope', {}]) {
    const r = matchApplications(bad, UID, null);
    assert.equal(r.verdict, 'unknown', `${JSON.stringify(bad)} must not read as "no application"`);
    assert.equal(r.readable, false);
  }
});

test('a missing total is treated as complete — but only a real total can shrink coverage', async () => {
  const { matchApplications } = await loadUtil();
  const r = matchApplications(APPS, '99999999-9999-9999-9999-999999999999', null);
  assert.equal(r.total, null);
  assert.equal(r.complete, true,
    'with no pagination at all the list is all we were given; the alternative is a page ' +
    'that can never answer anything');
});

test('approved beats pending, and the NEWEST row of a status wins', async () => {
  const { matchApplications } = await loadUtil();
  const rows = [
    { id: 'x', user_id: UID, company_name: 'Old Co', status: 'approved', reviewed_at: '2025-01-01T00:00:00Z' },
    { id: 'y', user_id: UID, company_name: 'New Co', status: 'approved', reviewed_at: '2026-05-05T00:00:00Z' },
    { id: 'z', user_id: UID, company_name: 'Later Application', status: 'pending', submitted_at: '2026-07-07T00:00:00Z' },
  ];
  const r = matchApplications(rows, UID, { total: 3 });
  assert.equal(r.verdict, 'business_account', 'an approved application means they were upgraded');
  assert.equal(r.approved.company_name, 'New Co');
});

test('THE URL: no identity parameter is ever sent to the applications endpoint', () => {
  // A source-level ban, because the trap is invisible at runtime — the request
  // succeeds and returns plausible rows.
  const call = API.match(/listBusinessApplications[\s\S]*?\n  \},/);
  assert.ok(call, 'listBusinessApplications must exist in AdminAPI');
  assert.doesNotMatch(call[0], /user_id/,
    'the endpoint accepts user_id= and IGNORES it — sending it returns the whole table ' +
    'while the caller believes it holds one customer (ERR-151)');
  assert.doesNotMatch(call[0], /['"]search['"]/,
    'search= is ignored the same way');
  assert.match(call[0], /params\.set\('status'/, 'status is the ONLY real filter');
});

test('the applications URL uses the live /api/admin/business/ namespace', () => {
  assert.match(API, /\/api\/admin\/business\/applications/);
});

test('the queue is PAGED, because limit is capped at 100 and 101 is a 400', () => {
  const fn = API.match(/async listBusinessApplications\([\s\S]*?\n  \},/)[0];
  assert.match(fn, /BUSINESS_APPLICATION_PAGE_MAX/,
    'limit=200 is rejected outright, not clamped — the first build of this shipped a 400 ' +
    'that rendered as "the queue could not be read"');
  assert.match(API, /BUSINESS_APPLICATION_PAGE_MAX = 100/);
  assert.match(fn, /for \(let page = 1; page <= BUSINESS_APPLICATION_MAX_PAGES/,
    'one page of 100 would turn every "does this customer have an application" answer into ' +
    '"unknown" the day the queue passes 100');
  assert.match(fn, /if \(!rows\.length\) break/,
    'only an EMPTY page ends pagination — a short page does not (ERR-134)');
  assert.doesNotMatch(fn, /limit: 200|limit=200/);
});

test('a mid-walk failure keeps the rows already collected instead of throwing them away', () => {
  const fn = API.match(/async listBusinessApplications\([\s\S]*?\n  \},/)[0];
  assert.match(fn, /page === 1 \? null : \{ applications: collected/,
    'page 1 failing means we know nothing (null); page 4 failing still leaves a partial read, ' +
    'which matchApplications correctly downgrades to "unknown" rather than discarding');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Error mapping — including the two shapes that would otherwise vanish
// ═══════════════════════════════════════════════════════════════════════════

test('🚨 BF-021: a PATCH killed by CORS preflight is named, not called "Failed to fetch"', async () => {
  const { describeUpdateError, isNetworkFailure } = await loadUtil();
  const blocked = new TypeError('Failed to fetch');   // exactly what Chrome throws
  assert.equal(isNetworkFailure(blocked), true, 'no status and no code — there was no response');

  const d = describeUpdateError(blocked);
  assert.match(d.title, /BF-021/,
    'Access-Control-Allow-Methods is GET,POST,PUT,DELETE,OPTIONS — no PATCH — so this endpoint ' +
    'is unreachable from a browser; PUT/POST/DELETE on the same path all 404 and there is no fallback');
  assert.match(d.message, /never sent/i);
  assert.match(d.message, /Nothing was changed/,
    'a bare "Failed to fetch" reads like a timeout, and a timeout is the one interpretation ' +
    'under which the write might have landed — it did not');
});

test('a network failure on CREATE says the opposite, because POST is not blocked', async () => {
  const { describeCreateError } = await loadUtil();
  const d = describeCreateError(new TypeError('Failed to fetch'));
  assert.match(d.message, /may or may not/,
    'POST is CORS-allowed, so the request really can reach the backend and lose only its reply — ' +
    'claiming "nothing was changed" there would be a guess, and the account id would already be lost');
  assert.match(d.message, /already has a business account/,
    'and the retry is the check: a second attempt on an upgraded customer answers 409');
});

test('an UPDATE failure never borrows the CREATE copy', async () => {
  const { describeUpdateError } = await loadUtil();
  const d = describeUpdateError(Object.assign(new Error('nope'), { code: 'INTERNAL_ERROR' }));
  assert.doesNotMatch(d.title, /upgrade this customer/i,
    '"Could not upgrade this customer" about an account that already exists sends the ' +
    'operator to fix the wrong thing');
  assert.match(d.title, /update/i);
});

test('409 CONFLICT tells the operator it already exists, and where to manage it', async () => {
  const { describeCreateError } = await loadUtil();
  const d = describeCreateError(Object.assign(new Error('User already has a business account'), { code: 'CONFLICT' }));
  assert.match(d.title, /Already a business account/);
  assert.match(d.message, /suspended or closed/,
    'the handoff notes a 409 can mean suspended/closed, not just "done already"');
});

test('404 NOT_FOUND on create is about the CUSTOMER; on update it is about the ACCOUNT', async () => {
  const { describeCreateError, describeUpdateError } = await loadUtil();
  const err = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  assert.match(describeCreateError(err).message, /re-pick the customer/i);
  assert.match(describeUpdateError(err).title, /Business account not found/,
    'the same code means two different things on the two endpoints; one copy for both would ' +
    'send the operator to re-pick a customer who is fine');
});

test('VALIDATION_FAILED details map onto fields, including DOTTED address paths', async () => {
  const { describeCreateError } = await loadUtil();
  const err = Object.assign(new Error('Validation failed'), {
    code: 'VALIDATION_FAILED',
    details: [
      { field: 'billing_address.city', message: '"billing_address.city" is required' },
      { field: 'company_name', message: 'Company name is required' },
    ],
  });
  const d = describeCreateError(err);
  assert.deepEqual(d.fields.map((f) => f.field), ['billing_address.city', 'company_name'],
    'the dotted path IS the input name — flattening it would orphan every address error');
});

test('a detail with a BLANK field name still surfaces', async () => {
  const { describeUpdateError } = await loadUtil();
  const err = Object.assign(new Error('Validation failed'), {
    code: 'VALIDATION_FAILED',
    details: [{ field: '', message: '"value" must have at least 1 key' }],
  });
  const d = describeUpdateError(err);
  assert.equal(d.fields.length, 1,
    'PATCH with an empty body really does answer with field:"" — a mapper that assumed a name ' +
    'would drop the only message there is');
  assert.match(d.message, /at least 1 key/);
});

test('403 is named as a permission problem, not a mystery', async () => {
  const { describeCreateError } = await loadUtil();
  for (const code of ['FORBIDDEN', 'UNAUTHORIZED']) {
    assert.match(describeCreateError(Object.assign(new Error('x'), { code })).message, /super_admin/);
  }
});

test('an unrecognised failure says nothing was changed', async () => {
  const { describeCreateError } = await loadUtil();
  const d = describeCreateError(Object.assign(new Error('kaboom'), { code: 'INTERNAL_ERROR' }));
  assert.equal(d.message, 'kaboom');
  assert.match(d.title, /Could not upgrade/);
  assert.deepEqual(d.fields, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The registry — the only copy of an id that cannot be re-fetched
// ═══════════════════════════════════════════════════════════════════════════

function fakeStorage(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _store: store,
  };
}

function withStorage(storage) {
  globalThis.window = { localStorage: storage };
}

test('record → forUser round-trips every field the manage dialog needs', async () => {
  const { BusinessAccountRegistry: R, REGISTRY_KEY } = await loadUtil();
  const s = fakeStorage();
  withStorage(s);

  assert.deepEqual(R.record({
    business_account_id: 'acc-1', user_id: UID, application_id: 'app-1',
    company_name: 'Acme Print Co', credit_limit: 2000, net30_approved: true,
    recorded_by: 'owner@example.com',
  }, '2026-08-09T00:00:00.000Z'), { ok: true });

  const { account, readable } = R.forUser(UID);
  assert.equal(readable, true);
  assert.equal(account.business_account_id, 'acc-1');
  assert.equal(account.credit_limit, 2000);
  assert.equal(account.net30_approved, true);
  assert.equal(account.status, 'active');
  assert.equal(account.recorded_by, 'owner@example.com');
  assert.ok(JSON.parse(s.getItem(REGISTRY_KEY)).version >= 1, 'the record is versioned');
});

test('UNREADABLE storage is not an empty registry — the tri-state is the point', async () => {
  const { BusinessAccountRegistry: R, REGISTRY_KEY } = await loadUtil();

  // Genuinely empty.
  withStorage(fakeStorage());
  assert.deepEqual(R.all(), { accounts: [], readable: true });

  // Corrupt.
  withStorage(fakeStorage({ [REGISTRY_KEY]: '{not json' }));
  assert.equal(R.all().readable, false, 'corrupt ≠ empty');

  // Right shape, wrong contents.
  withStorage(fakeStorage({ [REGISTRY_KEY]: '{"version":1}' }));
  assert.equal(R.all().readable, false);

  // Storage itself unavailable (Safari private mode throws on access).
  globalThis.window = { get localStorage() { throw new Error('blocked'); } };
  assert.deepEqual(R.all(), { accounts: [], readable: false },
    'a thrown getter must not crash the drawer, and must not read as "no account"');

  // No window at all (node, tests, SSR).
  delete globalThis.window;
  assert.equal(R.all().readable, false);
});

test('a failed write is REPORTED, not swallowed — the id has no other source', async () => {
  const { BusinessAccountRegistry: R } = await loadUtil();
  withStorage({
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  });
  assert.deepEqual(R.record({ business_account_id: 'acc-2', user_id: UID }), { ok: false },
    'the caller shows the id so the operator can copy it — silently returning ok would lose it');
});

test('recording the same account twice replaces rather than duplicates', async () => {
  const { BusinessAccountRegistry: R } = await loadUtil();
  withStorage(fakeStorage());
  R.record({ business_account_id: 'acc-3', user_id: UID, company_name: 'First' }, '2026-08-01T00:00:00.000Z');
  R.record({ business_account_id: 'acc-3', user_id: UID, company_name: 'Second' }, '2026-08-02T00:00:00.000Z');
  assert.equal(R.all().accounts.length, 1);
  assert.equal(R.get('acc-3').account.company_name, 'Second');
});

test('forUser returns the most recent record when a user somehow has two', async () => {
  const { BusinessAccountRegistry: R } = await loadUtil();
  withStorage(fakeStorage());
  R.record({ business_account_id: 'old', user_id: UID }, '2026-01-01T00:00:00.000Z');
  R.record({ business_account_id: 'new', user_id: UID }, '2026-08-01T00:00:00.000Z');
  assert.equal(R.forUser(UID).account.business_account_id, 'new');
});

test('update mirrors a PATCH; updating an unknown id fails rather than inventing a row', async () => {
  const { BusinessAccountRegistry: R } = await loadUtil();
  withStorage(fakeStorage());
  R.record({ business_account_id: 'acc-4', user_id: UID, credit_limit: 0, net30_approved: false });

  assert.deepEqual(R.update('acc-4', { credit_limit: 750, net30_approved: true, status: 'suspended' }), { ok: true });
  const a = R.get('acc-4').account;
  assert.equal(a.credit_limit, 750);
  assert.equal(a.net30_approved, true);
  assert.equal(a.status, 'suspended');

  assert.deepEqual(R.update('nope', { status: 'closed' }), { ok: false },
    'a locally-unknown account is one the backend may still have — not one to fabricate');
});

test('a registry entry with no id is refused', async () => {
  const { BusinessAccountRegistry: R } = await loadUtil();
  withStorage(fakeStorage());
  assert.deepEqual(R.record({ user_id: UID, company_name: 'No Id Co' }), { ok: false });
  assert.deepEqual(R.all().accounts, []);
});

test('forget removes exactly one row', async () => {
  const { BusinessAccountRegistry: R } = await loadUtil();
  withStorage(fakeStorage());
  R.record({ business_account_id: 'a', user_id: UID });
  R.record({ business_account_id: 'b', user_id: OTHER_UID });
  R.forget('a');
  assert.deepEqual(R.all().accounts.map((x) => x.business_account_id), ['b']);
  delete globalThis.window;
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Wiring — the id is recorded first, and every door is owner-gated
// ═══════════════════════════════════════════════════════════════════════════

test('the 201 id is recorded BEFORE the modal closes or any callback runs', () => {
  const body = COMPONENT.match(/const data = await AdminAPI\.createBusinessAccount[\s\S]*?onUpgraded/);
  assert.ok(body, 'the create call must exist');
  const recordAt = body[0].indexOf('BusinessAccountRegistry.record');
  const closeAt = body[0].indexOf('Modal.close');
  assert.ok(recordAt > -1, 'the returned id must be recorded — there is no GET to re-read it');
  assert.ok(closeAt > -1);
  assert.ok(recordAt < closeAt,
    'anything that can throw between the response and the write loses the only copy of the ' +
    'account id permanently');
});

test('a 201 with no id, and a failed write, are both reported to the operator', () => {
  assert.match(COMPONENT, /if \(!id\)[\s\S]{0,240}Toast\.warning/,
    'an upgrade that succeeds without an id still leaves the account unmanageable — say so');
  assert.match(COMPONENT, /!recorded\.ok[\s\S]{0,240}Toast\.warning/);
  assert.match(COMPONENT, /copy it now/i,
    'if the id cannot be stored, the operator needs it on screen while it still exists');
});

test('every entry point is behind AdminAuth.isOwner()', () => {
  assert.match(CUSTOMERS, /function businessBlock\(\)\s*\{\s*if \(!AdminAuth\.isOwner\(\)\) return '';/,
    'the drawer block must be owner-gated the way invoicingBlock and the loyalty button are');
  assert.match(CUSTOMERS, /if \(AdminAuth\.isOwner\(\)\)[\s\S]{0,200}readBusinessState/,
    'a non-owner must not even fetch the applications queue');
  assert.match(PAGE, /if \(!AdminAuth\.isOwner\(\)\)[\s\S]{0,320}Access Restricted/,
    'the page needs its own in-page gate beside the router gate');
  assert.match(codeOnly(APP_SRC), /key: 'business'[^}]*ownerOnly: true/,
    'the router derives its gate from NAV_ITEMS — without ownerOnly a direct #business loads');
});

test('super_admin IS the owner role — the gate is not a guess', () => {
  // MOVED (Aug 2026, ERR-188): the role map used to sit inline in
  // js/admin/auth.js. site-guard.js carried a second, differently-spelled copy
  // ('super_admin' literal vs this one's stripped 'superadmin'), so one endpoint
  // had two accept-lists. It now lives once, in AdminAccess (js/utils.js), and
  // auth.js delegates. The assertion is unchanged in substance — it just looks
  // where the vocabulary actually is now.
  const utils = codeOnly(read(path.join(INK, 'js', 'utils.js')));
  assert.match(utils, /superadmin: 'owner'/);
  assert.match(utils, /replace\(\/\[\^a-z\]\/g, ''\)/,
    "the backend says super_admin; the strip is what turns it into 'superadmin' and then 'owner'");

  // And the gate must still READ that map rather than re-deciding for itself.
  const auth = codeOnly(read(path.join(ADMIN, 'auth.js')));
  assert.match(auth, /AdminAccess/,
    'auth.js must delegate to the shared vocabulary, not grow a third copy');
});

test('the drawer re-reads the queue after an upgrade instead of trusting its cache', () => {
  assert.match(CUSTOMERS, /onChanged:[\s\S]{0,300}resetApplicationsCache\(\)/,
    'the upgrade mints an approved application, so the cached table is immediately stale');
  assert.match(CUSTOMERS, /destroy\(\)[\s\S]{0,400}resetApplicationsCache\(\)/,
    'and it must not outlive the page');
});

test('the create/update writes throw with details attached', () => {
  const create = API.match(/async createBusinessAccount[\s\S]*?\n  \},/)[0];
  assert.match(create, /throw invoiceError\(/,
    'invoiceError folds details[] into the message and carries .code — errorFromEnvelope alone drops details');
  assert.match(create, /\/api\/admin\/business\/accounts/);
  const update = API.match(/async updateBusinessAccount[\s\S]*?\n  \},/)[0];
  assert.match(update, /window\.API\.patch\(/, 'PATCH, not POST — the route is PATCH /:id');
  assert.match(update, /encodeURIComponent/);
});

test('listBusinessAccounts asks the REAL namespace, and local ids are tagged', () => {
  const fn = API.match(/async listBusinessAccounts\(\)[\s\S]*?\n  \},/)[0];
  assert.match(fn, /\/api\/admin\/business\/accounts/,
    'every admin business route lives under /api/admin/business/* — the old ' +
    '/api/admin/business-accounts was a guessed URL that could never have lit up (ERR-152)');
  assert.doesNotMatch(fn, /admin\/business-accounts/);
  assert.match(fn, /_source: 'device'/,
    'a device-local id must be distinguishable from one the backend vouched for');
});

test('an unreadable server list still returns null when nothing local is known', () => {
  const fn = API.match(/async listBusinessAccounts\(\)[\s\S]*?\n  \},/)[0];
  assert.match(fn, /local\.length \? local : null/,
    'null = "we could not ask", [] = "there are none" — the invoice picker renders them differently');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Honesty — nothing on these surfaces claims more than it knows
// ═══════════════════════════════════════════════════════════════════════════

test('the device-local list never calls itself the list of business accounts', () => {
  assert.match(PAGE_SRC, /Accounts created on this device/);
  assert.match(PAGE_SRC, /This is not the list of business accounts/i,
    'GET /api/admin/business/accounts is a 404 — a heading that implied completeness would be ' +
    'a fabricated collection (ERR-063/068/073)');
  assert.match(PAGE_SRC, /404/, 'and it names the reason rather than hand-waving');
});

test('the applications queue is stated as read-only, with no invented action endpoint', () => {
  assert.doesNotMatch(PAGE, /\/approve|\/decline|\/reject/,
    'no approve/decline endpoint is published; a button that 404s is worse than no button');
  assert.match(PAGE_SRC, /read-only/i);
});

test('a partial applications read is disclosed on the page, not rounded to a count', () => {
  assert.match(PAGE, /Showing the first \$\{all\.length\} of \$\{total\}/,
    '"3 applications" when 47 exist is the silent-truncation failure');
});

test('a pending application warns that upgrading supersedes it, before the click', () => {
  assert.match(COMPONENT_SRC, /superseded/i);
  assert.match(COMPONENT_SRC, /No decline email is sent/i,
    'the operator is about to close someone\'s application — the side effect belongs up front');
});

test('the unknown state is framed as our read failing, not as a verdict', () => {
  assert.match(COMPONENT_SRC, /not a statement about their account/i,
    'ERR-139 exactly: an outage rendered as "they are not a business account"');
});

test('a customer with no local id is told WHY they cannot be managed here', () => {
  assert.match(COMPONENT_SRC, /Account id unknown on this device/);
  assert.match(COMPONENT_SRC, /GET \/api\/admin\/business\/accounts/);
});

test('unreadable local storage renders differently from "no record"', () => {
  assert.match(COMPONENT, /if \(!local\.readable\)[\s\S]{0,300}can't be read/,
    'they look identical to a naive caller and mean opposite things');
});

test('the addresses caveat is on the form, where it changes what gets typed', () => {
  assert.match(COMPONENT_SRC, /all-or-nothing/i);
});

test('the credit-limit help says what it is NOT for', () => {
  assert.match(COMPONENT_SRC, /Volume pricing does not depend on it/i,
    'the handoff is explicit that credit_limit is Net 30 exposure only; an operator who ' +
    'thinks it drives discounts will set it wrong in both directions');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Escaping and styling
// ═══════════════════════════════════════════════════════════════════════════

// Fields that arrive from the backend or from an operator's typing and are
// stored verbatim — every one of these reaching HTML must go through esc/escA.
const UNTRUSTED = /\b(company_name|contact_email|contact_name|business_account_id|recorded_by|application_id|nzbn|address1|address2|postcode)\b/;

/** Pull one top-level function body out of a comment-stripped source. */
function fnBody(src, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  assert.ok(m, `${name} must exist`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

test('every untrusted value the HTML builders interpolate is escaped', () => {
  // Modal.open escapes only the title; body and footer are raw HTML, so these
  // builders are the last line of defence.
  const builders = [
    ['business-upgrade.js businessPanelHtml', fnBody(COMPONENT, 'businessPanelHtml')],
    ['business-upgrade.js localAccountHtml', fnBody(COMPONENT, 'localAccountHtml')],
    ['business-upgrade.js field', fnBody(COMPONENT, 'field')],
    ['business-upgrade.js addressFieldset', fnBody(COMPONENT, 'addressFieldset')],
    ['business.js localAccountsHtml', fnBody(PAGE, 'localAccountsHtml')],
  ];
  // Builders that escape their own arguments. A call to one of these is safe;
  // this list is narrow on purpose, and each entry is asserted below.
  const DELEGATES = /^\$\{(field|row|addressFieldset)\(/;
  const bad = [];
  for (const [label, body] of builders) {
    for (const expr of body.match(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || []) {
      if (!UNTRUSTED.test(expr)) continue;
      if (DELEGATES.test(expr)) continue;
      if (/\besc\(|\bescA\(/.test(expr)) continue;
      bad.push(`${label}: ${expr}`);
    }
  }
  assert.deepEqual(bad, [],
    'company_name is typed by an operator and stored verbatim by the backend — it reaches ' +
    'the drawer, the modal title, the page table and the invoice picker');
});

test('row() escapes unless the caller explicitly opts into raw HTML', () => {
  const row = fnBody(COMPONENT, 'row');
  assert.match(row, /raw \? value : esc\(value\)/,
    'the raw path exists only for values this file built itself (badges, <code> ids)');
  assert.match(row, /esc\(label\)/);
});

test('field() escapes every argument — the escaping test above delegates to it', () => {
  const field = fnBody(COMPONENT, 'field');
  for (const bit of ['label', 'name', 'value', 'placeholder', 'help', 'type']) {
    assert.match(field, new RegExp(`esc[A]?\\(${bit}\\)`),
      `field() interpolates ${bit} into HTML, and addressFieldset/upgradeFormHtml trust it to escape`);
  }
  // `attrs` is deliberately raw — it carries min/max/step written in this file.
  assert.doesNotMatch(field, /value="\$\{value\}"/);
});

test('the page escapes application rows it renders into the table', () => {
  // DataTable inserts column render() output as raw HTML.
  const cols = PAGE.slice(PAGE.indexOf('const APP_COLUMNS'), PAGE.indexOf('async function loadApplicationsTable'));
  for (const expr of cols.match(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || []) {
    if (UNTRUSTED.test(expr)) {
      assert.match(expr, /\besc\(|\bescA\(/, `unescaped application field in a table column: ${expr}`);
    }
  }
});

test('the badge vocabulary distinguishes suspended from closed', () => {
  assert.match(ADMIN_CSS, /\.admin-badge--suspended/);
  assert.match(ADMIN_CSS, /\.admin-badge--closed/);
  assert.ok(
    !/\.admin-badge--suspended,\s*\.admin-badge--closed/.test(ADMIN_CSS),
    'a suspended account can be reinstated and a closed one is over — one colour for both ' +
    'invites reinstating the wrong account',
  );
  assert.match(ADMIN_CSS, /\.admin-badge--business/);
});

test('the wide modal is capped in vw so it fits a laptop in a shop', () => {
  assert.match(ADMIN_CSS, /\.admin-modal--wide\s*\{[^}]*min\(\s*\d+px\s*,\s*\d+vw\s*\)/);
});

test('an autocomplete inside a modal is raised ABOVE the backdrop', () => {
  // Found live: the customer picker is the first autocomplete mounted inside a
  // plain .admin-modal. The portalled menu sits at 1150, deliberately under
  // .admin-modal-backdrop (1200) so a confirm dialog can cover it — which meant
  // the picker's results rendered, and every click landed on the backdrop.
  const ac = codeOnly(read(path.join(ADMIN, 'components', 'autocomplete.js')));
  assert.match(ac, /input\.closest\('\.admin-modal-backdrop'\)/,
    'the raise is measured from the anchor, not passed in — so no caller can forget it');
  assert.match(ac, /admin-ac__menu--over-modal/);

  const base = /\.admin-ac__menu\s*\{[^}]*z-index:\s*(\d+)/.exec(ADMIN_CSS);
  const over = /\.admin-ac__menu--over-modal\s*\{[^}]*z-index:\s*(\d+)/.exec(ADMIN_CSS);
  const backdrop = /\.admin-modal-backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(ADMIN_CSS);
  assert.ok(base && over && backdrop, 'all three z-indexes must be findable');
  assert.ok(Number(base[1]) < Number(backdrop[1]),
    'the default stays UNDER the backdrop so a confirm dialog still covers a drawer autocomplete');
  assert.ok(Number(over[1]) > Number(backdrop[1]),
    'and the in-modal variant clears it, or its results are unclickable');
});
