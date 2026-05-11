/**
 * Admin product Save — May 2026 contract pin
 * ===========================================
 *
 * 2026-05-11 incident: editing the price of "Amano Compatible 78000.02 FN
 * Black/Red Printer Ribbon" (sku 78000.02) in /admin#products failed with
 * `Save failed: Failed to update product`. Root cause was a backend bug —
 * `PUT /api/admin/products/:id` returns 500 INTERNAL_ERROR for every one
 * of the 34 legacy rows that carry `source = 'ribbon'`, regardless of
 * payload. Backend repair via `scripts/repair-source-ribbon-rows.js`
 * (per backend dev reply 2026-05-11). Reproduction in
 * `.claude/memory/errors.md` ("Admin product Save fails…").
 *
 * The frontend cannot fix the underlying SQL bug, but it shipped four
 * mitigations to stop silent data corruption and to give admins a
 * deterministic experience. This file pins those mitigations:
 *
 *   A. `buildSelect` preserves legacy values. Without this, opening a
 *      ribbon product silently auto-selected `source='genuine'` (first
 *      <option>) and Save would have written that wrong value back.
 *
 *   B. `AdminAPI.updateProduct` surfaces the Render `x-request-id` in the
 *      thrown error so the toast carries an 8-char correlation ref to grep
 *      stderr against (matches `reference_request_id_correlation` contract).
 *
 *   C. The product modal renders an orange `admin-product-modal__legacy-banner`
 *      whenever `source ∉ {genuine, compatible}`, warning the admin that
 *      saves will fail.
 *
 *   D. The Save handler shows a specific toast for the
 *      INTERNAL_ERROR-on-legacy-row case, citing this spec.
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
// A. buildSelect preserves legacy values (no silent data corruption)
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
  // Pin the mitigation: the toast must be able to read e.code === "INTERNAL_ERROR"
  // and e.request_id, so the legacy-row catch in products.js can show the
  // dedicated message instead of the generic "Failed to update product".
  assert.match(ADMIN_API_SRC, /err\.code\s*=\s*resp\.code/,
    'updateProduct must attach resp.code to the thrown Error');
  assert.match(ADMIN_API_SRC, /err\.status\s*=\s*resp\.status/,
    'updateProduct must attach resp.status to the thrown Error');
  assert.match(ADMIN_API_SRC, /err\.request_id\s*=\s*resp\.request_id/,
    'updateProduct must attach resp.request_id to the thrown Error');
});

test('AdminAPI.updateProduct error message includes the 8-char request_id ref when present', () => {
  // The api.js shared `request()` helper attaches request_id to error envelopes
  // (see reference_request_id_correlation.md). updateProduct must thread it
  // into the thrown message string so the toast carries the ref.
  assert.match(ADMIN_API_SRC, /String\(resp\.request_id\)\.slice\(0,\s*8\)/,
    'updateProduct must slice request_id to 8 chars when appending to the message');
  assert.match(ADMIN_API_SRC, /\(ref \$\{[^}]+\}\)/,
    'updateProduct must format the request_id as "(ref XXXXXXXX)"');
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Pre-flight banner renders for non-canonical source values
// ─────────────────────────────────────────────────────────────────────────────

test('buildProductModalTabs injects a legacy-source banner when source ∉ {genuine, compatible}', () => {
  // The banner is rendered as a sibling of #pm-panels with the
  // .admin-product-modal__legacy-banner class. We don't run the full modal —
  // we just verify the source contains the gating logic and the marker class.
  assert.match(PRODUCTS_SRC, /admin-product-modal__legacy-banner/,
    'the legacy-source banner CSS class must be present in the modal builder');
  assert.match(PRODUCTS_SRC, /new Set\(\[['"]genuine['"],\s*['"]compatible['"]\]\)/,
    'the allowed-source set must be {genuine, compatible} (mirrors backend Joi enum)');
  // Banner copy must surface the operator action so admins know what unblocks
  // saves — without the script name they have no actionable lever.
  assert.match(PRODUCTS_SRC, /repair-source-ribbon-rows\.js/,
    'the banner must name the backend repair script (operator action) so admins know what unblocks saves');
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Save catch shows the specific toast for INTERNAL_ERROR on legacy rows
// ─────────────────────────────────────────────────────────────────────────────

test('Save catch detects INTERNAL_ERROR/500 on legacy-source rows and shows a specific toast', () => {
  // The catch block must:
  //  - read product.source against the allowed set
  //  - check for code === 'INTERNAL_ERROR' OR status === 500
  //  - show a toast that mentions the legacy source and the spec doc
  assert.match(PRODUCTS_SRC, /isLegacyRow\s*&&\s*isInternal/,
    'Save catch must combine isLegacyRow and isInternal flags');
  assert.match(PRODUCTS_SRC, /e\.code\s*===\s*['"]INTERNAL_ERROR['"]/,
    'Save catch must check e.code === "INTERNAL_ERROR"');
  assert.match(PRODUCTS_SRC, /Pending operator fix/,
    'Save toast must name the pending operator action so admins know who to ping (not surface a generic 500 message)');
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Reproduction breadcrumb stays in errors.md
// ─────────────────────────────────────────────────────────────────────────────
//
// The standalone handoff doc was delivered to the backend dev and removed
// 2026-05-11 (per project_backend_handoff_docs_delivered_may2026 memo). The
// reproduction lives in `.claude/memory/errors.md` ("Admin product Save
// fails…") which is outside the repo, so this file no longer asserts on the
// spec's existence — only on the in-repo mitigations above.
