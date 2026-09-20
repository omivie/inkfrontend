/**
 * The machine list can be saved again — and a save has to PROVE itself
 * ====================================================================
 * ERR-272 · Sep 2026 · answers BF-062
 *
 * For ten days the admin's "Compatible Devices / For Use In" panel was
 * read-only, and correctly so: migration 132 moved the list out of `products`
 * into `product_compat_devices`, and we measured `PUT /api/admin/products/:id`
 * answering 200 for the field while discarding it (ERR-244). An editor whose
 * Save silently drops the operator's typing is strictly worse than no editor,
 * because they walk away believing the work is done.
 *
 * The backend's reply to BF-062 says that route has written the field since
 * 6 Aug 2026 and that we measured the wrong one (`by-sku`, whose Joi schema
 * declared three fields while `stripUnknown` deleted the other twenty-seven).
 *
 * We did not take their word for it. `npm run probe:product-write -- --write`
 * creates a throwaway product, writes, and asks an independent reader whether
 * the write landed — 21/0 on 2026-09-20. This file pins the FRONTEND half of
 * that: the behaviour the probe cannot see because it lives in our code.
 *
 * ── THE THREE THINGS THAT MUST NOT REGRESS ─────────────────────────────────
 *
 * 1. A SAVE IS VERIFIED BY A RE-READ, NEVER BY THE ROUTE'S OWN ECHO.
 *    The backend's reply proposes the echo as the proof. It cannot be: a route
 *    that strips the field can still return the string it was handed, which is
 *    how every decoy in this codebase has worked (ERR-151). And measured, the
 *    echo is not even there — no `compatible_devices_html` key comes back at
 *    all, so an implementation built on their suggestion would read every good
 *    write as a silent strip. `saved` therefore requires a re-read that agrees;
 *    anything less is `saved-unverified`, which is NOT a success.
 *
 * 2. '' CLEARS AND OMISSION PRESERVES, AND THE UI MUST NEVER CONFUSE THEM.
 *    Measured (probe §7). So an editor that resends its own seed on every save
 *    would turn one failed read into a silent wipe. The panel owns its own Save
 *    button; the create handler omits the key rather than sending `''`.
 *
 * 3. A FAILED LIST WRITE IS NOT A FAILED SAVE.
 *    Their §1: when the list fails the route answers 500 with the product row
 *    already written. "Save failed" would send an operator to retype a name
 *    that is already stored. `list-failed` says the true thing.
 *
 * ── HOW THIS FILE TESTS ────────────────────────────────────────────────────
 *
 * By EXECUTING the shipped module against fakes, not by grepping it. A source
 * grep pins the text that was there, not the branch that runs (ERR-263), and
 * this is entirely about which branch runs. Where a grep IS used — for the
 * call-site contracts in products.js — it runs over comment-STRIPPED source,
 * because this probe's own first run failed by matching a comment about the
 * field instead of a use of it.
 *
 * Every guard is red-proofed: §9 mutates a lifted copy of the module and
 * asserts the original defect returns. ERR-258 is six guards that could not
 * fail sitting inside a 6088/0 green suite.
 *
 * Run: node --test tests/for-use-in-write-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codeOnly = require('./helpers/strip-comments.js');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FUI_SRC = read('inkcartridges/js/admin/utils/for-use-in.js');
const PRODUCTS_SRC = read('inkcartridges/js/admin/pages/products.js');
const FUI_CODE = codeOnly(FUI_SRC);
const PRODUCTS_CODE = codeOnly(PRODUCTS_SRC);

const load = () => import(path.join(SITE, 'js/admin/utils/for-use-in.js'));

/** A minimal AdminAPI stand-in. Records what it was asked to write. */
function fakeAdminApi({ putThrows = null, stored = undefined, getThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    async updateProduct(id, payload) {
      calls.push({ id, payload });
      if (putThrows) throw putThrows;
      return { ok: true };
    },
    async getProduct() {
      if (getThrows) throw new Error('network');
      if (stored === undefined) return {};             // key ABSENT
      return { compatible_devices_html: stored };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. The stripper actually read these files
//
// Every `doesNotMatch` below asserts about text that ISN'T there, and those
// pass just as happily over a string that was never populated — which is how
// ERR-253 hid 22,251 characters of live code across 35 suites, in the direction
// that makes an assertion pass by construction.
// ─────────────────────────────────────────────────────────────────────────────

test('§0 the stripped sources are real code, not an empty string', () => {
  assert.ok(PRODUCTS_CODE.length > 100000,
    `products.js stripped to ${PRODUCTS_CODE.length} chars — too small to be the real file`);
  assert.ok(FUI_CODE.length > 2000,
    `for-use-in.js stripped to ${FUI_CODE.length} chars — too small to be the real file`);
  assert.match(FUI_CODE, /export async function writeForUseIn\(/);
  assert.match(FUI_CODE, /export function forUseInCreateValue\(/);
  // Positive control for the stripper: prose that exists ONLY in a comment must
  // be gone. Deliberately not a string any guard below also depends on, so this
  // cannot go red in sympathy with an unrelated failure (the ERR-267 G0 lesson).
  assert.doesNotMatch(FUI_CODE, /AN ECHO IS NOT A MEASUREMENT/,
    'strip-comments left comment prose in the code string — every guard below is unreliable');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. A save is proved by a re-read, not by the route's echo
// ─────────────────────────────────────────────────────────────────────────────

test('§1 a write confirmed by the re-read is `saved`', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  const api = fakeAdminApi({ stored: '<div>A<br>B</div>' });
  const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>A<br>B</div>', { adminApi: api });

  assert.equal(out.state, FOR_USE_IN_WRITE.SAVED);
  assert.equal(out.verified, true);
  assert.equal(out.reason, null);
});

test('§1 🚨 a route that ACCEPTS but does not persist is NOT reported as saved', async () => {
  // The exact ERR-244 failure, and the reason this module re-reads at all: the
  // PUT resolves happily and the list is unchanged on the server.
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  const api = fakeAdminApi({ stored: '<div>the OLD list</div>' });
  const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>the NEW list</div>', { adminApi: api });

  assert.equal(out.state, FOR_USE_IN_WRITE.SAVED_UNVERIFIED,
    'a silent strip must never paint a success');
  assert.equal(out.verified, false);
  assert.match(out.reason, /read back something different/i);
});

test('§1 an unreadable confirmation is `saved-unverified`, not `saved`', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  for (const api of [fakeAdminApi({ getThrows: true }), fakeAdminApi({ stored: undefined })]) {
    const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>x</div>', { adminApi: api });
    assert.equal(out.state, FOR_USE_IN_WRITE.SAVED_UNVERIFIED,
      'absence of confirmation is not confirmation (ERR-063/068/073/075/076/149/150)');
    assert.equal(out.verified, false);
  }
});

test('§1 POSITIVE CONTROL — the sanitiser rewriting <br> still counts as saved', async () => {
  // Measured: the backend stores `<br>` as `<br />`. A byte comparison fails a
  // perfectly good save on that alone — this probe's own first run did exactly
  // that three times, and ERR-243 had recorded the transform a fortnight before.
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  const api = fakeAdminApi({ stored: '<div>A<br />B</div>' });
  const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>A<br>B</div>', { adminApi: api });

  assert.equal(out.state, FOR_USE_IN_WRITE.SAVED);
  assert.equal(out.html, '<div>A<br />B</div>',
    'the editor must be re-seeded with the SERVER copy, or the next reopen reads as unsaved');
});

test('§1 the normaliser forgives ONLY the transforms it names', async () => {
  const { normaliseForUseIn, forUseInChanged } = await load();
  // Forgiven, because measured.
  assert.equal(forUseInChanged('<div>A<br>B</div>', '<div>A<br />B</div>'), false);
  assert.equal(forUseInChanged('<div>A</div>', '  <div>A</div>  '), false);
  // NOT forgiven. A normaliser loose enough to hide these would hide real loss.
  assert.equal(forUseInChanged('<div><b>A</b></div>', '<div>A</div>'), true, 'a dropped tag is a difference');
  assert.equal(forUseInChanged('<div>A<br>B</div>', '<div>A</div>'), true, 'dropped text is a difference');
  assert.equal(normaliseForUseIn(null), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. '' clears; nothing else does
// ─────────────────────────────────────────────────────────────────────────────

test('§2 an empty string is sent through as a deliberate clear', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE, FOR_USE_IN_WRITE_ROUTE } = await load();
  const api = fakeAdminApi({ stored: null });
  const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '', { adminApi: api });

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].payload[FOR_USE_IN_WRITE_ROUTE.field], '');
  assert.equal(out.state, FOR_USE_IN_WRITE.SAVED, 'clearing is a successful save, not a failure');
});

test('§2 🚨 null/undefined are REFUSED, never coerced into a clear', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  for (const value of [null, undefined, 0, {}]) {
    const api = fakeAdminApi({ stored: '<div>keep me</div>' });
    const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, value, { adminApi: api });
    assert.equal(out.state, FOR_USE_IN_WRITE.REFUSED,
      `${JSON.stringify(value)} must not be treated as "delete the list"`);
    assert.equal(api.calls.length, 0, 'and nothing may be sent at all');
  }
});

test('§2 the write body carries the list and the identifiers, and nothing else', async () => {
  // A write that quietly resends stale form values is how a save on one field
  // reverts another — the ERR-244 family, and why stock_quantity is kept off the
  // main product payload.
  const { writeForUseIn, FOR_USE_IN_WRITE_ROUTE } = await load();
  const api = fakeAdminApi({ stored: '<div>x</div>' });
  await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>x</div>', { adminApi: api, retailPrice: 12.5 });

  const keys = Object.keys(api.calls[0].payload).sort();
  assert.deepEqual(keys, [FOR_USE_IN_WRITE_ROUTE.field, 'retail_price', 'sku'].sort(),
    `the body grew extra keys: ${keys.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A failed LIST write is not a failed SAVE
// ─────────────────────────────────────────────────────────────────────────────

test('§3 a 500 says the product saved and the list did not', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  const err = Object.assign(new Error('Update failed'), { status: 500 });
  const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>x</div>',
    { adminApi: fakeAdminApi({ putThrows: err }) });

  assert.equal(out.state, FOR_USE_IN_WRITE.LIST_FAILED);
  assert.match(out.reason, /product saved/i);
  assert.match(out.reason, /nothing else on this product needs re-entering/i);
});

test('§3 an ordinary refusal is `refused`, and is not confused with the above', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  const err = Object.assign(new Error('nope'), { status: 400 });
  const out = await writeForUseIn({ id: 'p1', sku: 'S1' }, '<div>x</div>',
    { adminApi: fakeAdminApi({ putThrows: err }) });

  assert.equal(out.state, FOR_USE_IN_WRITE.REFUSED);
  assert.doesNotMatch(out.reason || '', /product saved/i,
    'a plain refusal must not claim the product row was written');
});

test('§3 no id, or no API client, refuses before sending anything', async () => {
  const { writeForUseIn, FOR_USE_IN_WRITE } = await load();
  const api = fakeAdminApi({ stored: 'x' });
  assert.equal((await writeForUseIn({ sku: 'S1' }, 'x', { adminApi: api })).state, FOR_USE_IN_WRITE.REFUSED);
  assert.equal((await writeForUseIn({ id: 'p1' }, 'x', { adminApi: {} })).state, FOR_USE_IN_WRITE.REFUSED);
  assert.equal(api.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The read side still has three states (ERR-243, unchanged)
// ─────────────────────────────────────────────────────────────────────────────

test('§4 ok / none / unavailable are still distinct, and 429 is not "no list"', async () => {
  const { readForUseIn, FOR_USE_IN_STATE } = await load();
  const api = (resp) => ({ getForUseIn: async () => resp });

  assert.equal((await readForUseIn('S', { api: api({ ok: true, data: { for_use_in_html: '<div>x</div>' } }) })).state,
    FOR_USE_IN_STATE.OK);
  assert.equal((await readForUseIn('S', { api: api({ ok: true, data: { for_use_in_html: null } }) })).state,
    FOR_USE_IN_STATE.NONE);
  // A 429 body has NO such key. Reading that absence as an empty list is what
  // nearly sent the backend a data-loss alarm (ERR-243).
  assert.equal((await readForUseIn('S', { api: api({ ok: true, data: {} }) })).state,
    FOR_USE_IN_STATE.UNAVAILABLE);
  assert.equal((await readForUseIn('', { api: api({ ok: true, data: {} }) })).state,
    FOR_USE_IN_STATE.UNAVAILABLE);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The preview never executes what it renders
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the preview strips scripts, handlers and every attribute', async () => {
  const { previewForUseIn } = await load();

  const nasty = '<div onclick="steal()">A</div><script>alert(1)</script>'
    + '<img src=x onerror="steal()"><a href="javascript:x()">link</a>'
    + '<iframe src="//evil"></iframe><b style="x">bold</b>';
  const out = previewForUseIn(nasty);

  assert.doesNotMatch(out, /<script/i, 'no script element');
  assert.doesNotMatch(out, /onerror|onclick/i, 'no event handler survives');
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /<iframe/i);
  assert.doesNotMatch(out, /<img/i, 'img is not on the allow-list');
  assert.doesNotMatch(out, /style=/i, 'no attributes at all');
  assert.doesNotMatch(out, /alert\(1\)/, 'a script BODY must go with its tag, not survive as text');
  // POSITIVE CONTROL — it must not simply be stripping everything.
  assert.match(out, /<div>A<\/div>/, 'allow-listed markup survives');
  assert.match(out, /<b>bold<\/b>/, 'and keeps its text');
});

test('§5 the wide allow-list this field actually needs is preserved', async () => {
  // Their §1: the machine list is sanitised with a WIDER tag allow-list than
  // descriptions — div, b, span, br survive, because the description sanitiser
  // would collapse the list into one run-on paragraph.
  const { previewForUseIn } = await load();
  const out = previewForUseIn('<div><b>HP</b> <span>LaserJet</span><br>Epson LQ-300+</div>');
  for (const tag of ['div', 'b', 'span', 'br']) {
    assert.match(out, new RegExp(`<${tag}>`), `<${tag}> must survive the preview`);
  }
  assert.match(out, /Epson LQ-300\+/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The create path omits rather than clears
// ─────────────────────────────────────────────────────────────────────────────

test('§6 forUseInCreateValue returns null for an empty box, never an empty string', async () => {
  const { forUseInCreateValue } = await load();
  const root = (value) => ({ querySelector: (sel) => (sel === '#for-use-in-input' ? { value } : null) });

  assert.equal(forUseInCreateValue(root('')), null, "'' is the CLEAR instruction — a create has nothing to clear");
  assert.equal(forUseInCreateValue(root('   ')), null, 'whitespace only is still nothing');
  assert.equal(forUseInCreateValue(root('<div>x</div>')), '<div>x</div>');
  assert.equal(forUseInCreateValue(null), null);
  assert.equal(forUseInCreateValue({}), null);
});

test('§6 the create handler omits the key when there is no list', () => {
  // Guarding the SHAPE of the call, since the value logic is tested above.
  assert.match(PRODUCTS_CODE, /const newForUseIn = forUseInCreateValue\(modal\);/,
    'the create handler must read the value through the module accessor');
  assert.match(PRODUCTS_CODE, /if \(newForUseIn !== null\) data\.compatible_devices_html = newForUseIn;/,
    'and must OMIT the key rather than sending an empty string');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. One owner, and the seam that flipped
// ─────────────────────────────────────────────────────────────────────────────

test('§7 the write route is declared exactly once and every surface reads it', () => {
  const declarations = (FUI_CODE.match(/FOR_USE_IN_WRITE_ROUTE\s*=\s*Object\.freeze/g) || []).length;
  assert.equal(declarations, 1, 'one owner for the route — ERR-187/192, where one rule reached six copies');
  // The field name must not be spelled anywhere else in the admin pages: the
  // module owns it, and forUseInCreateValue() is how the create handler reads it.
  const spellings = (PRODUCTS_CODE.match(/compatible_devices_html/g) || []).length;
  assert.equal(spellings, 1,
    `products.js names the field ${spellings} times; exactly one (the create payload) is expected`);
});

test('§7 the panel no longer tells operators their save will be discarded', async () => {
  const { forUseInNotice, canWriteForUseIn } = await load();
  assert.equal(canWriteForUseIn(), true, 'the write seam must be live');
  const notice = forUseInNotice();
  assert.doesNotMatch(notice, /read-only/i, 'the copy must stop saying the field cannot be saved');
  assert.doesNotMatch(notice, /silently discarded/i);
  assert.doesNotMatch(notice, /BF-062/, 'the ask is answered — stop asking for it in the UI');
  // POSITIVE CONTROL — it still explains the two things an operator can get wrong.
  assert.match(notice, /CLEARS/, 'an empty save clears, and must say so');
  assert.match(notice, /<div>|<br>/, 'and must name which tags survive');
});

test('§7 the drawer passes the product id, or the panel can never save', () => {
  assert.match(PRODUCTS_CODE, /wireForUseInPanel\(modal, full\.sku, esc, \{[\s\S]{0,400}?productId: full\.id/,
    'the edit drawer must hand the panel an id');
  assert.match(PRODUCTS_CODE, /mode: 'create'/, 'and the create modal must use create mode');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The margin page no longer reports a refusal as a success
// ─────────────────────────────────────────────────────────────────────────────

test('§8 the Margin page writes through AdminAPI, not a raw PUT', () => {
  const MARGIN_CODE = codeOnly(read('inkcartridges/js/admin/pages/margin.js'));
  assert.ok(MARGIN_CODE.length > 2000, 'margin.js stripped too small to trust');
  assert.match(MARGIN_CODE, /AdminAPI\.updateProduct\(id, \{ retail_price: price \}\)/,
    'the Apply button must go through the client that throws on {ok:false}');
  assert.doesNotMatch(MARGIN_CODE, /_fetchWithAuth\([^)]*\/api\/admin\/products/,
    'a raw _fetchWithAuth PUT resolves for a refusal — the button went green on a failed write');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. RED-PROOF — every guard above must be capable of failing
//
// ERR-258: six guards that could not fail sat inside a 6088/0 green suite. A
// guard is only evidence if the defect it describes actually turns it red. The
// mutations below are applied to a lifted STRING and evaluated, never to the
// file — peers hold this repo and a mutated file on disk is a deployed file.
// ─────────────────────────────────────────────────────────────────────────────

const { runInNewContext } = require('node:vm');

/** Evaluate a mutated copy of the module's `writeForUseIn` logic. */
async function withMutatedModule(mutate) {
  const mutated = mutate(FUI_SRC);
  assert.notEqual(mutated, FUI_SRC, 'the mutation did not apply — the red-proof is vacuous');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fui-mutant-'));
  const file = path.join(dir, 'for-use-in.mjs');
  fs.writeFileSync(file, mutated);
  try {
    return await import(`file://${file}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

test('§9 MUTANT — folding saved-unverified into saved brings the defect back', async () => {
  const mod = await withMutatedModule((src) => src.replace(
    '    if (!confirmedKnown) {\n        return done(FOR_USE_IN_WRITE.SAVED_UNVERIFIED, html,',
    '    if (!confirmedKnown) {\n        return done(FOR_USE_IN_WRITE.SAVED, html,'));
  const api = fakeAdminApi({ getThrows: true });
  const out = await mod.writeForUseIn({ id: 'p1', sku: 'S' }, '<div>x</div>', { adminApi: api });
  assert.equal(out.state, 'saved',
    'the mutant must report the unverified write as saved — otherwise §1 proves nothing');
});

test('§9 MUTANT — dropping the re-read makes a silent strip look successful', async () => {
  const mod = await withMutatedModule((src) => src.replace(
    '    if (!forUseInChanged(confirmed, html)) {',
    '    if (true) {'));
  const api = fakeAdminApi({ stored: '<div>the OLD list</div>' });
  const out = await mod.writeForUseIn({ id: 'p1', sku: 'S' }, '<div>the NEW list</div>', { adminApi: api });
  assert.equal(out.state, 'saved',
    'the mutant must call an unpersisted write saved — otherwise the re-read is not load-bearing');
});

test('§9 MUTANT — coercing a non-string to "" turns a bug into a deletion', async () => {
  const mod = await withMutatedModule((src) => src.replace(
    "    if (typeof html !== 'string') {",
    "    if (false) {"));
  const api = fakeAdminApi({ stored: null });
  await mod.writeForUseIn({ id: 'p1', sku: 'S' }, undefined, { adminApi: api });
  assert.equal(api.calls.length, 1, 'the mutant must send the write');
  assert.equal(api.calls[0].payload.compatible_devices_html, undefined,
    'and it is the CLEAR path that §2 exists to prevent');
});

test('§9 MUTANT — a loose normaliser hides a dropped tag', async () => {
  const mod = await withMutatedModule((src) => src.replace(
    'export const forUseInChanged = (a, b) => normaliseForUseIn(a) !== normaliseForUseIn(b);',
    'export const forUseInChanged = () => false;'));
  assert.equal(mod.forUseInChanged('<div><b>A</b></div>', '<div>A</div>'), false,
    'the mutant must stop seeing a dropped tag — otherwise the normaliser test proves nothing');
  // and the consequence that actually matters: a silent strip becomes a success
  const api = fakeAdminApi({ stored: '<div>the OLD list</div>' });
  const out = await mod.writeForUseIn({ id: 'p1', sku: 'S' }, '<div>the NEW list</div>', { adminApi: api });
  assert.equal(out.state, 'saved', 'a blind comparison reports an unpersisted write as saved');
});

test('§9 MUTANT — an allow-list without the tag filter lets a handler through', async () => {
  const mod = await withMutatedModule((src) => src.replace(
    '            if (!PREVIEW_ALLOWED.includes(name)) return \'\';\n            return match[1] === \'/\' ? `</${name}>` : `<${name}>`;',
    '            return match;'));
  const out = mod.previewForUseIn('<div onclick="steal()">A</div>');
  assert.match(out, /onclick/,
    'the mutant must leak the handler — otherwise §5 is not testing the rebuild');
});
