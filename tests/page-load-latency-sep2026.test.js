/**
 * Page-load latency — backend handoff 2026-09-21 (ERR-282 → ERR-285)
 * ====================================================================
 *
 * The backend measured where a first-time visitor's page load goes and found
 * it in ROUND TRIPS, not in HTML or queries. Each item below was re-verified
 * live on 2026-09-25 before it was changed; two of the handoff's premises were
 * wrong as written and are pinned here the way they were corrected.
 *
 *   §1 ERR-282  Content-Type only when there is a body. `application/json` is
 *               not CORS-safelisted, so on a bodyless GET it made every
 *               catalogue read preflight to the Render origin.
 *   §2 ERR-282  Static cache. The handoff asked for `immutable` on
 *               /(css|js|assets)/* "because the URLs are hash-versioned". They
 *               are NOT all versioned: ~114 admin modules load by bare import,
 *               three lazy imports carry a hand-bumped APP_VERSION, and
 *               traffic-tracker.js is injected with no token. So `immutable`
 *               applies ONLY to a URL whose `?v=` is a deploy-stamped 8-hex md5.
 *   §3 ERR-284  /shop brand-tile counts: ten requests that painted nothing
 *               (the code read `data.count`; the endpoint has never sent it).
 *               Now ONE `?brands=` request, summed per tile.
 *   §4 ERR-285  The traffic beacon's fallback host. gtag.js injects the tracker
 *               before config.js runs, so the fallback IS the production path.
 *   §5 ERR-283  site-guard's admin verify was a relative /api path on www
 *               (404) — the owner could not get past their own site lock.
 *               (The source-wide guard lives in api-subdomain-cutover §5.)
 *
 * Every behavioural test runs the SHIPPED code (vm or extracted function),
 * never a replica. Red-proof: each section fails against HEAD~ of its file.
 *
 * Run with: node --test tests/page-load-latency-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ICR, p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// §1 Content-Type only when there is a body (ERR-282)
// ─────────────────────────────────────────────────────────────────────────────

function loadApi() {
    const calls = [];
    const sandbox = {
        console, setTimeout, clearTimeout, AbortController, URL, URLSearchParams,
        Headers: globalThis.Headers,
        fetch: async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true, status: 200,
                headers: { get: () => null },
                async json() { return { ok: true, data: { sku: 'X1', name: 'x' } }; },
                async text() { return '{"ok":true}'; },
            };
        },
        Config: { API_URL: 'https://backend.test', SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'k' },
        DebugLog: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { cookie: '' },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('js/api.js'), sandbox, { filename: 'api.js' });
    return { API: sandbox.API, calls };
}

const contentType = (call) => {
    const h = call.opts.headers || {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === 'content-type');
    return key ? h[key] : undefined;
};

test('§1 a bodyless GET through request() sends NO Content-Type (anonymous and authed paths)', async () => {
    const { API, calls } = loadApi();
    await API.getPublic('/api/products?brand=hp');
    await API.get('/api/user/profile');
    assert.equal(calls.length, 2, 'both reads must reach fetch');
    for (const c of calls) {
        assert.equal(contentType(c), undefined,
            `${c.url} carried Content-Type on a bodyless GET — that makes it non-simple and costs an OPTIONS round trip per distinct URL`);
    }
});

test('§1 positive control: every body-carrying verb still sends application/json', async () => {
    const { API, calls } = loadApi();
    await API.post('/api/cart/items', { sku: 'X1', quantity: 1 });
    await API.put('/api/user/profile', { first_name: 'a' });
    await API.patch('/api/user/profile', { first_name: 'b' });
    assert.equal(calls.length, 3);
    for (const c of calls) {
        assert.equal(contentType(c), 'application/json',
            `${c.opts.method} ${c.url} lost its Content-Type — the backend JSON parser would see an empty body`);
        assert.equal(typeof c.opts.body, 'string');
    }
});

test('§1 the PDP product read (_rawJsonFetch) is a CORS-simple GET', async () => {
    const { API, calls } = loadApi();
    await API._rawJsonFetch('/api/products/X1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, 'GET');
    assert.equal(contentType(calls[0]), undefined,
        'the PDP pays a preflight before its product read if this GET carries Content-Type');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 Static cache: immutable ONLY for a deploy-stamped content hash (ERR-282)
// ─────────────────────────────────────────────────────────────────────────────

const VERCEL = JSON.parse(read('vercel.json'));
const HASH_COND = { type: 'query', key: 'v', value: '^[0-9a-f]{8}$' };
const HASH_RE = new RegExp(HASH_COND.value);
const cacheControl = (rule) => (rule.headers.find((h) => h.key === 'Cache-Control') || {}).value;

for (const dir of ['js', 'css']) {
    test(`§2 /${dir}: a hashed ?v= URL is immutable, every other URL revalidates, and the two rules are exclusive`, () => {
        const rules = VERCEL.headers.filter((r) => r.source === `/${dir}/(.*)`);
        assert.equal(rules.length, 2, `/${dir} must have exactly the hashed and the unhashed rule`);
        const hashed = rules.find((r) => r.has);
        const bare = rules.find((r) => r.missing);
        assert.ok(hashed && bare, 'one rule must use `has`, the other `missing`');
        assert.deepEqual(hashed.has, [HASH_COND]);
        assert.deepEqual(bare.missing, [HASH_COND],
            'the two conditions must be IDENTICAL — any gap is a URL both or neither rule claims');
        assert.equal(cacheControl(hashed), 'public, max-age=31536000, immutable');
        assert.match(cacheControl(bare), /max-age=0/);
        assert.match(cacheControl(bare), /must-revalidate/);
    });
}

test('§2 the hash condition matches what stamp-versions.js writes, and real tokens in live HTML', () => {
    assert.match(fs.readFileSync(path.join(ICR, 'scripts', 'stamp-versions.js'), 'utf8'),
        /digest\('hex'\)\.slice\(0, 8\)/,
        'the deploy stamp must still be the 8-hex md5 prefix the vercel.json condition matches');
    const html = read('html/shop.html');
    const tokens = [...html.matchAll(/\/(?:js|css)\/[^"?]+\?v=([^"&]+)"/g)].map((m) => m[1]);
    assert.ok(tokens.length > 10, 'positive control: shop.html must carry stamped tokens');
    for (const t of tokens) assert.match(t, HASH_RE, `stamped token ${t} would not be served immutable`);
});

test('§2 NO hand-maintained version token can ever look like a content hash', () => {
    // A hand-bumped APP_VERSION that happened to be 8 hex digits — a date like
    // '20261001' IS — would be served immutable and pinned in every admin's
    // browser for a year, even after the next bump... to a URL it then shares.
    const consts = [
        ['js/admin/app.js', 'APP_VERSION'],
        ['js/admin/pages/control-center.js', 'CC_VERSION'],
        ['js/admin/pages/settings.js', 'SETTINGS_VERSION'],
    ];
    for (const [file, name] of consts) {
        const m = read(file).match(new RegExp(`const ${name} = '([^']+)'`));
        assert.ok(m, `${file} must still declare ${name}`);
        assert.doesNotMatch(m[1], HASH_RE,
            `${name} = '${m[1]}' is 8 hex characters — vercel.json would serve it immutable; add a non-hex character`);
    }
    // And no literal `?v=<8 hex>` may be written into any JS file: only the
    // deploy stamp, which rewrites HTML, is allowed to mint one.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
    const offenders = walk(path.join(ICR, 'js')).filter((f) => /\?v=[0-9a-f]{8}(?![0-9A-Za-z_-])/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => path.relative(ICR, f)), []);
});

test('§2 unversioned /assets and root icons get a bounded cache, never immutable; HTML untouched', () => {
    const assets = VERCEL.headers.find((r) => r.source === '/assets/(.*)');
    assert.ok(assets, '/assets must declare a cache rule');
    assert.equal(cacheControl(assets), 'public, max-age=86400');
    const icons = VERCEL.headers.find((r) => /apple-touch-icon/.test(r.source));
    assert.ok(icons && /favicon\.png/.test(icons.source));
    assert.equal(cacheControl(icons), 'public, max-age=86400');
    const root = VERCEL.headers.find((r) => r.source === '/');
    assert.match(cacheControl(root), /max-age=0, must-revalidate/, 'HTML documents must keep revalidating');
    for (const r of VERCEL.headers) {
        if (/immutable/.test(cacheControl(r) || '')) {
            assert.ok(r.has, `${r.source} is immutable without a content-hash condition`);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 /shop brand-tile counts: one batched request (ERR-284)
// ─────────────────────────────────────────────────────────────────────────────

function loadBrandCounts() {
    const src = read('js/shop-page.js');
    const start = src.indexOf('async _loadBrandCounts(brands) {');
    const end = src.indexOf('async renderRibbonBrands()', start);
    assert.ok(start > 0 && end > start, '_loadBrandCounts must exist in shop-page.js');
    const body = src.slice(start, end).trim().replace(/,\s*$/, '');
    return (api) => {
        const tiles = {};
        const grid = { querySelector: (sel) => {
            const id = sel.match(/data-count="([^"]+)"/)[1];
            return (tiles[id] = tiles[id] || { textContent: '' });
        } };
        const obj = vm.runInNewContext(`({ ${body} })`, { API: api, CSS: { escape: (s) => s }, Number, Object, Set });
        obj.elements = { brandsGrid: grid };
        return { run: (brands) => obj._loadBrandCounts(brands), tiles };
    };
}

test('§3 ten brands cost ONE request, with sorted slugs, and each tile shows its summed count', async () => {
    const calls = [];
    const api = { getProductCounts: async (p) => {
        calls.push(p);
        return { ok: true, data: { hp: { ink: 385, toner: 433, drums: 32, paper: 7 }, epson: { ink: 317, paper: 23, ribbon: 32 } },
            meta: { unknown_brands: ['zz'] } };
    } };
    const { run, tiles } = loadBrandCounts()(api);
    await run([{ slug: 'hp' }, { slug: 'epson' }, { slug: 'zz' }, { slug: 'hp' }]);
    assert.equal(calls.length, 1, 'one request per ≤30 brands, not one per brand');
    assert.equal(calls[0].brands, 'epson,hp,zz', 'slugs must be de-duplicated and sorted so the URL is one edge-cache key');
    assert.equal(tiles.hp.textContent, '857 products');
    assert.equal(tiles.epson.textContent, '372 products');
    assert.equal(tiles.zz, undefined, 'an unknown brand stays BLANK — never "0 products"');
});

test('§3 a `total` key wins over summing (no double count); a 1 is singular', async () => {
    const api = { getProductCounts: async () => ({ ok: true, data: { a: { ink: 1, toner: 2, total: 3 }, b: { ink: 1 } } }) };
    const { run, tiles } = loadBrandCounts()(api);
    await run([{ slug: 'a' }, { slug: 'b' }]);
    assert.equal(tiles.a.textContent, '3 products');
    assert.equal(tiles.b.textContent, '1 product');
});

test('§3 a failed, rate-limited or thrown request leaves every tile blank and never throws', async () => {
    for (const impl of [
        async () => ({ ok: false, code: 'RATE_LIMITED' }),
        async () => { throw new Error('network'); },
        async () => ({ ok: true, data: null }),
    ]) {
        const { run, tiles } = loadBrandCounts()({ getProductCounts: impl });
        await run([{ slug: 'hp' }]);
        assert.deepEqual(tiles, {});
    }
});

test('§3 more than 30 brands are chunked at the backend cap of 30', async () => {
    const calls = [];
    const api = { getProductCounts: async (p) => { calls.push(p.brands.split(',').length); return { ok: true, data: {} }; } };
    const { run } = loadBrandCounts()(api);
    await run(Array.from({ length: 61 }, (_, i) => ({ slug: `b${String(i).padStart(2, '0')}` })));
    assert.deepEqual(calls, [30, 30, 1]);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 traffic beacon host when config.js has not run yet (ERR-285)
// ─────────────────────────────────────────────────────────────────────────────

function trackerApiUrl(hostname, Config) {
    const src = read('js/traffic-tracker.js');
    const m = src.match(/function getApiUrl\(\) \{[\s\S]*?\n {4}\}/);
    assert.ok(m, 'getApiUrl must exist in traffic-tracker.js');
    const ctx = { location: { hostname } };
    if (Config) ctx.Config = Config;
    return vm.runInNewContext(`${m[0]}; getApiUrl()`, ctx);
}

test('§4 production beacon goes through Cloudflare even when Config is not defined yet', () => {
    assert.equal(trackerApiUrl('www.inkcartridges.co.nz'), 'https://api.inkcartridges.co.nz');
    assert.equal(trackerApiUrl('inkcartridges.co.nz'), 'https://api.inkcartridges.co.nz');
    assert.equal(trackerApiUrl('feink-preview.vercel.app'), 'https://ink-backend-zaeq.onrender.com');
    assert.equal(trackerApiUrl('www.inkcartridges.co.nz', { API_URL: 'https://c.test' }), 'https://c.test',
        'Config, once loaded, is still the source of truth');
});

test('§4 the race is real: gtag.js (which injects the tracker) runs before the deferred config.js', () => {
    const html = read('html/shop.html');
    assert.match(html, /<script src="\/js\/gtag\.js\?v=[^"]+"><\/script>/, 'gtag.js is a sync head script');
    assert.match(html, /<script defer src="\/js\/config\.js\?v=/, 'config.js is deferred');
    assert.ok(html.indexOf('/js/gtag.js') < html.indexOf('/js/config.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 site-guard admin verify reaches the API host on production (ERR-283)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 site-guard BACKEND_URL is the api subdomain on www/apex, never a relative path', () => {
    const m = read('js/site-guard.js').match(/const BACKEND_URL = ([\s\S]*?);/);
    assert.ok(m);
    const at = (hostname) => vm.runInNewContext(m[1], { location: { hostname } });
    assert.equal(at('www.inkcartridges.co.nz'), 'https://api.inkcartridges.co.nz');
    assert.equal(at('inkcartridges.co.nz'), 'https://api.inkcartridges.co.nz');
    assert.equal(at('localhost'), 'https://ink-backend-zaeq.onrender.com');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 pages.css carries no statically dead rules (latency follow-up, 2026-09-25)
// ─────────────────────────────────────────────────────────────────────────────
//
// 473 rules (65.7KB raw) that no HTML or JS file could ever match were deleted
// from the render-blocking pages.css. This keeps it that way: a rule whose
// class/id appears nowhere in the web root — not literally, not as a fragment of
// a class the JS builds — fails here. Remove the CSS in the same change that
// removes the markup. The audit is conservative by construction (see its
// header); a false "dead" is a bug in the audit, not a reason to skip this.

test('§6 pages.css has zero statically dead rules', () => {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-css-coverage.mjs'), '--no-browser', '--list'],
        { encoding: 'utf8', env: { ...process.env, HOME: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'css-audit-')) } });
    const m = out.match(/STATIC DEAD \(can never match\): (\d+) rules/);
    assert.ok(m, 'the audit must print its STATIC DEAD line — an audit that printed nothing checked nothing');
    assert.equal(Number(m[1]), 0, `dead rules in pages.css:\n${out.split('\n').filter((l) => l.startsWith('  dead')).join('\n')}`);
});
