#!/usr/bin/env node
/**
 * probe:fe-master-6oct — the backend's 6 Oct re-check of the FE master checklist (ERR-307)
 * =======================================================================================
 * Source: backend-docs/inbox/FE-MASTER-CHECKLIST-oct2026.md, "Status after the live
 * check on 6 October 2026" + Part 4. Items 5/7/8 keep their own probe
 * (`npm run probe:fe-master`); this one measures what that one cannot:
 *
 *   §6   PDP: "Earn N reward points" near the price.                    READ-ONLY
 *   §14  /cart GLC3313BK 1 → 3 → 1: the price column reads ~~$67.49~~ $66.14 at
 *        once; sampled every animation frame + every DOM change, the summary
 *        NEVER shows a money figure for a quantity it was not priced at (a
 *        "mixed" state); qty 3 settles at the server's own total.        RECORDING
 *   §15  /checkout: `test@gmail.con` + Tab ⇒ the backend's message under the
 *        field, aria-invalid, "Continue to Payment" disabled, the typo hint;
 *        one tap on the hint ⇒ cleared and enabled.                       RECORDING
 *   §3   phone 390x664: a "Proceed to Checkout" control on the first screen
 *        (elementFromPoint), consent open and after Decline.            RECORDING
 *   §9   click → /checkout navigation commit, 3 runs, target < 1000 ms.   RECORDING
 *   §C   NEGATIVE CONTROL: the §14 mixed-state detector is fed a synthetic
 *        qty-3 frame carrying the qty-1 total and MUST flag it.
 *
 * MODE: READ-ONLY unless `--record`, and the mode is PRINTED first.
 *   --record writes ONLY to this probe's own guest cart (one GLC3313BK line,
 *   quantity changes) and sends two POST /api/checkout/guest-prefill (the
 *   endpoint allows 5 a minute per IP). It NEVER posts /api/orders, never
 *   ticks the cart-copy opt-in, never types into a search box. ROLLBACK: the
 *   line is put back to the quantity it had before the run (removed if it was
 *   absent), and the rollback is VERIFIED by re-reading the cart — after first
 *   having seen the line present (an empty cart proves nothing on its own,
 *   ERR-269). Analytics hosts and /api/analytics/* are aborted in the browser.
 *
 *   npm run probe:fe-master-6oct                         # READ-ONLY, localhost:3000
 *   npm run probe:fe-master-6oct -- --record
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:fe-master-6oct -- --record
 *   PROBE_GUEST_SESSION=<id>  reuse an existing guest session (mints none; the
 *                             backend's guest-session mint cap is per IP, >1 h)
 */
import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const RECORD = process.argv.includes('--record');
const REUSE = process.env.PROBE_GUEST_SESSION || '';
const SKU = 'GLC3313BK';
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|clarity\.ms|\/api\/analytics\//;

let pass = 0, fail = 0, skips = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const skip = (n, d) => { skips++; console.log(`  \x1b[33m⤼ SKIPPED (not a pass): ${n}\x1b[0m — ${d}`); };
const info = (t) => console.log(`  · ${t}`);
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log(RECORD
    ? '\x1b[31mMODE: RECORDING.\x1b[0m Writes ONLY this probe\'s own guest cart (one GLC3313BK line) + 2 guest-prefill POSTs; never /api/orders; rollback verified by re-read.'
    : '\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only. Cart, checkout, phone and timing sections need --record and are SKIPPED.');
console.log(`BASE ${BASE}${REUSE ? '  (reusing a guest session)' : ''}`);

const browser = await chromium.launch();
let storageState = null;

async function newPage(viewport = { width: 1366, height: 768 }, extra = {}) {
    const ctx = await browser.newContext({ viewport, ...extra, ...(storageState ? { storageState } : {}) });
    if (REUSE && !storageState) {
        await ctx.addInitScript((id) => { try { if (!localStorage.getItem('ink_guest_session_id')) localStorage.setItem('ink_guest_session_id', id); } catch (_) { /* fresh */ } }, REUSE);
    }
    await ctx.route(ANALYTICS, (r) => r.abort());
    const page = await ctx.newPage();
    const limited = [];
    page.on('response', (r) => { if (r.status() === 429) limited.push(r.url()); });
    return { ctx, page, limited };
}
const settled = (page) => page.waitForFunction(() => typeof Cart !== 'undefined' && !Cart.loading
    && Cart.pricingState === 'ok' && !Cart._mutationRepriceComing(), null, { timeout: 15000 });

// ─── the mixed-state detector (pure; §C feeds it a synthetic bad frame) ──────
/** A frame is MIXED when it shows a money total for a quantity whose settled total differs. */
function mixedFrames(frames, settledTotals) {
    return frames.filter((f) => /\$\d/.test(f.total || '')
        && settledTotals[f.qty] !== undefined && f.total !== settledTotals[f.qty]
        || (/\$\d/.test(f.total || '') && settledTotals[f.qty] === undefined));
}

// ═══ §6 PDP copy (READ-ONLY) ═════════════════════════════════════════════════
head('§6 PDP: "Earn N reward points" near the price (READ-ONLY)');
{
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'load' });
    const line = await page.waitForFunction(() => {
        const el = document.getElementById('product-points-line');
        return el && !el.hidden && el.textContent.trim() ? el.textContent.trim() : null;
    }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
    if (line === null) bad('points line rendered', 'absent after 15 s');
    else check('reads "Earn N reward points ($X) on this order"', /^Earn [\d,]+ reward points \(\$[\d.]+\) on this order$/.test(line), JSON.stringify(line));
    await ctx.close();
}

if (!RECORD) {
    for (const s of ['§14 cart volume price', '§15 checkout email', '§3 phone sticky bar', '§9 click timing']) skip(s, 'needs --record (writes the probe\'s own guest cart)');
} else {
    // ═══ §14 cart volume price, no mixed summary ═════════════════════════════
    head(`§14 /cart ${SKU} 1 → 3 → 1 (RECORDING)`);
    const { ctx, page, limited } = await newPage();
    await page.goto(`${BASE}/cart`, { waitUntil: 'load' });
    await settled(page).catch(() => {});
    const baseline = await page.evaluate((sku) => {
        const it = (typeof Cart !== 'undefined' ? Cart.items : []).find((i) => i.sku === sku);
        return it ? it.quantity : 0;
    }, SKU);
    info(`baseline: ${SKU} ×${baseline}`);
    if (baseline === 0) {
        // The storefront's own deep link (item 12) adds the line.
        await page.goto(`${BASE}/cart?add=${SKU}:1`, { waitUntil: 'load' });
    } else if (baseline !== 1) {
        await page.evaluate(async (sku) => {
            const it = Cart.items.find((i) => i.sku === sku);
            await Cart.updateQuantity(it.key || it.id, 1);
        }, SKU);
        await page.reload({ waitUntil: 'load' });
    }
    await settled(page);
    const ladder = await page.evaluate(async (sku) => (await API.get(`/api/products/${encodeURIComponent(sku)}`)).data.quantity_breaks, SKU);
    const rung3 = (ladder || []).filter((b) => b.min_quantity <= 3).sort((a, b) => b.min_quantity - a.min_quantity)[0];
    info(`live ladder rung for qty 3: ${rung3 ? `$${rung3.business_price}` : 'none'}`);

    // Sample every frame and every DOM change.
    await page.evaluate((sku) => {
        window.__frames = [];
        const row = () => [...document.querySelectorAll('.cart-item')].find((r) => r.textContent.includes(sku));
        const snap = () => {
            const r = row();
            if (!r) return;
            const t = (s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim();
            window.__frames.push({
                at: performance.now(),
                qty: Number(r.querySelector('.quantity-selector__input')?.value),
                price: (r.querySelector('.cart-item__price')?.textContent || '').replace(/\s+/g, ' ').trim(),
                priceMobile: (r.querySelector('.cart-item__price-mobile')?.textContent || '').replace(/\s+/g, ' ').trim(),
                lineTotal: (r.querySelector('.cart-item__total')?.textContent || '').replace(/\s+/g, ' ').trim(),
                total: t('#cart-total').replace(/ NZD$/, ''),
                shipping: t('#cart-shipping'),
                // The volume discount lands in the "Volume discount" row
                // (#cart-b2b-row) or the generic "You Save" row.
                savingsShown: ['cart-savings-row', 'cart-b2b-row'].some((id) => document.getElementById(id) && !document.getElementById(id).hidden),
                discount: ['cart-savings', 'cart-b2b-discount'].map((id) => document.getElementById(id)?.closest('[id$="-row"]')?.hidden === false ? t('#' + id) : '').join(''),
                state: Cart.pricingState,
            });
        };
        new MutationObserver(snap).observe(document.querySelector('.cart-page') || document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const loop = () => { snap(); window.__raf = requestAnimationFrame(loop); };
        loop();
    }, SKU);
    const settledTotals = {};
    const readTotal = () => page.evaluate(() => (document.querySelector('#cart-total')?.textContent || '').replace(/\s+/g, ' ').trim().replace(/ NZD$/, ''));
    settledTotals[1] = await readTotal();

    const plus = page.locator('.cart-item', { hasText: SKU }).locator('.quantity-selector__btn--increase');
    const minus = page.locator('.cart-item', { hasText: SKU }).locator('.quantity-selector__btn--decrease');
    const net = { put: 0, putWithCart: 0, get: 0 };
    page.on('request', (r) => {
        if (r.method() === 'GET' && /\/api\/cart(\?|$)/.test(r.url())) net.get++;
    });
    page.on('response', async (r) => {
        if (r.request().method() !== 'PUT' || !/\/api\/cart\/items\//.test(r.url())) return;
        net.put++;
        try { if ((await r.json())?.data?.cart?.items) net.putWithCart++; } catch (_) { /* not JSON */ }
    });
    const t0 = Date.now();
    await plus.click(); await plus.click();
    const atOnce = await page.evaluate(() => window.__frames.find((f) => f.qty === 3));
    await page.waitForTimeout(300);
    await settled(page);
    info(`qty 3 settled in ${Date.now() - t0} ms (includes the 400 ms debounce)`);
    if (net.putWithCart > 0) check('the PUT carried data.cart ⇒ no follow-up GET /api/cart', net.get === 0, `PUT ${net.put} (with cart ${net.putWithCart}), GET ${net.get}`);
    else skip('one request instead of two', `the PUT answered without data.cart (PUT ${net.put}, GET ${net.get}) — backend 6 Oct change not live here`);
    settledTotals[3] = await readTotal();
    const at3 = await page.evaluate(() => window.__frames[window.__frames.length - 1]);
    const want = rung3 ? `$${rung3.business_price.toFixed(2)}` : null;
    if (!want) bad('a qty-3 rung exists for the test SKU', 'ladder changed — pick another SKU');
    else {
        check('price column shows the rung price the FIRST frame qty reads 3', atOnce && atOnce.price.includes(want) && atOnce.price.includes('$67.49'), atOnce && JSON.stringify(atOnce.price));
        check('mobile price line shows it too', atOnce && atOnce.priceMobile.includes(want), atOnce && JSON.stringify(atOnce.priceMobile));
        check('line total = rung × 3 after settle', at3.lineTotal.includes(`$${(Math.round(rung3.business_price * 300) / 100).toFixed(2)}`), JSON.stringify(at3.lineTotal));
        check('volume discount row shown at qty 3', at3.savingsShown, `discount ${at3.discount}, total ${settledTotals[3]}, shipping ${at3.shipping}`);
    }
    const t1 = Date.now();
    await minus.click(); await minus.click();
    await page.waitForTimeout(300);
    await settled(page);
    info(`qty 1 settled in ${Date.now() - t1} ms`);
    const back = await page.evaluate(() => window.__frames[window.__frames.length - 1]);
    check('back at 1: $67.49, no strike, no volume discount row', back.qty === 1 && /^\$67\.49/.test(back.price) && !back.price.includes('$66') && !back.savingsShown, JSON.stringify(back.price));
    check('qty 1 settles to the same total it started at', (await readTotal()) === settledTotals[1], `${settledTotals[1]}`);
    const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames; });
    const mixed = mixedFrames(frames, settledTotals);
    check(`no MIXED summary frame (${frames.length} frames sampled)`, mixed.length === 0, mixed.length ? JSON.stringify(mixed.slice(0, 3)) : 'every money total matched its own quantity; in between: Updating…');
    info(`frames showing "Updating…": ${frames.filter((f) => f.total.startsWith('Updating')).length}`);

    // §C negative control: the detector must be able to go RED.
    head('§C NEGATIVE CONTROL — the mixed-state detector');
    const synthetic = [{ qty: 3, total: settledTotals[1] }];
    check('a qty-3 frame carrying the qty-1 total IS flagged', mixedFrames(synthetic, settledTotals).length === 1, `qty 3 + ${settledTotals[1]}`);
    check('a qty-2 money frame (never settled) IS flagged', mixedFrames([{ qty: 2, total: '$134.98' }], settledTotals).length === 1);

    storageState = await ctx.storageState();
    if (limited.length) bad('no 429 during §14', limited.slice(0, 2).join(', '));
    await ctx.close();

    // ═══ §15 checkout email ══════════════════════════════════════════════════
    head('§15 /checkout: test@gmail.con is caught under the field (RECORDING: 2 guest-prefill POSTs)');
    {
        const { ctx: c2, page: p2, limited: lim2 } = await newPage();
        const prefill = [];
        p2.on('response', (r) => { if (r.url().includes('/api/checkout/guest-prefill')) prefill.push(r.status()); });
        await p2.goto(`${BASE}/checkout`, { waitUntil: 'load' });
        await p2.waitForSelector('#email', { state: 'visible', timeout: 15000 });
        await p2.fill('#email', 'test@gmail.con');
        await p2.press('#email', 'Tab');
        const err = await p2.waitForSelector('#email-error', { timeout: 6000 }).then((h) => h.textContent()).catch(() => null);
        if (prefill[0] === 429) bad('NOT MEASURED', 'guest-prefill answered 429 (5/min/IP) — re-run in a minute');
        else {
            info(`guest-prefill answered ${prefill[0] ?? 'nothing'}`);
            check('the backend\'s message is under the field', !!err && /valid email/i.test(err), JSON.stringify(err));
            const st = await p2.evaluate(() => ({
                inv: document.getElementById('email').getAttribute('aria-invalid'),
                desc: document.getElementById('email').getAttribute('aria-describedby'),
                disabled: document.getElementById('continue-to-payment-btn').disabled,
                hint: document.getElementById('email-suggest')?.hidden === false ? document.getElementById('email-suggest').textContent : null,
            }));
            check('aria-invalid + aria-describedby', st.inv === 'true' && st.desc === 'email-error');
            check('"Continue to Payment" is disabled', st.disabled === true);
            check('typo hint offers test@gmail.com', st.hint === 'Did you mean test@gmail.com?', JSON.stringify(st.hint));
            await p2.click('.email-suggest__btn');
            const fixed = await p2.waitForFunction(() => !document.getElementById('email-error')
                && document.getElementById('email').value === 'test@gmail.com', null, { timeout: 6000 }).then(() => true).catch(() => false);
            await p2.waitForTimeout(1500); // the second prefill answer
            const after = await p2.evaluate(() => ({ disabled: document.getElementById('continue-to-payment-btn').disabled, err: !!document.getElementById('email-error') }));
            check('one tap fixes it: message gone, button enabled', fixed && !after.err && !after.disabled, `prefill statuses ${prefill.join(',')}`);
        }
        if (lim2.length) info(`429s: ${lim2.length}`);
        await c2.close();
    }

    // ═══ §3 phone sticky bar ═════════════════════════════════════════════════
    head('§3 phone 390x664: Proceed to Checkout on the first screen (RECORDING: answers consent with Decline)');
    {
        const { ctx: c3, page: p3 } = await newPage({ width: 390, height: 664 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
        await c3.addInitScript(() => { try { localStorage.removeItem('cookie_consent'); } catch (_) { /* fresh */ } });
        await p3.goto(`${BASE}/cart`, { waitUntil: 'load' });
        await settled(p3).catch(() => {});
        await p3.waitForTimeout(800);
        const hit = () => p3.evaluate(() => {
            const cands = [...document.querySelectorAll('#checkout-btn, #cart-sticky-checkout')];
            for (const b of cands) {
                const r = b.getBoundingClientRect();
                if (r.bottom <= innerHeight && r.top >= 0 && r.width) {
                    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    if (at && (at === b || b.contains(at))) return `${b.id} y ${Math.round(r.top)}–${Math.round(r.bottom)}`;
                }
            }
            return null;
        });
        const open = await p3.evaluate(() => !!document.querySelector('.consent-banner.is-open'));
        const h1 = await hit();
        check(`banner ${open ? 'OPEN' : 'not shown'}: a Proceed to Checkout control is hit-testable on screen`, !!h1, h1 || 'none');
        const decline = p3.locator('.consent-banner.is-open button', { hasText: /decline/i });
        if (await decline.count()) {
            await decline.first().click();
            await p3.waitForTimeout(800);
            const h2 = await hit();
            check('after Decline: still on screen and hit-testable', !!h2, h2 || 'none');
        } else skip('after-answer case', 'no Decline button on the banner');
        await c3.close();
    }

    // ═══ §9 click → /checkout ════════════════════════════════════════════════
    head('§9 click → /checkout navigation commit (RECORDING: 3 runs)');
    {
        const { ctx: c4, page: p4 } = await newPage();
        const runs = [];
        for (let i = 0; i < 3; i++) {
            await p4.goto(`${BASE}/cart`, { waitUntil: 'load' });
            await settled(p4);
            await p4.waitForFunction(() => !!(Cart._freshPrevalidation && Cart._freshPrevalidation()), null, { timeout: 5000 }).catch(() => {});
            const t = Date.now();
            await p4.click('#checkout-btn');
            await p4.waitForURL('**/checkout', { waitUntil: 'commit' });
            runs.push(Date.now() - t);
        }
        const med = runs.slice().sort((a, b) => a - b)[1];
        check('median click → /checkout commit < 1000 ms', med < 1000, `${runs.join(' / ')} ms`);
        await c4.close();
    }

    // ═══ rollback, verified ══════════════════════════════════════════════════
    head('ROLLBACK');
    {
        const { ctx: c5, page: p5 } = await newPage();
        await p5.goto(`${BASE}/cart`, { waitUntil: 'load' });
        await settled(p5);
        const seen = await p5.evaluate((sku) => Cart.items.some((i) => i.sku === sku), SKU);
        check(`${SKU} present before rollback (so an absence after it means something)`, seen);
        await p5.evaluate(async ({ sku, q }) => {
            const it = Cart.items.find((i) => i.sku === sku);
            if (!it) return;
            if (q > 0) await Cart.updateQuantity(it.key || it.id, q);
            else await Cart.removeItem(it.key || it.id);
        }, { sku: SKU, q: baseline });
        await p5.waitForTimeout(1500);
        const reread = await p5.evaluate(async (sku) => {
            const r = await API.getCart();
            const line = ((r && r.data && r.data.items) || []).find((i) => i.product && i.product.sku === sku);
            return line ? line.quantity : 0;
        }, SKU);
        check(`re-read cart holds ${SKU} ×${baseline} (as before the run)`, reread === baseline, `server says ×${reread}`);
        await c5.close();
    }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed, ${skips} skipped${skips ? ' (a skip is not a pass)' : ''}`);
process.exit(fail ? 1 : 0);
