/**
 * Return requests — the first return surface on the site (Aug 2026)
 * =================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The backend's §2.1 added two optional fields to
 * `POST /api/orders/:orderNumber/return-request`:
 *
 *   issue_type    not_recognised | print_quality | leaking | dried_out |
 *                 physical_damage | wrong_item | missing_parts | other
 *   printer_model free text
 *
 * …to an endpoint the frontend had NEVER CALLED. There was no return form
 * anywhere: `returns.html` is a static policy page, `order-detail-page.js` had no
 * return code, and a repo-wide grep for `return-request` returned nothing. The
 * new fields could not have collected a single row. So the form is the feature.
 *
 * WHY THE TWO QUESTIONS ARE NOT ONE FIELD
 * ---------------------------------------
 *   reason      the COMMERCIAL why — required; decides who pays return shipping.
 *   issue_type  the TECHNICAL why — optional, and the field that makes an issue
 *               RATE per (SKU × printer × supplier) computable. "Faulty" across
 *               two suppliers tells you nothing; "not_recognised, on Brother,
 *               from this supplier, six times" tells you what to stop buying.
 * The supplier is never asked of the customer — the server fills it from the
 * order line's own cost snapshot.
 *
 * THE LEGAL TRAP THIS FILE PINS (§3)
 * ----------------------------------
 * It is tempting to hide the form after 30 days. It would be wrong.
 * legal-config.js says so in as many words: "faulty / not-as-described returns
 * are NEVER time-barred by the 30-day window — that's a Consumer Guarantees Act
 * §43 right which a retailer cannot contract out of for consumer transactions."
 * A form that vanished on day 31 would be this site telling a customer they have
 * no rights they in fact have. The gate is on ORDER STATE, never on a date.
 *
 * Run: node --test tests/return-request-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(INK, 'js', rel), 'utf8');
const PAGE = JS('order-detail-page.js');
const API_SRC = JS('api.js');
const HTML = fs.readFileSync(path.join(INK, 'html', 'account', 'order-detail.html'), 'utf8');
const CSS = fs.readFileSync(path.join(INK, 'css', 'pages.css'), 'utf8');

/** Build API.createReturnRequest from the shipping source, with a scripted post(). */
function loadCreateReturnRequest(postImpl) {
    const start = API_SRC.indexOf('    async createReturnRequest(orderNumber, body) {');
    assert.notEqual(start, -1, 'createReturnRequest not found');
    const open = API_SRC.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < API_SRC.length; i++) {
        if (API_SRC[i] === '{') depth++;
        else if (API_SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = API_SRC.slice(open + 1, i);
    const self = { post: postImpl };
    const fn = new Function('encodeURIComponent', 'Array',
        `return async function (orderNumber, body) {${body}};`)(encodeURIComponent, Array);
    return fn.bind(self);
}

// ─────────────────────────────────────────────────────────────────────────
// §1  The payload — optional means OMITTED, not empty
// ─────────────────────────────────────────────────────────────────────────

test('§1 all three fields are sent when all three are given', async () => {
    const calls = [];
    const fn = loadCreateReturnRequest(async (url, payload) => { calls.push([url, payload]); return { ok: true }; });
    await fn('ORD-ABC-1', { reason: 'faulty', issue_type: 'not_recognised', printer_model: 'Brother MFC-J5740DW' });
    assert.equal(calls[0][0], '/api/orders/ORD-ABC-1/return-request');
    assert.deepEqual(calls[0][1], {
        reason: 'faulty', issue_type: 'not_recognised', printer_model: 'Brother MFC-J5740DW',
    });
});

test('§1 a blank optional is OMITTED, never sent as an empty string', async () => {
    // An empty string is a value. It would land in the taxonomy as a real,
    // meaningless category and quietly dilute every rate computed off it.
    const calls = [];
    const fn = loadCreateReturnRequest(async (url, payload) => { calls.push(payload); return { ok: true }; });
    await fn('ORD-1', { reason: 'faulty', issue_type: '', printer_model: '   ' });
    assert.deepEqual(calls[0], { reason: 'faulty' });
    assert.ok(!('issue_type' in calls[0]));
    assert.ok(!('printer_model' in calls[0]));
});

test('§1 whitespace around a real value is trimmed', async () => {
    const calls = [];
    const fn = loadCreateReturnRequest(async (url, payload) => { calls.push(payload); return { ok: true }; });
    await fn('ORD-1', { reason: 'faulty', printer_model: '  Brother MFC-J5740DW  ' });
    assert.equal(calls[0].printer_model, 'Brother MFC-J5740DW');
});

test('§1 the order number is URL-encoded', async () => {
    const calls = [];
    const fn = loadCreateReturnRequest(async (url) => { calls.push(url); return { ok: true }; });
    await fn('ORD/WEIRD 1', { reason: 'faulty' });
    assert.equal(calls[0], '/api/orders/ORD%2FWEIRD%201/return-request');
});

// ─────────────────────────────────────────────────────────────────────────
// §2  The taxonomy is exactly the contract
// ─────────────────────────────────────────────────────────────────────────

test('§2 ISSUE_TYPES matches the backend enum, in full and with nothing extra', () => {
    const m = PAGE.match(/ISSUE_TYPES: \[([\s\S]*?)\n        \]/);
    assert.ok(m, 'ISSUE_TYPES not found');
    const values = [...m[1].matchAll(/\['([a-z_]+)',/g)].map((x) => x[1]);
    assert.deepEqual(values, [
        'not_recognised', 'print_quality', 'leaking', 'dried_out',
        'physical_damage', 'wrong_item', 'missing_parts', 'other',
    ]);
});

test('§2 issue_type is optional in the UI — "Prefer not to say" is a real choice', () => {
    assert.ok(/opts\(this\.ISSUE_TYPES, 'Prefer not to say'\)/.test(PAGE));
});

/** Strip comments so a scan cannot match the prose documenting the rule. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('§2 the customer is never asked for the supplier', () => {
    // The server fills it from the order line's own cost snapshot. Asking would
    // be both useless and a disclosure of who we buy from.
    const render = stripComments(
        PAGE.slice(PAGE.indexOf('renderReturnRequest('), PAGE.indexOf('humaniseSlug(')));
    assert.ok(!/supplier/i.test(render));
});

// ─────────────────────────────────────────────────────────────────────────
// §3  The gate is order state, NEVER a date
// ─────────────────────────────────────────────────────────────────────────

test('§3 only a paid-or-later order can be returned', () => {
    const m = PAGE.match(/RETURNABLE_STATUSES: \[([^\]]+)\]/);
    assert.ok(m);
    const vals = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    assert.deepEqual(vals, ['paid', 'processing', 'shipped', 'completed', 'delivered']);
    assert.ok(!vals.includes('pending'), 'nothing was paid for');
    assert.ok(!vals.includes('cancelled'), 'there is nothing to send back');
});

test('§3 there is NO date cut-off anywhere in the return code', () => {
    const start = PAGE.indexOf('RETURNABLE_STATUSES:');
    const end = PAGE.indexOf('getStatusClass(status) {');
    const block = PAGE.slice(start, end);
    assert.ok(!/returnWindow|30\s*\*\s*24|daysSince|Date\.now\(\)\s*-/.test(block),
        'faulty / not-as-described returns are never time-barred (CGA §43) — a form that ' +
        'vanished on day 31 would tell a customer they have no rights they in fact have');
});

test('§3 the copy says the CGA position rather than restating a window', () => {
    assert.ok(/Consumer Guarantees Act/.test(PAGE));
    assert.ok(/href="\/returns"/.test(PAGE), 'the policy stays the single source of the detail');
});

// ─────────────────────────────────────────────────────────────────────────
// §4  Failure states the customer can act on
// ─────────────────────────────────────────────────────────────────────────

test('§4 the rate limiter is handled with its own advice, not "try again"', () => {
    // Measured live: this route answers 429 RATE_LIMITED "Too many return
    // requests. Please contact support directly." after very few attempts. "Try
    // again" is advice that cannot work.
    const idx = PAGE.indexOf("code === 'RATE_LIMITED'");
    assert.notEqual(idx, -1, 'a 429 must not fall through to generic copy');
    const branch = PAGE.slice(idx, idx + 420);
    assert.ok(/support@inkcartridges\.co\.nz/.test(branch));
    assert.ok(!/try again/i.test(branch));
});

test('§4 a validation failure shows the SERVER\'s own message', () => {
    // Only `faulty` is confirmed against the live contract; the endpoint could
    // not be probed for the rest of the `reason` enum because it is rate-limited
    // by design. So a rejected value must name itself rather than hide behind
    // house copy — that is the only clue to what the server would accept.
    assert.ok(/API\.extractErrorMessage\(res, ''\)/.test(PAGE));
    assert.ok(/We couldn’t send that request: \$\{detail\}/.test(PAGE));
});

test('§4 the submit button cannot be double-fired into the limiter', () => {
    assert.ok(/if \(!btn \|\| btn\.disabled\) return;/.test(PAGE));
    assert.ok(/btn\.disabled = true;/.test(PAGE));
});

test('§4 a missing reason is caught before the network', () => {
    const idx = PAGE.indexOf('if (!reason) {');
    assert.notEqual(idx, -1);
    assert.ok(PAGE.indexOf('await API.createReturnRequest') > idx);
});

test('§4 success replaces the form — it cannot be submitted twice', () => {
    const idx = PAGE.indexOf('if (res && res.ok) {');
    assert.notEqual(idx, -1);
    const branch = PAGE.slice(idx, idx + 700);
    assert.ok(/host\.innerHTML = `/.test(branch));
    assert.ok(/Return requested/.test(branch));
});

// ─────────────────────────────────────────────────────────────────────────
// §5  Escaping, prefill, markup
// ─────────────────────────────────────────────────────────────────────────

test('§5 every interpolated value is escaped', () => {
    const start = PAGE.indexOf('host.innerHTML = `');
    const end = PAGE.indexOf('const form = document.getElementById(\'order-return-form\')');
    const tpl = PAGE.slice(start, end);
    const interps = [...tpl.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    interps.forEach((expr) => {
        assert.ok(/^(esc|escA|opts)\(/.test(expr),
            `unescaped interpolation in the return form: \${${expr}}`);
    });
});

test('§5 the printer prefill only fires when the order names ONE printer', () => {
    const idx = PAGE.indexOf('const prefill =');
    const line = PAGE.slice(idx, idx + 120);
    assert.ok(/slugs\.length === 1/.test(line),
        'two printers on one order is not an answer; the box is left blank for the customer');
});

test('§5 the de-slugged printer name reads like a real model', () => {
    const start = PAGE.indexOf('        humaniseSlug(slug) {');
    assert.notEqual(start, -1);
    const open = PAGE.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < PAGE.length; i++) {
        if (PAGE[i] === '{') depth++;
        else if (PAGE[i] === '}') { depth--; if (depth === 0) break; }
    }
    const fn = new Function('String', `return function (slug) {${PAGE.slice(open + 1, i)}};`)(String);
    // A model number goes fully upper; a vowel-less short token is an acronym;
    // anything else is a word. Length alone printed "J5740dw" and "PRO".
    assert.equal(fn('brother-mfc-j5740dw'), 'Brother MFC J5740DW');
    assert.equal(fn('hp-officejet-pro-9720'), 'HP Officejet Pro 9720');
    assert.equal(fn('canon-ts3160'), 'Canon TS3160');
    assert.equal(fn('epson-workforce-wf-2830'), 'Epson Workforce WF 2830');
    assert.equal(fn(''), '');
    assert.equal(fn(null), '');
});

test('§5 the de-slugged name is presentation only — a slug is never SENT', () => {
    // humaniseSlug produces "Brother MFC J5740DW" for a free-text box the
    // customer can correct. printer_model is their words, not our identifier.
    assert.ok(/humaniseSlug\(slugs\[0\]\)/.test(PAGE));
    const submit = PAGE.slice(PAGE.indexOf('async submitReturnRequest('));
    assert.ok(!/printer_slug/.test(submit));
});

test('§5 the host section exists in the markup and starts hidden', () => {
    assert.ok(/<section class="order-return" id="order-return" hidden>/.test(HTML));
});

test('§5 the section is hidden — not disabled — for a non-returnable order', () => {
    // A visible-but-dead form reads as "we won't let you".
    const idx = PAGE.indexOf('if (this.RETURNABLE_STATUSES.indexOf(status) === -1)');
    assert.notEqual(idx, -1);
    assert.ok(/host\.hidden = true;/.test(PAGE.slice(idx, idx + 160)));
});

test('§5 every class the form emits is styled, with defined variables only', () => {
    ['order-return', 'order-return__intro', 'order-return__field', 'order-return__hint',
     'order-return__error', 'order-return__done',
    ].forEach((c) => assert.ok(CSS.includes('.' + c), `${c} is emitted but never styled`));

    const block = CSS.slice(CSS.indexOf('.order-return {'));
    const vars = [...new Set((block.match(/var\(--[a-z-]+/g) || []).map((v) => v.slice(4)))];
    const ALL = ['base.css', 'pages.css'].map((f) =>
        fs.readFileSync(path.join(INK, 'css', f), 'utf8')).join('\n');
    vars.forEach((v) => assert.ok(new RegExp(`${v}\\s*:`).test(ALL), `${v} is used but never defined`));
});
