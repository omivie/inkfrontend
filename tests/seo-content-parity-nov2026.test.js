/**
 * FE-3 (Nov 2026) — visible content parity on listing pages.
 * Pins: pure extraction over a fixture prerender, FAQ byte-parity with the
 * FAQPage JSON-LD, no innerHTML of prerender content, route coverage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SeoMeta = require('../inkcartridges/js/seo-meta.js');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const SRC = fs.readFileSync(path.join(ROOT, 'js/seo-meta.js'), 'utf8');

const FAQ = [
    { q: 'What size roll do I need?', a: 'Width x diameter — it\'s printed in the cover. We\'ll match it & help.' },
    { q: 'Is shipping free?', a: 'Yes — orders over $100 ship free anywhere in New Zealand.' },
];
const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
const FIXTURE = `<html><head><title>Ink Cartridges NZ</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
<main>
<h1>Ink Cartridges NZ &mdash; Genuine &amp; Compatible</h1>
<p>Browse 1453 ink cartridges. Free NZ shipping.</p>
<section><h2>Shop Ink Cartridges by Brand</h2><ul>
<li><a href="https://www.inkcartridges.co.nz/shop?brand=hp&amp;category=ink"><strong>HP Ink Cartridges</strong> (400)</a></li>
<li><a href="https://www.inkcartridges.co.nz/shop?brand=canon&amp;category=ink"><strong>Canon Ink Cartridges</strong> (381)</a></li></ul></section>
<section><h2>Genuine vs Compatible</h2>
<p>We stock both. <a href="https://www.inkcartridges.co.nz/genuine-vs-compatible">Learn more</a> or <a href="https://evil.example/x">bad</a> <a href="javascript:alert(1)">worse</a>.</p>
<ul><li><strong>Genuine:</strong> 1032 products</li></ul></section>
<section><h2>All Ink Cartridges</h2><ul>
<li class="product-card"><a href="https://www.inkcartridges.co.nz/products/b-one/GONE"><img src="x.webp" alt="a"><h3>Brother One &amp; Two</h3><p>Genuine Brother</p><p><strong>$8.49</strong> incl. GST</p><p>In Stock</p></a></li>
<li class="product-card"><a href="https://www.inkcartridges.co.nz/products/c-two/CTWO"><h3>Canon Two</h3><p><strong>$12.00</strong> incl. GST</p></a></li>
</ul><p><a href="https://www.inkcartridges.co.nz/shop?category=ink">View all 1453 ink cartridges</a></p></section>
<section class="faq"><h2 id="faq-heading">Frequently asked questions</h2><h3>${FAQ[0].q}</h3><p>${FAQ[0].a.replace(/'/g, '&#39;')}</p></section>
</main></body></html>`;

test('extractContent: sections, link-list flag, text-only segments, link allow-list', () => {
    const c = SeoMeta.extractContent(FIXTURE);
    assert.deepEqual(c.sections.map((s) => s.h2), ['Shop Ink Cartridges by Brand', 'Genuine vs Compatible']);
    assert.equal(c.sections[0].linkList, true);
    assert.equal(c.sections[1].linkList, false);
    const p = c.sections[1].blocks[0].s;
    assert.deepEqual(p.filter((x) => x.href).map((x) => x.href), ['/genuine-vs-compatible']);
    assert.ok(p.some((x) => x.t === 'bad' && !x.href), 'foreign host drops to text');
    assert.ok(p.some((x) => x.t === 'worse' && !x.href), 'javascript: drops to text');
    assert.equal(c.faqTitle, 'Frequently asked questions');
});

test('extractContent: products keep order, name, price lines and same-origin path', () => {
    const { products } = SeoMeta.extractContent(FIXTURE);
    assert.equal(products.h2, 'All Ink Cartridges');
    assert.deepEqual(products.items.map((i) => i.name), ['Brother One & Two', 'Canon Two']);
    assert.deepEqual(products.items[0].lines, ['Genuine Brother', '$8.49 incl. GST', 'In Stock']);
    assert.equal(products.items[0].href, '/products/b-one/GONE');
    assert.equal(products.more[0].href, '/shop?category=ink');
});

test('extractContent: empty / non-prerender input never throws', () => {
    for (const x of [null, undefined, '', '<html></html>', 42]) {
        const c = SeoMeta.extractContent(x);
        assert.deepEqual(c, { sections: [], products: null, faqTitle: null });
    }
});

test('FAQ text is byte-identical to the FAQPage JSON-LD answers (inv 11)', () => {
    const head = SeoMeta.extractHead(FIXTURE);
    assert.deepEqual(head.faq, FAQ);
    assert.equal(JSON.stringify(head.faq), JSON.stringify(FAQ));
    assert.ok(head.content.sections.every((s) => !/Frequently/.test(s.h2)), 'FAQ is not duplicated from the visible HTML');
});

test('safePath: same-origin only', () => {
    assert.equal(SeoMeta.safePath('https://www.inkcartridges.co.nz/a?b=1&amp;c=2#h'), '/a?b=1&c=2');
    assert.equal(SeoMeta.safePath('/relative'), '/relative');
    for (const bad of ['https://evil.example/', 'http://www.inkcartridges.co.nz/', 'javascript:alert(1)', '//evil.example/x', '', null]) {
        assert.equal(SeoMeta.safePath(bad), null, String(bad));
    }
});

test('no innerHTML / insertAdjacentHTML / outerHTML / document.write anywhere in the mirror code', () => {
    const a = SRC.indexOf('FE-3: visible mirror of the prerender body');
    const b = SRC.indexOf('    _setH1(text');
    assert.ok(a > 0 && b > a);
    assert.doesNotMatch(SRC.slice(a, b), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    assert.doesNotMatch(SRC, /\.innerHTML\s*=/);
});

test('mirror is loud on failure, never display:none, cache bumped to v4', () => {
    assert.match(SRC, /_setMirrorState\('error'\)/);
    assert.match(SRC, /ic_seo_pr_v4:/);
    assert.doesNotMatch(SRC, /ic_seo_pr_v3:/);
    const css = fs.readFileSync(path.join(ROOT, 'css/pages.css'), 'utf8');
    const block = css.slice(css.indexOf('FE-3: listing-page mirror'), css.indexOf('/* ── Shop Section Cards'));
    assert.ok(block.length > 100);
    assert.doesNotMatch(block, /display:\s*none/);
});

test('route coverage: each listing surface gets a prerender path and mirrors', () => {
    const cases = [
        ['/ink-cartridges', '', '/api/prerender/category/ink', 'category-ink'],
        ['/toner-cartridges', '', '/api/prerender/category/toner', 'category-toner'],
        ['/receipt-rolls', '', '/api/prerender/category/receipt', 'category-receipt'],
        ['/shop', '?brand=brother', '/api/prerender/brand/brother', 'brand'],
        ['/shop', '?brand=canon&category=toner', '/api/prerender/brand/canon?category=toner', 'brand'],
        ['/shop', '?brand=canon&code=PG645', '/api/prerender/brand/canon?code=PG645', 'brand'],
    ];
    for (const [pathname, search, pr, surface] of cases) {
        const loc = { pathname, search };
        assert.equal(SeoMeta.prerenderPathForLocation(loc), pr);
        assert.equal(SeoMeta.surfaceForLocation(loc), surface);
        assert.ok(SeoMeta.MIRROR_SURFACES.includes(surface), surface);
    }
    // printer pages are already at parity: left alone
    assert.ok(!SeoMeta.MIRROR_SURFACES.includes('printer'));
    assert.ok(!SeoMeta.MIRROR_SURFACES.includes('category-ribbons'));
});

test('shop.html carries the mirror container, hidden + static until populated', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/shop.html'), 'utf8');
    assert.match(html, /<section[^>]*id="seo-mirror"[^>]*data-mirror="static"[^>]*hidden/);
});
