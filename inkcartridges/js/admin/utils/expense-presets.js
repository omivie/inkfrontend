/**
 * expense-presets.js — saved, reusable expense templates ("presets")
 * ==================================================================
 *
 * A preset is a NAMED SNAPSHOT of the Add-expense form that can be re-applied in
 * one click ("Netflix subscription", "Power bill", "Warehouse rent"). It is a UI
 * convenience, NOT a financial record — no preset ever becomes an expense until
 * the operator hits Save on the drawer.
 *
 * DATES ARE NEVER STORED (owner's call). A preset carries the shape of a spend —
 * name, category, payee, amount, GST treatment, method, reference, notes and the
 * full recurrence RULE — but not `expense_date`, `due_date`, `paid_date` or
 * `recurrence_end` (also a date). On load the expense date resets to today. This
 * makes it impossible to silently re-date an old bill by re-using its preset, which
 * on a cash-basis P&L would land real money in the wrong month.
 * `recurrence_count` IS kept — it's a count, not a date.
 *
 * PERSISTENCE lives in the real database, not the browser: the page stores the list
 * under the `expenses.presets` key of `admin_ui_prefs` (a per-admin Supabase KV
 * table, RLS-locked to auth.uid()) via AdminAPI.getUiPrefs()/setUiPref(). This
 * module stays pure — it only shapes the data; the page owns the I/O.
 *
 * Import-free + side-effect-free → unit-tested in a bare vm sandbox.
 *
 * Run with: node --test tests/admin-expenses-presets.test.js
 */

'use strict';

/** The admin_ui_prefs key the preset list is stored under. */
export const PRESET_KEY = 'expenses.presets';

/** Hard cap — presets are a shortcut list, not a filing cabinet. */
export const MAX_PRESETS = 20;

export const MAX_PRESET_NAME = 40;

/**
 * The allowlist of form fields a preset captures. Deliberately EXCLUDES every date
 * (`expense_date`, `due_date`, `paid_date`, `recurrence_end`) and every identity /
 * status field (`id`, `status`, `series_state`) — a preset describes a KIND of
 * spend, not a specific one.
 */
export const PRESET_FIELDS = [
  'name', 'category', 'payee', 'amount', 'gst_claimable',
  'method', 'reference', 'notes',
  'recurrence',
  'recurrence_day_of_week', 'recurrence_day_of_month',
  'recurrence_month', 'recurrence_interval_days', 'recurrence_count',
];

/** Fields a preset must never carry, even if a caller hands them in. */
export const PRESET_BLOCKED_FIELDS = [
  'expense_date', 'date', 'due_date', 'paid_date', 'recurrence_end',
  'id', 'status', 'series_state', 'paid',
];

function slugId(name, seed = 0) {
  const base = String(name || 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  return seed ? `${base}-${seed}` : base;
}

/**
 * Build a preset from a collected form payload (the output of the page's
 * `collectPayload()`), keeping only the allowlisted fields. Undefined/empty values
 * are dropped so a preset stays a sparse patch over the default draft.
 */
export function toPreset(payload, name) {
  const fields = {};
  for (const k of PRESET_FIELDS) {
    const v = payload ? payload[k] : undefined;
    if (v === undefined || v === null || v === '') continue;
    if (Number.isNaN(v)) continue;
    fields[k] = v;
  }
  const clean = String(name || '').trim().slice(0, MAX_PRESET_NAME);
  return { id: slugId(clean), name: clean, fields };
}

/**
 * Turn a preset back into a partial draft the editor can spread over `freshDraft()`.
 * Blocked (date/identity) fields are stripped defensively — even if a malformed
 * preset somehow carries one, it can never re-date an expense.
 */
export function applyPresetToDraft(preset) {
  const src = (preset && preset.fields) ? preset.fields : {};
  const out = {};
  for (const k of PRESET_FIELDS) {
    if (src[k] === undefined) continue;
    out[k] = src[k];
  }
  for (const k of PRESET_BLOCKED_FIELDS) delete out[k];
  // A preset with no recurrence is a one-off.
  if (!out.recurrence) out.recurrence = 'none';
  return out;
}

/**
 * Insert or replace a preset by NAME (case-insensitive), preserving list order for
 * an overwrite and appending otherwise. Returns a NEW array (never mutates).
 * Throws when the cap would be exceeded by a genuinely new preset.
 */
export function upsertPreset(list, preset) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!preset || !preset.name) throw new Error('Preset needs a name.');
  const key = preset.name.trim().toLowerCase();
  const idx = arr.findIndex(p => String(p?.name || '').trim().toLowerCase() === key);
  if (idx >= 0) {
    arr[idx] = { ...preset, id: arr[idx].id || preset.id };
    return arr;
  }
  if (arr.length >= MAX_PRESETS) {
    throw new Error(`You can save up to ${MAX_PRESETS} presets. Delete one first.`);
  }
  // Keep ids unique even when two names slugify the same.
  let id = preset.id, n = 1;
  while (arr.some(p => p?.id === id)) id = slugId(preset.name, ++n);
  arr.push({ ...preset, id });
  return arr;
}

/** Remove a preset by id. Returns a NEW array. */
export function removePreset(list, id) {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter(p => p && p.id !== id);
}

/** Does a preset with this name already exist? (case-insensitive) */
export function presetNameExists(list, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  return (Array.isArray(list) ? list : [])
    .some(p => String(p?.name || '').trim().toLowerCase() === key);
}

/**
 * Coerce whatever came back from admin_ui_prefs into a safe preset array. The prefs
 * blob is shared with other features and could hold anything, so never trust it.
 */
export function normalizePresetList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
    .slice(0, MAX_PRESETS)
    .map((p, i) => ({
      id: typeof p.id === 'string' && p.id ? p.id : slugId(p.name, i),
      name: p.name.trim().slice(0, MAX_PRESET_NAME),
      fields: (p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields)) ? p.fields : {},
    }));
}

/**
 * A preset is a template, so it does NOT have to be a valid expense (no amount is
 * fine for a variable bill). Only a name is truly required — hence this is much
 * looser than the editor's validatePayload().
 */
export function validatePreset(name, list, { allowOverwrite = false } = {}) {
  const n = String(name || '').trim();
  if (!n) return 'Give the preset a name.';
  if (n.length > MAX_PRESET_NAME) return `Keep the name under ${MAX_PRESET_NAME} characters.`;
  if (!allowOverwrite && presetNameExists(list, n)) return 'A preset with that name already exists.';
  if (!allowOverwrite && !presetNameExists(list, n) && (Array.isArray(list) ? list.length : 0) >= MAX_PRESETS) {
    return `You can save up to ${MAX_PRESETS} presets. Delete one first.`;
  }
  return null;
}

try {
  if (typeof window !== 'undefined') {
    window.ExpensePresets = {
      PRESET_KEY, MAX_PRESETS, MAX_PRESET_NAME, PRESET_FIELDS, PRESET_BLOCKED_FIELDS,
      toPreset, applyPresetToDraft, upsertPreset, removePreset,
      presetNameExists, normalizePresetList, validatePreset,
    };
  }
} catch (_) { /* non-fatal */ }
