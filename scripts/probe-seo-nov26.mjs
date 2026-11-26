#!/usr/bin/env node
/**
 * probe-seo-nov26.mjs — ERR-400
 * =============================
 * Measures the backend's SEO handoff of 26 Nov 2026 (backend-docs/inbox/fe-handoff-seo-nov26-2026.md §5)
 * and the P1 Preview checklist (fe-p1-bundle.md §5) on a live site. Each line says PASS / FAIL;
 * any FAIL makes the exit code non-zero. Rows that need P1 Stage A (real 404s) FAIL until it ships, by design.
 *
 * MODE: READ-ONLY by default (HEAD/GET only, a handful of requests).
 *   --burst [N]      handoff row 1: N (default 40) Googlebot-UA GETs of cold printer URLs from THIS network.
 *                    It spends this network's 30/min prerender bucket on purpose; once ERR-400 is live with
 *                    the secret, only this network's bucket. Pass = never "200 -" (shell for a bot).
 *   --backend-limit  handoff row 3: 35 GETs to the backend with X-Prerender-Secret from env
 *                    PRERENDER_PROXY_SECRET (never printed) and 35 distinct TEST-NET client IPs. Pass = 35 × 200.
 *   --base <url>     run the www rows against another deployment (e.g. the Vercel Preview).
 *   --preview        add the P1 §5 rows (bot vs Chrome head parity, FE-2 404s, 0005 home FAQ JSON-LD).
 *                    A protected Preview needs env VERCEL_BYPASS (sent only to --base, never printed).
 *
 *   npm run probe:seo-nov26 [-- --burst] [-- --base https://<preview>.vercel.app --preview]
 */
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };
const WWW = (opt('--base', process.env.WWW_BASE || 'https://www.inkcartridges.co.nz')).replace(/\/$/, '');
const APEX = 'https://inkcartridges.co.nz';
const BACKEND = 'https://ink-backend-sg.onrender.com';
const UA_G = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_C = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const burst = flag('--burst') ? Number(opt('--burst', 40)) || 40 : 0;

const mode = [burst && `BURST ${burst} (spends this network's prerender bucket)`, flag('--backend-limit') && 'BACKEND-LIMIT (35 GETs, secret from env, never printed)'].filter(Boolean);
console.log(`probe:seo-nov26 — MODE: ${mode.length ? mode.join(' + ') : 'READ-ONLY (HEAD/GET only)'} against ${WWW}  ${new Date().toISOString()}`);

const results = { pass: 0, fail: 0 };
const check = (ok, m) => { results[ok ? 'pass' : 'fail']++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${m}`); };
// Vercel Deployment Protection on Previews: VERCEL_BYPASS (Settings → Deployment Protection → Protection Bypass
// for Automation) is sent ONLY to the --base host, never printed, never to www/apex/backend.
const BYPASS = process.env.VERCEL_BYPASS || '';
const get = (url, ua = UA_C, extra = {}) => fetch(url, { redirect: 'manual', headers: {
    'User-Agent': ua, ...(BYPASS && WWW !== 'https://www.inkcartridges.co.nz' && url.startsWith(WWW) ? { 'x-vercel-protection-bypass': BYPASS } : {}), ...extra } });
const h = (res, name) => res.headers.get(name) || '-';

// ── P2: redirects ──────────────────────────────────────────────────────────
console.log('\nrow 4 — trailing slash ⇒ 308 to the path without it');
for (const p of ['/ink-cartridges/', '/ribbons/', '/shop/?brand=hp']) {
    const r = await get(`${WWW}${p}`);
    const loc = new URL(h(r, 'location'), WWW);
    const want = p.replace(/\/(\?|$)/, '$1');
    check(r.status === 308 && `${loc.pathname}${loc.search}` === want, `${p} → ${r.status} ${h(r, 'location')}`);
}
for (const p of ['/ink-cartridges', '/shop?brand=hp', '/products/x/GLC233BK']) {
    const r = await get(`${WWW}${p}`);
    check(r.status === 200, `${p} still 200 without the slash (${r.status})`);
}

if (WWW === 'https://www.inkcartridges.co.nz') {
    console.log('\nrow 5 — bare domain ⇒ 308 to www, path and query kept');
    const r = await get(`${APEX}/ink-cartridges?x=1`);
    check(r.status === 308 && h(r, 'location') === 'https://www.inkcartridges.co.nz/ink-cartridges?x=1',
        `apex → ${r.status} ${h(r, 'location')} (307 = Vercel Domains setting still "Temporary")`);
}

// ── P0: the bot answer says whether the crawler IP is forwarded ─────────────
console.log('\nP0 — X-Prerender-Client on a bot answer (forwarded = PRERENDER_PROXY_SECRET reached the middleware)');
{
    const r = await get(`${WWW}/ink-cartridges`, UA_G);
    check(r.status === 200 && h(r, 'x-prerendered') === 'true', `Googlebot /ink-cartridges → ${r.status} x-prerendered=${h(r, 'x-prerendered')}`);
    check(h(r, 'x-prerender-client') === 'forwarded', `x-prerender-client=${h(r, 'x-prerender-client')} ('-' = ERR-400 not deployed; 'shared' = env var missing)`);
}

console.log('\nrow 7 — self-referencing canonical in the raw bot HTML');
{
    const html = await (await get(`${WWW}/ink-cartridges`, UA_G)).text();
    const tag = (html.match(/<link rel="canonical"[^>]*>/) || ['-'])[0];
    check(/href="https:\/\/www\.inkcartridges\.co\.nz\/ink-cartridges"/.test(tag), tag);
}

console.log('\nrow 6 — unknown printer/product ⇒ 404 + noindex, bot AND browser (P1 FE-2: FAILS until Stage A ships)');
for (const ua of [UA_G, UA_M]) {
    for (const p of ['/shop?brand=hp&printer_slug=zz-not-a-printer', '/products/zz-not-a-product/ZZNOTASKU']) {
        const r = await get(`${WWW}${p}`, ua);
        check(r.status === 404 && /noindex/.test(h(r, 'x-robots-tag')), `${ua === UA_G ? 'bot    ' : 'browser'} ${p} → ${r.status} x-robots-tag=${h(r, 'x-robots-tag')}`);
    }
}

// ── P1 §5 (Preview) ─────────────────────────────────────────────────────────
if (flag('--preview')) {
    const head = (html) => ({
        title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || null,
        canonical: (html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]*)"/i) || [])[1] || null,
        canonicals: (html.match(/<link\b[^>]*rel="canonical"/gi) || []).length,
        h1: ((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null,
        ld: [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => {
            try { const j = JSON.parse(m[1]); return (Array.isArray(j) ? j : j['@graph'] || [j]).map((x) => x['@type']); } catch { return ['UNPARSEABLE']; }
        }).sort().join(','),
    });
    console.log('\nP1 §5 — raw HTML, Googlebot vs Chrome (title / canonical / H1 / JSON-LD types must match)');
    for (const p of ['/ink-cartridges', '/ribbons', '/shop?brand=brother', '/shop?brand=hp&printer_slug=hp-1000cxi',
        '/products/canon-genuine-cart069hkbk-toner-cartridge-cart069hk-black/GCART069HKBK', '/']) {
        const rb = await get(`${WWW}${p}`, UA_G); const bot = head(await rb.text());
        const rc = await get(`${WWW}${p}`, UA_C); const chr = head(await rc.text());
        const diff = ['title', 'canonical', 'h1', 'ld'].filter((k) => bot[k] !== chr[k]);
        if (p === '/') diff.splice(diff.indexOf('h1') >>> 0, diff.includes('h1') ? 1 : 0); // home H1 is not injected by design (§4)
        check(rb.status === 200 && rc.status === 200 && diff.length === 0 && chr.canonicals === 1 && chr.canonical && !/\/shop$/.test(chr.canonical),
            `${p} → bot ${rb.status} / chrome ${rc.status} x-head-inject=${h(rc, 'x-head-inject')} canonical=${chr.canonical}${diff.length ? ` DIFF: ${diff.map((k) => `${k} bot=${JSON.stringify(bot[k])} chrome=${JSON.stringify(chr[k])}`).join('; ')}` : ''}`);
    }
    console.log('\nP1 0005 — home FAQPage JSON-LD = exactly the 5 visible Q&As, no dispatch claim');
    const home = await (await get(`${WWW}/`, UA_C)).text();
    const faqs = [...home.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter((j) => j && j['@type'] === 'FAQPage');
    check(faqs.length === 1, `FAQPage blocks: ${faqs.length}`);
    const qs = faqs[0]?.mainEntity || [];
    check(qs.length === 5, `Question entries: ${qs.length}`);
    const ldText = JSON.stringify(faqs);
    check(!/Auckland metro|same day|dispatched the same day/i.test(ldText), 'no "Auckland metro" / "same day" in FAQPage JSON-LD');
    const visible = home.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ');
    for (const q of qs) check(visible.includes(q.name.replace(/\s+/g, ' ')), `visible on the page: "${q.name}"`);
}

// ── row 1: burst ────────────────────────────────────────────────────────────
if (burst) {
    console.log(`\nrow 1 — Googlebot burst of ${burst} cold printer URLs from this network (want: 200 true …, then 503; NEVER "200 -")`);
    const xml = await (await fetch(`${WWW}/sitemap-printers.xml`)).text();
    const offset = Number(opt('--offset', 0));
    const urls = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&')).slice(offset, offset + burst);
    const tally = {};
    for (const u of urls) {
        const r = await get(u.replace('https://www.inkcartridges.co.nz', WWW), UA_G);
        const key = `${r.status} ${h(r, 'x-prerendered') === 'true' ? 'true' : '-'} client=${h(r, 'x-prerender-client')}`;
        tally[key] = (tally[key] || 0) + 1;
    }
    for (const [k, n] of Object.entries(tally)) console.log(`      ${String(n).padStart(3)} × ${k}`);
    const shells = Object.entries(tally).filter(([k]) => k.startsWith('200 -')).reduce((s, [, n]) => s + n, 0);
    check(shells === 0, `${shells} bot request(s) got the 200 shell (Soft 404)`);
    check(urls.length === burst, `${urls.length}/${burst} URLs taken from sitemap-printers.xml (offset ${offset})`);
}

// ── row 3: backend alone ────────────────────────────────────────────────────
if (flag('--backend-limit')) {
    console.log('\nrow 3 — backend alone: 35 distinct client IPs with the secret in one minute all pass');
    const secret = process.env.PRERENDER_PROXY_SECRET || '';
    if (secret.length < 32) check(false, `PRERENDER_PROXY_SECRET not in env (or < 32 chars) — row 3 NOT run`);
    else {
        const codes = {};
        for (let i = 1; i <= 35; i++) {
            const r = await fetch(`${BACKEND}/api/prerender/static/about`, { headers: { 'X-Prerender-Secret': secret, 'X-Prerender-Client-IP': `203.0.113.${i}` } });
            codes[r.status] = (codes[r.status] || 0) + 1;
        }
        console.log(`      ${JSON.stringify(codes)}`);
        check(codes[200] === 35, '35 × 200 (a 429 ⇒ the backend is not keying on X-Prerender-Client-IP for this secret)');
    }
}

console.log(`\n${results.pass} pass, ${results.fail} fail`);
process.exit(results.fail ? 1 : 0);
