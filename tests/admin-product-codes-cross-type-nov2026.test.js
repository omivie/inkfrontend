/**
 * Admin never writes a plain code row naming the OTHER type's code (ERR-384)
 * =========================================================================
 *
 * Backend response 2026-11-20 (ERR-379): seven hand-entered plain
 * `product_codes` rows filed Brother toners under drum codes. A plain row
 * REPLACES the product's derived codes, so the five TN3605 toners carried only
 * DR3605, and DR tiles showed on the toner grid. The backend cannot tell such a
 * row from a deliberate override, so it asked the admin to stop offering one.
 *
 * The guard lives in `AdminAPI.setProductCodes` — the one choke point every
 * code write passes through (product drawer, membership editor, brand rename,
 * new-product filing). It runs BEFORE the delete, so a refusal changes nothing.
 * The rule (`crossTypePlainCodes`, utils/catalogue-pathway.js) is EXACT-MPN:
 * measured live 2026-11-21 over all 75 product_codes rows, a substring rule
 * would have refused six legitimate Lexmark/OKI drum rows; exact refuses 0.
 *
 * Run with: node --test tests/admin-product-codes-cross-type-nov2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_API = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'api.js'), 'utf8');

let M;
let P;
test.before(async () => {
  M = await import('../inkcartridges/js/admin/utils/catalogue-pathway.js');
  P = await import('../inkcartridges/js/admin/utils/pgrst.js');
});

const DRUM_MPNS = ['DR3605', 'IBDR3605', 'DR2415', 'IBDR2415'];

// ── the rule ────────────────────────────────────────────────────────────────

test('a DR code as a PLAIN row on a toner is refused', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'toner_cartridge', mpn: 'TN3605', codes: ['TN3605', 'DR3605'], partnerMpns: DRUM_MPNS,
  }), ['DR3605']);
});

test('the same code as a VISITOR row (chip_category set) is allowed — that is the right way', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'toner_cartridge', mpn: 'TN3605', codes: ['TN3605', 'DR3605'],
    visits: { DR3605: 'consumable' }, partnerMpns: DRUM_MPNS,
  }), []);
});

test('a TN code on a drum is refused (the mirror image)', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'drum_unit', mpn: 'DR2415', codes: ['DR2415', 'TN2445'], partnerMpns: ['TN2445', 'TN2415'],
  }), ['TN2445']);
});

test('a combo pack whose own MPN names both codes keeps both', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'toner_cartridge', mpn: 'TN2445-DR2425', codes: ['TN2445', 'DR2425'], partnerMpns: ['DR2425'],
  }), []);
});

test('a pair code is judged by its halves', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'toner_cartridge', mpn: 'TN2445', codes: ['TN2445/DR2425'], partnerMpns: ['DR2425'],
  }), [], 'own half TN2445 is in the MPN — the pair is this product’s');
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'toner_cartridge', mpn: 'TN1070', codes: ['DR2425/DR2415'], partnerMpns: ['DR2415'],
  }), ['DR2425/DR2415']);
});

test('EXACT match: a printer-family code that is only a FRAGMENT of a toner MPN is fine (Lexmark C544, live)', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'drum_unit', mpn: 'C540X35G', codes: ['C540', 'C544'], partnerMpns: ['C544X1KG', 'C540H1KG'],
  }), []);
});

test('MPN punctuation does not matter (DK-1150 is DK1150)', () => {
  assert.deepEqual(M.crossTypePlainCodes({
    productType: 'toner_cartridge', mpn: 'TK-1154', codes: ['DK1150'], partnerMpns: ['DK-1150'],
  }), ['DK1150']);
});

test('every other product type is untouched', () => {
  for (const productType of ['ink_cartridge', 'waste_toner', 'label_tape', undefined]) {
    assert.deepEqual(M.crossTypePlainCodes({ productType, mpn: '', codes: ['DR3605'], partnerMpns: DRUM_MPNS }), []);
  }
});

// ── the choke point ─────────────────────────────────────────────────────────

/** Run the SHIPPING _refuseCrossTypePlainCodes against a fake Supabase client. */
function loadRefuse({ product, partnerRows = [], productErr = null, partnerErr = null }) {
  const start = ADMIN_API.indexOf('  async _refuseCrossTypePlainCodes(');
  assert.notEqual(start, -1);
  let depth = 0;
  let end = -1;
  for (let j = ADMIN_API.indexOf('{\n', start); j < ADMIN_API.length; j++) {
    if (ADMIN_API[j] === '{') depth++;
    else if (ADMIN_API[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const body = ADMIN_API.slice(start, end);
  const reads = [];
  const sb = {
    from: (table) => {
      const q = { table, filters: [] };
      reads.push(q);
      const c = {
        select: (cols) => { q.cols = cols; return c; },
        eq: (k, v) => { q.filters.push(['eq', k, v]); return c; },
        or: (expr) => { q.or = expr; return c; },
        limit: () => Promise.resolve(partnerErr ? { data: null, error: partnerErr } : { data: partnerRows, error: null }),
        maybeSingle: () => Promise.resolve(productErr ? { data: null, error: productErr } : { data: product, error: null }),
      };
      return c;
    },
  };
  const ctx = {
    PARTNER_TYPE: M.PARTNER_TYPE, crossTypePlainCodes: M.crossTypePlainCodes,
    plainCandidateCodes: M.plainCandidateCodes, pgrstLike: P.pgrstLike,
    SHOP_CATEGORIES: [{ value: 'toner', label: 'Toner' }, { value: 'drums', label: 'Drums & Kits' }],
  };
  vm.createContext(ctx);
  const obj = vm.runInContext(`({ ${body} })`, ctx);
  return { refuse: (codes, visits = {}) => obj._refuseCrossTypePlainCodes(sb, 'p1', codes, visits), reads };
}

const TONER = { product_type: 'toner_cartridge', manufacturer_part_number: 'TN3605', brand: { name: 'Brother' } };

test('setProductCodes runs the check BEFORE it deletes anything', () => {
  const fn = ADMIN_API.slice(ADMIN_API.indexOf('async setProductCodes('), ADMIN_API.indexOf('async getCodeCatalogue('));
  const check = fn.indexOf('await this._refuseCrossTypePlainCodes(sb, productId, clean, visits)');
  assert.ok(check > 0, 'the guard is wired in');
  assert.ok(check < fn.indexOf('.delete()'), 'a refusal must leave the product’s codes as they were');
  assert.ok(fn.indexOf('Object.assign(visits, chipCategory)') < check, 'it sees this save’s visitor rows');
});

test('refusal names the code, the other type and where to do it instead — and says nothing changed', async () => {
  const { refuse, reads } = loadRefuse({ product: TONER, partnerRows: [{ manufacturer_part_number: 'DR3605' }] });
  await assert.rejects(refuse(['TN3605', 'DR3605']), (err) => {
    assert.equal(err.code, 'CROSS_TYPE_CODE');
    assert.match(err.message, /DR3605 is a drum code/);
    assert.match(err.message, /Product Codes → Brother → Drums & Kits → DR3605/);
    assert.match(err.message, /Nothing was changed/);
    return true;
  });
  const partnerRead = reads.find(r => r.or);
  assert.deepEqual(partnerRead.filters, [['eq', 'product_type', 'drum_unit']]);
  assert.match(partnerRead.or, /manufacturer_part_number\.ilike\."%DR3605%"/, 'quoted pattern (ERR-202)');
  assert.ok(!/TN3605/.test(partnerRead.or), 'own-MPN codes are never looked up');
});

test('a toner’s own codes cost one read and pass', async () => {
  const { refuse, reads } = loadRefuse({ product: TONER });
  await refuse(['TN3605']);
  assert.equal(reads.length, 1, 'no partner lookup when every code is in the own MPN');
});

test('visitor rows pass without a partner lookup', async () => {
  const { refuse, reads } = loadRefuse({ product: TONER });
  await refuse(['TN3605', 'DR3605'], { DR3605: 'consumable' });
  assert.equal(reads.length, 1);
});

test('an ink cartridge is never checked against anything', async () => {
  const { refuse, reads } = loadRefuse({ product: { product_type: 'ink_cartridge', manufacturer_part_number: 'LC431' } });
  await refuse(['LC431', 'DR3605']);
  assert.equal(reads.length, 1);
});

test('a failed read REFUSES (before the delete) — unchecked is how the bug came back', async () => {
  const a = loadRefuse({ product: TONER, productErr: { message: 'boom' } });
  await assert.rejects(a.refuse(['DR3605']), /couldn’t check .* nothing was changed/);
  const b = loadRefuse({ product: TONER, partnerErr: { message: 'boom' } });
  await assert.rejects(b.refuse(['DR3605']), /couldn’t check .* nothing was changed/);
});
