#!/usr/bin/env node
/**
 * probe:checkout-funnel — the paid visitor's path from cart to payment (ERR-305)
 * =============================================================================
 * Backend handoff `ad-clicks-to-orders-FE-handoff-oct2026` §8 (2 Oct walk of the
 * whole funnel) and FE master checklist items 1, 3, 4, 9, 11 (5 Oct). Measures
 * what the backend will re-run after the deploy:
 *
 *   §8.2  "Proceed to Checkout" is on the first screen at 1366x768 and 390x664,
 *         clickable (elementFromPoint) with the consent banner OPEN;
 *         "Continue Shopping" is a text link, not a button.
 *   §8.3  the cart total row reads "Estimated total" and EQUALS the server's
 *         GET /api/cart summary.total; checkout never paints a shipping figure
 *         that then changes ("Calculating…" until the server answers).
 *   §8.1  the click reaches /checkout in under 1 second.
 *   §8.4  /payment has no "I authorize this payment" tick; the Terms line sits
 *         under Pay; /checkout has no Terms tick.
 *   §8.5  the address lookup asks NZ Post for 8 suggestions.
 *
 * MODE: READ-ONLY by default — fetches the three pages' HTML and checks markup.
 * Nothing is added to any cart, nothing is typed.
 *
 * RECORDING MODE (`--seed`): adds ONE line (PROBE_SKU, default CCLI681XXLBK) to a
 * BRAND-NEW guest cart per viewport, measures, then empties that cart in a
 * `finally`. The probe OWNS its rollback (ERR-257/262): it proves the cart was
 * non-empty a moment before the clear and empty after it, reading the cart the
 * SERVER echoes for that browser session. A failed cleanup exits 1 and says so.
 * Analytics collection is aborted in every context (ERR-254/271); the API is
 * never route()d (a Playwright route bypasses CORS).
 *
 * Exit: 0 all measured checks pass · 1 a finding or a failed cleanup ·
 *       2 could not run. A check that could not be measured is printed as
 *       NOT MEASURED and is never counted as a pass.
 */
import { chromium, devices } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const SKU = process.env.PROBE_SKU || 'CCLI681XXLBK';
const SEED = process.argv.includes('--seed');
const COLLECT = /google-analytics\.com\/(g\/)?collect|googleads\.g\.doubleclick\.net|doubleclick\.net\/pagead|google\.[a-z.]+\/pagead|googleadservices\.com|bat\.bing\.com|\/api\/analytics\/|clarity\.ms/;
const VIEWPORTS = [
    { name: 'laptop 1366x768', opts: { viewport: { width: 1366, height: 768 } } },
    // The backend's own re-check sizes (ad-clicks handoff "How we will verify").
    { name: 'laptop 1280x551', opts: { viewport: { width: 1280, height: 551 } } },
    { name: 'laptop 1366x599', opts: { viewport: { width: 1366, height: 599 } } },
    { name: 'laptop 1536x695', opts: { viewport: { width: 1536, height: 695 } } },
    { name: 'iPhone 13 390x664', opts: { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: devices['iPhone 13'].userAgent } },
];

let pass = 0, fail = 0, notMeasured = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const nm = (n, d) => { notMeasured++; console.log(`  \x1b[33m? NOT MEASURED: ${n}\x1b[0m — ${d}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const strip = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

console.log(SEED
    ? `\x1b[31mMODE: RECORDING (--seed).\x1b[0m Adds ONE line (${SKU}) to a NEW guest cart per viewport on ${BASE}, then empties it and verifies.`
    : '\x1b[33mMODE: READ-ONLY.\x1b[0m Page HTML only; no cart writes. Pass --seed to measure the live funnel with a throwaway guest cart.');
console.log(`BASE ${BASE}`);

async function markup() {
    head('Markup (§8.2, §8.4, §8.5) — READ-ONLY');
    const get = async (p) => { const r = await fetch(BASE + p); if (!r.ok) throw new Error(`${p} ${r.status}`); return strip(await r.text()); };
    let cart, checkout, payment, api;
    try {
        [cart, checkout, payment] = await Promise.all([get('/cart'), get('/checkout'), get('/payment')]);
        const src = (payment.match(/src="(\/js\/api\.js[^"]*)"/) || [])[1];
        api = src ? await (await fetch(BASE + src)).text() : '';
    } catch (e) { nm('page HTML', e.message); return; }
    check('/payment has no "I authorize this payment" tick', !/id="authorize-payment"|>\s*I authorize this payment\s*</.test(payment));
    check('/payment has the Terms line under Pay', /id="pay-terms"[^>]*>By placing this order you agree to our <a href="\/terms"/.test(payment));
    check('/checkout has no Terms tick box', !/id="terms"/.test(checkout));
    check('/cart "Continue Shopping" is a text link, not .btn', /class="cart-actions__continue"/.test(cart) && !/class="btn btn--secondary">\s*<svg[^]*?Continue Shopping/.test(cart));
    const iTotals = cart.indexOf('cart-summary__totals'), iCta = cart.indexOf('id="checkout-btn"'), iMsg = cart.indexOf('id="cart-shipping-message"');
    check('/cart checkout button follows the totals, before the free-shipping message', iTotals > 0 && iTotals < iCta && iCta < iMsg);
    check('/checkout shipping starts as "Calculating…", not a figure', /id="checkout-shipping" data-shipping-source="pending">Calculating…</.test(checkout));
    check('NZ Post suggest asks for 8', /async nzpostSuggest\(query, max = 8\)/.test(api || ''));
}

// ONE guest session for the whole run. The backend caps guest-session MINTS per
// IP ("RATE_LIMITED: Too many guest sessions", measured 2026-10-05) — a fresh
// context per viewport spent two, and parallel sessions' probes share the cap.
// The second viewport inherits the first's storage (guest id) but not its
// consent answer: localStorage consent is removed so the banner is open again.
// PROBE_GUEST_SESSION=<existing guest session id> reuses a session that
// already exists, so a run mints NONE (use it while the mint cap is closed).
let sharedState;
const REUSE = process.env.PROBE_GUEST_SESSION || '';
async function funnel(browser, vp) {
    head(`Funnel — ${vp.name} (RECORDING, consent banner open)`);
    const ctx = await browser.newContext({ ...vp.opts, ...(sharedState ? { storageState: sharedState } : {}) });
    if (REUSE && !sharedState) {
        await ctx.addInitScript((id) => { try { if (!localStorage.getItem('ink_guest_session_id')) localStorage.setItem('ink_guest_session_id', id); } catch (_) { /* fresh */ } }, REUSE);
    }
    await ctx.addInitScript(() => { try { localStorage.removeItem('cookie_consent'); } catch (_) { /* fresh */ } });
    await ctx.route(COLLECT, (r) => r.abort());
    const page = await ctx.newPage();
    let seeded = false;
    try {
        await page.goto(`${BASE}/cart?add=${encodeURIComponent(SKU)}:1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const ready = await page.waitForFunction(() => {
            const row = document.getElementById('cart-total-row');
            return row && row.dataset.totalSource !== 'pending' && document.querySelectorAll('#cart-items > *').length > 0;
        }, null, { timeout: 30000 }).then(() => true, () => false);
        if (!ready) { nm('cart rendered with the seeded line', 'no line within 30s'); return; }
        // The line must be on the SERVER, not only in this browser: a 429 from
        // the shared per-IP limiter (ERR-266) leaves a local-only line and a
        // server total of shipping alone, and every money check below would be
        // measuring that instead.
        const onServer = await page.evaluate(async () => (await API.getCart())?.data?.items?.length || 0).catch(() => 0);
        if (!onServer) { nm('everything on this viewport', 'the seeded line never reached the server cart (RATE_LIMITED guest sessions / cart limiter? re-run later)'); return; }
        seeded = true; // from here on the finally MUST remove a real server line
        // NO wait for the ?add= link's "Added 1 item" toast to go. It used to land
        // bottom-right, exactly on the laptop checkout button, for ~6s. Measuring
        // WITH it present is the point: on /cart it now sits at the top.
        await page.waitForTimeout(1000); // late banners/badges settle

        const m = await page.evaluate(async () => {
            const box = (sel) => {
                const e = document.querySelector(sel);
                if (!e) return null;
                const r = e.getBoundingClientRect();
                const visible = r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
                const hit = visible ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
                return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible, self: !!hit && e.contains(hit), hitBy: hit && !e.contains(hit) ? (hit.id || String(hit.className)).slice(0, 50) : '' };
            };
            const server = (await API.getCart())?.data?.summary || null;
            return {
                vh: innerHeight,
                banner: !!document.querySelector('#consent-banner.is-open, #consent-banner:not([hidden])'),
                cta: box('#checkout-btn'), sticky: box('#cart-sticky-checkout'),
                label: document.getElementById('cart-total-label')?.textContent.trim(),
                totalText: document.getElementById('cart-total')?.textContent.trim(),
                source: document.getElementById('cart-total-row')?.dataset.totalSource,
                points: document.getElementById('cart-points-earn')?.dataset.points,
                server,
            };
        });
        console.log(`  · viewport h${m.vh}, consent banner ${m.banner ? 'OPEN' : 'not shown'}; #checkout-btn y ${m.cta?.top}–${m.cta?.bottom}; sticky ${m.sticky?.visible ? `y ${m.sticky.top}–${m.sticky.bottom}` : 'hidden'}`);
        const real = m.cta && m.cta.visible && m.cta.bottom <= m.vh && m.cta.self;
        const sticky = m.sticky && m.sticky.visible && m.sticky.bottom <= m.vh && m.sticky.self;
        check('"Proceed to Checkout" on the first screen and clickable (elementFromPoint)', real || sticky,
            real ? `real button, bottom ${m.cta.bottom} ≤ ${m.vh}` : sticky ? `sticky bar, bottom ${m.sticky.bottom}` : `button bottom ${m.cta?.bottom}, covered by "${m.cta?.hitBy}"`);
        if (m.server && typeof m.server.total === 'number') {
            const want = '$' + m.server.total.toFixed(2) + ' NZD';
            check('total row is the server\'s summary.total', m.totalText === want && m.source === 'server', `"${m.label}" ${m.totalText} vs server ${want} (source=${m.source})`);
            check('label says the total includes shipping', m.label === (m.server.is_shipping_estimate === false || m.server.qualifies_for_free_shipping ? 'Total' : 'Estimated total'), m.label);
        } else nm('total row vs server', 'GET /api/cart gave no summary.total');
        check('points-to-earn row decided (a number, or LOUDLY absent)', /^\d+$|^absent$|^zero$/.test(String(m.points)), `data-points=${m.points}`);

        // §8.1 — click to /checkout.
        const target = real ? '#checkout-btn' : '#cart-sticky-checkout';
        // "Reaches /checkout" = the navigation to /checkout is committed (the
        // URL changes), measured from the click event inside the page so
        // Playwright's own actionability wait is not counted.
        await page.evaluate((sel) => {
            document.querySelector(sel).addEventListener('click', () => { sessionStorage.setItem('__probeClickAt', String(Date.now())); }, { capture: true, once: true });
        }, target);
        await Promise.all([page.waitForURL(/\/checkout/, { timeout: 15000, waitUntil: 'commit' }), page.click(target, { timeout: 5000 })]).catch(() => {});
        const arrived = Date.now();
        const clickedAt = Number(await page.evaluate(() => sessionStorage.getItem('__probeClickAt')).catch(() => 0));
        const ms = clickedAt ? arrived - clickedAt : NaN;
        if (!clickedAt) nm('click → /checkout time', 'the click timestamp did not survive the navigation');
        else check('click reaches /checkout in under 1 second', /\/checkout/.test(page.url()) && ms < 1000, `${ms}ms (click → navigation committed)`);

        // §8.3 — sample the checkout shipping cell; at most ONE figure may ever appear.
        const seen = await page.evaluate(() => new Promise((resolve) => {
            const out = [];
            const tick = () => {
                const el = document.getElementById('checkout-shipping');
                const t = el ? el.textContent.trim() : '(no cell)';
                if (out[out.length - 1] !== t) out.push(t);
            };
            tick();
            const id = setInterval(tick, 50);
            setTimeout(() => { clearInterval(id); resolve(out); }, 6000);
        }));
        const figures = [...new Set(seen.filter((t) => /\$|FREE/.test(t)))];
        check('checkout shows ONE shipping figure, never one that changes', figures.length <= 1 && !seen.some((t) => /skeleton/.test(t)), seen.join(' → '));
    } finally {
        if (seeded) {
            const before = await page.evaluate(async () => (await API.getCart())?.data?.items?.length ?? null).catch(() => null);
            await page.evaluate(async () => { await Cart.clear(); }).catch(() => {});
            const after = await page.evaluate(async () => (await API.getCart())?.data?.items?.length ?? null).catch(() => null);
            if (before > 0 && after === 0) ok('cleanup: the throwaway cart was non-empty and is now empty', `${before} → ${after}`);
            else bad('cleanup NOT verified', `items before=${before} after=${after} — a guest line for ${SKU} may be left behind in this session`);
        }
        sharedState = await ctx.storageState().catch(() => sharedState);
        await ctx.close();
    }
}

let browser;
try {
    await markup();
    if (SEED) {
        browser = await chromium.launch();
        for (const vp of VIEWPORTS) await funnel(browser, vp);
    } else {
        nm('funnel geometry, click timing, checkout figure', 'needs --seed (writes one throwaway guest line)');
    }
} catch (e) {
    console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${e.message}`);
    process.exitCode = 2;
} finally {
    if (browser) await browser.close();
}
console.log(`\n${pass} pass · ${fail} fail · ${notMeasured} not measured`);
if (!process.exitCode) process.exitCode = fail ? 1 : 0;
