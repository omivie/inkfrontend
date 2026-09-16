#!/usr/bin/env node
/**
 * probe:product-stock — can the admin actually WRITE a product's stock level?
 * ==========================================================================
 *
 * WHY THIS EXISTS
 *
 * The admin product editor's "Inventory" tab has no stock quantity on it. Before
 * putting one there, three things have to be measured rather than assumed,
 * because each one has already bitten this repo once:
 *
 *   1. `PUT /api/admin/products/:id` IS A DECOY FOR SOME FIELDS. It answered 200
 *      for `compatible_devices_html` (a column migration 132 had DROPPED) and for
 *      `for_use_in_html` (a column that never existed) — accepted, discarded
 *      (ERR-244). So "add stock_quantity to the payload and watch it turn green"
 *      proves NOTHING. ***An editor whose Save silently drops the operator's
 *      typing is strictly worse than no editor.***
 *
 *   2. A PARTIAL `PUT` DEFAULTS MISSING FIELDS — IT IS NOT A MERGE. A body
 *      carrying only an unknown key flipped `is_active` false→true on
 *      ADMIN-INK-001 (ERR-244). The edit payload at products.js:4003 does NOT
 *      send `stock_quantity`. So there is a live question here that has nothing
 *      to do with the new feature: **is every ordinary product save already
 *      resetting stock?** §3 asks it directly.
 *
 *   3. The direct-PostgREST leg may or may not hold UPDATE on the column. The
 *      admin Products list already runs on its fallback on every load because a
 *      grant changed under it without anyone being told (ERR-220).
 *
 * WHAT IT DOES
 *   §1  Does `stock_quantity` (and its neighbours) exist for this role? Asked ONE
 *       COLUMN AT A TIME — a column list is a joint claim about the schema and is
 *       only as live as its deadest member (ERR-244).
 *   §2  Does `GET /api/admin/products/:id` RETURN `stock_quantity`? Asked with
 *       hasOwnProperty, because absent, null and 0 are three different facts and
 *       only one of them means "no stock". If the record does not carry the
 *       field, the form cannot echo it on save — the same reasoning that makes
 *       `manual_retail_price` write-only (products.js:4043).
 *   §3  THE OMISSION TEST (--write). PUT the payload the shipped editor actually
 *       sends, with stock omitted, and read the stock back.
 *   §4  THE ROUND TRIP (--write). PUT with stock_quantity changed; read it back.
 *   §5  THE POSTGREST LEG (--write). PATCH the column directly; read it back.
 *   §6  Positive control — a column that IS gone must still 400, or §1 is passing
 *       because it is asking nothing.
 *
 * ── SAFETY: THIS PROBE OWNS ITS SAFETY, IT DOES NOT BORROW IT ───────────────
 *
 * On 2026-09-09 a probe billed as read-only wrote to a live customer order,
 * because the only thing standing between it and the mutation was the service it
 * was testing (ERR-257). So:
 *
 *   · Read-only by default. Every write is behind --write and the MODE IS
 *     PRINTED as the second line of output, in reverse video when it can write.
 *   · Writes are confined to a HARD-CODED SKU ALLOWLIST of one row —
 *     ADMIN-INK-001, the inactive "Admin Test Cartridge". The id is resolved FROM
 *     that SKU; no id is ever accepted from a flag, an env var or a listing.
 *   · It re-reads the resolved row and REFUSES to write if it is active, or if
 *     its SKU is not the one asked for. A guard pointed at the wrong row is a
 *     green light (ERR-258).
 *   · The original value is captured BEFORE the first write, restored from a
 *     `finally` and from the crash handlers, and the restore is VERIFIED by
 *     read-back. A cleanup that reports success without looking is the same
 *     class of claim this probe exists to stop making.
 *   · THE RESTORE USES THE SAME ROUTE THAT §4 PROVES IS WRITABLE. The first
 *     version of this probe restored through PostgREST — the very leg §5 exists
 *     to test — so on the first --write run §5 answered 403 and the restore died
 *     with it, leaving the test row 3 units high until it was put back by hand.
 *     ***A PROBE MUST NOT UNDO ITS WRITES THROUGH A PATH IT HAS NOT VERIFIED.***
 *     That is ERR-257 — a probe whose safety was borrowed from the system under
 *     test — wearing a different hat.
 *
 * Exit:  0 = every check passed
 *        1 = a real finding (or a failed restore)
 *        2 = the probe could not run — deliberately NOT 1, because
 *            "nothing was verified" must never read as "nothing was wrong"
 *
 *   npm run probe:product-stock             # read-only
 *   npm run probe:product-stock -- --write  # the mutation cycle on the test row
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const WRITE = ARGS.has('--write');

// The only row this probe may ever write to. Not configurable on purpose.
const TARGET_SKU = 'ADMIN-INK-001';

const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';

let pass = 0;
const findings = [];
const notes = [];
const say = (s) => console.log(s);
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { findings.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const skip = (n, d) => { notes.push(`SKIPPED ${n} — ${d}`); console.log(`  \x1b[90m·\x1b[0m ${n} \x1b[90m— skipped: ${d}\x1b[0m`); };
const cannotRun = (m) => {
  console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`);
  console.log('\x1b[33m  Nothing was verified. Do NOT read this as a pass.\x1b[0m\n');
  process.exit(2);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
}

// Config is read from the shipped file so the probe cannot drift from the app.
const configSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'config.js'), 'utf8');
const SUPABASE_URL = (configSrc.match(/SUPABASE_URL:\s*['"]([^'"]+)['"]/) || [])[1];
const ANON_KEY = (configSrc.match(/eyJ[A-Za-z0-9_.-]{40,}/) || [])[0];

const PRODUCTS_SRC = fs.readFileSync(
  path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'products.js'), 'utf8');

/**
 * The keys the shipped edit form actually sends, parsed out of products.js.
 * Retyping them here would mean §3 measures a save nobody performs — the ERR-231
 * mistake, where the probe was certifying a replica of the thing under test.
 */
function shippedSavePayloadKeys() {
  const start = PRODUCTS_SRC.indexOf('const data = {', PRODUCTS_SRC.indexOf("[data-action=\"save\"]"));
  if (start < 0) return null;
  const end = PRODUCTS_SRC.indexOf('\n    };', start);
  if (end < 0) return null;
  const block = PRODUCTS_SRC.slice(start, end);
  const keys = [...block.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
  if (block.includes('...sourcingPayload(val)')) {
    const sp = PRODUCTS_SRC.match(/function sourcingPayload\(val\) \{[\s\S]*?\n\}/);
    if (sp) keys.push(...[...sp[0].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]));
  }
  return [...new Set(keys)];
}

let TOKEN = null;
const sbHeaders = () => ({
  apikey: ANON_KEY,
  Authorization: `Bearer ${TOKEN || ANON_KEY}`,
  'Content-Type': 'application/json',
});

async function sb(method, pathAndQuery, body, prefer) {
  const headers = sbHeaders();
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function api(method, p, body) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

/** Ask PostgREST whether ONE column resolves. limit=0 → a schema verdict, no rows. */
async function columnResolves(col) {
  const r = await sb('GET', `products?select=${encodeURIComponent(col)}&limit=0`);
  if (r.ok) return { ok: true };
  return { ok: false, status: r.status, code: r.json?.code, message: r.json?.message };
}

// ── Restore, registered BEFORE the first write and honoured on every exit ───
// Which write path actually persists the column. Set by §4 / §5, judged by §7.
let putPersists = false;
let postgrestPersists = false;
let PENDING = null;          // { id, sku, row, original }
let restoreFailed = null;

/**
 * Set a stock level through the one route measured to persist it (§4).
 *
 * The identity fields ride along because `PUT /api/admin/products/:id` defaults
 * missing fields rather than merging them (ERR-244), and `retail_price` is
 * required outright (products.js:4644). Sending the row's own current values
 * back is a no-op for every field except the one being changed.
 */
async function setStock(row, value) {
  return api('PUT', `/api/admin/products/${row.id}`, {
    sku: row.sku,
    name: row.name,
    is_active: false,          // the test row stays inactive, whatever else happens
    retail_price: row.retail_price,
    stock_quantity: value,
  });
}

async function restore() {
  if (!PENDING) return;
  const { id, sku, row, original } = PENDING;
  say('\n\x1b[1mRestore\x1b[0m');
  try {
    const r = await setStock(row, original);
    if (r.status !== 200) throw new Error(`PUT answered ${r.status}: ${r.text.slice(0, 200)}`);

    // Verify, don't assume.
    const after = await sb('GET', `products?id=eq.${encodeURIComponent(id)}&select=stock_quantity`);
    const now = after.json?.[0]?.stock_quantity;
    if (now !== original) throw new Error(`read back ${JSON.stringify(now)}, wanted ${JSON.stringify(original)}`);
    say(`  \x1b[32m✓\x1b[0m ${sku}.stock_quantity restored to ${JSON.stringify(original)} and verified by read-back`);
    PENDING = null;
  } catch (e) {
    restoreFailed = e.message;
    console.error('\n\x1b[41m\x1b[97m RESTORE FAILED \x1b[0m');
    console.error(`\x1b[31mThis probe may have LEFT A CHANGED STOCK LEVEL on a real row.\x1b[0m`);
    console.error(`  product : ${id} (${sku})`);
    console.error(`  wanted  : stock_quantity = ${JSON.stringify(original)}`);
    console.error(`  reason  : ${e.message}`);
    console.error('\n  Put it back by hand, then re-read it to confirm.\n');
  }
}

for (const sig of ['uncaughtException', 'unhandledRejection']) {
  process.on(sig, async (e) => {
    console.error(`\n\x1b[31m${sig}:\x1b[0m ${e && e.message ? e.message : e}`);
    await restore();
    process.exit(2);
  });
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  say('\n\x1b[1mprobe:product-stock — can the admin actually write a product’s stock level?\x1b[0m');
  say(WRITE
    ? `\x1b[41m\x1b[97m MODE: WRITE \x1b[0m — this run CHANGES stock_quantity on ${TARGET_SKU} and puts it back.`
    : '\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET. Pass --write for the mutation cycle (§3–§5).');
  say('');

  if (!SUPABASE_URL || !ANON_KEY) cannotRun('could not read SUPABASE_URL / anon key out of js/config.js');

  const env = { ...readEnv(), ...process.env };
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    cannotRun('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment). '
      + 'The admin product routes 401 without them, and an anonymous run could only ever report '
      + 'a permission answer — which says nothing about whether stock is writable.');
  }

  // ── §0 sign in ───────────────────────────────────────────────────────────
  say('\x1b[1m§0 who this run is\x1b[0m');
  {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    });
    const j = await res.json().catch(() => ({}));
    TOKEN = j.access_token || null;
    if (!TOKEN) cannotRun(`sign-in failed (${res.status}) — ${j.error_description || j.msg || 'no token'}`);
    let claims = {};
    try { claims = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64').toString('utf8')); } catch { /* opaque */ }
    ok(`signed in as ${env.ADMIN_EMAIL} — role "${claims.role || 'unknown'}", `
      + `app_role "${claims.app_metadata?.role || claims.user_metadata?.role || 'unset'}"`);
  }

  // ── §1 do the columns exist, one at a time ───────────────────────────────
  say('\n\x1b[1m§1 the stock columns resolve against the live schema — asked ONE AT A TIME\x1b[0m');
  const STOCK_COLS = ['stock_quantity', 'stock_status', 'low_stock_threshold'];
  const liveCols = new Set();
  for (const col of STOCK_COLS) {
    const r = await columnResolves(col);
    if (r.ok) { liveCols.add(col); ok(`products.${col} exists and is readable by this role`); }
    else if (r.code === '42703') bad(`products.${col} DOES NOT EXIST`, r.message);
    else soft(`products.${col}`, `${r.status} ${r.code || ''} — a permission answer, not a schema answer. `
      + 'This run cannot tell you whether the column exists.');
    await sleep(120);
  }
  if (!liveCols.has('stock_quantity')) {
    cannotRun('products.stock_quantity did not resolve — there is nothing to measure and nothing to build on.');
  }

  // ── §2 does the ADMIN detail route return it? ────────────────────────────
  say('\n\x1b[1m§2 does GET /api/admin/products/:id RETURN stock_quantity?\x1b[0m');
  say('\x1b[90m   absent, null and 0 are three different facts — only one of them means "no stock".\x1b[0m');

  const found = await sb('GET', `products?sku=eq.${encodeURIComponent(TARGET_SKU)}`
    + '&select=id,sku,name,is_active,retail_price,stock_quantity&limit=2');
  if (!found.ok) cannotRun(`could not look up ${TARGET_SKU}: ${found.status} ${found.text.slice(0, 200)}`);
  const rows = found.json || [];
  if (rows.length !== 1) {
    cannotRun(`expected exactly one row for SKU ${TARGET_SKU}, got ${rows.length}. `
      + 'This probe will not write to a row it cannot uniquely identify.');
  }
  const target = rows[0];

  let adminDetailCarriesStock = null;
  {
    const r = await api('GET', `/api/admin/products/${target.id}`);
    if (r.status === 200) {
      const rec = r.json?.data ?? r.json ?? {};
      const body = rec.product ?? rec;
      adminDetailCarriesStock = Object.prototype.hasOwnProperty.call(body, 'stock_quantity');
      if (adminDetailCarriesStock) {
        ok(`the admin detail route carries stock_quantity (${JSON.stringify(body.stock_quantity)}) `
          + '⇒ the edit form can echo it on save');
      } else {
        soft('the admin detail route does NOT return stock_quantity',
          'so the edit form has no value to echo. Sending a guessed one on every save would be the '
          + 'manual_retail_price trap (products.js:4043): a blank would silently wipe a real number. '
          + 'The control must read its baseline from a route that actually returns the field.');
      }
    } else {
      soft('admin detail route', `${r.status} — could not establish whether it returns stock_quantity`);
    }
  }

  // ── §3–§5 the write cycle ────────────────────────────────────────────────
  const saveKeys = shippedSavePayloadKeys();
  if (!saveKeys) {
    soft('could not parse the shipped save payload out of products.js',
      'the source shape changed — §3 would be testing an invented payload, so it is skipped.');
  }

  if (!WRITE) {
    say('\n\x1b[1m§3–§5 the write cycle\x1b[0m');
    skip('§3 omission test', 'read-only run — pass --write');
    skip('§4 PUT round trip', 'read-only run — pass --write');
    skip('§5 PostgREST round trip', 'read-only run — pass --write');
    say('\x1b[90m   Without these three, this run CANNOT tell you whether stock is writable.\x1b[0m');
  } else {
    // The allowlist gate. Re-read what we resolved and refuse anything else.
    if (target.sku !== TARGET_SKU) {
      cannotRun(`resolved row has SKU ${target.sku}, not ${TARGET_SKU} — refusing to write.`);
    }
    if (target.is_active !== false) {
      cannotRun(`${TARGET_SKU} is ACTIVE (is_active=${JSON.stringify(target.is_active)}). `
        + 'This probe only writes to the inactive admin test row, so that a mistake cannot reach a '
        + 'shopper. Deactivate it, or fix the probe — do not widen this gate.');
    }
    const original = target.stock_quantity;
    PENDING = { id: target.id, sku: target.sku, row: target, original };
    say(`\n\x1b[90m   target: ${target.sku} (${target.id}) — inactive, stock_quantity = ${JSON.stringify(original)}\x1b[0m`);

    const readStock = async () => {
      const r = await sb('GET', `products?id=eq.${encodeURIComponent(target.id)}&select=stock_quantity`);
      return r.json?.[0]?.stock_quantity;
    };

    // §3 omission test
    say('\n\x1b[1m§3 does an ordinary save — which omits stock_quantity — change it?\x1b[0m');
    if (!saveKeys) {
      skip('§3 omission test', 'the shipped payload could not be parsed');
    } else {
      // Seed a value we would notice being defaulted away.
      const seed = (Number(original) || 0) + 7;
      const seeded = await setStock(target, seed);
      await sleep(300);
      if (seeded.status !== 200 || (await readStock()) !== seed) {
        skip('§3 omission test', `could not plant a known stock value (PUT ${seeded.status}) — `
          + 'and a stock that merely looks unchanged proves nothing without one');
      } else {
        const body = {};
        for (const k of saveKeys) {
          if (k === 'stock_quantity') continue;          // the whole point
          if (k in target) body[k] = target[k];
        }
        body.retail_price = target.retail_price;          // the route requires it (products.js:4644)
        body.sku = target.sku;
        body.name = target.name;
        body.is_active = false;                           // keep the test row inactive
        const put = await api('PUT', `/api/admin/products/${target.id}`, body);
        await sleep(300);
        const after = await readStock();
        if (put.status !== 200) {
          soft('the edit-shaped PUT was refused', `${put.status} ${put.text.slice(0, 200)} — `
            + 'cannot tell whether an ordinary save preserves stock');
        } else if (after === seed) {
          ok(`an ordinary save left stock_quantity alone (still ${seed}) — omitting it is SAFE`);
        } else {
          bad('AN ORDINARY PRODUCT SAVE CHANGED THE STOCK LEVEL',
            `seeded ${seed}, and after a PUT that never mentioned stock_quantity it read back `
            + `${JSON.stringify(after)}. The editor omits this field on every save (products.js:4003), `
            + 'so every operator edit to any product has been moving stock. File this as its own ERR '
            + '— it is a live data-loss bug, not a gap in the new feature.');
        }
      }
    }

    // §4 PUT round trip
    say('\n\x1b[1m§4 does PUT /api/admin/products/:id PERSIST stock_quantity, or accept-and-discard it?\x1b[0m');
    {
      const base = Number(await readStock()) || 0;
      const want = base + 3;
      const put = await api('PUT', `/api/admin/products/${target.id}`, {
        sku: target.sku, name: target.name, is_active: false,
        retail_price: target.retail_price, stock_quantity: want,
      });
      await sleep(300);
      const after = await readStock();
      if (put.status !== 200) {
        soft('PUT with stock_quantity was refused', `${put.status} ${put.text.slice(0, 220)}`);
      } else if (after === want) {
        putPersists = true;
        ok(`PUT persisted stock_quantity (${base} → ${after}) — the editor can write through AdminAPI.updateProduct`);
      } else {
        bad('PUT ANSWERED 200 AND DISCARDED stock_quantity',
          `asked for ${want}, read back ${JSON.stringify(after)}. This is the ERR-244 decoy shape: a `
          + 'green Save that changes nothing. Do NOT wire the control to this route — use the '
          + 'PostgREST leg if §5 passes, otherwise ship the number read-only and brief the backend.');
      }
    }

    // §4b — the collateral question. A control that writes stock on its own
    // must know what ELSE its payload costs, because a partial PUT has already
    // been measured DEFAULTING missing fields rather than merging them
    // (ERR-244: a body carrying one unknown key flipped is_active false→true).
    // §3 proves stock survives being omitted; that says nothing about whether a
    // five-key body preserves description, tags or supplier.
    say('\n\x1b[1m§4b does a SMALL payload keep the fields it does not mention?\x1b[0m');
    {
      const WIDE = 'description_html,meta_title,meta_description,tags,supplier,supplier_sku,'
        + 'pack_type,barcode,manufacturer_part_number,weight_kg,page_yield,internal_notes,compare_price';
      const snap = await sb('GET', `products?id=eq.${encodeURIComponent(target.id)}&select=${WIDE}`);
      const before = snap.json?.[0];
      if (!before) {
        skip('§4b', 'could not snapshot the wider column set');
      } else {
        const base = Number(await readStock()) || 0;
        await setStock(target, base + 1);           // the same 5-key body the control would send
        await sleep(300);
        const snap2 = await sb('GET', `products?id=eq.${encodeURIComponent(target.id)}&select=${WIDE}`);
        const after = snap2.json?.[0] || {};
        const lost = Object.keys(before).filter(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
        if (!lost.length) {
          ok(`a five-key PUT left all ${Object.keys(before).length} other columns untouched — `
            + 'a stock-only write is safe');
        } else {
          bad('A SMALL PUT DEFAULTED THE FIELDS IT OMITTED',
            `${lost.length} column(s) changed without being mentioned: ${lost.map(
              (k) => `${k} ${JSON.stringify(before[k])}→${JSON.stringify(after[k])}`).join(', ')}. `
            + 'A stock control must therefore send the FULL record, not just the number — '
            + 'and bulkSetActiveFor (products.js:4658), which sends two keys, is doing this today.');
        }
      }
    }

    // §5 PostgREST leg
    say('\n\x1b[1m§5 does the direct PostgREST leg hold UPDATE on stock_quantity?\x1b[0m');
    {
      const base = Number(await readStock()) || 0;
      const want = base + 5;
      const r = await sb('PATCH', `products?id=eq.${encodeURIComponent(target.id)}`,
        { stock_quantity: want }, 'return=representation');
      await sleep(200);
      const after = await readStock();
      if (!r.ok) {
        // Not a defect by itself — §7 decides, because this only matters if the
        // PUT failed too. Same grant family as ERR-220, where a revoke reached
        // `authenticated` and nothing in this repo was told.
        soft('PostgREST will not write this column',
          `${r.status} ${r.json?.code || ''} ${r.json?.message || r.text.slice(0, 160)} — `
          + 'so the direct leg is not available as a fallback, and nothing may restore through it');
      } else if (after === want) {
        postgrestPersists = true;
        ok(`PostgREST persisted stock_quantity (${base} → ${after}) — `
          + 'this leg works, one statement per column (ERR-244)');
      } else {
        bad('PostgREST answered 2xx but the value did not change',
          `asked for ${want}, read back ${JSON.stringify(after)} — an RLS policy is probably filtering the row`);
      }
    }
  }

  // ── §6 positive control ──────────────────────────────────────────────────
  say('\n\x1b[1m§6 positive control — a column that IS gone must still 400\x1b[0m');
  {
    const gone = await columnResolves('compatible_devices_html');
    if (gone.ok) {
      bad('the control column came back ALIVE',
        'products.compatible_devices_html was dropped by migration 132. If it resolves now, either the '
        + 'backend rolled that back, or §1 is not asking the database anything — and its passes mean nothing.');
    } else if (gone.code === '42703') {
      ok('a dropped column still 400s — §1 is really asking the schema');
    } else {
      soft('positive control inconclusive', `${gone.status} ${gone.code || ''} — got a permission answer, not a schema one`);
    }
  }

  // ── §7 the verdict the feature turns on ─────────────────────────────────
  if (WRITE) {
    say('\n\x1b[1m§7 verdict — which path may the Inventory control write through?\x1b[0m');
    if (putPersists) {
      ok('CASE A — PUT /api/admin/products/:id persists stock_quantity. Wire the control to '
        + 'AdminAPI.updateProduct with a small stock-only body (§4b: it costs no other column), '
        + 'and do NOT add stock_quantity to the main save payload — §3 shows omitting it is safe, '
        + 'so echoing a value the form read minutes ago is the only way left to clobber it.');
    } else if (postgrestPersists) {
      ok('CASE B — only the direct PostgREST leg persists it. Follow persistRichTextColumns '
        + '(admin/api.js:2970): ONE STATEMENT PER COLUMN (ERR-244).');
    } else {
      bad('CASE C — NOTHING PERSISTS stock_quantity',
        'neither the admin PUT nor the direct PostgREST leg wrote the column. Ship the number '
        + 'READ-ONLY with a visible note saying it is not editable yet, and brief the backend. '
        + 'A Save that reports success and changes nothing is worse than no control at all.');
    }
  }

}

try {
  await main();
} finally {
  await restore();
}

if (restoreFailed) findings.push(`restore — ${restoreFailed}`);

say(`\n\x1b[1mResult\x1b[0m  ${pass} passed, ${findings.length} finding(s), ${notes.length} note(s)`);
if (!WRITE) say('\x1b[2m  (read-only run — the write cycle was not exercised, so "passed" does not mean "writable")\x1b[0m');
for (const n of notes) say(`  \x1b[33m~\x1b[0m ${n}`);
for (const f of findings) say(`  \x1b[31m✗\x1b[0m ${f}`);
process.exit(findings.length ? 1 : 0);
