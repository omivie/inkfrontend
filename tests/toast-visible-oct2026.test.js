/**
 * ERR-321 — "Add does nothing": every toast on the site was invisible, and the
 * card buttons said "Added!" on a refused add.
 *
 * modern-effects.css loads after components.css on every page and carried
 * `.toast { opacity: 0 }` keyed to a `.show` class no JS sets. Same specificity,
 * later file, so `.toast--visible { opacity: 1 }` lost and a MIXED_TEST_CART
 * refusal toast rendered at opacity 0 (measured on live /shop and PDP,
 * 2026-10-13). The cart drawer (ERR-316) had replaced the success toast, so the
 * only toasts left were the error ones nobody could see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (...p) => stripComments(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

test('no stylesheet loaded after components.css styles .toast opacity or transform', () => {
    const css = read('css', 'modern-effects.css');
    assert.ok(css.length > 1000, 'modern-effects.css read as near-empty, the check below would pass vacuously');
    const rules = css.match(/[^{}]*\.toast\b[^{}]*\{[^}]*\}/g) || [];
    const offenders = rules.filter((r) => /\b(opacity|transform)\s*:/.test(r));
    assert.deepEqual(offenders, [], 'a later .toast opacity/transform rule hides every toast');
});

test('components.css still makes .toast--visible opaque', () => {
    assert.match(read('css', 'components.css'), /\.toast--visible\s*\{[^}]*opacity:\s*1/);
});

// Every card surface that prints "Added!" must first honour Cart.addItem's
// { ok: false } refusal (ERR-269 return contract). The PDP already did.
for (const file of ['shop-page.js', 'products.js', 'ribbons-page.js', 'business-page.js', 'favourites.js', 'product-detail-page.js']) {
    test(`${file}: a refused add is not reported as "Added!"`, () => {
        const js = read('js', file);
        const adds = js.split('Cart.addItem(').length - 1;
        assert.ok(adds >= 1, `${file} no longer calls Cart.addItem — update this list`);
        const guards = (js.match(/result\s*&&\s*result\.ok\s*===\s*false/g) || []).length;
        assert.ok(guards >= 1, `${file} ignores Cart.addItem's ok:false and claims "Added!"`);
    });
}
