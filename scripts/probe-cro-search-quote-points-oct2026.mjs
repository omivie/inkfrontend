#!/usr/bin/env node
/**
 * probe:cro-quote-points — the CRO handoff (search Add to Cart, PDF quote,
 * reward points; backend-docs/inbox/cro-search-quote-points-FE-handoff-oct2026.md).
 *
 * MODE: READ-ONLY by default — GETs only, and NO cart is created:
 *   §3   GET /api/products/:sku carries `reward_points` in the documented shape,
 *        and the backend's formula reproduces its own `points` (so the PDP's
 *        rung figures — js/product-detail-page.js rewardPointsFor — agree)
 *   §2   GET /api/cart/quote.pdf with no cart ⇒ 400 CART_EMPTY, and
 *        Content-Disposition is in access-control-expose-headers for www
 *   §1   the search pairs resolve alike ("604 xl" / "604-xl" / "604xl",
 *        "epson604"), and /smart rows carry id, in_stock, retail_price, source
 *   NEGATIVE CONTROL: an 81-character `company` is refused (400) — if the
 *        backend ever accepts it, the FE's 80-char clamp is guarding nothing.
 *
 * §1 IS NOT READ-ONLY FOR THE BACKEND: every /api/search/* GET writes a
 * `search_analytics` row (ERR-254). The notice below is printed every run.
 *
 * --record-opt-in=quote   ALSO downloads a real quote. This WRITES: it creates
 *   a fresh guest cart, POSTs one line (which logs an `add_to_cart` analytics
 *   row server-side), fetches the PDF, then DELETEs the line and verifies the
 *   cart is empty — and that it was NON-empty a moment before (ERR-269: an
 *   empty cart proves cleanup only if it held something). The rollback is the
 *   probe's own, checked by re-read, never assumed.
 *
 * Usage: npm run probe:cro-quote-points [-- --record-opt-in=quote]
 *   env: PROBE_API (default https://api.inkcartridges.co.nz), PROBE_SKU (C02CMY),
 *        PROBE_GUEST_SESSION (reuse an emptied guest session — mints nothing)
 */
import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const API = process.env.PROBE_API || 'https://api.inkcartridges.co.nz';
const WWW = 'https://www.inkcartridges.co.nz';
const SKU = process.env.PROBE_SKU || 'C02CMY';
const RECORD = process.argv.includes('--record-opt-in=quote');

console.log(`probe:cro-quote-points — MODE: ${RECORD
    ? 'RECORDING (--record-opt-in=quote): creates + empties ONE guest cart, logs one add_to_cart row'
    : 'READ-ONLY (no cart is created; search GETs still log analytics rows — see notice)'}`);
console.log(`  api=${API}  sku=${SKU}\n`);
console.log(SEARCH_ANALYTICS_NOTICE + '\n');

let failures = 0;
const result = (ok, label, seen) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${seen !== undefined ? ` — saw: ${seen}` : ''}`);
};
async function get(url, opts = {}) {
    try {
        return await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
    } catch (e) {
        return { ok: false, status: 0, error: e.message, headers: new Headers(), json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
    }
}
const json = async (res) => { try { return await res.json(); } catch { return null; } };

// §3 reward points
console.log('§3 reward points on the product');
const prodRes = await get(`${API}/api/products/${encodeURIComponent(SKU)}`);
const product = (await json(prodRes))?.data || null;
const rp = product?.reward_points;
result(rp && ['points', 'points_per_dollar', 'multiplier', 'redemption_rate'].every((k) => typeof rp[k] === 'number'),
    'reward_points has points / points_per_dollar / multiplier / redemption_rate', JSON.stringify(rp));
if (rp && product) {
    const formula = Math.floor(Math.round(product.retail_price * 100) / 100) * rp.points_per_dollar * rp.multiplier;
    result(formula === rp.points, `floor(${product.retail_price}) × ${rp.points_per_dollar} × ${rp.multiplier} = server points`, `${formula} vs ${rp.points}`);
}
const breaks = Array.isArray(product?.quantity_breaks) ? product.quantity_breaks : [];
result(breaks.length > 0 && breaks.every((b) => b.min_quantity > 0 && b.business_price > 0),
    'quantity_breaks[] has min_quantity + business_price per rung', breaks.map((b) => `${b.min_quantity}+@${b.business_price}`).join(' '));
result(typeof product?.delivery_estimate?.label === 'string' && !/1\s*[–-]\s*4/.test(product.delivery_estimate.label),
    'delivery_estimate.label present and not the retired 1–4 window', product?.delivery_estimate?.label);

// §2 quote, read-only half
console.log('\n§2 PDF quote');
const empty = await get(`${API}/api/cart/quote.pdf`, { headers: { Origin: WWW } });
const emptyBody = await json(empty);
result(empty.status === 400 && emptyBody?.error?.code === 'CART_EMPTY', 'no cart ⇒ 400 CART_EMPTY', `${empty.status} ${JSON.stringify(emptyBody?.error)}`);
const exposed = (empty.headers.get('access-control-expose-headers') || '').toLowerCase();
result(exposed.split(',').map((s) => s.trim()).includes('content-disposition'), 'Content-Disposition is CORS-exposed to www', exposed);
const tooLong = await get(`${API}/api/cart/quote.pdf?company=${'x'.repeat(81)}`, { headers: { Origin: WWW } });
result(tooLong.status === 400, 'NEGATIVE CONTROL: an 81-char company is refused (the FE clamp guards something)', tooLong.status);

// §1 search
console.log('\n§1 search (each line below wrote a search_analytics row)');
const search = async (ep, q, limit) => {
    const res = await get(`${API}/api/search/${ep}?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`);
    const d = (await json(res))?.data || {};
    const rows = d.products || d.suggestions || d.results || [];
    return { status: res.status, rows: Array.isArray(rows) ? rows : [] };
};
// /autocomplete rows carry no sku (measured 2026-10-05) — fall back to the name.
const skus = (r) => r.rows.map((p) => p.sku || p.name).filter(Boolean);
const glued = await search('smart', '604xl', 40);
const has604xl = (r) => skus(r).some((s) => /604\s*XL/i.test(s));
result(glued.rows.length > 0 && has604xl(glued), '/smart "604xl" returns a 604XL row', skus(glued).slice(0, 5).join(' '));
for (const [ep, q] of [['smart', '604 xl'], ['smart', '604-xl'], ['suggest', '604 xl'], ['autocomplete', '604-xl']]) {
    const r = await search(ep, q, ep === 'smart' ? 40 : null);
    result(r.status === 200 && has604xl(r), `/${ep} "${q}" ⇒ 604XL rows (matched as 604xl)`, `${r.status} ${skus(r).slice(0, 5).join(' ') || JSON.stringify(r.rows.slice(0, 2)).slice(0, 120)}`);
}
const epson = await search('smart', 'epson604', 40);
result(has604xl(epson), '/smart "epson604" includes the XL (was standard 604 only)', `${skus(epson).filter((x) => /604\s*XL/i.test(x)).length} XL of ${epson.rows.length} rows`);
const row = glued.rows[0] || {};
result(['id', 'in_stock', 'retail_price', 'source'].every((k) => k in row), '/smart rows carry id, in_stock, retail_price, source (the dropdown Add needs them)', Object.keys(row).filter((k) => ['id', 'in_stock', 'stock_quantity', 'retail_price', 'source', 'pack_type'].includes(k)).join(','));

// §2 quote, recording half
if (RECORD) {
    console.log('\n§2 PDF quote — RECORDING');
    if (!product?.id) {
        result(false, 'need the product id to add a line', 'none');
    } else {
        // Every header-less cart write MINTS a guest session, and the backend caps
        // mints per IP (measured 2026-10-05: "429 RATE_LIMITED: Too many guest
        // sessions" for over an hour). PROBE_GUEST_SESSION reuses an emptied one;
        // the id in use is always printed so the next run can reuse it.
        const reuse = process.env.PROBE_GUEST_SESSION || '';
        const add = await get(`${API}/api/cart/items`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: WWW, ...(reuse ? { 'X-Guest-Session': reuse } : {}) },
            body: JSON.stringify({ product_id: product.id, quantity: 1 }),
        });
        const guest = add.headers.get('x-guest-session') || (await json(add))?.data?.guest_session_id || reuse;
        console.log(`  guest session ${reuse ? 'REUSED' : 'MINTED'}: ${guest || '(none)'}  — reuse with PROBE_GUEST_SESSION=<id>`);
        result(add.ok && !!guest, 'fresh guest cart: one line added, session minted', `${add.status} session=${guest ? 'yes' : 'NO'}`);
        if (guest) {
            const h = { 'X-Guest-Session': guest, Origin: WWW };
            try {
                const before = (await json(await get(`${API}/api/cart`, { headers: h })))?.data;
                const lines = before?.items?.length ?? before?.cart?.items?.length ?? 0;
                result(lines > 0, 'cart is NON-empty before the quote (so the empty check below means something)', lines);
                const pdf = await get(`${API}/api/cart/quote.pdf?company=zzprobe&reference=PROBE`, { headers: h });
                const bytes = Buffer.from(await pdf.arrayBuffer());
                const disp = pdf.headers.get('content-disposition') || '';
                result(pdf.status === 200 && bytes.subarray(0, 4).toString() === '%PDF', 'quote.pdf ⇒ 200 and a real PDF', `${pdf.status} ${bytes.length} bytes, starts ${JSON.stringify(bytes.subarray(0, 5).toString())}`);
                result(/filename="[^"]+\.pdf"/.test(disp), 'Content-Disposition names a .pdf', disp);
                result(/application\/pdf/.test(pdf.headers.get('content-type') || ''), 'content-type application/pdf', pdf.headers.get('content-type'));
            } finally {
                const del = await get(`${API}/api/cart/items/${encodeURIComponent(product.id)}`, { method: 'DELETE', headers: h });
                const after = (await json(await get(`${API}/api/cart`, { headers: h })))?.data;
                const left = after?.items?.length ?? after?.cart?.items?.length ?? null;
                result(del.ok && left === 0, 'ROLLBACK: line deleted and the cart re-reads EMPTY', `delete ${del.status}, lines left ${left}`);
            }
        }
    }
} else {
    console.log('\n  (quote download skipped — pass --record-opt-in=quote to create, quote and empty one guest cart)');
}

console.log(`\n${failures ? `FAIL — ${failures} check(s)` : 'PASS — all checks'}${RECORD ? '' : ' (read-only run)'}`);
process.exit(failures ? 1 : 0);
