#!/usr/bin/env node
/**
 * probe-handoff-26oct.mjs
 * =======================
 * Measures, on the LIVE site, every storefront item of the backend's handoff
 * of 26 Oct 2026 (backend-docs/inbox/fe-handoff-26oct2026.md, ERR-376) that a
 * request can see. Each line says PASS / FAIL / SKIP; SKIP (no admin
 * credentials) is NOT a pass. Any FAIL or SKIP makes the exit code non-zero.
 *
 * MODE: READ-ONLY. GET requests, plus:
 *   - the Supabase password grant that mints the admin token, and
 *   - ONE POST /api/admin/invoices/quote — a price QUOTE, which saves nothing
 *     (no invoice, no draft, no price), to see item 49's two new line fields.
 * It never places an order, adds to a cart or captures a payment. Items 51 and
 * 53 (a refused press then a paid order; a test-mode Afterpay payment) need a
 * real payment and are the owner's check, as the handoff's "How we will check"
 * says — this probe only confirms the shipped code is the code being served.
 *
 *   npm run probe:handoff-26oct
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const WWW = process.env.WWW_BASE || 'https://www.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const PACE = Number(process.env.PROBE_PACE_MS || 400);

console.log(`probe:handoff-26oct — MODE: READ-ONLY (GET + one non-saving invoice QUOTE) against ${WWW} and ${API}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, skip: 0 };
const pass = (m) => { results.pass++; console.log(`  PASS  ${m}`); };
const fail = (m) => { results.fail++; console.log(`  FAIL  ${m}`); };
const skip = (m) => { results.skip++; console.log(`  SKIP  ${m}`); };
const check = (ok, m) => (ok ? pass(m) : fail(m));

async function get(url, headers = {}) {
    await sleep(PACE);
    const res = await fetch(url, { headers, redirect: 'manual' });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') || '' };
}
function readEnv() {
    const out = {};
    try {
        for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
    } catch (_) { /* no .env */ }
    return out;
}
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim();

const PHONE = "We may phone existing customers about their orders, reorders, quotes and account options. If you would rather we didn't, tell us and we won't call again.";
const GCR = 'Google Customer Reviews (an optional survey Google may offer after an order) — only if you opt in: your email address, order number, delivery country, estimated delivery date and the barcodes of the products you ordered, so Google can send you the survey.';

// ── 50: privacy, www bytes = prerender bytes ────────────────────────────────
console.log('\n50 — privacy');
const pre = await get(`${API}/api/prerender/static/privacy`);
const preItems = [...pre.text.matchAll(/<(p|li)>([\s\S]*?)<\/\1>/g)].map((m) => decode(m[2]));
check(preItems.includes(PHONE), 'prerender carries the phone paragraph (reference copy)');
check(preItems.includes(GCR), 'prerender carries the Google Customer Reviews item (reference copy)');
const www = await get(`${WWW}/privacy`);
check(www.status === 200 && www.text.includes(`<p>${PHONE}</p>`), 'www /privacy: phone paragraph, byte for byte');
const legalSrc = (/legal-config\.js\?v=([0-9a-f]+)/.exec(www.text) || [])[0];
const legal = legalSrc ? await get(`${WWW}/js/${legalSrc}`) : { text: '' };
const row = /name: 'Google Customer Reviews', purpose: '([^']+)'/.exec(legal.text);
const rowText = row ? `Google Customer Reviews ${row[1].replace(/\\u2014/g, '—')}` : '';
check(rowText === GCR, 'www /privacy processor row = the prerender item, byte for byte');

// ── 52 / 53 / 51: the served checkout ───────────────────────────────────────
console.log('\n51 / 52 / 53 — the served checkout');
const co = await get(`${WWW}/checkout`);
check((co.text.match(/inputmode="numeric" id="(billing-)?postcode"/g) || []).length === 2, 'both postcode inputs open the number pad');
const paySrc = (/payment-page\.js\?v=([0-9a-f]+)/.exec(co.text) || [])[0];
const pay = paySrc ? (await get(`${WWW}/js/${paySrc}`)).text : '';
check(pay.length > 0 && !/API\.addToCart\(/.test(pay), '51: served payment-page.js never adds to the cart before an order');
check(/_createOrderSpendingToken\(/.test(pay), '51: served payment-page.js spends the Turnstile token on every order answer');
check(/billingDetails: \{ name: 'never', email: 'never', phone: 'never' \}/.test(pay), '53: Payment Element never re-asks name/email/phone');
check(/orderTotalCheck\(result\.order\)/.test(pay), '52: Pay compares the order total with the screen before confirming');

// ── 54 / 55 / 58 ────────────────────────────────────────────────────────────
console.log('\n54 / 55 / 58');
const cart = await get(`${WWW}/cart`);
check(/aria-label="Afterpay"/.test(cart.text), '54: /cart lists Afterpay');
const footSrc = (/footer\.js\?v=([0-9a-f]+)/.exec(cart.text) || [])[0];
check(footSrc && /aria-label="Afterpay"/.test((await get(`${WWW}/js/${footSrc}`)).text), '54: footer "We accept" lists Afterpay');
const cssSrc = (/components\.css\?v=([0-9a-f]+)/.exec(cart.text) || [])[0];
check(cssSrc && /html\.cart-drawer-open #google-reviews-badge\s*\{\s*display:\s*none !important/.test((await get(`${WWW}/css/${cssSrc}`)).text), '55: badge hidden while the drawer is open');
check(/<span id="cart-item-count">0 items<\/span>\)/.test(cart.text), '58: subtotal label written whole');
const slash = await get(`${WWW}/cart/`);
check(slash.status === 308 || slash.status === 301, `/cart/ redirects (got ${slash.status} → ${slash.location})`);
check(/\/cart$/.test(slash.location), '/cart/ → /cart');

// ── 57 ──────────────────────────────────────────────────────────────────────
console.log('\n57 — PayPal redirect return / cancel');
const ret = await get(`${WWW}/checkout/paypal-return?token=PROBE-TOKEN&PayerID=X`);
check(ret.status >= 300 && ret.status < 400 && /\/checkout\?/.test(ret.location) && /paypal=return/.test(ret.location) && /token=PROBE-TOKEN/.test(ret.location),
    `return → ${ret.status} ${ret.location} (must keep PayPal's token)`);
const can = await get(`${WWW}/checkout/paypal-cancel?token=PROBE-TOKEN`);
check(can.status >= 300 && can.status < 400 && /paypal=cancelled/.test(can.location), `cancel → ${can.status} ${can.location}`);

// ── 49: the quote carries the two line fields ───────────────────────────────
console.log('\n49 — invoice quote line fields (one non-saving QUOTE)');
const env = readEnv();
const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
const anon = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
    || (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8')) || [])[1];
if (!email || !password || !anon) {
    skip('no ADMIN_EMAIL / ADMIN_PASSWORD — item 49 not measured');
} else {
    const tok = await (await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon }, body: JSON.stringify({ email, password }),
    })).json();
    const sku = 'GLC233BK';
    await sleep(PACE);
    const q = await fetch(`${API}/api/admin/invoices/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
        body: JSON.stringify({ line_items: [
            { product_code: sku, description: '', quantity: 1, unit_cost_excl_gst: 0.5, cost_source: 'auto' },
            { product_code: sku, description: '', quantity: 1, cost_source: 'manual' },
        ] }),
    });
    const body = await q.json().catch(() => null);
    const lines = (body && (body.data || body).lines) || [];
    check(q.ok && lines.length === 2, `quote answered ${q.status} with ${lines.length} lines`);
    check(lines[0] && lines[0].below_web_price === true, `a $0.50 line is below web price (got ${lines[0] && lines[0].below_web_price})`);
    check(lines[0] && typeof lines[0].gross_margin_pct === 'number', `gross_margin_pct is a number (got ${lines[0] && lines[0].gross_margin_pct})`);
    check(lines[1] && lines[1].gross_margin_pct === null, `manual cost + none typed ⇒ margin null (got ${lines[1] && lines[1].gross_margin_pct})`);
}

console.log(`\n${results.pass} pass · ${results.fail} fail · ${results.skip} skip`);
process.exit(results.fail || results.skip ? 1 : 0);
