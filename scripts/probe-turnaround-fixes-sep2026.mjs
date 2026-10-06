#!/usr/bin/env node
/**
 * probe:turnaround-fixes — ERR-296, the backend's turnaround doc (2026-09-28)
 * ===========================================================================
 *
 * tests/turnaround-fixes-sep2026.test.js runs the shipped functions. It cannot
 * see a rendered page, a live contract, or an edge. This asks them.
 *
 *   §A  API contracts the build reads: value-props loyalty copy (#15), /api/brands
 *       show_on_shop (#17), value-pack brand filter returns ONLY that brand (#17),
 *       NOT the business apply route (#10 is ERR-297's; a preflight
 *       proves nothing and a POST spends a 5/IP/24h limiter).
 *   §E  the edge: Googlebot on a printer URL still gets the prerender (200,
 *       X-Prerendered) — the 503 path is only reachable by a failing backend,
 *       so the unit test owns it; this is the "did we break the happy path" check.
 *   §S  static markup on BASE: cart label, /bulk-pricing quote link, value-pack
 *       chip mount, sign-in points line, confirmation form, fonts <link> order.
 *   §B  --browser (Chromium, BASE): finder empty state (#7) and the no-printer
 *       banner (#7, /smart MOCKED — see MODE); value-pack chips filter (#17);
 *       rendered card text ≥ 12px at 1440 and 390 (P2) with a NEGATIVE CONTROL;
 *       cross-sell image ≤ 120px (#8); phone toast at the TOP (P2); Filter &
 *       Sort leaves on a downward scroll and returns on an upward one (P2);
 *       the sign-in rewards line renders live text (#15).
 *
 * MODE: READ-ONLY. GETs only. No cart write, no sign-up, no
 * apply POST. In the browser, analytics hosts are aborted and the one search the
 * finder banner needs is answered by page.route with the MEASURED /smart shape
 * for "Brother HL-L2350DW" — so no search_analytics row is written (ERR-254/271).
 * That mock is a UI check, not a transport claim (the ctx.route CORS caveat does
 * not apply), and it is printed when used.
 *
 *   npm run probe:turnaround-fixes
 *   npm run probe:turnaround-fixes -- --browser
 *   PROBE_BASE=http://localhost:3000 npm run probe:turnaround-fixes -- --browser
 */
const argv = new Set(process.argv.slice(2));
const API = (process.env.PROBE_API || 'https://api.inkcartridges.co.nz').replace(/\/+$/, '');
const SITE = (process.env.PROBE_SITE || 'https://www.inkcartridges.co.nz').replace(/\/+$/, '');
const BASE = (process.env.PROBE_BASE || SITE).replace(/\/+$/, '');
const ORIGIN = 'https://www.inkcartridges.co.nz';
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || 600);
const GBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let pass = 0, fail = 0, unmeasured = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const skip = (n, d) => { unmeasured++; console.log(`  \x1b[36m○ UNMEASURED ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`probe:turnaround-fixes — \x1b[33mMODE: READ-ONLY\x1b[0m (GET only; no cart write, no sign-up, no apply POST)`);
console.log(`  API ${API} · SITE ${SITE} · BASE ${BASE}${argv.has('--browser') ? ' · --browser' : ''}`);

async function getJson(url, tries = 4) {
    for (let i = 0; i < tries; i++) {
        await pause(DELAY_MS);
        const r = await fetch(url, { headers: { Origin: ORIGIN } }).catch(() => null);
        if (!r) continue;
        if (r.status === 429) { await pause(5000 * (i + 1)); continue; }
        let body = null;
        try { body = await r.json(); } catch { /* non-JSON */ }
        return { status: r.status, body };
    }
    return { status: 429, body: null };
}

// ── §A API contracts ─────────────────────────────────────────────────────────
head('§A API contracts the build reads');
{
    const vp = await getJson(`${API}/api/site/value-props`);
    const lo = vp.body?.data?.loyalty;
    if (vp.status === 429) skip('value-props', 'rate limited');
    else check('value-props loyalty.headline + detail are strings (the sign-in line binds both)',
        typeof lo?.headline === 'string' && typeof lo?.detail === 'string', `${lo?.headline} | ${String(lo?.detail).slice(0, 80)}…`);
    check('loyalty.detail names the guest-orders claim and the welcome points', /same email/i.test(lo?.detail || '') && /welcome/i.test(lo?.detail || ''), '');

    const br = await getJson(`${API}/api/brands`);
    const shop = (Array.isArray(br.body?.data) ? br.body.data : []).filter((b) => b.show_on_shop === true);
    check('/api/brands has show_on_shop rows for the value-pack chips', shop.length > 0, shop.map((b) => b.slug).join(', '));

    for (const slug of ['canon', 'kyocera']) {
        const r = await getJson(`${API}/api/products?pack=value_pack&brand=${slug}&limit=24`);
        const rows = r.body?.data?.products || [];
        const other = rows.filter((p) => ((p.brand && (p.brand.slug || p.brand)) || '') !== slug);
        check(`value_pack&brand=${slug}: every row is ${slug} (the chip does not lie)`, rows.length > 0 && other.length === 0,
            `${rows.length} rows, total ${r.body?.meta?.pagination?.total ?? r.body?.meta?.total}${other.length ? `, off-brand: ${other.map((p) => p.sku).join(',')}` : ''}`);
    }
    const all = await getJson(`${API}/api/products?pack=value_pack&limit=1`);
    const t = all.body?.meta?.pagination?.total ?? all.body?.meta?.total;
    check('CONTROL: unfiltered value_pack total is larger than one brand', Number(t) > 124, `total ${t}`);

    // Not measured here: /api/business/apply. A preflight 204s whatever path you
    // ask (ERR-223) so it proves nothing, and a POST spends the 5/IP/24h limiter
    // that runs BEFORE auth (ERR-297). ERR-297's probe owns that route.
}

// ── §E edge happy path ───────────────────────────────────────────────────────
head('§E Googlebot on a printer URL still gets the prerender');
if (!/^https:\/\/www\.inkcartridges\.co\.nz$/.test(SITE)) skip('edge', `SITE is ${SITE} — middleware only runs on Vercel`);
else {
    await pause(DELAY_MS);
    const r = await fetch(`${SITE}/shop?brand=brother&printer_slug=brother-hl-l2375dw`, { headers: { 'User-Agent': GBOT }, redirect: 'manual' }).catch(() => null);
    const body = r ? await r.text() : '';
    if (r && r.status === 503) bad('printer prerender', `503 retry-after=${r.headers.get('retry-after')} — the backend is failing or slow RIGHT NOW (the new path is working as designed; re-run)`);
    else check('200 + X-Prerendered, and no /shop canonical in what Googlebot read', r?.status === 200 && r.headers.get('x-prerendered') === 'true'
        && !/rel="canonical" href="https:\/\/www\.inkcartridges\.co\.nz\/shop"/.test(body), `${r?.status} x-prerendered=${r?.headers.get('x-prerendered')}`);
}

// ── §S static markup ─────────────────────────────────────────────────────────
head('§S shipped markup on BASE');
async function page(p) { await pause(200); const r = await fetch(`${BASE}${p}`).catch(() => null); return r ? await r.text() : ''; }
{
    const cart = await page('/cart');
    check('/cart: "Total before shipping" + sticky "Before shipping"', /<span>Total before shipping<\/span>/.test(cart) && /cart-sticky-bar__label">Before shipping</.test(cart));
    check('/cart: guest coupon line ships hidden', /id="cart-coupon-guest" hidden>/.test(cart));
    const bulk = await page('/bulk-pricing');
    check('/bulk-pricing links /quote', /<a href="\/quote">Get a business quote<\/a>/.test(bulk));
    check('/value-packs mounts the brand chips', /id="value-page-brands"/.test(await page('/value-packs')));
    const login = await page('/account/login');
    check('/account/login: two rewards lines, data-bound, no number in markup', (login.match(/data-value-prop="loyalty\.detail"/g) || []).length === 2);
    const conf = await page('/order-confirmation');
    check('/order-confirmation: one-field form + business offer card, both hidden by default',
        /id="confirmation-account-form" hidden/.test(conf) && /id="business-account-offer" hidden/.test(conf) && /id="save-printer-prompt" hidden/.test(conf));
    const fontsFirst = (h) => { const f = h.indexOf('fonts.googleapis.com/css2'); const b = h.indexOf('/css/base.css'); return f > 0 && f < b; };
    check('fonts <link> precedes base.css on /cart, /shop, /', fontsFirst(cart) && fontsFirst(await page('/shop')) && fontsFirst(await page('/')));
    const base = await page('/css/base.css');
    check('base.css has no @import (no render-blocking chain)', base.length > 1000 && !/^\s*@import/m.test(base), `${base.length} bytes`);
}

// ── §B browser ───────────────────────────────────────────────────────────────
if (!argv.has('--browser')) {
    head('§B browser');
    skip('rendered checks', 'pass --browser');
} else {
    const { chromium, devices } = await import('playwright');
    const browser = await chromium.launch();
    const ANALYTICS = /googletagmanager|google-analytics|googleadservices|doubleclick|bat\.bing|clarity\.ms/;
    const newPage = async (opts) => {
        const ctx = await browser.newContext(opts);
        await ctx.route(ANALYTICS, (r) => r.abort());
        return { ctx, p: await ctx.newPage() };
    };

    head('§B1 printer finder: no match (#7)');
    {
        const { ctx, p } = await newPage({ viewport: { width: 1440, height: 900 } });
        await p.goto(`${BASE}/ink-cartridges`, { waitUntil: 'domcontentloaded' });
        const input = p.locator('#landing-printer-search-input');
        await input.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        if (!(await input.isVisible().catch(() => false))) skip('finder', 'the finder did not render');
        else {
            await input.fill('Brother HL-L2350DW');
            const none = p.locator('.landing-printer-search__none');
            await none.waitFor({ timeout: 20000 }).catch(() => {});
            const html = await none.innerHTML().catch(() => '');
            check('empty state: "couldn\'t match", /quote, a tel: link', /couldn't match that printer/.test(html) && /href="\/quote"/.test(html) && /href="tel:/.test(html), html.replace(/<[^>]+>/g, '').slice(0, 120));
            // CONTROL, and the separator bug found building this (ERR-296): the
            // box's own placeholder spelling, hyphenated, must FIND the printer.
            // Since BF-096 (backend 2026-10-06) every separator spelling finds
            // it with ONE request each — the FE's two-spelling fan-out is gone.
            // /api/printers/search writes no search_analytics row (see
            // tests/probe-search-analytics-honesty-sep2026.test.js), so typing
            // here pollutes nothing.
            for (const q of ['Brother MFC-J5930DW', 'MFC J5930DW', 'MFCJ5930DW']) {
                const asked = [];
                const onReq = (req) => { if (/\/api\/printers\/search\?/.test(req.url())) asked.push(req.url()); };
                p.on('request', onReq);
                await input.fill('');
                await input.fill(q);
                const hit = p.locator('.landing-printer-search__hit').first();
                await hit.waitFor({ timeout: 20000 }).catch(() => {});
                await p.waitForTimeout(600);   // let any second request show itself
                p.off('request', onReq);
                const text = await hit.innerText().catch(() => 'no hit');
                check(`CONTROL: "${q}" finds Brother MFC-J5930DW (display_name)`, text.trim() === 'Brother MFC-J5930DW', text);
                check(`"${q}": ONE /api/printers/search request (BF-096; was two for a hyphen)`, asked.length === 1, `${asked.length} request(s)`);
            }
        }
        await ctx.close();
    }

    head('§B2 finder search with no printer → banner (/smart MOCKED with the measured shape; nothing written)');
    {
        const { ctx, p } = await newPage({ viewport: { width: 1440, height: 900 } });
        let mocked = 0;
        await ctx.route(/\/api\/search\//, (r) => {
            mocked++;
            r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ ok: true, data: { products: [
                    { sku: 'CTN2345', name: 'Compatible Brother TN2345 Toner', source: 'compatible', retail_price: 39.99, brand: { name: 'Brother', slug: 'brother' } },
                ], total: 1, matched_printer: null } }) });
        });
        await p.goto(`${BASE}/shop?q=Brother+HL-L2350DW&from=finder`, { waitUntil: 'domcontentloaded' });
        const banner = p.locator('.search-finder-nomatch');
        await banner.waitFor({ timeout: 20000 }).catch(() => {});
        check('"These match your words, not your printer." above the results', /These match your words, not your printer/.test(await banner.innerText().catch(() => '')), `mocked ${mocked} request(s)`);
        await p.goto(`${BASE}/shop?q=Brother+HL-L2350DW`, { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(4000);
        check('CONTROL: the same query typed (no from=finder) shows no banner', (await p.locator('.search-finder-nomatch').count()) === 0);
        await ctx.close();
    }

    head('§B3 /value-packs brand chips (#17)');
    {
        const { ctx, p } = await newPage({ viewport: { width: 1440, height: 900 } });
        const brandsAsked = [];
        p.on('request', (r) => { if (/\/api\/products\?.*pack=value_pack/.test(r.url())) brandsAsked.push(new URL(r.url()).searchParams.get('brand')); });
        await p.goto(`${BASE}/value-packs`, { waitUntil: 'domcontentloaded' });
        const chip = p.locator('.value-page__brand-chip[data-brand="canon"]');
        await chip.waitFor({ timeout: 20000 }).catch(() => {});
        if (!(await chip.count())) bad('chips render', 'no Canon chip');
        else {
            await chip.click();
            await p.waitForFunction(() => document.querySelectorAll('#value-page-grid .product-card').length > 0, null, { timeout: 20000 }).catch(() => {});
            const names = await p.$$eval('#value-page-grid .product-card', (cs) => cs.map((c) => c.innerText.split('\n').find((l) => /canon|pg|cl|cli|pgi/i.test(l)) ? 'canon' : c.innerText.slice(0, 40)));
            check('Canon chip asks brand=canon and paints only Canon cards', brandsAsked.includes('canon') && names.length > 0 && names.every((n) => n === 'canon'),
                `${names.length} cards; asked ${JSON.stringify(brandsAsked)}`);
            check('aria-pressed + ?brand= reflect the choice', (await chip.getAttribute('aria-pressed')) === 'true' && /[?&]brand=canon/.test(p.url()));
        }
        await ctx.close();
    }

    head('§B4 card text floor 12px, cross-sell image cap, phone toast + Filter & Sort (P2, #8)');
    {
        const minFont = async (p) => p.evaluate(() => {
            let min = 99, where = '';
            document.querySelectorAll('.product-card').forEach((c) => c.querySelectorAll('*').forEach((el) => {
                if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
                if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return;
                const fs = parseFloat(getComputedStyle(el).fontSize);
                if (fs < min) { min = fs; where = `${el.className} "${el.textContent.trim().slice(0, 24)}"`; }
            }));
            return { min, where };
        });
        for (const [label, opts] of [['1440', { viewport: { width: 1440, height: 900 } }], ['390 (iPhone 13)', devices['iPhone 13']]]) {
            const { ctx, p } = await newPage(opts);
            await p.goto(`${BASE}/shop?brand=brother&category=ink&code=LC73`, { waitUntil: 'domcontentloaded' });
            // `attached`: on a phone one source tab's cards are display:none.
            await p.waitForSelector('.product-card', { state: 'attached', timeout: 60000 }).catch(() => {});
            await p.waitForTimeout(2500);
            const m = await minFont(p);
            if (m.min === 99) skip(`${label} card fonts`, 'no cards rendered');
            else check(`${label}: smallest visible card text ≥ 12px`, m.min >= 12, `${m.min}px at ${m.where}`);
            if (label === '1440') {
                await p.addStyleTag({ content: '.product-card__title{font-size:9px!important}' });
                const neg = await minFont(p);
                check('NEGATIVE CONTROL: a 9px override is reported (the measure can fail)', neg.min <= 9, `${neg.min}px`);
                const img = await p.evaluate(() => {
                    const o = document.createElement('div'); o.className = 'crosssell-modal__grid'; o.style.cssText = 'width:760px;display:grid;grid-template-columns:1fr';
                    o.innerHTML = '<a class="crosssell-modal__card"><div class="crosssell-modal__img crosssell-modal__img--placeholder"></div></a>';
                    document.body.appendChild(o);
                    const w = o.querySelector('.crosssell-modal__img').getBoundingClientRect().width; o.remove(); return w;
                });
                check('a lone cross-sell card\'s image is ≤ 120px wide (was 686px)', img > 0 && img <= 120, `${Math.round(img)}px`);
            } else {
                const toast = await p.evaluate(() => { showToast('probe toast (not an add)', 'info', 3000); const t = document.querySelector('.toast-container'); return t ? Math.round(t.getBoundingClientRect().top) : null; });
                check('phone toast sits at the TOP of the screen', toast !== null && toast < 80, `top ${toast}px of ${p.viewportSize().height}`);
                const bar = async () => p.evaluate(() => { const b = document.querySelector('.filter-sort-bar'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), vh: innerHeight }; });
                const before = await bar();
                if (!before) skip('Filter & Sort', 'bar not shown on this page');
                else {
                    await p.mouse.wheel(0, 900); await p.waitForTimeout(700);
                    const down = await bar();
                    await p.mouse.wheel(0, -300); await p.waitForTimeout(700);
                    const up = await bar();
                    check('Filter & Sort leaves the screen on a downward scroll', down && down.top >= down.vh, `top ${before.top} → ${down?.top} (vh ${down?.vh})`);
                    check('…and comes back on an upward scroll', up && up.top < up.vh, `top ${up?.top}`);
                }
            }
            await ctx.close();
        }
    }

    head('§B5 sign-in rewards line renders live text (#15)');
    {
        const { ctx, p } = await newPage({ viewport: { width: 1440, height: 900 } });
        await p.goto(`${BASE}/account/login`, { waitUntil: 'domcontentloaded' });
        await p.waitForFunction(() => { const e = document.querySelector('#login-panel .auth-form__points'); return e && !e.hidden; }, null, { timeout: 30000 }).catch(() => {});
        const txt = await p.locator('#login-panel .auth-form__points').innerText().catch(() => '');
        check('visible, and states the welcome points + guest claim from the API', /welcome/i.test(txt) && /same email/i.test(txt), txt.slice(0, 140));
        await ctx.close();
    }
    await browser.close();
}

console.log(`\n────────\nmode: READ-ONLY  passed ${pass}  failed ${fail}  unmeasured ${unmeasured}${unmeasured ? '  (a skip is not a pass)' : ''}`);
process.exit(fail ? 1 : 0);
