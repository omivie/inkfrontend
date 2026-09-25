#!/usr/bin/env node
/**
 * audit-css-coverage.mjs — `npm run audit:css-coverage [-- --list] [-- --no-browser]`
 * =====================================================================================
 * How much of a stylesheet is dead, and how much of it each page actually uses.
 * Built to decide the `pages.css` question from the 2026-09-21 latency handoff
 * (420KB raw / 77KB gz, render-blocking on 37 pages): delete dead rules, or
 * split per page, or neither.
 *
 * MODE: READ-ONLY. Nothing in the repo is written; the full report goes to
 * ~/.feink-audits/ (outside the repo — audit-output/ may hold only report.json). The browser leg aborts every analytics / beacon /
 * search request before it leaves (ERR-254/271) and never logs in.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT INSTRUMENTS — never conflate them:
 *
 *   STATIC DEAD — a rule none of whose selectors CAN ever match, because a
 *     class or id it requires appears in no HTML or JS file in the web root
 *     (nor as a dynamic prefix like `'btn--' + x` / `` `btn--${x}` ``). This is
 *     the ONLY evidence that licenses deleting a rule. It is conservative by
 *     construction: a token that appears anywhere, even in a comment, counts
 *     as referenced; tokens inside :not()/:is()/:where()/:has() are ignored
 *     (an absent class inside :not() makes a selector MORE likely to match);
 *     a selector with an attribute selector on `class`/`id` is always kept.
 *
 *   COVERAGE — which rules matched during a real first-visit load of each page,
 *     at phone (390x664, the real iPhone viewport — ERR-238) and desktop widths.
 *     It CANNOT license a deletion: a rule for an open modal, an error state, a
 *     logged-in page or a breakpoint we did not load reads "unused" here and is
 *     live. It answers the SPLIT question — how much of what a page downloads
 *     it uses on arrival.
 *
 * Content stored in the database (product description_html, page copy) is not
 * in the repo; the browser leg harvests every class present in each rendered
 * DOM into the corpus so the pages it visits contribute what their content uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeQuery, printSearchAnalyticsNotice } from './lib/probe-search-notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'inkcartridges');
const SITE = process.env.SITE || 'https://www.inkcartridges.co.nz';
const SHEET = process.env.SHEET || 'pages.css';
const LIST = process.argv.includes('--list');
const BROWSER = !process.argv.includes('--no-browser');

// Every public page that loads the sheet, by its clean URL. Account pages
// redirect to login when signed out; that is recorded, not hidden.
const PAGES = ['/', '/shop', '/ink-cartridges', '/toner-cartridges', '/ribbons', `/search?q=${encodeURIComponent(probeQuery('css'))}`,
    '/cart', '/checkout', '/payment', '/order-confirmation', '/about', '/contact', '/faq', '/terms',
    '/privacy', '/returns', '/shipping', '/business', '/quote', '/track-order', '/genuine-vs-compatible',
    '/account/login', '/account', '/zzprobe-not-a-page', '__PDP__'];
const VIEWPORTS = { phone: { width: 390, height: 664 }, desktop: { width: 1280, height: 800 } };

console.log(`\naudit:css-coverage — ${SHEET}`);
console.log(`MODE: READ-ONLY. Report → ~/.feink-audits/. ${BROWSER ? `Browser: ${SITE}, analytics/search ABORTED, signed out.` : 'Static only (--no-browser).'}\n`);
// The browser leg loads the site's own /search results page, whose script
// issues GET /api/search/* (a search_analytics write, ERR-254/271). Those calls
// are ABORTED in the browser below, and the query is a probeQuery() sentinel
// the backend excludes anyway — the notice is printed regardless, because the
// mechanism is what a reader of this probe needs to know about.
if (BROWSER) printSearchAnalyticsNotice();

// ── CSS rule listing with source offsets ─────────────────────────────────────
function parseRules(text) {
    const rules = [];
    const stack = []; // { kind: 'at'|'rule', prelude, start }
    let i = 0, preludeStart = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
        if (ch === '"' || ch === "'") { let j = i + 1; while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1; i = j + 1; continue; }
        if (ch === '{') {
            const prelude = text.slice(preludeStart, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
            // `start` = the selector's first character, which is what Chrome's
            // rule-usage offsets point at. Comments before it are NOT part of it.
            let start = preludeStart;
            for (;;) {
                while (/\s/.test(text[start])) start++;
                if (text[start] === '/' && text[start + 1] === '*') { start = text.indexOf('*/', start + 2) + 2; continue; }
                break;
            }
            stack.push({ prelude, start, at: prelude.startsWith('@') });
            i++; preludeStart = i; continue;
        }
        if (ch === '}') {
            const open = stack.pop();
            if (open) {
                const parentAt = stack.filter((s) => s.at).map((s) => s.prelude);
                const inKeyframes = parentAt.some((p) => /^@(-\w+-)?keyframes/.test(p));
                if (!open.at && !inKeyframes) rules.push({ start: open.start, end: i + 1, selector: open.prelude, media: parentAt.join(' ') || null });
                if (open.at) rules.push({ start: open.start, end: i + 1, atRule: open.prelude, media: parentAt.join(' ') || null });
            }
            i++; preludeStart = i; continue;
        }
        if (ch === ';' && stack.length === 0) { preludeStart = i + 1; }
        i++;
    }
    return rules;
}

function splitSelectors(sel) {
    const out = []; let depth = 0, cur = '';
    for (const ch of sel) {
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function stripFunctional(sel) {
    let out = '', i = 0;
    while (i < sel.length) {
        const m = sel.slice(i).match(/^:(not|is|where|has|matches|-webkit-any|-moz-any)\(/);
        if (m) { let d = 1, j = i + m[0].length; while (j < sel.length && d) { if (sel[j] === '(') d++; if (sel[j] === ')') d--; j++; } i = j; continue; }
        out += sel[i++];
    }
    return out;
}

function requiredTokens(selector) {
    if (/\[\s*(class|id)\b/.test(selector)) return null; // attribute match on class/id — cannot judge, keep
    const s = stripFunctional(selector).replace(/\[[^\]]*\]/g, '');
    return [...s.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[2]);
}

// ── corpus: every HTML + JS file in the web root ─────────────────────────────
function walk(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.vercel', 'css'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc); else if (/\.(html|js|mjs)$/.test(e.name)) acc.push(p);
    }
    return acc;
}
let corpus = walk(WEB).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// Fragments of class names the JS BUILDS: the literal text touching an
// interpolation or a concatenation — `${block}__line--${key}` yields
// "__line--", 'product-card--' + v yields "product-card--". Any token that
// CONTAINS such a fragment might be produced at runtime, so it is kept.
// This replaced a prefix/suffix check that missed the double-dynamic
// `${block}__line--${key}` and would have deleted the live business and
// loyalty chart colours (caught by business-centre §5, 2026-09-25).
const DYN_FRAGMENTS = new Set();
for (const re of [/\}([A-Za-z0-9_-]+)/g, /([A-Za-z0-9_-]+)\$\{/g, /['"`]([A-Za-z0-9_-]+)['"`]\s*\+/g, /\+\s*['"`]([A-Za-z0-9_-]+)['"`]/g]) {
    for (const m of corpus.matchAll(re)) if (m[1].length >= 3 && /[-_]/.test(m[1])) DYN_FRAGMENTS.add(m[1]);
}

function referenced(token, extra) {
    if (corpus.includes(token) || extra.has(token)) return true;
    for (const f of DYN_FRAGMENTS) if (token.includes(f)) return true;
    return false;
}

// ── browser leg: coverage per page × viewport, plus DOM class harvest ────────
const sheetText = { value: null };
const usage = {}; // pageKey -> Set(ruleStart)
const domClasses = new Set();
const pageNotes = {};
if (BROWSER) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const WRITES = /\/api\/analytics\/|\/api\/search\/|\/api\/cart-analytics|google-analytics\.com|googletagmanager\.com\/g\/collect|doubleclick\.net|googleadservices\.com|bat\.bing\.com/;
    let pdp = null;
    try {
        const r = await fetch('https://api.inkcartridges.co.nz/api/products?page=1&limit=1', { headers: { Origin: SITE } });
        pdp = `/products/x/${encodeURIComponent((await r.json()).data.products[0].sku)}`;
    } catch { pdp = null; }
    let aborted = 0;
    try {
        for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
            for (const raw of PAGES) {
                const route = raw === '__PDP__' ? pdp : raw;
                if (!route) { pageNotes[raw] = 'no PDP sku resolved'; continue; }
                const ctx = await browser.newContext({ viewport, isMobile: vpName === 'phone', hasTouch: vpName === 'phone' });
                await ctx.route(WRITES, (r) => { aborted++; return r.abort(); });
                const page = await ctx.newPage();
                const cdp = await ctx.newCDPSession(page);
                await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
                const ids = new Map();
                cdp.on('CSS.styleSheetAdded', (e) => { if (e.header.sourceURL.includes(`/css/${SHEET}`)) ids.set(e.header.styleSheetId, e.header.sourceURL); });
                await cdp.send('CSS.startRuleUsageTracking');
                try {
                    await page.goto(SITE + route, { waitUntil: 'networkidle', timeout: 60000 });
                    await page.waitForTimeout(1500);
                    // Walk the page once so lazy sections and scroll-revealed content render.
                    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
                    await page.waitForTimeout(500);
                } catch (e) { pageNotes[`${route} @${vpName}`] = `load: ${e.message.split('\n')[0]}`; }
                const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
                const finalUrl = new URL(page.url()).pathname;
                if (finalUrl !== route.split('?')[0]) pageNotes[`${route} @${vpName}`] = `landed on ${finalUrl}`;
                for (const c of await page.evaluate(() => [...document.querySelectorAll('[class]')].flatMap((e) => [...e.classList]))) domClasses.add(c);
                for (const id of await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id))) domClasses.add(id);
                const key = `${route} @${vpName}`;
                usage[key] = new Set();
                for (const [sid] of ids) {
                    if (sheetText.value === null) sheetText.value = (await cdp.send('CSS.getStyleSheetText', { styleSheetId: sid })).text;
                    for (const u of ruleUsage) if (u.styleSheetId === sid && u.used) usage[key].add(u.startOffset);
                }
                if (!ids.size) pageNotes[key] = (pageNotes[key] ? pageNotes[key] + '; ' : '') + `${SHEET} not loaded`;
                await ctx.close();
                process.stdout.write('.');
            }
        }
    } finally { await browser.close(); }
    console.log(`\n${aborted} analytics/search request(s) aborted before leaving the browser.\n`);
}

// Coverage offsets index the text the BROWSER parsed (production). Static
// analysis must run on the same text or offsets and selectors disagree.
// SHEET_FILE audits another copy of the sheet (e.g. `git show HEAD:…`) without
// touching the working tree, which another session may be editing.
const SHEET_FILE = process.env.SHEET_FILE || path.join(WEB, 'css', SHEET);
const text = sheetText.value ?? fs.readFileSync(SHEET_FILE, 'utf8');
const source = sheetText.value ? `production ${SITE}/css/${SHEET}` : path.relative(ROOT, SHEET_FILE) || SHEET_FILE;
const rules = parseRules(text).filter((r) => r.selector);
const bytes = (rs) => rs.reduce((a, r) => a + (r.end - r.start), 0);
const total = text.length;

const dead = [];
for (const r of rules) {
    const sels = splitSelectors(r.selector);
    const deadSels = sels.filter((s) => {
        const toks = requiredTokens(s);
        return toks && toks.some((t) => !referenced(t, domClasses));
    });
    if (deadSels.length === sels.length) dead.push({ ...r, missing: [...new Set(sels.flatMap((s) => (requiredTokens(s) || []).filter((t) => !referenced(t, domClasses))))] });
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
console.log(`sheet: ${source}`);
console.log(`  ${rules.length} style rules, ${kb(total)} total, ${kb(bytes(rules))} inside style rules`);
console.log(`  STATIC DEAD (can never match): ${dead.length} rules, ${kb(bytes(dead))} (${(bytes(dead) / total * 100).toFixed(1)}% of file)`);

const report = { sheet: SHEET, source, fetched: new Date().toISOString(), totalBytes: total, rules: rules.length,
    staticDead: dead.map((d) => ({ selector: d.selector, media: d.media, start: d.start, end: d.end, bytes: d.end - d.start, missing: d.missing, text: text.slice(d.start, d.end) })),
    pages: {}, notes: pageNotes };

if (Object.keys(usage).length) {
    const byStart = new Map(rules.map((r) => [r.start, r]));
    const everUsed = new Set(Object.values(usage).flatMap((s) => [...s]));
    const usedRules = rules.filter((r) => everUsed.has(r.start));
    console.log(`  COVERAGE, any page/viewport on first load: ${usedRules.length} rules, ${kb(bytes(usedRules))} used (${(bytes(usedRules) / total * 100).toFixed(1)}%)`);
    console.log('\n  per page (bytes of this sheet that matched on arrival):');
    const counts = new Map();
    for (const [key, set] of Object.entries(usage)) {
        const rs = [...set].map((s) => byStart.get(s)).filter(Boolean);
        report.pages[key] = { usedBytes: bytes(rs), usedRules: rs.length };
        for (const r of rs) counts.set(r.start, (counts.get(r.start) || 0) + 1);
        console.log(`    ${key.padEnd(40)} ${kb(bytes(rs)).padStart(8)}  ${(bytes(rs) / total * 100).toFixed(1)}%${pageNotes[key] ? `   (${pageNotes[key]})` : ''}`);
    }
    // Split question: how much of the used CSS is shared vs page-specific.
    const routes = new Map(); for (const key of Object.keys(usage)) routes.set(key.split(' @')[0], true);
    const perRoute = new Map();
    for (const [key, set] of Object.entries(usage)) { const r = key.split(' @')[0]; if (!perRoute.has(r)) perRoute.set(r, new Set()); for (const s of set) perRoute.get(r).add(s); }
    const routeCount = new Map();
    for (const set of perRoute.values()) for (const s of set) routeCount.set(s, (routeCount.get(s) || 0) + 1);
    const shared = rules.filter((r) => (routeCount.get(r.start) || 0) >= 3);
    const specific = rules.filter((r) => [1, 2].includes(routeCount.get(r.start) || 0));
    console.log(`\n  used by ≥3 routes: ${kb(bytes(shared))} · used by 1-2 routes: ${kb(bytes(specific))} · used on no visited route: ${kb(bytes(rules) - bytes(shared) - bytes(specific))}`);
    report.split = { sharedBytes: bytes(shared), specificBytes: bytes(specific) };
}

if (LIST) for (const d of dead) console.log(`  dead ${String(d.end - d.start).padStart(5)}B  ${d.selector.replace(/\s+/g, ' ').slice(0, 110)}${d.media ? `   [${d.media}]` : ''}   missing: ${d.missing.join(', ')}`);

const outDir = path.join(os.homedir(), '.feink-audits');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `css-coverage-${SHEET.replace(/\W/g, '_')}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nreport: ${out}`);
