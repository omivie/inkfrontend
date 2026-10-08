#!/usr/bin/env node
/**
 * probe:business-apply — the /business Apply contract (ERR-297)
 * =============================================================
 * backend-docs/inbox/fe-best-sellers-and-four-replies-round2-backend-response-sep2026.md §8.
 * The unit suite (tests/business-apply-sep2026.test.js) proves the panel logic;
 * this proves the LIVE contract it rests on, and (with --browser) the page.
 *
 *   §E  GET /api/business/apply 404 (the read that made us think there was no
 *       endpoint). With --post-controls ONLY: POST with no token 401 on /apply
 *       AND /reapply, plus a NEGATIVE CONTROL — a route that really does not
 *       exist must answer POST differently (measured 404), or the 401 proves
 *       nothing (a blanket auth wall would 401 every path).
 *       ⚠ HISTORY: until BF-095 /apply was limited to 5 attempts per IP per
 *       24h (ratelimit-policy 5;w=86400), counted BEFORE sign-in, so each POST
 *       control SPENT one of this connection's daily slots (measured
 *       2026-09-29: two curls + one probe run exhausted it, retry-after
 *       84657s). Backend 2026-10-06 (BF-095): the limiter now runs AFTER
 *       sign-in, per user, and a token-less POST is refused 401 without
 *       spending anything. CONFIRMED by the backend 2026-10-07 (ERR-313):
 *       `requireAuth` runs before `businessLimiter` on both routes
 *       (src/routes/business.js), their test sends 14 token-less POSTs ⇒ 14
 *       × 401, 0 × 429, and a live POST answered 401 with only the global
 *       per-minute headers. The controls stay opt-in (they are still POSTs to
 *       production), and a run with them reports any 24h-window header on the
 *       401 (present ⇒ the limiter ran first ⇒ the claim is false).
 *   §S  GET /api/business/status with no token = 401 (the control), and with
 *       --admin the owner's own status + can_apply are printed. `can_apply`
 *       absent FAILS since BF-095 (present on every branch); the page would
 *       still show the form and let the 409 decide (unknown ≠ false).
 *   §V  /api/site/value-props has volume_pricing tiers (the ladder's source).
 *   §B  --browser: /business as a GUEST shows the terms, a rendered ladder (not
 *       the loading line), the contact line, and the sign-in / create-account
 *       links back to /business#apply; the Apply form stays hidden for a guest.
 *
 * MODE: READ-ONLY by default (GETs only). It NEVER posts a real application:
 * --post-controls sends token-less POSTs that the auth wall refuses (before
 * BF-095 they spent the 5/day/IP limiter; confirmed spent nothing since, 7 Oct). --admin adds one
 * Supabase sign-in and one GET.
 *
 *   npm run probe:business-apply
 *   npm run probe:business-apply -- --admin --browser
 *   npm run probe:business-apply -- --post-controls   (safe without a token since BF-095, backend-confirmed 7 Oct)
 *   PROBE_BASE=http://localhost:3000 npm run probe:business-apply -- --browser
 */
import fs from 'node:fs';

const argv = new Set(process.argv.slice(2));
const API = process.env.PROBE_API || 'https://ink-backend-sg.onrender.com';
const SITE = (process.env.PROBE_SITE || 'https://www.inkcartridges.co.nz').replace(/\/+$/, '');
const BASE = (process.env.PROBE_BASE || SITE).replace(/\/+$/, '');
const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || 700);

let pass = 0, fail = 0, softs = 0, unmeasured = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const soft = (n, d) => { softs++; console.log(`  \x1b[33m⚠ ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const POSTS = argv.has('--post-controls');
const MODE = POSTS ? 'READ-ONLY + 3 TOKEN-LESS POSTs (refused 401)' : 'READ-ONLY';
console.log(`probe:business-apply — \x1b[33mMODE: ${MODE}\x1b[0m (${POSTS ? 'GETs + the --post-controls POSTs' : 'GET only'}; no application is ever submitted`
    + `${argv.has('--admin') ? '; --admin: one sign-in + one GET' : ''})`);
if (POSTS) console.log('  \x1b[31m--post-controls: 3 token-less POSTs. Refused 401; since BF-095 they spend NO limiter slot (backend-confirmed 7 Oct: code, test, live) — a 24h-window header on the 401 would say otherwise.\x1b[0m');
console.log(`API ${API}  SITE ${SITE}${argv.has('--browser') ? `  BASE ${BASE}` : ''}`);

/** One request, waiting out a 429 (100 req/60s per IP, shared across endpoints — ERR-266). */
async function call(method, url, init = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
        await pause(DELAY_MS);
        const r = await fetch(url, { method, ...init }).catch(() => null);
        if (!r) return { status: 0, body: null };
        // A POST 429 is REPORTED, never waited out: /apply's window is 24h.
        if (r.status === 429 && method === 'GET') {
            // Say so: a silent multi-minute wait looks like a hang (ERR-266).
            const wait = Math.min(Number(r.headers.get('retry-after')) || 20, 90);
            console.log(`  \x1b[36m… 429 on ${method} ${url.replace(API, '')}: waiting ${wait}s (attempt ${attempt + 1}/5)\x1b[0m`);
            await pause(wait * 1000);
            continue;
        }
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body, policy: r.headers.get('ratelimit-policy') || '' };
    }
    return { status: 429, body: null, policy: '' };
}
// An EMPTY body: if the auth wall ever stopped refusing, the handler would
// reject it as VALIDATION_FAILED rather than create an application.
const noTokenPost = (path) => call('POST', `${API}${path}`, { headers: { 'Content-Type': 'application/json' }, body: '{}' });

// ── §E endpoints ────────────────────────────────────────────────────────────
head('§E /api/business/apply + /reapply exist, POST-only, behind sign-in');
{
    const get = await call('GET', `${API}/api/business/apply`);
    check('GET /api/business/apply → 404 (the read that fooled us: no GET route)', get.status === 404, `HTTP ${get.status}`);
    if (!POSTS) {
        unmeasured++;
        console.log('  \x1b[36m○ UNMEASURED POST controls\x1b[0m — off by default (pre-BF-095 each spent a daily /apply slot); pass --post-controls. Last measured 2026-09-29: /apply 401, /reapply 401, unknown route 404.');
    } else {
        const apply = await noTokenPost('/api/business/apply');
        const reapply = await noTokenPost('/api/business/reapply');
        const control = await noTokenPost('/api/business/zz-no-such-route');
        check('POST /api/business/apply, no token → 401', apply.status === 401, `HTTP ${apply.status}`);
        check('POST /api/business/reapply, no token → 401', reapply.status === 401, `HTTP ${reapply.status}`);
        // BF-095: the 5/24h application limiter runs AFTER sign-in now. Its
        // policy carries the 24h window (w=86400, measured 2026-09-29); the
        // global 100/60s limiter's does not. A 24h policy on a token-less 401
        // means the application limiter ran first — the old, office-locking order.
        for (const [name, r] of [['/apply', apply], ['/reapply', reapply]]) {
            check(`POST ${name} 401 carries no 24h application-limiter policy (BF-095: limiter after sign-in)`,
                !/w=86400/.test(r.policy), `ratelimit-policy=${JSON.stringify(r.policy)}`);
        }
        // Negative control: if an unknown route ALSO 401s, the auth wall sits in
        // front of routing and the two 401s above prove nothing about existence.
        if (control.status === 401) soft('control POST /api/business/zz-no-such-route', 'also 401 — the auth wall runs before routing, so §E cannot distinguish "exists" from "does not"; the backend\'s own word (§8) is the evidence');
        else check('control POST to a route that does not exist ≠ 401', control.status !== 401, `HTTP ${control.status}`);
    }
}

// ── §S status ───────────────────────────────────────────────────────────────
head('§S /api/business/status');
{
    const anon = await call('GET', `${API}/api/business/status`);
    check('GET /api/business/status, no token → 401 (control)', anon.status === 401, `HTTP ${anon.status}`);
}
if (argv.has('--admin')) {
    const env = fs.existsSync('.env') ? Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })) : {};
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    const tok = email && password ? (await (await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    })).json()).access_token : null;
    if (!tok) bad('admin sign-in', 'ADMIN_EMAIL / ADMIN_PASSWORD missing or refused');
    else {
        const r = await call('GET', `${API}/api/business/status`, { headers: { Authorization: `Bearer ${tok}` } });
        const d = r.body && r.body.data;
        check('signed-in GET /api/business/status → 200', r.status === 200, `HTTP ${r.status}`);
        if (d) {
            const statuses = ['personal', 'pending', 'approved', 'rejected', 'suspended', 'closed'];
            check('status is one of the six documented values', statuses.includes(String(d.status).toLowerCase()), `status=${JSON.stringify(d.status)}`);
            // BF-095 (backend 2026-10-06): can_apply is on EVERY branch now — the
            // approved one included (false). Absent is a regression, not a soft gap.
            check('can_apply is a boolean (BF-095: present on every status branch)', typeof d.can_apply === 'boolean', `can_apply=${JSON.stringify(d.can_apply)} status=${d.status}`);
        }
    }
}

// ── §V value props ──────────────────────────────────────────────────────────
head('§V /api/site/value-props volume_pricing (the ladder\'s source)');
{
    const r = await call('GET', `${API}/api/site/value-props`);
    const vp = r.body && r.body.data && r.body.data.volume_pricing;
    check('value-props 200', r.status === 200, `HTTP ${r.status}`);
    check('volume_pricing.tiers is a non-empty array', Array.isArray(vp?.tiers) && vp.tiers.length > 0, `${vp?.tiers?.length ?? 'absent'} tiers`);
}

// ── §B browser ──────────────────────────────────────────────────────────────
if (argv.has('--browser')) {
    head(`§B /business as a guest (${BASE})`);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 664 }]) {
        const ctx = await browser.newContext({ viewport: vp });
        // Analytics beacons are aborted so a probe never writes a pageview. This
        // is a request block, not a transport claim (the ctx.route CORS caveat
        // does not apply to what is rendered).
        await ctx.route(/googletagmanager|google-analytics|bat\.bing|clarity\.ms/, (r) => r.abort());
        const page = await ctx.newPage();
        await page.goto(`${BASE}/business`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const d = document.getElementById('business-denied');
            const l = document.getElementById('business-ladder');
            return d && !d.hidden && l && !/Loading the current/.test(l.textContent);
        }, null, { timeout: 20000 }).catch(() => null);
        const s = await page.evaluate(() => ({
            open: !document.getElementById('business-denied')?.hidden,
            ladder: document.getElementById('business-ladder')?.innerHTML || '',
            contact: document.getElementById('business-contact')?.textContent || '',
            signin: document.querySelector('[data-apply-signin]')?.getAttribute('href') || null,
            signup: document.querySelector('[data-apply-signup]')?.getAttribute('href') || null,
            formHidden: document.getElementById('business-apply-form')?.hidden,
            scrollW: document.documentElement.scrollWidth,
        }));
        const tag = `${vp.width}px`;
        check(`${tag}: open page shown to a guest`, s.open);
        check(`${tag}: ladder rendered (a table, not the loading line)`, /value-page__table/.test(s.ladder), s.ladder.replace(/<[^>]+>/g, ' ').slice(0, 80));
        check(`${tag}: contact line names a phone`, /027 474 0115/.test(s.contact), s.contact.slice(0, 80));
        check(`${tag}: sign-in link returns to /business#apply`, s.signin === '/account/login?redirect=%2Fbusiness%23apply', s.signin);
        check(`${tag}: create-account link returns to /business#apply`, s.signup === '/account/login?tab=register&redirect=%2Fbusiness%23apply', s.signup);
        check(`${tag}: Apply form hidden for a guest`, s.formHidden === true);
        check(`${tag}: no horizontal page scroll`, s.scrollW <= vp.width, `scrollWidth ${s.scrollW}`);
        await ctx.close();
    }
    await browser.close();
}

console.log(`\n  mode: ${MODE}   passed: ${pass}   failed: ${fail}   soft: ${softs}   unmeasured: ${unmeasured}`
    + (unmeasured ? '  (UNMEASURED is not a pass)' : ''));
process.exit(fail ? 1 : 0);
