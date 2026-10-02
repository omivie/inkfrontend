#!/usr/bin/env node
/**
 * probe:backend-audit — the backend audit FE handoff (Oct 2026, ERR-300).
 *
 * MODE: READ-ONLY. Every request is a GET except ONE POST to
 * /api/checkout/guest-prefill, a lookup that writes nothing, sent with a
 * reserved probe address (zzprobe@example.com — `zz%` is on the analytics
 * exclusion list, ERR-254). Nothing here records a fixture.
 *
 * What it measures (each line prints PASS / FAIL with the value it saw):
 *   §1.1 guest-prefill answers with NO personal-data keys
 *   §1.3 /api/products/:sku carries faqJsonLd.mainEntity with the trust-signal
 *        delivery answer (the PDP accordion renders from it)
 *   §1.2 www /genuine-vs-compatible is identical for a bot and a browser and
 *        never says "guaranteed to work"
 *   §2.4 backend prerender titles/descriptions make no unqualified same-day
 *        promise
 *   §3   the API share image + logo answer 200 with an image type
 *   NEGATIVE CONTROL: the two www image paths the FE used to point at still
 *        404 — if they ever start answering 200, this probe's premise is stale.
 *   --site  also check that LIVE www HTML points at the API image URLs (only
 *           true after ERR-300 deploys).
 *
 * Usage: npm run probe:backend-audit [-- --site]
 */

const API = 'https://api.inkcartridges.co.nz';
const WWW = 'https://www.inkcartridges.co.nz';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SITE = process.argv.includes('--site');
const SKU = 'GLC3317BK';

console.log('probe:backend-audit — MODE: READ-ONLY (GETs + one non-writing guest-prefill lookup)');
console.log(`  api=${API}  www=${WWW}  site-check=${SITE ? 'ON' : 'off (pass --site after deploy)'}\n`);

let failures = 0;
let skips = 0;
const result = (ok, label, seen) => {
    if (ok === null) { skips++; console.log(`  SKIP  ${label} — ${seen}`); return; }
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${seen !== undefined ? ` — saw: ${seen}` : ''}`);
};

async function get(url, opts = {}) {
    try {
        const res = await fetch(url, { redirect: 'manual', ...opts, signal: AbortSignal.timeout(25000) });
        return res;
    } catch (e) {
        return { status: 0, error: e.message, headers: new Headers(), text: async () => '', json: async () => null };
    }
}

// §1.1
{
    const res = await get(`${API}/api/checkout/guest-prefill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: WWW },
        body: JSON.stringify({ email: 'zzprobe@example.com' }),
    });
    if (res.status === 429) {
        result(null, '§1.1 guest-prefill carries no PII keys', 'rate limited (429) — not a measurement');
    } else {
        const body = await res.json().catch(() => null);
        const data = body && body.data;
        const keys = data && typeof data === 'object' ? Object.keys(data) : [];
        const pii = keys.filter(k => /name|phone|address|city|region|postal|street/i.test(k));
        result(res.status === 200 && 'has_previous_order' in (data || {}) && pii.length === 0,
            '§1.1 guest-prefill carries no PII keys', `${res.status} keys=[${keys.join(',')}]`);
    }
}

// §1.3
{
    const res = await get(`${API}/api/products/${SKU}`, { headers: { Origin: WWW } });
    const body = await res.json().catch(() => null);
    const faq = body && body.data && body.data.faqJsonLd;
    const items = faq && Array.isArray(faq.mainEntity) ? faq.mainEntity : null;
    result(!!items && items.length > 0, `§1.3 ${SKU} faqJsonLd.mainEntity present`, items ? `${items.length} questions` : `${res.status} faqJsonLd=${typeof faq}`);
    const delivery = items && items.find(q => /delivery take/i.test(q.name));
    const text = delivery && delivery.acceptedAnswer && delivery.acceptedAnswer.text;
    result(!!text && /Auckland metro/.test(text) && !/Auckland metro: 1-2 business days/.test(text),
        '§1.3 delivery answer is the trust-signal one', text ? JSON.stringify(text.slice(0, 90)) : 'absent');
    const legacy = body && body.data && body.data.seo && body.data.seo.jsonLd;
    console.log(`        (info) legacy seo.jsonLd.faq_schema: ${legacy && legacy.faq_schema ? 'PRESENT' : 'absent'} — the FE reads faqJsonLd first either way`);
}

// §1.2
{
    const [bot, human] = await Promise.all([
        get(`${WWW}/genuine-vs-compatible`, { headers: { 'User-Agent': BOT_UA } }),
        get(`${WWW}/genuine-vs-compatible`),
    ]);
    const [b, h] = await Promise.all([bot.text(), human.text()]);
    result(bot.status === 200 && human.status === 200 && b === h, '§1.2 bot and browser get identical /genuine-vs-compatible', `${bot.status}/${human.status}, ${b.length}/${h.length} bytes`);
    result(!/guaranteed to work/i.test(b + h), '§1.2 no "guaranteed to work" on the page', /guaranteed to work/i.test(b + h) ? 'FOUND' : 'absent');
}

// §2.4
{
    const paths = ['home', 'shop', 'category/ink', 'category/toner', 'brand/hp'];
    for (const p of paths) {
        const res = await get(`${API}/api/prerender/${p}`, { headers: { 'User-Agent': BOT_UA, Accept: 'text/html' } });
        if (res.status !== 200) { result(null, `§2.4 prerender ${p}`, `HTTP ${res.status} — not a measurement`); continue; }
        const html = await res.text();
        const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const desc = (html.match(/name="description" content="([^"]*)"/) || [])[1] || '';
        const bad = [title, desc].filter(t => /same[- ]day/i.test(t) && !/Auckland metro/i.test(t));
        result(bad.length === 0, `§2.4 prerender ${p} title/description qualified`, bad.length ? bad.join(' | ') : title.replace(/&amp;/g, '&'));
    }
}

// §3 + negative control
{
    const want = [
        [`${API}/og-default.png`, 200],
        [`${API}/api/images/optimize?url=site/IC_2.png&format=png&w=512`, 200],
        [`${WWW}/assets/images/logo.png`, 404],
        [`${WWW}/logo.png`, 404],
    ];
    for (const [url, expect] of want) {
        const res = await get(url);
        const type = res.headers.get('content-type') || '';
        const ok = res.status === expect && (expect !== 200 || type.startsWith('image/'));
        result(ok, `§3 ${expect === 404 ? 'NEGATIVE CONTROL ' : ''}${url} → ${expect}`, `${res.status} ${type}`);
    }
}

// --site
if (SITE) {
    const res = await get(`${WWW}/`);
    const html = await res.text();
    const og = (html.match(/property="og:image" content="([^"]*)"/) || [])[1];
    result(og === `${API}/og-default.png`, 'site: www og:image is the API share card', og);
    result(html.includes(`${API}/api/images/optimize?url=site/IC_2.png`), 'site: www Organization logo is the API logo', html.includes('/logo.png"') ? 'old /logo.png' : 'missing');
}

console.log(`\n${failures ? `FAIL — ${failures} check(s) failed` : 'PASS'}${skips ? ` · ${skips} SKIPPED (a skip is not a pass)` : ''}`);
process.exit(failures ? 1 : 0);
