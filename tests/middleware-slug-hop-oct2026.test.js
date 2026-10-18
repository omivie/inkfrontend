/**
 * ERR-365 — a crawler on an OLD pack address gets a hard 301 to the new one
 * (backend response 2026-10-17, "Pack names" ask 2: 826 renamed slugs, each
 * with a `slug_redirects` hop; www used to answer 200 + new canonical).
 *
 * EXECUTES the real middleware (copied to .mjs, as chip-prerender does) with a
 * stubbed fetch that plays the backend. The guard cases are the measured ones:
 * the backend's hop endpoint 301s a CURRENT slug to a search page (2026-10-18),
 * so only a 301 to /products/<other slug>/<same SKU> may be followed.
 *
 * Run: node --test tests/middleware-slug-hop-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'middleware.js'), 'utf8');
const BACKEND = 'https://ink-backend-sg.onrender.com';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const OLD = '/products/lc3313kcmy-compatible-ink-cartridge-for-brother-lc3313-kcmy-4-pack/CLC3313KCMY';
const NEW = '/products/lc3313kcmy-compatible-ink-cartridge-for-brother-lc3313-kcmy-pack/CLC3313KCMY';

let fn = null;
let tmp = null;
async function middleware() {
    if (fn) return fn;
    tmp = path.join(os.tmpdir(), `ic-mw-slughop-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, SRC);
    fn = (await import(`file://${tmp}`)).default;
    return fn;
}
test.after(() => { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); });

const req = (p, ua = GOOGLEBOT) => ({
    url: `https://www.inkcartridges.co.nz${p}`,
    headers: { get: (n) => (String(n).toLowerCase() === 'user-agent' ? ua : null) },
});

/** Run with a fake backend: `hop(url)` answers the slug lookup, the prerender is a 200 page. */
async function run(p, hop, ua) {
    const mw = await middleware();
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (target) => {
        const u = String(target);
        seen.push(u);
        if (u.startsWith(`${BACKEND}/products/`)) return hop(u);
        return new Response('<html><title>pdp</title></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    };
    try { return { res: await mw(req(p, ua)), seen }; } finally { globalThis.fetch = original; }
}
const redirect = (location, status = 301) => new Response(null, { status, headers: { Location: location } });

test('old pack slug ⇒ our 301 to the new address (same SKU)', async () => {
    const { res, seen } = await run(OLD, () => redirect(`https://www.inkcartridges.co.nz${NEW}`));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), `https://www.inkcartridges.co.nz${NEW}`);
    assert.equal(res.headers.get('x-slug-redirect'), 'true');
    assert.ok(seen.includes(`${BACKEND}${OLD}`), 'asked the backend about THIS address');
    assert.ok(seen.some((u) => u.endsWith('/api/prerender/product/CLC3313KCMY')), 'prerender ran in parallel');
});

test('current slug: the hop endpoint 301s to a SEARCH page (measured) ⇒ ignored, prerender 200', async () => {
    const { res } = await run(NEW, () => redirect('https://www.inkcartridges.co.nz/shop?search=Products%2Flc3313kcmy%20for%20brother'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-prerendered'), 'true');
});

test('a 301 to ANOTHER SKU, to itself, to a foreign host, or a non-301 is never followed', async () => {
    for (const [label, answer] of [
        ['other SKU', () => redirect('https://www.inkcartridges.co.nz/products/x-pack/GLC3313KCMY')],
        ['itself', () => redirect(`https://www.inkcartridges.co.nz${OLD}`)],
        ['foreign host', () => redirect(`https://evil.example${NEW}`)],
        ['200', () => new Response('ok', { status: 200 })],
        ['404', () => new Response('no', { status: 404 })],
        ['302', () => redirect(`https://www.inkcartridges.co.nz${NEW}`, 302)],
        ['no Location', () => new Response(null, { status: 301 })],
        ['network error', () => { throw new TypeError('fetch failed'); }],
    ]) {
        const { res } = await run(OLD, answer);
        assert.equal(res.status, 200, `${label} ⇒ the prerender answers as before`);
    }
});

test('shoppers never pay for the lookup (bots only)', async () => {
    const { res, seen } = await run(OLD, () => redirect(`https://www.inkcartridges.co.nz${NEW}`), HUMAN);
    assert.equal(res, undefined, 'falls through to the SPA');
    assert.deepEqual(seen, []);
});

test('only /products/<slug>/<SKU> asks; /p/<sku> and /html/product do not', async () => {
    for (const p of ['/p/CLC3313KCMY', '/html/product?sku=CLC3313KCMY']) {
        const { seen } = await run(p, () => redirect(`https://www.inkcartridges.co.nz${NEW}`));
        assert.ok(!seen.some((u) => u.startsWith(`${BACKEND}/products/`)), p);
    }
});
