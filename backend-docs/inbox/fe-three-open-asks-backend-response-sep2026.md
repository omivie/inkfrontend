# The three open asks — backend response (2026-09-16)

All three verified against production and the live database. Two are **done and
deployed from our side**; one is **half ours, half the Cloudflare dashboard**.
One of the three turned out to be the wrong fix, and the reason matters, so it
leads.

| Ask | Status |
|---|---|
| Printronix `slug_redirects` rename | **Refused, and closed a different way.** Neither row was a printer. Both retired. |
| Exclude `query LIKE 'zzprobe%'` from aggregates | **Done — widened to `zz%` + the warmers.** 86 rows, not 20. |
| Cache Rule gap on `/api/site/nav`, `/api/ribbons`, `/api/printers/trending` | **Closed 2026-09-17.** Backend half shipped; rule expression updated and verified MISS → HIT on all three. |
| The reply in your `backend-docs/outbox/` | **Not received.** Nothing has reached us — see the last section. |

> Companion doc: `docs/storefront/fe-open-asks-backend-response-sep2026.md` covers
> the other half of the same round (BF-062's by-SKU route, the printer slug gate,
> the empty `suppliers` table). The two were worked in parallel; where both
> mention Printronix, section 1 here is the authoritative account.

---

## 1. Printronix — we are not renaming it, because it is not a printer

We said in the Sep-10 response that the real fix for
`printronix-103.23` / `printronix-103.23.` was "renaming the slug (a
`slug_redirects` hop), which we can do on request". Before doing it we looked at
what the page actually lists. That was the right instinct and the answer is:

```
printronix-103.23   → 8 products, all of them Epson 103 EcoTank INK
printronix-103.23.  → the same 8
```

Printronix builds line-matrix and dot-matrix industrial printers. They take
**ribbons**. `103.23` is not a model number at all — it is the part number of
Printronix's own ribbon, which sits in our catalogue as *"Printronix Compatible
103.23 FN Black Printer Ribbon"*. The Epson ink arrived by a bare-number
collision: the cartridge's `103` matched a printer row whose name **is** the
ribbon's part number.

The identical compat-link count on both sides — the check we used to prove they
were twins — was true and also beside the point. They were twins because they
were both wrong in the same way.

**Three more rows of the same kind**, which is what confirmed the diagnosis:

```
printronix-$100works   8 links — all Epson 103 ink
printronix-30-day      8 links — all Epson 103 ink
printronix-p300        8 Epson ink links + its 2 REAL Printronix ribbons
```

`$100WORKS` and `30-DAY` are supplier marketing prose ("…30-day money back… $100…")
that got parsed into `printer_models` as machines. They carry digits, which is
exactly why the no-digit rule in `printerNameNoise.js` — the guard that swept
217 prose rows in Sep — could not reach them: requiring no digit is what keeps
that rule off real hardware.

The write-time type guard could not stop any of it either. `getPrinterType()`
returns `unknown` for every Printronix model name, and the documented contract
for `unknown` is **allow**. Same door as the Canon FX-3 / "MP 190" case.

### What we did instead

1. Added an Epson-103 × Printronix group to `src/utils/compatLinkSuppressions.js`
   and ran `enforce-compat-link-suppressions.js --apply`: **40 links deleted**,
   exactly the 40 predicted, none beyond. Suppression rather than a bare delete
   because the feed re-asserts these (it did so within 15h in August), and the
   enforcer runs as step 3.6 of every import.
2. Deactivated the four junk rows. `printronix-p300` stays **active** — it is a
   real machine and now correctly holds only its two ribbons.
3. Removed the Printronix entry from the curated canonical map. Without this,
   `npm run audit:printer-canonicals --check` fails on a stale curation.

All 8 Epson 103 products still carry their **12 correct Epson EcoTank printers**
(L1110/L1210/L1250/L3110/L3150/L3160/L3210/L3250/L3260/L3550/L5190/L5290).
Nothing was left linkless.

Rollback — inlined because `audit_artifacts/` is gitignored, so the artifact is
local to the machine that ran it:

```sql
UPDATE public.printer_models SET is_active = true WHERE id IN (
  '6421d96d-8b4f-46ba-b717-9f60e9c85ced',  -- printronix-103.23
  '3b612614-ea50-4537-b861-44ba71c69ffb',  -- printronix-103.23.
  'e94992c1-ef91-42d4-9667-5cf7f80b36be',  -- printronix-30-day
  'd05935a2-c0f4-4116-904c-3b4a617b1ed9'   -- printronix-$100works
);
```

That restores the rows but **not** the 40 links — they are on the suppression
list and `enforce-compat-link-suppressions.js --apply` runs as import step 3.6.
Remove the Epson-103/Printronix group from `src/utils/compatLinkSuppressions.js`
first. Per-link detail: `audit_artifacts/enforce-compat-link-suppressions-2026-09-16.json`.

**The guard is not deployed yet.** The suppression group is uncommitted, so
nothing currently stops a link-creating import from re-adding these. No compat
link has been created anywhere since 2026-09-09, so the 0-regression measured on
09-17 is an absence of imports, not proof the backstop works — that test comes
after the code ships.

### What this means for your side

**Do not add the Printronix pair to `PrinterSlug`.** Both URLs are now retired,
not consolidated — there is no winner to canonicalise to. Your table of **15**
was right; our 16th was a defect we had mistaken for a duplicate. `--check`
passes at 15 groups, and the five `+` refusals are unchanged.

The trailing-full-stop rule stays in `printerSlugKey` and is still pinned — the
next feed row spelled that way must still group. Only this instance is gone.

---

## 2. Probe queries — done, and it needed to be wider than `zzprobe%`

Confirmed: 20 `zzprobe_*` rows, 2026-09-12 → 2026-09-16, every one at
`result_count = 0`.

Filtering only that prefix would have caught **20 of 86**. Both of us have been
firing `zz`-prefixed probes since April and the shapes vary:

```
zzprobe_edgecache · zzprobe_nonexistent,or(sku.eq.GTN251BK) · zzq1789008040
zzqqxnonexistent  · zzqxwvqwerty12345 · zzz_no_results_<ts> · zzznotreal
```

`zz` is safe as a marker: `products`, `printer_models` and `brands` contain
**zero** rows starting with `zz` — checked, not assumed.

And the single largest zero-result "query" was not a `zz` string at all:
**`warm`**, 21 rows, 0 sessions, always 0 results, and **17 of them share an IP
with a `zz%` prober**. It is a cache warmer. It is now filtered, along with
`ping` and `healthcheck`. `test` is deliberately **not** — a human can type it,
and guessing wrong there deletes real demand.

**What it was costing** (live, 7-day window):

| | reported | actual |
|---|---|---|
| zero-result rate | **16.91 %** | **14.12 %** |
| zero-result rows | 104 | 84 |
| top-15 zero-result list | **6 of 15 were probes**, incl. `warm` at #1 with 11 hits | — |

That list is the input to "what is the catalogue missing", so a polluted one
sends someone sourcing products nobody searched for.

**Implementation** — `src/utils/syntheticSearchQueries.js`, wired into all nine
`search_analytics` reads across `analyticsQueries`, `adminAnalytics` (×4),
`printers` (trending), `zeroResultAuditService`, `searchQualityReportService`
and the ribbon search monitor. Filtered **at read time, not write time**: the
probes prove the search path works end to end (two are security regression
tests), so the row is worth keeping — only the aggregate must not count it. Read
time also covers the 86 rows already logged, which a write-time skip never
could.

The exclusion is applied **in the query, not in JS after the fetch**, because
`GET /admin/analytics/search` selects `result_count` alone for its denominator —
a JS filter would have forced every caller to project `query`, and the one that
forgot would have silently stopped filtering with all tests green.
`__tests__/synthetic-search-queries.test.js` pins the predicate, its refusals,
and the mechanical rule that every reader carries a guard per read.

---

## 3. Cache Rule gap — confirmed on all three, and it is two different bugs

Measured live, one anonymous request each:

| Path | `cf-cache-status` |
|---|---|
| `/api/shop?brand=brother` | `MISS` → `HIT` (age 13) |
| `/api/products?limit=1` | `MISS` |
| `/api/brands` | `REVALIDATED` |
| `/api/site/nav` | **`DYNAMIC`** |
| `/api/ribbons` | **`DYNAMIC`** |
| `/api/printers/trending` | **`DYNAMIC`** |

`DYNAMIC` = Cloudflare never considered the response cacheable. Your three are
right, and the deployed rule turns out to cover only `/api/products*`,
`/api/shop*` and `/api/brands` — the `/api/site/` clause in our July hand-off
never made it into the expression.

The causes differ, which is why only part of this was ours:

- **`/api/site/nav`** was broken at the origin too. The route set
  `public, max-age=3600` with `res.set()`, which replaced the middleware's
  `Cache-Control` but left its `Pragma: no-cache` and `Expires: 0` behind — a
  response claiming to be public while carrying two do-not-cache headers. **Fixed.**
  `/api/site/*` joined the catalog allowlist, and both `/site/nav` and
  `/site/trust` now send `public, max-age=300, s-maxage=3600,
  stale-while-revalidate=86400`. They **upgrade** the middleware's header rather
  than replacing it, so an authenticated caller still gets `no-store`.
- **`/api/ribbons` and `/api/printers/trending`** already sent the correct
  header. Nothing to fix at the origin — their gap is entirely the rule.

**Both halves are now done.** The rule expression was updated on 2026-09-17 to
add `/api/ribbons`, `/api/printers` and `/api/site`, keeping **Edge TTL: use
cache-control header if present** — a fixed edge TTL would be wrong for one group
either way (`/api/site/*` wants 3600s, the rest 300s) and would outlive the purge
that fires on an admin price edit.

Verified live, one anonymous request then a second:

| Path | 1st | 2nd |
|---|---|---|
| `/api/site/nav` | `MISS` | `HIT` |
| `/api/ribbons` | `MISS` | `HIT` |
| `/api/printers/trending` | `MISS` | `HIT` |

Negatives pass too: an `sb-*` cookie gets `no-store` + `BYPASS`, `/api/admin/*`
stays `DYNAMIC` and never eligible, and no cached body carries `cost_price`,
`manual_retail_price` or `admin_only`. Full write-up — including why an
`Authorization`-bearing request correctly returns `HIT` and must not be "fixed"
with `Vary: Authorization` — is in `docs/infra/cloudflare-catalog-cache-rule.md`.

---

## 4. The outbox reply has not reached us

Nothing from `backend-docs/outbox/` has arrived — no bundle, no patch, no
message. `npm run bundle:backend` is a script in **your** repo; we cannot run it.
Whenever you send it, paste it or attach the bundle and we will pick it up.

Two things are worth knowing before you do:

- If that reply answers the Printronix ask, section 1 above supersedes it.
- The two items from your 2026-09-15 verification — the middleware dropping the
  query string on `/shop?brand=…&code=…`, and `/cart?add=SKU:QTY` — are still
  yours and still open as far as we can see. Neither is affected by anything here.
