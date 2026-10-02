#!/usr/bin/env node
/**
 * probe:ad-clicks — ERR-302, backend handoff ad-clicks-to-orders §4/§6/§7
 * =============================================================================
 * backend-docs/inbox/ad-clicks-to-orders-FE-handoff-oct2026.md. The unit suite
 * (tests/ad-clicks-to-orders-oct2026.test.js) proves the functions; this proves
 * the PAGES, each in a fresh first-visit context (consent bar open) at 1366x599:
 *
 *   §6 Footer: "See our reviews on Google" is shown, opens a new tab with
 *      noopener, and its href is the API's google_reviews_url (read from
 *      /api/site/trust by this probe and compared byte-for-byte).
 *   §7 PDP: the page pushes an Ads-scoped `view_item` with the page's SKU
 *      verbatim, AND the Google tag actually transmits it (the outgoing Ads
 *      request is captured and ABORTED, so no probe ever lands in the
 *      owner's remarketing audiences).
 *   §7 NEGATIVE CONTROL: a /shop listing must push NO Ads view_item — else a
 *      green §7 could just mean "every page sends one".
 *   §4 /cart, guest: the reminder box is bound (wrapper unhidden), UNTICKED,
 *      labelled exactly, and nothing has been POSTed to guest-contact.
 *      Read-only mode loads an EMPTY guest cart, so the box's on-screen
 *      position is NOT MEASURED here (the cart layout is hidden when empty);
 *      it is reported as such, never as a pass.
 *
 * MODE: READ-ONLY by default. Public GETs only; no cart write, nothing typed,
 * nothing ticked. Analytics collection endpoints are ABORTED in the browser
 * (gtag.js itself is allowed to load so its transmission can be observed).
 * This is a payload measurement, not a CORS claim (the ctx.route caveat).
 *
 * RECORDING MODE: `--record-opt-in=<email>` performs the backend's "done when"
 * for §4 ONCE: it adds one item to a NEW guest cart on the target site via
 * /cart?add=<SKU>:1 (a real guest cart write), ticks the box, enters <email>
 * and reports data-guest-contact. That creates a real guest_sessions consent
 * row and a real reminder email to <email> if the cart is abandoned. Use only
 * with an address the owner controls.
 *
 *   npm run probe:ad-clicks
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:ad-clicks
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:ad-clicks -- --record-opt-in=owner@example.co.nz
 */
import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = process.env.PROBE_API || 'https://api.inkcartridges.co.nz';
const VIEWPORT = { width: 1366, height: 599 };
const PDP_SKU = process.env.PROBE_SKU || 'GGI690KCMY';
const OPT_IN_SKU = process.env.PROBE_OPT_IN_SKU || 'CLC73BK';
const ADS_TAG = 'AW-18032498762';
const recordArg = process.argv.find((a) => a.startsWith('--record-opt-in='));
const RECORD_EMAIL = recordArg ? recordArg.split('=')[1] : null;
// Collection endpoints only. gtag/js (a script GET) is allowed through.
const COLLECT = /google-analytics\.com\/(g\/)?collect|googleads\.g\.doubleclick\.net|doubleclick\.net\/pagead|google\.[a-z.]+\/pagead|googleadservices\.com|bat\.bing\.com|\/api\/analytics\//;

let pass = 0, fail = 0, notMeasured = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const nm = (n, d) => { notMeasured++; console.log(`  \x1b[33m? NOT MEASURED: ${n}\x1b[0m — ${d}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(RECORD_EMAIL
    ? `\x1b[31mMODE: RECORDING.\x1b[0m Writes ONE guest cart line (${OPT_IN_SKU}) and ONE guest-contact consent for ${RECORD_EMAIL} on ${BASE}.`
    : '\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, nothing typed or ticked; analytics collection aborted.');
console.log(`BASE ${BASE}  API ${API}  viewport ${VIEWPORT.width}x${VIEWPORT.height}  PDP ${PDP_SKU}`);

const browser = await chromium.launch();
async function fresh() {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const aborted = [];
    await ctx.route(COLLECT, (r) => { aborted.push(r.request().url() + '\n' + (r.request().postData() || '')); return r.abort(); });
    const page = await ctx.newPage();
    const writes = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'OPTIONS' && /\/api\/cart/.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    // Record every gtag() call the page makes, before any page script runs.
    return { ctx, page, aborted, writes };
}
// Read gtag's own queue AFTER the fact. gtag/js replaces dataLayer.push when it
// loads, so wrapping push only sees what was queued before (and a re-wrapping
// accessor looped). The array keeps every gtag() call either way.
const gtagCalls = (page) => page.evaluate(() => (window.dataLayer || [])
    .filter((c) => c && typeof c === 'object' && typeof c.length === 'number' && c[0] === 'event')
    .map((c) => JSON.parse(JSON.stringify(Array.from(c)))));
const adsEvents = async (page, name) => (await gtagCalls(page))
    .filter((c) => c[1] === name && c[2] && c[2].send_to === ADS_TAG);

try {
    /* ══ §6 footer link ══════════════════════════════════════════════════ */
    head('§6 Footer — "See our reviews on Google"');
    {
        const trust = await fetch(`${API}/api/site/trust`).then((r) => r.json()).catch(() => null);
        const expected = trust && trust.data && trust.data.organization && trust.data.organization.google_reviews_url;
        if (!expected) bad('API organization.google_reviews_url readable', 'cannot compare the link to its source');
        const { ctx, page } = await fresh();
        await page.goto(`${BASE}/shop`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const state = await page.waitForFunction(() => {
            const el = document.getElementById('footer-google-reviews');
            return el && el.dataset.reviewsLink ? el.dataset.reviewsLink : null;
        }, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => null);
        const link = await page.evaluate(() => {
            const el = document.getElementById('footer-google-reviews');
            const a = el && el.querySelector('a');
            return el && a ? { hidden: el.hidden, href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() } : null;
        });
        check('footer link element exists', !!link);
        check('renderer reached a verdict', state === 'present', `data-reviews-link=${state}`);
        if (link) {
            check('shown', link.hidden === false);
            check('exact text', link.text === 'See our reviews on Google', link.text);
            check('opens a new tab with noopener', link.target === '_blank' && /noopener/.test(link.rel), `${link.target} / ${link.rel}`);
            if (expected) check('href is the API\'s google_reviews_url', link.href === new URL(expected).href, link.href);
            check('no stars or counts beside it', !/★|\d\.\d/.test(link.text));
        }
        await ctx.close();
    }

    /* ══ §7 PDP view_item ════════════════════════════════════════════════ */
    head(`§7 PDP ${PDP_SKU} — Ads remarketing view_item`);
    {
        await pause(3000);
        const { ctx, page, aborted } = await fresh();
        await page.goto(`${BASE}/p/${PDP_SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const rendered = await page.waitForFunction(() => /\$\d/.test(document.getElementById('product-price')?.textContent || ''), null, { timeout: 45000 }).then(() => true, () => false);
        if (!rendered) bad('PDP rendered', 'no price in 45s — nothing below is measured');
        await page.waitForTimeout(4000);   // gtag/js loads async and flushes its queue
        const events = await adsEvents(page, 'view_item');
        check('exactly one Ads-scoped view_item pushed', events.length === 1, `${events.length}`);
        const items = events[0] && events[0][2].items;
        check('items[0].id is the page SKU verbatim', !!items && items.length === 1 && items[0].id === PDP_SKU, JSON.stringify(items));
        check('google_business_vertical is retail', !!items && items[0] && items[0].google_business_vertical === 'retail');
        const sent = aborted.filter((u) => /doubleclick|googleadservices|google\.[a-z.]+\/pagead/.test(u) && /view_item/.test(decodeURIComponent(u)));
        if (!aborted.length) nm('transmission', 'no collection request at all (gtag/js blocked or not loaded?)');
        else check('the Google tag transmitted view_item to Ads carrying the SKU', sent.some((u) => decodeURIComponent(u).includes(PDP_SKU)),
            `${sent.length} Ads view_item request(s) of ${aborted.length} aborted`);
        await ctx.close();
    }

    /* ══ §7 negative control ═════════════════════════════════════════════ */
    head('§7 NEGATIVE CONTROL — a listing page sends no Ads view_item');
    {
        await pause(3000);
        const { ctx, page } = await fresh();
        await page.goto(`${BASE}/shop?brand=epson&category=ink&code=288`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(6000);
        const total = (await gtagCalls(page)).length;
        const events = await adsEvents(page, 'view_item');
        if (!total) nm('control', 'no gtag events at all — the control would pass vacuously');
        else check('no Ads view_item on /shop', events.length === 0, `${events.length} of ${total} gtag events`);
        await ctx.close();
    }

    /* ══ §4 cart reminder ════════════════════════════════════════════════ */
    head('§4 /cart — guest reminder box (read-only: empty guest cart)');
    {
        await pause(3000);
        const { ctx, page, writes, aborted } = await fresh();
        const contactPosts = [];
        page.on('request', (r) => { if (/\/api\/cart\/guest-contact/.test(r.url())) contactPosts.push(r.method()); });
        await page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const bound = await page.waitForFunction(() => document.getElementById('cart-guest-email')?.hidden === false, null, { timeout: 20000 })
            .then(() => true, () => false);
        const s = await page.evaluate(() => {
            const root = document.getElementById('cart-guest-email');
            const box = document.getElementById('cart-guest-email-consent');
            const layout = document.getElementById('cart-layout');
            return root && box ? {
                checked: box.checked, label: root.querySelector('.checkout-optin span')?.textContent.trim(),
                email: !!document.getElementById('cart-guest-email-input'), layoutHidden: !!layout && layout.hidden,
            } : null;
        });
        check('box bound for a guest (wrapper unhidden)', bound);
        check('box is UNTICKED', !!s && s.checked === false);
        check('exact label', !!s && s.label === "Email me a copy of my cart if I don't finish", s && s.label);
        check('has its own email field', !!s && s.email);
        check('nothing POSTed to guest-contact', contactPosts.length === 0, contactPosts.join(','));
        check('no cart write at all (READ-ONLY)', writes.length === 0, writes.join(', '));
        if (s && s.layoutHidden) nm('on-screen position', 'empty cart ⇒ #cart-layout hidden; run --record-opt-in on a real cart to measure');

        if (RECORD_EMAIL) {
            head(`§4 RECORDING — one real opt-in for ${RECORD_EMAIL}`);
            const r = await fresh();
            const posts = [];
            r.page.on('response', async (resp) => {
                if (/\/api\/cart\/guest-contact/.test(resp.url()) && resp.request().method() === 'POST') {
                    posts.push({ status: resp.status(), body: await resp.text().catch(() => '') });
                }
            });
            await r.page.goto(`${BASE}/cart?add=${OPT_IN_SKU}:1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await r.page.waitForFunction(() => !document.getElementById('cart-layout')?.hidden
                && document.getElementById('cart-guest-email')?.hidden === false, null, { timeout: 45000 });
            // A shopper types an address over several seconds; the deep link's
            // server add (which mints the guest session) and its cross-sell modal
            // both land in that window. Wait for the session, close the modal.
            await r.page.waitForFunction(() => typeof API !== 'undefined' && !!API.getGuestSessionId(), null, { timeout: 20000 });
            await r.page.waitForTimeout(3000);
            await r.page.keyboard.press('Escape');
            const pos = await r.page.evaluate(() => {
                const b = (id) => document.getElementById(id).getBoundingClientRect();
                return { checkoutBottom: Math.round(b('checkout-btn').bottom), boxTop: Math.round(b('cart-guest-email').top) };
            });
            check('box sits below Proceed to Checkout', pos.boxTop > pos.checkoutBottom, JSON.stringify(pos));
            const atc = await adsEvents(r.page, 'add_to_cart');
            check('the deep-link add pushed an Ads add_to_cart with the SKU', atc.some((c) => (c[2].items || []).some((i) => i.id === OPT_IN_SKU)), JSON.stringify(atc.map((c) => c[2].items)));
            await r.page.fill('#cart-guest-email-input', RECORD_EMAIL);
            await r.page.check('#cart-guest-email-consent');
            const verdict = await r.page.waitForFunction(() => document.getElementById('cart-guest-email')?.dataset.guestContact || null, null, { timeout: 20000 })
                .then((h) => h.jsonValue(), () => null);
            check('guest-contact accepted', verdict === 'sent', `data-guest-contact=${verdict}; POSTs ${JSON.stringify(posts)}`);
            const status = await r.page.textContent('#cart-guest-email-status');
            console.log(`  shopper sees: ${JSON.stringify(status && status.trim())}`);
            console.log(`  recorded at ${new Date().toISOString()} — ask the backend to confirm guest_sessions.contact_consent_at`);
            await r.ctx.close();
        }
        void aborted;
        await ctx.close();
    }
} finally {
    await browser.close();
}

console.log(`\n${pass} pass, ${fail} fail, ${notMeasured} not measured`);
process.exit(fail ? 1 : 0);
