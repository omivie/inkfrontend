/**
 * ERR-400 — backend SEO handoff 26 Nov 2026 (`backend-docs/inbox/fe-handoff-seo-nov26-2026.md`).
 *
 * P0  The backend's prerender limit (30/min per IP) keys on the CRAWLER once the
 *     middleware proves itself with X-Prerender-Secret + X-Prerender-Client-IP.
 *     A backend 429 is an outage (503 + Retry-After), never the 200 shell.
 * P2  Trailing slash ⇒ 308 (vercel.json `trailingSlash: false`).
 * 32  Ink-finder logos carry their displayed size + WebP; cart/order thumbnails
 *     carry size + lazy; the staggered list fade is gone; the PDP hero still has
 *     NO width/height (ERR-374 measured CLS 0.30 with them).
 *
 * EXECUTES the real middleware (copied to .mjs, as middleware-slug-hop does)
 * with a stubbed fetch that plays the backend.
 *
 * Run: node --test tests/seo-handoff-nov26-2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
// SEO_NOV26_MIDDLEWARE lets the red-proof run this file against an older copy.
const SRC = fs.readFileSync(process.env.SEO_NOV26_MIDDLEWARE || path.join(INK, 'middleware.js'), 'utf8');
const BACKEND = 'https://ink-backend-sg.onrender.com';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const SECRET = 'a'.repeat(64);
const PDP = '/products/lc3313kcmy-compatible-ink-cartridge-for-brother-lc3313-kcmy-pack/CLC3313KCMY';

let fn = null;
let tmp = null;
async function middleware() {
    if (fn) return fn;
    tmp = path.join(os.tmpdir(), `ic-mw-seo-nov26-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, SRC);
    fn = (await import(`file://${tmp}`)).default;
    return fn;
}
test.after(() => { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); });

const req = (p, { ua = GOOGLEBOT, realIp = null, cfIp = null } = {}) => {
    const h = new Headers({ 'user-agent': ua });
    if (realIp) h.set('x-real-ip', realIp);
    if (cfIp) h.set('cf-connecting-ip', cfIp);
    return { url: `https://www.inkcartridges.co.nz${p}`, headers: h, method: 'GET' };
};

/**
 * Run with a fake backend. `answer(url)` returns the prerender Response; every
 * fetch is recorded with its headers. `secret` undefined ⇒ the env var is unset.
 */
async function run(p, { answer = () => new Response('<html></html>', { status: 200 }), secret, ...reqOpts } = {}) {
    const mw = await middleware();
    const seen = [];
    const originalFetch = globalThis.fetch;
    const hadSecret = Object.prototype.hasOwnProperty.call(process.env, 'PRERENDER_PROXY_SECRET');
    const oldSecret = process.env.PRERENDER_PROXY_SECRET;
    if (secret === undefined) delete process.env.PRERENDER_PROXY_SECRET;
    else process.env.PRERENDER_PROXY_SECRET = secret;
    globalThis.fetch = async (target, init = {}) => {
        const headers = new Headers(init.headers || {});
        seen.push({ url: String(target), headers });
        if (String(target).startsWith(`${BACKEND}/products/`)) return new Response('no', { status: 404 }); // slugHop: no hop
        return answer(String(target));
    };
    try {
        return { res: await mw(req(p, reqOpts)), seen };
    } finally {
        globalThis.fetch = originalFetch;
        if (hadSecret) process.env.PRERENDER_PROXY_SECRET = oldSecret;
        else delete process.env.PRERENDER_PROXY_SECRET;
    }
}
const prerenderCall = (seen) => seen.find((s) => s.url.startsWith(`${BACKEND}/api/prerender/`));

// ── P0 change 1: the two headers ────────────────────────────────────────────

test('P0: env var set ⇒ the prerender fetch carries the secret and the crawler IP', async () => {
    const { res, seen } = await run('/ink-cartridges', { secret: SECRET, realIp: '162.158.1.1', cfIp: '66.249.66.1' });
    const call = prerenderCall(seen);
    assert.ok(call, 'prerender was fetched');
    assert.equal(call.headers.get('x-prerender-secret'), SECRET);
    assert.equal(call.headers.get('x-prerender-client-ip'), '66.249.66.1');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-prerender-client'), 'forwarded', 'says the IP was forwarded');
    assert.equal(res.headers.get('x-prerender-secret'), null, 'the secret never goes back to the client');
});

test('P0: env var unset ⇒ neither header, and the answer says "shared"', async () => {
    const { res, seen } = await run('/ink-cartridges', { realIp: '162.158.1.1', cfIp: '66.249.66.1' });
    const call = prerenderCall(seen);
    assert.equal(call.headers.get('x-prerender-secret'), null);
    assert.equal(call.headers.get('x-prerender-client-ip'), null);
    assert.equal(res.headers.get('x-prerender-client'), 'shared');
});

test('P0: env var set but no client IP ⇒ neither header (never a half pair)', async () => {
    const { seen } = await run('/ink-cartridges', { secret: SECRET });
    const call = prerenderCall(seen);
    assert.equal(call.headers.get('x-prerender-secret'), null);
    assert.equal(call.headers.get('x-prerender-client-ip'), null);
});

test('P0: cf-connecting-ip is trusted ONLY when the connection came from Cloudflare', async () => {
    const ipFor = async (realIp, cfIp) => prerenderCall((await run('/ink-cartridges', { secret: SECRET, realIp, cfIp })).seen)
        .headers.get('x-prerender-client-ip');
    // The two cases the handoff names.
    assert.equal(await ipFor('162.158.1.1', '66.249.66.1'), '66.249.66.1', 'Cloudflare edge ⇒ the crawler');
    assert.equal(await ipFor('203.0.113.9', '66.249.66.1'), '203.0.113.9', 'not Cloudflare ⇒ the connecting IP, the fake header is ignored');
    // IPv6 Cloudflare edge (2606:4700::/32) and the /29 (2a06:98c0–98c7).
    assert.equal(await ipFor('2606:4700:10::ac43:1', '2001:4860:4801:10::1'), '2001:4860:4801:10::1');
    assert.equal(await ipFor('2a06:98c7::1', '66.249.66.1'), '66.249.66.1');
    assert.equal(await ipFor('2a06:98c8::1', '66.249.66.1'), '2a06:98c8::1', '98c8 is outside 2a06:98c0::/29');
    // CIDR edges: 104.16.0.0/13 = 104.16.0.0–104.23.255.255; 104.24.0.0/14 is its own range.
    assert.equal(await ipFor('104.23.255.255', '66.249.66.1'), '66.249.66.1');
    assert.equal(await ipFor('104.28.0.1', '66.249.66.1'), '104.28.0.1', '104.28 is outside every Cloudflare v4 range');
    assert.equal(await ipFor('172.71.255.255', '66.249.66.1'), '66.249.66.1', '172.64.0.0/13 upper edge');
    assert.equal(await ipFor('172.72.0.0', '66.249.66.1'), '172.72.0.0', 'one past 172.64.0.0/13');
    // Cloudflare edge but no cf-connecting-ip ⇒ fall back to the edge IP (the backend keys on it, as today).
    assert.equal(await ipFor('162.158.1.1', null), '162.158.1.1');
});

test('P0: the headers go to BACKEND only — the slug-hop fetch never carries them', async () => {
    const { seen } = await run(PDP, { secret: SECRET, realIp: '162.158.1.1', cfIp: '66.249.66.1' });
    const hop = seen.find((s) => s.url.startsWith(`${BACKEND}/products/`));
    assert.ok(hop, 'slug hop ran');
    assert.equal(hop.headers.get('x-prerender-secret'), null);
    assert.equal(hop.headers.get('x-prerender-client-ip'), null);
    for (const s of seen) {
        if (s.headers.get('x-prerender-secret')) assert.ok(s.url.startsWith(`${BACKEND}/api/prerender/`), s.url);
    }
});

test('P0: shoppers trigger no backend fetch at all (bot gate unchanged)', async () => {
    const { res, seen } = await run('/ink-cartridges', { ua: HUMAN, secret: SECRET, realIp: '162.158.1.1', cfIp: '66.249.66.1' });
    assert.equal(res, undefined);
    assert.deepEqual(seen, []);
});

test('P0: the secret is read via globalThis.process?.env — a missing `process` can never 503 every bot', () => {
    assert.match(SRC, /globalThis\.process\?\.env\?\.PRERENDER_PROXY_SECRET/);
    assert.doesNotMatch(SRC.replace(/globalThis\.process\?\.env/g, ''), /\bprocess\.env\b/);
    // Built before the try, so even a throw would surface instead of becoming prerenderUnavailable().
    const tryAt = SRC.indexOf('const response = await fetch(`${BACKEND}${prerenderPath}`');
    assert.ok(SRC.indexOf('const proxyHeaders = prerenderProxyHeaders(request);') < tryAt);
});

// ── P0 change 2: 429 is an outage ───────────────────────────────────────────

test('P0: backend 429 ⇒ 503 + Retry-After + no-store + noindex, never the 200 shell', async () => {
    const { res } = await run('/ink-cartridges', {
        secret: SECRET, realIp: '162.158.1.1', cfIp: '66.249.66.1',
        answer: () => new Response('Too many requests', { status: 429 }),
    });
    assert.ok(res, 'answered (did not fall through to the SPA shell)');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '120');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('x-prerender-client'), 'forwarded');
});

test('P0: a backend 404 still falls through; a 500 is still 503', async () => {
    const r404 = await run('/shop?brand=hp&printer_slug=zz-not-a-printer', { answer: () => new Response('no', { status: 404 }) });
    assert.equal(r404.res, undefined, '404 = an answer, the SPA renders not-found');
    const r500 = await run('/ink-cartridges', { answer: () => new Response('boom', { status: 500 }) });
    assert.equal(r500.res.status, 503);
    assert.equal(r500.res.headers.get('x-prerender-client'), 'shared');
});

// ── P2: trailing slash ──────────────────────────────────────────────────────

test('P2: vercel.json answers a trailing slash with a 308 (trailingSlash:false), cleanUrls kept', () => {
    const cfg = JSON.parse(read('vercel.json'));
    assert.equal(cfg.trailingSlash, false);
    assert.equal(cfg.cleanUrls, true);
});

// ── Item 32: images + first-screen fade ─────────────────────────────────────

const LOGOS = {
    brother: ['webp', 205, 48], canon: ['webp', 179, 39], epson: ['webp', 85, 21], hp: ['webp', 36, 36],
    samsung: ['svg', 137, 21], lexmark: ['webp', 122, 24], oki: ['svg', 56, 28], 'fuji-xerox': ['webp', 140, 28], kyocera: ['svg', 108, 24],
};

test('32: every ink-finder logo carries its displayed width/height, lazy + async, WebP for the raster ones', () => {
    for (const file of ['index.html', 'html/index.html', 'html/account/printers.html']) {
        const html = read(file);
        const tags = html.match(/<img\b[^>]*class="ink-finder__brand-img[^"]*"[^>]*>/g) || [];
        assert.equal(tags.length, 9, `${file}: nine finder logos`);
        for (const [brand, [ext, w, h]] of Object.entries(LOGOS)) {
            const tag = tags.find((t) => t.includes(`ink-finder__brand-img--${brand}"`));
            assert.ok(tag, `${file}: ${brand}`);
            assert.ok(tag.includes(`src="/assets/brands/${brand}.${ext}"`), `${file}: ${brand} src .${ext}`);
            assert.ok(tag.includes(`width="${w}" height="${h}"`), `${file}: ${brand} ${w}x${h}`);
            assert.ok(/loading="lazy"/.test(tag) && /decoding="async"/.test(tag), `${file}: ${brand} lazy/async`);
        }
    }
});

test('32: the WebP logos exist, are ≤ 5 KB, and the PNGs stay (shop-page.js + /api/images/optimize read them)', () => {
    for (const [brand, [ext]] of Object.entries(LOGOS)) {
        if (ext !== 'webp') continue;
        const size = fs.statSync(path.join(INK, 'assets/brands', `${brand}.webp`)).size;
        assert.ok(size <= 5 * 1024, `${brand}.webp is ${size} B`);
        assert.ok(fs.existsSync(path.join(INK, 'assets/brands', `${brand}.png`)), `${brand}.png kept`);
    }
});

test('32: .ink-finder__brand-img keeps width:auto — the attributes set the aspect ratio, not the size', () => {
    const css = read('css/pages.css');
    const rule = /\.ink-finder__brand-img \{([^}]*)\}/.exec(css);
    assert.ok(rule && /width:\s*auto/.test(rule[1]), 'without it the ≤600px heights get the attribute width (measured: epson 65→78, hp 28→36, oki 44→56)');
});

test('32: cart + order-detail thumbnails carry their box size, lazy + async', () => {
    const cart = read('js/cart.js');
    assert.equal((cart.match(/width="70" height="70" loading="lazy" decoding="async"/g) || []).length, 3);
    assert.match(read('js/order-detail-page.js'), /width="80" height="80" loading="lazy" decoding="async" data-fallback="placeholder"/);
    assert.match(read('js/product-detail-page.js'), /class="pack-upsell__thumb"[^>]*width="56" height="56" loading="lazy"/);
});

test('32: the PDP hero (LCP) is never lazy and still has NO width/height (ERR-374: 800x800 ⇒ CLS 0.30)', () => {
    const pdp = read('js/product-detail-page.js');
    const heroes = pdp.match(/<img [^>]*fetchpriority="high"[^>]*>/g) || [];
    assert.ok(heroes.length >= 2);
    for (const tag of heroes) {
        assert.doesNotMatch(tag, /loading="lazy"/);
        assert.doesNotMatch(tag, /\bwidth="\d+"|\bheight="\d+"/);
    }
});

test('32: no staggered list fade — product cards, cart and order lines paint at full opacity', () => {
    const js = read('js/modern-effects.js');
    const css = read('css/modern-effects.css');
    assert.doesNotMatch(js, /initStaggeredLists|staggerFadeIn|stagger-children/);
    assert.doesNotMatch(css, /\.stagger-children|@keyframes staggerFadeIn/);
});
