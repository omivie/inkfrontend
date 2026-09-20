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

/**
 * The one sentinel. Every synthetic term this repo sends starts with it.
 *
 * WHAT THE BACKEND ACTUALLY FILTERS, as of 2026-09-16 — wider than we asked for,
 * and the difference matters. We asked for `query NOT LIKE 'zzprobe%'`, which
 * would have caught 20 rows of 86. They widened it to `zz%` plus three named
 * terms after measuring what was really in there:
 *
 *   zzprobe_edgecache · zzq1789008040 · zzqqxnonexistent · zzqxwvqwerty12345
 *   zzz_no_results_<ts> · zzznotreal            ← both sides have fired zz* since April
 *   warm · ping · healthcheck                   ← cache warmers, not queries at all
 *
 * `zz` is safe as a marker because `products`, `printer_models` and `brands`
 * contain ZERO rows starting with `zz` — they checked, rather than assuming.
 *
 * ⚠️ `test` IS DELIBERATELY NOT FILTERED, AND MUST NEVER BE PROPOSED AGAIN. A
 * human can type it, and a filter that guesses wrong there deletes real demand
 * from the one list that answers "what is the catalogue missing". The same
 * argument forbids sentinelling any term whose RESULTS are the measurement.
 *
 * The largest single polluter was not a `zz` string at all: `warm`, 21 rows, 0
 * sessions, always 0 results, 17 of them sharing an IP with a `zz%` prober. That
 * was OUR cache warm-up in probe-data-capture.mjs, which looked organic for
 * months and sat at #1 in the live zero-result top-15. It now carries the
 * sentinel. Cost of the whole pollution, measured live over 7 days: the
 * zero-result rate read 16.91% and was actually 14.12%, and SIX of the top
 * fifteen zero-result terms were ours.
 */
export const PROBE_QUERY_PREFIX = 'zzprobe_';

/**
 * The backend's exclusion rule, recorded so the next reader does not have to
 * find the email — and NOT re-implemented as a gate.
 *
 * ***THIS IS DOCUMENTATION, NOT A PREDICATE.*** ERR-231 is this repo's record of
 * a probe that certified a REPLICA of the escaper it was supposed to be checking:
 * the copy passed while the real thing was broken. A local re-implementation of
 * somebody else's SQL can only ever agree with itself. What we can honestly
 * assert is a fact about OUR OWN strings — that every synthetic term we emit
 * starts with `zz` — and that is what `probeQuery()` guarantees below and what
 * tests/probe-search-analytics-honesty-sep2026.test.js pins.
 */
export const EXCLUDED_BY_BACKEND = Object.freeze({
    prefix: 'zz',
    terms: Object.freeze(['warm', 'ping', 'healthcheck']),
    notFiltered: Object.freeze(['test']),
    since: '2026-09-16',
});

/**
 * Stamp a SYNTHETIC search term so the row it creates is greppable and
 * excludable. Never use this on a term whose results are being measured — a
 * prefixed "lc3319" is not a search for lc3319.
 *
 * Throws rather than returns a bad term: a sentinel that silently fails to
 * apply is indistinguishable from organic traffic, which is the whole defect.
 */
export function probeQuery(term) {
  const t = String(term == null ? '' : term);
  const out = t.startsWith(PROBE_QUERY_PREFIX) ? t : PROBE_QUERY_PREFIX + t;
  // The invariant the backend's `zz%` rule depends on, asserted at the one place
  // that can guarantee it. Cheap, and it cannot be true "most of the time".
  if (!out.startsWith(EXCLUDED_BY_BACKEND.prefix)) {
    throw new Error(
      `probeQuery produced "${out}", which does not start with ` +
      `"${EXCLUDED_BY_BACKEND.prefix}" — the backend would count it as a real shopper search.`
    );
  }
  return out;
}

/**
 * The line every /api/search/* probe prints under its MODE banner. Two
 * sentences, because the second one is the part people do not know.
 */
export const SEARCH_ANALYTICS_NOTICE =
  '\x1b[33mNOTE:\x1b[0m every GET to /api/search/* writes a `search_analytics` row server-side '
  + '(ERR-254).\n      Synthetic terms here are prefixed `' + PROBE_QUERY_PREFIX + '`, which the backend '
  + 'excludes from its\n      aggregates (`zz%` + warm/ping/healthcheck, live since '
  + EXCLUDED_BY_BACKEND.since + '). Real product\n      terms CANNOT be prefixed without measuring '
  + 'something else, so those rows stay\n      indistinguishable from organic and land in the live '
  + 'top-search-terms list.';

/** Convenience: print the notice. Kept so the wording has exactly one owner. */
export function printSearchAnalyticsNotice(log = console.log) {
  log(SEARCH_ANALYTICS_NOTICE);
}
