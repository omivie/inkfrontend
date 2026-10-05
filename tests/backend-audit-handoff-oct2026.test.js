'use strict';

/**
 * Backend audit FE handoff, Oct 2026 (ERR-300)
 * =============================================================================
 * Source: backend-docs/inbox/backend-audit-fe-handoff-oct2026.md (backend
 * 390ae16, live 2026-09-30). Every claim was MEASURED against prod before
 * acting (2026-10-02); what the measurement found is what these tests pin:
 *
 *   §1   guest-prefill now returns only { has_previous_order, customer_status?,
 *        welcome_message? } — it was an unauthenticated home-address lookup.
 *        Checkout must never read or fill a field from it again.
 *   §2   the visible PDP FAQ read `seo.jsonLd.faq_schema`, a key ABSENT on prod
 *        ⇒ the accordion was hidden on every PDP. It must read `faqJsonLd`.
 *   §3   `/account?subscription=created|exists|unavailable|error` had NO
 *        handler, and the login bounce dropped the param.
 *   §4   the ?rated=N thank-you was inside the reviews try ⇒ a failed reviews
 *        fetch swallowed it.
 *   §5   same-day dispatch is an Auckland-metro promise; no customer-facing copy
 *        may make it unqualified. "Guaranteed to work" is a banned claim.
 *   §6   og:image / twitter:image / Organization logo pointed at www files that
 *        never existed (404). They now point at the API's assets.
 *
 * Behavioural where the logic branches (§1, §3): the real method source is
 * pulled out of the file and run against stubs, so a test cannot pass on a
 * comment or a dead string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const OG_DEFAULT = 'https://api.inkcartridges.co.nz/og-default.png';
const API_LOGO = 'https://api.inkcartridges.co.nz/api/images/optimize?url=site/IC_2.png&format=png&w=512';

/**
 * Return the source of an object-literal method (`name(args) { ... }`),
 * brace-matched with string/template literals skipped.
 */
function extractMethod(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `method "${signature}" not found`);
    let i = src.indexOf('{', start + signature.length - 1);
    let depth = 0;
    let quote = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${signature}`);
}

/** Every customer-facing HTML page (admin excluded). */
function customerHtml() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'admin' || e.name === 'node_modules') continue;
                walk(p);
            } else if (e.name.endsWith('.html')) {
                out.push(p);
            }
        }
    };
    walk(INK);
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 Guest prefill: greeting only, never a form fill
// ─────────────────────────────────────────────────────────────────────────────

const CHECKOUT = stripComments(read('js/checkout-page.js'));
const PREFILL_SRC = extractMethod(CHECKOUT, 'async tryGuestPrefill(email) {');
// ERR-307 (item 15): the same answer is the backend's verdict on the address.
const VERDICT_SRC = extractMethod(CHECKOUT, 'emailVerdictFrom(res) {');

function runPrefill(response, { authed = false } = {}) {
    const calls = { api: 0, banner: [], filled: 0 };
    calls.verdicts = [];
    const self = {
        _renderReturningGuestBanner(msg) { calls.banner.push(msg); },
        fillAddressFields() { calls.filled++; },
        _recordEmailVerdict(key, v) { calls.verdicts.push([key, v.state]); },
    };
    const sandbox = {
        API: { guestPrefill: async () => { calls.api++; return response; } },
        Auth: { isAuthenticated: () => authed },
        DebugLog: { log() {} },
        // An empty address form, so the pre-ERR-300 "don't overwrite typing"
        // guard can't short-circuit: red-proof runs against HEAD fail on the
        // FILL, not on a missing global.
        document: { getElementById: () => ({ value: '' }) },
        self,
    };
    vm.createContext(sandbox);
    vm.runInContext(`self.tryGuestPrefill = ${PREFILL_SRC.replace(/^async tryGuestPrefill/, 'async function')}`, sandbox);
    vm.runInContext(`self.emailVerdictFrom = ${VERDICT_SRC.replace(/^emailVerdictFrom/, 'function')}`, sandbox);
    return { self, calls };
}

test('§1 the old PII response shape fills NOTHING (even if a backend regressed and sent it)', async () => {
    const legacy = { ok: true, data: {
        has_previous_order: true, welcome_message: 'Welcome back!',
        first_name: 'A', last_name: 'B', address_line1: '1 Secret St', city: 'Auckland',
        name: 'A B', phone: '021', shipping_address: { address_line1: '1 Secret St' },
    } };
    const { self, calls } = runPrefill(legacy);
    await self.tryGuestPrefill('a@example.com');
    assert.equal(calls.filled, 0, 'no form field may be filled from an unauthenticated lookup');
    assert.deepEqual(calls.banner, ['Welcome back!']);
});

test('§1 the measured new shape greets a returning guest; a new guest gets nothing', async () => {
    const returning = runPrefill({ ok: true, data: { has_previous_order: true, customer_status: 'returning', welcome_message: 'Welcome back!' } });
    await returning.self.tryGuestPrefill('a@example.com');
    assert.deepEqual(returning.calls.banner, ['Welcome back!']);

    const fresh = runPrefill({ ok: true, data: { has_previous_order: false } });
    await fresh.self.tryGuestPrefill('b@example.com');
    assert.deepEqual(fresh.calls.banner, []);
});

test('§1 each address is asked once; signed-in shoppers and non-emails are never sent', async () => {
    const r = runPrefill({ ok: true, data: { has_previous_order: false } });
    await r.self.tryGuestPrefill('a@example.com');
    await r.self.tryGuestPrefill('A@Example.com');
    assert.equal(r.calls.api, 1, 'a repeat blur must not re-POST the same address');
    await r.self.tryGuestPrefill('not-an-email');
    assert.equal(r.calls.api, 1);

    const authed = runPrefill({ ok: true, data: {} }, { authed: true });
    await authed.self.tryGuestPrefill('a@example.com');
    assert.equal(authed.calls.api, 0);
});

test('§1 a rejected request is silent (checkout continues)', async () => {
    const sandboxed = runPrefill(null);
    await sandboxed.self.tryGuestPrefill('a@example.com');
    assert.deepEqual(sandboxed.calls.banner, []);
});

test('§1 the blur listener only sends a VALID email (the prod VALIDATION_FAILED 400s)', () => {
    assert.match(CHECKOUT, /addEventListener\('blur',[\s\S]{0,200}emailField\.validity\.valid[\s\S]{0,120}tryGuestPrefill/);
});

test('§1 the JSDoc no longer promises address fields', () => {
    const api = read('js/api.js');
    const doc = api.slice(api.lastIndexOf('/**', api.indexOf('async guestPrefill(')), api.indexOf('async guestPrefill('));
    assert.ok(!/address_line1|first_name/.test(doc), 'guestPrefill JSDoc must not describe PII fields');
    assert.match(doc, /has_previous_order/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 PDP FAQ renders from faqJsonLd
// ─────────────────────────────────────────────────────────────────────────────

const PDP = stripComments(read('js/product-detail-page.js'));

test('§2 the visible FAQ reads faqJsonLd first, old key second', () => {
    const iNew = PDP.indexOf('info.faqJsonLd');
    const iOld = PDP.indexOf('faq_schema');
    assert.ok(iNew !== -1, 'must read info.faqJsonLd (the key /api/products/:sku actually sends)');
    assert.ok(iOld === -1 || iNew < iOld, 'faqJsonLd must win over the legacy seo.jsonLd.faq_schema');
    assert.match(PDP, /Array\.isArray\(faq\.mainEntity\)[\s\S]{0,80}this\._faqSchema = faq/);
});

test('§2 the accordion renders backend text escaped, never copy of ours', () => {
    const fn = extractMethod(PDP, 'renderFaqAccordion() {');
    assert.match(fn, /escapeHtml\(q\.name\)/);
    assert.match(fn, /escapeHtml\(q\.acceptedAnswer\?\.text/);
    assert.ok(!/business days|warranty|returned within/i.test(fn), 'no hard-coded answer copy');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 /account?subscription=<outcome>
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT = stripComments(read('js/account.js'));

function loadAccount(search) {
    const toasts = [];
    const replaced = [];
    const href = `https://www.inkcartridges.co.nz/account${search}`;
    const sandbox = {
        URL, URLSearchParams,
        window: {
            location: { search, href, pathname: '/account', hash: '' },
            history: { replaceState: (_s, _t, u) => replaced.push(u) },
        },
        showToast: (msg, type, ms) => toasts.push({ msg, type, ms }),
        page: null,
    };
    vm.createContext(sandbox);
    const src = [
        'page = {',
        `SUBSCRIPTION_OUTCOMES: ${ACCOUNT.match(/SUBSCRIPTION_OUTCOMES:\s*(\{[\s\S]*?\n\s*\}),/)[1]},`,
        extractMethod(ACCOUNT, 'subscriptionOutcome() {') + ',',
        extractMethod(ACCOUNT, 'handleSubscriptionParam() {') + ',',
        'showToast() {},',
        '};',
    ].join('\n');
    vm.runInContext(src, sandbox);
    return { page: sandbox.page, toasts, replaced };
}

test('§3 all four backend outcomes are told to the shopper, then stripped', () => {
    for (const outcome of ['created', 'exists', 'unavailable', 'error']) {
        const { page, toasts, replaced } = loadAccount(`?subscription=${outcome}&x=1`);
        page.handleSubscriptionParam();
        assert.equal(toasts.length, 1, `${outcome} must toast`);
        assert.ok(toasts[0].msg.length > 10);
        assert.equal(toasts[0].type, outcome === 'error' ? 'error' : outcome === 'unavailable' ? 'warning' : 'success');
        assert.deepEqual(replaced, ['/account?x=1'], 'only the subscription param is dropped');
    }
});

test('§3 an unknown or hostile value is ignored, never reflected', () => {
    for (const v of ['', 'CREATED', '<img src=x onerror=1>', 'constructor', '__proto__', 'toString']) {
        const { page, toasts, replaced } = loadAccount(`?subscription=${encodeURIComponent(v)}`);
        assert.equal(page.subscriptionOutcome(), null, `"${v}" must not be an outcome`);
        page.handleSubscriptionParam();
        assert.equal(toasts.length, 0);
        assert.equal(replaced.length, 0);
    }
});

test('§3 the login bounce carries ONLY the allowlisted outcome', () => {
    const init = extractMethod(ACCOUNT, 'async init() {');
    assert.match(init, /const outcome = this\.subscriptionOutcome\(\);/);
    assert.match(init, /\?subscription=\$\{outcome\}/);
    assert.match(init, /encodeURIComponent\(back\)/);
    assert.ok(!/window\.location\.search\)?\s*\+?\s*\)?\s*\+\s*tab/.test(init), 'the raw query must not be forwarded');
    assert.match(init, /this\.handleSubscriptionParam\(\)/, 'signed-in path must handle the param');
});

test('§3 Security.safeRedirect accepts the carried path (so login lands back on it)', () => {
    const sec = read('js/security.js');
    const fn = extractMethod(stripComments(sec), 'safeRedirect(url, fallback = \'/account\') {');
    const sandbox = { out: null };
    vm.createContext(sandbox);
    vm.runInContext(`const f = function ${fn.replace(/^safeRedirect/, '')}; out = f('/account?subscription=created');`, sandbox);
    assert.equal(sandbox.out, '/account?subscription=created');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 ?rated=N survives a failed reviews fetch
// ─────────────────────────────────────────────────────────────────────────────

test('§4 handleRatedParam is called AFTER the reviews try/catch, not inside it', () => {
    const fn = extractMethod(PDP, 'async loadReviews(');
    const iCatch = fn.lastIndexOf('catch (e)');
    const iCall = fn.indexOf('this.handleRatedParam(');
    assert.ok(iCatch !== -1 && iCall !== -1);
    assert.ok(iCall > iCatch, 'the thank-you must run even when the reviews fetch throws');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 Same-day dispatch is Auckland metro only; no "guaranteed to work"
// ─────────────────────────────────────────────────────────────────────────────

test('§5 no customer-facing page states same-day dispatch without Auckland metro', () => {
    const offenders = [];
    for (const file of customerHtml()) {
        const text = fs.readFileSync(file, 'utf8')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');
        const re = /same[- ]day dispatch|dispatch(?:ed)? (?:the )?same[- ]day/gi;
        let m;
        while ((m = re.exec(text))) {
            const around = text.slice(Math.max(0, m.index - 160), m.index + 120);
            if (!/Auckland metro/i.test(around)) offenders.push(`${path.relative(ROOT, file)}: …${around.trim()}…`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('§5 the SEO fallback titles carry no unqualified same-day promise', () => {
    const seo = stripComments(read('js/seo-meta.js'));
    assert.ok(!/Same-Day Dispatch/.test(seo), 'titles must use the backend\'s "Fast NZ Delivery"');
    assert.match(seo, /Auckland metro: same-day dispatch by \$\{trust\.cutoff\} NZT\./);
});

test('§5 "guaranteed to work" appears nowhere customer-facing', () => {
    for (const file of customerHtml()) {
        assert.ok(!/guaranteed to work/i.test(fs.readFileSync(file, 'utf8')), path.relative(ROOT, file));
    }
    for (const f of fs.readdirSync(path.join(INK, 'js')).filter(n => n.endsWith('.js'))) {
        assert.ok(!/guaranteed to work/i.test(stripComments(read(`js/${f}`))), f);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 Share image + Organization logo resolve
// ─────────────────────────────────────────────────────────────────────────────

test('§6 no reference to the two www image paths that 404', () => {
    const bad = /assets\/images\/logo\.png|inkcartridges\.co\.nz\/logo\.png|SITE \+ '\/logo\.png'/;
    const hits = [];
    for (const file of customerHtml()) if (bad.test(fs.readFileSync(file, 'utf8'))) hits.push(path.relative(ROOT, file));
    for (const f of fs.readdirSync(path.join(INK, 'js')).filter(n => n.endsWith('.js'))) {
        if (bad.test(stripComments(read(`js/${f}`)))) hits.push(`js/${f}`);
    }
    assert.deepEqual(hits, []);
});

test('§6 every og:image / twitter:image uses the API default share card', () => {
    let count = 0;
    for (const file of customerHtml()) {
        const html = fs.readFileSync(file, 'utf8');
        for (const m of html.matchAll(/<meta (?:property="og:image"|name="twitter:image")[^>]*content="([^"]*)"/g)) {
            assert.equal(m[1], OG_DEFAULT, path.relative(ROOT, file));
            count++;
        }
    }
    assert.ok(count >= 40, `expected >= 40 share-image tags, found ${count}`);
    assert.match(PDP, new RegExp(`info\\.image_url \\|\\| '${OG_DEFAULT.replace(/[.?/]/g, '\\$&')}'`));
});

test('§6 the Organization logo matches what /api/schema/site emits', () => {
    for (const rel of ['index.html', 'html/index.html']) {
        assert.ok(read(rel).includes(`"logo": "${API_LOGO}"`), rel);
    }
    assert.ok(stripComments(read('js/footer.js')).includes(`logo: '${API_LOGO}'`));
});
