#!/usr/bin/env node
/**
 * probe:series-source — the series page honours `&source=` on ad landing pages
 * ============================================================================
 * backend-docs/inbox/series-page-source-filter-FE-handoff-oct2026.md
 * (2026-10-08, FE master checklist item 21). The "Winners" / "Exclusive"
 * Search ad groups land on /shop?brand=…&code=…&source=compatible|genuine.
 * Before the fix the page sent no `source` and showed both versions.
 *
 *   §1 API contract (plain GETs, no browser): LC3319XL and LC3319 with
 *      source=compatible ⇒ 6, without ⇒ 12, source=bogus ⇒ 400, HP 965
 *      pack=value_pack ⇒ 4. If these moved, the page checks below cannot be
 *      read against the handoff's numbers — reported, not assumed.
 *   §2 LC3319XL source=compatible, end to end:
 *        - EVERY /api/shop request carries source=compatible, and both the
 *          requested code (LC3319XL) and the family code (LC3319) are asked;
 *        - the grid shows exactly the API's compatible set, every card's SKU
 *          is a compatible row in the API's own answer (not a SKU-prefix guess);
 *        - the chip reads "Compatible only", is visible, has an aria-label;
 *        - <link rel=canonical> has no `source` (and no `type`);
 *        - clicking the chip drops `source` from the URL WITHOUT a new history
 *          entry (replaceState), hides the chip, and the grid shows all 12.
 *   §3 the five live landing pages from the handoff: every request carries the
 *      source, every card is that source, the chip names it.
 *   §4 /shop?brand=hp&code=965&pack=value_pack still lists only value packs
 *      (4), and the request carries pack=value_pack.
 *   §5 geometry: the chip sits in the breadcrumb row — the first card's top is
 *      the same (±2px) with and without `source` at 1280x551 and 390x664.
 *   §6 NEGATIVE CONTROLS (a probe that cannot fail proves nothing, ERR-258):
 *        - source=bogus: no request carries source, no chip, 12 cards — the
 *          value is IGNORED, not forwarded (the API would 400 it);
 *        - the §2 "every request carries source" check, run on an UNFILTERED
 *          load, must come out RED.
 *
 * MODE: READ-ONLY. Public GETs only: nothing is added to a cart, no form is
 * submitted, nothing is typed into a search box (no /api/search/* call ⇒ no
 * search_analytics row, ERR-254/271). Third-party analytics and
 * /api/analytics/* are ABORTED in the browser: this probe measures what the
 * page requests and renders; the aborted routes are not the transport under
 * test (the ctx.route CORS caveat is about transport claims).
 *
 *   npm run probe:series-source                       (BASE localhost:3000 —
 *       `npx serve inkcartridges -l 3000`, the one local origin CORS allows)
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:series-source
 *
 * PACED. The backend limits 100 requests / 60 s per IP across endpoints
 * (ERR-266); contexts open at most one per PROBE_PACE_MS (default 6000). A
 * load that saw a 429 or never painted a card is NOT MEASURED — never a
 * result (ERR-243).
 */
import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = (process.env.PROBE_API || 'https://api.inkcartridges.co.nz').replace(/\/+$/, '');
const PACE_MS = Number(process.env.PROBE_PACE_MS || 6000);
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;
const LANDINGS = [
    ['brother', 'LC3319XL', 'compatible'],
    ['brother', 'LC531', 'compatible'],
    ['canon', 'PGI2600', 'genuine'],
    ['canon', 'PFI1000', 'genuine'],
    ['oki', 'C610', 'genuine'],
];

let pass = 0, fail = 0, unmeasured = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const notMeasured = (n, d) => { unmeasured++; console.log(`  \x1b[33m? NOT MEASURED ${n}\x1b[0m — ${d}`); };
const info = (n, d) => console.log(`  \x1b[36mℹ ${n}\x1b[0m — ${d}`);
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, no form submits, no search typed; analytics aborted.');
console.log(`BASE ${BASE}  API ${API}  pace ${PACE_MS}ms`);

// ── §1 API contract ─────────────────────────────────────────────────────────
async function apiShop(qs) {
    const r = await fetch(`${API}/api/shop?${qs}&limit=200`, { headers: { Origin: 'http://localhost:3000' } });
    let j = null;
    try { j = await r.json(); } catch (_) { /* non-JSON */ }
    const products = (j && j.data && j.data.products) || [];
    return { status: r.status, ok: !!(j && j.ok), products };
}

head('§1 /api/shop contract (the handoff\'s numbers)');
const contract = [
    ['brand=brother&code=LC3319XL&source=compatible', 6, 'compatible'],
    ['brand=brother&code=LC3319&source=compatible', 6, 'compatible'],
    ['brand=brother&code=LC3319XL', 12, null],
    ['brand=hp&code=965&pack=value_pack', 4, null],
];
for (const [qs, want, src] of contract) {
    const r = await apiShop(qs);
    if (r.status === 429) { notMeasured(qs, '429'); continue; }
    const srcOk = !src || r.products.every((p) => p.source === src);
    check(`${qs} ⇒ ${want}${src ? ` ${src}` : ''}`, r.ok && r.products.length === want && srcOk,
        `${r.status} ${r.products.length} rows${src && !srcOk ? ' — MIXED sources' : ''}`);
}
{
    const r = await apiShop('brand=brother&code=LC3319&source=bogus');
    check('source=bogus ⇒ 400 (why the page must never forward an unvalidated value)', r.status === 400, `${r.status}`);
}

// ── browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
let lastOpen = 0;

async function load(path, viewport = { width: 1366, height: 768 }) {
    const wait = lastOpen + PACE_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastOpen = Date.now();
    const ctx = await browser.newContext({ viewport });
    await ctx.route(ANALYTICS, (r) => r.abort());
    const page = await ctx.newPage();
    const requests = [];
    const sourceOfSku = new Map();
    const limited = [];
    page.on('request', (r) => { if (/\/api\/shop\?/.test(r.url())) requests.push(new URL(r.url())); });
    page.on('response', async (r) => {
        if (r.status() === 429) limited.push(r.url());
        if (!/\/api\/shop\?/.test(r.url())) return;
        try {
            const j = await r.json();
            for (const p of (j && j.data && j.data.products) || []) if (p && p.sku) sourceOfSku.set(p.sku, p.source);
        } catch (_) { /* body not JSON */ }
    });
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const painted = await page.waitForFunction(
        () => document.querySelector('#source-sections .product-card[data-sku]'), null, { timeout: 30000 },
    ).then(() => true, () => false);
    await page.waitForTimeout(1500);   // late fan-out responses, chip render
    return { ctx, page, requests, sourceOfSku, limited, painted };
}

function READ_PAGE() {
    const vis = (el) => !!el && el.getBoundingClientRect().height > 0;
    const cards = [...document.querySelectorAll('#source-sections .product-card[data-sku]')].filter(vis);
    const chip = document.getElementById('source-filter-chip');
    return {
        url: location.pathname + location.search,
        historyLength: history.length,
        skus: cards.map((c) => c.getAttribute('data-sku')),
        firstCardTop: cards.length ? Math.round(cards[0].getBoundingClientRect().top) : null,
        chip: chip && !chip.hidden && vis(chip)
            ? { text: chip.textContent.trim(), aria: chip.getAttribute('aria-label'), top: Math.round(chip.getBoundingClientRect().top) }
            : null,
        canonical: document.getElementById('canonical-url')?.getAttribute('href') || null,
    };
}

/** True iff every /api/shop request carries `source=<want>`. Also the §6 control's subject. */
const everyRequestCarries = (requests, want) => requests.length > 0 && requests.every((u) => u.searchParams.get('source') === want);
const reqList = (requests) => requests.map((u) => u.search).join(' | ') || 'no /api/shop request';

async function landing(brand, code, source, { clickChip = false } = {}) {
    const path = `/shop?brand=${brand}&code=${code}&source=${source}`;
    const L = await load(path);
    const tag = `${brand} ${code} source=${source}`;
    if (L.limited.length || !L.painted) {
        notMeasured(tag, L.limited.length ? `429 on ${L.limited.length} request(s)` : 'no card painted in 30s');
        await L.ctx.close();
        return;
    }
    const m = await L.page.evaluate(READ_PAGE);
    const label = source === 'genuine' ? 'Genuine only' : 'Compatible only';
    check(`${tag}: every /api/shop request carries source=${source}`, everyRequestCarries(L.requests, source), reqList(L.requests));
    const wrong = m.skus.filter((s) => L.sourceOfSku.get(s) !== source);
    check(`${tag}: every card is ${source} (per the API's own rows)`, m.skus.length > 0 && wrong.length === 0,
        `${m.skus.length} cards${wrong.length ? `; NOT ${source}: ${wrong.join(', ')}` : ''}`);
    check(`${tag}: chip reads "${label}"`, !!m.chip && m.chip.text === label && m.chip.aria === `Remove filter: ${label}`,
        m.chip ? `"${m.chip.text}" aria="${m.chip.aria}"` : 'no visible chip');
    check(`${tag}: canonical has no source/type`, !!m.canonical && !/[?&](source|type)=/.test(m.canonical), m.canonical || 'none');
    if (clickChip) {
        await L.page.click('#source-filter-chip');
        await L.page.waitForFunction((n) => document.querySelectorAll('#source-sections .product-card[data-sku]').length > n, m.skus.length, { timeout: 30000 }).catch(() => {});
        await L.page.waitForTimeout(1500);
        const after = await L.page.evaluate(READ_PAGE);
        check('chip removed: URL drops source', !/[?&]source=/.test(after.url) && /code=LC3319/i.test(after.url), after.url);
        check('chip removed: no new history entry (replaceState)', after.historyLength === m.historyLength, `${m.historyLength} → ${after.historyLength}`);
        check('chip removed: chip hidden', !after.chip, after.chip ? after.chip.text : 'hidden');
        const sources = new Set(after.skus.map((s) => L.sourceOfSku.get(s)));
        check('chip removed: grid shows all 12, both sources', after.skus.length === 12 && sources.has('genuine') && sources.has('compatible'),
            `${after.skus.length} cards, sources ${[...sources].join('+')}`);
    }
    if (code === 'LC3319XL') {
        const codes = new Set(L.requests.map((u) => (u.searchParams.get('code') || '').toUpperCase()));
        check(`${tag}: both the requested code and the family code are asked`, codes.has('LC3319XL') && codes.has('LC3319'), [...codes].join(', '));
        check(`${tag}: exactly 6 cards (handoff)`, m.skus.length === 6, `${m.skus.length}`);
    }
    await L.ctx.close();
}

try {
    head('§2 LC3319XL source=compatible — requests, grid, chip, canonical, removal');
    await landing('brother', 'LC3319XL', 'compatible', { clickChip: true });

    head('§3 the five live ad landing pages');
    for (const [brand, code, source] of LANDINGS.slice(1)) await landing(brand, code, source);

    head('§4 pack=value_pack still works (Exclusive - Value Packs ads)');
    {
        const L = await load('/shop?brand=hp&code=965&pack=value_pack');
        if (L.limited.length || !L.painted) notMeasured('hp 965 pack', L.limited.length ? '429' : 'no card painted');
        else {
            const m = await L.page.evaluate(READ_PAGE);
            const packs = await L.page.evaluate(() => [...document.querySelectorAll('#source-sections .product-card[data-sku]')]
                .filter((c) => c.getBoundingClientRect().height > 0)
                .map((c) => !!c.querySelector('.product-card__ribbon--value-pack')));
            check('the request carries pack=value_pack', L.requests.some((u) => u.searchParams.get('pack') === 'value_pack'), reqList(L.requests));
            check('4 cards, all value packs', m.skus.length === 4 && packs.every(Boolean), `${m.skus.length} cards: ${m.skus.join(', ')}`);
            check('no source chip on a pack landing', !m.chip, m.chip ? m.chip.text : 'none');
        }
        await L.ctx.close();
    }

    head('§5 geometry — the chip adds no row to the first screen');
    for (const vp of [{ width: 1280, height: 551 }, { width: 390, height: 664 }]) {
        const A = await load('/shop?brand=brother&code=LC3319XL', vp);
        const a = A.painted ? await A.page.evaluate(READ_PAGE) : null;
        await A.ctx.close();
        const B = await load('/shop?brand=brother&code=LC3319XL&source=compatible', vp);
        const b = B.painted ? await B.page.evaluate(READ_PAGE) : null;
        await B.ctx.close();
        const tag = `${vp.width}x${vp.height}`;
        if (!a || !b || A.limited.length || B.limited.length) { notMeasured(tag, 'a load did not paint or saw a 429'); continue; }
        info(`${tag} chip`, b.chip ? `top ${b.chip.top}px` : 'not visible');
        check(`${tag}: first card top unchanged by the chip (±2px)`, Math.abs(a.firstCardTop - b.firstCardTop) <= 2,
            `without ${a.firstCardTop}px, with ${b.firstCardTop}px`);
    }

    head('§6 NEGATIVE CONTROLS');
    {
        const L = await load('/shop?brand=brother&code=LC3319XL&source=bogus');
        if (L.limited.length || !L.painted) notMeasured('source=bogus', L.limited.length ? '429' : 'no card painted');
        else {
            const m = await L.page.evaluate(READ_PAGE);
            check('source=bogus: no request carries source (ignored, not forwarded)', L.requests.length > 0 && L.requests.every((u) => !u.searchParams.has('source')), reqList(L.requests));
            check('source=bogus: no chip', !m.chip, m.chip ? m.chip.text : 'none');
            check('source=bogus: all 12 cards', m.skus.length === 12, `${m.skus.length}`);
        }
        await L.ctx.close();
    }
    {
        const L = await load('/shop?brand=brother&code=LC3319XL');
        if (L.limited.length || !L.painted) notMeasured('unfiltered control', L.limited.length ? '429' : 'no card painted');
        else check('control: the "every request carries source" check is RED on an unfiltered load',
            !everyRequestCarries(L.requests, 'compatible'), reqList(L.requests));
        await L.ctx.close();
    }
} finally {
    await browser.close();
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed, ${unmeasured} not measured\x1b[0m`);
process.exit(fail ? 1 : unmeasured ? 2 : 0);
