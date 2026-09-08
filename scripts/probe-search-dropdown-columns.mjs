#!/usr/bin/env node
/**
 * probe-search-dropdown-columns — does the panel actually paint two columns?
 * =========================================================================
 *
 * Sep-2026. The typeahead dropdown used to STACK its two source sections:
 * Compatible in a 7-up grid, Genuine in another one underneath it. Genuine
 * therefore started below the fold on essentially every query. It now lays
 * them side by side — Compatible left, Genuine right, three cards to a row in
 * each, six across the panel — and falls back to one full-width six-up section
 * when only one source came back.
 *
 * None of that is provable by grepping CSS. A `grid-template-columns:
 * repeat(3, …)` in the stylesheet says a rule was written, not that three
 * cards shared a top edge in a browser; ERR-224 shipped 21 green source-grep
 * tests over a layout that was wrong on screen. So this probe asks the browser
 * the four questions the change is actually about:
 *
 *   1. Are the two sections SIDE BY SIDE — same top edge, disjoint x-ranges?
 *   2. How many cards actually share a row inside each column?
 *   3. When only one source comes back, does it take the WHOLE panel width?
 *   4. Does any of it overflow — panel, column, or card?
 *
 * It counts distinct card top-edges rather than reading CSS back, so it would
 * catch a `min-width` still forcing a fourth card onto the next line, or a
 * column silently collapsing to one.
 *
 * A NOTE ON THE SINGLE-SOURCE CASE: which queries return only one source is a
 * property of live data, not of this repo, so the probe DISCOVERS one by
 * trying candidates. If none of them yields a single-source panel it reports
 * that as an UNPROVEN check, not a pass — a gate that declines to run has to
 * say so by name.
 *
 * READ-ONLY. It navigates, types, and measures. It writes nothing.
 *
 *   npm run probe:search-columns
 *   PROBE_BASE=http://localhost:3000 npm run probe:search-columns
 *
 * Exit code 0 = every assertion held.
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const PAGE = process.env.PROBE_PATH || '/';
const TWO_SOURCE_QUERY = process.env.PROBE_QUERY || 'lc531';
// Candidates for a result set with only ONE source. Nothing here is asserted
// to exist — the probe uses whichever one the live catalogue actually answers
// with a single section, and says so if none does.
const SINGLE_SOURCE_CANDIDATES = ['ap830', 'kx-p', 'dpk', 'maintenance box', 'sp650'];

// Per-viewport expectation. The panel is min(1120, innerWidth - 32), a split
// column is half of that, and the card count per row steps down as the column
// narrows — 3 while the column can hold three readable cards, then 2, then 1.
// MEASURED, not assumed — and 960px is in this list because it is where the
// first attempt was wrong. At 1024px a split column is 483px and three cards
// land at 151.5px, which the compact stepper fits. At 960px the same three
// cards measure 141.3px and the CTA clips its widest label. So 3-up stops at
// 1024, and 960 is pinned here so it cannot quietly come back.
const VIEWPORTS = [
    { width: 1440, height: 900, splitTracks: 3, singleTracks: 6 },
    { width: 1024, height: 800, splitTracks: 3, singleTracks: 6 },
    { width: 960,  height: 800, splitTracks: 2, singleTracks: 4 },
    { width: 768,  height: 800, splitTracks: 2, singleTracks: 4 },
    { width: 375,  height: 812, splitTracks: 1, singleTracks: 1 },
];

// The compact dropdown stepper (search.css, ERR-218) is sized against this
// floor. A card below it clips its own Add label at high quantities, which is
// exactly the bug ERR-218 exists to prevent — so the probe measures the card,
// not just the track count.
const CARD_FLOOR_PX = 150;

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function unproven(name, detail) {
    results.push({ name, ok: false, unproven: true, detail });
    console.log(`  ⚠️  UNPROVEN: ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Everything the layout question needs, read off the painted boxes.
 * Cards are grouped by their rounded top edge: the size of the largest group
 * IS the cards-per-row the shopper sees, whatever the stylesheet claims.
 */
async function measure(page) {
    return page.evaluate(() => {
        const dd = document.querySelector('.smart-ac-dropdown.is-open')
            || document.querySelector('.smart-ac-dropdown');
        if (!dd) return { missing: 'no dropdown' };
        const wrap = dd.querySelector('.smart-ac__sections');
        const round = (n) => Math.round(n);
        const r1 = (n) => Math.round(n * 10) / 10;

        const mode = !wrap ? 'none'
            : wrap.classList.contains('smart-ac__sections--split') ? 'split'
            : wrap.classList.contains('smart-ac__sections--single') ? 'single'
            : 'unclassified';

        const sections = [...dd.querySelectorAll('.smart-ac__section')].map((sec) => {
            const rect = sec.getBoundingClientRect();
            const badge = sec.querySelector('.products-section__badge');
            const grid = sec.querySelector('.smart-ac__grid');
            const cards = [...sec.querySelectorAll('.product-card')];
            const byTop = new Map();
            for (const c of cards) {
                const t = round(c.getBoundingClientRect().top);
                byTop.set(t, (byTop.get(t) || 0) + 1);
            }
            const perRowCounts = [...byTop.values()];
            const widths = cards.map((c) => r1(c.getBoundingClientRect().width));
            // The resolved track list — the grid's CAPACITY. Distinct from
            // `perRow` below, which is the widest row actually painted and is
            // capped by family size as well as by track count: a three-member
            // family broken onto its own row never fills six tracks, so
            // `perRow` alone cannot tell a 6-up grid from a 3-up one.
            const tracks = grid
                ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length
                : 0;
            // ERR-218's question, asked of the painted button rather than of
            // arithmetic: at the widest label QtyStepper.ctaLabel can produce,
            // does the CTA still fit? Relabel through the real vocabulary, read
            // the overflow, put the label back.
            let ctaClipped = null;
            let ctaWidestLabel = null;
            const cta = sec.querySelector('.product-card__add-btn');
            if (cta && typeof QtyStepper !== 'undefined' && QtyStepper.ctaLabel) {
                const before = cta.textContent;
                ctaWidestLabel = QtyStepper.ctaLabel(QtyStepper.ceiling ? QtyStepper.ceiling() : 100);
                cta.textContent = ctaWidestLabel;
                ctaClipped = Math.max(0, cta.scrollWidth - cta.clientWidth);
                cta.textContent = before;
            }
            return {
                tracks,
                ctaClipped,
                ctaWidestLabel,
                label: badge ? badge.textContent.trim() : '(no badge)',
                left: round(rect.left), right: round(rect.right),
                top: round(rect.top), width: round(rect.width),
                cards: cards.length,
                rows: byTop.size,
                perRow: perRowCounts.length ? Math.max(...perRowCounts) : 0,
                cardWidth: widths.length ? widths[0] : null,
                widestCard: widths.length ? Math.max(...widths) : null,
                gridOverflow: grid ? grid.scrollWidth - grid.clientWidth : null,
            };
        });

        const footer = dd.querySelector('.smart-ac__view-all');
        return {
            mode,
            sections,
            panel: {
                left: round(dd.getBoundingClientRect().left),
                width: round(dd.getBoundingClientRect().width),
                clientWidth: dd.clientWidth,
                bottom: round(dd.getBoundingClientRect().bottom),
                overflowX: dd.scrollWidth - dd.clientWidth,
            },
            footerBottom: footer ? round(footer.getBoundingClientRect().bottom) : null,
            viewportH: window.innerHeight,
            viewportW: window.innerWidth,
        };
    });
}

async function typeQuery(page, query) {
    const input = page.locator('#search-input').first();
    await input.fill('');
    await input.pressSequentially(query, { delay: 40 });
    // Poll for the panel instead of sleeping a guessed interval.
    await page.waitForFunction(() => {
        const dd = document.querySelector('.smart-ac-dropdown');
        return !!(dd && dd.querySelector('.smart-ac__section .product-card'));
    }, null, { timeout: 12000 }).catch(() => {});
}

console.log(`\n\x1b[1mprobe:search-columns — Compatible left / Genuine right, measured\x1b[0m`);
console.log(`   base: ${BASE}${PAGE}\n`);

const browser = await chromium.launch();
let singleSourceProvenAt = null;

try {
    for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        await page.goto(`${BASE}${PAGE}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(600);

        console.log(`\x1b[1m§ ${vp.width}×${vp.height} — two-source query "${TWO_SOURCE_QUERY}"\x1b[0m`);
        await typeQuery(page, TWO_SOURCE_QUERY);
        const m = await measure(page);

        if (m.missing || !m.sections || m.sections.length === 0) {
            check(`${vp.width}px: the panel has result sections`, false, m.missing || 'no sections');
            await ctx.close();
            continue;
        }

        console.log(`     panel: ${m.panel.width}px wide at x=${m.panel.left}, mode=${m.mode}`);
        for (const s of m.sections) {
            console.log(`     ${s.label.padEnd(11)} x=${s.left}..${s.right} (${s.width}px) top=${s.top} `
                + `· ${s.tracks} tracks, ${s.cards} cards in ${s.rows} rows `
                + `(widest ${s.perRow}), card ${s.cardWidth}px`);
        }

        if (m.sections.length === 2) {
            const [a, b] = m.sections;
            check(`${vp.width}px: mode is --split when both sources came back`,
                m.mode === 'split', `mode=${m.mode}`);
            check(`${vp.width}px: Compatible is the LEFT column, Genuine the RIGHT`,
                /compatible/i.test(a.label) && /genuine/i.test(b.label) && a.left < b.left,
                `${a.label}@${a.left} then ${b.label}@${b.left}`);
            check(`${vp.width}px: the two sections share a top edge (side by side, not stacked)`,
                Math.abs(a.top - b.top) <= 1, `tops ${a.top} vs ${b.top}`);
            check(`${vp.width}px: the columns do not overlap`,
                a.right <= b.left + 1, `left ends ${a.right}, right starts ${b.left}`);
            check(`${vp.width}px: each column is ${vp.splitTracks} track(s) wide`,
                a.tracks === vp.splitTracks && b.tracks === vp.splitTracks,
                `compatible ${a.tracks}, genuine ${b.tracks} (expected ${vp.splitTracks})`);
            check(`${vp.width}px: ${vp.splitTracks * 2} cards across the panel in total`,
                a.tracks + b.tracks === vp.splitTracks * 2,
                `${a.tracks} + ${b.tracks} = ${a.tracks + b.tracks}`);
            check(`${vp.width}px: no row paints more cards than the column has tracks`,
                a.perRow <= a.tracks && b.perRow <= b.tracks,
                `widest rows ${a.perRow} / ${b.perRow} against ${a.tracks} tracks`);
            check(`${vp.width}px: neither column overflows its track`,
                (a.gridOverflow ?? 0) <= 1 && (b.gridOverflow ?? 0) <= 1,
                `overflow ${a.gridOverflow} / ${b.gridOverflow}px`);
            // The floor guards the COMPACT stepper, which only runs above the
            // 480px breakpoint; below that the buy row wraps and the CTA takes
            // a full line of its own, so the clip check below is the guard.
            if (vp.width > 480) {
                check(`${vp.width}px: cards stay above the ${CARD_FLOOR_PX}px stepper floor`,
                    a.cardWidth >= CARD_FLOOR_PX && b.cardWidth >= CARD_FLOOR_PX,
                    `narrowest card ${Math.min(a.cardWidth, b.cardWidth)}px`);
            }
            check(`${vp.width}px: the Add CTA is not clipped at its widest label`,
                a.ctaClipped === 0 && b.ctaClipped === 0,
                `clipped by ${a.ctaClipped} / ${b.ctaClipped}px at "${a.ctaWidestLabel}"`);
        } else {
            check(`${vp.width}px: "${TWO_SOURCE_QUERY}" returns two sources to split`,
                false, `got ${m.sections.length} section(s): ${m.sections.map(s => s.label).join(', ')}`);
        }

        check(`${vp.width}px: the panel itself does not scroll sideways`,
            m.panel.overflowX <= 1, `${m.panel.overflowX}px of horizontal overflow`);
        check(`${vp.width}px: the panel stays inside the fold`,
            m.panel.bottom <= m.viewportH, `bottom ${m.panel.bottom} vs fold ${m.viewportH}`);
        if (m.footerBottom !== null) {
            check(`${vp.width}px: the sticky "View all results" footer is on screen`,
                m.footerBottom <= m.viewportH + 1, `footer bottom ${m.footerBottom} vs fold ${m.viewportH}`);
        }

        // ── The single-source fallback: one section, full panel width ──────
        if (!singleSourceProvenAt) {
            for (const q of SINGLE_SOURCE_CANDIDATES) {
                await typeQuery(page, q);
                const one = await measure(page);
                if (one.missing || !one.sections || one.sections.length !== 1) continue;

                console.log(`\x1b[1m  single-source query "${q}"\x1b[0m`);
                console.log(`     ${one.sections[0].label} spans ${one.sections[0].width}px `
                    + `of a ${one.panel.clientWidth}px panel · ${one.sections[0].tracks} tracks, `
                    + `widest row ${one.sections[0].perRow}, card ${one.sections[0].cardWidth}px`);
                const s = one.sections[0];
                check(`${vp.width}px: a single source is marked --single`,
                    one.mode === 'single', `mode=${one.mode}`);
                check(`${vp.width}px: the surviving section takes the WHOLE panel width`,
                    Math.abs(s.width - one.panel.clientWidth) <= 2,
                    `section ${s.width}px vs panel ${one.panel.clientWidth}px`);
                check(`${vp.width}px: it runs ${vp.singleTracks} tracks full-width`,
                    s.tracks === vp.singleTracks,
                    `${s.tracks} tracks, widest painted row ${s.perRow} (expected ${vp.singleTracks})`);
                check(`${vp.width}px: the full-width section does not overflow`,
                    (s.gridOverflow ?? 0) <= 1, `${s.gridOverflow}px`);
                singleSourceProvenAt = `${q} @ ${vp.width}px`;
                break;
            }
        }

        await ctx.close();
        console.log('');
    }
} finally {
    await browser.close();
}

if (!singleSourceProvenAt) {
    unproven('the single-source full-width fallback was never exercised',
        `none of [${SINGLE_SOURCE_CANDIDATES.join(', ')}] returned exactly one section — `
        + 'set PROBE_QUERY to a query you know has only one source, or add one to '
        + 'SINGLE_SOURCE_CANDIDATES. This is NOT a pass.');
} else {
    console.log(`  single-source fallback proven with: ${singleSourceProvenAt}\n`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.unproven ? '[UNPROVEN] ' : ''}${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exit(1);
}
console.log('\x1b[32mTwo columns of three, measured in a browser.\x1b[0m\n');
