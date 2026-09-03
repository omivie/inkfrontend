# Analytics dashboards — FE response (Sep 2026)

**Status: all three jobs shipped.** The click-element cap is 200. Catalogue
Engagement is a new owner-only page under Catalog (`#catalog-engagement`);
Acquisition is a new tab in the Finance hub (`#analytics?tab=acquisition`). Both
render live production data — verified in the running admin, not just in tests.

**Your hand-off was unusually good: every endpoint in it was live, authenticated,
and returning real data on the first try.** That is not the norm here — the last
four hand-offs each opened with at least one claim that did not survive
measurement. Six endpoints, six 200s, contract shapes as documented.

Four things below are worth your time. **Two are bugs on your side** (§1 the rate
limiter, §2 `offshore_bounce_views_excluded`). **Two are places the document's
own rendering advice would have produced a wrong screen** (§3 the null-vs-zero
rule, §4 the SEO double-count) — I followed the intent rather than the letter and
want you to know where and why. §5 is what shipped and how to re-check it.

Measured 2026-09-03 against backend commit `6aaf225f`, `db: connected`, signed in
as the owner account.

---

## 1. The rate limiter advertises 30 and enforces 20

Not mentioned in the hand-off, and the headers actively mislead. Reproduced
twice, from a cold window:

```
req #1  → 200   ratelimit-limit: 30   ratelimit-remaining: 29   policy: 30;w=60
req #20 → 200   ratelimit-limit: 30   ratelimit-remaining: 10   policy: 30;w=60
req #21 → 429   ratelimit-limit: 20   retry-after: 44           policy: 20;w=60
```

A client that trusts `ratelimit-remaining` believes it has **ten requests of
headroom** and takes a 429 on the very next one. It looks like two limiters on
the same route — a general admin one at 30 and an analytics one at 20 — with only
the looser one writing the response headers on a 200.

**Ask: make the 200 responses advertise the binding limit.** Until then nothing
here reads `ratelimit-remaining`; both dashboards plan against a hard-coded 20
and fetch sequentially rather than in parallel.

This mattered more than it sounds. Our shared analytics helper
(`analyticsHttpGet`) returns `null` for *every* failure — 401, 403, 500, abort and
429 alike — and `null` renders as an empty table. A rate-limited Catalogue
Engagement would have said **"no products were viewed"**. Both new surfaces use a
new discriminated sibling that reports `{ rateLimited, retryAfter }` and renders a
named *"Analytics is rate-limited — retrying in Ns"* state with a live countdown
from your `retry-after`. An outage is never allowed to look like a measurement.

## 2. `offshore_bounce_views_excluded` does not "report the count either way"

Your §"Scraper filter" says it does. Measured:

| request | rows | `offshore_bounce_views_excluded` |
|---|---|---|
| `/catalog/products` | 259 | **8** |
| `/catalog/products?include_offshore_bounces=true` | 267 | **0** |
| `/catalog/brands` | 18 | **key absent entirely** |

The middle row is the problem: the count drops to 0 exactly when the eight views
are *included*. So `0` there means "nothing was filtered from this response",
which is true and useless — it is not the size of what the filter normally
removes, and printing "0 excluded" beside an unfiltered table tells the operator
the filter finds nothing.

Three distinct states, so the UI has three sentences:

- filtered + reported → *"Scraper filter on: 8 offshore single-page views
  removed. All New Zealand traffic is kept."*
- filter off → *"Scraper filter OFF — these are unfiltered totals… the backend
  does not report how many that adds while the filter is off, so the difference
  is not shown."*
- brands → *"Scraper filter status not reported on this endpoint — the count of
  excluded offshore views is unknown, not zero."*

**Two asks:** report the *would-have-been-excluded* count while unfiltered, and
add the key to `/catalog/brands`. Both are one-liners on your side and both
remove a sentence we currently have to apologise with.

For the record, we did surface the filter prominently, as you asked, and the
reasoning in your document is why it survived review rather than being "fixed" by
someone. It reads as a deliberate choice on screen, not a mystery.

## 3. The null-vs-zero rule is false on `/acquisition/search-terms`

> "`null` = that source isn't connected. `0` = connected and genuinely zero."

True on `/landing-pages`: `ads_clicks`, `ads_impressions`, `ads_cost` and
`ads_conversions` are `null` on all 174 rows. **The opposite is true one endpoint
over.** With `meta.sources.google_ads.connected === false` — the same unconnected
integration —

```
/acquisition/search-terms?limit=500
   500 of 500 rows:  paid_clicks: 0,  paid_impressions: 0,  paid_cost: 0
     0 of 500 rows:  null
```

Follow the stated rule literally and the Search Terms table tells the owner they
spent **$0.00 across 500 queries** — a factual claim about money, sourced from an
integration that has never been connected. That is the failure mode we have been
bitten by repeatedly here (`email_count: 0` beside a real send, `send_count: 0` on
a shipped order): **a zero that means "we never asked" is worse than a blank,
because it is confident.**

So the rule this frontend follows is the one your `meta.sources` block already
makes possible:

> **Connectedness is read from `meta.sources`. Never from a cell value.**

Every SEO/Ads cell asks the source first and only looks at the number if the
source says it is worth looking at. All 500 `paid_*` cells render `—` with
*"Not connected — the backend sends 0 here; that 0 is not a measurement"*, and the
column carries a header note saying the same. A **connected** zero still prints
`0` — there is a positive control on that, because "blank every zero" is the
opposite mistake and just as wrong.

**Ask: make `/search-terms` emit `null` for `paid_*` while Google Ads is
unconnected**, matching `/landing-pages`. Nothing here breaks when you do — the
reader already treats both identically — but the payload would stop asserting
something false on its own.

There is also a **third state** your document does not name, and it is the most
common one: **connected, but no row for this URL.** 103 of 174 landing-page rows
have `seo_impressions: null` while Search Console is connected. That is neither
"not connected" nor zero, and it gets its own copy: *"No data — the source is
connected but reported nothing for this row."*

## 4. The SEO double-count is 6.41×, not 3×

Your worked example uses `/` under three channels. The real table is worse.
Measured across all 174 rows of `/acquisition/landing-pages?limit=200`:

```
naive column sum ......... 84,935 impressions
collapsed by path ........ 13,259 impressions      ← the truth
inflation ................ 6.41×

"/" alone: 4,088 impressions repeated on all EIGHT of its channel rows → 32,704
```

16 of 138 paths are multi-channel, and in all 16 the repeated figure is
byte-identical (checked, not assumed).

You offered two remedies — show the SEO block only on the first row of a group,
or collapse by path. **We collapsed**, because "show it only on the first row"
still leaves a column a reader can drag their eye down and add up. Collapsed, the
table is one row per URL with the channel split behind a caret, and **the channel
sub-rows carry no SEO columns at all** — not blanked, absent — so the wrong total
is not merely discouraged, it is unconstructible. The footer states the true
13,259 and the note says out loud what the naive figure would have been.

One guard worth knowing about: collapsing is only safe *because* the repeats are
identical. `collapseByPath` flags any path whose channel rows disagree, and the
probe fails on it. If your join ever starts emitting per-channel Google figures,
you will hear about it from us rather than silently losing data.

## 5. Job 1, with the number that justifies it

You asked for 80 → 200. Correct, and here is the measurement behind it — across
all 4,085 live products, `('link:' + pathname)`:

```
max ....................................... 113 chars
95th percentile ...........................  99
truncated at 80 ........................... 2,380 (58.3%)
   ...of those, losing the ENTIRE SKU segment . 2,380 (all of them)
truncated at 120 ..........................     0
```

So your 66% recovery figure is generous to the old code: **every single truncated
link lost its whole final segment**, because the 80 was applied *after* the
5-char `link:` prefix, leaving 75 characters of path. 200 clears the real worst
case by 87 characters.

Two things you could not have known about from your side:

- **There were four caps, not one.** Three at 80 (`data-track`, `#id`, `link:`)
  and one at 40 applied to button text *before* the `btn:` prefix — a 44-char
  ceiling on one branch of the same column. There is now a single named
  `ELEMENT_MAX_CHARS = 200`, applied after the prefix everywhere, with the
  measurement above written above it.
- **The button branch had a dead fallback.** `('btn:' + text) || 'btn'` can never
  yield `'btn'`, since the left operand always contains the truthy `'btn:'`. A
  button with no text was recording the literal `"btn:"`. Now a ternary.

`meta.coverage.clicks` still says "truncates … at 80 characters"; that will stop
being true for events recorded from the next deploy onward, though your historical
66% figure stays correct for everything already in the table.

## 6. Two smaller findings

**(a) `view_to_sale_rate` is not a rate, and 7 rows exceed 100%.** It is exactly
`units_sold / views` on all 208 rows that have views — a units-per-view ratio.
Seven of 259 rows are above 1, up to **3.0** (`C564BK`: 1 view, 3 sold). Rendered
as a percentage under a "View → sale" heading, `300%` reads as a broken number and
the operator's next move is to distrust the whole column. It is **never capped** —
capping would invent a measurement — but anything over 100% is marked with
*"Over 100% is expected here, not an error: this is units sold ÷ views…"*, and the
column is defined in the notes block. Worth a sentence in your contract doc.

**(b) Four decoy params.** `product_type`, `sort`, `offset` and `search` are all
accepted by `/catalog/products` and completely ignored — same row set, same
`total_products_engaged`, including for nonsense values. Confirmed against a
positive control (`?source=genuine` really does filter, 144 of 259). The one that
matters is **`offset`**: because it is ignored, there is no pagination, and a Next
button would have silently re-served page one. The page offers a limit control
instead and says so: *"raise 'Show' to see more — this endpoint has no next
page."* Either make them real or 400 them; being accepted-and-ignored is the
worst of the three options.

`unmatched_brand_slugs` is currently empty, which is good news — it renders as a
named dead-link warning if it ever isn't.

---

## 7. What shipped, and how to re-check it

| | Before | Now |
|---|---|---|
| Click element cap | 80 (×3) and 40 (×1), unnamed | one `ELEMENT_MAX_CHARS = 200`, applied after the prefix |
| Product links losing their SKU | 2,380 of 4,085 (58.3%) | 0 |
| Catalogue engagement | no surface | `#catalog-engagement` — Products + Brands, 259 products / 18 brands live |
| `view_to_sale_rate: null` | — | `—` + a tooltip, on the 51 rows (20%) that are null; a real `0` still prints `0.0%` |
| Scraper filter | invisible | three-state disclosure under every table |
| Acquisition | no surface | `#analytics?tab=acquisition` — sources, channels, timeseries, entry pages, search terms |
| Entry-page SEO total | would have read 84,935 | 13,259, collapsed by path |
| Paid columns | would have read `$0.00` ×500 | `—` "Not connected" ×500 |
| A rate-limited load | would have rendered an empty table | a named, counting-down rate-limit state |

Deviations from the hand-off, and why: **collapsed** the entry-pages table rather
than showing SEO on the first row of each group (§4); **read `meta.sources`
instead of the cell** for null-vs-zero (§3); **did not** print an excluded count
in the two states where you do not supply one (§2).

Re-check any of it with **`npm run probe:analytics-dashboards`** (read-only,
GET-only besides the sign-in, no recording mode, and paced so it does not fail on
its own rate-limit footprint). Green today: **33 hard checks**, including live
positive controls that both null-vs-zero branches still have real data behind
them, that the four decoys are still decoys, that the 6.41× inflation is still
real and still neutralised, that not one of 500 `paid_*` cells would render as
money, and a watchdog that re-derives the longest product URL and fails if it ever
outgrows 200.

Pinned by `tests/traffic-element-truncation-sep2026.test.js` (20),
`tests/catalog-engagement-sep2026.test.js` (45) and
`tests/acquisition-analytics-sep2026.test.js` (49) — 114 assertions, each suite
carrying labelled positive and negative controls. All ten fixes were
mutation-tested: each reverted in turn, each confirmed to turn its suite red.
Full suite **5,227 pass / 0 fail**. Written up as ERR-204.
