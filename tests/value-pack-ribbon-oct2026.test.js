/**
 * Value-pack card ribbon: says how many colours, sits clear of the heart (ERR-324)
 * ==============================================================================
 *
 * Owner, 2026-10-13, from a /shop?code=LC3313 screenshot:
 *   - the favourite heart (top-right of every card) covered the end of the
 *     top-left "FULL-SET VALUE PACK" ribbon, so it read "FULL-SET VALUE PA♡";
 *   - say "Three colour value pack" / "Four colour value pack" instead;
 *   - the burnt-amber fill (#b45309) did not invite a buy.
 *
 * Fix: the heart stays (favourites is how repeat ink buyers re-order); the
 * ribbon moves to the image's bottom-left corner; the label comes from ONE
 * helper, ProductColors.packLabel, used by both card renderers (shop grid and
 * search dropdown — ERR-125: duplicated renderers drift); the fill is
 * emerald-700 #047857 (white ~5.5:1, WCAG AA).
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 *   - Counting colours from the NAME ("5-Pack") would call a KCMY + spare-black
 *     pack "Five-colour". The count is from the stored colour code only.
 *   - B and K are the same black: "BCMY" is four colours, not five.
 *   - A colour code we cannot count must say "Value pack", never "undefined-colour".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripComments } = require('./helpers/strip-comments');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', ...p), 'utf8');

function loadProductColors() {
    const stubWindow = {
        location: { hostname: 'localhost', protocol: 'http:', href: 'http://localhost/' },
        addEventListener: () => {},
        document: { addEventListener: () => {}, readyState: 'complete' },
    };
    const ctx = {
        window: stubWindow, document: stubWindow.document, console,
        navigator: { userAgent: 'node-test' },
        setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.createContext(ctx);
    vm.runInContext(`(function(){ ${read('js', 'utils.js')}\n window.ProductColors = ProductColors; })();`, ctx);
    return ctx.window.ProductColors;
}
const ProductColors = loadProductColors();

test('§1 label counts colours from the stored colour code', () => {
    const cases = [
        ['CMY', 'Three-colour value pack'],
        ['KCMY', 'Four-colour value pack'],
        ['CMYK', 'Four-colour value pack'],
        ['BCMY', 'Four-colour value pack'],
        ['kcmy', 'Four-colour value pack'],
        ['Value Pack', 'Value pack'],
        ['Black/Colour', 'Value pack'],
        ['Black', 'Value pack'],
        ['K', 'Value pack'],
        ['', 'Value pack'],
    ];
    for (const [color, want] of cases) {
        // Labels use U+2011 (non-breaking hyphen) so "Three-colour" never splits.
        assert.equal(ProductColors.packLabel({ color, name: 'X 5-Pack' }), want.replace('-', '\u2011'), `color=${JSON.stringify(color)}`);
    }
    assert.equal(ProductColors.packLabel(null), 'Value pack');
    assert.equal(ProductColors.packLabel({}), 'Value pack');
});

test('§2 both card renderers use the one helper, escaped, and the old wording is gone', () => {
    for (const file of ['shop-page.js', 'products.js']) {
        const src = stripComments(read('js', file));
        assert.match(src, /product-card__ribbon--value-pack">\$\{Security\.escapeHtml\(ProductColors\.packLabel\(product\)\)\}/, file);
        assert.doesNotMatch(src, /Full-set value pack/i, file);
    }
});

test('§3 ribbon sits bottom-left (clear of the top-right heart) on an enticing green', () => {
    const css = stripComments(read('css', 'search.css'));
    const base = css.match(/\.product-card__ribbon\s*\{([^}]*)\}/);
    assert.ok(base, 'base .product-card__ribbon rule');
    assert.match(base[1], /bottom:\s*8px/);
    assert.doesNotMatch(base[1], /\btop:/, 'a top offset puts it back under the heart');
    const vp = css.match(/\.product-card__ribbon--value-pack\s*\{([^}]*)\}/);
    assert.ok(vp, 'value-pack rule');
    assert.match(vp[1], /background:\s*#047857/);
    // The heart is still top-right — the fix moved the ribbon, not the heart.
    const fav = stripComments(read('css', 'pages.css')).match(/\.product-card__fav-btn\s*\{([^}]*)\}/);
    assert.match(fav[1], /top:/);
    assert.match(fav[1], /right:/);
});
