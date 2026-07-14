/**
 * expense-recurrence.js — expand a recurring-expense template into occurrences
 * ===========================================================================
 *
 * A repeating expense is stored ONCE as a template carrying a recurrence rule.
 * Future occurrences are NEVER inserted into the database indefinitely — they
 * are PROJECTED here, on demand, bounded to a requested window. Only occurrences
 * the operator actually acts on (marks paid / edits / skips) get materialised
 * server-side; those override the projection for the same (series, date).
 *
 * Everything is computed in UTC to keep occurrence dates stable regardless of
 * the viewer's timezone (a monthly-on-the-1st bill must not drift to the 31st
 * of the previous month for a UTC+13 user).
 *
 * Recurrence rule fields on a template:
 *   recurrence               'none'|'weekly'|'fortnightly'|'monthly'|'quarterly'|'yearly'|'custom'
 *   recurrence_day_of_week   0(Sun)-6(Sat)   — weekly / fortnightly
 *   recurrence_day_of_month  1-31            — monthly / quarterly / yearly (month-end clamped)
 *   recurrence_month         1-12            — yearly
 *   recurrence_interval_days >=1             — custom
 *   recurrence_end           'YYYY-MM-DD'    — optional inclusive end date
 *   recurrence_count         >=1             — optional "end after N occurrences"
 * Start date: expense_date | date | start_date.
 *
 * Month-end rule (explicit + consistent): a monthly/quarterly/yearly expense
 * scheduled for day 31 fires on the LAST valid day of shorter months
 * (Feb 28/29, Apr 30, …). Feb 29 yearly rules clamp to Feb 28 in non-leap years.
 *
 * Import-free + side-effect-free so it unit-tests in a bare vm sandbox.
 *
 * Run with: node --test tests/admin-expenses-recurrence.test.js
 */

'use strict';

export const MS_DAY = 86400000;

export const RECURRENCE_TYPES = ['none', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly', 'custom'];

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Iteration backstop — no legitimate windowed projection needs more fires than
// this, but it guarantees a malformed rule can never spin forever.
const HARD_ITER_CAP = 6000;

/** Parse 'YYYY-MM-DD' (or an ISO datetime) to UTC-midnight ms. NaN if invalid. */
export function parseUtcDate(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return value;
  const s = String(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : NaN;
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC-midnight ms → 'YYYY-MM-DD'. */
export function isoFromMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Days in a given month (0-indexed month), leap-year aware, via UTC. */
export function daysInMonth(year, monthIdx0) {
  return new Date(Date.UTC(year, monthIdx0 + 1, 0)).getUTCDate();
}

/** Clamp a requested day-of-month to the last valid day of that month. */
export function clampDom(dom, year, monthIdx0) {
  return Math.min(dom, daysInMonth(year, monthIdx0));
}

function startMsOf(template) {
  return parseUtcDate(template.expense_date ?? template.date ?? template.start_date);
}

function intField(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}

/**
 * Generate ordered fire-date ms values for a template, from the series start up
 * to `horizonMs` (inclusive), honouring recurrence_end and recurrence_count.
 * Occurrences are counted from the SERIES START (not the window) so
 * recurrence_count and end-of-series are correct regardless of the window asked
 * for. Returns [{ ms, index }].
 */
export function generateFires(template, horizonMs) {
  const startMs = startMsOf(template);
  if (!Number.isFinite(startMs)) return [];

  const type = RECURRENCE_TYPES.includes(template.recurrence) ? template.recurrence : 'none';
  const endMs = parseUtcDate(template.recurrence_end);
  const maxCount = intField(template.recurrence_count);
  const hardEnd = Math.min(
    Number.isFinite(horizonMs) ? horizonMs : Infinity,
    Number.isFinite(endMs) ? endMs : Infinity
  );

  const out = [];
  const push = (ms, index) => { out.push({ ms, index }); };
  const withinCount = (index) => (maxCount == null || index < maxCount);

  // One-off (or unknown) → single occurrence at the start date.
  if (type === 'none') {
    if (startMs <= hardEnd && withinCount(0)) push(startMs, 0);
    return out;
  }

  if (type === 'weekly' || type === 'fortnightly') {
    const step = (type === 'weekly' ? 7 : 14) * MS_DAY;
    const dow = intField(template.recurrence_day_of_week);
    let first = startMs;
    if (dow != null && dow >= 0 && dow <= 6) {
      const shift = (dow - new Date(startMs).getUTCDay() + 7) % 7;
      first = startMs + shift * MS_DAY;
    }
    let i = 0;
    for (let ms = first; ms <= hardEnd && i < HARD_ITER_CAP; ms += step, i++) {
      if (!withinCount(i)) break;
      push(ms, i);
    }
    return out;
  }

  if (type === 'monthly' || type === 'quarterly' || type === 'yearly') {
    const startDate = new Date(startMs);
    const monthStep = type === 'yearly' ? 12 : (type === 'quarterly' ? 3 : 1);
    const targetDom = (() => {
      const d = intField(template.recurrence_day_of_month);
      return (d != null && d >= 1 && d <= 31) ? d : startDate.getUTCDate();
    })();
    // Anchor month/year. Yearly pins the month; the rest start from the start month.
    let year = startDate.getUTCFullYear();
    let monthIdx0 = type === 'yearly'
      ? (() => { const m = intField(template.recurrence_month); return (m != null && m >= 1 && m <= 12) ? m - 1 : startDate.getUTCMonth(); })()
      : startDate.getUTCMonth();

    let index = 0;
    for (let guard = 0; guard < HARD_ITER_CAP; guard++) {
      const day = clampDom(targetDom, year, monthIdx0);
      const ms = Date.UTC(year, monthIdx0, day);
      if (ms >= startMs) {
        if (ms > hardEnd) break;
        if (!withinCount(index)) break;
        push(ms, index);
        index++;
      }
      // Advance by the step.
      monthIdx0 += monthStep;
      while (monthIdx0 > 11) { monthIdx0 -= 12; year++; }
      // Bail once we've marched past the horizon (the first in-range ms may lie
      // before start, so only break on ms once we've begun emitting).
      if (Date.UTC(year, monthIdx0, 1) > hardEnd && index === 0 && Date.UTC(year, monthIdx0, 1) > startMs) break;
    }
    return out;
  }

  if (type === 'custom') {
    const interval = intField(template.recurrence_interval_days);
    if (interval == null || interval < 1) {
      // Malformed custom rule → treat as a single one-off so nothing is lost.
      if (startMs <= hardEnd && withinCount(0)) push(startMs, 0);
      return out;
    }
    const step = interval * MS_DAY;
    let i = 0;
    for (let ms = startMs; ms <= hardEnd && i < HARD_ITER_CAP; ms += step, i++) {
      if (!withinCount(i)) break;
      push(ms, i);
    }
    return out;
  }

  return out;
}

const RECURRENCE_KEYS = [
  'recurrence', 'recurrence_day_of_week', 'recurrence_day_of_month',
  'recurrence_month', 'recurrence_interval_days', 'recurrence_end', 'recurrence_count',
];

/** Build a clean projected-occurrence object (recurrence keys stripped). */
function makeOccurrence(template, fireMs, index) {
  const occ = {};
  for (const k of Object.keys(template)) {
    if (RECURRENCE_KEYS.includes(k)) continue;
    occ[k] = template[k];
  }
  const iso = isoFromMs(fireMs);
  occ.date = iso;
  occ.expense_date = iso;
  occ.due_date = iso;
  occ.projected = true;
  occ.recurring = true;
  occ.paid = false;
  occ.paid_date = null;
  occ.status = undefined; // derived downstream
  occ.series_id = template.id ?? template.series_id ?? null;
  occ.template_id = template.id ?? null;
  occ.occurrence_index = index;
  return occ;
}

/**
 * Expand a recurring template into PROJECTED occurrences whose date falls within
 * [windowStartMs, windowEndMs] (inclusive). A one-off (recurrence 'none') yields
 * at most one occurrence. Never returns unbounded rows — the window caps it.
 *
 * @returns {Array<object>} clean occurrence objects, recurrence keys stripped.
 */
export function expandExpenseOccurrences(template, windowStartMs, windowEndMs) {
  if (!template || typeof template !== 'object') return [];
  const winStart = Number.isFinite(windowStartMs) ? windowStartMs : -Infinity;
  const winEnd = Number.isFinite(windowEndMs) ? windowEndMs : Infinity;
  const fires = generateFires(template, winEnd);
  const out = [];
  for (const { ms, index } of fires) {
    if (ms < winStart) continue;
    out.push(makeOccurrence(template, ms, index));
  }
  return out;
}

/**
 * The FIRST occurrence a template will ever fire, as an ISO date — i.e. where the
 * series really begins once the day-of-week / day-of-month rule is applied.
 *
 * BACKEND PARITY (Jul 2026). The backend anchors every frequency on `expense_date`
 * and does NOT re-anchor on `recurrence_day_of_week` / `_day_of_month` — it stores
 * them for the UI but steps straight from the start date. We DO re-anchor, because
 * that is what the form promises ("Monthly · day 20", "Every Wed"). Left alone the
 * two projectors would drift apart (start Mon 6 Jul + "every Wed" → we say Wed 8th,
 * they say Mon 13th) and a backend-materialised occurrence would never line up with
 * a projected one.
 *
 * The fix is to SNAP the stored `expense_date` to this value on save. Once the start
 * date IS the first occurrence, an `expense_date`-anchored stepping and a
 * dow/dom-anchored stepping produce the IDENTICAL series — so both projectors agree
 * by construction, with no backend change. Pinned by tests.
 *
 * Returns null for a template with no valid start date.
 */
export function firstOccurrence(template) {
  if (!template) return null;
  const startMs = startMsOf(template);
  if (!Number.isFinite(startMs)) return null;
  // A horizon of ~2 years covers the widest gap any rule can open between the
  // typed start and its first real fire (yearly, month pinned 11 months back).
  const fires = generateFires(template, startMs + 800 * MS_DAY);
  return fires.length ? isoFromMs(fires[0].ms) : null;
}

/**
 * The next scheduled fire date on/after `fromMs` (default: caller passes today).
 * Returns an ISO date string, or null if the series has ended before then.
 * Searches a bounded horizon so a paused/ended series can't loop.
 */
export function nextOccurrence(template, fromMs, horizonDays = 800) {
  if (!template) return null;
  const from = Number.isFinite(fromMs) ? fromMs : NaN;
  if (!Number.isFinite(from)) return null;
  const fires = generateFires(template, from + horizonDays * MS_DAY);
  for (const { ms } of fires) {
    if (ms >= from) return isoFromMs(ms);
  }
  return null;
}

/**
 * Derive an occurrence's display status. Stored terminal statuses and a paid
 * date win; otherwise overdue/due/scheduled is derived from the due date vs
 * today so we never store a status that time alone can flip.
 */
export function deriveStatus(occ, todayMs) {
  if (!occ) return 'scheduled';
  const stored = occ.status;
  if (stored === 'cancelled' || stored === 'skipped') return stored;
  if (occ.paid_date || occ.paid === true || stored === 'paid') return 'paid';
  const dueMs = parseUtcDate(occ.due_date ?? occ.date ?? occ.expense_date);
  const today = Number.isFinite(todayMs) ? todayMs : NaN;
  if (!Number.isFinite(dueMs) || !Number.isFinite(today)) return stored || 'scheduled';
  if (dueMs < today) return 'overdue';
  if (dueMs === today) return 'due';
  return 'scheduled';
}

/** Human-readable one-line recurrence summary for a template. */
export function describeRecurrence(t) {
  if (!t) return '';
  const v = t.recurrence;
  if (!v || v === 'none') return 'One-off';
  const end = t.recurrence_end ? ` until ${t.recurrence_end}` : (t.recurrence_count ? ` · ${t.recurrence_count}×` : '');
  switch (v) {
    case 'weekly':      return `Weekly · ${DOW_NAMES[Number(t.recurrence_day_of_week)] || '?'}${end}`;
    case 'fortnightly': return `Fortnightly · ${DOW_NAMES[Number(t.recurrence_day_of_week)] || '?'}${end}`;
    case 'monthly':     return `Monthly · day ${t.recurrence_day_of_month ?? '?'}${end}`;
    case 'quarterly':   return `Quarterly · day ${t.recurrence_day_of_month ?? '?'}${end}`;
    case 'yearly':      return `Yearly · ${MONTH_NAMES[Number(t.recurrence_month) - 1] || '?'} ${t.recurrence_day_of_month ?? '?'}${end}`;
    case 'custom':      return `Every ${t.recurrence_interval_days ?? '?'} days${end}`;
    default:            return 'One-off';
  }
}

/** Is this template a recurring series (vs a one-off)? */
export function isRecurring(t) {
  return !!t && t.recurrence && t.recurrence !== 'none' && RECURRENCE_TYPES.includes(t.recurrence);
}

try {
  if (typeof window !== 'undefined') {
    window.ExpenseRecurrence = {
      MS_DAY, RECURRENCE_TYPES, parseUtcDate, isoFromMs, daysInMonth, clampDom,
      generateFires, expandExpenseOccurrences, firstOccurrence, nextOccurrence,
      deriveStatus, describeRecurrence, isRecurring,
    };
  }
} catch (_) { /* non-fatal */ }
