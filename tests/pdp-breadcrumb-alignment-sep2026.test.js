/**
 * PDP breadcrumb — one centre line, /shop look — September 2026 (ERR-298)
 *
 * The 44px tap-target rule on `.breadcrumb__item a` pinned each link's TEXT to
 * the top of its 44px box, while the "/" separator and the current page sat on
 * the box's centre line: measured on live, links at y=204 and the product name
 * at y=214. The PDP trail also used the sans `.breadcrumb` look while /shop uses
 * the mono, chevron `.drilldown-breadcrumb`, so the trail changed font on click.
 *
 * Run: node --test tests/pdp-breadcrumb-alignment-sep2026.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const stripComments = require('./helpers/strip-comments');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const COMPONENTS = stripComments(read('inkcartridges/css/components.css'));
const LAYOUT = stripComments(read('inkcartridges/css/layout.css'));
const PDP_HTML = read('inkcartridges/html/product/index.html');

test('breadcrumb links centre their text inside the 44px tap target', () => {
    const rule = COMPONENTS.match(/\.breadcrumb__item a\s*\{[^}]*display:\s*inline-flex[^}]*\}/);
    assert.ok(rule, '.breadcrumb__item a must be display:inline-flex');
    assert.match(rule[0], /align-items:\s*center/, 'text must sit on the separator centre line');
});

test('PDP breadcrumb carries the /shop drilldown look', () => {
    assert.match(PDP_HTML, /<nav class="breadcrumb breadcrumb--pdp" aria-label="Breadcrumb">/);
    assert.match(LAYOUT, /\.breadcrumb--pdp \.breadcrumb__item\s*\{[^}]*font-family:\s*var\(--font-family-mono\)/);
    assert.match(LAYOUT, /\.breadcrumb--pdp \.breadcrumb__item:not\(:last-child\)::after\s*\{[^}]*rotate\(-45deg\)/,
        'separator must be the drilldown chevron, not "/"');
});
