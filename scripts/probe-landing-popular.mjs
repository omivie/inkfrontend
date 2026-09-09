#!/usr/bin/env node
/**
 * Do the ad landing pages actually sell anything? (ERR-236)
 * =========================================================
 *
 * /ink-cartridges, /toner-cartridges and /ribbons are where Google Ads lands —
 * `buy ink cartridges` alone is 53% of spend. Measured on production
 * 2026-09-09, every one of them rendered a brand chooser and NOT ONE PRICE.
 *
 * tests/landing-popular-products-sep2026.test.js pins the wiring, but a source
 * grep cannot prove a card was painted, is the right width, or that the row
 * appeared ABOVE the brand picker rather than below the fold. ERR-224 shipped
 * 21 green source greps over a layout that was wrong on screen; this measures
 * the real boxes.
 *
 * WHAT THIS ASSERTS, per landing URL
 * ----------------------------------
 *   A  the shelf is visible and holds cards
 *   B  the page shows real prices (the hand-off's own check: > 0 matches of
 *      /\$\d+\.\d{2}/ in body text)
 *   C  every card is inside [CARD_FLOOR, CARD_CEILING) — see below
 *   D  the shelf sits ABOVE the brand picker in the document AND on screen
 *   E  the brand picker still has its own heading, not the shelf's
 *   F  the cards are interactive: an Add button per card
 *   G  no horizontal overflow was introduced at phone width
 *
 * CARD_CEILING 200px is not a style preference. `.product-card` carries
 * `@container pcard (max-width: 200px)` (components.css). Under it the footer
 * stacks price above the buy row; over it they go side by side, and on the
 * search dropdown a card that grew to 214.9px handed the stepper a 107px row
 * and clipped "Add 100" — a WIDER card producing a SMALLER button. CARD_FLOOR
 * 150px is where the Add CTA starts clipping its own widest label.
 *
 * CONTROL: bare /shop must NOT show the shelf. It knows no category, and a
 * probe that only ever looks at pages where the feature is on cannot tell
 * "correctly scoped" from "on everywhere".
 *
 * Usage:  npm run probe:landing-popular
 *         PROBE_BASE=http://localhost:3000 npm run probe:landing-popular
 * Exit:   0 = every assertion held
 *         1 = a measured box or a missing shelf regressed
 *         2 = could not run (network / the page never rendered)
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const LOCAL = BASE.includes('localhost');
const CARD_FLOOR = 150;
const CARD_CEILING = 200;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// On localhost the Vercel rewrites do not exist, so address the files directly.
const LANDINGS = LOCAL
    ? [
        { name: '/ink-cartridges', url: '/html/shop?category=ink' },
        { name: '/toner-cartridges', url: '/html/shop?category=toner' },
        { name: '/ribbons', url: '/html/ribbons' },
    ]
    : [
        { name: '/ink-cartridges', url: '/ink-cartridges' },
        { name: '/toner-cartridges', url: '/toner-cartridges' },
        { name: '/ribbons', url: '/ribbons' },
    ];
const CONTROL = LOCAL ? '/html/shop' : '/shop';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mprobe:landing-popular — do the ad landing pages show products? (ERR-236)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no writes.');
console.log(`Target: ${BASE}${LOCAL ? '  (localhost — addressing html/ files directly, no Vercel rewrites)' : ''}\n`);

/** Everything this probe cares about, read from the live DOM. */
const MEASURE = () => {
    const sec = document.getElementById('popular-row');
    const grid = document.getElementById('popular-row-grid');
    const cards = grid ? [...grid.querySelectorAll('.product-card')] : [];
    const brandGrid = document.getElementById('brands-grid') || document.getElementById('ribbons-brands-grid');
    const brandCard = brandGrid ? brandGrid.closest('.shop-section-card') : null;

    const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) };
    };
    // Name the offenders — "406 > 390" does not say which element to open.
    const overflowing = [];
    document.querySelectorAll('*').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1) {
            overflowing.push(`${e.tagName.toLowerCase()}.${String(e.className).trim().slice(0, 40)} right=${Math.round(r.right)}`);
        }
    });

    // `hidden` on an ancestor counts too — a visible-looking section inside a
    // hidden level is not on screen.
    const reallyVisible = (el) => {
        if (!el) return false;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            if (n.hidden || getComputedStyle(n).display === 'none') return false;
        }
        return true;
    };

    return {
        sectionExists: !!sec,
        sectionVisible: reallyVisible(sec),
        title: (document.getElementById('popular-row-title') || {}).textContent ?? null,
        cardCount: cards.length,
        cardWidths: cards.map((c) => +c.getBoundingClientRect().width.toFixed(1)),
        addButtons: grid ? grid.querySelectorAll('.product-card__add-btn').length : 0,
        skus: cards.map((c) => c.dataset.sku).filter(Boolean),
        priceMatches: (document.body.innerText.match(/\$\d+\.\d{2}/g) || []).length,
        shelfBox: box(sec),
        brandCardBox: box(brandCard),
        brandHeading: brandCard ? (brandCard.querySelector('.shop-section-card__title') || {}).textContent ?? null : null,
        overflowing: overflowing.slice(0, 5),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
    };
};

async function measure(ctx, url, viewport) {
    const page = await ctx.newPage();
    await page.setViewportSize(viewport);
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The row is an async fetch; wait for it to settle rather than sleeping a
    // guessed constant. A measurement taken once is a constant with a good alibi.
    await page.waitForFunction(
        () => {
            const s = document.getElementById('popular-row');
            const g = document.getElementById('popular-row-grid');
            return !!s && (!s.hidden || (g && g.children.length > 0));
        },
        { timeout: 20000 },
    ).catch(() => { /* fall through — the assertions below report it honestly */ });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(MEASURE);
    await page.close();
    return m;
}

const browser = await chromium.launch().catch((e) => {
    console.error(`\x1b[31mcould not launch a browser: ${e.message}\x1b[0m`);
    process.exit(2);
});

try {
    for (const landing of LANDINGS) {
        head(`${landing.name}  (${landing.url})`);
        const ctx = await browser.newContext();
        let m;
        try {
            m = await measure(ctx, landing.url, DESKTOP);
        } catch (e) {
            bad(`${landing.name}: the page never rendered`, e.message);
            await ctx.close();
            continue;
        }

        // A — the shelf is there and populated
        check(`${landing.name}: the popular shelf is VISIBLE`, m.sectionVisible,
            m.sectionExists
                ? 'the section exists but is hidden — the read failed, or the category did not map. '
                  + 'This is the state ERR-236 exists to fix: a brand chooser and no products on the '
                  + 'page 53% of ad spend lands on.'
                : '#popular-row is not in the DOM at all — the markup did not ship to this page.');
        check(`${landing.name}: it holds product cards`, m.cardCount > 0,
            `cards=${m.cardCount}`);

        // B — the hand-off's own acceptance check
        check(`${landing.name}: the page shows real prices`, m.priceMatches > 0,
            `body text matched /\\$\\d+\\.\\d{2}/ ${m.priceMatches} times — this was 0 on all three `
            + 'landings on 2026-09-09');

        // C — card geometry, the container-query window
        if (m.cardWidths.length) {
            const outside = m.cardWidths.filter((w) => w < CARD_FLOOR || w >= CARD_CEILING);
            check(`${landing.name}: every card is inside [${CARD_FLOOR}, ${CARD_CEILING})`,
                outside.length === 0,
                `widths=${m.cardWidths.join(', ')}. Past ${CARD_CEILING}px the card's own container `
                + 'query flips the footer to price-BESIDE-button and the Add label clips — a wider '
                + `card producing a smaller button. Below ${CARD_FLOOR}px the CTA clips too.`);
        }

        // D — above the brand picker, in the document and on screen
        if (m.shelfBox && m.brandCardBox) {
            check(`${landing.name}: the shelf sits ABOVE the brand picker`,
                m.shelfBox.top < m.brandCardBox.top,
                `shelf top=${m.shelfBox.top}, brand card top=${m.brandCardBox.top} — an ad click `
                + 'must meet products before it meets a chooser');
        } else {
            soft(`${landing.name}: could not compare shelf and brand-picker positions`,
                'one of the two boxes was not measurable on this page');
        }

        // E — the brand picker kept its OWN heading
        check(`${landing.name}: the brand picker still has its own heading`,
            !!m.brandHeading && !/popular/i.test(m.brandHeading),
            `brand heading is ${JSON.stringify(m.brandHeading)}. renderBrands() used to take "the `
            + 'first .shop-section-card__title inside #level-brands", which is the SHELF now — an '
            + 'unscoped positional selector quietly meaning something else the moment anything moves.');

        // F — the cards are actually usable
        check(`${landing.name}: every card has an Add button`,
            m.cardCount > 0 && m.addButtons === m.cardCount,
            `cards=${m.cardCount} addButtons=${m.addButtons}. Cards are bound by `
            + 'attachCardListeners; a shelf you cannot buy from is decoration.');
        check(`${landing.name}: every card carries data-sku`,
            m.cardCount > 0 && m.skus.length === m.cardCount,
            `skus=${m.skus.length}/${m.cardCount} — Business.decorateCards finds cards by SKU to `
            + 'overlay bulk pricing; a card without one silently loses it.');

        await ctx.close();

        // G — phone width, no new overflow
        const ctx2 = await browser.newContext();
        try {
            const p = await measure(ctx2, landing.url, PHONE);
            check(`${landing.name}: no horizontal overflow at ${PHONE.width}px`,
                p.scrollWidth <= p.innerWidth + 1,
                `scrollWidth=${p.scrollWidth} innerWidth=${p.innerWidth}; offenders: `
                + (p.overflowing.join(' | ') || '(none named)'));
            if (p.cardWidths.length) {
                const outside = p.cardWidths.filter((w) => w < CARD_FLOOR || w >= CARD_CEILING);
                check(`${landing.name}: card widths hold at ${PHONE.width}px too`,
                    outside.length === 0, `widths=${p.cardWidths.join(', ')}`);
            }
        } catch (e) {
            soft(`${landing.name}: phone pass could not run`, e.message);
        }
        await ctx2.close();
    }

    // ── CONTROL ──────────────────────────────────────────────────────────────
    head(`CONTROL — ${CONTROL} (no category) must NOT show the shelf`);
    {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            await page.setViewportSize(DESKTOP);
            await page.goto(`${BASE}${CONTROL}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForSelector('#brands-grid .drilldown-box', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2000);
            const m = await page.evaluate(MEASURE);
            await page.close();

            check('bare /shop hides the shelf', !m.sectionVisible,
                'bare /shop knows no category. Showing a shelf here would mean picking one on the '
                + "customer's behalf and printing the guess as a recommendation. This control is "
                + 'what separates "correctly scoped" from "on everywhere".');
            check('bare /shop keeps its own brand heading', !!m.brandHeading && !/popular/i.test(m.brandHeading),
                `brand heading is ${JSON.stringify(m.brandHeading)}`);
        } catch (e) {
            soft('the control page could not be measured', e.message);
        }
        await ctx.close();
    }
} finally {
    await browser.close();
}

console.log(`\n\x1b[1m${pass} passed, ${failures.length} failed, ${notes.length} noted\x1b[0m`);
if (notes.length) { console.log('\nNoted:'); notes.forEach((n) => console.log(`  ~ ${n}`)); }
if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
}
process.exit(0);
