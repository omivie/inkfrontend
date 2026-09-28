/**
 * Backend move to Render Singapore + storefront speed fixes — backend handoff 2026-09-28
 * ======================================================================================
 *
 * backend-docs/inbox/fe-handoff-page-speed-and-backend-move-sep2026.md. Every claim
 * the handoff makes about a live endpoint was measured before it was built on
 * (scripts/probe-backend-move.mjs); where the handoff was wrong, the section says so.
 *
 *   §0  The Vercel side names `ink-backend-sg`, never the retired `ink-backend-zaeq`.
 *       The old service is switched off once this ships; a rewrite still naming it
 *       would 404 the sitemap, the feeds, robots.txt and every bot prerender.
 *   §4a site-guard reads GET /api/site/lock, not site_settings straight from
 *       Supabase — one uncached Mumbai round trip fewer on every page view — and
 *       still fails OPEN on every failure.
 *
 * Run with: node --test tests/backend-move-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const OLD_HOST = 'ink-backend-zaeq.onrender.com';
const NEW_ORIGIN = 'https://ink-backend-sg.onrender.com';

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs, out); }
        else if (/\.(js|mjs|html|json)$/.test(e.name)) out.push(abs);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §0 No shipped file names the old backend host
// ─────────────────────────────────────────────────────────────────────────────

test('§0 nothing under the web root or scripts/ names the old Render host', () => {
    // The web root is what Vercel serves and runs (middleware, rewrites, CSP,
    // every fallback). scripts/ is here too: a probe defaulting to a switched-off
    // host fails on a DNS error and reads like an outage, not a stale default.
    const files = [...walk(INK), ...walk(path.join(ROOT, 'scripts'))];
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(OLD_HOST))
        .map((f) => path.relative(ROOT, f));
    assert.deepEqual(hits, [], `still naming ${OLD_HOST}:\n  ${hits.join('\n  ')}`);
});

test('§0 middleware and every Render-bound rewrite target the Singapore service', () => {
    assert.match(read('middleware.js'), new RegExp(`^const BACKEND = '${NEW_ORIGIN}';`, 'm'));
    const vercel = JSON.parse(read('vercel.json'));
    const renderBound = vercel.rewrites.filter((r) => /onrender\.com/.test(r.destination));
    // sitemap, sitemap-:path, robots, llms, 3 feeds, /p, /html/p, /product-by-name, /shop, /html/shop
    assert.ok(renderBound.length >= 12, `expected the full Render-bound rewrite set, got ${renderBound.length}`);
    for (const r of renderBound) {
        assert.ok(r.destination.startsWith(`${NEW_ORIGIN}/`), `${r.source} → ${r.destination}`);
    }
    const csp = vercel.headers.flatMap((h) => h.headers)
        .find((h) => h.key === 'Content-Security-Policy').value;
    const connect = csp.match(/connect-src ([^;]*)/)[1].split(/\s+/);
    assert.ok(connect.includes(NEW_ORIGIN), 'connect-src allows the non-production API origin');
});

test('§0 the four pre-Config mirrors of Config.API_URL agree on every host', () => {
    // config.js, pdp-prefetch.js, site-guard.js and traffic-tracker.js each carry
    // the same host rule because three of them run before config.js exists. A
    // mirror left on the old host would break only off-production — silently.
    const configExpr = read('js/config.js').match(/API_URL: (\(location\.hostname[\s\S]*?'),\n/)[1];
    const prefetch = read('js/pdp-prefetch.js').match(/function apiBase\(host\) \{[\s\S]*?\n {4}\}/)[0];
    const guardExpr = read('js/site-guard.js').match(/const BACKEND_URL = ([\s\S]*?);/)[1];
    const tracker = read('js/traffic-tracker.js').match(/function getApiUrl\(\) \{[\s\S]*?\n {4}\}/)[0];
    for (const hostname of ['www.inkcartridges.co.nz', 'inkcartridges.co.nz', 'localhost', 'feink.vercel.app']) {
        const ctx = { location: { hostname } };
        const want = vm.runInNewContext(configExpr, ctx);
        assert.equal(vm.runInNewContext(`${prefetch}; apiBase(${JSON.stringify(hostname)})`, {}), want, `pdp-prefetch @ ${hostname}`);
        assert.equal(vm.runInNewContext(guardExpr, ctx), want, `site-guard @ ${hostname}`);
        assert.equal(vm.runInNewContext(`${tracker}; getApiUrl()`, ctx), want, `traffic-tracker @ ${hostname}`);
    }
    assert.equal(vm.runInNewContext(configExpr, { location: { hostname: 'localhost' } }), NEW_ORIGIN);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4a site-guard reads the lock from the API, and still fails open
// ─────────────────────────────────────────────────────────────────────────────

function guardFn(name) {
    const src = read('js/site-guard.js');
    const m = src.match(new RegExp(`  async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
    assert.ok(m, `site-guard.js must define ${name}`);
    return m[0];
}

async function lockWith(fetchImpl) {
    const ctx = { BACKEND_URL: 'https://api.test', fetch: fetchImpl, calls: [] };
    return vm.runInNewContext(`${guardFn('getLockStatus')}; getLockStatus()`, ctx);
}

test('§4a the lock is read from GET /api/site/lock, anonymously, and never from site_settings', async () => {
    const src = stripComments(read('js/site-guard.js'));
    assert.doesNotMatch(src, /site_settings/, 'the direct Supabase read is gone');
    let seen;
    const got = await lockWith(async (url, opts) => {
        seen = { url, opts };
        return { ok: true, json: async () => ({ ok: true, data: { enabled: true, message: 'Back soon' } }) };
    });
    assert.equal(seen.url, 'https://api.test/api/site/lock');
    assert.equal(seen.opts.credentials, 'omit', 'anonymous ⇒ one shared edge-cache entry');
    assert.deepEqual({ ...got }, { enabled: true, message: 'Back soon' });
});

test('§4a every failure reads as UNLOCKED (fail-open, as the Supabase read was)', async () => {
    const cases = {
        'network error': async () => { throw new TypeError('Failed to fetch'); },
        '503': async () => ({ ok: false, status: 503, json: async () => ({}) }),
        'non-JSON body': async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }),
        'ok:false envelope': async () => ({ ok: true, json: async () => ({ ok: false, error: 'x' }) }),
        'no data': async () => ({ ok: true, json: async () => ({ ok: true }) }),
    };
    for (const [label, impl] of Object.entries(cases)) {
        assert.equal(await lockWith(impl), null, label);
    }
});

test('§4a PRESERVED (green before this change too): unlocked or no supabase-js ⇒ open; locked ⇒ overlay', async () => {
    const run = guardFn('run');
    const ctx = (lock, supabase) => ({
        location: { pathname: '/shop' },
        window: supabase ? { supabase } : {},
        getLockStatus: async () => lock,
        initClient: () => { throw new Error('initClient must not run'); },
        showOverlay: () => { ctx.shown = true; },
    });
    // Unlocked: returns before any client work (initClient would throw).
    const unlocked = ctx({ enabled: false }, null);
    await vm.runInNewContext(`${run}; run()`, unlocked);
    // Locked, but supabase-js failed to load: open, as before this change.
    const noSb = ctx({ enabled: true, message: 'x' }, null);
    noSb.showOverlay = () => { throw new Error('overlay must not show without supabase-js'); };
    await vm.runInNewContext(`${run}; run()`, noSb);
    // Locked with supabase-js and no admin session: the overlay shows.
    let shown = null;
    const locked = {
        location: { pathname: '/shop' },
        window: { supabase: { createClient() {} } },
        getLockStatus: async () => ({ enabled: true, message: 'Back soon' }),
        initClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
        isAdminSession: async () => false,
        showOverlay: (m) => { shown = m; },
    };
    await vm.runInNewContext(`${run}; run()`, locked);
    assert.equal(shown, 'Back soon');
});
