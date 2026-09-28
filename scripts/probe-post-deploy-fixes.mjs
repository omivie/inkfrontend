#!/usr/bin/env node
/**
 * probe:post-deploy-fixes — the backend's 2026-09-28 acceptance checks (ERR-293)
 * =============================================================================
 * backend-docs/inbox/fe-post-deploy-fixes-sep2026.md. The unit suite
 * (tests/post-deploy-fixes-sep2026.test.js) proves the shipped functions; this
 * proves the PAGE, one fresh context per scenario (a first visit = an ad click,
 * consent bar OPEN).
 *
 *   §1 compatible PDP, desktop 1440x900: Add to Cart fully above the consent
 *      bar at scroll 0 AND hit-testable there; the one-line compliance + fit
 *      lines above Add; the FULL compliance text still on the page, below Add;
 *      the one-line ladder "N+ from $X each"; the countdown scoped when shown.
 *      Genuine GLC3329XLBK is the CONTROL (no compliance line).
 *   §2 phone 390x664: unchanged — headline + ladder line NOT displayed, fit
 *      still above Add.
 *   §3 card "+N" on a listing (code drill-down, /api/shop — NOT search) agrees
 *      with the API row's compatible_printers_count.
 *   §4 /review with a bogus token renders the expired message (flag is live,
 *      the GET ran). GET only — nothing is ever POSTed.
 *   §5 NEGATIVE CONTROL: a 200px spacer injected above Add must turn §1's
 *      consent-bar check red — otherwise a green §1 means nothing.
 *
 * MODE: READ-ONLY. Public GETs only: no cart write, no form submit, no review
 * POST, nothing typed into search (no /api/search/* call ⇒ no
 * search_analytics row, ERR-254/271). Third-party analytics and
 * /api/analytics/* are ABORTED in the browser; this probe measures LAYOUT and
 * rendered text, not transport (the ctx.route caveat is about CORS claims).
 * BASE defaults to localhost:3000 (`npx serve inkcartridges -l 3000`) — the
 * only local origin the backend's CORS allows.
 *
 *   npm run probe:post-deploy-fixes
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:post-deploy-fixes
 */
import { chromium } from 'playwright';
import { PHONE, IPHONE_UA } from './lib/mobile-viewports.mjs';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = process.env.PROBE_API || 'https://ink-backend-sg.onrender.com';
const DESKTOP = { width: 1440, height: 900 };
// The handoff named CLC73BK and "for example CTN2450" — CTN2450 is a 404
// (measured 2026-09-28), so the toner check uses two live compatible toners.
const COMPATIBLE = ['CLC73BK', 'CTN2445BK', 'CTN258XLBK'];
const GENUINE = 'GLC3329XLBK';               // control: no compliance line
const LISTING = '/shop?brand=brother&category=ink&code=LC73';
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;

let pass = 0, fail = 0, softs = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const soft = (n, d) => { softs++; console.log(`  \x1b[33m⚠ ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, no form submits, no review POST, no search typed; analytics aborted.');
console.log(`BASE ${BASE}  API ${API}  desktop ${DESKTOP.width}x${DESKTOP.height}  phone ${PHONE.width}x${PHONE.height}`);

const browser = await chromium.launch();
async function ctxFor(kind) {
    const ctx = await browser.newContext(kind === 'phone'
        ? { viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
        : { viewport: DESKTOP });
    await ctx.route(ANALYTICS, (r) => r.abort());
    return ctx;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** The API row, waiting out a 429 (100 req/60s per IP, SHARED across
 *  endpoints and with every other probe on this machine — ERR-266). */
const apiRow = async (sku) => {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(`${API}/api/products/${sku}`);
            if (r.status === 429) { await pause((Number(r.headers.get('retry-after')) || 20) * 1000); continue; }
            return (await r.json()).data || null;
        } catch (_) { return null; }
    }
    return null;
};

/** Everything §1/§2/§5 read off a PDP, at scroll 0. */
const MEASURE = () => {
    const box = (e) => (e ? e.getBoundingClientRect() : null);
    const shown = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && box(e).height > 0;
    const add = document.getElementById('add-to-cart-btn');
    const a = box(add);
    const bar = document.getElementById('consent-banner');
    const barTop = bar && shown(bar) ? Math.round(box(bar).top) : null;
    let hittable = false;
    if (a && a.height > 0) {
        const hit = document.elementFromPoint(a.left + a.width / 2, Math.min(a.top + a.height / 2, innerHeight - 1));
        hittable = !!hit && (hit === add || add.contains(hit));
    }
    const line = (id) => { const e = document.getElementById(id); return shown(e) ? { text: e.textContent.replace(/\s+/g, ' ').trim(), y: Math.round(box(e).top) } : null; };
    const panel = document.getElementById('compat-disclaimer');
    const cd = document.getElementById('product-dispatch-countdown');
    return {
        addTop: a ? Math.round(a.top) : null, addBottom: a ? Math.round(a.bottom) : null, barTop, hittable,
        compliance: line('product-headline-compliance'), fit: line('product-headline-fit'),
        summary: line('volume-pricing-summary'),
        panel: panel ? { text: panel.textContent.replace(/\s+/g, ' ').trim(), y: Math.round(box(panel).top) } : null,
        fitBlockY: shown(document.getElementById('product-fit')) ? Math.round(box(document.getElementById('product-fit')).top) : null,
        countdown: cd && !cd.hidden ? cd.textContent.trim() : null,
    };
};

async function openPdp(kind, sku) {
    await pause(6000);   // pace the per-IP budget: one PDP load is ~15 API calls
    const ctx = await ctxFor(kind);
    const page = await ctx.newPage();
    const throttled = [];
    page.on('response', (r) => { if (r.status() === 429) throttled.push(new URL(r.url()).pathname); });
    await page.goto(`${BASE}/p/${sku}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for the RENDER, not a clock: the buy box is painted and (for a
    // compatible row) the headline strip or the panel exists. A fixed 5s wait
    // measured a half-rendered page on a cold backend and called it green.
    const rendered = await page.waitForFunction(() => {
        const t = document.getElementById('product-title');
        const price = document.getElementById('product-price');
        return t && !t.querySelector('.skeleton') && price && /\$\d/.test(price.textContent);
    }, null, { timeout: 45000 }).then(() => true, () => false);
    await page.waitForTimeout(2500);   // async ladder + value props settle
    return { ctx, page, rendered, throttled };
}

try {
    /* ══ §1 desktop PDP ══════════════════════════════════════════════════ */
    head('§1 PDP — desktop 1440x900, first visit, consent bar open');
    for (const sku of [...COMPATIBLE, GENUINE]) {
        const api = await apiRow(sku);
        if (!api) { bad(`${sku}: API row not readable`, 'a SKU the probe cannot read is not a pass'); continue; }
        const { ctx, page, rendered, throttled } = await openPdp('desktop', sku);
        if (throttled.length) { bad(`${sku}: page was rate-limited — NOT MEASURED`, `429 on ${[...new Set(throttled)].join(', ')}`); await ctx.close(); continue; }
        if (!rendered) { bad(`${sku}: PDP never rendered (45s)`); await ctx.close(); continue; }
        const m = await page.evaluate(MEASURE);
        console.log(`  ${sku}: Add y ${m.addTop}-${m.addBottom}, bar from y ${m.barTop}, hit-testable ${m.hittable}`);
        console.log(`    compliance=${JSON.stringify(m.compliance?.text)} fit=${JSON.stringify(m.fit?.text)} summary=${JSON.stringify(m.summary?.text)}`);
        check(`${sku}: consent bar is open (first visit)`, m.barTop !== null, `bar top ${m.barTop}`);
        check(`${sku}: Add fully above the consent bar`, m.addBottom > 0 && m.barTop !== null && m.addBottom <= m.barTop,
            `Add bottom ${m.addBottom} vs bar ${m.barTop}`);
        check(`${sku}: Add hit-testable at scroll 0`, m.hittable);
        const compatible = api && api.source === 'compatible';
        if (compatible) {
            const brand = api.brand && api.brand.name;
            check(`${sku}: one compliance line under the title, above Add`,
                !!m.compliance && m.compliance.text === `Compatible — not made by ${brand}` && m.compliance.y < m.addTop, m.compliance && `${m.compliance.text} @y${m.compliance.y}`);
            check(`${sku}: the FULL compliance text is still on the page, below Add`,
                !!m.panel && /not made or endorsed by/.test(m.panel.text) && /Sold by Office Consumables Ltd\./.test(m.panel.text) && m.panel.y > m.addTop,
                m.panel && `@y${m.panel.y}`);
        } else {
            check(`${sku}: genuine — no compliance line (control)`, m.compliance === null && m.panel === null);
        }
        const n = Array.isArray(api?.compatible_printers) ? api.compatible_printers.length : 0;
        if (n) {
            check(`${sku}: "Fits:" line above Add`, !!m.fit && /^Fits: /.test(m.fit.text) && m.fit.y < m.addTop, m.fit && `@y${m.fit.y}`);
            if (n > 2) check(`${sku}: +N matches the list (${n} printers)`, !!m.fit && m.fit.text.endsWith(`+${n - 2} more`), m.fit?.text);
        } else soft(`${sku}: no compatible_printers in the API row`, 'fit line not checked');
        const rung = Array.isArray(api?.quantity_breaks) && api.quantity_breaks[0];
        if (rung) {
            check(`${sku}: one ladder line above Add, from the API's first rung`,
                !!m.summary && m.summary.y < m.addTop && m.summary.text.startsWith(`${rung.min_quantity}+ from $${Number(rung.business_price).toFixed(2)} each`),
                m.summary?.text);
            check(`${sku}: never a maximum saving above Add`, !!m.summary && !/up to|save/i.test(m.summary.text));
        } else soft(`${sku}: no quantity_breaks`, 'ladder line not checked');
        if (m.countdown) {
            const scoped = /auckland metro/i.test(api?.delivery_estimate?.promise || '');
            check(`${sku}: countdown carries the promise's scope`, scoped === / \(Auckland metro\)$/.test(m.countdown), m.countdown);
        } else soft(`${sku}: countdown not showing`, `same_day_eligible=${api?.delivery_estimate?.same_day_eligible} (outside the cutoff) — scope checked by the unit suite`);
        await ctx.close();
    }

    /* ══ §2 phone unchanged ══════════════════════════════════════════════ */
    head('§2 PDP — phone 390x664: layout unchanged');
    {
        const { ctx, page, throttled } = await openPdp('phone', COMPATIBLE[0]);
        if (throttled.length) bad('phone PDP was rate-limited — NOT MEASURED', `429 on ${[...new Set(throttled)].join(', ')}`);
        const m = await page.evaluate(MEASURE);
        const addY = await page.evaluate(() => Math.round(document.getElementById('add-to-cart-btn').getBoundingClientRect().top));
        check('headline + ladder lines not displayed on a phone', !m.compliance && !m.fit && !m.summary);
        check('full compliance panel above Add on a phone (as before)', !!m.panel && m.panel.y < addY, m.panel && `@y${m.panel.y} vs Add ${addY}`);
        check('printer fit block above Add on a phone (as before)', m.fitBlockY !== null && m.fitBlockY < addY, `${m.fitBlockY} vs ${addY}`);
        await ctx.close();
    }

    /* ══ §3 card +N ══════════════════════════════════════════════════════ */
    head(`§3 card "+N" — ${LISTING}`);
    {
        const ctx = await ctxFor('desktop');
        const page = await ctx.newPage();
        const rows = new Map();
        page.on('response', async (r) => {
            if (!/\/api\/shop\b/.test(r.url())) return;
            try {
                const j = await r.json();
                for (const p of (j.data && j.data.products) || []) rows.set(p.sku, p);
            } catch (_) { /* not JSON */ }
        });
        await page.goto(`${BASE}${LISTING}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(7000);
        const cards = await page.evaluate(() => [...document.querySelectorAll('.product-card')].map((c) => ({
            sku: c.getAttribute('data-sku') || c.querySelector('[data-sku]')?.getAttribute('data-sku'),
            fits: c.querySelector('.product-card__fits')?.textContent.trim() || null,
        })));
        let compared = 0;
        for (const c of cards) {
            const row = rows.get(c.sku);
            if (!row || !c.fits || !Array.isArray(row.compatible_printers)) continue;
            compared++;
            const total = Number(row.compatible_printers_count);
            const shown = Math.min(2, row.compatible_printers.length);
            const want = Math.max(Number.isFinite(total) ? total : 0, row.compatible_printers.length) - shown;
            const got = (c.fits.match(/ \+(\d+)$/) || [])[1];
            check(`${c.sku}: "+N" = count − shown`, want > 0 ? got === String(want) : got === undefined, `${c.fits} (count ${row.compatible_printers_count})`);
        }
        check('at least one card compared against its API row', compared > 0, `${compared} of ${cards.length} cards, ${rows.size} rows`);
        await ctx.close();
    }

    /* ══ §4 /review ══════════════════════════════════════════════════════ */
    head('§4 /review — live flag, bogus token (GET only)');
    {
        const ctx = await ctxFor('phone');
        const page = await ctx.newPage();
        let got = null;
        page.on('request', (r) => { if (r.method() === 'POST' && /reviews/.test(r.url())) got = 'POST'; });
        page.on('response', (r) => { if (/\/api\/reviews\/by-token\//.test(r.url())) got = got || r.status(); });
        await page.goto(`${BASE}/review?token=zzprobe-invalid-token`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
        const text = await page.evaluate(() => document.getElementById('review-page-body')?.textContent.trim() || '');
        check('never POSTs', got !== 'POST');
        if (got === 429) {
            // 100 req/60s per IP, shared across endpoints (ERR-266): a throttled
            // read is NOT MEASURED — never a pass. Re-run after a minute.
            bad('by-token GET was rate-limited (429) — not measured', 'wait 60s and re-run');
        } else {
            check('the page asked the backend (flag is live)', got === 404, `by-token response ${got}`);
            check('a bogus token reads as expired, not "not active yet"', /expired or could not be read/.test(text) && !/isn.t active yet/.test(text), text.slice(0, 80));
        }
        await ctx.close();
    }

    /* ══ §5 negative control ═════════════════════════════════════════════ */
    head('§5 negative control — can §1\'s consent-bar check go red?');
    {
        const { ctx, page } = await openPdp('desktop', COMPATIBLE[0]);
        await page.evaluate(() => {
            const s = document.createElement('div');
            s.style.height = '200px';
            document.querySelector('.product-info__actions').before(s);
        });
        const m = await page.evaluate(MEASURE);
        check('a 200px spacer above Add is reported as Add under the bar', m.addBottom > m.barTop, `Add bottom ${m.addBottom} vs bar ${m.barTop}`);
        await ctx.close();
    }
} catch (e) {
    bad('probe crashed', e && e.message);
} finally {
    await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${softs} soft`);
process.exit(fail ? 1 : 0);
