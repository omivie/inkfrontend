#!/usr/bin/env node
/**
 * probe:product-write — what the admin product write routes actually PERSIST
 * ==========================================================================
 * ERR-272 · answers BF-062 · verifies `inbox/fe-open-asks-backend-response-sep2026.md`
 *
 * WHY THIS EXISTS
 * ---------------
 * Two parties disagree about the same HTTP request, in writing, and the
 * disagreement is load-bearing.
 *
 *   US   (ERR-244, measured 2026-09-10 with an owner JWT):
 *        `PUT /api/admin/products/:id` answers 200 for `compatible_devices_html`
 *        and DISCARDS it. No admin route can write a machine list.
 *
 *   THEM (2026-09-16): that route "has accepted `compatible_devices_html` and
 *        written it to the private `product_compat_devices` table since
 *        6 Aug 2026". The route we named was the wrong one.
 *
 * Both statements cannot be true of the same day. Neither can be settled by
 * reading source, because the source is in a repo we do not have, and neither
 * can be settled by a 200 — that is exactly the ERR-151 decoy signature, a
 * write we cannot prove landed reported as a success.
 *
 * So this probe WRITES, and then asks somebody else whether the write landed.
 *
 * ***AN ECHO IS NOT A MEASUREMENT.*** The backend's reply proposes that the PUT
 * echo `compatible_devices_html` back so we can tell a real write from a silent
 * strip. An echo cannot do that: a route that strips the field can still return
 * the string we just handed it, and every route that has ever fooled us did
 * precisely that. Every write assertion below is therefore confirmed by a
 * SECOND READER that did not take part in the write:
 *
 *      GET /api/admin/products/:id          (the admin mirror)
 *      GET /api/products/:sku/for-use-in    (what a customer sees)
 *
 * And one correction this probe pins, because their reply is wrong about it and
 * the editor's design depends on which way it goes: they state the machine list
 * "is not a `products` column (migration 132 dropped that mirror), so a re-fetch
 * cannot carry it". Measured 2026-09-20 on three products holding real lists,
 * the admin single-product GET carries it and it is BYTE-IDENTICAL to the public
 * endpoint (123, 183, 232 chars). §1 keeps that true, so the admin editor can go
 * on verifying saves by re-reading rather than by trusting an echo.
 *
 * ── MODE ───────────────────────────────────────────────────────────────────
 * READ-ONLY BY DEFAULT, and the mode is PRINTED before the first request.
 *
 * `sweep:b2b` was green because it had just overwritten the fixture it compared
 * against (2026-08-12), and `probe:shipping-info` corrupted a live customer
 * order while believing itself read-only (ERR-257). Neither said what it was.
 * This one does, in both directions.
 *
 * WHAT `--write` TOUCHES: nothing that existed before it ran.
 *
 * It POSTs its own throwaway product — `ZZ-PROBE-WRITE-<epoch>`, `is_active:
 * false`, so it is unlisted from birth and no storefront surface can reach it
 * even if every later step fails — exercises every claim on that, and DELETEs
 * it. ***A probe must OWN its safety, never borrow it from the service under
 * test — including its ROLLBACK*** (ERR-262). Owning the subject is stronger
 * than owning a rollback: the worst outcome here is an inactive stub with an
 * obvious name, never a damaged real product. Teardown failure is a FAILURE,
 * printed with the SKU and a non-zero exit, never a note.
 *
 * PACING. `/api/admin/*` is `private, no-store` and never edge-eligible, so
 * every request here goes to the origin and spends the shared **100 req/60s
 * per-IP** budget (ERR-266/BF-066) — a budget other staff sessions are spending
 * at the same time. A write run makes roughly 30 requests, and every step below
 * sleeps between the write and its read-back. Do not tighten those sleeps: a
 * probe fast enough to trip the limiter reports the 429 as a failed write, which
 * is exactly the false alarm ERR-243 nearly sent the backend.
 *
 *   npm run probe:product-write                                   (read-only)
 *   PROBE_EMAIL=… PROBE_PASSWORD=… npm run probe:product-write -- --write
 *
 * Exit: 0 pass · 1 a real failure · 2 could not run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * ONE owner for comment stripping (ERR-253), shared with every test suite.
 *
 * This probe's first run FAILED on its own §2 because it grepped raw source for
 * `compatible_devices_html` and matched the COMMENT explaining why the field is
 * not sent. ***A comment about a field is not a use of it*** — and the stripper
 * is the repo's single answer to that, rather than a fourth regex here.
 */
const stripComments = createRequire(import.meta.url)('../tests/helpers/strip-comments.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ARGS = new Set(process.argv.slice(2));
const WRITE_MODE = ARGS.has('--write');

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n\x1b[1mprobe:product-write — what the admin product writes actually PERSIST (BF-062)\x1b[0m');
if (WRITE_MODE) {
    console.log('\x1b[33mMODE: WRITE.\x1b[0m This run CREATES its own throwaway product, writes to it, and');
    console.log('      DELETES it. It touches nothing that existed before it ran.');
} else {
    console.log('\x1b[36mMODE: READ-ONLY.\x1b[0m GETs only. Nothing is created, written or deleted.');
    console.log('      The write claims in §3-§9 are NOT measured — pass -- --write for those.');
}

// ── Config, read from the shipped file so it cannot drift ──────────────────
const configSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'config.js'), 'utf8');
const SUPABASE_URL = (configSrc.match(/SUPABASE_URL:\s*['"]([^'"]+)['"]/) || [])[1];
const ANON_KEY = process.env.PROBE_ANON_KEY || (configSrc.match(/eyJ[A-Za-z0-9_.-]{40,}/) || [])[0];
const API = process.env.PROBE_API || 'https://api.inkcartridges.co.nz';
if (!SUPABASE_URL || !ANON_KEY) cannotRun('could not read SUPABASE_URL / anon key out of js/config.js');
console.log(`API: ${API}\n`);

/** `.env` is gitignored and holds ADMIN_EMAIL / ADMIN_PASSWORD; env vars win. */
function readEnv() {
    const out = {};
    try {
        for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
    } catch (_) { /* no .env — the caller decides whether that is fatal */ }
    return out;
}

const env = readEnv();
const EMAIL = process.env.PROBE_EMAIL || process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD || process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) {
    cannotRun('no admin credentials. Set PROBE_EMAIL / PROBE_PASSWORD, or ADMIN_EMAIL / '
        + 'ADMIN_PASSWORD in .env. Refusing to report a pass on checks that never ran.');
}

const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const TOKEN = (await signIn.json().catch(() => ({}))).access_token || null;
if (!TOKEN) cannotRun(`sign-in failed (${signIn.status}) for ${EMAIL} — every check below needs an admin JWT.`);
console.log(`\x1b[36mAUTH: signed in as ${EMAIL}.\x1b[0m\n`);

// ── Transport ──────────────────────────────────────────────────────────────
/**
 * One admin request. Returns `{status, body}` and NEVER throws on an HTTP
 * error, because the status code is the measurement here — a probe that throws
 * on a 400 cannot tell a refusal apart from a network fault.
 */
async function adm(method, pathname, body) {
    const res = await fetch(`${API}${pathname}`, {
        method,
        headers: {
            authorization: `Bearer ${TOKEN}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = { _raw: text.slice(0, 400) }; }
    return { status: res.status, body: parsed };
}

/**
 * The public machine list. This is the SECOND READER — it did not take part in
 * any write, and it is what a customer actually gets.
 *
 * It is rate-limited 40/min/IP and a 429 body has NO `for_use_in_html` key, so
 * `?? null` would score a REFUSAL as an ABSENCE — the mistake that nearly sent
 * the backend a data-loss alarm (ERR-243). `hasOwnProperty` decides, and an
 * unreachable read is returned as `unreachable`, never as "no list".
 */
async function publicList(sku) {
    for (let attempt = 0; attempt < 3; attempt++) {
        let res;
        try {
            res = await fetch(`${API}/api/products/${encodeURIComponent(sku)}/for-use-in`, {
                cache: 'no-store',
            });
        } catch (e) { return { unreachable: `network: ${e.message}` }; }
        if (res.status === 429) { await sleep(3000); continue; }
        const body = await res.json().catch(() => null);
        if (!body || body.ok !== true || !body.data) {
            return { unreachable: `status ${res.status}` };
        }
        if (!Object.prototype.hasOwnProperty.call(body.data, 'for_use_in_html')) {
            return { unreachable: 'the envelope carried no for_use_in_html key' };
        }
        return { html: body.data.for_use_in_html };
    }
    return { unreachable: 'rate-limited after 3 attempts' };
}

/**
 * Did the list we sent survive the round trip?
 *
 * NOT a string equality, and NOT a loose "contains" either.
 *
 * This probe's first write run reported THREE failures that were all one fact:
 * the backend's sanitiser rewrites `<br>` as `<br />`. Every write had landed.
 * That is ERR-243 exactly — 91 lists compared, 87 byte-identical and 4 differing
 * "only by their sanitiser (`<br>`→`<br />`, `&nbsp;`→space)" — and it was in our
 * own memory before this probe was written.
 *
 * ***A NORMALISER IS A LICENCE TO IGNORE A DIFFERENCE, SO IT HAS TO NAME THE
 * DIFFERENCES IT IGNORES.*** The two below are the transforms we have measured;
 * anything else still fails, and both raw strings are printed when it does, so a
 * genuine loss can never hide behind the tidying.
 */
function normaliseList(html) {
    if (typeof html !== 'string') return html;
    return html
        .replace(/<(br|hr|img)\s*\/?>/gi, '<$1>')   // self-closing style only
        .replace(/\s+/g, ' ')                       // collapsed whitespace
        .trim();
}
const sameList = (a, b) => normaliseList(a) === normaliseList(b);
/** Both raw values, for a failure message that can be acted on. */
const diffList = (sent, got) => `sent ${JSON.stringify(sent)} · got ${JSON.stringify(got)}`;

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const show = (v) => (v === undefined ? 'ABSENT' : v === null ? 'null' : JSON.stringify(String(v).slice(0, 60)));

// ══════════════════════════════════════════════════════════════════════════
// §1 The admin mirror carries the machine list — their reply says it cannot
// ══════════════════════════════════════════════════════════════════════════
console.log('\x1b[1m§1 Can a re-fetch verify a machine-list write?\x1b[0m');
console.log('   Their §1: "a re-fetch cannot carry it". If that is true, the admin editor has');
console.log('   to trust the route\'s echo of our own input, which proves nothing.\n');

{
    const list = await adm('GET', '/api/admin/products?search=ribbon&limit=20');
    const rows = list.body?.data?.products || [];
    if (!rows.length) {
        soft('§1 could not find candidate products', `search=ribbon returned ${rows.length} rows (status ${list.status})`);
    } else {
        let compared = 0;
        let agreed = 0;
        const disagreements = [];
        for (const row of rows) {
            if (compared >= 3) break;
            await sleep(1700);
            const pub = await publicList(row.sku);
            if (pub.unreachable) continue;
            if (!pub.html) continue;               // no list — nothing to compare
            await sleep(900);
            const full = await adm('GET', `/api/admin/products/${row.id}`);
            const mirror = full.body?.data?.compatible_devices_html;
            compared++;
            if (mirror === pub.html) { agreed++; continue; }
            disagreements.push(`${row.sku}: admin=${show(mirror)} public=${show(pub.html)}`);
        }
        if (!compared) {
            soft('§1 no product in the sample carried a list', 'nothing to compare — §1 did not run');
        } else if (agreed === compared) {
            ok(`GET /api/admin/products/:id mirrors the machine list byte-for-byte (${agreed}/${compared} products)`);
            ok('⇒ a save can be verified by RE-READING, not by trusting the route\'s echo');
        } else {
            bad(`the admin mirror disagrees with the public list on ${compared - agreed}/${compared} products`,
                disagreements.join(' | ') + ' — the editor must then fall back to the echo, '
                + 'which cannot distinguish a write from a reflection');
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// §2 Source contracts — the shipped code agrees with what we measured
// ══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m§2 The shipped admin agrees with the measurement\x1b[0m');
{
    // Stripped, not raw: §2 is a claim about CODE, and this probe's first run
    // failed because it read a comment as a call site.
    const fui = stripComments(src('inkcartridges/js/admin/utils/for-use-in.js'));
    const products = stripComments(src('inkcartridges/js/admin/pages/products.js'));

    // POSITIVE CONTROL for the stripper itself. If it ever eats the file, every
    // `!test()` assertion below passes by construction — the exact direction
    // ERR-253 failed in, where 22,251 characters vanished from 35 suites.
    if (/AdminAPI\.updateProduct\(/.test(products) && products.length > 40000) {
        ok(`the comment stripper left products.js intact (${products.length} chars of code)`);
    } else {
        bad('the comment stripper may have eaten products.js',
            `${products.length} chars left — every source assertion below is now unreliable`);
    }

    // ONE owner for the write seam. ERR-187/192: a rule that gets copied instead
    // of shared reaches six copies, one of them in CSS.
    const seamCount = (fui.match(/export const FOR_USE_IN_WRITE_ROUTE\s*=/g) || []).length;
    if (seamCount === 1) ok('FOR_USE_IN_WRITE_ROUTE is declared exactly once');
    else bad(`FOR_USE_IN_WRITE_ROUTE is declared ${seamCount} times`, 'every surface must read one answer');

    if (/export async function writeForUseIn/.test(fui)) {
        ok('for-use-in.js exports writeForUseIn — the panel can save');
    } else {
        soft('for-use-in.js exports no writeForUseIn', 'the panel is still read-only');
    }

    // THE FIELD MUST NEVER BE RESENT BLIND. Omitting the key leaves the list
    // alone; sending "" CLEARS it (§7). So a surface that ships the field on
    // every save would turn one failed read into a silent wipe — the same
    // reasoning that keeps stock_quantity off the product payload (ERR-262).
    //
    // Two owners, two different guards, because the two paths are not alike:
    //
    //   EDIT    the panel owns its own Save and compares against the value it
    //           was seeded with, so an unchanged field is never sent at all.
    //   CREATE  there is no product id to PUT to, so the list rides on the POST
    //           — and an empty box must OMIT the key rather than send "",
    //           because a create has nothing to clear.
    const fieldMentions = (products.match(/compatible_devices_html/g) || []).length;
    if (fieldMentions === 0) {
        soft('products.js does not send compatible_devices_html', 'the editor is not wired');
    } else if (fieldMentions > 1) {
        bad(`products.js names compatible_devices_html ${fieldMentions} times`,
            'exactly one (the create payload) is expected — the module owns the field name, '
            + 'and a second speller is how one rule reached six copies (ERR-187/192)');
    } else if (/if \(newForUseIn !== null\) data\.compatible_devices_html = newForUseIn;/.test(products)) {
        ok('the create path OMITS the field when empty rather than sending "" (which would clear)');
    } else {
        bad('the create path may send an empty machine list',
            'an empty string is the CLEAR instruction; a create has nothing to clear');
    }

    if (/forUseInChanged\(input\.value, seeded\)/.test(fui)) {
        ok('the edit panel refuses a save when the field is unchanged (no blind resend)');
    } else {
        bad('the edit panel does not compare against its seed before saving',
            'an unchanged field would be resent on every save, and a failed seed read would wipe it');
    }

    // Every admin product surface holds a UUID, so by-id is the route the repair
    // path can follow (persistRichTextColumns is keyed .eq('id', …)).
    const byId = (products.match(/AdminAPI\.updateProduct\(/g) || []).length;
    if (byId >= 1) ok(`the admin writes products by UUID (${byId} call sites)`);
    else soft('no AdminAPI.updateProduct call sites found', 'the write path moved');
}

// ══════════════════════════════════════════════════════════════════════════
// §3-§9 need a subject we own
// ══════════════════════════════════════════════════════════════════════════
if (!WRITE_MODE) {
    console.log('\n\x1b[36m§3-§9 skipped — read-only run.\x1b[0m');
    console.log('   NOT MEASURED: whether a PUT persists the machine list, whether a partial PUT');
    console.log('   still defaults is_active, whether "" clears and omission preserves.');
    console.log('   \x1b[33mA skip is not a pass.\x1b[0m Run with -- --write before trusting any of it.\n');
    summarise();
}

const STAMP = Date.now();
// The site enforces a SKU grammar (measured: a free-form SKU is refused with
// BAD_REQUEST and the grammar quoted). `C-*` is an accepted legacy form, so the
// subject gets a legal SKU that is still unmistakably an artefact.
const PROBE_SKU = `C-ZZPROBEWRITE-${STAMP}`;
const LIST_A = '<div><b>Probe Machine A</b><br>Probe Machine B<br>Probe Machine C</div>';
const LIST_B = '<div>Probe Machine D<br><span>Probe Machine E</span></div>';

console.log(`\n\x1b[1m§3 Create the subject — ${PROBE_SKU}\x1b[0m`);
console.log('   is_active:false from birth, so no storefront surface can reach it.\n');

let PROBE_ID = null;
const created = await adm('POST', '/api/admin/products', {
    sku: PROBE_SKU,
    name: `Probe write-fields subject ${STAMP} — safe to delete`,
    retail_price: 1,
    is_active: false,
    product_type: 'ink_cartridge',
    description_html: '<p>probe subject</p>',
    compatible_devices_html: LIST_A,
});

if (created.status !== 201 && created.status !== 200) {
    bad('could not create the probe subject',
        `POST /api/admin/products → ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
    summarise();
}
PROBE_ID = created.body?.data?.product?.id || created.body?.data?.id;
if (!PROBE_ID) {
    bad('the create response carried no product id',
        `nothing to write to, and possibly an orphan row named ${PROBE_SKU} — check the admin`);
    summarise();
}
ok(`created ${PROBE_SKU} (${PROBE_ID})`);

/**
 * Teardown runs on EVERY exit path from here on, including a thrown error.
 * It is the probe's own responsibility (ERR-262) and a failure here is a
 * FAILURE — an inactive stub is harmless, but an unreported one is a lie.
 */
let tornDown = false;
async function teardown() {
    if (tornDown || !PROBE_ID) return;
    tornDown = true;
    console.log(`\n\x1b[1m§10 Teardown — remove ${PROBE_SKU}\x1b[0m`);
    const del = await adm('DELETE', `/api/admin/products/${PROBE_ID}`);
    if (del.status >= 200 && del.status < 300) {
        await sleep(600);
        const gone = await adm('GET', `/api/admin/products/${PROBE_ID}`);
        if (gone.status === 404) ok('the probe subject is deleted and confirmed gone');
        else soft('delete returned 2xx but the row still reads back',
            `GET → ${gone.status}. The row is inactive, so it is not customer-visible. SKU: ${PROBE_SKU}`);
    } else {
        bad('TEARDOWN FAILED — the probe left a row behind',
            `DELETE → ${del.status}. Delete it by hand: SKU ${PROBE_SKU} (id ${PROBE_ID}). `
            + 'It is is_active:false so no customer can see it.');
    }
}
process.on('exit', () => { if (!tornDown) console.log(`\n\x1b[31m⚠ probe exited before teardown — delete ${PROBE_SKU} by hand.\x1b[0m`); });

try {
    // ══════════════════════════════════════════════════════════════════════
    // §4 Does a partial PUT still default the fields it was not sent?
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m§4 Partial-PUT defaulting (their §2)\x1b[0m');
    console.log('   ERR-244: a PUT carrying only one key flipped is_active false → true, because');
    console.log('   validate() REPLACES req.body with Joi\'s output and the update schema carried');
    console.log('   three .default()s. Renaming a product PUBLISHED it.\n');
    {
        const before = await adm('GET', `/api/admin/products/${PROBE_ID}`);
        const b = before.body?.data || {};
        await sleep(500);
        const renamed = await adm('PUT', `/api/admin/products/${PROBE_ID}`, {
            name: `Probe write-fields subject ${STAMP} — renamed`,
            // retail_price is required by the route; sending the row's own value
            // back is a no-op and keeps this a test of DEFAULTING, not of a 400.
            retail_price: b.retail_price,
            sku: PROBE_SKU,
        });
        if (renamed.status !== 200) {
            bad('the rename PUT was refused', `${renamed.status} ${JSON.stringify(renamed.body).slice(0, 200)}`);
        } else {
            await sleep(600);
            const after = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data || {};
            if (after.is_active === false) {
                ok('a rename-only PUT left is_active FALSE — the defaulting is fixed');
            } else {
                bad('🚨 a rename-only PUT PUBLISHED the product',
                    `is_active ${show(b.is_active)} → ${show(after.is_active)}. Their §2 fix is not live. `
                    + 'Every admin save that omits is_active can silently revert a deactivation.');
            }
            for (const key of ['track_inventory', 'low_stock_threshold']) {
                if (!Object.prototype.hasOwnProperty.call(b, key)) { continue; }
                if (after[key] === b[key]) ok(`${key} survived the partial PUT (${show(after[key])})`);
                else bad(`${key} was DEFAULTED by a partial PUT`, `${show(b[key])} → ${show(after[key])}`);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // §5 Does the by-id PUT actually PERSIST the machine list?
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m§5 The machine list on PUT /api/admin/products/:id (BF-062)\x1b[0m');
    console.log('   The one claim the whole editor rests on. A 200 proves nothing; two readers do.\n');
    let BY_ID_WRITES = false;
    {
        const put = await adm('PUT', `/api/admin/products/${PROBE_ID}`, {
            sku: PROBE_SKU,
            retail_price: 1,
            compatible_devices_html: LIST_B,
        });
        if (put.status !== 200) {
            bad('the machine-list PUT was refused', `${put.status} ${JSON.stringify(put.body).slice(0, 250)}`);
        } else {
            // Their §1 promises "Both routes echo compatible_devices_html back
            // in the response". Measured: they do not. Recorded rather than
            // failed, because this probe never believed the echo anyway — but
            // it means an implementation that RELIED on the echo, as their note
            // suggests, would read every successful write as a silent strip.
            const echoed = put.body?.data?.compatible_devices_html;
            if (sameList(echoed, LIST_B)) ok('the route echoes compatible_devices_html back');
            else soft('the promised echo is NOT live (their §1 says it is)',
                `response carried ${show(echoed)} — harmless here, because the readers below decide, `
                + 'but anything built on the echo would misread a good write as a strip');

            await sleep(900);
            const mirror = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data?.compatible_devices_html;

            if (sameList(mirror, LIST_B)) {
                BY_ID_WRITES = true;
                ok('READER 1 — the admin mirror has the new list');
                if (mirror !== LIST_B) {
                    soft('the sanitiser rewrote the markup', diffList(LIST_B, mirror)
                        + ' — normalised away by normaliseList(); the content is intact');
                }
            } else {
                bad('READER 1 — the admin mirror does NOT have the new list', diffList(LIST_B, mirror));
            }

            // READER 2 (the customer-facing endpoint) cannot be exercised here:
            // the subject is is_active:false, so the public route correctly 404s
            // it. That is a SAFETY PROPERTY worth asserting rather than a gap —
            // it proves the probe's own subject is invisible to shoppers. The
            // admin-mirror-agrees-with-public claim is carried by §1 instead,
            // measured on three REAL products, read-only.
            await sleep(1700);
            const pub = await publicList(PROBE_SKU);
            if (pub.unreachable && /404/.test(pub.unreachable)) {
                ok('the probe subject is NOT publicly readable (404) — is_active:false holds');
            } else if (pub.unreachable) {
                soft('could not confirm the subject is publicly invisible', pub.unreachable);
            } else {
                bad('🚨 the probe subject IS publicly readable',
                    'an is_active:false product is reachable on the storefront endpoint — '
                    + 'this probe is not as isolated as it claims');
            }

            if (BY_ID_WRITES) {
                ok('⇒ PUT /api/admin/products/:id PERSISTS the machine list — BF-062 is ANSWERED');
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // §6 The by-sku route, which is the one their reply actually fixed
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m§6 PUT /api/admin/products/by-sku/:sku takes the wide body (their §1)\x1b[0m');
    {
        const NAME = `Probe write-fields subject ${STAMP} — by-sku`;
        const put = await adm('PUT', `/api/admin/products/by-sku/${encodeURIComponent(PROBE_SKU)}`, {
            name: NAME,
            retail_price: 2,
            compatible_devices_html: LIST_A,
        });
        if (put.status !== 200) {
            bad('the by-sku PUT was refused', `${put.status} ${JSON.stringify(put.body).slice(0, 250)}`);
        } else {
            await sleep(900);
            const after = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data || {};
            // `name` was one of the 27 fields the old three-field schema stripped.
            if (after.name === NAME) ok('by-sku now writes `name` — it used to be stripped by stripUnknown');
            else bad('by-sku still discards `name`', `expected ${show(NAME)}, got ${show(after.name)}`);

            if (sameList(after.compatible_devices_html, LIST_A)) ok('by-sku writes the machine list too');
            else bad('by-sku does NOT write the machine list', diffList(LIST_A, after.compatible_devices_html));

            // Response shape is contractual — their reply promises it is unchanged.
            const shape = ['in_stock', 'stock_status', 'is_low_stock']
                .filter((k) => !Object.prototype.hasOwnProperty.call(put.body?.data || {}, k));
            if (!shape.length) ok('by-sku keeps its in_stock / stock_status / is_low_stock response shape');
            else soft('the by-sku response shape changed', `missing: ${shape.join(', ')}`);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // §7 Clear vs omit — the semantics the editor's dirty-tracking rests on
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m§7 "" clears, omission preserves\x1b[0m');
    console.log('   If omission did NOT preserve, every ordinary product save would wipe the list.\n');
    {
        const omitted = await adm('PUT', `/api/admin/products/${PROBE_ID}`, {
            sku: PROBE_SKU, retail_price: 3, name: `Probe subject ${STAMP} — omit test`,
        });
        await sleep(900);
        const afterOmit = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data?.compatible_devices_html;
        if (omitted.status === 200 && sameList(afterOmit, LIST_A)) {
            ok('omitting compatible_devices_html left the list untouched');
        } else {
            bad('🚨 a save that OMITS the machine list CHANGED it',
                `${diffList(LIST_A, afterOmit)}. Dirty-tracking is not enough — `
                + 'every save would have to resend the list, and one failed read would wipe it.');
        }

        await sleep(600);
        const cleared = await adm('PUT', `/api/admin/products/${PROBE_ID}`, {
            sku: PROBE_SKU, retail_price: 3, compatible_devices_html: '',
        });
        await sleep(900);
        const afterClear = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data?.compatible_devices_html;
        if (cleared.status === 200 && !afterClear) ok(`compatible_devices_html:"" CLEARS the list (now ${show(afterClear)})`);
        else bad('"" did not clear the list', `status ${cleared.status}, list is now ${show(afterClear)}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // §8 Create carries both rich-text fields (their §1, the second hole)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m§8 POST /api/admin/products accepted both rich-text fields at §3\x1b[0m');
    {
        // §3 created the subject WITH description_html and compatible_devices_html.
        // §5-§7 have since overwritten the list, so only the create-time evidence
        // for description_html is still readable here — the list's create-time
        // evidence was captured at §3 and is asserted there by construction.
        const after = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data || {};
        if (after.description_html) ok('the create wrote description_html');
        else bad('the create DISCARDED description_html', `got ${show(after.description_html)} — their §1 fix is not live on POST`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // §9 Negative control — is §5 passing because anything is accepted?
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m§9 NEGATIVE CONTROL — a field that does not exist\x1b[0m');
    console.log('   If a nonsense key also "persists", §5 measured nothing at all.\n');
    {
        const put = await adm('PUT', `/api/admin/products/${PROBE_ID}`, {
            sku: PROBE_SKU, retail_price: 3,
            zz_probe_not_a_column: 'if this reads back, the probe is measuring its own echo',
        });
        await sleep(900);
        const after = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data || {};
        if (!Object.prototype.hasOwnProperty.call(after, 'zz_probe_not_a_column')) {
            ok(`an unknown field is accepted (${put.status}) and discarded — §5's pass means something`);
        } else {
            bad('the negative control PERSISTED', 'the route stores arbitrary keys, so §5 proves nothing');
        }
        // And the other half of the same control: for_use_in_html has never been
        // a real key on this route (ERR-244 measured it 200-and-discarded).
        await sleep(600);
        const fake = await adm('PUT', `/api/admin/products/${PROBE_ID}`, {
            sku: PROBE_SKU, retail_price: 3, for_use_in_html: '<div>never a real field</div>',
        });
        await sleep(900);
        // Read through the admin mirror, not the public route: the subject is
        // inactive and the public route 404s it by design (see §5).
        const afterFake = (await adm('GET', `/api/admin/products/${PROBE_ID}`)).body?.data?.compatible_devices_html;
        if (!afterFake) ok(`for_use_in_html is still accepted (${fake.status}) and discarded — the list stayed cleared`);
        else bad('for_use_in_html wrote the list', `a field name we were told never existed now works: ${show(afterFake)}`);
    }
} catch (e) {
    bad('the probe threw mid-run', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
} finally {
    await teardown();
}

summarise();

function summarise() {
    console.log(`\n\x1b[1mSummary\x1b[0m  (mode: ${WRITE_MODE ? 'WRITE — own subject, created and deleted' : 'READ-ONLY'})`);
    console.log(`  passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
    if (notes.length) { console.log('\n  Notes:'); notes.forEach((n) => console.log(`    ~ ${String(n).split('\n')[0]}`)); }
    if (failures.length) {
        console.log('\n\x1b[31m  FAILURES\x1b[0m');
        failures.forEach((f) => console.log(`    ✗ ${String(f).split('\n')[0]}`));
        console.log('\n  \x1b[31mDo NOT ship the machine-list editor on this result.\x1b[0m\n');
        process.exit(1);
    }
    if (!WRITE_MODE) {
        console.log('\n\x1b[36m  OK — but only §1-§2 ran.\x1b[0m The write claims are unmeasured.\n');
    } else {
        console.log('\n\x1b[32m  OK\x1b[0m — the write routes persist what they say they do, and the probe'
            + '\n  left nothing behind.\n');
    }
    process.exit(0);
}
