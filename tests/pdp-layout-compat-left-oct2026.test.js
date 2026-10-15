'use strict';
/**
 * PDP layout, owner 12 Oct 2026 (ERR-318), revised 15 Oct (ERR-339):
 *   - the image sits at the top of the gallery column at 64% of its width,
 *     "For use in your printer" directly UNDER it; click/tap enlarges it;
 *   - phones keep the list BELOW the buy box (Add to Cart stays high);
 *   - Delivery / Returns sit under Add AND under the buy-more chips;
 *   - Colour / Page yield render as chips under the title;
 *   - "Search your printer model…" (the backend's how_to_check) is gone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('html/product/index.html').replace(/<!--[\s\S]*?-->/g, '');
const JS = stripComments(read('js/product-detail-page.js'));
const CSS = stripComments(read('css/pages.css'));

function method(src, name) {
    const m = new RegExp(`\\n        (?:async )?${name}\\(`).exec(src);
    const start = m ? m.index : -1;
    assert.ok(start > 0, `${name}() must exist`);
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
            return { params: src.slice(src.indexOf('(', start) + 1, src.indexOf(')', start)), body: src.slice(open, i + 1) };
        }
    }
    throw new Error(`unbalanced ${name}`);
}

test('the compat slot comes right AFTER the image, inside the gallery', () => {
    const gallery = HTML.indexOf('<div class="product-gallery">');
    const slot = HTML.indexOf('<div class="product-gallery__compat" id="product-compat-slot">');
    const image = HTML.indexOf('id="product-image"');
    const info = HTML.indexOf('<div class="product-info">');
    assert.ok(gallery > 0 && gallery < image && image < slot && slot < info);
    assert.match(HTML.slice(gallery, slot), /<div class="product-gallery">\s*<div class="product-gallery__main" id="product-image">/, 'image is the first child');
});

test('grouped, flat and legacy renders all go through _mountCompat; none targets .related-products', () => {
    for (const name of ['_renderGroupedPrinterCompat', '_renderFlatPrinterCompat']) {
        assert.match(method(JS, name).body, /return this\._mountCompat\(`/, name);
    }
    const all = method(JS, 'renderCompatiblePrinters').body;
    assert.match(all, /this\._mountCompat\(''\);[\s\S]*_renderGroupedPrinterCompat/, 'cleared before the fast paths');
    assert.match(all, /this\._mountCompat\(`/, 'legacy Supabase fallback');
    for (const name of ['_renderGroupedPrinterCompat', '_renderFlatPrinterCompat', 'renderCompatiblePrinters']) {
        assert.doesNotMatch(method(JS, name).body, /product-printers-wrap|\.related-products/, name);
    }
    // Ribbons keep their own routing (renderCompatibleDevices appends to <main>).

});

test('_mountCompat fills the slot, and says false when there is no slot', () => {
    const { params, body } = method(JS, '_mountCompat');
    const slot = { innerHTML: 'old product' };
    const run = (doc) => vm.runInNewContext(`(function (${params}) ${body})`, { document: doc });
    assert.equal(run({ getElementById: (id) => (id === 'product-compat-slot' ? slot : null) })('<b>x</b>'), true);
    assert.equal(slot.innerHTML, '<b>x</b>');
    assert.equal(run({ getElementById: () => null })('<b>x</b>'), false);
});

test('desktop: image is 64% of the column (80% less 20%), top-anchored; empty slot takes no space', () => {
    assert.match(CSS, /\.product-detail__layout \.product-gallery \{\s*display: flex;\s*flex-direction: column;[^}]*align-self: start;/);
    assert.match(CSS, /\.product-detail__layout \.product-gallery__main \{\s*width: 64%;/);
    assert.match(CSS, /\.product-gallery__compat:empty \{ display: none; \}/);
    assert.doesNotMatch(CSS, /\.product-detail__layout \.product-gallery__main \{\s*position: absolute;/, 'no longer stretched to the info column');
});

test('phone: one column, list ordered after the buy box, image 20% shorter', () => {
    const i = CSS.indexOf('@media (max-width: 768px) {\n    .product-detail__layout,');
    assert.ok(i > 0);
    const block = CSS.slice(i, CSS.indexOf('\n}', i));
    assert.match(block, /max-height: 176px;/);
    assert.match(block, /\.product-detail__layout \.product-gallery \{ display: contents; \}/);
    assert.match(block, /\.product-gallery__compat \{ order: 1; \}/);
});

test('Delivery / Returns: after the chips in the DOM and in the same order group, at every width', () => {
    const chips = HTML.indexOf('id="volume-pricing"');
    const add = HTML.indexOf('id="add-to-cart-btn"');
    const terms = HTML.indexOf('id="product-terms"');
    assert.ok(chips > 0 && add > 0 && chips < terms && add < terms);
    assert.match(CSS, /\n\.product-info > #volume-pricing,\s*\.product-info > #product-terms,\s*\.product-info > #pack-upsell\s*\{\s*order:\s*1;/);
});

test('spec chips: under the title, before the price box; label kept for screen readers, colour dot from the palette', () => {
    const sku = HTML.indexOf('id="product-sku"');
    const specs = HTML.indexOf('id="product-specs"');
    const price = HTML.indexOf('id="product-buybox"');
    assert.ok(sku < specs && specs < price);
    assert.match(read('html/product/index.html'), /<div class="product-info__meta">\s*<p class="product-info__sku" id="product-sku">[\s\S]*?<\/p>\s*<ul class="product-info__specs" id="product-specs" hidden><\/ul>\s*<\/div>/,
        'chips share the SKU row (as their own row they put GGI690KCMY Add past 551px)');
    assert.match(CSS, /\.product-info__meta \{\s*display: flex;\s*flex-wrap: wrap;/);
    assert.match(CSS, /\.product-info__spec \{[^}]*border-radius: 999px;/);
    assert.match(CSS, /\.product-info__spec-label \{\s*position: absolute;/);
    assert.match(method(JS, 'renderSpecs').body, /this\.getColorStyle\(String\(info\.color\)\)/);
});

test('"Search your printer model" appears in no storefront JS, and renderPromise ignores how_to_check', () => {
    const dir = path.join(ROOT, 'js');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
        assert.doesNotMatch(stripComments(fs.readFileSync(path.join(dir, f), 'utf8')), /Search your printer model/, f);
    }
    assert.doesNotMatch(method(JS, 'renderPromise').body, /how_to_check/);
});

test('click-to-enlarge: real photo opens a modal <dialog> with the zoom source; fallback never does', () => {
    const start = JS.indexOf('function initProductImageLightbox(');
    assert.ok(start > 0, 'initProductImageLightbox exists');
    const end = JS.indexOf('\n    }\n', start);
    const src = JS.slice(start, end + 6);
    // Called for the main photo right after the hover zoom, and NOT behind the
    // hover-only media query (it must work on touch).
    assert.match(JS, /initProductImageZoom\(productImageEl\);\s*initProductImageLightbox\(productImageEl\);/);
    assert.doesNotMatch(src, /matchMedia/);
    assert.match(JS, /productImageEl\.removeAttribute\('data-enlarge'\)/, 'image error path disables enlarge');

    const el = (tag) => {
        const attrs = {}; const listeners = {}; const kids = [];
        return { tagName: tag, dataset: {}, attrs, listeners, kids, open: false, src: '', alt: '',
            setAttribute(k, v) { attrs[k] = v; }, hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
            addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
            querySelector(q) { return q.startsWith('img') ? this.img || null : null; },
            set innerHTML(_) { this.img = el('img'); }, showModal() { this.open = true; }, close() { this.open = false; } };
    };
    let dlg = null;
    const doc = { body: { appendChild(d) { dlg = d; } }, getElementById: () => dlg, createElement: el };
    const run = (c) => vm.runInNewContext(`${src}; initProductImageLightbox(c)`, { document: doc, HTMLDialogElement: function () {}, c });

    const photo = el('div');
    photo.img = Object.assign(el('img'), { dataset: { zoomSrc: 'https://img/big.jpg', fallback: 'placeholder' }, src: 'small.jpg', alt: 'HP 62' });
    run(photo); run(photo); // re-render binds once
    assert.ok(photo.hasAttribute('data-enlarge'));
    assert.equal(photo.listeners.click.length, 1);
    photo.listeners.click[0]();
    assert.equal(dlg.open, true);
    assert.equal(dlg.img.src, 'https://img/big.jpg');
    assert.equal(dlg.img.alt, 'HP 62');
    dlg.listeners.click[0]();
    assert.equal(dlg.open, false);

    photo.removeAttribute('data-enlarge'); // image failed to load
    photo.listeners.click[0]();
    assert.equal(dlg.open, false, 'a fallback tile is never enlarged');

    const noPhoto = el('div');
    run(noPhoto);
    assert.equal(noPhoto.hasAttribute('data-enlarge'), false);
});
