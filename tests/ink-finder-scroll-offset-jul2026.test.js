/**
 * INK FINDER SCROLL OFFSET — Jul 2026 (ERR-137)
 * =============================================
 * "Printer Models" (/?scroll=ink-finder) and the hero CTA (#ink-finder-heading)
 * both scroll to the finder card. The old math centred .ink-finder__wrapper in
 * the FULL viewport — but on the landing page js/landing.js pins .site-header
 * (.site-header--sticky) the moment the hero clears, which is precisely what
 * that scroll causes. The desktop header is ~200px and its base rule is
 * position:relative, so nothing reserves the space: the card landed with
 * "Find ink for your printer", the subtitle and half the tab row hidden behind
 * the pinned chrome. Whether you saw it was pure timing luck.
 *
 * Fix: one shared scrollToInkFinder() that centres the card in the space BELOW
 * the pinned header, with a MEASURED header height and a settle pass that
 * re-corrects after the mid-flight layout shifts (header pins, mobile header
 * collapses, #trust-stats un-hides from /api/site/trust). The geometry lives in
 * landing.js — next to the observer that pins the header, and on exactly the
 * two pages that have the finder; main.js only delegates via
 * window.InkFinderScroll (which also keeps it under its 750-line audit budget,
 * tests/search-thin-frontend.test.js).
 *
 * The geometry half of these tests EXECUTES the real function lifted out of
 * landing.js — a string-match alone can pass on code that throws (ERR-136).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MAIN_JS = read('inkcartridges/js/main.js');
const LANDING_JS = read('inkcartridges/js/landing.js');

// Lift a top-level helper out of landing.js's IIFE by name.
function lift(name) {
    const m = LANDING_JS.match(new RegExp(`function\\s+${name}\\s*\\([\\s\\S]*?\\n {4}\\}`));
    assert.ok(m, `could not locate function ${name} in landing.js`);
    return m[0];
}

function loadInkFinderScrollTop() {
    return new Function(lift('inkFinderScrollTop') + '\nreturn inkFinderScrollTop;')();
}

/**
 * Build inkFinderTarget() over stubbed geometry so the three-way decision
 * (bare / reserved / edge) can be EXERCISED, not just string-matched.
 * All measurements are in document space; heroBottom is the scrollTop at which
 * landing.js's observer pins the header.
 */
function makeTarget({ viewportH, headerH, heroBottom, wrapperTop, wrapperH,
                      headerPosition = 'relative', hasHero = true }) {
    const rect = (top, height) => ({ top, height, bottom: top + height });
    const scrollY = 0;   // measured from the top of the document, as on load
    const els = {
        '.ink-finder__wrapper': { getBoundingClientRect: () => rect(wrapperTop - scrollY, wrapperH) },
        '.site-header': {
            getBoundingClientRect: () => rect(0, headerH),
            classList: { contains: () => false }
        },
        '.hero': hasHero ? { getBoundingClientRect: () => rect(headerH, heroBottom - headerH) } : null
    };
    const fakeDocument = { querySelector: (sel) => els[sel] || null };
    const fakeWindow = {
        pageYOffset: scrollY,
        innerHeight: viewportH,
        getComputedStyle: () => ({ position: headerPosition })
    };
    const src = [lift('inkFinderScrollTop'), lift('pinnedHeaderHeight'),
                 lift('headerPinsFrom'), lift('inkFinderTarget')].join('\n');
    return new Function('window', 'document', src + '\nreturn inkFinderTarget();')(
        fakeWindow, fakeDocument);
}

const HEADER = 200;      // desktop landing header: contact + logo + nav rows
const VIEWPORT = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// F1 — the header height is genuinely subtracted (the actual bug)
// ─────────────────────────────────────────────────────────────────────────────

test('F1 a pinned header pushes the landing position down by the header height', () => {
    const inkFinderScrollTop = loadInkFinderScrollTop();
    const withHeader = inkFinderScrollTop(2000, 700, VIEWPORT, HEADER);
    const noHeader = inkFinderScrollTop(2000, 700, VIEWPORT, 0);
    assert.ok(withHeader < noHeader,
        'a pinned header must land the page HIGHER in the document (smaller scrollTop), ' +
        'so the card sits below the chrome instead of under it');
    // Centred case: the header is reclaimed from a viewport that also shrank by
    // it, so half the shift shows up as the (now larger) gap under the card.
    assert.strictEqual(noHeader - withHeader, HEADER / 2);

    // Top-aligned case (card taller than the free space) — nothing is absorbed
    // by centring, so the FULL header height must be reclaimed.
    const tallWith = inkFinderScrollTop(2000, 1400, VIEWPORT, HEADER);
    const tallNone = inkFinderScrollTop(2000, 1400, VIEWPORT, 0);
    assert.strictEqual(tallNone - tallWith, HEADER,
        'with no centring slack the whole header height must be reclaimed');
});

test('F1b the card top always clears the pinned header — the title is never buried', () => {
    const inkFinderScrollTop = loadInkFinderScrollTop();
    // Sweep card heights from comfortably-fits to taller-than-the-viewport.
    for (let h = 200; h <= 1400; h += 50) {
        const top = inkFinderScrollTop(2000, h, VIEWPORT, HEADER);
        const cardTopInViewport = 2000 - top;   // where the card top paints on screen
        assert.ok(cardTopInViewport >= HEADER,
            `card height ${h}: card top painted at ${cardTopInViewport}px, ` +
            `under the ${HEADER}px header — the title would be hidden`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — geometry: centred when it fits, top-aligned when it doesn't
// ─────────────────────────────────────────────────────────────────────────────

test('F2 a card that fits is centred in the space below the header (equal air)', () => {
    const inkFinderScrollTop = loadInkFinderScrollTop();
    const cardH = 600;
    const top = inkFinderScrollTop(2000, cardH, VIEWPORT, HEADER);
    const above = (2000 - top) - HEADER;                 // gap between header and card
    const below = VIEWPORT - (2000 - top) - cardH;       // gap under the card
    assert.ok(Math.abs(above - below) < 1,
        `expected even air above/below the card, got ${above} / ${below}`);
    assert.strictEqual(above, (VIEWPORT - HEADER - cardH) / 2);
});

test('F2b a card taller than the free space top-aligns with a 16px gap', () => {
    const inkFinderScrollTop = loadInkFinderScrollTop();
    const top = inkFinderScrollTop(2000, 1200, VIEWPORT, HEADER);
    assert.strictEqual(top, 2000 - HEADER - 16,
        'tall card must top-align under the header so the title leads, not trails');
});

test('F2c never returns a negative scrollTop', () => {
    const inkFinderScrollTop = loadInkFinderScrollTop();
    assert.strictEqual(inkFinderScrollTop(100, 400, VIEWPORT, HEADER), 0,
        'a finder near the top of the document must clamp to 0, not scroll negative');
    assert.ok(inkFinderScrollTop(0, 2000, 600, 56) >= 0);
});

test('F2d headerHeight larger than the viewport degrades safely', () => {
    const inkFinderScrollTop = loadInkFinderScrollTop();
    const top = inkFinderScrollTop(2000, 500, 300, 400);
    assert.ok(Number.isFinite(top) && top >= 0,
        'a pathological header/viewport ratio must still yield a usable scrollTop');
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 — the header height is MEASURED, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────

test('F3 pinnedHeaderHeight measures the real header and predicts the landing pin', () => {
    assert.match(LANDING_JS, /function\s+pinnedHeaderHeight\s*\(/,
        'expected a pinnedHeaderHeight helper');
    const block = LANDING_JS.match(/function\s+pinnedHeaderHeight\s*\([\s\S]*?\n {4}\}/)[0];
    assert.match(block, /getBoundingClientRect\(\)\.height/,
        'the header height must be measured, not assumed');
    assert.match(block, /site-header--sticky/,
        'must recognise the class landing.js sets when it pins the header');
    assert.match(block, /\.hero/,
        'on the landing page the header is not pinned YET when this runs — the ' +
        'presence of .hero is what predicts that landing.js is about to pin it');
    assert.match(block, /sticky|fixed/,
        'must also honour a header that is already position:sticky/fixed (mobile)');
    assert.ok(!/--header-h/.test(block),
        '--header-h is a mobile-only 56px token; it must not stand in for the ' +
        'measured desktop header (ERR-137)');
    assert.ok(!/\b(?:1[5-9]\d|2[0-9]\d)\b/.test(block),
        'no hardcoded pixel header height');
});

// ─────────────────────────────────────────────────────────────────────────────
// F3b — the reservation is conditional: whether the header is pinned at the
//       destination is itself a function of the destination
// ─────────────────────────────────────────────────────────────────────────────

// Geometry close to production: ~155px header, hero ending ~554px down the
// document, the finder card ~593px tall starting at ~651px.
const PAGE = { headerH: 155, heroBottom: 554, wrapperTop: 651, wrapperH: 593 };

test('F3b tall viewport — the header never pins there, so nothing is reserved', () => {
    const top = makeTarget({ ...PAGE, viewportH: 1080 });
    // Centred in the FULL viewport: the hero is still on screen at this scroll,
    // so the header is not pinned and reserving would only shove the card down.
    assert.strictEqual(top, 651 - (1080 - 593) / 2);
    assert.ok(top < PAGE.heroBottom,
        'landing above the pin threshold is what makes the bare centre valid');
});

test('F3b2 mobile sticky header — pinned at every scroll, so always reserved', () => {
    const top = makeTarget({ ...PAGE, viewportH: 844, headerH: 167, headerPosition: 'sticky' });
    const cardTopOnScreen = 651 - top;
    assert.ok(cardTopOnScreen >= 167,
        `card top painted at ${cardTopOnScreen}px, under the 167px sticky header`);
    assert.strictEqual(cardTopOnScreen, 167 + (844 - 167 - 593) / 2,
        'centred in the space below the sticky header');
});

test('F3b3 short viewport — sits just short of the pin threshold, never under it', () => {
    const top = makeTarget({ ...PAGE, viewportH: 620 });
    assert.strictEqual(top, PAGE.heroBottom - 8,
        'reserving would land BELOW the threshold where the header is not pinned, ' +
        'cropping the card for chrome that never appears — sit just short instead');
    assert.ok(top < PAGE.heroBottom, 'must stay on the un-pinned side of the threshold');
    assert.ok(651 - top >= 0, 'the card top must still be on screen');
});

test('F3b4 no card on the page → no target (other pages load main.js too)', () => {
    const src = [lift('inkFinderScrollTop'), lift('pinnedHeaderHeight'),
                 lift('headerPinsFrom'), lift('inkFinderTarget')].join('\n');
    const out = new Function('window', 'document', src + '\nreturn inkFinderTarget();')(
        { pageYOffset: 0, innerHeight: 800, getComputedStyle: () => ({ position: 'relative' }) },
        { querySelector: () => null });
    assert.strictEqual(out, null, 'a page without .ink-finder__wrapper must yield null');
});

test('F3b5 whichever branch runs, the title is never left under the chrome', () => {
    // Sweep viewport heights across all three branches and assert the invariant
    // that the whole bug was about.
    for (let vh = 500; vh <= 1400; vh += 25) {
        for (const sticky of [false, true]) {
            const top = makeTarget({
                ...PAGE, viewportH: vh,
                headerPosition: sticky ? 'sticky' : 'relative'
            });
            const cardTopOnScreen = PAGE.wrapperTop - top;
            const pinned = sticky || top >= PAGE.heroBottom;
            const chrome = pinned ? PAGE.headerH : 0;
            assert.ok(cardTopOnScreen >= chrome,
                `viewport ${vh}, sticky=${sticky}: card top at ${cardTopOnScreen}px ` +
                `with ${chrome}px of chrome above it — the title would be hidden`);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — one implementation, both entry points
// ─────────────────────────────────────────────────────────────────────────────

test('F4 the old full-viewport centring math is gone from every call site', () => {
    for (const [name, src] of [['main.js', MAIN_JS], ['landing.js', LANDING_JS]]) {
        assert.ok(!/windowHeight\s*-\s*wrapperHeight/.test(src),
            `${name}: the hero-CTA copy of the full-viewport centring math must be gone`);
        assert.ok(!/window\.innerHeight\s*-\s*rect\.height/.test(src),
            `${name}: the ?scroll=ink-finder copy of the full-viewport centring math must be gone`);
    }
});

test('F4b both entry points route through scrollToInkFinder', () => {
    assert.match(MAIN_JS, /function\s+scrollToInkFinder\s*\(/,
        'expected the single shared entry point');
    const calls = MAIN_JS.match(/scrollToInkFinder\(/g) || [];
    assert.ok(calls.length >= 3,
        `expected the definition plus both call sites, found ${calls.length} occurrences`);
    // The hero CTA branch.
    assert.match(MAIN_JS, /targetId === '#ink-finder-heading'\)\s*\{\s*\n\s*scrollToInkFinder\(/,
        'the #ink-finder-heading click branch must call scrollToInkFinder');
    // The nav deep link — still load-gated, still strips the param.
    const deep = MAIN_JS.match(/get\('scroll'\) === 'ink-finder'[\s\S]*?\n\}/)[0];
    assert.match(deep, /scrollToInkFinder\(/,
        'the ?scroll=ink-finder deep link must call scrollToInkFinder');
    assert.match(deep, /params\.delete\('scroll'\)/,
        'the deep link must still strip ?scroll= so a reload lands at the top');
    assert.match(deep, /addEventListener\('load'/,
        'the deep link must still wait for load before measuring');
});

test('F4c main.js delegates to window.InkFinderScroll and degrades without it', () => {
    const hook = MAIN_JS.match(/function\s+scrollToInkFinder\s*\([\s\S]*?\n\}/)[0];
    assert.match(hook, /window\.InkFinderScroll/,
        'main.js must delegate to the landing.js implementation');
    assert.match(hook, /scrollIntoView/,
        'if landing.js is absent the click must still move the viewport, not no-op');
    assert.match(LANDING_JS, /window\.InkFinderScroll\s*=\s*\{/,
        'landing.js must publish the namespace main.js delegates to');
    // Execute the hook with the namespace missing — the fallback must not throw
    // (a static assertion can pass on code that throws, ERR-136).
    let intoViewArgs = null;
    const fakeWindow = {};
    const fakeDocument = {
        getElementById: () => ({ scrollIntoView: (o) => { intoViewArgs = o; } })
    };
    new Function('window', 'document', hook + '\nscrollToInkFinder();')(fakeWindow, fakeDocument);
    assert.deepStrictEqual(intoViewArgs, { behavior: 'smooth', block: 'center' },
        'the no-landing.js fallback must scroll the heading into view');
});

test('F4d landing.js ships on every page that has the finder', () => {
    for (const page of ['inkcartridges/index.html', 'inkcartridges/html/index.html']) {
        const html = read(page);
        assert.ok(html.includes('ink-finder__wrapper'), `${page} should have the finder card`);
        assert.match(html, /src="\/js\/landing\.js/,
            `${page} has the finder, so it MUST load landing.js — that is where the ` +
            `scroll geometry lives (main.js only delegates)`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 — the settle pass re-corrects drift, but never fights the user
// ─────────────────────────────────────────────────────────────────────────────

test('F5 correctInkFinderScroll re-measures after settle with a Safari fallback', () => {
    assert.match(LANDING_JS, /function\s+correctInkFinderScroll\s*\(/,
        'expected a settle/correction pass — the target moves mid-flight when the ' +
        'header pins, the mobile header collapses, or #trust-stats un-hides');
    const block = LANDING_JS.match(/function\s+correctInkFinderScroll\s*\([\s\S]*?\n {4}\}\n/)[0];
    assert.match(block, /'scrollend'/, 'must settle on scrollend where available');
    assert.match(block, /setTimeout\(settle/, 'Safari has no scrollend — needs a timeout fallback');
    assert.match(block, /inkFinderTarget\(\)/,
        'the correction must RE-MEASURE, not reuse the stale pre-scroll target');
});

test('F5b the correction cancels on user input or an off-target landing', () => {
    const block = LANDING_JS.match(/function\s+correctInkFinderScroll\s*\([\s\S]*?\n {4}\}\n/)[0];
    for (const evt of ['wheel', 'touchstart', 'keydown']) {
        assert.ok(block.includes(`'${evt}'`),
            `${evt} must cancel the correction — never yank a viewport the user took over`);
    }
    assert.match(block, /Math\.abs\(window\.pageYOffset - aimedTop\) > \d+/,
        'landing far from where we aimed means the user scrolled — skip the correction');
});

// ─────────────────────────────────────────────────────────────────────────────
// F6 — the nav contract these all hang off is unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('F6 the Printer Models link and the finder card markup still match the JS', () => {
    const INDEX = read('inkcartridges/index.html');
    assert.ok(INDEX.includes('href="/?scroll=ink-finder"'),
        'the nav link is the deep-link entry point');
    assert.ok(INDEX.includes('class="ink-finder__wrapper"'),
        'scrollToInkFinder measures .ink-finder__wrapper');
    assert.ok(INDEX.includes('id="ink-finder-heading"'),
        'the heading is both the hero-CTA anchor and the no-wrapper fallback target');
    // pages.css owns the pin that started all this.
    assert.match(read('inkcartridges/css/pages.css'),
        /\.site-header--sticky\s*\{[\s\S]*?position:\s*sticky/,
        '.site-header--sticky must still be the pinned state landing.js toggles');
    assert.match(LANDING_JS, /site-header--sticky/,
        'landing.js is what pins the header once the hero clears — and is therefore ' +
        'where the compensating geometry belongs');
});
