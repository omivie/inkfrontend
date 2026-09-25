#!/usr/bin/env node
/**
 * probe-crux.mjs — `npm run probe:crux [-- --save]`
 * ===================================================
 * Real-user (Chrome UX Report) p75 for the origin, phone + desktop, plus the
 * last 8 weekly points. This is FIELD data from real Chrome visitors, a 28-day
 * rolling window — the only before/after we can get for ERR-282..285, because
 * the pre-fix build cannot be re-run against the production API.
 *
 * Baseline: audit-output/crux-baseline-2026-09-23.json (window 08-27 → 09-23,
 * wholly BEFORE the 2026-09-25 deploy). The first window wholly AFTER it ends
 * ~2026-10-23; compare then. A window that straddles 09-25 is a blend.
 *
 * MODE: READ-ONLY. Key read from ~/.crux_api_key (outside the repo, never
 * printed). `--save` writes the raw responses to audit-output/crux-<lastDate>.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://www.inkcartridges.co.nz';
const KEY_FILE = path.join(os.homedir(), '.crux_api_key');
let key;
try { key = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { key = ''; }
if (!key) { console.error(`no key in ${KEY_FILE}`); process.exit(2); }

console.log(`\nprobe:crux — ${ORIGIN}\nMODE: READ-ONLY (field data, 28-day window)\n`);
const api = async (method, body) => {
    const r = await fetch(`https://chromeuxreport.googleapis.com/v1/records:${method}?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.code} ${j.error.message}`);
    return j.record;
};
const date = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const METRICS = ['largest_contentful_paint', 'first_contentful_paint', 'experimental_time_to_first_byte',
    'interaction_to_next_paint', 'cumulative_layout_shift'];

const out = {};
try {
    for (const formFactor of ['PHONE', 'DESKTOP']) {
        const rec = await api('queryRecord', { origin: ORIGIN, formFactor });
        const hist = await api('queryHistoryRecord', { origin: ORIGIN, formFactor,
            metrics: ['largest_contentful_paint', 'first_contentful_paint', 'experimental_time_to_first_byte'] });
        out[formFactor] = { record: rec, history: hist };
        const p = rec.collectionPeriod;
        console.log(`${formFactor}  window ${date(p.firstDate)} → ${date(p.lastDate)}`);
        for (const m of METRICS) {
            const v = rec.metrics[m];
            if (!v) { console.log(`  ${m.padEnd(32)} no data`); continue; }
            console.log(`  ${m.padEnd(32)} p75 ${String(v.percentiles.p75).padStart(6)}   good ${(v.histogram[0].density * 100).toFixed(1)}%`);
        }
        const periods = hist.collectionPeriods;
        const hm = hist.metrics;
        console.log('  weekly p75 (LCP / FCP / TTFB ms; null = too little traffic that week):');
        for (let i = Math.max(0, periods.length - 8); i < periods.length; i++) {
            const at = (m) => hm[m].percentilesTimeseries.p75s[i];
            console.log(`    ${date(periods[i].lastDate)}  ${at('largest_contentful_paint')} / ${at('first_contentful_paint')} / ${at('experimental_time_to_first_byte')}`);
        }
        console.log('');
    }
} catch (err) {
    console.error(`probe could not run: ${err.message}`);
    process.exit(2);
}

if (process.argv.includes('--save')) {
    const last = date(out.PHONE.record.collectionPeriod.lastDate);
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'audit-output', `crux-${last}.json`);
    fs.writeFileSync(file, JSON.stringify({ origin: ORIGIN, fetched: new Date().toISOString(), ...out }, null, 2));
    console.log(`saved ${path.relative(process.cwd(), file)}`);
}
