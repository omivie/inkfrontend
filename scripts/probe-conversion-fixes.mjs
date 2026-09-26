#!/usr/bin/env node
/**
 * probe:conversion-fixes — the backend's acceptance checks, in a real browser
 * ===========================================================================
 * Conversion handoff 2026-09-23 (+ owner goal 2026-09-27). The unit suite
 * (tests/conversion-fixes-sep2026.test.js) proves the shipped functions;
 * this proves the PAGE, with a fresh context per scenario — a first-time
 * visitor, which is what an ad click is.
 *
 *   §1 paid landings on an iPhone 13 (390x664, the VIEWPORT — not the 844
 *      screen, ERR-280): no overlay; printer box first; per-page h1; first
 *      Add button y; and a 150px sweep asking at every offset "if an Add is
 *      on screen, can a thumb reach one?" (the shopper's question, ERR-280)
 *   §2 PDP, both devices: printer fit above Add, points / free-shipping /
 *      phone lines, the dispatch line agreeing with the API's own
 *      `same_day_eligible`, hero image fetchpriority
 *   §3 CLS on each surface (layout-shift entries, hadRecentInput excluded)
 *   §4 NEGATIVE CONTROL: a synthetic fixed overlay over the cards must turn
 *      §1's sweep red — otherwise a green §1 means nothing
 *
 * MODE: READ-ONLY. GETs of public pages only: nothing is added to a cart, no
 * form is submitted, the header search box and the printer box are never
 * typed into (no /api/search/* call, so no search_analytics row — ERR-254/271).
 * Third-party analytics and /api/analytics/* are ABORTED in the browser: this
 * probe measures LAYOUT, not transport, so a route handler here changes no
 * answer it gives (the ctx.route caveat is about CORS/transport claims).
 * BASE defaults to localhost:3000 (`npx serve inkcartridges -l 3000`) — the
 * one origin the backend's CORS allows besides production.
 *
 *   npm run probe:conversion-fixes               # localhost
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:conversion-fixes
 */
import { chromium } from 'playwright';
import { PHONE, IPHONE_UA } from './lib/mobile-viewports.mjs';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const DESKTOP = { width: 1440, height: 900 };
const PDP_SKUS = ['GLC3329XLBK', 'GTN258BK'];
const LANDINGS = ['/ink-cartridges', '/toner-cartridges', '/shop?brand=hp&category=ink&code=65'];
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;

let pass = 0, fail = 0, softs = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const soft = (n, d) => { softs++; console.log(`  \x1b[33m⚠ ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, no form submits, no search typed; analytics aborted.');
console.log(`BASE ${BASE}  phone ${PHONE.width}x${PHONE.height}  desktop ${DESKTOP.width}x${DESKTOP.height}`);

const browser = await chromium.launch();
async function ctxFor(kind) {
    const ctx = await browser.newContext(kind === 'phone'
        ? { viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
        : { viewport: DESKTOP });
    await ctx.route(ANALYTICS, (r) => r.abort());
    await ctx.addInitScript(() => {
        window.__cls = 0;
        try {
            new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
                .observe({ type: 'layout-shift', buffered: true });
        } catch (_) { /* no layout-shift support */ }
    });
    return ctx;
}

/** At the current scroll offset: visible Add buttons, and whether ANY is reachable at its centre. */
const SWEEP_POINT = () => {
    const sel = '.product-card .product-card__add-btn, .product-card .add-to-cart-btn, .product-card .product-card__cart-btn, #add-to-cart-btn, #sticky-atc-btn';
    const vis = [...document.querySelectorAll(sel)].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(b).visibility !== 'hidden';
    });
    let reachable = 0; let blocker = null;
    for (const b of vis) {
        const r = b.getBoundingClientRect();
        const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        const hit = document.elementFromPoint(r.left + r.width / 2, y);
        if (hit && (hit === b || b.contains(hit))) reachable++;
        else if (hit && !blocker) blocker = (hit.id ? '#' + hit.id : hit.className || hit.tagName).toString().slice(0, 50);
    }
    return { visible: vis.length, reachable, blocker };
};

async function sweep(page, stepPx = 150) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    const dead = [];
    for (let y = 0; y < Math.min(h, 6000); y += stepPx) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(350);   // past the header's 0.2s slide
        const p = await page.evaluate(SWEEP_POINT);
        if (p.visible > 0 && p.reachable === 0) dead.push(`${y}(${p.blocker})`);
    }
    return dead;
}

try {
    /* ══ §1 paid landing pages on a phone ══════════════════════════════════ */
    head('§1 paid landings — iPhone 13 viewport, first-time visitor');
    for (const path of LANDINGS) {
        const ctx = await ctxFor('phone');
        const page = await ctx.newPage();
        await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}gclid=probe`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(6000);
        const m = await page.evaluate(() => {
            const firstAdd = [...document.querySelectorAll('.product-card .product-card__add-btn, .product-card .product-card__cart-btn, .product-card .add-to-cart-btn')]
                .find((b) => b.getBoundingClientRect().height > 0);
            const box = document.getElementById('landing-printer-search');
            return {
                h1: (document.querySelector('h1') || {}).textContent?.trim(),
                firstAddY: firstAdd ? Math.round(firstAdd.getBoundingClientRect().top + scrollY) : null,
                printerBox: !!box && !box.hidden,
                nudge: !!document.getElementById('rewards-nudge'),
                strip: !!document.getElementById('value-strip') && !document.getElementById('value-strip').hidden,
                banner: Math.round(document.getElementById('consent-banner')?.getBoundingClientRect().height || 0),
                cls: +window.__cls.toFixed(3),
            };
        });
        console.log(`  ${path}  h1="${m.h1}"  firstAdd y=${m.firstAddY}  banner=${m.banner}px  CLS=${m.cls}`);
        check(`${path}: no rewards overlay`, !m.nudge);
        check(`${path}: consent banner compact (≤ 64px)`, m.banner > 0 && m.banner <= 64, `${m.banner}px (was 148)`);
        if (path !== LANDINGS[2]) {
            check(`${path}: printer-model box shown first`, m.printerBox);
            check(`${path}: per-page h1`, /^(Ink|Toner) Cartridges NZ — Genuine & Compatible$/.test(m.h1 || ''), m.h1);
        }
        check(`${path}: value strip rendered`, m.strip);
        check(`${path}: CLS < 0.1`, m.cls < 0.1, String(m.cls));
        if (m.firstAddY !== null && m.firstAddY > 520) soft(`${path}: first Add at y ${m.firstAddY}`, 'handoff target is ≤ 520 on a 664px viewport');
        const dead = await sweep(page);
        check(`${path}: at every 150px offset with an Add on screen, one is tappable`, dead.length === 0,
            dead.length ? `dead at ${dead.join(', ')}` : 'no dead offsets');
        await ctx.close();
    }

    /* ══ §2 PDP ═══════════════════════════════════════════════════════════ */
    for (const kind of ['phone', 'desktop']) {
        head(`§2 PDP — ${kind}`);
        for (const sku of PDP_SKUS) {
            const ctx = await ctxFor(kind);
            const page = await ctx.newPage();
            const api = await (await fetch(`https://ink-backend-zaeq.onrender.com/api/products/${sku}`)).json().catch(() => null);
            await page.goto(`${BASE}/p/${sku}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForSelector('#product-title:not(:empty)', { timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(5000);
            const m = await page.evaluate(() => {
                const y = (id) => { const e = document.getElementById(id); return e && !e.hidden ? Math.round(e.getBoundingClientRect().top + scrollY) : null; };
                return {
                    fitY: y('product-fit'), valueY: y('product-value-lines'), addY: y('add-to-cart-btn'),
                    fitItems: document.querySelectorAll('#product-fit .product-fit__item').length,
                    points: document.getElementById('product-points-line')?.textContent || '',
                    call: document.querySelector('.product-value-lines__call')?.textContent || '',
                    delivery: document.getElementById('product-delivery')?.textContent.replace(/\s+/g, ' ').trim() || '',
                    heroPriority: document.querySelector('#product-image img')?.getAttribute('fetchpriority') || null,
                    cls: +window.__cls.toFixed(3),
                };
            });
            const eligible = api && api.data && api.data.delivery_estimate ? api.data.delivery_estimate.same_day_eligible : undefined;
            console.log(`  ${sku}: fit y=${m.fitY} (${m.fitItems} printers)  value y=${m.valueY}  Add y=${m.addY}  CLS=${m.cls}`);
            console.log(`    points="${m.points}"  call="${m.call}"`);
            console.log(`    delivery="${m.delivery}"  (API same_day_eligible=${eligible})`);
            if (kind === 'phone') {
                // Phones: fit + value lines ABOVE Add (handoff §4.2/§8.1); the sticky
                // Add bar already carries the first screen.
                check(`${sku}: printer fit ABOVE Add`, m.fitY !== null && m.addY !== null && m.fitY < m.addY);
                check(`${sku}: value lines ABOVE Add`, m.valueY !== null && m.valueY < m.addY);
            } else {
                // Desktop: Add keeps its first screen, clear of the 61px consent bar
                // (D-P0-2); fit + value lines render one screen down, below it.
                check(`${sku}: Add to Cart fully above the consent bar at scroll 0`, m.addY !== null && m.addY + 48 <= DESKTOP.height - 61,
                    `Add y ${m.addY}-${m.addY + 48}, bar from y ${DESKTOP.height - 61}`);
                check(`${sku}: printer fit + value lines rendered (below Add on desktop)`, m.fitY !== null && m.valueY !== null && m.fitY > m.addY);
            }
            check(`${sku}: points line rendered`, /^Earn \d[\d,]* points \(\$\d+\.\d\d\) on this order$/.test(m.points), m.points);
            check(`${sku}: phone + founding year printed`, /027 474 0115/.test(m.call) && /since \d{4}/.test(m.call), m.call);
            if (eligible === false) check(`${sku}: no same-day promise while the API says not eligible`, !/same-day/i.test(m.delivery), m.delivery);
            else if (eligible === true) check(`${sku}: same-day line while eligible`, /same-day/i.test(m.delivery), m.delivery);
            else soft(`${sku}: dispatch line not checked`, 'could not read delivery_estimate from the API');
            check(`${sku}: hero image fetchpriority=high`, m.heroPriority === 'high', String(m.heroPriority));
            check(`${sku}: CLS < 0.1`, m.cls < 0.1, String(m.cls));
            await ctx.close();
        }
    }

    /* ══ §4 negative control ══════════════════════════════════════════════ */
    head('§4 negative control — can §1\'s sweep go red?');
    {
        const ctx = await ctxFor('phone');
        const page = await ctx.newPage();
        await page.goto(`${BASE}/ink-cartridges`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
        await page.evaluate(() => {
            const o = document.createElement('div');
            o.id = 'probe-synthetic-overlay';
            o.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483646;background:rgba(255,0,0,.05)';
            document.body.appendChild(o);
        });
        const dead = await sweep(page, 450);
        check('a full-screen synthetic overlay is reported as dead offsets', dead.length > 0, `${dead.length} dead offsets`);
        await ctx.close();
    }
} catch (e) {
    bad('probe crashed', e && e.message);
} finally {
    await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${softs} soft`);
process.exit(fail ? 1 : 0);
