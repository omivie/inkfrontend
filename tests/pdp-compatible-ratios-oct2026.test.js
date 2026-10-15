/**
 * Compatible PDP uses the same column + image ratios as a genuine PDP
 * (owner 2026-10-15, ERR-343). The old `--compatible` desktop override
 * (`minmax(180px, 300px) 1fr`, image `object-fit: cover`) squeezed the photo
 * and printer list into a ~190px column.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const css = stripComments(fs.readFileSync(
    path.join(__dirname, '..', 'inkcartridges', 'css', 'pages.css'), 'utf8'));

test('no desktop rule gives .product-detail__layout--compatible its own grid or image fit', () => {
    // Only the <=768 shared phone block may name --compatible.
    const desktop = css.replace(/@media \(max-width: 768px\)\s*\{[\s\S]*?\n\}/g, '');
    assert.doesNotMatch(desktop, /\.product-detail__layout--compatible/);
});

test('base layout is the shared 1fr 1fr grid with the 64% image', () => {
    assert.match(css, /\.product-detail__layout\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    assert.match(css, /\.product-detail__layout \.product-gallery__main\s*\{[^}]*width:\s*64%/);
});
