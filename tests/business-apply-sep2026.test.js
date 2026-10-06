/**
 * /business APPLY — ERR-297 (2026-09-29)
 * ======================================
 *
 * /business used to be a locked door for everyone who was not already an
 * approved account: one paragraph and a /quote button. The reason on file was
 * "no application endpoint exists" (legal-pages §7, business-centre §1). That
 * was a GET-vs-POST mistake: the endpoint is POST-only, so our GET read a 404 as
 * absence. The backend's 09-29 reply (§8), measured the same day:
 *   GET  /api/business/apply            404
 *   POST /api/business/apply (no token) 401
 *
 * What these tests pin, in order of how badly each would bite:
 *   1. `can_apply` ABSENT is UNKNOWN, never false. Reading it as false hides the
 *      form from every prospect with no symptom (absence-as-zero, ERR-063 family).
 *   2. rejected → /reapply, everyone else → /apply. The wrong endpoint 409s.
 *   3. A failed POST re-reads status rather than guessing: a 409 for "already
 *      pending" must show "we have your application", not "try again".
 *   4. A failed ladder read SAYS so; it never leaves the loading line up.
 *   5. The sign-up round-trip keeps ?redirect=, and safeRedirect judges the URL
 *      the BROWSER follows ("/\evil.com" → https://evil.com/ per WHATWG).
 *
 * Run: node --test tests/business-apply-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripComments } = require('./helpers/strip-comments');

const INK = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
const BUSINESS_JS = read('js/business.js');
const PAGE_JS = read('js/business-page.js');
const LOGIN_JS = read('js/login-page.js');
const SECURITY_JS = read('js/security.js');
const PAGE = read('html/business.html');

// ── A minimal DOM: just what the Apply panel touches ─────────────────────────
function el(extra = {}) {
    const attrs = {};
    return Object.assign({
        hidden: false, innerHTML: '', textContent: '', value: '', disabled: false,
        setAttribute(k, v) { attrs[k] = String(v); },
        removeAttribute(k) { delete attrs[k]; },
        getAttribute(k) { return k in attrs ? attrs[k] : null; },
        querySelectorAll() { return []; },
        insertAdjacentElement() {},
        insertAdjacentHTML(_where, html) { this.innerHTML += html; },
        addEventListener() {},
        focus() {},
        scrollIntoView() {},
        attrs,
    }, extra);
}

function makeForm(values = {}) {
    const fields = {};
    for (const n of ['company_name', 'contact_name', 'contact_email', 'nzbn', 'contact_phone',
        'estimated_monthly_spend', 'industry', 'business_type', 'ap_email', 'billing_address', 'shipping_address']) {
        fields[n] = el({ value: values[n] || '' });
    }
    const form = el({ hidden: true, elements: { namedItem: (n) => fields[n] || null } });
    return { form, fields };
}

function load({ statusReply, postReply, valueProps, user } = {}) {
    const ids = {};
    ['business-apply-state', 'business-apply-heading', 'business-apply-errors', 'business-apply-submit',
        'business-ladder', 'business-contact', 'apply', 'business-denied', 'business-unavailable',
        'business-loading', 'business-main'].forEach((id) => { ids[id] = el(); });
    const { form, fields } = makeForm();
    ids['business-apply-form'] = form;
    const warns = [];
    const posts = [];
    const statusReplies = Array.isArray(statusReply) ? statusReply.slice() : [statusReply];
    const ctx = {
        console,
        location: { hash: '' },
        document: {
            readyState: 'loading',
            addEventListener() {},
            getElementById: (id) => ids[id] || null,
            querySelectorAll: () => [],
            createElement: () => el(),
        },
        DebugLog: { warn: (...a) => warns.push(a.join(' ')), log() {} },
        Security: { escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) },
        LegalConfig: { phoneE164: '+64274740115', phoneDisplay: '027 474 0115', email: 'support@inkcartridges.co.nz', responseSLA: 'within one business day', hoursDisplay: 'Mon–Fri', invoice: { contactName: 'Trevor Walker' } },
        Auth: {
            initialized: true,
            isAuthenticated: () => !!user,
            getUser: () => user || null,
            user: user || null,
            onAuthStateChange() {},
        },
        API: {
            get: async (url) => {
                assert.equal(url, '/api/business/status');
                const r = statusReplies.length > 1 ? statusReplies.shift() : statusReplies[0];
                if (r instanceof Error) throw r;
                return r;
            },
            post: async (url, body) => { posts.push({ url, body }); return postReply || { ok: true, data: { id: 'x', status: 'pending' } }; },
        },
        ValueProps: {
            load: async () => valueProps || { ok: false },
            volume: (d) => (d && d.volume_pricing ? { tiers: d.volume_pricing.tiers, headline: 'Buy more, pay less', detail: null } : null),
        },
        ValuePages: {
            tiersTableHtml: (tiers) => (tiers && tiers.length ? '<table class="value-page__table"></table>' : ''),
            unavailable(box) { box.innerHTML = '<p class="value-page__error">We couldn\'t load the current details just now.</p>'; },
        },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(BUSINESS_JS, ctx, { filename: 'business.js' });
    vm.runInContext(PAGE_JS, ctx, { filename: 'business-page.js' });
    // The Business object reads the user id from Auth; give it a stable one.
    ctx.Business._userId = () => (user ? user.id : null);
    return { ctx, Business: ctx.Business, Page: ctx.BusinessPage, ids, form, fields, warns, posts };
}

const USER = { id: 'u1', email: 'sam@acme.co.nz', user_metadata: { full_name: 'Sam Lee' } };

// ── §1 applyState ────────────────────────────────────────────────────────────

test('§1 applyState carries status + can_apply; can_apply ABSENT is null, never false', async () => {
    const cases = [
        [{ status: 'personal', can_apply: true }, { status: 'personal', canApply: true }],
        [{ status: 'Rejected', can_apply: true }, { status: 'rejected', canApply: true }],
        [{ status: 'pending', can_apply: false }, { status: 'pending', canApply: false }],
        [{ status: 'personal' }, { status: 'personal', canApply: null }],
        [{ status: 'personal', can_apply: 'yes' }, { status: 'personal', canApply: null }],
    ];
    for (const [data, want] of cases) {
        const { Business } = load({ statusReply: { ok: true, data }, user: USER });
        await Business.getStatus();
        assert.deepEqual({ ...Business.applyState() }, want, JSON.stringify(data));
    }
});

test('§1 a "not a business account" code is personal/unknown; an OUTAGE leaves applyState null', async () => {
    const refused = load({ statusReply: { ok: false, code: 'B2B_REQUIRED' }, user: USER });
    await refused.Business.getStatus();
    assert.deepEqual({ ...refused.Business.applyState() }, { status: 'personal', canApply: null });
    assert.equal(refused.Business._statusDegraded, false);

    const down = load({ statusReply: { ok: false, code: 'SERVER_ERROR' }, user: USER });
    await down.Business.getStatus();
    assert.equal(down.Business.applyState(), null, 'a 5xx is not an answer about the application');
    assert.equal(down.Business._statusDegraded, true);

    const threw = load({ statusReply: new Error('network'), user: USER });
    await threw.Business.getStatus();
    assert.equal(threw.Business.applyState(), null);
});

test('§1 reset() forgets the application state (sign-out / account switch)', async () => {
    const { Business } = load({ statusReply: { ok: true, data: { status: 'pending', can_apply: false } }, user: USER });
    await Business.getStatus();
    assert.ok(Business.applyState());
    Business.reset();
    assert.equal(Business.applyState(), null);
});

test('§1 pricing is untouched: a pending application is still an INACTIVE account', async () => {
    const { Business } = load({ statusReply: { ok: true, data: { status: 'pending', can_apply: false } }, user: USER });
    const s = await Business.getStatus();
    assert.equal(s.active, false);
});

// ── §2 renderApply: one panel per state ─────────────────────────────────────

test('§2 each state renders the right panel and endpoint', () => {
    const run = (state) => {
        const t = load({ user: USER });
        t.Page.renderApply(state);
        return { html: t.ids['business-apply-state'].innerHTML, formShown: !t.form.hidden, endpoint: t.Page._applyEndpoint, heading: t.ids['business-apply-heading'].textContent, t };
    };

    const guest = run('guest');
    assert.equal(guest.formShown, false);
    assert.match(guest.html, /href="\/account\/login\?redirect=%2Fbusiness%23apply"/);
    assert.match(guest.html, /href="\/account\/login\?tab=register&amp;redirect=%2Fbusiness%23apply"/);

    const fresh = run({ status: 'personal', canApply: true });
    assert.equal(fresh.formShown, true);
    assert.equal(fresh.endpoint, '/api/business/apply');

    const again = run({ status: 'rejected', canApply: true });
    assert.equal(again.formShown, true);
    assert.equal(again.endpoint, '/api/business/reapply', 'a rejected applicant resubmits via /reapply');
    assert.equal(again.heading, 'Apply again');

    const pending = run({ status: 'pending', canApply: false });
    assert.equal(pending.formShown, false);
    assert.match(pending.html, /We have your application/);
    assert.match(pending.html, /within one business day/);

    for (const s of [{ status: 'suspended', canApply: false }, { status: 'closed', canApply: null }, { status: 'personal', canApply: false }]) {
        const r = run(s);
        assert.equal(r.formShown, false, JSON.stringify(s));
        assert.match(r.html, /027 474 0115/);
        assert.equal(r.endpoint, null);
    }

    const down = run('degraded');
    assert.equal(down.formShown, false);
    assert.match(down.html, /couldn't check/);
});

test('§2 can_apply UNKNOWN shows the form and warns — a missing field must not lock prospects out', () => {
    const t = load({ user: USER });
    t.Page.renderApply({ status: 'personal', canApply: null });
    assert.equal(t.form.hidden, false);
    assert.equal(t.Page._applyEndpoint, '/api/business/apply');
    assert.ok(t.warns.some((w) => /no can_apply/.test(w)), 'the unknown must be LOUD');
});

test('§2 the form is prefilled from the signed-in user, never over what they typed', () => {
    const t = load({ user: USER });
    t.fields.contact_name.value = 'Typed Name';
    t.Page.renderApply({ status: 'personal', canApply: true });
    assert.equal(t.fields.contact_email.value, 'sam@acme.co.nz');
    assert.equal(t.fields.contact_name.value, 'Typed Name');
});

// ── §3 the payload ──────────────────────────────────────────────────────────

test('§3 required fields are required; blank optionals are LEFT OUT; nzbn is 13 digits', () => {
    const t = load({ user: USER });
    Object.assign(t.fields.company_name, { value: '  Acme Ltd ' });
    Object.assign(t.fields.contact_name, { value: 'Sam Lee' });
    Object.assign(t.fields.contact_email, { value: 'sam@acme.co.nz' });
    Object.assign(t.fields.nzbn, { value: '9429 0000 00000' });
    Object.assign(t.fields.estimated_monthly_spend, { value: '500_1000' });
    let r = t.Page.readApplyForm(t.form);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual({ ...r.body }, { company_name: 'Acme Ltd', contact_name: 'Sam Lee', contact_email: 'sam@acme.co.nz', nzbn: '9429000000000', estimated_monthly_spend: '500_1000' });

    t.fields.nzbn.value = '12345';
    t.fields.company_name.value = '';
    t.fields.ap_email.value = 'not-an-email';
    t.fields.estimated_monthly_spend.value = 'loads';
    r = t.Page.readApplyForm(t.form);
    const names = r.errors.map((e) => e.name).sort();
    assert.deepEqual([...names], ['ap_email', 'company_name', 'estimated_monthly_spend', 'nzbn']);
});

test('§3 business.html offers exactly the five spend values the backend accepts', () => {
    const form = PAGE.slice(PAGE.indexOf('id="business-apply-form"'), PAGE.indexOf('</form>', PAGE.indexOf('id="business-apply-form"')));
    const vals = [...form.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    assert.deepEqual(vals, ['under_500', '500_1000', '1000_2500', '2500_5000', 'over_5000']);
});

// ── §4 submit outcomes ──────────────────────────────────────────────────────

function fillValid(t) {
    t.fields.company_name.value = 'Acme Ltd';
    t.fields.contact_name.value = 'Sam Lee';
    t.fields.contact_email.value = 'sam@acme.co.nz';
}

test('§4 success posts to the chosen endpoint, hides the form and says "pending"', async () => {
    const t = load({ user: USER, statusReply: { ok: true, data: { status: 'rejected', can_apply: true } } });
    t.Page.renderApply({ status: 'rejected', canApply: true });
    fillValid(t);
    await t.Page.submitApply(t.form);
    assert.equal(t.posts.length, 1);
    assert.equal(t.posts[0].url, '/api/business/reapply');
    assert.equal(t.form.hidden, true);
    assert.match(t.ids['business-apply-state'].innerHTML, /we have your application/i);
});

test('§4 an invalid form never reaches the network', async () => {
    const t = load({ user: USER });
    t.Page.renderApply({ status: 'personal', canApply: true });
    await t.Page.submitApply(t.form);
    assert.equal(t.posts.length, 0);
    assert.equal(t.ids['business-apply-errors'].hidden, false);
});

test('§4 a refused POST RE-READS status: "already pending" renders pending, not "try again"', async () => {
    const t = load({
        user: USER,
        postReply: { ok: false, code: 'APPLICATION_EXISTS', error: 'exists' },
        statusReply: { ok: true, data: { status: 'pending', can_apply: false } },
    });
    t.Page.renderApply({ status: 'personal', canApply: true });
    fillValid(t);
    await t.Page.submitApply(t.form);
    assert.equal(t.form.hidden, true);
    assert.match(t.ids['business-apply-state'].innerHTML, /We have your application/);
});

test('§4 409 APPLICATION_PENDING renders pending from the CODE — even when the status re-read would fail (BF-095)', async () => {
    const t = load({
        user: USER,
        postReply: { ok: false, code: 'APPLICATION_PENDING', error: 'An application is already pending' },
        statusReply: new Error('network down'),
    });
    t.Page.renderApply({ status: 'personal', canApply: true });
    fillValid(t);
    await t.Page.submitApply(t.form);
    assert.equal(t.form.hidden, true);
    assert.match(t.ids['business-apply-state'].innerHTML, /We have your application/);
    assert.doesNotMatch(t.ids['business-apply-state'].innerHTML, /couldn't send/);
});

test('§4 409 ALREADY_APPROVED hands over to gate() — the account view, not an error (BF-095)', async () => {
    const t = load({
        user: USER,
        postReply: { ok: false, code: 'ALREADY_APPROVED', error: 'Already approved' },
        statusReply: { ok: true, data: { status: 'personal', can_apply: true } },
    });
    let gated = 0;
    t.Page.gate = async () => { gated++; };
    t.Page.renderApply({ status: 'rejected', canApply: true });
    fillValid(t);
    await t.Page.submitApply(t.form);
    assert.equal(gated, 1);
    assert.equal(t.form.hidden, true);
    assert.doesNotMatch(t.ids['business-apply-state'].innerHTML, /couldn't send/);
});

test('§4 a failure with no new status keeps the form and its values, with one error line', async () => {
    const t = load({
        user: USER,
        postReply: { ok: false, error: 'Server error' },
        statusReply: { ok: true, data: { status: 'personal', can_apply: true } },
    });
    t.Page.renderApply({ status: 'personal', canApply: true });
    fillValid(t);
    await t.Page.submitApply(t.form);
    assert.equal(t.form.hidden, false);
    assert.equal(t.fields.company_name.value, 'Acme Ltd');
    assert.match(t.ids['business-apply-state'].innerHTML, /couldn't send your application/);
    assert.equal(t.ids['business-apply-submit'].disabled, false, 'the button comes back');
});

test('§4 VALIDATION_FAILED maps the server\'s field errors onto the form', async () => {
    const t = load({
        user: USER,
        postReply: { ok: false, code: 'VALIDATION_FAILED', error: 'Validation failed', details: [{ field: 'nzbn', message: 'NZBN must be 13 digits' }] },
    });
    t.Page.renderApply({ status: 'personal', canApply: true });
    fillValid(t);
    await t.Page.submitApply(t.form);
    assert.equal(t.form.hidden, false);
    assert.match(t.ids['business-apply-errors'].innerHTML, /NZBN must be 13 digits/);
});

test('§4 RATE_LIMITED (5 per signed-in user per 24h, BF-095) says so plainly — in BOTH shapes', async () => {
    // Measured 2026-09-29: ratelimit-policy 5;w=86400 on POST /api/business/apply.
    // Since BF-095 (backend 2026-10-06) it counts per signed-in USER, after auth.
    // API.request RESOLVES a 429 as {code:'RATE_LIMITED'} but can also THROW an
    // error carrying .code (ERR-266); both must land on the same message.
    for (const shape of ['resolved', 'thrown']) {
        const t = load({ user: USER, statusReply: { ok: true, data: { status: 'personal', can_apply: true } } });
        if (shape === 'resolved') t.ctx.API.post = async () => ({ ok: false, code: 'RATE_LIMITED', error: 'Too many requests', retry_after: 84657 });
        else t.ctx.API.post = async () => { const e = new Error('Too many requests'); e.code = 'RATE_LIMITED'; throw e; };
        t.Page.renderApply({ status: 'personal', canApply: true });
        fillValid(t);
        await t.Page.submitApply(t.form);
        const html = t.ids['business-apply-state'].innerHTML;
        assert.match(html, /can't take another online application from your account today/, shape);
        assert.doesNotMatch(html, /connection/, `${shape}: the limit is per account now, not per connection`);
        assert.match(html, /027 474 0115/, `${shape}: a person to call instead`);
        assert.doesNotMatch(html, /try again in a minute/, `${shape}: a 24h limit is not "a minute"`);
        assert.equal(t.form.hidden, false, `${shape}: answers kept`);
    }
});

// ── §5 the ladder ───────────────────────────────────────────────────────────

test('§5 a failed value-props read SAYS so; it never leaves the loading line', async () => {
    const t = load({ valueProps: { ok: false } });
    t.ids['business-ladder'].innerHTML = 'Loading the current price breaks…';
    await t.Page.renderLadder();
    assert.match(t.ids['business-ladder'].innerHTML, /couldn't load/);
    assert.ok(t.warns.some((w) => /value-props unavailable/.test(w)));
});

test('§5 a programme with no tiers is an ANSWER, worded as one', async () => {
    const t = load({ valueProps: { ok: true, data: {} } });
    await t.Page.renderLadder();
    assert.match(t.ids['business-ladder'].innerHTML, /aren't running just now/);
});

test('§5 tiers render the shared /bulk-pricing table', async () => {
    const t = load({ valueProps: { ok: true, data: { volume_pricing: { tiers: [{ min_price: 0, max_price: 100, min_quantity: 3, discount_percent: 4 }] } } } });
    await t.Page.renderLadder();
    assert.match(t.ids['business-ladder'].innerHTML, /value-page__table/);
    assert.match(t.ids['business-ladder'].innerHTML, /Buy more, pay less/);
});

// ── §6 page copy + wiring ───────────────────────────────────────────────────

test('§6 the open page states the terms, links /quote and /bulk-pricing, and makes no ranking claim', () => {
    const open = PAGE.slice(PAGE.indexOf('id="business-denied"'), PAGE.indexOf('id="business-unavailable"'));
    assert.match(open, /Net&nbsp;30/);
    assert.match(open, /GST tax invoices/);
    assert.match(open, /PO number/);
    assert.match(open, /href="\/quote"/);
    assert.match(open, /href="\/bulk-pricing"/);
    assert.match(open, /id="business-apply-form"[^>]*novalidate/);
    assert.doesNotMatch(open, /<form[^>]*\baction=/, 'posting is done in JS with the session token');
    assert.doesNotMatch(open.toLowerCase(), /lowest|best in nz|cheapest|save up to/, 'Google Ads compliance');
    // value-pages.js must load after utils.js (ValueProps) for the ladder.
    assert.ok(PAGE.indexOf('/js/value-pages.js') > PAGE.indexOf('/js/utils.js'));
});

test('§6 gate(): not-approved AND degraded both render the open page; degraded never guesses', () => {
    const code = stripComments(PAGE_JS);
    const gate = code.slice(code.indexOf('async gate()'), code.indexOf('renderAccount(status)'));
    assert.match(gate, /_statusDegraded[\s\S]*?show\('business-unavailable', true\)[\s\S]*?renderApply\('degraded'\)/);
    assert.match(gate, /!status\.active[\s\S]*?renderApply\(Business\.applyState/);
});

// ── §7 redirect survives sign-up; safeRedirect judges what the browser follows ─

function loginHelpers(store = {}) {
    const code = LOGIN_JS;
    const start = code.indexOf("const REDIRECT_KEY");
    const end = code.indexOf('// Tab switching');
    assert.ok(start > 0 && end > start, 'redirect helpers moved');
    const ctx = {
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        Security: {},
        Date,
        JSON,
        Number,
    };
    vm.createContext(ctx);
    vm.runInContext(SECURITY_JS + '\nthis.Security = Security;', ctx);
    vm.runInContext(code.slice(start, end) + '\nthis.rememberRedirect = rememberRedirect; this.postLoginRedirect = postLoginRedirect;', ctx);
    return { ctx, store };
}

test('§7 a sign-up with ?redirect= is remembered and used by the sign-in after verification', () => {
    const store = {};
    const a = loginHelpers(store);
    a.ctx.rememberRedirect(new URLSearchParams('tab=register&redirect=%2Fbusiness%23apply'));
    assert.ok(store.post_verify_redirect);
    const b = loginHelpers(store);   // new tab, from the verification email
    const p = new URLSearchParams('');
    assert.equal(b.ctx.postLoginRedirect(p), '/business#apply');
    assert.equal(b.ctx.postLoginRedirect(p), '/business#apply', 'memoised: both SIGNED_IN and the form redirect agree');
    assert.equal(store.post_verify_redirect, undefined, 'consumed once');
});

test('§7 the sign-up success path REMEMBERS the redirect before leaving for /account/verify-email', () => {
    const code = stripComments(LOGIN_JS);
    // The sign-up success branch: remember, THEN leave for verify-email. (The
    // login branch also goes to verify-email for an unverified sign-in, without
    // remembering — its ?redirect= is still on the URL.)
    assert.match(code, /rememberRedirect\(new URLSearchParams\(window\.location\.search\)\);\s*window\.location\.href = '\/account\/verify-email';/,
        'without this the verification link lands on /account and the applicant loses /business#apply');
    // Every post-sign-in redirect goes through the one helper, so none of them
    // can skip the remembered target.
    assert.equal((code.match(/Security\.safeRedirect\(params\.get\('redirect'\)\)/g) || []).length, 1,
        'the only direct read of ?redirect= is inside postLoginRedirect');
    assert.ok((code.match(/postLoginRedirect\(params\)/g) || []).length >= 3);
});

test('§7 stale, unsafe or absent → /account; an explicit ?redirect= always wins', () => {
    const old = { post_verify_redirect: JSON.stringify({ path: '/business', at: Date.now() - 25 * 3600 * 1000 }) };
    assert.equal(loginHelpers(old).ctx.postLoginRedirect(new URLSearchParams('')), '/account');

    const s = {};
    loginHelpers(s).ctx.rememberRedirect(new URLSearchParams('redirect=%2F%5Cevil.com'));
    assert.equal(s.post_verify_redirect, undefined, 'an unsafe target is never stored');

    const fresh = { post_verify_redirect: JSON.stringify({ path: '/business', at: Date.now() }) };
    assert.equal(loginHelpers(fresh).ctx.postLoginRedirect(new URLSearchParams('redirect=%2Fcart')), '/cart');
    assert.equal(loginHelpers({}).ctx.postLoginRedirect(new URLSearchParams('')), '/account');
});

test('§7 safeRedirect rejects what a browser would follow off-site (WHATWG: "\\\\" is "/", tab/CR/LF dropped)', () => {
    const { ctx } = loginHelpers({});
    const f = (u) => ctx.Security.safeRedirect(u);
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '\\\\evil.com', 'https://evil.com', 'javascript:alert(1)']) {
        assert.equal(f(bad), '/account', JSON.stringify(bad));
        // The claim is about the browser, so check it against the browser's parser.
        if (bad.startsWith('/')) assert.notEqual(new URL(bad, 'https://www.inkcartridges.co.nz/account/login').host, 'www.inkcartridges.co.nz');
    }
    for (const good of ['/business#apply', '/account/orders', '/shop?q=a/b']) assert.equal(f(good), good);
});
