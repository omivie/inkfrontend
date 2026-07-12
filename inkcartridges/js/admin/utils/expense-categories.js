/**
 * expense-categories.js — the single source of truth for expense categories
 * =========================================================================
 *
 * Every surface that shows, filters, or sums expenses (the Add/Edit form, the
 * table, the filter bar, the KPI + P&L math) reads categories from HERE — they
 * are never re-hardcoded per file again (the old form inlined 8 <option>s with
 * no shared meaning).
 *
 * The critical property is `kind`:
 *   - 'operating'    → a genuine operating expense. COUNTS toward operating
 *                      expenses / P&L / net profit.
 *   - 'order_linked' → a cost the system ALREADY computes automatically per
 *                      order (supplier COGS, Stripe/merchant fees, courier
 *                      shipping treated as pass-through). Logging it here would
 *                      DOUBLE-COUNT against the per-order profit math
 *                      (profitability.js) once that stock sells, so it is
 *                      EXCLUDED from the operating-expense total and clearly
 *                      labelled "already counted in order costs". It stays
 *                      visible for cash-flow tracking only.
 *
 * `gstDefault` seeds the per-expense "claim NZ GST input credit" toggle. Most
 * SaaS is foreign / GST-free (default off); NZ premises, utilities, insurance,
 * professional services etc. carry claimable GST (default on). Wages and
 * financial services are GST-exempt (off).
 *
 * This module is import-free and side-effect-free so it can be unit-tested in a
 * bare vm sandbox (see tests/admin-expenses-categories.test.js).
 *
 * Run with: node --test tests/admin-expenses-categories.test.js
 */

'use strict';

export const EXPENSE_CATEGORIES = [
  // ── Order-linked (EXCLUDED from operating expenses — already auto-counted) ──
  { key: 'inventory',            label: 'Inventory purchases',    kind: 'order_linked', gstDefault: true,  deductibleDefault: true,  hint: 'Stock cost — already counted as COGS when the item sells.' },
  { key: 'merchant_fees',        label: 'Merchant & Stripe fees', kind: 'order_linked', gstDefault: false, deductibleDefault: true,  hint: 'Stripe fees are auto-computed per order.' },
  { key: 'customer_shipping',    label: 'Customer shipping',      kind: 'order_linked', gstDefault: true,  deductibleDefault: true,  hint: 'Courier to the customer — treated as pass-through in order profit.' },

  // ── Operating expenses (COUNT toward P&L / net profit) ──
  { key: 'supplier_shipping',    label: 'Supplier shipping (freight-in)', kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'packaging',            label: 'Packaging',              kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'website_hosting',      label: 'Website & hosting',      kind: 'operating', gstDefault: false, deductibleDefault: true },
  { key: 'software',             label: 'Software subscriptions', kind: 'operating', gstDefault: false, deductibleDefault: true },
  { key: 'marketing',            label: 'Advertising & marketing',kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'banking_fees',         label: 'Banking fees',           kind: 'operating', gstDefault: false, deductibleDefault: true },
  { key: 'refund_chargeback',    label: 'Refund & chargeback costs', kind: 'operating', gstDefault: false, deductibleDefault: true },
  { key: 'office_supplies',      label: 'Office supplies',        kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'vehicle_travel',       label: 'Vehicle & travel',       kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'professional_services',label: 'Professional services',  kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'tax_accounting',       label: 'Tax & accounting',       kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'insurance',            label: 'Insurance',              kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'utilities',            label: 'Utilities',              kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'rent',                 label: 'Rent & premises',        kind: 'operating', gstDefault: true,  deductibleDefault: true },
  { key: 'wages',                label: 'Wages / contractor',     kind: 'operating', gstDefault: false, deductibleDefault: true },
  { key: 'other',                label: 'Other',                  kind: 'operating', gstDefault: false, deductibleDefault: true },
];

/**
 * Legacy category keys the old Financial-Health form saved. Existing rows in
 * the backend carry these, so every read path normalises through here. The
 * mapping is deliberately conservative: old `cogs`/`shipping`/`platform` land
 * on order-linked kinds so historical rows stop double-counting the moment this
 * ships, without rewriting the stored value.
 */
export const LEGACY_CATEGORY_MAP = {
  cogs: 'inventory',
  shipping: 'customer_shipping',
  platform: 'merchant_fees',
  salaries: 'wages',
  rent: 'rent',
  marketing: 'marketing',
  software: 'software',
  other: 'other',
};

const _BY_KEY = (() => {
  const m = Object.create(null);
  for (const c of EXPENSE_CATEGORIES) m[c.key] = c;
  return m;
})();

/** Canonicalise a possibly-legacy category key to a current one. */
export function normalizeCategory(key) {
  if (!key) return 'other';
  const k = String(key).trim();
  if (_BY_KEY[k]) return k;
  if (LEGACY_CATEGORY_MAP[k]) return LEGACY_CATEGORY_MAP[k];
  return 'other';
}

/** Full category object for a key (legacy-normalised). Always returns an object. */
export function categoryByKey(key) {
  const k = normalizeCategory(key);
  return _BY_KEY[k] || { key: 'other', label: 'Other', kind: 'operating', gstDefault: false, deductibleDefault: true };
}

export function categoryLabel(key) {
  return categoryByKey(key).label;
}

/** True when a category is an order-linked cost that must NOT enter operating expenses. */
export function isOrderLinked(key) {
  return categoryByKey(key).kind === 'order_linked';
}

/** The kind for a (legacy-normalised) category key. */
export function categoryKind(key) {
  return categoryByKey(key).kind;
}

export function operatingCategories() {
  return EXPENSE_CATEGORIES.filter(c => c.kind === 'operating');
}

export function orderLinkedCategories() {
  return EXPENSE_CATEGORIES.filter(c => c.kind === 'order_linked');
}

export function orderLinkedKeys() {
  return EXPENSE_CATEGORIES.filter(c => c.kind === 'order_linked').map(c => c.key);
}

/** Default "claim NZ GST" toggle state for a category. */
export function gstDefaultFor(key) {
  return !!categoryByKey(key).gstDefault;
}

// Expose on window for any non-module admin consumer (mirrors ProductColors etc.).
// The bare-import page path uses the ESM exports above; this is a belt-and-braces
// fallback and is a no-op under the test sandbox (no window).
try {
  if (typeof window !== 'undefined') {
    window.ExpenseCategories = {
      EXPENSE_CATEGORIES, LEGACY_CATEGORY_MAP, normalizeCategory, categoryByKey,
      categoryLabel, isOrderLinked, categoryKind, operatingCategories,
      orderLinkedCategories, orderLinkedKeys, gstDefaultFor,
    };
  }
} catch (_) { /* non-fatal */ }
