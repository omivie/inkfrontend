/**
 * FE-1 / FE-2 (Nov 2026) — the initial HTML every user agent receives.
 *
 * FE-1: a NON-bot GET on a prerender-routed URL gets the static shell with the
 * prerender's <title>, description, canonical, robots and H1 written in. Both
 * fetches are stubbed here; the shell is the REAL file from disk. Bots are
 * pinned to behave exactly as before (same Render URL, same headers).
 *
 * Run: node --test tests/seo-initial-html-nov2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const SRC = fs.readFileSync(path.join(ROOT, 'middleware.js'), 'utf8');
const SHOP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'shop.html'), 'utf8');
const PDP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'product', 'index.html'), 'utf8');
const SITE = 'https://www.inkcartridges.co.nz';
const API = 'https://api.inkcartridges.co.nz';
const RENDER = 'https://ink-backend-sg.onrender.com';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// ── loaders ──────────────────────────────────────────────────────────────────
let tmp = null;
let mw = null;
async function middleware() {
    if (mw) return mw;
    tmp = path.join(os.tmpdir(), `ic-mw-headinject-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, SRC);
    mw = (await import(`file://${tmp}`)).default;
    return mw;
}
test.after(() => { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); });

// The pure helpers sit between two markers and import nothing: evaluate just that block.
const block = SRC.slice(SRC.indexOf('// <head-inject>'), SRC.indexOf('// </head-inject>'));
const { extractPrerenderHead, injectHead } = new Function(`${block}\nreturn { extractPrerenderHead, injectHead };`)();

const prerenderPage = ({ title, description, canonical, h1, robots = 'index, follow, max-image-preview:large' }) =>
    `<!DOCTYPE html><html><head><title>${title}</title>`
    + (description ? `<meta name="description" content="${description}">` : '')
    + (canonical ? `<link rel="canonical" href="${canonical}">` : '')
    + (robots ? `<meta name="robots" content="${robots}">` : '')
    + `</head><body>${h1 ? `<h1>${h1}</h1>` : ''}<p>body</p></body></html>`;

// ── unit: extractor / injector ───────────────────────────────────────────────
test('extract: entity-escaped values come through verbatim (no unescape)', () => {
    const h = extractPrerenderHead(prerenderPage({
        title: 'Canon &amp; HP Ink | InkCartridges.co.nz', description: 'Save &quot;now&quot; $5 &amp; more',
        canonical: `${SITE}/shop?brand=hp&amp;code=1`, h1: 'Ink <em>NZ</em> &mdash; Genuine &amp; Compatible',
    }));
    assert.equal(h.title, 'Canon &amp; HP Ink | InkCartridges.co.nz');
    assert.equal(h.description, 'Save &quot;now&quot; $5 &amp; more');
    assert.equal(h.canonical, `${SITE}/shop?brand=hp&amp;code=1`);
    assert.equal(h.h1, 'Ink NZ &mdash; Genuine &amp; Compatible', 'tags stripped from the h1, entities kept');
    assert.equal(h.robots, 'index, follow, max-image-preview:large');
});

test('extract: missing parts are null, garbage in is safe', () => {
    assert.deepEqual(extractPrerenderHead(prerenderPage({ title: 'T', canonical: 'https://x/', robots: '' })),
        { title: 'T', description: null, canonical: 'https://x/', robots: null, h1: null });
    for (const bad of [null, undefined, '', 42]) assert.equal(extractPrerenderHead(bad).title, null);
});

const HEAD = { title: 'A &amp; B | Shop', description: 'Costs $1 &amp; $&', canonical: 'https://www.inkcartridges.co.nz/x', robots: null, h1: 'H &amp; 1' };

test('inject: shell title/description/canonical/h1 are replaced in place, escapes not doubled, `$` literal', () => {
    const r = injectHead(SHOP_SHELL, HEAD);
    assert.deepEqual(r.missing, []);
    assert.match(r.html, /<title>A &amp; B \| Shop<\/title>/);
    assert.ok(r.html.includes('<meta id="meta-description" name="description" content="Costs $1 &amp; $&">'), 'id kept, value verbatim');
    assert.equal((r.html.match(/rel="canonical"/g) || []).length, 1);
    assert.match(r.html, /<link id="canonical-url" rel="canonical" href="https:\/\/www\.inkcartridges\.co\.nz\/x">/);
    assert.match(r.html, /<h1 class="drilldown-title" id="drilldown-title">H &amp; 1<\/h1>/);
    assert.ok(!r.html.includes('&amp;amp;'));
    assert.ok(!r.html.includes('Shop Ink Cartridges & Toner NZ | InkCartridges'), 'old title gone');
});

test('inject: PDP shell (empty canonical href, skeleton h1, title id) is filled', () => {
    const r = injectHead(PDP_SHELL, HEAD);
    assert.deepEqual(r.missing, []);
    assert.match(r.html, /<title id="page-title">A &amp; B \| Shop<\/title>/);
    assert.match(r.html, /<link rel="canonical" id="canonical-url" href="https:\/\/www\.inkcartridges\.co\.nz\/x">/);
    assert.match(r.html, /id="product-title">H &amp; 1<\/h1>/);
});

test('inject: a DUPLICATE canonical in the shell collapses to exactly one', () => {
    const shell = '<html><head><title>t</title><link rel="canonical" href="a"><link rel="canonical" href="b"></head><body><h1>x</h1></body></html>';
    const r = injectHead(shell, HEAD);
    assert.equal((r.html.match(/rel="canonical"/g) || []).length, 1);
    assert.ok(r.html.includes('href="https://www.inkcartridges.co.nz/x"') && !r.html.includes('href="b"'));
});

test('inject: no shell canonical/description slot ⇒ one is ADDED; no h1 in prerender ⇒ reported missing, shell h1 kept', () => {
    const shell = '<html><head><title>t</title></head><body><h1>keep me</h1></body></html>';
    const r = injectHead(shell, { ...HEAD, h1: null });
    assert.equal((r.html.match(/rel="canonical"/g) || []).length, 1);
    assert.match(r.html, /<meta name="description" content="Costs \$1 &amp; \$&">/);
    assert.deepEqual(r.missing, ['h1']);
    assert.match(r.html, /<h1>keep me<\/h1>/);
});

test('inject: robots from the prerender replaces the shell robots; absent ⇒ shell robots untouched', () => {
    assert.match(injectHead(PDP_SHELL, { ...HEAD, robots: 'noindex' }).html, /<meta name="robots" content="noindex">/);
    assert.match(injectHead(PDP_SHELL, HEAD).html, /name="robots" content="index, follow, max-image-preview:large"/);
});

test('inject: a shell with no </head> is reported, not mangled', () => {
    const r = injectHead('<html><body>x</body></html>', HEAD);
    assert.equal(r.html, '<html><body>x</body></html>');
    assert.deepEqual(r.missing, ['shell-head']);
});

// ── integration: the middleware with fetch stubbed ───────────────────────────
const req = (p, ua = HUMAN, extra = {}) => ({
    url: `${SITE}${p}`,
    method: 'GET',
    headers: { get: (n) => { const k = String(n).toLowerCase(); return k === 'user-agent' ? ua : (extra[k] ?? null); } },
});

/**
 * `prerender(url)` plays api.inkcartridges.co.nz / the Render origin; the www host
 * plays the deployment and serves the real shell files, requiring the loop guard.
 */
async function run(p, { ua = HUMAN, prerender } = {}) {
    const m = await middleware();
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (target, init = {}) => {
        const u = String(target);
        calls.push({ url: u, init });
        if (u.startsWith(SITE)) {
            assert.equal(init.headers['x-ic-shell'], '1', 'self-fetch must carry the loop guard');
            const pdp = /^\/(products|product|p)\//.test(new URL(u).pathname) || /html\/product/.test(u);
            return new Response(pdp ? PDP_SHELL : SHOP_SHELL, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', 'Content-Length': '1', 'Content-Encoding': 'br' } });
        }
        return prerender(u, init);
    };
    try { return { res: await m(req(p, ua)), calls }; } finally { globalThis.fetch = original; }
}
const ok = (o) => () => new Response(prerenderPage(o), { status: 200, headers: { 'Content-Type': 'text/html' } });

const CASES = [
    ['/ink-cartridges', { title: 'Ink Cartridges NZ | InkCartridges.co.nz', description: 'Ink &amp; more', canonical: `${SITE}/ink-cartridges`, h1: 'Ink Cartridges NZ — Genuine &amp; Compatible' }, '/api/prerender/category/ink'],
    ['/shop?brand=brother', { title: 'Brother Ink &amp; Toner NZ', description: 'Brother', canonical: `${SITE}/shop?brand=brother`, h1: 'Brother Ink &amp; Toner NZ' }, '/api/prerender/brand/brother'],
    ['/shop?brand=canon&code=PG645', { title: 'Canon PG645 Ink NZ', description: 'PG645 desc', canonical: `${SITE}/shop?brand=canon&amp;code=PG645`, h1: 'Canon PG645 Ink Cartridges' }, '/api/prerender/brand/canon?code=PG645'],
    ['/shop?brand=hp&printer_slug=hp-officejet-pro-9010', { title: 'HP OfficeJet Pro 9010 Ink NZ', description: 'HP 9010', canonical: `${SITE}/shop?brand=hp&amp;printer_slug=hp-officejet-pro-9010`, h1: 'HP OfficeJet Pro 9010 Ink' }, '/api/prerender/printer/hp/hp-officejet-pro-9010'],
    ['/products/some-slug/SKU1', { title: 'SKU1 Ink | InkCartridges.co.nz', description: 'SKU1 desc', canonical: `${SITE}/products/some-slug/SKU1`, h1: 'SKU1 Compatible Cartridge' }, '/api/prerender/product/SKU1'],
];

for (const [p, page, want] of CASES) {
    test(`human ${p}: head + h1 injected from the cached API host; exactly one canonical`, async () => {
        const { res, calls } = await run(p, { prerender: ok(page) });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-head-inject'), 'ok');
        const html = await res.text();
        assert.ok(html.includes(`<title>${page.title}</title>`) || html.includes(`>${page.title}</title>`), 'title');
        assert.ok(html.includes(`content="${page.description}"`), 'description');
        assert.ok(html.includes(`href="${page.canonical}"`), 'canonical');
        assert.equal((html.match(/rel="canonical"/g) || []).length, 1, 'one canonical');
        assert.ok(html.includes(`>${page.h1}</h1>`), 'h1');
        assert.ok(calls.some((c) => c.url === `${API}${want}`), `fetched ${API}${want}`);
        assert.ok(calls.every((c) => !c.url.startsWith(RENDER)), 'never the Render origin');
        const pre = calls.find((c) => c.url.startsWith(API));
        assert.equal(pre.init.redirect, 'manual');
        assert.ok(pre.init.signal, 'timeout signal');
        assert.equal(res.headers.get('content-length'), null);
        assert.equal(res.headers.get('content-encoding'), null);
        assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    });
}

test('human: prerender timeout / 500 / 404 / garbage ⇒ the untouched shell + a miss header', async () => {
    const shell = (p) => (/^\/products/.test(p) ? PDP_SHELL : SHOP_SHELL);
    const cases = [
        ['timeout', () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'miss-timeout'],
        ['network', () => { throw new Error('boom'); }, 'miss-fetch-error'],
        ['500', () => new Response('x', { status: 500 }), 'miss-status-500'],
        ['301', () => new Response(null, { status: 301, headers: { Location: '/x' } }), 'miss-status-301'],
        ['garbage', () => new Response('<html>no head</html>', { status: 200 }), 'miss-parse'],
    ];
    for (const p of ['/ink-cartridges', '/products/x/SKU1']) {
        for (const [name, prerender, header] of cases) {
            const { res } = await run(p, { prerender });
            assert.equal(res.status, 200, `${p} ${name}`);
            assert.equal(res.headers.get('x-head-inject'), header, `${p} ${name}`);
            assert.equal(await res.text(), shell(p), `${p} ${name}: shell byte-identical`);
        }
    }
});

test('human: a category 404 is NOT a not-found (only printer/product are) — shell + miss header', async () => {
    const { res } = await run('/ink-cartridges', { prerender: () => new Response('x', { status: 404 }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-head-inject'), 'miss-status-404');
});

// ── FE-2: no indexable 200 for a nonexistent printer / product ───────────────
const NF = [
    ['/shop?brand=hp&printer_slug=zz-not-a-printer', '/api/prerender/printer/hp/zz-not-a-printer', SHOP_SHELL],
    ['/products/zz/NOSUCHSKU', '/api/prerender/product/NOSUCHSKU', PDP_SHELL],
    ['/product/zz-not-a-slug', '/api/prerender/product-by-slug/zz-not-a-slug', PDP_SHELL],
    ['/p/NOSUCHSKU', '/api/prerender/product/NOSUCHSKU', null],
    ['/html/product?sku=NOSUCHSKU', '/api/prerender/product/NOSUCHSKU', PDP_SHELL],
];
for (const [ua, who] of [[HUMAN, 'human'], [GOOGLEBOT, 'bot']]) {
    for (const [p, pre, shell] of NF) {
        test(`${who} ${p}: backend 404 ⇒ HTTP 404 + noindex (body + header)`, async () => {
            const { res, calls } = await run(p, { ua, prerender: () => new Response('nf', { status: 404 }) });
            assert.equal(res.status, 404);
            assert.equal(res.headers.get('x-robots-tag'), 'noindex');
            const html = await res.text();
            assert.match(html, /<meta name="robots" content="noindex">/);
            assert.equal((html.match(/name="robots"/g) || []).length, 1, 'one robots tag');
            assert.ok(!/content="index/.test(html), 'no indexable robots left');
            if (shell && /\/shop|product/.test(p)) assert.ok(html.includes('<body'), 'body is the shell (SPA not-found UI)');
            const host = who === 'bot' ? RENDER : API;
            assert.ok(calls.some((c) => c.url === `${host}${pre}`));
        });
    }
}

test('5xx / timeout on a printer or product is NEVER a 404: 503 for bots, the plain shell for humans', async () => {
    for (const p of [NF[0][0], NF[1][0]]) {
        for (const prerender of [() => new Response('x', { status: 503 }), () => { throw new Error('boom'); }]) {
            const bot = await run(p, { ua: GOOGLEBOT, prerender });
            assert.equal(bot.res.status, 503, p);
            const human = await run(p, { prerender });
            assert.equal(human.res.status, 200, p);
            assert.match(human.res.headers.get('x-head-inject'), /^miss-/);
            assert.equal(human.res.headers.get('x-robots-tag'), null);
        }
    }
});

test('unknown BRAND keeps today\'s fallthrough: bot → undefined, human → shell 200 (never a 404)', async () => {
    const bot = await run('/shop?brand=okin&category=receipt&code=X', { ua: GOOGLEBOT, prerender: () => new Response('nf', { status: 404 }) });
    assert.equal(bot.res, undefined);
    const human = await run('/shop?brand=zz-nobrand', { prerender: () => new Response('nf', { status: 404 }) });
    assert.equal(human.res.status, 200);
    assert.equal(human.res.headers.get('x-head-inject'), 'miss-status-404');
});

test('bot 404 with the shell unreachable still answers 404 + noindex (status is what matters)', async () => {
    const m = await middleware();
    const original = globalThis.fetch;
    globalThis.fetch = async (t) => (String(t).startsWith(SITE) ? Promise.reject(new Error('down')) : new Response('nf', { status: 404 }));
    try {
        const res = await m(req(NF[0][0], GOOGLEBOT));
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('x-robots-tag'), 'noindex');
        assert.match(await res.text(), /noindex/);
    } finally { globalThis.fetch = original; }
});

test('noindexShell: replaces the shell robots in place, adds one when absent', () => {
    const f = new Function(`${block}\nreturn noindexShell;`)();
    assert.equal(f('<head><meta name="robots" content="index, follow"></head>'), '<head><meta name="robots" content="noindex"></head>');
    assert.equal(f('<head><title>t</title></head>'), '<head><title>t</title><meta name="robots" content="noindex">\n</head>');
});

test('human: unrouted paths and non-GET fall through exactly as before (undefined, no fetch)', async () => {
    for (const p of ['/shop?brand=hp&category=ink&q=zz', '/products', '/shop?q=abc']) {
        const { res, calls } = await run(p, { prerender: ok(CASES[0][1]) });
        if (res === undefined) assert.equal(calls.length, 0, p);
    }
    const m = await middleware();
    assert.equal(await m({ ...req('/ink-cartridges'), method: 'POST' }), undefined);
});

test('loop guard: a request carrying x-ic-shell returns undefined immediately, never fetches', async () => {
    const m = await middleware();
    const original = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => { n++; return new Response('x'); };
    try {
        assert.equal(await m(req('/ink-cartridges', HUMAN, { 'x-ic-shell': '1' })), undefined);
        assert.equal(await m(req('/ink-cartridges', GOOGLEBOT, { 'x-ic-shell': '1' })), undefined);
    } finally { globalThis.fetch = original; }
    assert.equal(n, 0);
});

test('guard does not open the denylist or the admin gate', async () => {
    const m = await middleware();
    assert.equal((await m(req('/sql/x.sql', HUMAN, { 'x-ic-shell': '1' }))).status, 404);
    assert.equal((await m(req('/admin/x', HUMAN, { 'x-ic-shell': '1' }))).status, 302);
    assert.equal((await m(req('/shop?category=junk', HUMAN, { 'x-ic-shell': '1' }))).status, 301);
});

test('bot on a valid page: unchanged — Render origin, same headers, prerender body, no shell fetch', async () => {
    const { res, calls } = await run('/shop?brand=canon&code=PG645', { ua: GOOGLEBOT, prerender: ok(CASES[2][1]) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${RENDER}/api/prerender/brand/canon?code=PG645`);
    assert.equal(calls[0].init.headers['User-Agent'], GOOGLEBOT);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-prerendered'), 'true');
    assert.equal(res.headers.get('x-head-inject'), null);
    assert.equal(res.headers.get('cache-control'), 'public, s-maxage=3600, max-age=3600, stale-while-revalidate=86400');
    assert.match(await res.text(), /Canon PG645 Ink Cartridges/);
});

test('client parity: seo-meta.js reconcile() only SETS the prerender values (idempotent over the injected ones)', () => {
    const seo = fs.readFileSync(path.join(ROOT, 'js', 'seo-meta.js'), 'utf8');
    const rec = seo.slice(seo.indexOf('async reconcile('), seo.indexOf('h1For(prerenderPath)'));
    assert.ok(/_setTitle\(head\.title\)/.test(rec) && /_setDescription\(head\.description\)/.test(rec));
    assert.ok(!/appendChild|insertAdjacent|createElement\('link'\)/.test(rec), 'reconcile never adds a second tag');
    const set = seo.slice(seo.indexOf('_setH1(text'), seo.indexOf('// ── public entry point'));
    assert.match(set, /el\.textContent = text/);
});

test('human /: head fields injected, but the styled hero H1 is left untouched', async () => {
    const page = { title: 'Ink Cartridges NZ | Home', description: 'Home desc', canonical: `${SITE}/`, h1: 'Plain prerender H1' };
    const { res } = await run('/', { prerender: ok(page) });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`content="${page.description}"`), 'description');
    assert.ok(!html.includes(page.h1), 'prerender H1 must not replace the hero');
    assert.match(res.headers.get('x-head-inject'), /^ok/);
});
