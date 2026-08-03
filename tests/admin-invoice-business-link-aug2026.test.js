/**
 * ADMIN INVOICE → BUSINESS ACCOUNT LINK (Aug 2026)
 * ================================================
 *
 * `standalone_invoices.business_account_id` is the ONLY thing that puts an
 * invoice on a customer's /business portal: GET /api/business/invoices filters
 * on that FK and never on email, because a shared or mistyped billing address
 * would expose another company's invoices — a data leak wearing UX clothes.
 *
 * The failure modes these tests exist to prevent:
 *
 *   1. THE FIELD GOING MISSING FROM buildPayload AGAIN. It isn't only about
 *      linking. setStatusViaFullUpdate() rehydrates a record by walking
 *      Object.keys(payload), and documentDrift() diffs the same key set — so a
 *      field absent from the payload is invisible to BOTH. While
 *      business_account_id was missing, the first flick of the Paid toggle on a
 *      linked invoice would silently drop the link and remove the invoice from
 *      the customer's portal, with no symptom. (ERR-142)
 *   2. AUTO-LINKING ON A MATCH. Linking publishes a document to a customer's
 *      portal. An email or name match is a prompt for a human decision, never
 *      authority to grant access.
 *   3. "NOT LINKED" BECOMING INVISIBLE. An unlinked invoice is simply absent
 *      from the portal; there is no other symptom an operator could notice, so
 *      the editor has to say it in words.
 *   4. null COLLAPSING INTO []. "We couldn't ask for the accounts" and "there
 *      are no approved accounts" are different, and they render differently.
 *
 * Run: node --test tests/admin-invoice-business-link-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const INVOICES = read('js/admin/pages/invoices.js');
const ADMIN_API = read('js/admin/api.js');
const ADMIN_CSS = read('css/admin.css');

/** Strip comments so a literal inside a comment can't satisfy an assertion. */
const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');

const CODE = codeOnly(INVOICES);
const API_CODE = codeOnly(ADMIN_API);

// ═════════════════════════════════════════════════════════════════════════════
// §1 — the two fields survive a round trip
// ═════════════════════════════════════════════════════════════════════════════

test('§1 freshDraft carries both fields, so the editor has somewhere to put them', () => {
    const draft = CODE.slice(CODE.indexOf('function freshDraft()'), CODE.indexOf('function draftFromInvoice'));
    assert.match(draft, /business_account_id:\s*null/,
        'null, not undefined — an absent key would never reach buildPayload');
    assert.match(draft, /po_number:\s*''/);
});

test('§1 draftFromInvoice reads both back, so an edit does not drop them', () => {
    const from = CODE.slice(CODE.indexOf('function draftFromInvoice'), CODE.indexOf('function buildPayload'));
    assert.match(from, /d\.business_account_id = rec\.business_account_id \?\? null/,
        '`??` not `||` — the id is a uuid, but the habit of collapsing falsy to a default is ' +
        'how a real value becomes a default elsewhere');
    assert.match(from, /d\.po_number = rec\.po_number \?\? ''/);
});

test('§1 buildPayload SENDS both — the full-record PUT is blind to anything it omits', () => {
    const payload = CODE.slice(CODE.indexOf('function buildPayload'), CODE.indexOf('function buildPayload') + 2000);
    assert.match(payload, /business_account_id:/,
        'setStatusViaFullUpdate walks Object.keys(payload); a missing key is silently dropped ' +
        'on every Paid toggle, unlinking the invoice with no symptom (ERR-142)');
    assert.match(payload, /po_number:/);
});

test('§1 the preservation loop and the drift guard both walk the payload key set', () => {
    // This is WHY §1 above matters. If either of these ever stops keying off
    // Object.keys(payload), adding a field to buildPayload no longer protects it.
    assert.match(CODE, /for \(const key of Object\.keys\(payload\)\)/,
        'setStatusViaFullUpdate must rehydrate by walking the payload keys');
    assert.match(CODE, /Object\.keys\(payload\)\s*\n?\s*\.filter/,
        'documentDrift must diff the same key set');
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — a suggestion is not a decision
// ═════════════════════════════════════════════════════════════════════════════

test('§2 the matcher only FINDS — it never assigns', () => {
    const fn = CODE.slice(CODE.indexOf('function suggestedBusinessAccount'), CODE.indexOf('const bizAccountLabel'));
    assert.ok(fn.length > 50, 'suggestedBusinessAccount must exist');
    assert.ok(!/_draft\.business_account_id\s*=/.test(fn),
        'matching a customer to an account must not link the invoice — linking publishes the ' +
        'document to that portal, so it takes an explicit human click');
    assert.match(fn, /a\.user_id === uid|uid && a\.user_id/,
        'the strong signal is the user id; email is the fallback, and only as a suggestion');
});

test('§2 the only assignment is behind an explicit click', () => {
    // Every place the draft's link is set, and what gates it.
    const assignments = CODE.split('\n').filter((l) => /_draft\.business_account_id\s*=/.test(l));
    assert.ok(assignments.length >= 2, 'expected the link and unlink actions to assign');

    const linkAction = CODE.slice(CODE.indexOf("act === 'link-business'"), CODE.indexOf("act === 'unlink-business'"));
    assert.match(linkAction, /dataset\.accountId/,
        'the id must come off the clicked button, not from the matcher directly');
    assert.match(linkAction, /if \(!id\) return;/, 'no id, no link');

    // And the auto-fill paths must NOT touch it.
    for (const fnName of ['function loadFromContact', 'async function loadFromCustomer']) {
        const start = CODE.indexOf(fnName);
        assert.ok(start > -1, `${fnName} must exist`);
        const body = CODE.slice(start, start + 2200);
        assert.ok(!/_draft\.business_account_id\s*=/.test(body),
            `${fnName} fills ADDRESS FIELDS; it must never grant portal access as a side effect`);
    }
});

test('§2 the fill sources carry identity so a suggestion is possible at all', () => {
    assert.match(CODE, /_fillSource = \{ type: 'contact'[^}]*email:/,
        'the contact picker used to discard everything but a label');
    assert.match(CODE, /_fillSource = \{ type: 'customer'[^}]*userId:/,
        'the customer id is the strong match signal');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — the state is stated
// ═════════════════════════════════════════════════════════════════════════════

test('§3 "Not linked" is spelled out, because the failure it prevents is invisible', () => {
    assert.match(INVOICES, /Not linked — this invoice will not appear on any customer's Business Centre/,
        'an unlinked invoice is simply absent from the portal; without this line an operator ' +
        'cannot answer "why isn\'t my invoice showing?" (backend brief §7 follow-on)');
    assert.match(INVOICES, /Linked to/, 'the positive state must name the company');
    assert.match(CODE, /data-form-action="unlink-business"/, 'a link must be reversible');
});

test('§3 all three block states exist: linked, unavailable, and pickable', () => {
    const fn = CODE.slice(CODE.indexOf('function businessLinkHtml'), CODE.indexOf('function editorBodyHtml'));
    assert.match(fn, /_bizAccounts === undefined/, 'not looked up yet');
    assert.match(fn, /_bizAccounts === null/, 'the endpoint is unavailable');
    assert.match(fn, /Linking is unavailable/,
        'when the accounts endpoint is missing the operator must be told the CONTROL is missing, ' +
        'not left to conclude the customer has no account');
    assert.match(ADMIN_CSS, /\.inv-biz__state--off/, 'the not-linked state needs a visible treatment');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — null is not empty
// ═════════════════════════════════════════════════════════════════════════════

test('§4 listBusinessAccounts resolves null when it could not ask, never []', () => {
    // Anchored on the full signature: `async getInvoice` also matches
    // getInvoicePreviewUrl, which sits ~250 lines EARLIER and would slice backwards.
    const fn = API_CODE.slice(API_CODE.indexOf('async listBusinessAccounts'), API_CODE.indexOf('async getInvoice(invoiceId)'));
    assert.ok(fn.length > 50, 'listBusinessAccounts must exist');
    assert.match(fn, /if \(!Array\.isArray\(rows\)\) return null/,
        '[] means "there are no approved accounts"; null means "we could not ask" — the editor ' +
        'renders them differently and collapsing them hides an outage');
    assert.match(fn, /return null;/, 'a thrown request must also degrade to null');
    assert.ok(!/return \[\]/.test(fn), 'an empty array would claim there are no business accounts');
});

test('§4 the editor still opens when the accounts lookup is slow or dead', () => {
    assert.match(CODE, /ensureBusinessAccounts\(\);/,
        'fired without await — the block renders its own checking/unavailable states, so a ' +
        'missing endpoint must never block the drawer from opening');
    const ensure = CODE.slice(CODE.indexOf('async function ensureBusinessAccounts'), CODE.indexOf('function suggestedBusinessAccount'));
    assert.match(ensure, /editorAlive\(token\)/,
        'an async resolve after the drawer closed must not write into a dead editor (ERR-045)');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — the PO number is the customer's, and it reaches them
// ═════════════════════════════════════════════════════════════════════════════

test('§5 po_number is editable, sent, and printed on the reproduction', () => {
    assert.match(CODE, /data-field="po_number"/, 'the operator needs a field to type it in');
    const pdf = codeOnly(read('js/business-invoice-pdf.js'));
    assert.match(pdf, /inv\.po_number/,
        'without it the customer cannot match the document to their own purchase order, ' +
        'which is most of why they wanted it');
});
