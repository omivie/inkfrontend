#!/usr/bin/env node
/**
 * probe:ga4-events — do the four GA4 ecommerce hits actually LEAVE THE BROWSER?
 * ============================================================================
 *
 * ERR-256 · backend handoff `ga4-ecommerce-events-FE-handoff-sep2026.md`
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * `tests/ga4-ecommerce-events-sep2026.test.js` has 70 assertions and every one
 * of them is about SOURCE TEXT or about a function executed in a `vm` against a
 * recording `gtag`. They prove the module BUILDS the right payload. They cannot
 * prove a single byte reached Google, because in the test there is no gtag.js
 * from googletagmanager, no consent state, no CSP, and no network.
 *
 * All of these would leave the suite green and the funnel empty:
 *
 *   - CSP blocks the transport. `connect-src` has to carry
 *     *.google-analytics.com AND www.googletagmanager.com. That exact pair has
 *     bitten this site before: `googletagmanager.com` was in `script-src` but
 *     NOT `connect-src`, so "Fetch API cannot load .../td?id=AW-..." killed a
 *     conversion with no other symptom (errors.md ERR-049 neighbourhood).
 *     A CSP violation is invisible to every source assertion in the repo.
 *   - `send_to` names a property the loader never configured, so the hit is
 *     built perfectly and routed into a black hole.
 *   - The call site never runs: a guard is false, an exception upstream skips
 *     it, or the element it is bound to was renamed. ERR-194 and ERR-214 are
 *     both exactly this, and both had green suites.
 *   - The hit leaves with `tid=AW-18032498762` and lands in the ad account,
 *     which is what the backend's duplicated-conversion monitor watches for.
 *
 * So this probe reads the WIRE. It watches the real requests the real browser
 * makes and decodes GA4's `en=` / `tid=` / `pr1=` / `gcs=` parameters, printing
 * them — a measurement, not a boolean. "It said OK" is how a measurement taken
 * once becomes a constant with a good alibi.
 *
 * There is NO ctx.route() in this file and there must never be one. A route
 * handler re-issues requests outside the browser's own enforcement, so it would
 * make this a measurement of the instrument rather than of the site — and CSP
 * and consent, the two things most likely to break this feature, are precisely
 * what it would bypass. `page.on('request')` OBSERVES; it does not intercept.
 *
 * A fresh browser context per section, for the same reason the mobile-fold probe
 * does it: a dirty profile (a stored consent decision, a warm cart, a dismissed
 * nudge) nearly disproved a correct brief once already.
 *
 * BOTH CONSENT STATES ARE MEASURED. The handoff says not to gate the calls
 * ourselves because Consent Mode handles it — so "we do not gate" is a CLAIM,
 * and §1 is the measurement of it: pre-consent the hit must still leave, marked
 * `gcs=G1-0`. If it does not, Google is not modelling anything and the funnel is
 * empty for every visitor who has not clicked Accept. Consent is then granted
 * THROUGH THE REAL UI — never by writing localStorage, and never through
 * setStorage(), which JSON-quotes the value against gtag.js's bare-string
 * compare (ERR-227).
 *
 * ── READ-ONLY. ──
 * GETs and clicks on the public storefront only. It adds a line to a GUEST cart
 * through the real UI (the same thing any visitor does) and never signs in,
 * never pays, never submits the checkout form. There is no --record and no
 * --update-baseline, deliberately: a probe that can record may be green only
 * because it just overwrote what it compared against (sweep:b2b ate a committed
 * fixture, 2026-08-12). The mode is PRINTED on every run so it can never be
 * assumed.
 *
 * It touches no /api/search/* endpoint, so it does not write a search_analytics
 * row (ERR-254). It DOES cause GA4 hits, which is unavoidable — measuring
 * whether a beacon fires means firing it. They are marked: every probe run sets
 * a debug_mode-ish marker in the page title check only, and the SKU used is a
 * real one, so expect a handful of view_item/add_to_cart events per run in the
 * property. That is stated here rather than discovered later.
 *
 * REPEATED RUNS WILL 429. POST /api/cart/items is rate-limited, and running this
 * probe several times in a few minutes exhausts it — after which the add is not
 * server-confirmed, so add_to_cart correctly does NOT fire. That is reported as
 * NOT EXERCISED with the status attached, never as a failure: blaming the tag
 * for the backend's answer is how a flaky red gets ignored. Leave a few minutes
 * between runs, or read the status line before believing a gap.
 *
 * Usage:  npm run probe:ga4-events
 *         PROBE_BASE=http://localhost:3000 npm run probe:ga4-events
 *         PROBE_SKU=GLC3333M npm run probe:ga4-events
 * Exit:   0 = every assertion held
 *         1 = an event did not leave the browser, or left wrongly routed
 *         2 = could not run (network / the page never rendered)
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const SKU = process.env.PROBE_SKU || 'CLC37BK';
const PROPERTY = 'G-SDQELG0FGD';
const SECOND_PROPERTY = 'G-YJXTSGLM28';
const ADS_TAG = 'AW-18032498762';
const PHONE = { width: 390, height: 844 };   // iPhone 14 — mobile is the point
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m── ${t} ──\x1b[0m`);

console.log('\n\x1b[1mprobe:ga4-events — do the GA4 ecommerce hits leave the browser? (ERR-256)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no writes.');
console.log('Observes real requests only. It DOES cause GA4 hits — measuring a beacon means firing it.');
console.log(`Target: ${BASE}   SKU: ${SKU}   Viewport: ${PHONE.width}x${PHONE.height}\n`);

/* ── Reading GA4 off the wire ─────────────────────────────────────────────── */

/** Is this one of Google's measurement endpoints? */
const isGa4 = (url) => /google-analytics\.com\/(g\/)?collect/.test(url)
    || /googletagmanager\.com\/[a-z]+\/collect/.test(url);
const isAds = (url) => /googletagmanager\.com\/td\?/.test(url)
    || /google(ads\.g\.doubleclick|adservices)\.[a-z.]+\/(pagead\/)?/.test(url)
    || /google\.com\/pagead\/1p-conversion/.test(url);

/**
 * One hit can carry several events: GA4 batches them as a POST whose body holds
 * one urlencoded row per line, with the shared parameters left in the query
 * string. Reading only the query string silently loses every batched event —
 * and batching is exactly what happens when several fire close together, which
 * is the normal case on a checkout page.
 */
function hitsFrom(req) {
    let url;
    try { url = new URL(req.url()); } catch { return []; }
    const shared = Object.fromEntries(url.searchParams.entries());
    const body = (() => { try { return req.postData(); } catch { return null; } })();
    if (!body || !body.trim()) return [shared];
    return body.split('\n').filter((l) => l.trim()).map((line) => ({
        ...shared,
        ...Object.fromEntries(new URLSearchParams(line).entries()),
    }));
}

/** GA4 packs a product as `idSKU~nmName~brBrand~caCategory~pr12.34~qt2`. */
function decodeProduct(pr) {
    const map = { id: 'item_id', nm: 'item_name', br: 'item_brand', ca: 'item_category', pr: 'price', qt: 'quantity' };
    const out = {};
    for (const part of String(pr).split('~')) {
        const k = part.slice(0, 2);
        if (map[k]) out[map[k]] = part.slice(2);
    }
    return out;
}

/**
 * net::ERR_ABORTED IS NOT A BLOCK, and conflating the two made this probe red on
 * its first real run.
 *
 * gtag delivers `/g/collect` with sendBeacon or a keepalive fetch, and Chromium
 * reports those as `requestfailed` / ERR_ABORTED whenever the page navigates or
 * unloads before the response is read — which on a checkout walk is most of
 * them. The hit was still SENT: we saw it in `page.on('request')` and decoded
 * its parameters. Treating that as a CSP refusal is a false positive, and a
 * probe that reddens on a benign condition is red for ever and gets ignored,
 * taking the next real failure with it (the ERR-223 lesson).
 *
 * A genuine refusal looks different and is what this still fails on:
 * ERR_BLOCKED_BY_* (CSP, client, or response) and the console's "Refused to
 * connect/load" line. Aborted counts are printed as information, never as a
 * verdict.
 */
const BENIGN_FAILURE = /ERR_ABORTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_CLOSED/;

/** Attach a recorder to a page. Returns the live arrays it fills. */
function record(page) {
    const ga4 = [];
    const ads = [];
    const blocked = [];
    const aborted = [];
    const adds = [];
    page.on('request', (req) => {
        const url = req.url();
        if (isGa4(url)) { for (const h of hitsFrom(req)) if (h.en) ga4.push(h); return; }
        if (isAds(url)) ads.push(url);
    });
    page.on('requestfailed', (req) => {
        const url = req.url();
        if (!isGa4(url) && !isAds(url)) return;
        const err = req.failure()?.errorText || 'failed';
        if (BENIGN_FAILURE.test(err)) { aborted.push(err); return; }
        blocked.push(`${url.slice(0, 110)} — ${err}`);
    });
    page.on('console', (msg) => {
        const t = msg.text();
        if (/Content Security Policy|Refused to (connect|load)/i.test(t)) blocked.push(`CSP: ${t.slice(0, 200)}`);
    });
    /* THE GA4 add_to_cart FIRES ONLY ON A SERVER-CONFIRMED 2xx, deliberately —
     * so "no event" has two causes again, and only one of them is a bug. If
     * POST /api/cart/items did not return 2xx (a cold Render start, a rate
     * limit, an out-of-stock refusal) then no event is DUE and the feature is
     * behaving exactly as specified. Without this the probe blames the tag for
     * the backend's answer, which is how a flaky red gets ignored. */
    page.on('response', (res) => {
        const url = res.url();
        if (/\/api\/cart\/items(\?|$)/.test(url) && res.request().method() === 'POST') {
            adds.push(res.status());
        }
    });
    return { ga4, ads, blocked, aborted, adds };
}

/** Report the transport honestly: refusals fail, beacon aborts are noise. */
function checkTransport(rec, where) {
    if (rec.blocked.length) {
        bad(`nothing Google-bound was refused (${where})`, rec.blocked.slice(0, 3).join('\n      '));
    } else {
        ok(`nothing Google-bound was refused (${where})`,
            rec.aborted.length ? `${rec.aborted.length} beacon(s) reported ERR_ABORTED — expected, the hits were sent` : 'clean');
    }
}

const named = (hits, name) => hits.filter((h) => h.en === name);
/** Poll for an event rather than sleeping a guess. */
async function waitForEvent(page, hits, name, ms = 15000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (named(hits, name).length) return named(hits, name);
        await page.waitForTimeout(500);
    }
    return [];
}

function describe(h) {
    const parts = [`tid=${h.tid}`, `gcs=${h.gcs || '(none)'}`];
    if (h.cu) parts.push(`cu=${h.cu}`);
    const value = h['epn.value'] !== undefined ? h['epn.value'] : h['ep.value'];
    if (value !== undefined) parts.push(`value=${value}`);
    if (h['ep.shipping_tier']) parts.push(`shipping_tier=${h['ep.shipping_tier']}`);
    if (h.pr1) parts.push(`pr1={${Object.entries(decodeProduct(h.pr1)).map(([k, v]) => `${k}:${v}`).join(', ')}}`);
    const extraProducts = Object.keys(h).filter((k) => /^pr[2-9]$/.test(k)).length;
    if (extraProducts) parts.push(`+${extraProducts} more items`);
    return parts.join('  ');
}
const valueOf = (h) => Number(h['epn.value'] !== undefined ? h['epn.value'] : h['ep.value']);

/* ── Driving the real UI ──────────────────────────────────────────────────── */

async function newPhone(browser) {
    const ctx = await browser.newContext({
        viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    return { ctx, page, rec: record(page) };
}

async function openPdp(page) {
    await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#add-to-cart-btn', { timeout: 30000 });
    await page.waitForTimeout(2500);
}

/** Accept analytics THROUGH THE REAL BANNER. Never by writing storage. */
async function acceptConsent(page) {
    const btn = page.locator('#consent-banner button', { hasText: 'Accept' }).first();
    try {
        await btn.waitFor({ state: 'visible', timeout: 8000 });
        await btn.click();
        await page.waitForTimeout(1200);
        return true;
    } catch {
        return false;
    }
}

async function addToCartThroughUi(page) {
    await page.evaluate(() => document.querySelector('#add-to-cart-btn').click());
    let stored = null;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(750);
        stored = await page.evaluate(() => localStorage.getItem('inkcartridges_cart'));
        if (stored && stored !== '[]') break;
    }
    if (!stored || stored === '[]') throw new Error('cart did not seed after 15s — the add-to-cart path itself is broken');
}

/** /checkout never reaches networkidle: the payment SDKs hold connections open. */
async function openCheckout(page) {
    await page.goto(`${BASE}/checkout`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name="email"]', { timeout: 30000 });
    await page.waitForTimeout(4500);
}

/**
 * Walk the accordion the way a shopper does, up to the delivery Continue.
 *
 * add_shipping_info fires only when _validateAccordionSection() returns true,
 * and that validates every visible [required] field in the section. The first
 * run of this probe clicked Continue on an EMPTY form, validation refused, and
 * no event fired — the site was right and the probe was wrong. Filling the form
 * is not a convenience here; an unfilled form measures nothing.
 *
 * Nothing is written to storage and the form is never submitted: this stops at
 * the delivery section's own Continue button.
 */
async function walkToDelivery(page) {
    const filled = [];
    const set = async (sel, value) => {
        const el = page.locator(sel).first();
        if (!(await el.count())) return;
        try { await el.fill(value, { timeout: 5000 }); filled.push(sel); } catch { /* not visible yet */ }
    };

    // Section 0 — contact.
    await set('#email', 'ga4probe@example.com');
    await set('#phone', '211234567');
    await page.evaluate(() => {
        const email = document.querySelector('#email');
        const section = email && email.closest('fieldset.checkout-section');
        const btn = section && section.querySelector('.checkout-section__continue-btn');
        if (btn) btn.click();
    });
    await page.waitForTimeout(1200);

    // Section 1 — shipping address + delivery area.
    await set('#first-name', 'Ga4');
    await set('#last-name', 'Probe');
    await set('#address1', '12 Example Street');
    await set('#city', 'Auckland');
    await set('#postcode', '1010');
    // A <select> needs selectOption, and the region drives the freight quote.
    try {
        const region = page.locator('#region').first();
        if (await region.count()) {
            const value = await region.evaluate((el) => {
                const opt = Array.from(el.options).find((o) => o.value && o.value.trim() !== '');
                return opt ? opt.value : null;
            });
            if (value) { await region.selectOption(value); filled.push(`#region=${value}`); }
        }
    } catch { /* reported through `filled` */ }
    // `terms` is a required checkbox inside this section.
    await page.evaluate(() => {
        const t = document.querySelector('#terms');
        if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.waitForTimeout(600);
    return filled;
}

/**
 * The cart as the page sees it, right now.
 *
 * add_shipping_info and begin_checkout both REFUSE an empty cart on purpose (an
 * empty cart has no value, and reporting 0 for it was a real bug this probe
 * caught). So "no event fired" has two completely different causes and they must
 * not be reported as one: the feature is broken, or there was legitimately
 * nothing to report. Asking the cart is what tells them apart.
 *
 * This matters most on localhost, where a guest's session cookie does not reach
 * api.inkcartridges.co.nz, so the server answers with an empty cart and
 * Cart.items is 0 on /checkout while localStorage still holds the line. On that
 * host the delivery-step assertions are NOT EXERCISED rather than failing — and
 * a probe that reddens on a benign environment is red for ever and gets ignored.
 */
async function cartState(page) {
    return page.evaluate(() => ({
        lines: (typeof Cart !== 'undefined' && Array.isArray(Cart.items)) ? Cart.items.length : null,
        subtotal: (typeof Cart !== 'undefined' && Cart.getSubtotal) ? Cart.getSubtotal() : null,
        serverPriced: (typeof Cart !== 'undefined' && Cart.hasServerPricing) ? Cart.hasServerPricing() : null,
        pricingState: (typeof Cart !== 'undefined') ? Cart.pricingState : null,
        stored: (() => { try { const v = localStorage.getItem('inkcartridges_cart'); return v ? JSON.parse(v).length : 0; } catch { return null; } })(),
    }));
}

/** Click the Continue of the section that OWNS the delivery radios. */
async function pressDeliveryContinue(page) {
    return page.evaluate(() => {
        const radio = document.querySelector('input[name="delivery_type"]');
        if (!radio) return { state: 'no-delivery-control' };
        const section = radio.closest('fieldset.checkout-section');
        if (!section) return { state: 'no-section' };
        const btn = section.querySelector('.checkout-section__continue-btn');
        if (!btn) return { state: 'no-continue-button' };
        if (btn.hidden || btn.offsetParent === null) {
            const heading = section.querySelector('.checkout-section__heading');
            if (heading) heading.click();
        }
        btn.click();
        // Did validation accept it? An error node or is-error class means no.
        const errors = Array.from(section.querySelectorAll('.form-error')).map((e) => e.textContent.trim());
        const invalid = Array.from(section.querySelectorAll('.is-error')).length;
        return {
            state: 'clicked',
            validated: errors.length === 0 && invalid === 0,
            errors,
            checked: document.querySelector('input[name="delivery_type"]:checked')?.value || null,
        };
    });
}

/* ── Sections ─────────────────────────────────────────────────────────────── */

const browser = await chromium.launch();
let fatal = null;
try {
    /* ── 1. PRE-CONSENT — the hit must still leave, marked denied ─────────── */
    {
        head('1. Pre-consent: we do NOT gate the calls; Consent Mode does');
        const { ctx, page, rec } = await newPhone(browser);
        await openPdp(page);
        const hits = await waitForEvent(page, rec.ga4, 'view_item');

        checkTransport(rec, 'pre-consent PDP');

        check('view_item leaves the browser BEFORE consent is given', hits.length > 0,
            hits.length ? describe(hits[0]) : 'no view_item hit observed in 15s — if Consent Mode is '
                + 'suppressing it outright, the funnel is empty for every visitor who has not clicked Accept');

        if (hits.length) {
            const gcs = hits[0].gcs || '';
            check('and it is marked as consent-DENIED, which is what makes it modelled', gcs.startsWith('G1-0'),
                `gcs=${gcs || '(none)'} (expected G1-0 before Accept)`);
        }
        await ctx.close();
    }

    /* ── 2. view_item, with consent granted through the real banner ───────── */
    let grantedOnce = false;
    {
        head('2. view_item — after Accept, on the PDP');
        const { ctx, page, rec } = await newPhone(browser);
        await openPdp(page);
        const accepted = await acceptConsent(page);
        grantedOnce = accepted;
        if (!accepted) {
            soft('the consent banner was clickable', 'no #consent-banner Accept button found — '
                + 'consent-state assertions below are NOT EXERCISED (a skip is not a pass)');
        } else {
            ok('consent granted through the real banner UI (no storage writes)');
        }
        // Reload so a fresh page emits view_item with consent already granted.
        rec.ga4.length = 0;
        await openPdp(page);
        const hits = await waitForEvent(page, rec.ga4, 'view_item');

        check('view_item reaches Google', hits.length > 0,
            hits.length ? describe(hits[0]) : 'no view_item observed in 15s');

        if (hits.length) {
            const h = hits[0];
            const p = h.pr1 ? decodeProduct(h.pr1) : {};
            check('it is routed to the one GA4 property', h.tid === PROPERTY, `tid=${h.tid}`);
            check('currency is NZD', h.cu === 'NZD', `cu=${h.cu}`);
            check('items[] is populated with the SKU as item_id', !!p.item_id, `pr1 item_id=${p.item_id || '(none)'}`);
            check('the SKU is the one we asked for', (p.item_id || '').toUpperCase() === SKU.toUpperCase(),
                `item_id=${p.item_id} vs SKU=${SKU}`);
            check('a value is carried', Number.isFinite(valueOf(h)) && valueOf(h) > 0, `value=${valueOf(h)}`);
            if (p.item_brand) ok('item_brand is present', p.item_brand);
            else soft('item_brand is absent on this SKU', 'omitted rather than guessed — correct if the payload has no brand');
            if (p.item_category) ok('item_category is the raw product_type', p.item_category);
            else soft('item_category is absent on this SKU', 'omitted rather than guessed');
            if (accepted) {
                check('the hit is now marked consent-GRANTED', (h.gcs || '').startsWith('G1-1'),
                    `gcs=${h.gcs || '(none)'} (expected G1-1 after Accept)`);
            }
        }
        await ctx.close();
    }

    /* ── 3. add_to_cart, and its parity with the Ads conversion ───────────── */
    {
        head('3. add_to_cart — on a real add, and the Ads twin');
        const { ctx, page, rec } = await newPhone(browser);
        await openPdp(page);
        await acceptConsent(page);
        rec.ga4.length = 0;
        rec.ads.length = 0;
        await addToCartThroughUi(page);
        const hits = await waitForEvent(page, rec.ga4, 'add_to_cart');

        const confirmed2xx = rec.adds.some((s) => s >= 200 && s < 300);
        console.log(`  (POST /api/cart/items -> ${rec.adds.join(', ') || 'not observed'})`);

        if (!hits.length && !confirmed2xx) {
            soft('add_to_cart after an UNCONFIRMED add', `POST /api/cart/items answered `
                + `${rec.adds.join(', ') || 'nothing observed'} — the event fires only on a 2xx, by design, `
                + 'so none is DUE here and the tag is not what failed. NOT EXERCISED.');
        } else {
            check('add_to_cart reaches Google', hits.length > 0,
                hits.length ? describe(hits[0])
                    : `POST /api/cart/items returned ${rec.adds.join(', ')} (2xx) but NO add_to_cart followed `
                      + '— the server confirmed the add and the tag did not fire');
        }

        if (hits.length) {
            const h = hits[0];
            const p = h.pr1 ? decodeProduct(h.pr1) : {};
            check('routed to the one GA4 property', h.tid === PROPERTY, `tid=${h.tid}`);
            check('items[] carries the SKU', !!p.item_id, `item_id=${p.item_id || '(none)'}`);
            check('quantity is the DELTA — one add of one unit reports 1', p.quantity === '1',
                `qt=${p.quantity} (a resulting LINE TOTAL here is BF-060/ERR-223)`);
            const unit = Number(p.price);
            const total = valueOf(h);
            if (Number.isFinite(unit) && Number.isFinite(total)) {
                check('value is unit x delta, not the line total',
                    Math.abs(total - unit * Number(p.quantity)) < 0.02,
                    `value=${total} vs price ${unit} x qty ${p.quantity}`);
            } else {
                soft('value/price parity NOT EXERCISED', `price=${p.price} value=${total}`);
            }
            check('exactly one add_to_cart per add', hits.length === 1, `${hits.length} hits observed`);
        }

        // The Ads conversion is on a different host and is not always decodable;
        // report what was seen rather than pretending to adjudicate it.
        if (rec.ads.length) ok(`the Google Ads conversion also fired (${rec.ads.length} request(s))`);
        else soft('the Ads conversion was NOT observed on the wire',
            'not exercised here — it may batch or use a host this probe does not match; '
            + 'probe:add-to-cart is the one that adjudicates the Ads tag');
        await ctx.close();
    }

    /* ── 4. begin_checkout + add_shipping_info on the real checkout ───────── */
    {
        head('4. begin_checkout and add_shipping_info — on /checkout, on a phone');
        const { ctx, page, rec } = await newPhone(browser);
        await openPdp(page);
        await acceptConsent(page);
        await addToCartThroughUi(page);
        rec.ga4.length = 0;
        await openCheckout(page);
        const begin = await waitForEvent(page, rec.ga4, 'begin_checkout');

        check('begin_checkout reaches Google', begin.length > 0,
            begin.length ? describe(begin[0]) : 'no begin_checkout observed in 15s');
        if (begin.length) {
            const h = begin[0];
            check('routed to the one GA4 property', h.tid === PROPERTY, `tid=${h.tid}`);
            check('items[] is populated', !!h.pr1, `pr1=${h.pr1 || '(none)'}`);
            check('a cart value is carried', Number.isFinite(valueOf(h)) && valueOf(h) > 0, `value=${valueOf(h)}`);
            check('exactly one begin_checkout per page load', begin.length === 1, `${begin.length} hits`);
        }

        // Fill the form the way a shopper does, then press the Continue of the
        // section that OWNS the delivery radios — found by the control, the same
        // way the page finds it.
        const filled = await walkToDelivery(page);
        console.log(`  (filled ${filled.length} field(s): ${filled.join(', ') || 'none'})`);
        const cart = await cartState(page);
        console.log(`  (cart at the delivery step: lines=${cart.lines} subtotal=${cart.subtotal} `
            + `serverPriced=${cart.serverPriced} state=${cart.pricingState} localStorage=${cart.stored})`);
        const pressed = await pressDeliveryContinue(page);

        if (cart.lines === 0) {
            soft('add_shipping_info on an EMPTY cart', `Cart.items=0 (localStorage still holds ${cart.stored}) `
                + '— the module refuses an empty cart on purpose, so no event is DUE and nothing is proven '
                + 'here. On localhost this is expected: a guest session cookie does not reach the API host. '
                + 'NOT EXERCISED.');
        } else if (pressed.state !== 'clicked') {
            soft('the delivery section Continue was NOT reachable', `${pressed.state} — `
                + 'add_shipping_info is NOT EXERCISED on this run (a skip is not a pass)');
        } else if (!pressed.validated) {
            soft('the delivery section did not validate, so no event is DUE',
                `errors: ${pressed.errors.join(' | ') || '(class only)'} — add_shipping_info is NOT `
                + 'EXERCISED. The site is correct to refuse; this probe could not complete the form.');
        } else {
            const ship = await waitForEvent(page, rec.ga4, 'add_shipping_info');
            check('add_shipping_info reaches Google', ship.length > 0,
                ship.length ? describe(ship[0]) : 'no add_shipping_info observed after the delivery Continue');
            if (ship.length) {
                const h = ship[0];
                const tier = h['ep.shipping_tier'];
                check('routed to the one GA4 property', h.tid === PROPERTY, `tid=${h.tid}`);
                check('shipping_tier is urban or rural, from the real control',
                    tier === 'urban' || tier === 'rural', `shipping_tier=${tier || '(absent)'}`);
                check('and it matches what is actually checked on the page', tier === pressed.checked,
                    `reported=${tier} checked=${pressed.checked}`);
            }
        }
        await ctx.close();
    }

    /* ── 5. Routing and the purchase rule, across every hit seen ──────────── */
    {
        head('5. Routing — nothing ecommerce-shaped may reach the ad account');
        const { ctx, page, rec } = await newPhone(browser);
        await openPdp(page);
        await acceptConsent(page);
        await addToCartThroughUi(page);
        // Wait for the add_to_cart beacon before navigating. Without this the
        // routing sweep below saw only 2 of the 4 event types, because the hit
        // was still in flight when /checkout replaced the page — a sweep that
        // silently covers half of what it claims to.
        await waitForEvent(page, rec.ga4, 'add_to_cart', 10000);
        await openCheckout(page);
        await waitForEvent(page, rec.ga4, 'begin_checkout', 10000);
        const filledAll = await walkToDelivery(page);
        const cartAll = await cartState(page);
        const pressedAll = await pressDeliveryContinue(page);
        if (cartAll.lines === 0) {
            soft('the routing sweep could not reach add_shipping_info',
                `the cart was empty at the delivery step (Cart.items=0, localStorage=${cartAll.stored}) `
                + '— no event is due; that event is not covered by the sweep');
        } else if (pressedAll.state === 'clicked' && pressedAll.validated) {
            await waitForEvent(page, rec.ga4, 'add_shipping_info', 10000);
        } else {
            soft('the routing sweep could not reach add_shipping_info',
                `${pressedAll.state}${pressedAll.validated === false ? ' / did not validate' : ''} `
                + `(filled ${filledAll.length} field(s)) — that event is not covered by the sweep`);
        }
        await page.waitForTimeout(2000);

        const ecommerce = rec.ga4.filter((h) =>
            ['view_item', 'add_to_cart', 'begin_checkout', 'add_shipping_info', 'purchase'].includes(h.en));
        console.log(`  observed ${rec.ga4.length} GA4 hit(s), ${ecommerce.length} ecommerce:`);
        for (const h of ecommerce) console.log(`    ${h.en.padEnd(18)} ${describe(h)}`);

        const misrouted = ecommerce.filter((h) => String(h.tid).startsWith('AW-'));
        check('no ecommerce event carries an Ads tag id', misrouted.length === 0,
            misrouted.length ? misrouted.map((h) => `${h.en} -> ${h.tid}`).join(', ')
                : 'none reached AW-18032498762');

        const toSecond = ecommerce.filter((h) => h.tid === SECOND_PROPERTY);
        check('no ecommerce event feeds the orphan second property', toSecond.length === 0,
            toSecond.length ? toSecond.map((h) => h.en).join(', ') : `none reached ${SECOND_PROPERTY}`);

        const purchases = rec.ga4.filter((h) => h.en === 'purchase');
        check('NO browser purchase event — that one is server-side only', purchases.length === 0,
            purchases.length ? `${purchases.length} browser purchase hit(s): ${purchases.map(describe).join(' | ')}`
                : 'none — revenue cannot be double-counted from the browser');

        check('every ecommerce hit that fired was routed to ' + PROPERTY,
            ecommerce.length > 0 && ecommerce.every((h) => h.tid === PROPERTY),
            ecommerce.length ? `${ecommerce.length}/${ecommerce.length} on ${PROPERTY}`
                : 'no ecommerce hits observed at all — nothing was measured here');

        checkTransport(rec, 'full funnel walk');

        if (!grantedOnce) {
            soft('consent could not be granted in this run',
                'the gcs=G1-1 half of the consent measurement was NOT EXERCISED');
        }
        await ctx.close();
    }
} catch (err) {
    fatal = err;
} finally {
    await browser.close();
}

console.log('\n────────────────────────────────────────────────────────');
if (fatal) {
    console.log(`\x1b[31mCOULD NOT RUN\x1b[0m — ${fatal.message}`);
    process.exit(2);
}
console.log(`${pass} passed, ${failures.length} failed, ${notes.length} not exercised`);
if (notes.length) {
    console.log('\n\x1b[33mNot exercised (a skip is not a pass):\x1b[0m');
    notes.forEach((n) => console.log(`  ~ ${n}`));
}
if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
}
/* A SKIP IS NOT A PASS, so the closing line must not claim what was skipped.
 * The old wording said "all four events leave the browser" even on a run where
 * two of them were never exercised — a green sentence covering a gap is worse
 * than a yellow one, because it is the line people read instead of the log. */
if (notes.length) {
    console.log(`\x1b[33mNothing regressed, but ${notes.length} check(s) were NOT EXERCISED — `
        + 'read them above before treating this run as proof.\x1b[0m');
} else {
    console.log('\x1b[32mAll four GA4 ecommerce events leave the browser, routed to the one property, '
        + 'with no browser purchase.\x1b[0m');
}
process.exit(0);
