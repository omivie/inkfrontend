/**
 * Quick-order OUTCOME — the quotes we lost (Aug 2026)
 * ===================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A quote that never became an invoice left no trace of WHY. `status`
 * (open|invoiced|cancelled) says what happened to the record; `outcome` says what
 * happened to the deal, and only the second can tell you that you lose on price
 * and not on delivery time. The backend added
 * `PATCH /api/admin/quick-orders/:id/outcome` for it.
 *
 * THE THING THIS FILE MOSTLY GUARDS: THE ENDPOINT IS UNREACHABLE
 * -------------------------------------------------------------
 * Measured against production 2026-08-31 with a live super_admin token:
 *
 *   PATCH /:id/outcome  {"outcome":"bogus"}      → 400 "outcome" must be one of
 *                                                  [won, lost, pending, null]
 *   PATCH /:id/outcome  {"outcome":"won"}        → 404 Quick order not found
 *     …so the route is live, validating, and correct.
 *
 *   OPTIONS /:id/outcome (Access-Control-Request-Method: PATCH)
 *     → 204, Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
 *     …no PATCH. Chrome kills the request before it is sent. That is BF-021,
 *     open since 2026-07-30 — the same one-line backend change ERR-131 and
 *     ERR-188 waited on.
 *
 * AND THERE IS NO FALLBACK VERB. Every permitted alternative was probed:
 *   POST /:id/outcome            → 404 Endpoint not found
 *   PUT  /:id/outcome            → 404 Endpoint not found
 *   PUT  /:id {outcome}          → 400 "A status is required for a status-only update"
 *   PUT  /:id {status, outcome}  → reaches the row lookup — i.e. `outcome` is
 *                                  neither validated nor rejected, the ERR-151
 *                                  decoy signature. A write we cannot prove
 *                                  landed is worse than one that visibly did not.
 *   X-HTTP-Method-Override       → not on Access-Control-Allow-Headers.
 *
 * So the invoice pattern's PATCH→PUT fallback has nothing to fall back TO, and
 * inventing one would write "lost to a competitor at $38.90" into a void behind
 * a success toast. The page attempts PATCH — correct, and working the day
 * BF-021 lands — and reports a blocked transport BY NAME. §3 is the guard
 * against that becoming a reassuring lie for the fourth time.
 *
 * Run: node --test tests/admin-quick-order-outcome-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const ADMIN = (rel) => fs.readFileSync(path.join(INK, 'js', 'admin', rel), 'utf8');
const API_SRC = ADMIN('api.js');
const PAGE_SRC = ADMIN('pages/quick-order.js');
const CSS = fs.readFileSync(path.join(INK, 'css', 'admin.css'), 'utf8');

/**
 * Rebuild AdminAPI.setQuickOrderOutcome from the shipping source, with a
 * scripted window.API. Executing the real function beats asserting on its text:
 * a copy would rot the first time the validation changed.
 */
function loadSetOutcome({ patchImpl }) {
    const start = API_SRC.indexOf('  async setQuickOrderOutcome(quickOrderId, patch) {');
    assert.notEqual(start, -1, 'setQuickOrderOutcome not found');
    const open = API_SRC.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < API_SRC.length; i++) {
        if (API_SRC[i] === '{') depth++;
        else if (API_SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = API_SRC.slice(open + 1, i);

    const self = {
        QUICK_ORDER_OUTCOMES: Object.freeze(['won', 'lost', 'pending']),
        QUICK_ORDER_REASONS_LOST: Object.freeze([
            'price', 'availability', 'delivery_time', 'competitor',
            'no_response', 'changed_requirements', 'other',
        ]),
    };
    const invoiceError = (resp, fallback) => {
        const e = new Error(resp?.error?.message || fallback);
        e.code = resp?.error?.code || null;
        e.details = resp?.error?.details || null;
        return e;
    };
    const window = { API: { patch: patchImpl } };
    const fn = new Function('window', 'invoiceError', 'encodeURIComponent',
        `return async function (quickOrderId, patch) {${body}};`)(window, invoiceError, encodeURIComponent);
    return fn.bind(self);
}

// ─────────────────────────────────────────────────────────────────────────
// §1  The enums live in one place, and match the contract exactly
// ─────────────────────────────────────────────────────────────────────────

test('§1 the outcome enum is exactly the contract', () => {
    const m = API_SRC.match(/QUICK_ORDER_OUTCOMES: Object\.freeze\(\[([^\]]+)\]\)/);
    assert.ok(m);
    const vals = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    assert.deepEqual(vals, ['won', 'lost', 'pending']);
});

test('§1 the reason_lost enum is exactly the contract', () => {
    const m = API_SRC.match(/QUICK_ORDER_REASONS_LOST: Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(m);
    const vals = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    assert.deepEqual(vals, ['price', 'availability', 'delivery_time', 'competitor',
        'no_response', 'changed_requirements', 'other']);
});

test('§1 the page never re-spells an enum value inline', () => {
    // ERR-075 / ERR-162: a bogus value returns zero rows in silence. The
    // dropdowns map over AdminAPI's lists, so an option that the API layer would
    // reject cannot be rendered.
    assert.ok(PAGE_SRC.includes('AdminAPI.QUICK_ORDER_OUTCOMES.map('));
    assert.ok(PAGE_SRC.includes('AdminAPI.QUICK_ORDER_REASONS_LOST.map('));
});

// ─────────────────────────────────────────────────────────────────────────
// §2  Client-side validation — catch it here, not as an opaque 400
// ─────────────────────────────────────────────────────────────────────────

test('§2 a valid patch reaches the PATCH route with the right URL and body', async () => {
    const calls = [];
    const fn = loadSetOutcome({ patchImpl: async (url, body) => { calls.push([url, body]); return { ok: true, data: { quick_order: { id: 'x' } } }; } });
    const out = await fn('abc-123', { outcome: 'lost', reason_lost: 'competitor', competitor_price: 38.9 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/admin/quick-orders/abc-123/outcome');
    assert.deepEqual(calls[0][1], { outcome: 'lost', reason_lost: 'competitor', competitor_price: 38.9 });
    assert.deepEqual(out, { id: 'x' });
});

test('§2 a bogus outcome is refused before the network', async () => {
    let called = false;
    const fn = loadSetOutcome({ patchImpl: async () => { called = true; return { ok: true }; } });
    await assert.rejects(() => fn('abc', { outcome: 'bogus' }), /Unsupported outcome/);
    assert.equal(called, false);
});

test('§2 reason_lost without outcome:lost is refused — the server 400s on it', async () => {
    let called = false;
    const fn = loadSetOutcome({ patchImpl: async () => { called = true; return { ok: true }; } });
    await assert.rejects(() => fn('abc', { outcome: 'won', reason_lost: 'price' }),
        /only valid when the outcome is "lost"/);
    assert.equal(called, false);
});

test('§2 an explicit null CLEARS a field and is not mistaken for absence', async () => {
    const calls = [];
    const fn = loadSetOutcome({ patchImpl: async (url, body) => { calls.push(body); return { ok: true, data: {} }; } });
    await fn('abc', { outcome: null, reason_lost: null, discount_offered: null });
    assert.deepEqual(calls[0], { outcome: null, reason_lost: null, discount_offered: null });
});

// ─────────────────────────────────────────────────────────────────────────
// §3  BF-021 — the blocked path is loud, specific, and not a lie
// ─────────────────────────────────────────────────────────────────────────

test('§3 a thrown transport failure is tagged, not swallowed', async () => {
    const fn = loadSetOutcome({ patchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(() => fn('abc', { outcome: 'won' }), (err) => {
        assert.equal(err.transportBlocked, true);
        return true;
    });
});

test('§3 a CODED rejection is rethrown untouched — never retried elsewhere', async () => {
    // The server already answered. Re-asking through another route is trying to
    // talk it out of that answer.
    const fn = loadSetOutcome({
        patchImpl: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'Quick order not found' } }),
    });
    await assert.rejects(() => fn('abc', { outcome: 'won' }), (err) => {
        assert.equal(err.code, 'NOT_FOUND');
        assert.notEqual(err.transportBlocked, true);
        return true;
    });
});

test('§3 nothing falls back to PUT — the fallback would write into a void', () => {
    const start = API_SRC.indexOf('async setQuickOrderOutcome(');
    const end = API_SRC.indexOf('async deleteQuickOrder(');
    const fn = API_SRC.slice(start, end);
    assert.ok(!/window\.API\.put|updateQuickOrder\(/.test(fn),
        'PUT /:id is a status-only route; it neither validates nor stores `outcome`');
});

/**
 * Strip // and block comments so a source scan cannot match the very prose that
 * documents the rule it is checking — the banned sentence is quoted verbatim in
 * the comment above the branch, on purpose.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('§3 the blocked message names BF-021 and never says "not available yet"', () => {
    const idx = PAGE_SRC.indexOf('err.transportBlocked');
    assert.notEqual(idx, -1);
    const branch = stripComments(PAGE_SRC.slice(idx, idx + 1600));
    assert.ok(/BF-021/.test(branch), 'name the blocker so it can be found and fixed');
    assert.ok(/Nothing was changed/i.test(branch), 'the operator must know their number was not stored');
    // ERR-131's real damage was not the wrong URL — it was the toast reading
    // "isn't available yet (backend endpoint pending)" over a route that was
    // answering 401 the whole time, which made a broken feature look like an
    // unbuilt one and stopped anyone looking for a month.
    assert.ok(!/not available yet|endpoint pending|coming soon|not built/i.test(branch),
        'a blocked feature must never be described as an unbuilt one');
});

test('§3 the operator is told once per session, not once per click', () => {
    assert.ok(/_outcomeBlockNoted/.test(PAGE_SRC), 'a nag gets trained away');
});

// ─────────────────────────────────────────────────────────────────────────
// §4  The UI — absence, ambiguity and money
// ─────────────────────────────────────────────────────────────────────────

test('§4 an unset outcome renders as — and never as "Pending"', () => {
    // "Nobody has decided yet" and "we decided it is still open" are different
    // facts; collapsing them makes the lost-quote report quietly optimistic.
    const idx = PAGE_SRC.indexOf('function outcomeCell(');
    assert.notEqual(idx, -1);
    const fn = PAGE_SRC.slice(idx, idx + 700);
    assert.ok(/if \(!o \|\| !OUTCOME_LABELS\[o\]\) return `<span class="cell-muted">\$\{MISSING\}/.test(fn));
});

test('§4 an empty money box means UNKNOWN, never 0', () => {
    const idx = PAGE_SRC.indexOf('const moneyOrNull =');
    assert.notEqual(idx, -1);
    const fn = PAGE_SRC.slice(idx, idx + 320);
    assert.ok(/if \(!raw\) return null;/.test(fn),
        'a competitor price of $0.00 is a claim we would be inventing (ERR-068)');
});

test('§4 reason_lost is hidden AND cleared when the outcome is not lost', () => {
    const idx = PAGE_SRC.indexOf('const syncReason =');
    const fn = PAGE_SRC.slice(idx, idx + 300);
    assert.ok(/reasonWrap\.hidden = !isLost;/.test(fn));
    assert.ok(/if \(!isLost\) reasonEl\.value = '';/.test(fn),
        'a stale selection left in a hidden field would be posted into a 400');
});

test('§4 outcome never touches buildPayload — it must not disturb status', () => {
    const start = PAGE_SRC.indexOf('function buildPayload(');
    assert.notEqual(start, -1);
    const end = PAGE_SRC.indexOf('\n}', start);
    const fn = PAGE_SRC.slice(start, end);
    assert.ok(!/outcome|reason_lost|competitor_price|discount_offered/.test(fn),
        'buildPayload is the PUT body carrying `status`, which drives set_quick_order_status() ' +
        'and the invoice bridge');
});

test('§4 the badge classes exist in the stylesheet', () => {
    ['admin-badge--completed', 'admin-badge--cancelled', 'admin-badge--pending'].forEach((c) => {
        assert.ok(CSS.includes('.' + c), `${c} is not defined — the badge would render unstyled`);
    });
});

test('§4 the modal styles use defined variables only', () => {
    const block = CSS.slice(CSS.indexOf('.qo-outcome__hint'));
    const vars = [...new Set((block.match(/var\(--[a-z-]+/g) || []).map((v) => v.slice(4)))];
    vars.forEach((v) => {
        assert.ok(new RegExp(`${v}\\s*:`).test(CSS), `${v} is used but never defined`);
    });
});
