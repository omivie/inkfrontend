#!/usr/bin/env node
/**
 * Can a phone actually get past the delivery-area gate? (ERR-235)
 * ===============================================================
 *
 * Mobile recorded 0 completed checkouts against 36 starts over 120 days. One
 * cause: NEITHER delivery_type radio was `checked`, both were `required`, and
 * three separate JS gates refused to advance without a selection — while the
 * page was ALREADY quoting the urban rate through
 * `...:checked')?.value || 'urban'`. It displayed an urban quote and then
 * refused to accept the state it was displaying.
 *
 * WHY A PROBE AND NOT ONLY TESTS. The hand-off's proposed fix was to add
 * `checked` to the markup. That is exactly what a source grep would have
 * certified — and it would have been WRONG, because init()'s first statement
 * un-checked the group on every load. A grep can read an attribute; only a
 * browser can tell you what the radio's state is after the page settles.
 *
 * WHAT THIS ASSERTS, at 390x844
 * -----------------------------
 *   A  exactly ONE delivery radio is checked after load, and it is urban
 *   B  both price labels are filled, FROM THE BACKEND, and they differ
 *   C  an RD address auto-selects Rural and SAYS SO in the live region
 *   D  removing the RD token puts it back — an automatic choice that cannot be
 *      automatically withdrawn is a typo that overcharges forever
 *   E  a hand-picked choice is never overridden by the address
 *   F  POSITIVE CONTROL: the gate still exists. If the group is cleared, the
 *      page still refuses to advance. Proving the dead end is gone is worth
 *      nothing if the safety net was simply deleted with it.
 *
 * Nothing here creates an order. It seeds a guest cart through the real UI
 * (never by writing storage), fills the shipping form, and reads state; it
 * never proceeds past /checkout.
 *
 * Usage:  npm run probe:checkout-delivery
 *         PROBE_BASE=http://localhost:3000 npm run probe:checkout-delivery
 * Exit:   0 = every assertion held
 *         1 = the gate regressed, or a measured value is wrong
 *         2 = could not run (network / no cart / the page never rendered)
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const LOCAL = BASE.includes('localhost');
const PHONE = { width: 390, height: 844 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const LANDING = LOCAL ? '/html/shop?category=ink' : '/ink-cartridges';
const CHECKOUT = LOCAL ? '/html/checkout' : '/checkout';

const URBAN_ADDRESS = { address1: '12 Great North Road', city: 'Auckland', region: 'auckland', postcode: '1021' };
const RURAL_LINE = '45 Someplace Road, RD 2';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mprobe:checkout-delivery — can a phone get past the delivery gate? (ERR-235)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route().');
console.log('Seeds a guest cart through the real UI and stops at /checkout. No order is created.');
console.log(`Target: ${BASE}\n`);

/** The delivery-area state, as the shopper's browser actually has it. */
const READ = () => {
    const radios = [...document.querySelectorAll('input[name="delivery_type"]')];
    const notice = document.getElementById('delivery-type-notice');
    const price = (v) => {
        const el = document.querySelector(`.delivery-type-option__price[data-delivery-price="${v}"]`);
        return el ? el.textContent.trim() : null;
    };
    return {
        count: radios.length,
        checked: radios.filter((r) => r.checked).map((r) => r.value),
        urbanPrice: price('urban'),
        ruralPrice: price('rural'),
        noticeHidden: notice ? notice.hidden : null,
        noticeText: notice ? notice.textContent.trim() : null,
        shippingShown: (document.getElementById('checkout-shipping') || {}).textContent ?? null,
    };
};

const money = (s) => {
    if (!s) return null;
    if (/free/i.test(s)) return 0;
    const m = s.match(/([\d.]+)/);
    return m ? Number(m[1]) : null;
};

/** Seed a cart from the popular row — which also proves that row's Add works. */
async function seedCart(page) {
    await page.goto(`${BASE}${LANDING}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
        await page.waitForSelector('#popular-row-grid .product-card__add-btn', { timeout: 25000 });
    } catch {
        return `no Add button appeared in the popular row on ${LANDING} — either ERR-236 has `
            + 'regressed or this landing page is not rendering products at all';
    }
    await page.evaluate(() => document.querySelector('#popular-row-grid .product-card__add-btn').click());
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(750);
        const stored = await page.evaluate(() => localStorage.getItem('inkcartridges_cart'));
        if (stored && stored !== '[]') return null;
    }
    return 'the cart did not seed within 15s — the add-to-cart path itself may be broken';
}

async function fillShipping(page, addressLine) {
    await page.evaluate((addr) => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('email', 'probe@example.com');
        set('phone', '0211234567');
        set('first-name', 'Probe');
        set('last-name', 'Runner');
        set('city', addr.city);
        set('region', addr.region);
        set('postcode', addr.postcode);
        set('address1', addr.line1);
    }, { ...URBAN_ADDRESS, line1: addressLine });
    await page.waitForTimeout(2500);
}

const browser = await chromium.launch().catch((e) => {
    console.error(`\x1b[31mcould not launch a browser: ${e.message}\x1b[0m`);
    process.exit(2);
});

let fatal = null;
try {
    const ctx = await browser.newContext({
        viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();

    head('0  seed — a cart, through the real UI');
    const why = await seedCart(page);
    if (why) { fatal = why; throw new Error(why); }
    ok('a guest cart was seeded from the popular row', 'which also proves that row\'s Add button is bound');

    await page.goto(`${BASE}${CHECKOUT}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#checkout-form', { timeout: 30000 });
    await page.waitForTimeout(2500);

    // ── A ────────────────────────────────────────────────────────────────────
    head('A  the state of the group after the page settles');
    {
        const m = await page.evaluate(READ);
        check('there are two delivery options', m.count === 2, `found ${m.count}`);
        check('EXACTLY ONE is checked after load', m.checked.length === 1,
            `checked=[${m.checked.join(', ')}]. Zero is the ERR-235 dead end: both were `
            + '`required`, three JS gates refused to advance, and a phone could not check out. '
            + 'Two would mean the group is broken.');
        check('and it is Urban, not Rural', m.checked[0] === 'urban',
            `checked=[${m.checked.join(', ')}]. Rural costs roughly double; it must never be the `
            + 'default, including via browser autofill.');
        soft('this is the assertion a source grep could not make',
            'the hand-off proposed adding `checked` to the markup. init() used to un-check the '
            + 'group on every load, so the attribute was true in the file and false in the browser.');
    }

    // ── B ────────────────────────────────────────────────────────────────────
    head('B  both prices, from the backend, and different from each other');
    {
        await fillShipping(page, URBAN_ADDRESS.address1);
        const m = await page.evaluate(READ);
        const u = money(m.urbanPrice);
        const r = money(m.ruralPrice);
        check('the Urban option shows a price', u !== null, `urban label = ${JSON.stringify(m.urbanPrice)}`);
        check('the Rural option shows a price', r !== null, `rural label = ${JSON.stringify(m.ruralPrice)}`);
        if (u !== null && r !== null) {
            check('the two prices are NOT the same number twice', r !== u,
                `urban=${u} rural=${r}. Equal values would mean one quote was copied into both `
                + 'labels rather than each area being quoted on its own.');
            check('Rural is the dearer of the two', r > u,
                `urban=${u} rural=${r} — every rate row in /api/shipping/rates has rural above `
                + 'urban ($7/$14, $12/$20, $22/$30), so this ordering is the backend\'s, not ours');
        }
        soft('what this does NOT prove', 'that the figures match the courier invoice — only that '
            + 'they are the two numbers POST /api/shipping/options gave for this cart.');
    }

    // ── C ────────────────────────────────────────────────────────────────────
    head('C  an RD address selects Rural, out loud');
    {
        await fillShipping(page, RURAL_LINE);
        const m = await page.evaluate(READ);
        check('an "RD 2" address auto-selects Rural', m.checked[0] === 'rural',
            `checked=[${m.checked.join(', ')}] for ${JSON.stringify(RURAL_LINE)} — "RD n" is the `
            + 'New Zealand Rural Delivery convention and roughly doubles the freight');
        check('and the change is ANNOUNCED, not silent', m.noticeHidden === false && !!m.noticeText,
            `notice hidden=${m.noticeHidden} text=${JSON.stringify(m.noticeText)}. Moving a `
            + 'price-affecting field without saying so is indistinguishable from a bug.');
        if (m.noticeText) {
            check('the announcement names the token it matched', /RD\s*2/i.test(m.noticeText),
                `notice = ${JSON.stringify(m.noticeText)} — telling the shopper WHICH part of `
                + 'their address triggered this makes a wrong guess obvious to them');
        }
    }

    // ── D ────────────────────────────────────────────────────────────────────
    head('D  and it withdraws when the reason goes away');
    {
        await fillShipping(page, URBAN_ADDRESS.address1);
        const m = await page.evaluate(READ);
        check('removing the RD token puts it back to Urban', m.checked[0] === 'urban',
            `checked=[${m.checked.join(', ')}]. An automatic choice that cannot be automatically `
            + 'withdrawn is a typo that overcharges forever.');
        check('and the notice clears with it', m.noticeHidden === true || !m.noticeText,
            `notice hidden=${m.noticeHidden} text=${JSON.stringify(m.noticeText)} — a stale `
            + 'announcement about a selection that no longer holds is worse than none');
    }

    // ── E ────────────────────────────────────────────────────────────────────
    head('E  a person\'s own choice is never overridden');
    {
        await page.evaluate(() => {
            const r = document.querySelector('input[name="delivery_type"][value="urban"]');
            r.checked = true;
            r.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(500);
        await fillShipping(page, RURAL_LINE);
        const m = await page.evaluate(READ);
        check('an RD address does NOT override a hand-picked Urban', m.checked[0] === 'urban',
            `checked=[${m.checked.join(', ')}]. Only a real user interaction fires \`change\` on a `
            + 'radio, so the flag this relies on can only be set by a person — and after that the '
            + 'address stops voting.');
    }

    // ── F  POSITIVE CONTROL ──────────────────────────────────────────────────
    head('F  positive control — the gate is still there');
    {
        // Clear the group the way the OLD init() did, then ask the page to advance.
        // If it sails through, the dead end was not fixed, it was deleted.
        await page.goto(`${BASE}${CHECKOUT}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#checkout-form', { timeout: 30000 });
        await page.waitForTimeout(2500);
        await fillShipping(page, URBAN_ADDRESS.address1);
        const before = page.url();
        const result = await page.evaluate(() => {
            document.querySelectorAll('input[name="delivery_type"]').forEach((r) => { r.checked = false; });
            const btn = document.getElementById('continue-to-payment-btn');
            if (!btn) return 'no continue button';
            btn.click();
            return 'clicked';
        });
        await page.waitForTimeout(2500);
        const after = page.url();
        const attention = await page.evaluate(() =>
            !!document.querySelector('#delivery-type-section.needs-attention'));
        check('with NO area selected, the page still refuses to advance',
            result === 'clicked' && after === before,
            `clicked=${result} url before=${before} after=${after}. The fix is a sensible DEFAULT, `
            + 'not the removal of a rule — if the group is somehow emptied, the guard must still hold.');
        check('and it says which section needs attention', attention,
            'the .needs-attention state on #delivery-type-section is what points the shopper at '
            + 'the control; a silent refusal is the original bug wearing a different hat');
    }

    await ctx.close();
} catch (e) {
    if (!fatal) fatal = e.message;
} finally {
    await browser.close();
}

if (fatal) {
    console.error(`\n\x1b[31mcould not run: ${fatal}\x1b[0m`);
    process.exit(2);
}
console.log(`\n\x1b[1m${pass} passed, ${failures.length} failed, ${notes.length} noted\x1b[0m`);
if (notes.length) { console.log('\nNoted:'); notes.forEach((n) => console.log(`  ~ ${n}`)); }
if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
}
process.exit(0);
