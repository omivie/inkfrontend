#!/usr/bin/env node
/**
 * probe-shop-source-columns — do /shop and /search paint two source columns?
 * ==========================================================================
 *
 * Sep-2026. The shop page used to STACK its two sources: #compatible-section
 * above #genuine-section, each a 7-across flex row, so the Genuine set began a
 * full section down the page and the two prices for the same colour were never
 * on screen together. They sit side by side now — Compatible left, Genuine
 * right, three cards to a row in each — collapsing to one full-width six-up
 * section when only one source has rows.
 *
 * /search is a Vercel rewrite onto the same shell (/html/shop), as are
 * /ink-cartridges and /toner-cartridges, so this probe drives both URLs
 * against the one file.
 *
 * WHY A PROBE AND NOT ANOTHER GREP. `.products-row` is a wrapping FLEX
 * container: how many cards land on a row is decided by a computed flex-basis
 * against a container width, not by anything a stylesheet states outright. A
 * source grep can confirm `33.333%` was typed; only a browser can say three
 * cards shared a top edge. ERR-224 shipped 21 green source greps over a layout
 * that was wrong on screen.
 *
 * The two numbers this asserts are both scars:
 *
 *   - CARD_CEILING 200px. .product-card carries `@container pcard (max-width:
 *     200px)` (components.css). Under it the footer stacks price above the buy
 *     row; over it they go side by side. On the search dropdown a card that
 *     grew to 214.9px handed the compact stepper a 107px row and clipped
 *     "Add 100" — a WIDER card producing a SMALLER button.
 *   - CARD_FLOOR 150px. Below it the Add CTA clips its own widest label.
 *
 * READ-ONLY. It navigates and measures. It writes nothing.
 *
 *   npm run probe:shop-columns
 *   PROBE_BASE=http://localhost:3000 npm run probe:shop-columns
 *
 * Exit code 0 = every assertion held.
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const CODE_URL = process.env.PROBE_SHOP_PATH || '/shop?brand=brother&category=ink&code=LC3317';
const SEARCH_URL = process.env.PROBE_SEARCH_PATH || '/search?q=lc531';

const CARD_FLOOR = 150;
const CARD_CEILING = 200;

// Expected cards per row, MEASURED. --split is 2-up by default and 3-up from
// 1200px, dropping to 1-up under 768px. --single is left on the page's existing
// global ladder (6 / 5 / 2), which this change deliberately does not touch.
const VIEWPORTS = [
    { width: 1440, height: 900, split: 3, single: 6 },
    { width: 1280, height: 900, split: 3, single: 6 },
    { width: 1024, height: 900, split: 2, single: 6 },
    { width: 768,  height: 900, split: 2, single: 5 },
    { width: 375,  height: 812, split: 1, single: 2 },
];

/**
 * WHAT THIS PROBE DOES AND DOES NOT OWN.
 *
 * The card width in --split is set by this change, so its CTA fit is asserted
 * outright. Below 1100px a --single section is sized by the page's ORIGINAL
 * global ladder, which this change does not touch — and that ladder has always
 * clipped the Add CTA. Measured on shipped HEAD (aac29c0), stacked full-width:
 *
 *     1440px  6-up  162.3px  clips 3px      768px  5-up  136.0px  clips 16px
 *     1200px  6-up  156.6px  clips 5px      700px  5-up  122.4px  clips 23px
 *     1100px  6-up  142.3px  clips 13px     600px  4-up  120.0px  clips 24px
 *     1024px  6-up  154.7px  clips 6px      375px  2-up  159.5px  clips 1px
 *
 * So single-mode CTA fit is NOT asserted as pass/fail — it would fail on debt
 * this change did not create. It is asserted against the frozen baseline
 * instead: below 1100px a --single card must still measure what it measured
 * before, which catches a regression without pretending the debt is fixed. The
 * gap is PRINTED by name, never silently skipped.
 */
const SINGLE_BASELINE = { 1024: 154.7, 768: 136, 375: 159.5 };

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Read the painted sections. Cards are grouped by rounded top edge: the size of
 * the largest group IS the cards-per-row a shopper sees. Unlike the dropdown's
 * CSS-Grid columns there is no track list to fall back on here — a flex row has
 * no tracks — so the computed flex-basis is reported alongside it, and a row
 * that comes up short because a family row-break ended it early is visible as a
 * disagreement between the two rather than as a silent pass.
 */
async function measure(page) {
    return page.evaluate(({ FLOOR, CEIL }) => {
        const wrap = document.getElementById('source-sections');
        if (!wrap) return { missing: 'no .products-sections wrapper' };
        const round = (n) => Math.round(n);
        const r1 = (n) => Math.round(n * 10) / 10;

        const mode = wrap.classList.contains('products-sections--split') ? 'split'
            : wrap.classList.contains('products-sections--single') ? 'single'
            : 'unclassified';

        const sections = [...wrap.querySelectorAll('.products-section')]
            .filter((sec) => !sec.hidden && sec.getBoundingClientRect().height > 0)
            .map((sec) => {
                const rect = sec.getBoundingClientRect();
                const badge = sec.querySelector('.products-section__badge');
                const row = sec.querySelector('.products-row');
                const cards = [...sec.querySelectorAll('.product-card')];
                const byTop = new Map();
                for (const c of cards) {
                    const t = round(c.getBoundingClientRect().top);
                    byTop.set(t, (byTop.get(t) || 0) + 1);
                }
                const widths = cards.map((c) => r1(c.getBoundingClientRect().width));

                // ERR-218's question asked of the painted button: at the widest
                // label QtyStepper.ctaLabel can produce, does the CTA still fit?
                let ctaClipped = null;
                let ctaLabel = null;
                const cta = sec.querySelector('.product-card__cart-btn, .product-card__add-btn');
                const footerRow = cta ? cta.closest('.product-card__footer-row') : null;
                if (cta && typeof QtyStepper !== 'undefined' && QtyStepper.ctaLabel) {
                    const before = cta.textContent;
                    ctaLabel = QtyStepper.ctaLabel(QtyStepper.ceiling ? QtyStepper.ceiling() : 100);
                    cta.textContent = ctaLabel;
                    ctaClipped = Math.max(0, cta.scrollWidth - cta.clientWidth);
                    cta.textContent = before;
                }

                return {
                    label: badge ? badge.textContent.trim() : '(no badge)',
                    left: round(rect.left), right: round(rect.right),
                    top: round(rect.top), width: round(rect.width),
                    cards: cards.length,
                    rows: byTop.size,
                    perRow: byTop.size ? Math.max(...byTop.values()) : 0,
                    basis: row ? getComputedStyle(row.querySelector('.product-card') || row).flexBasis : null,
                    cardWidth: widths.length ? widths[0] : null,
                    narrowest: widths.length ? Math.min(...widths) : null,
                    widest: widths.length ? Math.max(...widths) : null,
                    rowOverflow: row ? row.scrollWidth - row.clientWidth : null,
                    footerDirection: footerRow ? getComputedStyle(footerRow).flexDirection : null,
                    ctaClipped, ctaLabel,
                };
            });

        const host = wrap.getBoundingClientRect();
        return {
            mode, sections,
            wrapWidth: round(host.width),
            wrapClient: wrap.clientWidth,
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            viewportW: window.innerWidth,
        };
    }, { FLOOR: CARD_FLOOR, CEIL: CARD_CEILING });
}

/**
 * Returns false when the cards never arrived. The caller reports THAT, rather
 * than measuring an empty page and calling it a layout failure: a probe that
 * cannot tell "the layout is wrong" from "the data never loaded" will
 * eventually blame the wrong thing.
 */
async function load(page, url) {
    // One retry: the drilldown takes several API round-trips and a cold backend
    // occasionally misses the window. A transient fetch is not a finding, but a
    // repeatable one is — so retry once, then report it as a DATA failure by
    // name rather than measuring an empty page and blaming the layout.
    for (let attempt = 1; attempt <= 2; attempt++) {
        await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
        // Poll for real cards rather than sleeping a guessed interval.
        const ok = await page.waitForFunction(() => {
            const w = document.getElementById('source-sections');
            return !!(w && w.querySelector('.products-section:not([hidden]) .product-card'));
        }, null, { timeout: 30000 }).then(() => true).catch(() => false);
        if (ok) return true;
        if (attempt === 1) console.log('     (cards did not arrive — retrying once)');
    }
    return false;
}

console.log('\n\x1b[1mprobe:shop-columns — Compatible left / Genuine right on /shop and /search\x1b[0m');
console.log(`   base: ${BASE}\n`);

const browser = await chromium.launch();

try {
    for (const vp of VIEWPORTS) {
        for (const [label, url] of [['/shop code drilldown', CODE_URL], ['/search results', SEARCH_URL]]) {
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            const page = await ctx.newPage();
            const loaded = await load(page, url);
            if (!loaded) {
                check(`${vp.width}px ${label}: product cards loaded at all`, false,
                    'timed out waiting for cards — DATA problem, not a layout one');
                await ctx.close();
                continue;
            }
            const m = await measure(page);

            console.log(`\x1b[1m§ ${vp.width}×${vp.height} — ${label}\x1b[0m`);
            if (m.missing || !m.sections || !m.sections.length) {
                check(`${vp.width}px ${label}: the page has visible source sections`,
                    false, m.missing || 'no visible sections');
                await ctx.close();
                continue;
            }
            console.log(`     wrapper ${m.wrapClient}px, mode=${m.mode}`);
            for (const s of m.sections) {
                console.log(`     ${s.label.padEnd(11)} x=${s.left}..${s.right} (${s.width}px) top=${s.top} `
                    + `· ${s.cards} cards in ${s.rows} rows, ${s.perRow}/row, `
                    + `card ${s.cardWidth}px (basis ${s.basis})`);
            }

            const expected = m.mode === 'split' ? vp.split : vp.single;

            if (m.mode === 'split') {
                const [a, b] = m.sections;
                check(`${vp.width}px ${label}: both sources are showing`,
                    m.sections.length === 2, `${m.sections.length} section(s)`);
                if (m.sections.length === 2) {
                    check(`${vp.width}px ${label}: Compatible LEFT, Genuine RIGHT`,
                        /compatible/i.test(a.label) && /genuine/i.test(b.label) && a.left < b.left,
                        `${a.label}@${a.left} then ${b.label}@${b.left}`);
                    check(`${vp.width}px ${label}: the two sections share a top edge`,
                        Math.abs(a.top - b.top) <= 1, `tops ${a.top} vs ${b.top}`);
                    check(`${vp.width}px ${label}: the columns do not overlap`,
                        a.right <= b.left + 1, `left ends ${a.right}, right starts ${b.left}`);
                }
            } else {
                check(`${vp.width}px ${label}: a lone section takes the WHOLE width`,
                    Math.abs(m.sections[0].width - m.wrapClient) <= 2,
                    `section ${m.sections[0].width}px vs wrapper ${m.wrapClient}px`);
            }

            for (const s of m.sections) {
                check(`${vp.width}px ${label}: ${s.label} paints ${expected} card(s) per row`,
                    s.perRow === expected, `${s.perRow}/row (expected ${expected}), basis ${s.basis}`);
                check(`${vp.width}px ${label}: ${s.label} cards stay under the ${CARD_CEILING}px footer-flip ceiling`,
                    s.widest < CARD_CEILING, `widest ${s.widest}px`);
                check(`${vp.width}px ${label}: ${s.label} footer stays stacked (container query did not flip)`,
                    s.footerDirection === 'column', `flex-direction: ${s.footerDirection}`);
                check(`${vp.width}px ${label}: ${s.label} row does not overflow`,
                    (s.rowOverflow ?? 0) <= 1, `${s.rowOverflow}px`);

                if (m.mode === 'split') {
                    // This change owns the width here, so the CTA must fit outright.
                    check(`${vp.width}px ${label}: ${s.label} cards clear the ${CARD_FLOOR}px CTA floor`,
                        s.narrowest >= CARD_FLOOR, `narrowest ${s.narrowest}px`);
                    check(`${vp.width}px ${label}: ${s.label} Add CTA is not clipped at its widest label`,
                        s.ctaClipped === 0, `clipped ${s.ctaClipped}px at "${s.ctaLabel}"`);
                } else if (vp.width >= 1100) {
                    check(`${vp.width}px ${label}: ${s.label} Add CTA is not clipped at its widest label`,
                        s.ctaClipped === 0, `clipped ${s.ctaClipped}px at "${s.ctaLabel}"`);
                } else if (SINGLE_BASELINE[vp.width]) {
                    console.log(`     ↳ NOT ASSERTED (pre-existing, see SINGLE_BASELINE): `
                        + `single-mode CTA clips ${s.ctaClipped}px at "${s.ctaLabel}" on the untouched global ladder`);
                    check(`${vp.width}px ${label}: ${s.label} single-mode width unchanged from shipped baseline`,
                        Math.abs(s.cardWidth - SINGLE_BASELINE[vp.width]) <= 1,
                        `${s.cardWidth}px vs baseline ${SINGLE_BASELINE[vp.width]}px`);
                }
            }
            check(`${vp.width}px ${label}: the page does not scroll sideways`,
                m.pageOverflow <= 1, `${m.pageOverflow}px`);

            await ctx.close();
            console.log('');
        }
    }

    // ── The single-source fallback, driven deterministically ──────────────
    // ?type=genuine empties compatible and vice versa (shop-page.js), so this
    // needs no discovery and cannot quietly skip.
    for (const [type, expectBadge] of [['genuine', /genuine/i], ['compatible', /compatible/i]]) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        const loaded = await load(page, `${CODE_URL}&type=${type}`);
        if (!loaded) {
            check(`?type=${type}: product cards loaded at all`, false,
                'timed out waiting for cards — DATA problem, not a layout one');
            await ctx.close();
            continue;
        }
        const m = await measure(page);
        console.log(`\x1b[1m§ 1440px — ?type=${type} (single source)\x1b[0m`);
        if (m.missing || !m.sections || !m.sections.length) {
            check(`?type=${type}: the surviving section renders`, false, m.missing || 'nothing visible');
        } else {
            const s = m.sections[0];
            console.log(`     ${s.label} spans ${s.width}px of ${m.wrapClient}px · ${s.perRow}/row, card ${s.cardWidth}px`);
            check(`?type=${type}: exactly one section is showing`,
                m.sections.length === 1, `${m.sections.length} visible`);
            check(`?type=${type}: it is the ${type} one`,
                expectBadge.test(s.label), s.label);
            check(`?type=${type}: the wrapper is marked --single`,
                m.mode === 'single', `mode=${m.mode}`);
            check(`?type=${type}: it takes the WHOLE width, not half a split grid`,
                Math.abs(s.width - m.wrapClient) <= 2,
                `section ${s.width}px vs wrapper ${m.wrapClient}px`);
            check(`?type=${type}: it runs 6 cards per row full-width`,
                s.perRow === 6, `${s.perRow}/row, basis ${s.basis}`);
            check(`?type=${type}: cards stay inside ${CARD_FLOOR}–${CARD_CEILING}px`,
                s.narrowest >= CARD_FLOOR && s.widest < CARD_CEILING,
                `${s.narrowest}–${s.widest}px`);
        }
        await ctx.close();
        console.log('');
    }
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exit(1);
}
console.log('\x1b[32mTwo source columns of three, measured in a browser.\x1b[0m\n');
