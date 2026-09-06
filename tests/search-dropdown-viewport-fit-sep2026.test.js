/**
 * Search dropdown — the panel stays on screen (ERR-217)
 * =====================================================
 *
 * 404.html is the only page on the site with a search box that is not in the
 * header: the big one under "Try searching for what you need"
 * (`#error-search-input`, `404.html:167`). Typing in it fetched, rendered 40
 * cards, and then put them where you could not read them.
 *
 * Measured live, inkcartridges.co.nz/<a 404 path>, 1440x800, query "lc":
 *
 *              header box (worked)      in-page 404 box (broken)
 *   --smart-ac-top   157px                    654px
 *   painted at       top 157   ✅             top 809   ❌  (+155px)
 *   height           627px                    280px  (the floor)
 *   bottom           784  (fold 800)          1089 — 289px BELOW THE FOLD
 *
 * Two causes, one symptom. The +155px offset was a containing-block problem
 * fixed in js/modern-effects.js and pinned by
 * tests/search-overlay-containing-block-sep2026.test.js. THIS file pins the
 * other one: even placed correctly, the panel did not fit. The old math was
 *
 *     top       = inputRect.bottom + 6
 *     maxHeight = Math.max(280, innerHeight - top - 16)
 *
 * which is right for the only box that existed when it was written — the header
 * one, which always has ~630px of clear viewport under it. The 404 input sits
 * 649px down an 800px window, so "the space below" was 129px, the 280px floor
 * took over, and the floor became the overflow. **A floor larger than the space
 * it is floored into is not a fallback; it is an off-screen panel.**
 *
 * The contract now: prefer below (so the header box's numbers do not move),
 * flip above when below is cramped and above is roomier, stop clear of the
 * sticky header when flipped (it paints at z-index 200 over the dropdown's 50 —
 * probed with elementFromPoint, not assumed), and never — at any viewport, at
 * any input position — hand back a box that leaves the screen.
 *
 * Run with: node --test tests/search-dropdown-viewport-fit-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { simulatePositionDropdown } = require('./helpers/position-dropdown-sim');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'search.js');
const CSS_PATH = path.join(ROOT, 'inkcartridges', 'css', 'search.css');

// The two real geometries, measured in the browser rather than invented.
const HEADER_BOX = { innerWidth: 1440, innerHeight: 800, inputBottom: 151, inputHeight: 38, formLeft: 1030, formWidth: 196, headerBottom: 155 };
const ERROR_BOX  = { innerWidth: 1440, innerHeight: 800, inputBottom: 649, inputHeight: 62, formLeft: 480, formWidth: 400, headerBottom: 155 };

// ─── §1 The reported defect ────────────────────────────────────────────────

test('§1 the 404 in-page box: panel is fully inside the viewport', () => {
    const { box, placement } = simulatePositionDropdown(ERROR_BOX);
    assert.ok(box.bottom <= ERROR_BOX.innerHeight,
        `panel bottom ${box.bottom} must not pass the ${ERROR_BOX.innerHeight}px fold ` +
        '(it shipped at 1089 — 289px of product titles and prices unreachable)');
    assert.ok(box.top >= 0, `panel top ${box.top} must not sit above the viewport`);
    assert.equal(placement, 'above',
        'with 129px below the input and 410px above it, the panel belongs above');
});

test('§1 the 404 in-page box: the flipped panel clears the sticky header', () => {
    const { box } = simulatePositionDropdown(ERROR_BOX);
    assert.ok(box.top >= ERROR_BOX.headerBottom,
        `panel top ${box.top} must start at or below the header's bottom edge ` +
        `(${ERROR_BOX.headerBottom}) — the header paints over it at z-index 200 vs 50`);
});

test('§1 the 404 in-page box: the panel is worth opening (two card rows do not fit, but the space is used in full)', () => {
    const { box } = simulatePositionDropdown(ERROR_BOX);
    // 649 - 62 = 587 input top; 587 - 6 gap - 155 header - 16 edge = 410.
    assert.equal(box.height, 410, 'the flipped panel must claim all the room above the input');
    assert.ok(box.height > 129 * 2,
        'and it must beat the 129px that placing below would have given it');
});

// ─── §2 The regression control: the header box must not move ───────────────

test('§2 the header box still places BELOW, with the numbers it had before', () => {
    const { box, placement, props } = simulatePositionDropdown(HEADER_BOX);
    assert.equal(placement, 'below', 'the header box has 633px under it — it must never flip');
    assert.equal(props['--smart-ac-top'], '157px', 'top = inputBottom + 6, unchanged');
    assert.equal(box.height, 800 - 157 - 16, 'height = innerHeight - top - 16, unchanged');
    assert.equal(box.bottom, 784, 'measured in the browser as 784 before this change');
    assert.equal(props['--smart-ac-bottom'], undefined,
        'a panel placed below must not leave a stale --smart-ac-bottom behind');
});

test('§2 the flip is reversible — the same instance placed below afterwards clears is-above', () => {
    // positionDropdown re-runs on resize and scroll (js/search.js), so a panel
    // that flipped once must be able to flip back. Simulated by running the
    // cramped geometry and then the roomy one against one shared stub is not
    // possible through the helper's API, so assert the source does the cleanup
    // that makes it possible.
    const js = fs.readFileSync(JS_PATH, 'utf8');
    const fnStart = js.indexOf('function positionDropdown(');
    const body = js.slice(fnStart, js.indexOf('\n        }', fnStart));
    assert.match(body, /classList\.remove\(\s*['"`]is-above['"`]\s*\)/,
        'the below branch must remove is-above');
    assert.match(body, /removeProperty\(\s*['"`]--smart-ac-bottom['"`]\s*\)/,
        'the below branch must clear --smart-ac-bottom');
    assert.match(body, /removeProperty\(\s*['"`]--smart-ac-top['"`]\s*\)/,
        'the above branch must clear --smart-ac-top');
});

// ─── §3 The invariant, swept ───────────────────────────────────────────────

test('§3 across every viewport and input position, the panel never leaves the screen', () => {
    const failures = [];
    for (const innerHeight of [360, 600, 720, 800, 900, 1080, 1300, 1600]) {
        for (const innerWidth of [360, 768, 1280, 1440, 1920, 2560]) {
            for (const headerBottom of [0, 64, 155]) {
                // Walk the input down the whole page, 20px at a time.
                for (let inputBottom = headerBottom + 40; inputBottom < innerHeight; inputBottom += 20) {
                    const { box } = simulatePositionDropdown({
                        innerWidth, innerHeight, inputBottom, inputHeight: 40,
                        formLeft: 16, formWidth: Math.min(400, innerWidth - 32), headerBottom,
                    });
                    if (!(box.height > 0)) failures.push(`h=${innerHeight} w=${innerWidth} hdr=${headerBottom} in=${inputBottom}: zero height`);
                    else if (box.bottom > innerHeight) failures.push(`h=${innerHeight} w=${innerWidth} hdr=${headerBottom} in=${inputBottom}: bottom ${box.bottom} > fold`);
                    else if (box.top < 0) failures.push(`h=${innerHeight} w=${innerWidth} hdr=${headerBottom} in=${inputBottom}: top ${box.top} < 0`);
                }
            }
        }
    }
    assert.deepEqual(failures.slice(0, 10), [],
        `${failures.length} geometries put the panel off screen`);
});

test('§3 the panel always takes the roomier side', () => {
    const GAP = 6, EDGE = 16;
    for (const inputBottom of [120, 300, 400, 500, 649, 700]) {
        const opts = { innerWidth: 1440, innerHeight: 800, inputBottom, inputHeight: 40, formLeft: 480, formWidth: 400, headerBottom: 155 };
        const { box, placement } = simulatePositionDropdown(opts);
        const below = 800 - inputBottom - GAP - EDGE;
        const above = (inputBottom - 40) - GAP - 155 - EDGE;
        assert.ok(box.height >= Math.min(Math.max(below, above), box.height),
            'sanity');
        if (below < 280 && above > below) {
            assert.equal(placement, 'above', `input at ${inputBottom}: below=${below} above=${above}`);
        } else {
            assert.equal(placement, 'below', `input at ${inputBottom}: below=${below} above=${above}`);
        }
    }
});

// ─── §4 The CSS half — a class the stylesheet does not honour is a no-op ───

test('§4 search.css honours .is-above by anchoring to the bottom', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const idx = css.indexOf('.smart-ac-dropdown:has(.smart-ac__grid).is-above');
    assert.ok(idx !== -1,
        'positionDropdown sets .is-above; without a rule for it the class is decoration ' +
        'and the flipped panel still paints downward off the screen');
    const body = css.slice(css.indexOf('{', idx), css.indexOf('}', idx));
    assert.match(body, /top:\s*auto/, 'the flipped rule must release `top`');
    assert.match(body, /bottom:\s*var\(\s*--smart-ac-bottom/,
        'the flipped rule must read --smart-ac-bottom, the property positionDropdown sets');
});

test('§4 the dropdown pins its own text alignment', () => {
    // .error-page { text-align: center } inherited straight into the panel, so
    // the same component read differently on 404.html than in every header.
    // Strip comments first: this rule's own comment contains a literal
    // `{ text-align: center }`, and a naive indexOf('}') stops inside it.
    const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const open = css.indexOf('.smart-ac-dropdown {');
    const body = css.slice(open, css.indexOf('}', open));
    assert.match(body, /text-align:\s*left/,
        'the dropdown must set text-align rather than inherit the page\'s');
});
