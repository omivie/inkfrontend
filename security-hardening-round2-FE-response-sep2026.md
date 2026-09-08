# Security hardening (Sep 2026, round 2) — FE response

Answering `security-hardening-sep2026-round2-FE-handoff.md`. Everything below was
measured against the live site and the live database, not read off the hand-off —
this project has history with documents that were true when written.

**Short version:** §1 is done, and it was worse than you thought. §3 checks out.
§4's "zero impact" does not. §5's open CSP item is now audited and was not clean.
And one thing you certified as working is currently broken — see §5 below, it is
yours.

---

## 1. §1 — done, but the file was not just sitting in the repo. It was published.

You were right about the grant, and right that it hadn't been applied. What the
hand-off missed is where the file lived:

```
GET https://www.inkcartridges.co.nz/sql/analytics_function_grants.sql
    200   application/x-sql   5714 bytes
```

No auth, no `noindex`. All five of our `.sql` files were public, plus two dev
scripts:

| Path | Status before | What it published |
|---|---|---|
| `/sql/analytics_function_grants.sql` | 200 | the grants, and a written recipe for minting an `authenticated` JWT from the anon key, next to the note that the analytics RPCs are `SECURITY DEFINER` |
| `/sql/product_codes.sql` | 200 | RLS policies — including `authenticated` holding blanket `insert, delete` `with check (true)` |
| `/sql/admin_ui_prefs.sql` | 200 | RLS policies on an `auth.users`-keyed table |
| `/sql/order_tracking_requests.sql` | 200 | table shape and fulfilment logic |
| `/sql/quote_uploads.sql` | 200 | the storage-bucket policy (anon insert, no select) |
| `/scripts/fit-audit.js`, `/scripts/canonicalise-page-copy.mjs` | 200 | internal tooling |

Cause: `vercel.json` sets `outputDirectory: "."` with the Vercel Root Directory at
`inkcartridges/`, and there is no `.vercelignore`. Everything in that tree ships.

**What we did.** Both of the options you offered, plus the part neither covered:

1. **Moved** `inkcartridges/sql/` to the repo root, and the two dev scripts with
   it. The repo root is outside the deploy — proven rather than assumed:
   `/scripts/probe-payment-csp.mjs` (repo root) 404s while `/scripts/fit-audit.js`
   (`inkcartridges/`) returned 200. Same URL prefix, opposite results.
2. **Narrowed the grant** to your six-function allow-list, verbatim, with
   signatures — and **deleted sections 2 and 3**. You were right that re-running
   the wide version would replace your migration 163's trigger.
3. Four files genuinely cannot move (`stamp-versions.js` is the `buildCommand`;
   `serve.json`, `vercel.json`, `middleware.js` are read in place). Those are now
   denied with a real 404 in the edge middleware.
4. `npm run probe:public-surface` asks production directly. It was **red with 11
   findings** before the deploy, which is the only reason to believe it green
   after.

**One thing worth your attention from that list:** `product_codes.sql`'s policies
grant every `authenticated` user blanket `insert, delete` with `with check (true)`
on `public.product_codes`. That is a live grant, not just a published document,
and it is yours rather than ours. Any signed-in customer can delete our product
code overrides.

---

## 2. §3 `manual_retail_price` — confirmed, and now pinned

Your grep matched ours, and the revoke behaves as you describe. As `anon`:

```
select=id,manual_retail_price   →  42501 permission denied for table products
select=id,retail_price          →  200
```

Nothing in the FE reads it; the admin drawer only writes it. We added a test that
walks every `.select()` in the client and fails if the column ever appears in one,
because the failure mode is not a missing field — PostgREST fails the **whole**
query with a hard 401, so one added column blanks an entire page. That is exactly
how a `select('*')` blanked all 63 ribbon brand pages for us in August.

---

## 3. §4 `*` — the grep was right, the conclusion was not

> "I grepped for intentional `*` usage in search calls and found none, so I expect
> zero impact."

No FE feature offers `*` to users, so that grep was correct. There were still two
impacts.

**a. Our local/remote agreement broke.** `js/admin/utils/pgrst.js` has a
`foldFilterPunct()` that strips `,()` *specifically because your escaper does*, so
that the invoice party picker's local pass agrees with the remote one. You added
`*`; we hadn't. `queryTokens('TN*251')` still produced the token `tn*251`, which
cannot match any row your search returns.

**b. The half your fix cannot reach.** Three admin searches go **direct to
PostgREST**, so your escaper never sees them — and the double-quoting we added in
round 1 does not stop the rewrite:

```
name.ilike."%TN2*BK%"   →  GTN2130BK, CTN2345BK, CTN240BK
name.ilike."%TN2%BK%"   →  GTN2130BK, CTN2345BK, CTN240BK      identical
```

So `*` was a third wildcard in the admin search, alongside the `%` and `_` we
documented as deliberate — except nobody decided on it, and it is the only one
that cannot be escaped. Both halves now delete it, matching you.

**A detail we'd have got wrong by reasoning.** The obvious fix was to add `*` to
the existing `[,()]` class, which folds to a *space*. Your API says otherwise:

```
search=TN2130   →  1 row (GTN2130BK)
search=TN2*130  →  1 row        deletion
search=TN2,130  →  1 row        deletion — for the comma too
search=TN2 130  →  0 rows       a space is not what you do
```

Useful for us to know that you delete rather than space-fold; if that ever
changes, `npm run probe:search-escaping` §5 will fail loudly on both halves.

---

## 4. §5 — the CSP item is now audited, and it was not clean

You listed "CSP / Vercel host config" as still unaudited. Three findings.

**a. Three of our own inline scripts were being refused in production.**
`script-src` has no `'unsafe-inline'` and two `sha256` hashes; neither matched the
homepage's scroll-restoration guard, the personal-details page controller, or the
admin sync-report redirect. The personal-details form had not saved for months.
All three are external files now.

**b. One of those two hashes has never matched anything in our repo.** It was
added in a commit that described it as "the PayPal inline script hash" — a wrong
guess, which is what caused our ERR-225 PayPal outage. The real hash was added
later and the wrong one was left behind, with a test pinning it as "the original
site hash must survive". Removed; the test now computes the hash of every inline
block instead.

**c. Missing directives with no `default-src` fallback.** Added `base-uri 'none'`,
`object-src 'none'`, and `form-action 'self'` plus the PayPal and Stripe origins.
Without `base-uri`, an injected `<base>` would have repointed every relative URL
on the page, including the action-less `<form id="payment-form">`.

Also checked and **cleared**: your round-1 §4 item about the anon key. Both copies
in the client (`config.js` and `site-guard.js` — round 1 only pinned the first)
decode to `role: anon`, no service-role material anywhere. The test covers both now.

One suspected finding that did **not** survive measurement, recorded so nobody
re-opens it: our edge middleware builds its own `Response` for bot prerenders with
only three headers, which looked like it would drop the CSP on eleven routes. It
does not — Vercel re-applies the `headers` config on top. Requested `/` with a
Googlebot UA and got the full CSP, HSTS, nosniff and `X-Frame-Options` alongside
`x-prerendered: true`.

---

## 5. §2 — the analytics RPCs are dark right now, and this one is yours

> "Your direct `sb.rpc()` calls as a super-admin still work — verified `EXECUTE`
> for `authenticated` is intentionally preserved."

Not as of today. With a real super-admin JWT and each function's real named
params:

```
analytics_kpi_summary      403  42501 permission denied for function
analytics_revenue_series   403  42501
analytics_refunds_series   403  42501
analytics_top_products     403  42501
analytics_customer_stats   403  42501
analytics_brand_breakdown  403  42501
get_suppliers              403  42501     collateral — it is all of public
```

Controls with the same token: `products` select → 200, `cost_price` → 403
(expected). So the JWT is valid and the denial is specific to function EXECUTE.
This is the fourth recurrence of the family we've logged as ERR-010 / ERR-029 /
ERR-035. The dashboard is on its order-feed self-heal banner, which is correct
behaviour, but Gross Profit, Gross Margin, New Customers, Returning % and Refund
Rate are all showing "—".

Worth flagging: **this is exactly the scenario your §1 warns about.** Someone hits
this outage, goes looking for the fix, finds our SQL file, and pastes it. Under
the old version that would have opened `set_business_contract_price` to every
customer and reverted your migration 163 in the same paste. It no longer can — but
the outage that would prompt it is live now, so the timing matters.

Our narrowed file will restore the six RPCs if you want the dashboard back
immediately. It is a restore, not a durable fix; **migration 163 is the durable
part** and we've pointed our own docs at it.

If it's useful, the diagnosis recipe from the file still works and we've kept it —
including the trap that an empty-`{}` RPC call returns 404 PGRST202 rather than
42501, so a 404 there proves nothing.

---

## 6. What changed on our side

| Area | Files |
|---|---|
| Moved out of the served tree | `sql/*` (5), `scripts/fit-audit.js`, `scripts/canonicalise-page-copy.mjs` |
| Grant narrowed | `sql/analytics_function_grants.sql` |
| Edge 404 for what can't move | `inkcartridges/middleware.js` |
| CSP | `inkcartridges/vercel.json`, 3 HTML files, 2 new JS files |
| `*` handling | `inkcartridges/js/admin/utils/pgrst.js` |
| Tests | `public-surface-sep2026`, `security-hardening-sep2026-round2` (new); `analytics-function-grants` (inverted), `payment-csp-paypal-sep2026` (amended) |
| Live probes | `npm run probe:public-surface` (new), `npm run probe:search-escaping` §5 |

Full suite: **5711 tests, 0 failures.**

Logged as ERR-229 (exposure), ERR-230 (CSP), ERR-231 (`*`), ERR-232 (the analytics
outage above, open and yours).

_Questions → frontend._
