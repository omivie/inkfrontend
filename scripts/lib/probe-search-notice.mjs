/**
 * probe-search-notice — a probe that reads /api/search/* is a WRITER (ERR-254)
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Nine scripts in this directory GET `/api/search/*`, and most of them print a
 * banner saying some version of "MODE: READ-ONLY — nothing is written". That
 * claim is true of this repository and FALSE of the backend's database.
 *
 * `logSearchAnalytics()` writes a `search_analytics` row on every one of those
 * GETs, fire-and-forget, server-side. So a probe run is indistinguishable from
 * a shopper searching, and the rows persist.
 *
 * MEASURED 2026-09-12, in production, from the admin analytics endpoint: the
 * live top-search-terms list for the last 7 days contained
 *
 *     zzqqxnotaproduct9987     6 occurrences
 *
 * which is the zero-result control query in probe-search-value-pack-ranking.mjs
 * line 261. Six of the site's "searches" that week were ours. Nothing warned
 * anyone, because every banner said the script could not write.
 *
 * This is the house's own failure shape, one layer out: the repo already knows
 * that "a probe that records may be green because it has just overwritten the
 * thing it was comparing against" (sweep:b2b ate a committed fixture,
 * 2026-08-12). This is that, except the thing being overwritten is the evidence
 * we cite back to the backend — and we cited it: ERR-237 was argued on
 * `search_analytics` row counts.
 *
 * THE TWO KINDS OF QUERY, AND WHY ONLY ONE CAN BE FIXED
 * -----------------------------------------------------
 *   SYNTHETIC — a control term chosen to match nothing ("does a zero-result
 *   query take the rescue ladder?"). Its text is arbitrary, so it can carry a
 *   sentinel and the backend can exclude it with one `query NOT LIKE 'zzprobe%'`.
 *   Use `probeQuery()`.
 *
 *   REAL — an actual product term ("lc3319", "tn2130") whose results are the
 *   thing being measured. It CANNOT be prefixed without measuring something
 *   else, so these rows stay in the dataset looking exactly like organic
 *   traffic. There is no fix for that on our side; the only honest response is
 *   to say so in the banner, which is what `SEARCH_ANALYTICS_NOTICE` does.
 *
 * A probe that declines to mention this is not more read-only for staying quiet.
 */

/** The one sentinel. Backend excludes with `query NOT LIKE 'zzprobe%'`. */
export const PROBE_QUERY_PREFIX = 'zzprobe_';

/**
 * Stamp a SYNTHETIC search term so the row it creates is greppable and
 * excludable. Never use this on a term whose results are being measured — a
 * prefixed "lc3319" is not a search for lc3319.
 */
export function probeQuery(term) {
  const t = String(term == null ? '' : term);
  return t.startsWith(PROBE_QUERY_PREFIX) ? t : PROBE_QUERY_PREFIX + t;
}

/**
 * The line every /api/search/* probe prints under its MODE banner. Two
 * sentences, because the second one is the part people do not know.
 */
export const SEARCH_ANALYTICS_NOTICE =
  '\x1b[33mNOTE:\x1b[0m every GET to /api/search/* writes a `search_analytics` row server-side '
  + '(ERR-254).\n      Synthetic terms here are prefixed `' + PROBE_QUERY_PREFIX + '` so the backend '
  + 'can exclude them; real\n      product terms cannot be, and land in the live top-search-terms list.';

/** Convenience: print the notice. Kept so the wording has exactly one owner. */
export function printSearchAnalyticsNotice(log = console.log) {
  log(SEARCH_ANALYTICS_NOTICE);
}
