#!/usr/bin/env node
/**
 * audit-colour-vocabulary.mjs
 * ===========================
 * Live oracle for the product-colour vocabulary.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-03 a backend handoff arrived describing six products whose
 * `color` had been corrected — five Canon singles moved from the vague
 * "Colour" to "Tri-Colour", and one HP row became a live tri-colour single.
 * It concluded "Nothing to code. Purge caches and eyeball the swatches."
 *
 * Eyeballing six rows would have missed everything that actually mattered.
 * A full sweep of the catalogue found EIGHT more tri-colour singles still
 * labelled "Colour", a 2-pack flattened into a "single", two byte-identical
 * products at a $28 price fork, and twenty distinct stored colour values the
 * admin dropdown could not offer — including "Grey", which production has
 * used 27 times while our vocabulary only knew the US "Gray".
 *
 * `color` is a FREE-TEXT column shared by a supplier importer, an admin
 * dropdown and three storefront render paths. Free-text plus multiple writers
 * always drifts. The drift is invisible because a colour we do not recognise
 * does not throw — it renders a blank tile and sorts to "unknown", which
 * looks exactly like a product that simply has no colour.
 *
 * This script makes that drift loud. It is the difference between "wait for
 * the next handoff" and "run the audit" (ERR-143).
 *
 * NOT under inkcartridges/. `vercel.json` sets `outputDirectory: "."` with the
 * Vercel project root at `inkcartridges/`, so everything in that tree is served
 * publicly (inkcartridges/scripts/fit-audit.js is live on the web right now).
 * Audit tooling belongs in this directory.
 *
 * ONE VOCABULARY. Every check loads the SHIPPED `ProductColors` out of
 * inkcartridges/js/utils.js. It never re-declares a colour list of its own —
 * an audit that carries its own copy certifies a UI that does not exist.
 *
 * Two passes:
 *
 *   1. STATIC pass — internal consistency of the shipped vocabulary, plus the
 *      regression gate that fails if a FOURTH private colour->hex map appears
 *      anywhere in inkcartridges/js. No network. These are frontend-owned
 *      defects and always block.
 *
 *   2. LIVE pass — walks `GET /api/products` to exhaustion and reconciles the
 *      collected count against `meta.total`, then reports rows whose stored
 *      colour or pack shape the frontend cannot render honestly. These are
 *      BACKEND-owned, so they are graded against a baseline record (see
 *      BASELINE below) rather than failing on day one forever.
 *
 * Usage:
 *   node scripts/audit-colour-vocabulary.mjs            # static + live
 *   node scripts/audit-colour-vocabulary.mjs --static   # static only, no network
 *   node scripts/audit-colour-vocabulary.mjs --json     # machine-readable
 *   node scripts/audit-colour-vocabulary.mjs --update-baseline
 *
 * Env:
 *   API_BASE=...   (optional; defaults to the Render origin)
 *
 * Exit codes: 0 clean · 1 any un-baselined finding, a stale baseline entry,
 * a static failure, or an unreachable API.
 *
 * An unreachable API is a FAILURE, never a silent pass. "I could not read the
 * catalogue" and "the catalogue is clean" are different sentences, and
 * collapsing them is the exact absence-read-as-zero mistake that produced
 * ERR-139.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'colour-vocabulary-baseline.json');

const ARGS = new Set(process.argv.slice(2));
const STATIC_ONLY = ARGS.has('--static');
const JSON_OUT = ARGS.has('--json');
const UPDATE_BASELINE = ARGS.has('--update-baseline');

const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const PAGE_LIMIT = 200;

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (ch = '─') => say(ch.repeat(74));

/** Categories where a cartridge colour is expected to be meaningful. */
const COLOURED_CATEGORIES = new Set(['CON-INK', 'CON-LASER', 'CON-COPIER', 'CON-A3', 'CON-FAX']);

/**
 * Names that describe a machine part carrying no ink or toner. One of these
 * tagged with a colour puts a machine part into colour-filtered views and
 * gives it a cartridge swatch.
 *
 * DRUMS AND IMAGING UNITS ARE DELIBERATELY ABSENT. A colour laser has one
 * drum per colour — "OKI Genuine MC853C Drum Unit MC853 Cyan" is correctly
 * `color: "Cyan"`. Listing them here produced ~30 false positives on the
 * first run, which is how a check earns itself an exemption and stops being
 * read. A fuser, belt, waste bottle or staple cartridge has no colour at all.
 */
const ACCESSORY_NAME_RE = /\b(fuser|transfer\s+belt|waste\s+(?:toner|bottle|box)|maintenance\s+kit|transfer\s+kit|staple|feed\s+roller|separation\s+pad)\b/i;

/** SKU shapes that assert "this is a multi-cartridge pack". */
const PACK_SKU_RE = /(?:-\d+\s*PK|\d+PK|VP|VPVP)$/i;

/** A name or SKU that signals a tri-colour cartridge specifically. */
const TRI_NAME_RE = /tri[-\s]?colou?r/i;
const TRI_SKU_RE = /CLR$/i;

const findings = [];   // backend-owned, graded against the baseline
const staticFails = []; // frontend-owned, always block
const notes = [];

const fail = (check, subject, detail) => findings.push({ check, subject, detail });
const staticFail = (check, detail) => staticFails.push({ check, detail });
const note = (msg) => notes.push(msg);

// ──────────────────────────────────────────────────────────────────────────
// The one interpreter — load the SHIPPED vocabulary
// ──────────────────────────────────────────────────────────────────────────

function loadVocabulary() {
    const utilsPath = path.join(SITE, 'js', 'utils.js');
    if (!fs.existsSync(utilsPath)) {
        console.error(`\n✖ cannot find ${utilsPath} — is this running from the repo root?\n`);
        process.exit(1);
    }
    // utils.js carries a CommonJS export tail guarded on `typeof module`, so a
    // plain require gets the real objects with no stubbing and no second copy.
    const require = createRequire(import.meta.url);
    const { ProductColors, ProductSort } = require(utilsPath);
    if (!ProductColors || !ProductColors.map || !Array.isArray(ProductColors.OPTIONS)) {
        console.error('\n✖ utils.js did not export a usable ProductColors\n');
        process.exit(1);
    }
    return { ProductColors, ProductSort };
}

const { ProductColors, ProductSort } = loadVocabulary();

const swatchFor = (colour) => ProductColors.map[String(colour || '').toLowerCase().trim()] || null;
const OPTION_VALUES = ProductColors.OPTIONS.map(o => o.value);
const OPTION_SET = new Set(OPTION_VALUES.map(v => v.toLowerCase()));

// ──────────────────────────────────────────────────────────────────────────
// Baseline
// ──────────────────────────────────────────────────────────────────────────

function loadBaseline() {
    if (!fs.existsSync(BASELINE_PATH)) return { captured_at: null, api_base: null, accepted: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
        if (!Array.isArray(parsed.accepted)) throw new Error('`accepted` must be an array');
        return parsed;
    } catch (err) {
        console.error(`\n✖ ${BASELINE_PATH} is unreadable: ${err.message}\n`);
        process.exit(1);
    }
}

const baselineKey = (f) => `${f.check}::${f.subject}`;

// ──────────────────────────────────────────────────────────────────────────
// PASS 1 — STATIC (frontend-owned, always blocks)
// ──────────────────────────────────────────────────────────────────────────

/**
 * COLOR_RANK keys that are deliberate short aliases ('k', 'lc', 'vlm') or pack
 * labels rather than renderable colour names. They are not expected to carry a
 * swatch of their own.
 */
const RANK_ALIAS_RE = /^[a-z]{1,4}$/;
const RANK_PACK_KEYS = new Set(['cmy', 'kcmy', 'cmyk', 'bcmy', '3-pack', '3 pack', '4-pack', '4 pack']);

function staticPass() {
    say('\nSTATIC — shipped vocabulary self-consistency');
    rule();

    // S1 — every offerable colour must be paintable.
    for (const value of OPTION_VALUES) {
        if (!swatchFor(value)) {
            staticFail('S1-option-no-swatch',
                `ProductColors.OPTIONS offers '${value}' but ProductColors.map has no entry — an admin can save a colour the storefront cannot paint`);
        }
    }

    // S2 — every ranked colour must be paintable.
    const rank = (ProductSort && ProductSort.COLOR_RANK) || {};
    for (const key of Object.keys(rank)) {
        if (RANK_ALIAS_RE.test(key) || RANK_PACK_KEYS.has(key)) continue;
        if (!swatchFor(key)) {
            staticFail('S2-rank-no-swatch',
                `COLOR_RANK ranks '${key}' but ProductColors.map has no entry — sortable but unpaintable`);
        }
    }

    // S3 — ERR-075 guard, both directions.
    for (const value of ProductColors.PACK_VALUES || []) {
        if (!OPTION_SET.has(value.toLowerCase())) {
            staticFail('S3-pack-value-not-offerable',
                `PACK_VALUES carries '${value}' but OPTIONS does not — the admin Packs filter would match rows nobody can select`);
        }
    }

    // S4 — a duplicated dropdown value renders two identical <option>s.
    const seen = new Set();
    for (const value of OPTION_VALUES) {
        const k = value.toLowerCase();
        if (seen.has(k)) staticFail('S4-duplicate-option', `OPTIONS lists '${value}' more than once`);
        seen.add(k);
    }

    // S5 — THE REGRESSION GATE. Three private colour->hex maps had forked the
    // vocabulary before ERR-143 (shop-page.js loadColorPacks, cc2-packs.js
    // COLOR_DOT, order-detail-page.js getColorPlaceholder). This is what stops
    // a fourth.
    //
    // The signature of a PRODUCT-colour map is the CMYK vocabulary: it maps a
    // cyan key AND a magenta key to hexes. Requiring both is what keeps this
    // gate honest — admin/pages/planner.js has a sticky-note palette
    // (yellow/pink/blue/green/purple/gray) that is a UI theme, not a cartridge
    // colour, and a looser "any colour-word key" test flags it forever until
    // someone silences the whole check.
    const CYAN_KEY_RE = /\bcyan\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/i;
    const MAGENTA_KEY_RE = /\bmagenta\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/i;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js')) continue;
            if (full === path.join(SITE, 'js', 'utils.js')) continue;   // the one vocabulary
            const src = fs.readFileSync(full, 'utf8');
            if (!CYAN_KEY_RE.test(src) || !MAGENTA_KEY_RE.test(src)) continue;
            const lineNo = src.split('\n').findIndex(l => CYAN_KEY_RE.test(l)) + 1;
            staticFail('S5-private-colour-map',
                `${path.relative(ROOT, full)}:${lineNo} declares a private cartridge-colour->hex map. Use ProductColors.getProductStyle() — a private map cannot see Tri-Colour, gradient colours, or color_hex arrays.`);
        }
    };
    walk(path.join(SITE, 'js'));

    say(`  OPTIONS: ${OPTION_VALUES.length} · map: ${Object.keys(ProductColors.map).length} · COLOR_RANK: ${Object.keys(rank).length}`);
    say(`  ${staticFails.length === 0 ? '✔ vocabulary is self-consistent' : `✖ ${staticFails.length} static failure(s)`}`);
}

// ──────────────────────────────────────────────────────────────────────────
// PASS 2 — LIVE
// ──────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RATE_LIMIT_BACKOFF_MS = 20000;
const MAX_PAGE_ATTEMPTS = 4;

async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`${url} -> HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`); }
    return body;
}

/**
 * A 429 is back-pressure, not an answer. Retrying is the difference between a
 * tool people run and a tool that "randomly fails", which is how a gate gets
 * ignored. A rate limit that survives every attempt still aborts loudly —
 * it is never downgraded to "catalogue looks clean".
 */
async function getJsonWithBackoff(url) {
    let lastBody = null;
    for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
        const body = await getJson(url);
        lastBody = body;
        const code = body && body.error && body.error.code;
        if (code !== 'RATE_LIMITED') return body;
        if (attempt === MAX_PAGE_ATTEMPTS) break;
        say(`    rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${attempt}/${MAX_PAGE_ATTEMPTS})`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
    }
    throw new Error(`rate limited after ${MAX_PAGE_ATTEMPTS} attempts: ${url}`);
}

/**
 * Walk /api/products anonymously. Param order is `page` then `limit` to match
 * API.CATALOG_PARAM_ORDER (js/api.js) so the sweep warms the storefront's
 * existing Cloudflare edge keys rather than minting a parallel set (ERR-124).
 */
async function collectCatalog() {
    const rows = [];
    let page = 1;
    let meta = null;
    let endedCleanly = false;
    let guard = 0;

    for (;;) {
        if (++guard > 200) throw new Error('catalog walk exceeded 200 pages — refusing to loop');
        const body = await getJsonWithBackoff(`${API_BASE}/api/products?page=${page}&limit=${PAGE_LIMIT}`);
        if (!body || body.ok === false) {
            throw new Error(`catalog page ${page} failed: ${JSON.stringify(body && body.error)}`);
        }
        const data = body.data || body;
        const items = data.products || data.items || (Array.isArray(data) ? data : []);
        // Pagination lives in the envelope's `meta`, NOT in `data.pagination`.
        meta = body.meta || data.pagination || {};
        rows.push(...items.filter(p => p && typeof p.sku === 'string' && p.sku.trim()));
        say(`  page ${page}: +${items.length} (running ${rows.length}${meta.total ? '/' + meta.total : ''})`);

        if (meta.has_next === false || items.length === 0) { endedCleanly = true; break; }
        page++;
    }

    // These two are unrecoverable: there is nothing to audit.
    if (!endedCleanly) throw new Error('catalog walk did not terminate on has_next=false');
    if (rows.length === 0) throw new Error('catalog walk returned ZERO products — refusing to report "clean"');

    // A count mismatch is LOUD BUT NOT FATAL. Aborting here would make the
    // whole audit unusable for as long as the backend's total is wrong, which
    // is how a gate gets --warn-only'd into irrelevance. Instead the shortfall
    // becomes a finding in its own right and the sweep continues over what it
    // could actually read — partial-ness reported in the RESULT, never
    // swallowed (ERR-139).
    if (typeof meta.total === 'number' && rows.length !== meta.total) {
        fail('L0-catalogue-count-mismatch', `${API_BASE}/api/products`,
            `walked every page to has_next=false and collected ${rows.length} products, but meta.total claims ${meta.total} — ${Math.abs(meta.total - rows.length)} row(s) are counted by the API but never served by it. Everything below was checked against the ${rows.length} rows that ARE reachable; any product in the gap is unaudited AND invisible to the storefront.`);
    }
    return rows;
}

function livePass(rows) {
    say('\nLIVE — catalogue vs the shipped vocabulary');
    rule();

    const byNameKey = new Map();

    for (const p of rows) {
        const sku = p.sku;
        const colour = p.color == null ? null : String(p.color).trim();
        const name = p.name || '';
        const category = p.category || '';
        const isColoured = COLOURED_CATEGORIES.has(category);

        // L1 — stored colour the admin dropdown cannot offer.
        if (colour && !OPTION_SET.has(colour.toLowerCase())) {
            fail('L1-colour-not-offerable', sku,
                `color=${JSON.stringify(colour)} is not in ProductColors.OPTIONS — the admin drawer shows it as "(legacy)" and any save silently re-spells it`);
        }

        // L2 — stored colour the storefront cannot paint.
        if (colour && !swatchFor(colour)) {
            fail('L2-colour-no-swatch', sku,
                `color=${JSON.stringify(colour)} has no ProductColors.map entry — an imageless row renders a blank tile`);
        }

        // L3 — the vague label, on a row that is demonstrably tri-colour.
        if (colour && /^colou?r$/i.test(colour)) {
            const looksTri = TRI_NAME_RE.test(name) || TRI_SKU_RE.test(sku) || /^G?CL\d/i.test(sku);
            fail('L3-vague-colour', sku,
                looksTri
                    ? `color="${colour}" but the name/SKU says tri-colour — should be "Tri-Colour" (a SINGLE cartridge), not a word that could mean a 3-pack`
                    : `color="${colour}" is ambiguous — it names no cartridge count. Pick "Tri-Colour" (one body) or "CMY"/"KCMY" (separate cartridges)`);
        }

        // L4 — a pack SKU stored as a single. This is the flattening error:
        // the row loses its pack ribbon, its savings badge and its constituents.
        if (PACK_SKU_RE.test(sku) && String(p.pack_type || '').toLowerCase() === 'single') {
            fail('L4-pack-sku-stored-single', sku,
                `SKU asserts a multi-cartridge pack but pack_type="single" — the storefront renders no pack UI at all (name: ${JSON.stringify(name)})`);
        }

        // L5 — colour on a machine part.
        if (colour && ACCESSORY_NAME_RE.test(name)) {
            fail('L5-colour-on-accessory', sku,
                `color=${JSON.stringify(colour)} on what the name says is a machine part, not a marking agent: ${JSON.stringify(name)}`);
        }

        // L6 — an imageless TRI-COLOUR row. Imageless products at large are a
        // known, tracked backlog (hundreds of rows) and reporting them all
        // drowns everything else, so the overall count goes out as a note
        // below. Tri-colour specifically is called out because it is the shape
        // this audit was born from: a genuine tri-colour single with no image
        // is the one product that can never show its colour anywhere — the
        // genuine-no-colour-tile invariant forbids the swatch, so a missing
        // photo leaves the customer with a blank square and a name.
        if (isColoured && colour && !p.image_url && TRI_NAME_RE.test(colour)) {
            fail('L6-tricolour-no-image', sku,
                `color=${JSON.stringify(colour)} with image_url=NULL. Genuine rows never render a colour swatch (the genuine-no-colour-tile invariant), so this shows a blank placeholder in every listing until a photo lands.`);
        }

        // L7 — backend shipping an uncollapsed yield code. familyKey collapses
        // these now, but a code arriving pre-forked is worth knowing about.
        for (const code of (Array.isArray(p.series_codes) ? p.series_codes : [])) {
            const raw = String(code || '').toUpperCase().replace(/\s+/g, '');
            if (/^[A-Z]*\d+X{1,3}L$/.test(raw)) {
                fail('L7-uncollapsed-series-code', sku,
                    `series_codes carries the yield-suffixed "${raw}" — the std sibling ships the collapsed base, so the two only co-group because familyKey normalises them`);
            }
        }

        // L8 — duplicate listing: same brand + same name, different price.
        if (name) {
            const key = `${(p.brand?.name || p.brand || '')}::${name.toLowerCase().replace(/\s+/g, ' ').trim()}`;
            if (!byNameKey.has(key)) byNameKey.set(key, []);
            byNameKey.get(key).push(p);
        }
    }

    for (const [key, group] of byNameKey) {
        if (group.length < 2) continue;
        const prices = new Set(group.map(p => Number(p.retail_price)).filter(Number.isFinite));
        if (prices.size < 2) continue;
        const skus = group.map(p => `${p.sku} $${p.retail_price}`).join(' vs ');
        fail('L8-duplicate-name-price-fork', group.map(p => p.sku).sort().join('+'),
            `${group.length} products share the name "${key.split('::')[1]}" at different prices — ${skus}. Customers see identical cards with different prices.`);
    }

    const imageless = rows.filter(p => COLOURED_CATEGORIES.has(p.category || '') && p.color && !p.image_url).length;
    note(`swept ${rows.length} products across ${new Set(rows.map(r => r.category)).size} categories`);
    note(`${imageless} coloured ink/toner rows have no image (tracked backlog — only the tri-colour ones are reported above)`);
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

function report(baseline) {
    const accepted = new Map((baseline.accepted || []).map(a => [baselineKey(a), a]));
    const fresh = [];
    const known = [];
    for (const f of findings) {
        const hit = accepted.get(baselineKey(f));
        (hit ? known : fresh).push(hit ? { ...f, reason: hit.reason, reported: hit.reported_to_backend } : f);
    }

    // A baseline entry that no longer trips is a RESOLVED bug — and it also
    // fails, because the whole point of ERR-140 was that a record allowed to
    // go stale is worse than no record at all.
    //
    // ONLY meaningful when the live pass actually ran. Under --static nothing
    // is swept, so every entry would look "resolved" and the run would fail
    // with 30 phantom fixes — the inverse of the absence-as-zero error, and
    // just as wrong.
    const trippedKeys = new Set(findings.map(baselineKey));
    const stale = STATIC_ONLY
        ? []
        : (baseline.accepted || []).filter(a => !trippedKeys.has(baselineKey(a)));

    if (JSON_OUT) {
        console.log(JSON.stringify({
            ok: staticFails.length === 0 && fresh.length === 0 && stale.length === 0,
            static_failures: staticFails, new_findings: fresh, known_findings: known,
            resolved_baseline_entries: stale, notes
        }, null, 2));
    } else {
        if (staticFails.length) {
            say('\n✖ STATIC FAILURES (frontend-owned — fix these in this repo)');
            rule();
            for (const f of staticFails) say(`  [${f.check}] ${f.detail}`);
        }
        if (fresh.length) {
            say(`\n✖ NEW FINDINGS (${fresh.length}) — backend-owned, not yet reported`);
            rule();
            for (const f of fresh) say(`  [${f.check}] ${f.subject}\n      ${f.detail}`);
        }
        if (known.length) {
            say(`\n• KNOWN (${known.length}) — already reported to the backend, not failing`);
            rule();
            const byCheck = new Map();
            for (const f of known) byCheck.set(f.check, (byCheck.get(f.check) || 0) + 1);
            for (const [check, n] of byCheck) say(`  ${String(n).padStart(4)}  ${check}`);
        }
        if (stale.length) {
            say(`\n✖ RESOLVED (${stale.length}) — these baseline entries no longer trip. Remove them.`);
            rule();
            for (const a of stale) say(`  [${a.check}] ${a.subject}`);
        }
        say('');
        for (const n of notes) say(`  ${n}`);
        rule('═');
        const ok = staticFails.length === 0 && fresh.length === 0 && stale.length === 0;
        say(ok ? '✔ colour vocabulary clean' : '✖ colour vocabulary needs attention');
        say('');
    }

    if (UPDATE_BASELINE) {
        const record = {
            captured_at: new Date().toISOString().slice(0, 10),
            api_base: API_BASE,
            note: 'Backend-owned findings already reported. See tri-colour-catalogue-BACKEND-tasks-aug2026.md. An entry that stops tripping FAILS the audit — delete it when the backend fixes it.',
            accepted: findings.map(f => ({
                check: f.check, subject: f.subject, detail: f.detail,
                reason: 'reported to backend', reported_to_backend: '2026-08-03'
            }))
        };
        fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
        fs.writeFileSync(BASELINE_PATH, JSON.stringify(record, null, 2) + '\n');
        say(`  baseline written: ${path.relative(ROOT, BASELINE_PATH)} (${record.accepted.length} entries)`);
        return 0;
    }

    return (staticFails.length === 0 && fresh.length === 0 && stale.length === 0) ? 0 : 1;
}

// ──────────────────────────────────────────────────────────────────────────

async function main() {
    say('');
    rule('═');
    say('  COLOUR VOCABULARY AUDIT');
    say(`  ${STATIC_ONLY ? 'static only' : API_BASE}`);
    rule('═');

    staticPass();

    if (!STATIC_ONLY) {
        say('\nwalking catalogue…');
        let rows;
        try {
            rows = await collectCatalog();
        } catch (err) {
            // Loud, never silent. An unreadable catalogue is not a clean one.
            console.error(`\n✖ LIVE PASS FAILED: ${err.message}`);
            console.error('  Refusing to report "clean" from a catalogue we could not read.\n');
            process.exit(1);
        }
        livePass(rows);
    }

    process.exit(report(loadBaseline()));
}

main().catch(err => {
    console.error(`\n✖ ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
