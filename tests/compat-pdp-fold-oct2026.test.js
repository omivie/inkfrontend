/**
 * Compatible PDP: Add to Cart on the first screen of a 1280x551 window (ERR-313)
 * ============================================================================
 *
 * Backend re-check, 7 Oct 2026: on CTN2030BK at 1280x551 Add sat at y 548-596,
 * under the screen, ~77px lower than a genuine page. Measured 8 Oct on six long
 * compatible titles (CTN2030BK, CCART318M, CCWAA0759BK, CTN258XLKCMY,
 * CB412DNBK-2, CC332M) — all identical, all below the fold:
 *
 *   breadcrumb 187-283 (three rows: the last crumb is the full product name) +52px
 *   compliance line + fit line on two rows                                  +24px
 *
 * After the fix (local, same six SKUs, 1280x551 and 1366x599): Add 473-521,
 * hit-testable. The rendered geometry is measured by
 * `npm run probe:fe-master-6oct` §16b; this suite pins the rules that produce it.
 *
 * Run with: node --test tests/compat-pdp-fold-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, 'inkcartridges', p), 'utf8');
const LAYOUT = stripComments(read('css/layout.css'));
const PAGES = stripComments(read('css/pages.css'));
const PDP = stripComments(read('js/product-detail-page.js'));

/** Top-level rules only: the text with every @media { … } block removed. */
function outsideMedia(css) {
    let out = '';
    for (let i = 0; i < css.length; i++) {
        if (css.startsWith('@media', i)) {
            let depth = 0;
            for (; i < css.length; i++) {
                if (css[i] === '{') depth++;
                else if (css[i] === '}' && --depth === 0) break;
            }
            continue;
        }
        out += css[i];
    }
    return out;
}

/** The body of every `@media <query> { … }` block with exactly this query. */
function mediaBodies(css, query) {
    const bodies = [];
    let at = 0;
    while ((at = css.indexOf(`@media ${query} {`, at)) !== -1) {
        let i = css.indexOf('{', at) + 1;
        const start = i;
        for (let depth = 1; depth && i < css.length; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
        }
        bodies.push(css.slice(start, i - 1));
        at = i;
    }
    return bodies;
}

test('PDP breadcrumb is ONE line at EVERY width; the current crumb (= the H1) truncates', () => {
    const top = outsideMedia(LAYOUT);
    assert.match(top, /\.breadcrumb--pdp \.breadcrumb__list \{\s*flex-wrap: nowrap;\s*overflow: hidden;\s*white-space: nowrap;\s*\}/);
    assert.match(top, /\.breadcrumb--pdp \.breadcrumb__item \{ flex: 0 0 auto; \}/);
    assert.match(top, /\.breadcrumb--pdp \.breadcrumb__item--current \{\s*flex: 1 1 auto;\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;/);
});

test('short laptop window: compliance + fit share a row, the title clamps at two lines, its CLS reserve stays off', () => {
    const block = mediaBodies(PAGES, '(min-width: 1100px) and (max-height: 620px)').find((b) => b.includes('.product-info__title'));
    assert.ok(block, 'the PDP short-window block exists');
    assert.match(block, /\.product-info__title \{ min-height: 0; \}/);
    assert.match(block, /\.product-headline:not\(\[hidden\]\) \{\s*display: flex;\s*flex-wrap: wrap;/);
    assert.match(block, /\.product-info__title \{\s*display: -webkit-box;\s*-webkit-box-orient: vertical;\s*-webkit-line-clamp: 2;\s*line-clamp: 2;\s*overflow: hidden;\s*\}/);
    // Nothing in the headline is HIDDEN to make room — it wraps instead.
    assert.doesNotMatch(block, /\.product-headline[^{]*\{[^}]*display: none/);
});

test('a clamped title keeps the full name as its tooltip', () => {
    assert.match(PDP, /const titleEl = document\.getElementById\('product-title'\);\s*titleEl\.textContent = info\.displayName;\s*titleEl\.title = info\.displayName;/);
});
