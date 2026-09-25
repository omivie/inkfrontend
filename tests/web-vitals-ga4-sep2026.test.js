/**
 * Real-user Core Web Vitals → GA4 (latency follow-up to ERR-282)
 * ================================================================
 * `WebVitalsReporter` in js/gtag.js loads web-vitals@6.2.2 (pinned, SRI) after
 * `load` and sends LCP/FCP/INP/CLS/TTFB to the GA4 property ONLY. These tests
 * run the shipped gtag.js in a vm — never a replica.
 *
 * Why each assertion exists:
 *   - send_to: an event without it also reaches the Ads tag AW-18032498762,
 *     putting non-conversion hits into the account the owner bids from.
 *   - SRI + exact version: a floating `@6` would let a new upstream release run
 *     on every page unreviewed; SRI makes a changed file fail closed.
 *   - after `load`: the library is not allowed on the critical path it measures.
 *
 * Run with: node --test tests/web-vitals-ga4-sep2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ICR = path.join(__dirname, '..', 'inkcartridges');
const SRC = fs.readFileSync(path.join(ICR, 'js', 'gtag.js'), 'utf8');

function load({ pathname = '/shop', readyState = 'loading' } = {}) {
    const events = [];
    const appended = [];
    const listeners = {};
    const store = {};
    const sandbox = {
        console, Math, JSON, Object, Array, String, Number, Boolean, Date, Promise, Set, Map,
        location: { pathname, hostname: 'www.inkcartridges.co.nz', search: '' },
        navigator: { userAgent: 'test' },
        localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: {
            readyState,
            cookie: '',
            head: { appendChild: (el) => appended.push(el) },
            documentElement: {},
            createElement: (tag) => ({ tag }),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        setTimeout, clearTimeout,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'gtag.js' });
    // Capture events after the config lines: replace the dataLayer shim's sink.
    sandbox.gtag = (...args) => events.push(args);
    return { sandbox, events, appended, listeners };
}

test('library is pinned to an exact version with a sha384 SRI hash', () => {
    const { sandbox } = load();
    const r = sandbox.WebVitalsReporter;
    assert.match(r.SRC, /^https:\/\/cdn\.jsdelivr\.net\/npm\/web-vitals@\d+\.\d+\.\d+\/dist\/web-vitals\.iife\.js$/);
    assert.match(r.INTEGRITY, /^sha384-[A-Za-z0-9+/]{64}$/);
});

test('the script is injected only after load, with integrity + crossorigin', () => {
    const { appended, listeners } = load({ readyState: 'loading' });
    assert.equal(appended.filter((e) => /web-vitals/.test(e.src || '')).length, 0, 'must not load before `load`');
    assert.equal((listeners.load || []).length >= 1, true);
    for (const fn of listeners.load) fn();
    const s = appended.find((e) => /web-vitals/.test(e.src || ''));
    assert.ok(s, 'injected on load');
    assert.match(s.integrity, /^sha384-/);
    assert.equal(s.crossOrigin, 'anonymous');
    assert.equal(s.async, true);
});

test('never runs on admin pages', () => {
    const { sandbox, appended, listeners } = load({ pathname: '/admin/orders', readyState: 'complete' });
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.WebVitalsReporter.start())), { started: false, reason: 'admin' });
    assert.equal(appended.filter((e) => /web-vitals/.test(e.src || '')).length, 0);
    assert.equal((listeners.load || []).length, 0);
});

test('every metric goes to the GA4 property ONLY, never the Ads tag', () => {
    const { sandbox, events } = load();
    for (const name of ['LCP', 'FCP', 'INP', 'TTFB']) {
        sandbox.WebVitalsReporter.send({ name, value: 1234.6, delta: 1234.6, id: 'v5-1', rating: 'good' });
    }
    sandbox.WebVitalsReporter.send({ name: 'CLS', value: 0.1234, delta: 0.1234, id: 'v5-2', rating: 'needs-improvement' });
    assert.equal(events.length, 5);
    for (const [cmd, , params] of events) {
        assert.equal(cmd, 'event');
        assert.equal(params.send_to, 'G-SDQELG0FGD');
        assert.doesNotMatch(JSON.stringify(params), /AW-/);
        assert.equal(params.non_interaction, true);
        assert.ok(Number.isInteger(params.value));
    }
    assert.equal(events[0][2].value, 1235, 'ms delta rounded');
    assert.equal(events[4][2].value, 123, 'CLS scaled ×1000 so GA4 can sum an integer');
    assert.equal(events[4][2].metric_rating, 'needs-improvement');
});

test('onload wires every metric; a missing global or gtag fails soft', () => {
    const { sandbox, appended, listeners, events } = load();
    for (const fn of listeners.load) fn();
    const s = appended.find((e) => /web-vitals/.test(e.src || ''));
    const wired = [];
    sandbox.webVitals = Object.fromEntries(['onLCP', 'onFCP', 'onINP', 'onCLS', 'onTTFB'].map((k) => [k, (cb) => { wired.push(k); cb({ name: k.slice(2), value: 1, delta: 1, id: 'x', rating: 'good' }); }]));
    s.onload();
    assert.deepEqual(wired, ['onLCP', 'onFCP', 'onINP', 'onCLS', 'onTTFB']);
    assert.equal(events.length, 5);
    delete sandbox.webVitals;
    assert.doesNotThrow(() => s.onload());
    sandbox.gtag = undefined;
    assert.equal(sandbox.WebVitalsReporter.send({ name: 'LCP', value: 1, delta: 1 }), false);
});

test('the CSP allows the CDN in script-src (a blocked script would measure nothing, silently)', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ICR, 'vercel.json'), 'utf8'));
    const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    assert.match(scriptSrc, /https:\/\/cdn\.jsdelivr\.net(\s|$)/);
});
