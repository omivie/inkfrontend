/**
 * ERR-356 (owner, 16 Oct 2026)
 * ============================
 * 1. "Buy the full set" (#pack-upsell) moves to the gallery column: under
 *    "For use in your printer" (#product-compat-slot), above "Pack contents &
 *    page yields" (#product-contents-slot). Phones keep it below the buy box
 *    with the printer list (CSS order 1).
 * 2. The same-day dispatch countdown moves directly under the free-shipping
 *    line (#product-free-ship), out of #product-terms.
 *
 * Run with: node --test tests/pdp-full-set-left-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const HTML = fs.readFileSync(path.join(ROOT, 'html/product/index.html'), 'utf8');
const CSS = stripComments(fs.readFileSync(path.join(ROOT, 'css/pages.css'), 'utf8'));

const at = (needle) => {
    const i = HTML.indexOf(needle);
    assert.ok(i >= 0, `${needle} must be in html/product/index.html`);
    assert.equal(HTML.indexOf(needle, i + 1), -1, `${needle} must appear once`);
    return i;
};

test('#pack-upsell sits in the gallery, between the printer list and Pack contents', () => {
    const gallery = at('<div class="product-gallery">');
    const info = at('<div class="product-info">');
    const compat = at(' id="product-compat-slot"');
    const upsell = at(' id="pack-upsell"');
    const contents = at(' id="product-contents-slot"');
    assert.ok(gallery < compat && compat < upsell && upsell < contents && contents < info);
    assert.match(HTML, /<section class="pack-upsell" id="pack-upsell" hidden data-testid="pack-upsell"/);
});

test('dispatch countdown sits directly after the free-ship line, before the promise, outside #product-terms', () => {
    const ship = at(' id="product-free-ship"');
    const countdown = at(' id="product-dispatch-countdown"');
    const promise = at(' id="product-promise"');
    assert.ok(ship < countdown && countdown < promise);
    const between = HTML.slice(HTML.indexOf('</p>', ship), countdown).replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(between, / id="/, 'nothing between the free-ship line and the countdown');
    assert.ok(countdown < at(' id="product-terms"'));
});

test('CSS: phone order keeps the card with the printer list; no dead .product-info rule; no doubled gap', () => {
    assert.match(CSS, /\.product-gallery__compat \{ order: 1; \}\s*\.product-gallery > #pack-upsell \{ order: 1; \}\s*\.product-gallery__contents \{ order: 1; \}/);
    assert.doesNotMatch(CSS, /\.product-info > #pack-upsell/);
    assert.match(CSS, /\.product-gallery > \.pack-upsell \{ margin-top: 0; \}/);
});
