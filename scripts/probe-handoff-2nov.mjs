#!/usr/bin/env node
/**
 * probe-handoff-2nov.mjs
 * ======================
 * Measures, on the LIVE site, the storefront items of the backend's handoff of
 * 2 Nov 2026 (fe-handoff-2nov2026.md, ERR-377) that a request can see, against
 * the backend's own bot pages (handoff §6). Each line says PASS / FAIL; any FAIL
 * makes the exit code non-zero.
 *
 * MODE: READ-ONLY. GET requests only. No cart, no order, no login.
 *
 * Before the deploy the www checks FAIL (www still serves the old copy) and the
 * bot-page reference checks PASS — that split is the probe's negative control.
 *
 *   npm run probe:handoff-2nov
 */
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const WWW = process.env.WWW_BASE || 'https://www.inkcartridges.co.nz';
const PACE = Number(process.env.PROBE_PACE_MS || 400);

console.log(`probe:handoff-2nov — MODE: READ-ONLY (GET only) against ${WWW} and ${API}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0 };
const pass = (m) => { results.pass++; console.log(`  PASS  ${m}`); };
const fail = (m) => { results.fail++; console.log(`  FAIL  ${m}`); };
const check = (ok, m) => (ok ? pass(m) : fail(m));

async function get(url) {
    await sleep(PACE);
    const res = await fetch(url, { headers: { 'User-Agent': 'probe-handoff-2nov (read-only)' } });
    return { status: res.status, text: await res.text() };
}
async function json(url) {
    const r = await get(url);
    try { return JSON.parse(r.text); } catch { return null; }
}
const text = (html) => html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')
    .replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ');
/** The served copy of one asset, found by its ?v= ref in a page. */
async function asset(pageHtml, name) {
    const m = new RegExp(`/(js|css)/${name.replace('.', '\\.')}\\?v=[0-9a-f]+`).exec(pageHtml);
    return m ? (await get(`${WWW}${m[0]}`)).text : '';
}

// ── 59 / 63 — the PDP script ───────────────────────────────────────────────
console.log('\n59 / 63 — product pages');
const c62 = await json(`${API}/api/products/C62XLBK`);
check(c62 && c62.data && c62.data.source === 'compatible' && /^I/.test(c62.data.manufacturer_part_number || ''),
    `reference: C62XLBK is compatible with a supplier code (${c62 && c62.data && c62.data.manufacturer_part_number})`);
const rib = await json(`${API}/api/products/C-OKI-IO182-RIB-BK`);
check(rib && rib.data && rib.data.source === 'compatible' && rib.data.manufacturer_part_number === 'IO182',
    'reference: the OKI ribbon is compatible and carries IO182');
const pdpPage = await get(`${WWW}/products/x/C62XLBK`);
const pdp = await asset(pdpPage.text, 'product-detail-page.js');
check(/info\.source !== 'compatible' \|\| info\.category === 'ribbon'/.test(pdp), '59: served PDP hides the MPN on compatibles, keeps it on ribbons');
const sum = await json(`${API}/api/products/${c62 && c62.data && c62.data.id}/reviews/summary`);
check(!sum || !sum.data || !('average' in sum.data), 'reference: the summary endpoint sends no `average` field (why it was NaN)');
check(/_reviewSummaryStats\(summary\)/.test(pdp) && !/summary\.average\b/.test(pdp), '63: served PDP reads average_rating / review_count');

// ── 60 — /about, /genuine-vs-compatible, /contact, /returns ───────────────
console.log('\n60 — static pages');
const ABOUT_NEW = [
    'We started InkCartridges.co.nz to be a New Zealand business that sells the cartridge you actually need.',
    'Warranty and guarantee',
    'Genuine cartridges carry the original manufacturer warranty. Compatible cartridges are covered by our 30-day satisfaction guarantee.',
    'No surcharges',
    'Each one is tested before dispatch and covered by our 30-day satisfaction guarantee.',
    'Every order ships by courier.',
    'Phone: 027 474 0115 · Email: support@inkcartridges.co.nz',
    'Call 027 474 0115 or email support@inkcartridges.co.nz.',
];
const OLD = /Most New Zealand printer-supply websites|usually within one to two working days|Buy once, prints right|Fair pricing, no surcharges|quality-checked on receipt|dispatched from our Kelston|within one (?:business|working) day|in business hours|walk-ins|9:00am|Mon(?:day)?\s*[–-]\s*Fri(?:day)?,?\s*\d/i;
const about = text((await get(`${WWW}/about`)).text);
for (const line of ABOUT_NEW) check(about.includes(line), `www /about: "${line.slice(0, 60)}…"`);
check(!OLD.test(about), `www /about: no replaced line${OLD.test(about) ? ` (found "${about.match(OLD)[0]}")` : ''}`);
const botAbout = text((await get(`${API}/api/prerender/static/about`)).text);
check(botAbout.includes('tested before dispatch') && !/Kelston, Auckland office|dispatched from/i.test(botAbout), 'reference: bot /about says "tested before dispatch", no Kelston dispatch');
const gvc = text((await get(`${WWW}/genuine-vs-compatible`)).text);
check(gvc.includes('Covered by our 30-day satisfaction guarantee.') && !gvc.includes('Lower cost, and covered'), 'www /genuine-vs-compatible: summary line');
for (const p of ['contact', 'returns', 'faq', 'shipping', 'terms', 'quote']) {
    const t = text((await get(`${WWW}/${p}`)).text);
    check(!OLD.test(t), `www /${p}: no opening hours / reply-time promise${OLD.test(t) ? ` (found "${t.match(OLD)[0]}")` : ''}`);
}
const home = (await get(`${WWW}/`)).text;
const footer = await asset(home, 'footer.js');
check(footer.length > 0 && !/openingHoursSpecification:\s*\{/.test(footer) && !/<dt>Hours<\/dt>/.test(footer), 'www footer.js: no openingHours JSON-LD, no Hours row');
check(!/openingHoursSpecification/.test(home), 'www home: no openingHours in the static JSON-LD');

// ── 61 — printer page titles ──────────────────────────────────────────────
console.log('\n61 — printer pages');
const botPrinter = await get(`${API}/api/prerender/printer/brother/brother-hl-l2375dw`);
check(!/Fast NZ Delivery/.test(botPrinter.text) && !/cost less than genuine|How much can I save/i.test(botPrinter.text), 'reference: bot printer page dropped "Fast NZ Delivery" / "cost less" / "How much can I save"');
const shop = await get(`${WWW}/shop?brand=brother&printer_slug=brother-hl-l2375dw`);
const seo = await asset(shop.text, 'seo-meta.js');
check(seo.length > 0 && !/— Fast NZ Delivery/.test(seo.replace(/\/\/.*$/gm, '')), 'www seo-meta.js: no "— Fast NZ Delivery" fallback title');
const shopJs = await asset(shop.text, 'shop-page.js');
check(!/Compatible Ink for \$\{/.test(shopJs) && /this\.state\.printerName \|\|/.test(shopJs), '61.3: printer title reads display_name');

// ── 46 — the promise line ─────────────────────────────────────────────────
console.log('\n46 — compatibility promise under each Add');
check(c62 && c62.data && c62.data.trust_signals && c62.data.trust_signals.compatibility_promise
    && /^Not sure it fits\?/.test(c62.data.trust_signals.compatibility_promise.label), 'reference: the product payload carries compatibility_promise.label');
check(/product-card__promise" data-promise hidden/.test(shopJs) && /_compatPromiseLabel/.test(shopJs), 'www shop-page.js: the slot + one reader');

// ── 62 — /ribbons ─────────────────────────────────────────────────────────
console.log('\n62 — /ribbons');
const botRib = (await get(`${API}/api/prerender/category/ribbons`)).text;
const botTitle = (/<title>([^<]*)<\/title>/.exec(botRib) || [])[1] || '';
const botH1 = (/<h1[^>]*>([^<]*)<\/h1>/.exec(botRib) || [])[1] || '';
const wwwRib = (await get(`${WWW}/ribbons`)).text;
check(text(`<x>${botTitle}</x>`).trim() === text(`<x>${(/<title>([^<]*)<\/title>/.exec(wwwRib) || [])[1] || ''}</x>`).trim(), `www /ribbons title = bot ("${text(botTitle).trim()}")`);
check(new RegExp(`id="drilldown-title">${botH1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(wwwRib), `www /ribbons h1 = bot ("${botH1}")`);
check(/id="ribbons-intro"/.test(wwwRib) && /id="ribbons-faq-list"/.test(wwwRib), 'www /ribbons has the intro + FAQ slots (mirrored from the bot page at runtime)');
const firstQ = (/"name":\s*"([^"]+\?)"/.exec(botRib) || [])[1] || '';
check(firstQ && wwwRib.includes(firstQ), `www /ribbons static FAQ starts with the bot's first question ("${firstQ}")`);

// ── 38 / 50 ───────────────────────────────────────────────────────────────
console.log('\n38 / 50');
const oc = await get(`${WWW}/order-confirmation`);
const ocJs = await asset(oc.text, 'order-confirmation-page.js');
check(/when these are likely running low\./.test(ocJs) && !/before you run out\./.test(ocJs.replace(/Want a reminder before you run out\?/g, '')), '38: served Done lines say "likely running low"');
const priv = (await get(`${WWW}/privacy`)).text;
check(/policy-date">7 November 2026</.test(priv), '50: www /privacy "Last updated: 7 November 2026"');

console.log(`\n${results.pass} pass, ${results.fail} fail`);
process.exit(results.fail ? 1 : 0);
