/**
 * expense-categories.js — the single source of truth for expense categories
 * =========================================================================
 *
 * Every surface that shows, filters, or sums expenses (the Add/Edit form, the
 * table, the filter bar, the KPI + P&L math) reads categories from HERE — they
 * are never re-hardcoded per file again (the old form inlined 8 <option>s with
 * no shared meaning).
 *
 * OWNER-MANAGED CATEGORIES (Jul 2026): the old 16-item built-in operating list
 * is gone. Operating categories are now the OWNER'S OWN list, stored under the
 * `expenses.categories` key of admin_ui_prefs (same durable per-admin store as
 * expense presets) and loaded into this module at page init via
 * `setCustomCategories()`. Only four categories stay built-in:
 *   - the 3 order_linked ones (they carry the double-count protection), and
 *   - 'other' (the hard fallback every unknown key normalises onto).
 * The retired built-ins live on in RETIRED_CATEGORY_DEFAULTS purely so rows
 * saved under them can be SEEDED back into the owner's list with their original
 * label + GST default (see seedMissingCategories) instead of collapsing to
 * "Other".
 *
 * The critical property is `kind`:
 *   - 'operating'    → a genuine operating expense. COUNTS toward operating
 *                      expenses / P&L / net profit. Every custom category is
 *                      operating by definition.
 *   - 'order_linked' → a cost the system ALREADY computes automatically per
 *                      order (supplier COGS, Stripe/merchant fees, courier
 *                      shipping treated as pass-through). Logging it here would
 *                      DOUBLE-COUNT against the per-order profit math
 *                      (profitability.js) once that stock sells, so it is
 *                      EXCLUDED from the operating-expense total and clearly
 *                      labelled "already counted in order costs". It stays
 *                      visible for cash-flow tracking only.
 *
 * RESERVED KEYS: a custom category may never claim a built-in key nor a
 * NON-IDENTITY legacy key (`cogs`/`shipping`/`platform`/`salaries`). If a
 * custom `shipping` existed, normalizeCategory('shipping') would resolve to it
 * as OPERATING and historical order-linked rows would start double-counting —
 * that guard is load-bearing, not cosmetic.
 *
 * `gstDefault` seeds the per-expense "claim NZ GST input credit" toggle.
 * Custom categories default to claimable (true) unless saved with
 * `gstDefault: false`.
 *
 * This module is import-free and side-effect-free so it can be unit-tested in a
 * bare vm sandbox (see tests/admin-expenses-categories.test.js). It only SHAPES
 * data — the page owns all I/O (mirrors expense-presets.js).
 *
 * Run with: node --test tests/admin-expenses-categories.test.js
 */

'use strict';

export const EXPENSE_CATEGORIES = [
  // ── Order-linked (EXCLUDED from operating expenses — already auto-counted) ──
  { key: 'inventory',            label: 'Inventory purchases',    kind: 'order_linked', gstDefault: true,  deductibleDefault: true,  hint: 'Stock cost — already counted as COGS when the item sells.' },
  { key: 'merchant_fees',        label: 'Merchant & Stripe fees', kind: 'order_linked', gstDefault: false, deductibleDefault: true,  hint: 'Stripe fees are auto-computed per order.' },
  { key: 'customer_shipping',    label: 'Customer shipping',      kind: 'order_linked', gstDefault: true,  deductibleDefault: true,  hint: 'Courier to the customer — treated as pass-through in order profit.' },

  // ── The one built-in operating category: the unknown-key fallback ──
  { key: 'other',                label: 'Other',                  kind: 'operating', gstDefault: false, deductibleDefault: true },
];

/**
 * The retired built-in operating categories. NOT offered in any UI — they exist
 * only so seedMissingCategories() can adopt a key still present on saved rows
 * with its original nice label + GST default, rather than a prettified slug.
 */
export const RETIRED_CATEGORY_DEFAULTS = {
  supplier_shipping:     { label: 'Supplier shipping (freight-in)', gstDefault: true },
  packaging:             { label: 'Packaging',                      gstDefault: true },
  website_hosting:       { label: 'Website & hosting',              gstDefault: false },
  software:              { label: 'Software subscriptions',         gstDefault: false },
  marketing:             { label: 'Advertising & marketing',        gstDefault: true },
  banking_fees:          { label: 'Banking fees',                   gstDefault: false },
  refund_chargeback:     { label: 'Refund & chargeback costs',      gstDefault: false },
  office_supplies:       { label: 'Office supplies',                gstDefault: true },
  vehicle_travel:        { label: 'Vehicle & travel',               gstDefault: true },
  professional_services: { label: 'Professional services',          gstDefault: true },
  tax_accounting:        { label: 'Tax & accounting',               gstDefault: true },
  insurance:             { label: 'Insurance',                      gstDefault: true },
  utilities:             { label: 'Utilities',                      gstDefault: true },
  rent:                  { label: 'Rent & premises',                gstDefault: true },
  wages:                 { label: 'Wages / contractor',             gstDefault: false },
};

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

/** The admin_ui_prefs key the owner's category list is stored under. */
export const CUSTOM_CATEGORIES_KEY = 'expenses.categories';

/**
 * The admin_ui_prefs key of the per-expense category override map.
 *
 * WHY THIS EXISTS: the backend validates `POST/PUT /api/admin/expenses`'s
 * `category` against ITS OWN fixed enum (GET /api/admin/expense-categories —
 * the built-ins + the retired list) and strips unknown fields, so a
 * brand-new owner category can't live in the record's `category` column.
 * Such expenses are saved as `category: 'other'` (a value the backend accepts,
 * with the IDENTICAL operating kind, so every server- and client-side TOTAL is
 * unaffected) and this map — `{ [expenseId]: customKey }`, stored in the same
 * durable per-admin Supabase table as the category list itself — refines the
 * label/grouping back on read. Retired keys (e.g. `software`) are still
 * backend-valid and are stored directly, no override involved.
 *
 * BACKEND FOLLOW-UP OWED: once the API accepts arbitrary category keys, writes
 * can send the custom key directly and this map becomes migration input.
 */
export const CATEGORY_OVERRIDES_KEY = 'expenses.categoryOverrides';

/** Hard cap — a category list, not a filing cabinet. */
export const MAX_CUSTOM_CATEGORIES = 40;

export const MAX_CATEGORY_LABEL = 40;

const _BY_KEY = (() => {
  const m = Object.create(null);
  for (const c of EXPENSE_CATEGORIES) m[c.key] = c;
  return m;
})();

/**
 * Keys a custom category may never claim: every built-in, plus every legacy key
 * that maps AWAY from itself (see the double-counting note in the header).
 * Identity-mapped legacy keys (`rent`, `marketing`, `software`) stay creatable —
 * seeding itself recreates them.
 */
export const RESERVED_CATEGORY_KEYS = EXPENSE_CATEGORIES.map(c => c.key)
  .concat(Object.keys(LEGACY_CATEGORY_MAP).filter(k => LEGACY_CATEGORY_MAP[k] !== k));

const _RESERVED = new Set(RESERVED_CATEGORY_KEYS);

/** Underscore slug for a category key ('Team Lunch!' → 'team_lunch'); null if nothing survives. */
export function slugifyCategoryKey(label) {
  const key = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return key || null;
}

const isValidKey = (k) => typeof k === 'string' && k !== '' && slugifyCategoryKey(k) === k;

/** 'team_lunch' → 'Team lunch' — the label of last resort when seeding an unknown key. */
function prettifyKey(key) {
  const s = String(key || '').replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * Coerce whatever came back from admin_ui_prefs into a safe custom-category
 * array. The prefs blob is shared with other features and could hold anything,
 * so never trust it: drop junk entries, reserved keys, and duplicates; trim and
 * cap labels; cap the count. `gstDefault` is only carried when explicitly false
 * (true is the default).
 */
export function normalizeCustomCategoryList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (out.length >= MAX_CUSTOM_CATEGORIES) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.label !== 'string' || !entry.label.trim()) continue;
    const label = entry.label.trim().slice(0, MAX_CATEGORY_LABEL);
    const key = isValidKey(entry.key) ? entry.key : slugifyCategoryKey(label);
    if (!key || seen.has(key) || _RESERVED.has(key)) continue;
    seen.add(key);
    const item = { key, label };
    if (entry.gstDefault === false) item.gstDefault = false;
    out.push(item);
  }
  return out;
}

/**
 * Coerce the raw override map from admin_ui_prefs into `{ id: customKey }`.
 * Same distrust as normalizeCustomCategoryList: junk, reserved keys, and
 * malformed slugs are dropped.
 */
export function normalizeCategoryOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const id of Object.keys(raw)) {
    const key = raw[id];
    if (!id || typeof key !== 'string' || !isValidKey(key) || _RESERVED.has(key)) continue;
    out[id] = key;
  }
  return out;
}

/**
 * Resolve a stored row's category through the override map: only an 'other'
 * row can carry an override (that's the value custom saves ride on). Returns
 * the RAW key — callers still normalizeCategory() it, which safely collapses
 * an override whose category has since been deleted.
 */
export function resolveRowCategory(rawCategory, id, overrides) {
  const k = String(rawCategory == null ? '' : rawCategory).trim();
  if (k === 'other' && id != null && overrides) {
    const ov = overrides[String(id)];
    if (ov) return ov;
  }
  return rawCategory;
}

// ── the runtime registry: built-ins + the owner's loaded list ────────────────
let _custom = [];

/**
 * Load the owner's categories into the registry (call before any expense is
 * enriched/rendered). Input is re-normalised — callers can hand the raw prefs
 * value straight in. Returns the normalised list that was installed.
 */
export function setCustomCategories(list) {
  _custom = normalizeCustomCategoryList(list);
  return _custom.slice();
}

/** The owner's categories currently loaded into the registry (copy). */
export function customCategories() {
  return _custom.slice();
}

function customByKey(key) {
  for (const c of _custom) if (c.key === key) return c;
  return null;
}

/** Present a custom entry with the same shape as a built-in category. */
function customAsCategory(c) {
  return { key: c.key, label: c.label, kind: 'operating', gstDefault: c.gstDefault !== false, deductibleDefault: true };
}

/** Canonicalise a possibly-legacy category key to a current (built-in or custom) one. */
export function normalizeCategory(key) {
  if (!key) return 'other';
  const k = String(key).trim();
  if (_BY_KEY[k] || customByKey(k)) return k;
  const mapped = LEGACY_CATEGORY_MAP[k];
  if (mapped && (_BY_KEY[mapped] || customByKey(mapped))) return mapped;
  return 'other';
}

/** Full category object for a key (legacy-normalised). Always returns an object. */
export function categoryByKey(key) {
  const k = normalizeCategory(key);
  if (_BY_KEY[k]) return _BY_KEY[k];
  const c = customByKey(k);
  if (c) return customAsCategory(c);
  return { key: 'other', label: 'Other', kind: 'operating', gstDefault: false, deductibleDefault: true };
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

/** The owner's categories (as full category objects) + the built-in Other, last. */
export function operatingCategories() {
  return _custom.map(customAsCategory).concat([_BY_KEY.other]);
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

// ── pure mutation helpers (the page owns persistence) ───────────────────────

/**
 * Add a category by label. Returns { list, key } with a NEW array (never
 * mutates). Throws with a user-facing message on empty/too-long label,
 * reserved key, duplicate, or the cap.
 */
export function addCustomCategory(list, label) {
  const arr = Array.isArray(list) ? list : [];
  const clean = String(label || '').trim();
  if (!clean) throw new Error('Give the category a name.');
  if (clean.length > MAX_CATEGORY_LABEL) throw new Error(`Keep the name under ${MAX_CATEGORY_LABEL} characters.`);
  const key = slugifyCategoryKey(clean);
  if (!key) throw new Error('Use letters or numbers in the name.');
  if (_RESERVED.has(key)) throw new Error(`"${clean}" is a built-in category.`);
  if (arr.some(c => c.key === key || String(c.label).trim().toLowerCase() === clean.toLowerCase())) {
    throw new Error('That category already exists.');
  }
  if (arr.length >= MAX_CUSTOM_CATEGORIES) {
    throw new Error(`You can have up to ${MAX_CUSTOM_CATEGORIES} categories. Delete one first.`);
  }
  return { list: arr.concat([{ key, label: clean }]), key };
}

/**
 * Rename a category. THE KEY NEVER CHANGES — saved expenses store the key, so a
 * rename is display-only and every historical row picks the new label up for
 * free. Returns a NEW array.
 */
export function renameCustomCategory(list, key, label) {
  const arr = Array.isArray(list) ? list : [];
  const clean = String(label || '').trim();
  if (!clean) throw new Error('Give the category a name.');
  if (clean.length > MAX_CATEGORY_LABEL) throw new Error(`Keep the name under ${MAX_CATEGORY_LABEL} characters.`);
  const idx = arr.findIndex(c => c.key === key);
  if (idx < 0) throw new Error('That category no longer exists.');
  if (arr.some((c, i) => i !== idx && String(c.label).trim().toLowerCase() === clean.toLowerCase())) {
    throw new Error('Another category already has that name.');
  }
  return arr.map((c, i) => (i === idx ? { ...c, label: clean } : c));
}

/** Remove a category by key. Returns a NEW array. (The page blocks removal while in use.) */
export function removeCustomCategory(list, key) {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter(c => c && c.key !== key);
}

/**
 * Self-heal: adopt every category key present on saved rows that the registry
 * doesn't know — a retired built-in, or a custom created on another device —
 * so the row keeps a real label instead of collapsing to "Other". Legacy keys
 * are mapped first (`salaries` seeds `wages`; `cogs` hits the built-in
 * `inventory` and seeds nothing). Idempotent, and it NEVER throws (a seed
 * failure must not break page load): malformed keys are skipped and the cap is
 * respected silently.
 *
 * Safe to run on every load: the page only allows deleting an UNUSED category,
 * so seeding can never resurrect a deliberate deletion.
 */
export function seedMissingCategories(list, rawRows) {
  const arr = Array.isArray(list) ? list : [];
  const known = new Set(EXPENSE_CATEGORIES.map(c => c.key));
  for (const c of arr) known.add(c.key);
  const added = [];
  for (const row of (Array.isArray(rawRows) ? rawRows : [])) {
    if (arr.length + added.length >= MAX_CUSTOM_CATEGORIES) break;
    let k = String((row && row.category) || '').trim();
    if (!k) continue;
    if (!known.has(k) && LEGACY_CATEGORY_MAP[k]) k = LEGACY_CATEGORY_MAP[k];
    if (known.has(k)) continue;
    if (!isValidKey(k) || _RESERVED.has(k)) continue;
    const retired = RETIRED_CATEGORY_DEFAULTS[k];
    const item = { key: k, label: retired ? retired.label : prettifyKey(k) };
    if (retired && retired.gstDefault === false) item.gstDefault = false;
    added.push(item);
    known.add(k);
  }
  return { list: arr.concat(added), added };
}

// Expose on window for any non-module admin consumer (mirrors ProductColors etc.).
// The bare-import page path uses the ESM exports above; this is a belt-and-braces
// fallback and is a no-op under the test sandbox (no window).
try {
  if (typeof window !== 'undefined') {
    window.ExpenseCategories = {
      EXPENSE_CATEGORIES, RETIRED_CATEGORY_DEFAULTS, LEGACY_CATEGORY_MAP,
      CUSTOM_CATEGORIES_KEY, CATEGORY_OVERRIDES_KEY, MAX_CUSTOM_CATEGORIES, MAX_CATEGORY_LABEL, RESERVED_CATEGORY_KEYS,
      normalizeCategory, categoryByKey, categoryLabel, isOrderLinked, categoryKind,
      operatingCategories, orderLinkedCategories, orderLinkedKeys, gstDefaultFor,
      slugifyCategoryKey, normalizeCustomCategoryList, setCustomCategories, customCategories,
      addCustomCategory, renameCustomCategory, removeCustomCategory, seedMissingCategories,
      normalizeCategoryOverrides, resolveRowCategory,
    };
  }
} catch (_) { /* non-fatal */ }
