/**
 * Admin product Save — May 2026 contract pin (rev 2: 2026-05-12)
 * ===============================================================
 *
 * 2026-05-11 incident: editing the price of "Amano Compatible 78000.02 FN
 * Black/Red Printer Ribbon" (sku 78000.02) in /admin#products failed with
 * `Save failed: Failed to update product`. Root cause was a backend CHECK
 * constraint that re-evaluated against the NEW row state and rejected
 * EVERY update on the 34 legacy rows where `source = 'ribbon'`.
 *
 * Backend dev shipped the SQL fix on 2026-05-12 — PUT now succeeds on
 * those rows (verified live: `PUT /api/admin/products/<ribbon-id>` with
 * `{retail_price: 99.99}` returns 200). The Joi enum on `source` still
 * rejects `'ribbon'` writes (must be one of `[genuine, compatible]`),
 * but reading/keeping the legacy value is fine.
 *
 * Two FE shims were retired alongside the backend fix:
 *   • `admin-product-modal__legacy-banner` — actively misleading once
 *     saves work on those rows.
 *   • INTERNAL_ERROR-aware Save toast — generic toast carries the
 *     `(ref XXXXXXXX)` already, no special case needed.
 *
 * Two FE pieces stayed permanent (this file pins them):
 *
 *   A. `buildSelect` preserves legacy values. Without this, opening a
 *      ribbon product silently auto-selected `source='genuine'` (first
 *      <option>) and Save would have written that wrong value back —
 *      historic bug that almost shipped silent data corruption.
 *      Stays as a safety net for any future enum drift.
 *
 *   B. `AdminAPI.updateProduct` surfaces the Render `x-request-id` in the
 *      thrown error so the toast carries an 8-char correlation ref. CORS
 *      `Access-Control-Expose-Headers` shipped 2026-05-11 so this works
 *      cross-origin (verified end-to-end: `Save failed: Validation
 *      failed: ... (ref e72595af)`).
 *
 * Reproduction history in `.claude/memory/errors.md`.
 *
 * Run: `node --test tests/admin-product-save-may2026.test.js`
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');
const ADMIN_API_SRC = READ('inkcartridges/js/admin/api.js');

// Shared esc stub matching the production helper (Security.escapeAttr-equivalent).
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Pull a top-level function declaration out of products.js as text and
// evaluate it in an isolated vm context. Mirrors the strategy in
// tests/admin-color-dropdown.test.js — the file is an ES module that imports
// `esc` from app.js so we can't `require()` it directly.
function loadFn(source, name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`);
  const m = source.match(re);
  assert.ok(m, `expected to find function ${name} in source`);
  const ctx = { esc, window: {} };
  vm.createContext(ctx);
  vm.runInContext(`var __r; ${m[0]}; __r = ${name};`, ctx);
  return ctx.__r;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. buildSelect preserves legacy values (permanent safety net)
// ─────────────────────────────────────────────────────────────────────────────

test('buildSelect: canonical match selects the matching <option> only', () => {
  const buildSelect = loadFn(PRODUCTS_SRC, 'buildSelect');
  const html = buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], 'compatible');

  // Exactly one selected option, and it is the canonical match.
  const selectedMatches = html.match(/<option[^>]*selected[^>]*>/g) || [];
  assert.equal(selectedMatches.length, 1, 'exactly one option must be selected');
  assert.match(html, /<option value="compatible" selected>Compatible<\/option>/);

  // No legacy fallback option appended when value matches canonical list.
  assert.ok(!html.includes('(legacy)'),
    'no "(legacy)" option should appear when the value matches a canonical option');
});

test('buildSelect: empty selected leaves first option visible (browser default), no extra option', () => {
  const buildSelect = loadFn(PRODUCTS_SRC, 'buildSelect');
  const html = buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], '');

  const selectedMatches = html.match(/<option[^>]*selected[^>]*>/g) || [];
  assert.equal(selectedMatches.length, 0,
    'no option should carry selected when the field is empty (browser shows first option)');
  assert.ok(!html.includes('(legacy)'), 'no legacy fallback when input is empty');
});

test('buildSelect: legacy value (source="ribbon") is preserved as a (legacy) option', () => {
  // The bug: previously this dropdown silently auto-selected `genuine` (first
  // option) for every ribbon product, and Save then sent `source: 'genuine'`
  // back to the backend, corrupting the row. This test pins the fix.
  const buildSelect = loadFn(PRODUCTS_SRC, 'buildSelect');
  const html = buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], 'ribbon');

  // All canonical options still rendered, none of them selected.
  assert.match(html, /<option value="genuine">Genuine<\/option>/);
  assert.match(html, /<option value="compatible">Compatible<\/option>/);
  assert.match(html, /<option value="remanufactured">Remanufactured<\/option>/);

  // The legacy value is appended pre-selected with " (legacy)" suffix.
  assert.match(html, /<option value="ribbon" selected>ribbon \(legacy\)<\/option>/,
    'legacy value must be preserved as a selected (legacy) option');

  // Exactly one selected option, and it is the legacy entry.
  const selectedMatches = html.match(/<option[^>]*selected[^>]*>/g) || [];
  assert.equal(selectedMatches.length, 1, 'exactly one option may carry selected');
});

test('buildSelect: case-insensitive match still treats canonical value as canonical', () => {
  // Reading back `source = "Compatible"` (uppercase C) must not be treated as
  // a legacy mismatch — the existing code was case-insensitive, regression-pin.
  const buildSelect = loadFn(PRODUCTS_SRC, 'buildSelect');
  const html = buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], 'Compatible');
  assert.ok(!html.includes('(legacy)'), 'mixed-case canonical must not produce a legacy option');
  assert.match(html, /<option value="compatible" selected>Compatible<\/option>/);
});

test('buildSelect: object-form options ({value,label}) preserve legacy values too', () => {
  const buildSelect = loadFn(PRODUCTS_SRC, 'buildSelect');
  const opts = [
    { value: 'ink_cartridge', label: 'Ink Cartridge' },
    { value: 'toner_cartridge', label: 'Toner Cartridge' },
  ];
  const html = buildSelect('edit-type', opts, 'mystery_legacy_type');
  assert.match(html, /<option value="mystery_legacy_type" selected>mystery_legacy_type \(legacy\)<\/option>/);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. AdminAPI.updateProduct surfaces request_id and structured fields
// ─────────────────────────────────────────────────────────────────────────────

test('AdminAPI.updateProduct rethrows with code/status/request_id attached', () => {
  // Pin the contract: the toast and any caller can read e.code, e.status,
  // and e.request_id from the thrown Error. Backend CORS exposes
  // x-request-id cross-origin, so request_id is now reliably populated.
  assert.match(ADMIN_API_SRC, /err\.code\s*=\s*resp\.code/,
    'updateProduct must attach resp.code to the thrown Error');
  assert.match(ADMIN_API_SRC, /err\.status\s*=\s*resp\.status/,
    'updateProduct must attach resp.status to the thrown Error');
  assert.match(ADMIN_API_SRC, /err\.request_id\s*=\s*resp\.request_id/,
    'updateProduct must attach resp.request_id to the thrown Error');
});

test('AdminAPI.updateProduct error message includes the 8-char request_id ref when present', () => {
  // Verified end-to-end 2026-05-12 against prod: a 400 VALIDATION_FAILED
  // surfaced as `Save failed: ... (ref e72595af)` in the admin toast.
  assert.match(ADMIN_API_SRC, /String\(resp\.request_id\)\.slice\(0,\s*8\)/,
    'updateProduct must slice request_id to 8 chars when appending to the message');
  assert.match(ADMIN_API_SRC, /\(ref \$\{[^}]+\}\)/,
    'updateProduct must format the request_id as "(ref XXXXXXXX)"');
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The legacy-source banner + INTERNAL_ERROR-toast were RETIRED 2026-05-12
// ─────────────────────────────────────────────────────────────────────────────

test('legacy-source banner is gone from the modal builder (backend SQL fix shipped)', () => {
  // The orange `admin-product-modal__legacy-banner` was a placeholder while
  // backend ribbon-row writes 500'd. They no longer 500 (verified live).
  // Keeping the banner would actively mislead admins.
  assert.doesNotMatch(PRODUCTS_SRC, /admin-product-modal__legacy-banner/,
    'legacy-source banner CSS class must be deleted — saves work on those rows now');
  assert.doesNotMatch(PRODUCTS_SRC, /repair-source-ribbon-rows\.js/,
    'banner copy referencing the backend repair script must be deleted — script ran, fix shipped');
});

test('Save catch is the simple generic toast — no INTERNAL_ERROR special case', () => {
  // Pre-2026-05-12 the catch had a `if (isLegacyRow && isInternal)` branch
  // that swapped the toast for a custom message about the backend repair.
  // That path is dead now; the generic toast carries the validation details
  // and `(ref XXXXXXXX)` automatically via AdminAPI.updateProduct.
  assert.doesNotMatch(PRODUCTS_SRC, /isLegacyRow\s*&&\s*isInternal/,
    'Save catch must not retain the legacy-row INTERNAL_ERROR special case');
  assert.doesNotMatch(PRODUCTS_SRC, /Pending operator fix/,
    'Save catch must not retain the "Pending operator fix" copy — backend fix shipped');
  // Generic toast still present
  assert.match(PRODUCTS_SRC, /Toast\.error\(`Save failed: \$\{e\.message\}`\)/,
    'Save catch must keep the generic `Save failed: ${e.message}` toast');
});
