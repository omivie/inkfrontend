#!/usr/bin/env node
/**
 * probe:cart-wallet-paint — FE master checklist (8 Oct) items 20 and 19
 * =======================================================================================
 * Item 20 (owner, 8 Oct): "The 'Pay instantly' option appears too late when I
 * open the cart." The backend measured the wallet button at 3.3 s on /cart with
 * a cold cache (2.0 s warm), against a 0.4 s page paint. The target is the
 * "or pay instantly" area visible at first paint, and the button live by ~2 s
 * with a cold cache.
 *
 *   §20  /cart with ONE line, N cold runs (each in a fresh browser context, so
 *        the HTTP cache is empty). A MutationObserver installed before any page
 *        script records every #cart-wallet `data-wallet` / `hidden` change
 *        against performance.now(), plus first-contentful-paint. Pass:
 *        - the box is VISIBLE with a >= 48px slot at the cart's FIRST PAINT,
 *          the moment #cart-layout is revealed (it ships `hidden` until
 *          cart.js renders the lines, so DOMContentLoaded shows nothing yet);
 *        - the median time to `ready` is < 2500 ms.
 *        A device with no wallet ends in `none`. That is reported and SKIPPED
 *        for the timing check: a skip is not a pass.                RECORDING
 *   §19  /checkout with the same cart: the "Email me when my cartridges are
 *        likely running low" box is visible and unticked; ticked, then reloaded,
 *        it is unticked again.                                       RECORDING
 *   §C   NEGATIVE CONTROL: the first-paint detector is fed the PRE-item-20
 *        record (box `hidden` at DCL) and MUST fail it.
 *
 * MODE: READ-ONLY unless `--record`, and the mode is PRINTED first.
 *   READ-ONLY runs §C, then loads an empty /cart and checks that the wallet box
 *   ends hidden there (an empty cart has nothing to pay).
 *   --record writes ONLY to this probe's own guest cart: one line of SKU, added
 *   with the storefront's own /cart?add= deep link. It NEVER posts /api/orders,
 *   never taps the wallet, never ticks the cart-copy opt-in, and never types an
 *   email. ROLLBACK (in `finally`): the line goes back to the quantity it had
 *   before the run (removed if it was absent). The rollback is VERIFIED by
 *   re-reading the cart, after first having seen the line present (an empty
 *   cart proves nothing on its own, ERR-269). Analytics hosts and
 *   /api/analytics/* are aborted in the browser.
 *
 *   npm run probe:cart-wallet-paint                       # READ-ONLY, localhost:3000
 *   npm run probe:cart-wallet-paint -- --record
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:cart-wallet-paint -- --record
 *   PROBE_RUNS=5               cold runs (default 3)
 *   PROBE_GUEST_SESSION=<id>   reuse an existing guest session (mints none; the
 *                              backend's guest-session mint cap is per IP, >1 h)
 */
import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const RECORD = process.argv.includes('--record');
const REUSE = process.env.PROBE_GUEST_SESSION || '';
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS || 3));
const SKU = process.env.PROBE_SKU || 'GLC3313BK';
const READY_TARGET_MS = 2500;
// The per-IP limiter (100/60 s) is SHARED across endpoints AND with every peer
// session on this machine (ERR-266): a 4 s pace saw 429s on 8 Oct.
const PACE_MS = Number(process.env.PROBE_PACE_MS || 15000);
const pace = () => new Promise((r) => setTimeout(r, PACE_MS));
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|clarity\.ms|\/api\/analytics\//;

let pass = 0, fail = 0, skips = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const skip = (n, d) => { skips++; console.log(`  \x1b[33m⤼ SKIPPED (not a pass): ${n}\x1b[0m — ${d}`); };
const info = (t) => console.log(`  · ${t}`);
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log(RECORD
    ? `\x1b[31mMODE: RECORDING.\x1b[0m Writes ONLY this probe's own guest cart (one ${SKU} line via /cart?add=); never /api/orders; rollback in finally, verified by re-read.`
    : '\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only. The timed cart runs and /checkout need --record and are SKIPPED.');
console.log(`BASE ${BASE}  runs ${RUNS}${REUSE ? '  (reusing a guest session)' : ''}`);

/** PURE. The box held its space when the cart first painted: visible, with the 48px slot. */
function visibleAtFirstPaint(rec) {
    const f = rec && rec.firstPaint;
    return !!(f && f.present && !f.hidden && f.slot >= 48);
}

// ═══ §C negative control ════════════════════════════════════════════════════
head('§C negative control: the detector must FAIL the pre-item-20 markup');
check('a box `hidden` at the cart\'s first paint is flagged', !visibleAtFirstPaint({ firstPaint: { present: true, hidden: true, slot: 0, state: '' } }));
check('a box without the 48px slot is flagged', !visibleAtFirstPaint({ firstPaint: { present: true, hidden: false, slot: 0, state: 'loading' } }));
check('a cart that never painted is flagged', !visibleAtFirstPaint({ firstPaint: null }));
check('the item-20 markup passes', visibleAtFirstPaint({ firstPaint: { present: true, hidden: false, slot: 48, state: 'loading' } }));

const browser = await chromium.launch();
let storageState = null;

/** Every #cart-wallet change from before the first script, against performance.now(). */
const RECORDER = () => {
    window.__wallet = { changes: [], firstPaint: null, fcp: null };
    const snap = (box, how) => window.__wallet.changes.push({
        t: Math.round(performance.now()), how, state: box.dataset.wallet || '', why: box.dataset.walletWhy || '', hidden: box.hidden,
    });
    const attach = (box) => {
        snap(box, 'parsed');
        new MutationObserver(() => snap(box, 'attr')).observe(box, { attributes: true, attributeFilter: ['data-wallet', 'data-wallet-why', 'hidden'] });
    };
    // The cart's first paint = the moment cart.js reveals #cart-layout.
    const firstPaint = () => {
        if (window.__wallet.firstPaint) return;
        const box = document.getElementById('cart-wallet');
        const slot = document.getElementById('cart-wallet-element');
        window.__wallet.firstPaint = {
            t: Math.round(performance.now()),
            present: !!box,
            hidden: box ? (box.hidden || getComputedStyle(box).display === 'none') : true,
            slot: slot ? Math.round(slot.getBoundingClientRect().height) : 0,
            state: box ? box.dataset.wallet || '' : '',
        };
    };
    let boxSeen = false, layoutSeen = false;
    const finder = new MutationObserver(() => {
        const box = document.getElementById('cart-wallet');
        if (box && !boxSeen) { boxSeen = true; attach(box); }
        const layout = document.getElementById('cart-layout');
        if (layout && !layoutSeen) {
            layoutSeen = true;
            const look = () => { if (!layout.hidden && getComputedStyle(layout).display !== 'none') firstPaint(); };
            new MutationObserver(look).observe(layout, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
            document.addEventListener('DOMContentLoaded', look);
        }
        if (boxSeen && layoutSeen) finder.disconnect();
    });
    finder.observe(document, { childList: true, subtree: true });
    try {
        new PerformanceObserver((l) => {
            for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__wallet.fcp = Math.round(e.startTime);
        }).observe({ type: 'paint', buffered: true });
    } catch (_) { /* old engine */ }
};

async function newPage(extra = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, ...extra, ...(storageState ? { storageState } : {}) });
    if (REUSE && !storageState) {
        await ctx.addInitScript((id) => { try { if (!localStorage.getItem('ink_guest_session_id')) localStorage.setItem('ink_guest_session_id', id); } catch (_) { /* fresh */ } }, REUSE);
    }
    await ctx.route(ANALYTICS, (r) => r.abort());
    const page = await ctx.newPage();
    const limited = [];
    page.on('response', (r) => { if (r.status() === 429) limited.push(r.url()); });
    return { ctx, page, limited };
}
const settled = (page) => page.waitForFunction(() => typeof Cart !== 'undefined' && !Cart.loading, null, { timeout: 15000 });
const walletDone = (page) => page.waitForFunction(() => {
    const b = document.getElementById('cart-wallet');
    return b && ['ready', 'none', 'error', 'off'].includes(b.dataset.wallet);
}, null, { timeout: 15000 }).catch(() => null);

if (!RECORD) {
    head('§20 empty /cart (READ-ONLY): the wallet box ends hidden');
    const { ctx, page } = await newPage();
    await ctx.addInitScript(RECORDER);
    await page.goto(`${BASE}/cart`, { waitUntil: 'load' });
    await walletDone(page);
    const rec = await page.evaluate(() => ({ ...window.__wallet, final: document.getElementById('cart-wallet')?.dataset.wallet, hidden: document.getElementById('cart-wallet')?.hidden }));
    info(`changes: ${rec.changes.map((c) => `${c.t}ms ${c.state}${c.hidden ? '(hidden)' : ''}`).join(' → ')}`);
    check('empty cart ⇒ the box ends hidden', rec.hidden === true, `data-wallet=${rec.final}`);
    await ctx.close();
    skip('§20 timed cold runs with one line', 'needs --record');
    skip('§19 /checkout reminder box', 'needs --record (an empty cart redirects /checkout)');
} else {
    let baseline = null;
    let sawLine = false;
    try {
        // ─── seed: one line through the storefront's own deep link ───────────
        head(`seed: one ${SKU} line (RECORDING)`);
        {
            const { ctx, page } = await newPage();
            await page.goto(`${BASE}/cart`, { waitUntil: 'load' });
            await settled(page).catch(() => {});
            baseline = await page.evaluate((sku) => {
                const it = (typeof Cart !== 'undefined' ? Cart.items : []).find((i) => i.sku === sku);
                return it ? it.quantity : 0;
            }, SKU);
            info(`baseline: ${SKU} ×${baseline}`);
            if (baseline === 0) {
                await page.goto(`${BASE}/cart?add=${SKU}:1`, { waitUntil: 'load' });
                await page.waitForFunction((sku) => typeof Cart !== 'undefined' && !Cart.loading
                    && Cart.items.some((i) => i.sku === sku), SKU, { timeout: 20000 });
            }
            // The SERVER must hold the line: a 429 on the add leaves it local-only,
            // the cart then has no server total, and every run would end
            // none/no-server-total — a probe artefact, not a wallet result (8 Oct).
            sawLine = await page.evaluate(async (sku) => {
                const r = await API.getCart();
                return ((r && r.data && r.data.items) || []).some((i) => i.product && i.product.sku === sku);
            }, SKU);
            check(`${SKU} is in the probe's SERVER cart (re-read)`, sawLine);
            if (!sawLine) throw new Error('seed line not on the server (rate limited?); no run would mean anything');
            storageState = await ctx.storageState();
            await ctx.close();
        }

        // ─── §20 cold runs ────────────────────────────────────────────────────
        head(`§20 /cart, ${RUNS} cold run(s): placeholder at first paint, wallet ready time`);
        const readies = [];
        for (let i = 1; i <= RUNS; i++) {
            await pace();
            const { ctx, page, limited } = await newPage(); // fresh context ⇒ empty HTTP cache
            await ctx.addInitScript(RECORDER);
            await page.goto(`${BASE}/cart`, { waitUntil: 'load' });
            await walletDone(page);
            const rec = await page.evaluate(() => window.__wallet);
            const final = rec.changes[rec.changes.length - 1] || {};
            const ready = rec.changes.find((c) => c.state === 'ready' && !c.hidden);
            const fp = rec.firstPaint;
            info(`run ${i}: FCP ${rec.fcp ?? '?'}ms · cart painted ${fp ? `${fp.t}ms (${fp.state || '-'}, ${fp.hidden ? 'HIDDEN' : 'visible'}, slot ${fp.slot}px)` : 'never'} · `
                + rec.changes.map((c) => `${c.t}ms ${c.state}${c.why ? '/' + c.why : ''}${c.hidden ? '(hidden)' : ''}`).join(' → '));
            check(`run ${i}: "or pay instantly" area visible when the cart first paints`, visibleAtFirstPaint(rec),
                `firstPaint=${JSON.stringify(fp)}`);
            if (ready) readies.push(ready.t);
            else if (final.state === 'none' && final.why === 'no-wallet-on-device') skip(`run ${i}: wallet ready time`, 'this browser reports no wallet (none/no-wallet-on-device); nothing to time');
            else bad(`run ${i}: wallet reached ready`, `ended ${final.state || '?'}/${final.why || '?'}${limited.length ? ' — 429s this run' : ''}`);
            if (limited.length) bad(`run ${i}: no 429`, limited.slice(0, 2).join(', '));
            await ctx.close();
        }
        if (readies.length) {
            const sorted = readies.slice().sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            info(`ready times (ms): ${readies.join(', ')}; median ${median} (8 Oct baseline 3300 cold)`);
            check(`median wallet ready < ${READY_TARGET_MS} ms cold`, median < READY_TARGET_MS, `${median} ms`);
        }

        // ─── §19 /checkout reminder box ─────────────────────────────────────
        head('§19 /checkout: the reorder-reminder box, unticked on every visit');
        await pace();
        {
            const { ctx, page } = await newPage();
            await page.goto(`${BASE}/checkout`, { waitUntil: 'load' });
            const box = page.locator('#reminder-consent');
            const seen = await page.locator('#reminder-consent-optin').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
            check('the box is visible on /checkout', seen, seen ? '' : `url ${page.url()}`);
            if (seen) {
                check('it starts unticked', !(await box.isChecked()));
                const label = (await page.locator('#reminder-consent-optin').innerText()).trim();
                check('the label is the backend copy', label === 'Email me when my cartridges are likely running low, so I can reorder in time.', label);
                await box.check();
                await page.reload({ waitUntil: 'load' });
                await page.locator('#reminder-consent-optin').waitFor({ state: 'visible', timeout: 15000 });
                await page.waitForTimeout(800);
                check('ticked, then reloaded ⇒ unticked again', !(await page.locator('#reminder-consent').isChecked()));
            }
            await ctx.close();
        }
    } catch (e) {
        bad('probe aborted', e.message);
    } finally {
        // ─── rollback, verified ─────────────────────────────────────────────
        head('ROLLBACK');
        if (baseline === null || !storageState) {
            info('nothing was added (seed did not run)');
        } else {
            await pace();
            const { ctx, page } = await newPage();
            await page.goto(`${BASE}/cart`, { waitUntil: 'load' });
            await settled(page).catch(() => {});
            const present = await page.evaluate((s) => Cart.items.some((i) => i.sku === s), SKU);
            check(`${SKU} present before rollback (so an absence after it means something)`, present || !sawLine);
            await page.evaluate(async ({ sku, q }) => {
                const it = Cart.items.find((i) => i.sku === sku);
                if (!it) return;
                if (q > 0) await Cart.updateQuantity(it.key || it.id, q);
                else await Cart.removeItem(it.key || it.id);
            }, { sku: SKU, q: baseline });
            await page.waitForTimeout(1500);
            const reread = await page.evaluate(async (s) => {
                const r = await API.getCart();
                const line = ((r && r.data && r.data.items) || []).find((i) => i.product && i.product.sku === s);
                return line ? line.quantity : 0;
            }, SKU);
            check(`re-read cart holds ${SKU} ×${baseline} (as before the run)`, reread === baseline, `server says ×${reread}`);
            await ctx.close();
        }
    }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed, ${skips} skipped${skips ? ' (a skip is not a pass)' : ''}`);
process.exit(fail ? 1 : 0);
