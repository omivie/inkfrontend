#!/usr/bin/env node
// Verify the SEO meta-rewrite contract (seo-meta-rewrite-may2026.md) against a
// deployed host's bot-prerender layer + the trust endpoint.
//
// The SPA mirrors the backend's authoritative <title> + <meta name=description>
// (api seo for products, prerender head for listings) so the SPA render is
// byte-identical to what crawlers receive (no cloaking penalty). This script
// checks the SOURCE OF TRUTH that the SPA mirrors:
//
//   1. /api/site/trust returns the documented shape (or is reported missing —
//      the SPA fails open by omitting trust clauses until it lands).
//   2. Each surface's prerender endpoint serves a <title> <=60 and a
//      <meta name=description> <=155, both compliance-clean (no superlatives,
//      no scarcity, no competitor name-drops, no price in <title>).
//   3. The printer prerender uses :brand/:slug — the slug-only form 404s
//      (the middleware bug this release fixed: a 404 made the bot fall through
//      to the SPA shell and the printer SEO copy never shipped).
//
// Full bot-vs-SPA byte parity needs a headless browser (Playwright). After
// deploy + Cloudflare purge, additionally run, per surface:
//   document.title  &&  document.querySelector('meta[name=description]').content
// and diff the literal strings against the curl output below.
//
// Usage:
//   node scripts/verify_seo_meta.mjs
//   node scripts/verify_seo_meta.mjs --host https://www.inkcartridges.co.nz
//   node scripts/verify_seo_meta.mjs --api https://ink-backend-zaeq.onrender.com
//
// Exit code: 0 if every assertion passed, 1 otherwise. node >=18 (global fetch).

const args = process.argv.slice(2);
function flag(name, def) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const API = flag('--api', 'https://ink-backend-zaeq.onrender.com').replace(/\/$/, '');

const TITLE_MAX = 60;
const DESC_MAX = 155;
const SUPERLATIVES = /save up to|lowest price|best in nz|cheapest|guaranteed (?:to|result|lowest)|#1|number one|unbeatable/i;
const SCARCITY = /only \d+ left|ending soon|last chance|hurry|while stocks last|selling fast/i;
const COMPETITORS = /officemax|harvey norman|noel\s*leeming|warehouse stationery|the warehouse|jb hi-fi|pb tech/i;

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { failures++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };
const info = (m) => console.log(`  \x1b[2m· ${m}\x1b[0m`);

function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/g, ' ');
}
function extractHead(html) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    let desc = null;
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
        if (/\bname\s*=\s*["']description["']/i.test(tag)) {
            const c = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag) || /\bcontent\s*=\s*'([^']*)'/i.exec(tag);
            if (c) { desc = decodeEntities(c[1]).trim(); break; }
        }
    }
    return { title: t ? decodeEntities(t[1]).trim() : null, description: desc };
}

async function getStatus(path) {
    try {
        const res = await fetch(`${API}${path}`, { headers: { Accept: 'text/html', 'User-Agent': 'Googlebot/2.1' } });
        return { status: res.status, html: res.ok ? await res.text() : '' };
    } catch (e) {
        return { status: 0, html: '', error: e.message };
    }
}

function checkCopy(label, head) {
    if (!head.title) { fail(`${label}: no <title>`); return; }
    if (!head.description) { fail(`${label}: no <meta name=description>`); return; }
    info(`title (${head.title.length}): ${head.title}`);
    info(`desc  (${head.description.length}): ${head.description}`);
    head.title.length <= TITLE_MAX ? pass(`${label}: title <= ${TITLE_MAX}`) : fail(`${label}: title ${head.title.length} > ${TITLE_MAX}`);
    head.description.length <= DESC_MAX ? pass(`${label}: desc <= ${DESC_MAX}`) : fail(`${label}: desc ${head.description.length} > ${DESC_MAX}`);
    !head.title.includes('$') ? pass(`${label}: no price in title`) : fail(`${label}: price anchor in <title>`);
    const blob = `${head.title} ${head.description}`;
    !SUPERLATIVES.test(blob) ? pass(`${label}: no superlatives`) : fail(`${label}: superlative wording`);
    !SCARCITY.test(blob) ? pass(`${label}: no scarcity`) : fail(`${label}: scarcity wording`);
    !COMPETITORS.test(blob) ? pass(`${label}: no competitor name-drop`) : fail(`${label}: competitor name-drop`);
}

const SURFACES = [
    ['Homepage',          '/api/prerender/home'],
    ['Shop landing',      '/api/prerender/shop'],
    ['Category — ink',    '/api/prerender/category/ink'],
    ['Category — toner',  '/api/prerender/category/toner'],
    ['Category — ribbons','/api/prerender/category/ribbons'],
    ['Brand hub',         '/api/prerender/brand/canon'],
    ['Printer hub',       '/api/prerender/printer/brother/brother-mfc-j5945dw'],
];

(async () => {
    console.log(`\nSEO meta-rewrite verification — API ${API}\n`);

    console.log('▶ /api/site/trust');
    try {
        const res = await fetch(`${API}/api/site/trust`, { headers: { Accept: 'application/json' } });
        if (res.ok) {
            const j = await res.json();
            const d = (j && 'data' in j) ? j.data : j;
            const ok = d && d.organization && d.guarantee && d.shipping_promise;
            ok ? pass(`trust returns organization/guarantee/shipping_promise (founded=${d.organization.founded_year}, guarantee=${d.guarantee.days}d, cutoff=${d.shipping_promise.dispatch_cutoff_nzt})`)
               : fail('trust envelope missing documented fields');
        } else {
            info(`trust endpoint not live yet (HTTP ${res.status}) — SPA fails open by omitting trust clauses. OK pre-deploy.`);
        }
    } catch (e) { info(`trust fetch error: ${e.message} — SPA fails open.`); }

    for (const [label, path] of SURFACES) {
        console.log(`\n▶ ${label}  (${path})`);
        const { status, html, error } = await getStatus(path);
        if (status !== 200) { fail(`${label}: prerender HTTP ${status}${error ? ' — ' + error : ''}`); continue; }
        checkCopy(label, extractHead(html));
    }

    console.log('\n▶ Printer prerender path contract (:brand/:slug, slug-only must 404)');
    const slugOnly = await getStatus('/api/prerender/printer/brother-mfc-j5945dw');
    slugOnly.status === 404
        ? pass('slug-only printer prerender 404s (confirms middleware must pass :brand/:slug)')
        : fail(`slug-only printer prerender returned ${slugOnly.status} (expected 404)`);

    console.log(`\n${failures === 0 ? '\x1b[32mAll checks passed\x1b[0m' : `\x1b[31m${failures} check(s) failed\x1b[0m`}\n`);
    process.exit(failures === 0 ? 0 : 1);
})();
