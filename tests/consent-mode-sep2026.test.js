/**
 * Consent Mode — the key gtag.js reads and nothing ever wrote (ERR-227)
 * ====================================================================
 *
 * js/gtag.js line 9 decides analytics_storage from
 * `localStorage.getItem('cookie_consent') === 'accepted'`. That key had ONE
 * reader and ZERO writers anywhere in the repository, so the comparison was
 * false for every visitor since the day it shipped and GA4 ran in cookieless
 * ping mode permanently. Nothing logged it, because nothing was broken in the
 * sense any test was asking about.
 *
 * WHY THIS FILE EXECUTES THE BANNER INSTEAD OF GREPPING IT
 * -------------------------------------------------------
 * ERR-224's 21 tests are all source-text assertions, and two of its four
 * mutations initially passed against a broken build — one matched a phrase
 * inside the comment explaining it. A grep for `localStorage.setItem` cannot
 * tell you what value actually lands in storage, and the value is the entire
 * bug here: setStorage() from utils.js JSON-stringifies, so routing this through
 * the house helper would persist `"accepted"` WITH QUOTES and gtag's bare-string
 * comparison would stay false for ever — banner gone, consent still denied, no
 * error anywhere. So §2 runs consent-banner.js in a VM against a fake DOM and
 * reads back what is genuinely in storage.
 *
 * §4 pins the pairing rather than either half: a writer and a reader that agree
 * with themselves and not each other is the ERR-199 shape.
 *
 * Run with: node --test tests/consent-mode-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');

const BANNER_SRC = fs.readFileSync(path.join(INK, 'js', 'consent-banner.js'), 'utf8');
const GTAG_SRC = fs.readFileSync(path.join(INK, 'js', 'gtag.js'), 'utf8');
const CSS = fs.readFileSync(path.join(INK, 'css', 'components.css'), 'utf8');

/** Source with comments removed. An assertion must never be satisfied by the
 *  prose explaining the thing it is checking for (the ERR-224 lesson). */
function codeOnly(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const BANNER = codeOnly(BANNER_SRC);

/** Every .html in the deployed tree. */
function htmlFiles(dir = INK, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) htmlFiles(full, out);
        else if (entry.name.endsWith('.html')) out.push(full);
    }
    return out;
}
const HTML = htmlFiles();

/** Tolerates the ?v= token deliberately — never pin a cache token (ERR-067). */
const loads = (src, file) =>
    new RegExp(`src="/js/${file.replace('.', '\\.')}(\\?v=[a-f0-9]+)?"`).test(src);


/* ── §1 ENROLMENT ────────────────────────────────────────────────────────────
   ERR-214: markup hash-locked across 30 pages, the runtime enrolled by hand,
   and 10 pages drifted for four months. The enrolment is pinned here, in the
   same file as the behaviour. */

test('§1 the tree actually has pages to check (guards a vacuous pass)', () => {
    assert.ok(HTML.length >= 40, `expected 40+ html files, found ${HTML.length}`);
    const withGtag = HTML.filter((f) => loads(fs.readFileSync(f, 'utf8'), 'gtag.js'));
    assert.ok(withGtag.length >= 35,
        `expected gtag.js on 35+ pages, found ${withGtag.length} — the anchor moved`);
});

test('§1 EVERY page that loads gtag.js also loads consent-banner.js', () => {
    const missing = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        if (!loads(src, 'gtag.js')) continue;
        if (!loads(src, 'consent-banner.js')) missing.push(path.relative(INK, file));
    }
    assert.deepEqual(missing, [],
        'these pages read cookie_consent but ship no way to set it:\n  ' + missing.join('\n  '));
});

test('§1 and no page ships the banner without the gtag that reads its key', () => {
    const orphan = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        if (loads(src, 'consent-banner.js') && !loads(src, 'gtag.js')) {
            orphan.push(path.relative(INK, file));
        }
    }
    assert.deepEqual(orphan, [], 'a consent prompt that gates nothing:\n  ' + orphan.join('\n  '));
});

test('§1 the banner tag is deferred — root 404.html does not defer its siblings', () => {
    const bad = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        const m = src.match(/<script([^>]*)src="\/js\/consent-banner\.js[^"]*"/);
        if (!m) continue;
        if (!/\bdefer\b/.test(m[1])) bad.push(path.relative(INK, file));
    }
    assert.deepEqual(bad, [],
        'needs defer to reach a parsed <body>:\n  ' + bad.join('\n  '));
});


/* ── §2 BEHAVIOUR — the file is EXECUTED, not read ──────────────────────────── */

/** The smallest DOM that consent-banner.js can actually run against. */
function makeEnv({ pathname = '/checkout', stored = null, storedVersion = null } = {}) {
    const store = new Map();
    if (stored !== null) store.set('cookie_consent', stored);
    if (storedVersion !== null) store.set('cookie_consent_v', storedVersion);

    const listeners = [];
    class El {
        constructor(tag) {
            this.tagName = String(tag).toUpperCase();
            this.children = [];
            this.attrs = {};
            this.textContent = '';
            this.className = '';
            this.id = '';
            this.parentNode = null;
            this.offsetWidth = 1;
            this._classes = new Set();
            this.style = {
                _p: {},
                setProperty: (k, v) => { this.style._p[k] = v; },
                removeProperty: (k) => { delete this.style._p[k]; },
            };
            this.classList = {
                add: (c) => this._classes.add(c),
                remove: (c) => this._classes.delete(c),
                contains: (c) => this._classes.has(c),
            };
        }
        setAttribute(k, v) { this.attrs[k] = String(v); }
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
        removeChild(c) {
            this.children = this.children.filter((x) => x !== c);
            c.parentNode = null;
            return c;
        }
        addEventListener(ev, fn) { listeners.push({ el: this, ev, fn }); }
        getBoundingClientRect() { return { height: 72, width: 390, top: 772, bottom: 844 }; }
        /** Depth-first search over the built tree. */
        find(pred) {
            if (pred(this)) return this;
            for (const c of this.children) { const r = c.find(pred); if (r) return r; }
            return null;
        }
    }

    const body = new El('body');
    const document = {
        readyState: 'complete',
        body,
        createElement: (t) => new El(t),
        createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
        getElementById: (id) => body.find((e) => e.id === id),
        addEventListener: () => {},
    };

    const gtagCalls = [];
    const win = {
        location: { pathname },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
        },
    };
    const ctx = {
        window: win,
        document,
        location: win.location,
        localStorage: win.localStorage,
        gtag: (...a) => { gtagCalls.push(a); },
        console,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(BANNER_SRC, ctx, { filename: 'consent-banner.js' });

    const click = (label) => {
        const btn = body.find((e) => e.tagName === 'BUTTON' && e.textContent === label);
        assert.ok(btn, `no "${label}" button was rendered`);
        listeners.filter((l) => l.el === btn && l.ev === 'click').forEach((l) => l.fn());
    };

    return {
        body, store, gtagCalls, click, win,
        banner: () => body.find((e) => e.id === 'consent-banner'),
        raw: (k) => (store.has(k) ? store.get(k) : null),
    };
}

test('§2 with no decision stored, the banner renders', () => {
    const env = makeEnv();
    assert.ok(env.banner(), 'no banner was appended for an undecided visitor');
    assert.equal(env.banner().getAttribute('role'), 'region');
});

test('§2 Accept stores the RAW string gtag compares against — not JSON', () => {
    const env = makeEnv();
    env.click('Accept');
    assert.equal(env.raw('cookie_consent'), 'accepted');
    // The whole bug in one assertion: setStorage() would have written `"accepted"`.
    assert.notEqual(env.raw('cookie_consent'), '"accepted"',
        'JSON-quoted value — gtag.js compares against the bare string and would stay denied');
    assert.equal(env.raw('cookie_consent') === 'accepted', true,
        'must satisfy the exact comparison in gtag.js line 9');
});

test('§2 Accept flips analytics_storage to granted', () => {
    const env = makeEnv();
    env.click('Accept');
    const update = env.gtagCalls.find((c) => c[0] === 'consent' && c[1] === 'update');
    assert.ok(update, 'no gtag consent update was sent');
    assert.equal(update[2].analytics_storage, 'granted');
});

test('§2 Decline stores a real decision and denies', () => {
    const env = makeEnv();
    env.click('Decline');
    assert.equal(env.raw('cookie_consent'), 'declined');
    const update = env.gtagCalls.find((c) => c[0] === 'consent' && c[1] === 'update');
    assert.equal(update[2].analytics_storage, 'denied');
});

test('§2 deciding removes the bar and releases the space it reserved', () => {
    const env = makeEnv();
    assert.ok(env.body.classList.contains('has-consent-banner'), 'space was never reserved');
    env.click('Accept');
    assert.equal(env.banner(), null, 'the bar survived the click');
    assert.equal(env.body.classList.contains('has-consent-banner'), false,
        'padding left behind — a permanent gap at the foot of every page');
});

test('§2 an existing decision shows nothing at all', () => {
    for (const v of ['accepted', 'declined']) {
        const env = makeEnv({ stored: v, storedVersion: '1' });
        assert.equal(env.banner(), null, `re-prompted a visitor who already chose "${v}"`);
        assert.equal(env.body.classList.contains('has-consent-banner'), false);
    }
});

test('§2 a pre-existing accept with NO version key is honoured, never re-asked', () => {
    // Absent version means version 1 — the accounts that accepted before this
    // shipped must not be re-prompted on deploy day.
    const env = makeEnv({ stored: 'accepted' });
    assert.equal(env.banner(), null);
});

test('§2 admin pages are skipped', () => {
    const env = makeEnv({ pathname: '/admin/orders' });
    assert.equal(env.banner(), null, 'staff tooling is not a consent surface');
});

test('§2 a junk stored value is treated as undecided, not as consent', () => {
    const env = makeEnv({ stored: 'yes', storedVersion: '1' });
    assert.ok(env.banner(), 'an unrecognised value must re-ask, never imply consent');
});

test('§2 the bar reserves its MEASURED height, not a hardcoded constant', () => {
    const env = makeEnv();
    assert.equal(env.body.style._p['--consent-banner-height'], '72px',
        'must come from getBoundingClientRect — a constant reserving space for '
        + 'content is a measurement someone declined to take (ERR-189/196)');
});


/* ── §3 SCOPE AND SHAPE ──────────────────────────────────────────────────────── */

test('§3 the banner never touches ad_storage', () => {
    // gtag.js declares only analytics_storage, so ad_storage is granted and Ads
    // conversion tracking works. Denying it here would silently switch off the
    // measurement ERR-224 exists to rescue.
    assert.doesNotMatch(BANNER, /ad_storage|ad_user_data|ad_personalization/,
        'this would disable Google Ads conversion tracking as a side effect');
});

test('§3 it is a bottom bar, not a full-screen interstitial', () => {
    assert.doesNotMatch(BANNER, /aria-modal|role="dialog"|role', 'dialog'/,
        'a consent prompt must never trap a shopper');
    const rule = CSS.slice(CSS.indexOf('.consent-banner {'));
    assert.match(rule.slice(0, 400), /bottom:\s*0/);
    assert.doesNotMatch(rule.slice(0, 400), /inset:\s*0|top:\s*0/,
        'full-screen overlay — the ERR-224 mistake in a new place');
});

test('§3 the touch targets clear 44px', () => {
    const rule = CSS.slice(CSS.indexOf('.consent-banner__btn {'));
    const m = rule.slice(0, 300).match(/min-height:\s*(\d+)px/);
    assert.ok(m && Number(m[1]) >= 44, `min-height must be >= 44px, found ${m && m[1]}`);
});

test('§3 the reserved space is applied to the body in CSS', () => {
    assert.match(CSS, /body\.has-consent-banner\s*\{[^}]*padding-bottom:\s*var\(--consent-banner-height/,
        'the JS measures the height; the CSS must actually spend it');
});


/* ── §4 THE PAIRING — writer and reader must agree ───────────────────────────── */

test('§4 gtag.js still reads exactly the key and value the banner writes', () => {
    const gtag = codeOnly(GTAG_SRC);
    assert.match(gtag, /localStorage\.getItem\('cookie_consent'\)\s*===\s*'accepted'/,
        'gtag.js changed its side of the contract');
    assert.match(BANNER, /'cookie_consent'/);
    assert.match(BANNER, /accepted:\s*'accepted'/);
});

test('§4 the banner does NOT route storage through setStorage()', () => {
    // setStorage JSON-stringifies. This is the refactor that looks like cleanup
    // and silently re-breaks consent for ever.
    assert.doesNotMatch(BANNER, /setStorage\s*\(/,
        'setStorage() would persist "accepted" WITH QUOTES; gtag compares bare');
    assert.match(BANNER, /localStorage\.setItem\(/, 'must write storage directly');
});

test('§4 gtag.js declares only analytics_storage in its consent default', () => {
    const dflt = GTAG_SRC.slice(GTAG_SRC.indexOf("gtag('consent', 'default'"), GTAG_SRC.indexOf('});'));
    assert.doesNotMatch(dflt, /ad_storage/,
        'if this ever declares ad_storage, the banner must be revisited deliberately');
});
