/**
 * FE-4 (Nov 2026) — JSON-LD parity: the human path copies the prerender's
 * ld+json blocks byte-for-byte into the shell head, one block per @type.
 *
 * Run: node --test tests/seo-jsonld-parity-nov2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const SRC = fs.readFileSync(path.join(ROOT, 'middleware.js'), 'utf8');
const HOME_SHELL = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHOP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'shop.html'), 'utf8');
const PDP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'product', 'index.html'), 'utf8');
const SITE = 'https://www.inkcartridges.co.nz';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const block = SRC.slice(SRC.indexOf('// <head-inject>'), SRC.indexOf('// </head-inject>'));
const { injectLdJson } = new Function(`${block}\nreturn { injectLdJson };`)();

let tmp = null;
let mw = null;
async function middleware() {
    if (mw) return mw;
    tmp = path.join(os.tmpdir(), `ic-mw-ldjson-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmp, SRC);
    mw = (await import(`file://${tmp}`)).default;
    return mw;
}
test.after(() => { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); });

// Byte-exact bodies, with odd whitespace on purpose: a re-serialise would change them.
const body = (o, pad = '\n  ') => `${pad}${JSON.stringify(o, null, 1).replace(/\n/g, pad)}${pad}`;
const LD = {
    Organization: { '@context': 'https://schema.org', '@type': 'Organization', name: 'PRE-ORG' },
    WebSite: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'PRE-SITE' },
    LocalBusiness: { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'PRE-LB' },
    CollectionPage: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'PRE-CP' },
    BreadcrumbList: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
    FAQPage: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] },
    Product: { '@context': 'https://schema.org', '@type': 'Product', name: 'PRE-P', offers: { price: '34.99' } },
    ProductGroup: { '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'PRE-PG' },
};
const bodies = Object.fromEntries(Object.entries(LD).map(([k, v], i) => [k, body(v, i % 2 ? '\n    ' : '\n  ')]));
const tag = (t, extra = '') => `<script type="application/ld+json"${extra}>${bodies[t]}</script>`;
const page = (types, extra = '') => `<!DOCTYPE html><html><head><title>T</title><link rel="canonical" href="${SITE}/x"></head><body><h1>H</h1>${types.map((t) => tag(t)).join('\n')}${extra}</body></html>`;
// ld blocks of a final document, as [{type,id,body}] — head only.
const ldOf = (html) => [...html.slice(0, html.toLowerCase().indexOf('</head>')).matchAll(/<script\b([^>]*)type="application\/ld\+json"([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((m) => ({ type: JSON.parse(m[3])['@type'], id: (/id="([^"]*)"/.exec(m[1] + m[2]) || [])[1], body: m[3] }));
const typesOf = (html) => ldOf(html).map((b) => b.type).sort();

const req = (p, ua = HUMAN) => ({
    url: `${SITE}${p}`,
    method: 'GET',
    headers: { get: (n) => (String(n).toLowerCase() === 'user-agent' ? ua : null) },
});
async function run(p, prerenderBody, { ua = HUMAN, status = 200 } = {}) {
    const m = await middleware();
    const original = globalThis.fetch;
    globalThis.fetch = async (target) => {
        const u = String(target);
        if (u.startsWith(SITE)) {
            const pathname = new URL(u).pathname;
            const shell = pathname === '/' ? HOME_SHELL : /^\/(products|product|p)\//.test(pathname) ? PDP_SHELL : SHOP_SHELL;
            return new Response(shell, { status: 200, headers: { 'Content-Type': 'text/html' } });
        }
        return new Response(prerenderBody, { status, headers: { 'Content-Type': 'text/html' } });
    };
    try { return await m(req(p, ua)); } finally { globalThis.fetch = original; }
}
const ALL_SITE = ['Organization', 'WebSite', 'LocalBusiness'];

test('copy: blocks are byte-identical to the prerender, ids reuse the runtime-upserted ids', () => {
    const r = injectLdJson('<html><head><title>x</title></head><body></body></html>', page([...ALL_SITE, 'CollectionPage', 'BreadcrumbList']), '/api/prerender/category/ink');
    const got = ldOf(r.html);
    assert.equal(got.length, 5);
    for (const g of got) assert.equal(g.body, bodies[g.type], `${g.type} verbatim`);
    assert.deepEqual(Object.fromEntries(got.map((g) => [g.type, g.id])), {
        Organization: 'site-jsonld-organization', WebSite: 'site-jsonld-website', LocalBusiness: 'site-jsonld-localbusiness',
        CollectionPage: 'collection-jsonld-collection-page', BreadcrumbList: 'collection-jsonld-breadcrumbs',
    });
    assert.equal(r.skipped, 0);
});

test('dedupe: the real home shell keeps ONE block per type; its own id survives, unmatched FAQPage stays', () => {
    assert.equal(typesOf(HOME_SHELL).filter((t) => t === 'Organization').length, 1);
    const r = injectLdJson(HOME_SHELL, page([...ALL_SITE, 'CollectionPage']), '/api/prerender/home');
    const got = ldOf(r.html);
    for (const t of [...ALL_SITE, 'CollectionPage', 'FAQPage']) assert.equal(got.filter((g) => g.type === t).length, 1, t);
    assert.equal(got.find((g) => g.type === 'Organization').body, bodies.Organization, 'shell org replaced');
    assert.ok(got.find((g) => g.type === 'FAQPage').body.includes('Question'), 'the shell FAQPage (its own visible FAQ) is kept');
});

test('dedupe: shop shell #shop-schema CollectionPage is replaced in place (id kept); no second CollectionPage', () => {
    const r = injectLdJson(SHOP_SHELL, page(['CollectionPage', 'BreadcrumbList']), '/api/prerender/brand/brother');
    const cps = ldOf(r.html).filter((g) => g.type === 'CollectionPage');
    assert.equal(cps.length, 1);
    assert.equal(cps[0].id, 'shop-schema');
    assert.equal(cps[0].body, bodies.CollectionPage);
});

test('filter: FAQPage only on category/brand/product routes; never printer or home', () => {
    const pre = page(['CollectionPage', 'FAQPage']);
    const has = (p) => ldOf(injectLdJson(SHOP_SHELL, pre, p).html).some((g) => g.type === 'FAQPage');
    for (const p of ['/api/prerender/category/ink', '/api/prerender/brand/brother?code=LC73', '/api/prerender/product/SKU1']) assert.ok(has(p), p);
    for (const p of ['/api/prerender/printer/amano/amano-bx3000', '/api/prerender/home']) assert.ok(!has(p), p);
});

test('bad block: a non-parsing block is skipped and counted; the good ones still go in', () => {
    const bad = '<script type="application/ld+json">{ not json </script>';
    const r = injectLdJson('<html><head></head></html>', page(['Organization'], bad), '/api/prerender/category/ink');
    assert.equal(r.skipped, 1);
    assert.deepEqual(typesOf(r.html), ['Organization']);
});

test('no </head> or no blocks: shell returned untouched', () => {
    assert.equal(injectLdJson('<html>no head', page(['Organization']), '/x').html, '<html>no head');
    const s = '<html><head><title>a</title></head></html>';
    assert.equal(injectLdJson(s, '<html></html>', '/x').html, s);
});

test('middleware: product page gets Product+ProductGroup+Breadcrumb+FAQ once each, header ok', async () => {
    const res = await run('/products/some-slug/SKU1', page([...ALL_SITE, 'ProductGroup', 'Product', 'BreadcrumbList', 'FAQPage']));
    assert.equal(res.headers.get('x-head-inject'), 'ok-partial-no-description');
    const html = await res.text();
    assert.deepEqual(typesOf(html), ['BreadcrumbList', 'FAQPage', 'LocalBusiness', 'Organization', 'Product', 'ProductGroup', 'WebSite']);
    assert.equal(ldOf(html).find((g) => g.type === 'Product').body, bodies.Product);
});

test('middleware: printer page drops FAQPage; bad block reported in X-Head-Inject', async () => {
    const pre = page(['CollectionPage', 'BreadcrumbList', 'FAQPage'], '<script type="application/ld+json">{oops</script>');
    const res = await run('/shop?brand=hp&printer_slug=hp-x', pre);
    assert.match(res.headers.get('x-head-inject'), /-ldjson-skip-1$/);
    const html = await res.text();
    assert.deepEqual(typesOf(html), ['BreadcrumbList', 'CollectionPage']);
    assert.ok(ldOf(html).some((g) => g.id === 'printer-jsonld-breadcrumbs'));
});

test('middleware: miss behaviour unchanged (500 prerender => untouched shell + miss header)', async () => {
    const res = await run('/ink-cartridges', 'boom', { status: 500 });
    assert.equal(res.headers.get('x-head-inject'), 'miss-status-500');
    assert.equal(await res.text(), SHOP_SHELL);
});

test('bot path unchanged: Googlebot gets the prerender body itself, no shell, no X-Head-Inject', async () => {
    const m = await middleware();
    const original = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (u) => { urls.push(String(u)); return new Response('PRERENDER-BODY', { status: 200, headers: { 'Content-Type': 'text/html' } }); };
    try {
        const res = await m(req('/ink-cartridges', GOOGLEBOT));
        assert.equal(await res.text(), 'PRERENDER-BODY');
        assert.equal(res.headers.get('x-head-inject'), null);
        assert.ok(urls.every((u) => !u.startsWith(SITE)), 'no shell fetch');
    } finally { globalThis.fetch = original; }
});

test('pin: client code upserts these ids, so injected blocks are replaced, never doubled', () => {
    const footer = fs.readFileSync(path.join(ROOT, 'js', 'footer.js'), 'utf8');
    const schema = fs.readFileSync(path.join(ROOT, 'js', 'schema.js'), 'utf8');
    for (const id of ['site-jsonld-organization', 'site-jsonld-website', 'site-jsonld-localbusiness']) assert.ok(footer.includes(id), id);
    for (const id of ['collection-jsonld-collection-page', 'collection-jsonld-breadcrumbs', 'printer-jsonld-collection-page', 'printer-jsonld-breadcrumbs']) assert.ok(schema.includes(id), id);
    // Known gap (shop-page.js, FE-3's file): #shop-schema AND collection-jsonld-collection-page can coexist after JS.
});
