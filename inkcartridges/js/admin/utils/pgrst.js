/**
 * Escaping values that cross into a PostgREST filter (ERR-202).
 *
 * The admin SPA reaches Supabase directly for three searches — the Products
 * list, the ribbon-products list and the printer picker — so the backend's
 * Sep-2026 search escaper never sees them. Each built its filter by
 * interpolating the operator's raw text:
 *
 *     query.or(`name.ilike.%${_search}%,sku.ilike.%${_search}%`)
 *
 * `.or()` is a comma/paren-delimited expression, so the operator's punctuation
 * is read as SYNTAX. Measured live against PostgREST with an admin JWT:
 *
 *     "TN251"                 → 200, the right rows
 *     "Smith, Ltd"            → 400  PGRST100 "failed to parse logic tree"
 *     "Acme (NZ)"             → 200 but []  — parens are literal to ilike
 *     "x,is_active.eq.false"  → 400  invalid input syntax for boolean "false%"
 *
 * A comma or a bracket is not an attack, it is a Tuesday: company names carry
 * them ("Acme (NZ) Limited"), and so do our own product titles — the page-yield
 * suffix is literally "(2,500 pages)". So every one of those searches was
 * either erroring or silently returning nothing.
 *
 * ── WHY QUOTING, NOT STRIPPING ──────────────────────────────────────────────
 *
 * The obvious fix is to delete the offending characters, and this repo already
 * has that shape in `sbSafe` (components/product-search.js). Deleting them is
 * safe but lossy: it answers a different question than the one the operator
 * asked, and "(2,500 pages)" degrades to a search for "2 500 pages".
 *
 * PostgREST accepts a DOUBLE-QUOTED value, inside which `,` `(` `)` `.` carry
 * no syntactic weight. Verified live, same session as the failures above:
 *
 *     name.ilike."%Black (2,500 pages)%"   → 200, the two real products
 *     name.ilike."%x,is_active.eq.false%"  → 200, [] — inert literal text
 *     name.ilike."%quote\" inject%"        → 200, [] — no break-out
 *
 * So the value is preserved AND the injection is closed. Searching
 * "(2,500 pages)" now works where it used to return a 400.
 *
 * Only `"` and `\` can terminate a quoted value, so only those are escaped.
 *
 * `%` and `_` are deliberately NOT escaped: they remain ilike wildcards, which
 * is what they already were here and is reasonable in a free-text search box.
 * That is a decision, not an oversight — the one place it would be wrong is an
 * EXACT lookup, and `resolveSkus` already avoids ilike entirely for that reason
 * (see its header). If you ever need a literal `%`, add a `pgrstLikeExact` that
 * escapes them with an explicit ESCAPE clause; do not change these two.
 *
 * ── THE THIRD WILDCARD: `*` (ERR-231) ───────────────────────────────────────
 *
 * There is a third wildcard, it was never a decision, and quoting cannot close
 * it. PostgREST rewrites `*` into the SQL `%` INSIDE every `ilike` filter,
 * before the value is parsed, unconditionally and with no escape sequence — so
 * the double quotes above, which do neutralise `,` `(` `)` `.`, do nothing here.
 * Measured live against our own products table:
 *
 *     name.ilike."%TN2*BK%"  → GTN2130BK, CTN2345BK, CTN240BK
 *     name.ilike."%TN2%BK%"  → GTN2130BK, CTN2345BK, CTN240BK   ← identical
 *
 * So `*` is stripped in `pgrstLike` below, and this is the ONE case where round
 * 1's "quote, never strip" rule cannot apply. That rule earned its place because
 * quoting *preserves* the operator's text — "(2,500 pages)" stays searchable.
 * Nothing preserves `*`. The only choice is between an undocumented wildcard the
 * operator never asked for and agreeing with the backend, which strips `*` from
 * `/api/search/*` for exactly the same reason (their round-2 hand-off, §4).
 * Agreement is the invariant this repo keeps re-learning the hard way — ERR-176
 * and ERR-202 are both "the two halves disagreed about punctuation".
 *
 * Strip it in `pgrstLike`, NOT in `pgrstValue`: `*` is only special to the
 * pattern operators. `pgrstValue` also backs `.eq` / `.in`, where a stripped `*`
 * would corrupt an exact lookup on a SKU that legitimately contains one.
 *
 * ── STALENESS WARNING ───────────────────────────────────────────────────────
 *
 * `js/admin/utils/*.js` are imported BARE — `APP_VERSION` cannot bust a util,
 * so a stale copy of this module looks exactly like a broken fix. If an escaped
 * search still 400s after a deploy, hard-reload before you debug the escaper.
 */

/**
 * One value inside a PostgREST filter expression, quoted so that punctuation
 * is data rather than syntax. Returns the quotes as part of the string.
 */
export function pgrstValue(s) {
  return `"${String(s ?? '').replace(/["\\]/g, (m) => '\\' + m)}"`;
}

/**
 * A `%term%` substring pattern for `ilike`, quoted. Use everywhere an operator's
 * free text reaches a `.or()` / `.ilike()` filter:
 *
 *     query.or(`name.ilike.${pgrstLike(q)},sku.ilike.${pgrstLike(q)}`)
 */
export function pgrstLike(s) {
  // `*` is removed, not escaped — PostgREST turns it into `%` inside ilike and
  // offers no way to say "I meant a literal asterisk". See the header (ERR-231).
  return pgrstValue(`%${String(s ?? '').replace(/\*/g, '')}%`);
}

/**
 * Fold PostgREST's delimiters to spaces and collapse the run.
 *
 * NOT an escaper — never use it to build a filter, use pgrstLike for that.
 * This is for the LOCAL half of a search that also runs remotely, so that both
 * halves agree on what a token is. party-search.js compares the rows a remote
 * search returned against the operator's raw string; if one side treats
 * "Walker," as a token and the other never had the comma, every returned row is
 * discarded and the picker reports "no match" for a customer that exists
 * (ERR-176's failure mode, re-entered through a different door).
 *
 * THE SET HERE MIRRORS WHAT THE REMOTE HALF DROPS, and `*` joined it in Sep
 * 2026 (ERR-231) — the backend added `*` to its search escaper because PostgREST
 * expands it to `%`, and `pgrstLike` strips it for the direct-to-Supabase
 * searches the backend never sees. If this fold kept `*`, `queryTokens('TN*251')`
 * would yield the token "tn*251", which cannot match any row the remote query
 * returns — ERR-176 again, one character further along.
 *
 * `*` is DELETED; `, ( )` are folded to a SPACE. That asymmetry is deliberate
 * and it is measured, not guessed. Against the live API, `TN2*130` and `TN2,130`
 * both return GTN2130BK while `TN2 130` returns nothing — the backend deletes
 * all three rather than spacing them. For `, ( )` the space is nonetheless the
 * right local behaviour, because they nearly always sit next to one ("Walker,
 * Vieland", "Acme (NZ)") so deleting or spacing gives the same tokens, and the
 * space additionally rescues the no-space case. `*` has no such convention: it
 * appears mid-token or not at all. And this fold is applied to the HAYSTACK as
 * well as the query (see matchesAllTokens), so spacing `*` would fold a stored
 * "TN*251" to "tn 251" and stop it matching the query "TN251" that the remote
 * leg just used to fetch it. Delete, don't space.
 */
export function foldFilterPunct(s) {
  return String(s ?? '')
    .replace(/\*/g, '')
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
