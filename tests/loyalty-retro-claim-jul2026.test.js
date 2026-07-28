/**
 * Retroactive loyalty claim + signup intent (Jul 2026)
 * ====================================================
 *
 * BACKGROUND. When a guest signs up with an email that already has guest orders,
 * the backend now claims those orders and awards their points DURING
 * POST /api/account/sync. That used to happen on a nightly cron (~24h lag); it is
 * now immediate. So a brand-new account can land on the dashboard with a non-zero
 * points balance and orders in its history — and nothing explained why.
 *
 * THE CONTRACT THESE TESTS DEFEND — the banner is STRICTLY BACKEND-DRIVEN:
 *
 *   - No `retro` block in the sync response  => render NOTHING.
 *   - A `retro` block with zeros             => render NOTHING. "orders_claimed: 0"
 *                                               is the backend saying nothing
 *                                               happened; it is not an event.
 *   - It is NEVER inferred from a balance, a ledger diff, or an order count. A
 *     wrong "we found your past orders" is worse than no banner at all, and every
 *     number shown is one the backend sent, not one we computed.
 *   - Shown at most ONCE (delete-on-read + a per-device seen marker).
 *   - A stash belonging to a different user is discarded (shared devices).
 *
 * The backend field is requested in readfirst/loyalty-retro-claim-jul2026.md
 * (BF-011). Until it ships, every path here renders nothing — which is why the
 * "absent" cases below matter more than the happy path.
 *
 * Run with: node --test tests/loyalty-retro-claim-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');
const HTML = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const UID = 'user-abc-123';

function makeStorage() {
    const map = new Map();
    return {
        map,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear()
    };
}

/**
 * Load ONLY the retro-claim members of Auth into a sandbox.
 *
 * auth.js is a large object literal wired to the Supabase SDK; booting all of it
 * would test the SDK stub, not the contract. Extracting the members under test
 * keeps the assertions about behaviour. The extraction is itself asserted below
 * ("the methods under test exist in auth.js"), so this cannot silently drift into
 * testing a copy that no longer matches the shipped file.
 */
function loadAuthRetro(opts = {}) {
    const src = JS('auth.js');
    const members = [
        'RETRO_STASH_KEY', 'RETRO_SEEN_KEY',
        'captureRetroClaim', '_retroAlreadySeen', 'markRetroClaimSeen', 'takeRetroClaim'
    ];

    // Slice each member out of the object literal, from its name to the line
    // before the next top-level member.
    const start = src.indexOf('    RETRO_STASH_KEY:');
    const end = src.indexOf('    /**\n     * Get a Turnstile token');
    assert.ok(start > 0 && end > start, 'retro-claim block not found in auth.js');
    const block = src.slice(start, end);
    for (const m of members) {
        assert.ok(block.includes(m), `auth.js retro block must define ${m}`);
    }

    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    const warnings = [];
    const sandbox = {
        console, JSON, Number, Math, Object, String,
        sessionStorage, localStorage,
        DebugLog: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(
        `var Auth = { user: ${JSON.stringify(opts.user === undefined ? { id: UID } : opts.user)},\n${block}\n};`,
        sandbox,
        { filename: 'auth-retro.js' }
    );

    return { Auth: sandbox.Auth, sessionStorage, localStorage, warnings };
}

/** A minimal DOM for AccountPage.renderRetroClaimBanner(). */
function makeDom() {
    const els = {};
    const make = (id) => ({
        id,
        hidden: true,
        textContent: '',
        innerHTML: '',
        dataset: {},
        listeners: [],
        addEventListener(ev, fn) { this.listeners.push([ev, fn]); }
    });
    for (const id of ['account-retro-banner', 'account-retro-title', 'account-retro-body', 'account-retro-dismiss']) {
        els[id] = make(id);
    }
    return {
        els,
        document: { getElementById: (id) => els[id] || null }
    };
}

/** Load AccountPage.renderRetroClaimBanner against a stubbed Auth + DOM. */
function loadBanner(authStub, dom) {
    const src = JS('account.js');
    const start = src.indexOf('    renderRetroClaimBanner()');
    assert.ok(start > 0, 'renderRetroClaimBanner not found in account.js');
    // Slice to the next sibling member at the same indentation.
    const rest = src.slice(start);
    const endRel = rest.indexOf('\n    },');
    assert.ok(endRel > 0, 'could not delimit renderRetroClaimBanner');
    const body = rest.slice(0, endRel + '\n    },'.length);

    const sandbox = {
        console, JSON, Number, Math, Object, String,
        Auth: authStub,
        Security: { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
        document: dom.document,
        DebugLog: { warn: () => {}, error: () => {} }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`var AccountPage = {\n${body}\n};`, sandbox, { filename: 'account-retro.js' });
    return sandbox.AccountPage;
}

// ─────────────────────────────────────────────────────────────────────────────
// capture: what the backend must say before anything is stashed
// ─────────────────────────────────────────────────────────────────────────────

test('no retro block => nothing stashed', () => {
    const { Auth, sessionStorage } = loadAuthRetro();
    Auth.captureRetroClaim({ ok: true, data: {} });
    Auth.captureRetroClaim({ ok: true });
    Auth.captureRetroClaim(null);
    Auth.captureRetroClaim(undefined);
    assert.equal(sessionStorage.map.size, 0, 'silence from the backend means silence in the UI');
});

test('a retro block of ZEROS is not an event', () => {
    // "orders_claimed: 0" is the backend telling us nothing happened. Rendering
    // "0 points added" would be the absence-as-zero defect all over again.
    const { Auth, sessionStorage } = loadAuthRetro();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 0, points_awarded: 0 } } });
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 2, points_awarded: 0 } } });
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 0, points_awarded: 400 } } });
    assert.equal(sessionStorage.map.size, 0);
});

test('junk or missing numbers are not stashed', () => {
    const { Auth, sessionStorage } = loadAuthRetro();
    for (const retro of [
        { orders_claimed: 'two', points_awarded: 400 },
        { orders_claimed: 2 },
        { points_awarded: 400 },
        { orders_claimed: NaN, points_awarded: 400 },
        { orders_claimed: -1, points_awarded: 400 },
        {}
    ]) {
        Auth.captureRetroClaim({ data: { retro } });
    }
    assert.equal(sessionStorage.map.size, 0);
});

test('a real claim is stashed with both figures and the user id', () => {
    const { Auth, sessionStorage } = loadAuthRetro();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 3, points_awarded: 412, claim_id: 'rc_9' } } });
    const stash = JSON.parse(sessionStorage.getItem('ic_retro_claim'));
    assert.equal(stash.orders, 3);
    assert.equal(stash.points, 412);
    assert.equal(stash.uid, UID);
    assert.equal(stash.claimId, 'rc_9');
});

test('nothing is stashed when there is no signed-in user to attribute it to', () => {
    const { Auth, sessionStorage } = loadAuthRetro({ user: null });
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 3, points_awarded: 412 } } });
    assert.equal(sessionStorage.map.size, 0);
});

test('capture never throws when storage is unavailable (private mode / quota)', () => {
    const { Auth } = loadAuthRetro();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 1, points_awarded: 10 } } });
    // Break storage after the first write, then capture again.
    assert.doesNotThrow(() => {
        Auth.captureRetroClaim({ data: { retro: { orders_claimed: 2, points_awarded: 20 } } });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// take: exactly once, and only for the right user
// ─────────────────────────────────────────────────────────────────────────────

test('takeRetroClaim is DELETE-ON-READ — a second call in the same load returns null', () => {
    // The dashboard calls the renderer twice (once immediately, once after its
    // own sync answers) because login-page.js can cancel auth.js's sync
    // mid-flight. Delete-on-read is what makes that safe.
    const { Auth, sessionStorage } = loadAuthRetro();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 2, points_awarded: 300 } } });
    assert.ok(Auth.takeRetroClaim());
    assert.equal(Auth.takeRetroClaim(), null);
    assert.equal(sessionStorage.getItem('ic_retro_claim'), null);
});

test('an announced claim is not re-stashed if the backend re-sends it', () => {
    const { Auth, localStorage } = loadAuthRetro();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 2, points_awarded: 300 } } });
    Auth.takeRetroClaim();
    assert.ok(localStorage.getItem('ic_retro_claim_seen'), 'a seen marker is written');

    // A later login re-reports the same award (idempotent backend, same numbers).
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 2, points_awarded: 300 } } });
    assert.equal(Auth.takeRetroClaim(), null, 'must not announce the same claim twice');
});

test('a DIFFERENT claim is still announced after an earlier one', () => {
    const { Auth } = loadAuthRetro();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 2, points_awarded: 300 } } });
    Auth.takeRetroClaim();
    Auth.captureRetroClaim({ data: { retro: { orders_claimed: 1, points_awarded: 55 } } });
    const second = Auth.takeRetroClaim();
    assert.ok(second, 'the seen marker must pin one claim, not mute the feature');
    assert.equal(second.points, 55);
});

test('a stash belonging to another user is discarded (shared device)', () => {
    const { Auth, sessionStorage } = loadAuthRetro();
    sessionStorage.setItem('ic_retro_claim', JSON.stringify({
        v: 1, uid: 'someone-else', orders: 9, points: 9999, signature: 'x'
    }));
    assert.equal(Auth.takeRetroClaim(), null);
    assert.equal(sessionStorage.getItem('ic_retro_claim'), null, 'and it is cleared, not left to leak later');
});

test('a corrupt or wrong-version stash is ignored, not rendered', () => {
    const { Auth, sessionStorage } = loadAuthRetro();
    for (const raw of ['not json', '{}', JSON.stringify({ v: 2, uid: UID, orders: 1, points: 1 }),
        JSON.stringify({ v: 1, uid: UID, orders: 0, points: 0 })]) {
        sessionStorage.setItem('ic_retro_claim', raw);
        assert.equal(Auth.takeRetroClaim(), null, `must reject: ${raw}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// render: the banner itself
// ─────────────────────────────────────────────────────────────────────────────

test('renders nothing at all when there is no claim', () => {
    const dom = makeDom();
    const page = loadBanner({ takeRetroClaim: () => null }, dom);
    page.renderRetroClaimBanner();
    assert.equal(dom.els['account-retro-banner'].hidden, true);
    assert.equal(dom.els['account-retro-title'].textContent, '', 'no DOM writes whatsoever');
    assert.equal(dom.els['account-retro-body'].innerHTML, '');
});

test('renders both figures when a claim is present', () => {
    const dom = makeDom();
    const page = loadBanner({ takeRetroClaim: () => ({ orders: 3, points: 1412 }) }, dom);
    page.renderRetroClaimBanner();
    assert.equal(dom.els['account-retro-banner'].hidden, false);
    assert.match(dom.els['account-retro-title'].textContent, /1,412 points/, 'points are grouped en-NZ');
    assert.match(dom.els['account-retro-body'].innerHTML, /3 previous orders/);
    assert.match(dom.els['account-retro-body'].innerHTML, /\/account\/loyalty/, 'links to the ledger');
});

test('singular wording for exactly one order', () => {
    const dom = makeDom();
    const page = loadBanner({ takeRetroClaim: () => ({ orders: 1, points: 55 }) }, dom);
    page.renderRetroClaimBanner();
    const body = dom.els['account-retro-body'].innerHTML;
    assert.match(body, /1 previous order\b/);
    assert.doesNotMatch(body, /1 previous orders/);
});

test('the banner makes no claim about timing', () => {
    // Retro points are immediate now. No "24h"/"overnight" copy has ever existed
    // in this repo — do not introduce one here.
    const dom = makeDom();
    const page = loadBanner({ takeRetroClaim: () => ({ orders: 2, points: 300 }) }, dom);
    page.renderRetroClaimBanner();
    const all = dom.els['account-retro-title'].textContent + ' ' + dom.els['account-retro-body'].innerHTML;
    assert.doesNotMatch(all, /24\s*h|24 hours|overnight|business day|shortly|may take/i);
});

test('the dismiss button hides the banner and binds exactly once', () => {
    const dom = makeDom();
    const page = loadBanner({ takeRetroClaim: () => ({ orders: 2, points: 300 }) }, dom);
    page.renderRetroClaimBanner();
    const dismiss = dom.els['account-retro-dismiss'];
    assert.equal(dismiss.listeners.length, 1);
    dismiss.listeners[0][1]();
    assert.equal(dom.els['account-retro-banner'].hidden, true);
});

test('renderRetroClaimBanner is a no-op when the markup is absent', () => {
    // It is called from loadDashboard, which runs on every account page; only the
    // dashboard carries the banner markup.
    const page = loadBanner({ takeRetroClaim: () => ({ orders: 2, points: 300 }) },
        { document: { getElementById: () => null } });
    assert.doesNotThrow(() => page.renderRetroClaimBanner());
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

test('auth.js captures the retro block at the sync call site', () => {
    const src = JS('auth.js');
    assert.match(src, /const syncResult = await API\.accountSync\(turnstileToken\);[\s\S]{0,400}?this\.captureRetroClaim\(syncResult\)/,
        'captureRetroClaim must run on the response from the sync in onAuthStateChange');
});

test('account.js captures from ITS OWN sync too, and renders twice', () => {
    // login-page.js registers its own onAuthStateChange that navigates away on
    // SIGNED_IN, which can cancel auth.js's accountSync mid-flight. The dashboard's
    // own sync is often the call that actually returns the retro block, so the
    // capture is deliberately double-sited.
    const src = JS('account.js');
    assert.match(src, /const syncResult = await API\.accountSync\(turnstileToken\)/,
        'syncProfileToBackend must keep the response, not discard it');
    assert.match(src, /Auth\.captureRetroClaim\(syncResult\)/);
    assert.match(src, /this\.renderRetroClaimBanner\(\);[\s\S]{0,400}?syncProfileToBackend\(\)[\s\S]{0,80}?renderRetroClaimBanner\(\)/,
        'loadDashboard must render once immediately and once after its own sync');
});

test('the dashboard carries the banner markup, hidden by default', () => {
    const html = HTML('html/account/index.html');
    assert.match(html, /id="account-retro-banner"[^>]*hidden/, 'must ship hidden');
    assert.match(html, /id="account-retro-title"/);
    assert.match(html, /id="account-retro-body"/);
    assert.match(html, /id="account-retro-dismiss"/);
    assert.match(html, /role="status"/, 'screen readers should hear the announcement');
});

test('the banner never fabricates a claim from a balance or order count', () => {
    const src = JS('account.js');
    const fn = src.slice(src.indexOf('renderRetroClaimBanner()'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.doesNotMatch(body, /getLoyalty|getOrders|points_balance|lifetime_earned/,
        'the banner must read the sync result only — never infer from other data');
});

// ─────────────────────────────────────────────────────────────────────────────
// Signup intent on /account
// ─────────────────────────────────────────────────────────────────────────────

test('/account honours ?intent=signup by opening the REGISTER tab', () => {
    // The guest-invoice email's "Sign up & claim your points" CTA points at
    // /account. A logged-out visitor is bounced to /account/login, which opens the
    // SIGN IN tab — the wrong ask for someone with no account.
    const src = JS('account.js');
    assert.match(src, /URLSearchParams\(window\.location\.search\)\.get\('intent'\)/);
    assert.match(src, /intent === 'signup'\s*\?\s*'&tab=register'\s*:\s*''/,
        'strict equality — the value must never be reflected into the URL');
    assert.match(src, /'\/account\/login\?redirect='[\s\S]{0,120}\+ tab/);
});

test('login-page.js still honours ?tab=register (the other half of the contract)', () => {
    const src = JS('login-page.js');
    assert.match(src, /get\('tab'\)|tab.*register/i,
        'the login page must still read the tab param the redirect appends');
});

test('rewards-nudge.js and /account converge on the same register-tab param', () => {
    assert.match(JS('rewards-nudge.js'), /\/account\/login\?tab=register/,
        'one param for the register tab, used by both signup entry points');
});
