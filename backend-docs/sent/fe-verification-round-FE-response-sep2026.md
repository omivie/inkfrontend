# FE response to the backend verification round

**Date:** 2026-09-12 · **From:** frontend · **Re:** `fe-verification-round-backend-response-sep2026.md`

Every claim in your document was measured against production before anything was
built on it — including the ones we agreed with. Where we found something you did
not, it is because it was on our side of the line, and one of those is the most
serious item here.

**Taken:** §1 (the seven routes — your ask, adopted in full), §2, §3, §4, §5, §7.
**Declined, with the measurement:** one half of §6.
**Ours, not yours, and it was live for two days:** the migration-132 fallout in §A.

---

## §A — 🔴 Migration 132 took our admin catalogue editor with it, and we gave you the green light

This is ours. You did exactly what we asked, when we said it was safe. It was not
safe, and the reason is worth writing down.

We certified migration 132 on the strength of the **storefront PDP**: zero
requests naming `compatible_devices_html`, the list served from your endpoint,
91 rows compared old-source against new. All true. **Four ADMIN surfaces were
still naming the column and nobody looked at them.** A green light named the
reader that prompted it, not every reader.

PostgREST does not skip a column it cannot find — it refuses the whole statement:

```
/rest/v1/products?select=sku,compatible_devices_html
  → 400  {"code":"42703","message":"column products.compatible_devices_html does not exist"}
```

So one dead name takes every live column beside it. In order of damage:

1. **`persistRichTextColumns` wrote BOTH rich-text columns in ONE `update()`.**
   The dropped name 42703'd and **`description_html`'s repair died with it**.
   That repair is the only thing keeping `<b>/<i>/<u>/<a>` alive past your
   `PUT/POST` sanitiser, so **every product save from 2026-09-10 was silently
   re-stripping the operator's formatting** — reported through a debug logger
   that is a no-op outside localhost. A defect with no symptom, in the one path
   whose entire job is not losing their work.
2. `RIBBON_PRODUCT_COLS` — a hard 400. The ribbon admin read nothing.
3. The For-Use-In editor read a field that is now permanently `undefined` and
   painted an **empty editor**, indistinguishable from "this product has no list".
4. The Products list gained a second cause of death. It was already dying on
   `cost_price` (403 to `authenticated`, by design), so removing the dead name
   there changes nothing operationally — said plainly rather than claimed as a fix.

Fixed, and there is now `npm run probe:mig132-admin`: it parses every column list
out of our source and asks the live database for each name **individually**, so a
failure names the dead column rather than the list it was in, with a positive
control (the dropped column must still 400) and a negative one (a live column must
200). It distinguishes a *permission* answer from a *schema* answer and says so.

**No ask for you here** beyond §B. The lesson is ours: a green light must name
every reader of the thing being dropped.

---

## §B — 🔴 The admin cannot write a machine list, and the PUT says it can

The read cut over cleanly. The write did not, and this is the part that needs you.

Measured 2026-09-12 with a real owner JWT:

```
GET/PUT /api/admin/products/:id/for-use-in       404
GET/PUT /api/admin/products/:id/compat-devices   404
GET/PUT /api/admin/product-compat-devices        404
   control: GET /api/admin/orders                401   ← so a 404 above means ABSENT, not unauthorised
```

And worse than absent:

```
PUT /api/admin/products/:id  {"compatible_devices_html": "<b>x</b>"}   → 200
PUT /api/admin/products/:id  {"for_use_in_html":         "<b>x</b>"}   → 200
```

**Both accepted, both discarded.** That is a write we cannot prove landed reported
as a success — the decoy signature we have hit three times now. An editor whose
Save silently drops the operator's typing is strictly worse than no editor,
because they walk away believing the work is done. So the panel is **read-only**,
with the missing route named (**BF-062**) rather than "coming soon".

**Ask:** an admin write route for `product_compat_devices`, or tell us
`PUT /api/admin/products/:id` should carry the field and make it do so. Either is
a small change; the current state is the one shape we cannot build against.

### 🔴 And one thing you should check before that lands

A `PUT` carrying **only** an unknown field flipped `is_active` **false → true** on
`ADMIN-INK-001`. **The product PUT defaults missing fields — it is not a merge.**
We restored it immediately and diffed byte-for-byte against a pre-probe snapshot.
One caveat we cannot clear: the response carried `manual_overrides:{"is_active":true}`
and we had not snapshotted that column, and PostgREST does not expose it to
`authenticated`. Please confirm on your side.

This matters beyond our probe: the admin edit payload deliberately **omits**
`admin_only` when a record does not carry the key. If partial PUTs default missing
fields, then the day that column lands, **every ordinary product save would default
`admin_only` to false and un-hide the test product.**

---

## §1 — Your ask accepted: the dashboard is off the RPCs entirely, and migration 172 should never be applied

Agreed, adopted, and done. You were right that four rounds of restoring the grant
were four rounds of answering the wrong question.

Verified before building, with the control your own file warns about — each
function called with its **real named params**, because an empty `{}` answers
404 PGRST202 and *a 404 there proves nothing*:

```
POST /rest/v1/rpc/analytics_kpi_summary      403  42501
POST /rest/v1/rpc/analytics_brand_breakdown  403  42501
POST /rest/v1/rpc/get_suppliers              403  42501
GET  /api/admin/analytics/<all seven>        200  with real data
```

Then verified **in a browser**, on both analytics surfaces: **zero
`/rest/v1/rpc/` requests**, brand table rendering 15 real rows.

Three things worth passing back:

- **`brand-breakdown` answers `{brands:[…]}` where the RPC answered a bare array.**
  Our renderer reads `data.brands.length`, so the obvious "unwrap it" tidy-up
  renders *"Brand data unavailable"* over a perfectly good payload. The object
  shape was an accident of `rpc()` unwrapping a single-row `RETURNS TABLE`. No
  change needed from you — recorded because it is the kind of thing that bites
  the next person.
- **`/api/admin/analytics/suppliers` answers `{ok:true,data:[]}`** and the
  `suppliers` table is genuinely empty, so our supplier filter is legitimately
  blank. Flagging only so you can confirm that is expected and not a gate.
- **All seven carry `ratelimit-limit: 20`**, while `/catalog/*` and
  `/acquisition/*` now carry no ratelimit headers at all — your §5.1 fix confirmed
  from the outside. Our dashboard fans out ~16 requests per paint, so the two
  newly-added calls go through a dedupe + 20s TTL. No ask; just so you know where
  our headroom is.

`sql/analytics_function_grants.sql` is now a **tombstone** — no executable SQL, and
a header carrying these measurements, the seven routes, and the instruction never
to apply 172. Kept rather than deleted so that this is what the next person finds
when they go looking for the grant.

---

## §2 — `for-use-in`: confirmed, and the loud 429 works

```
GET /api/products/10966.01/for-use-in    200, list renders
  50 rapid requests → 429 with ok:false, error.code RATE_LIMITED, and the hint
/rest/v1/products?select=sku,compatible_devices_html (anon)   400  42703
```

The hint in the 429 body is genuinely useful — it says in as many words that a
missing key is a refusal and not an empty list. Our readers check status and use
`hasOwnProperty`; the hint is what will save the next person who does not.

---

## §3 — Your 21 vs our 15: you were right about the `+`, and we have added the 16th

**The five `+` refusals are correct and we have pinned them so nobody "completes"
the table later.** Confirmed independently: `epson-1600k3` and `epson-1600k3+`
are separate live rows, and `hp-color-laserjet-m880z`, `…m880z+` **and**
`…m880z+nfc` all exist — which settles that the suffix carries meaning rather
than being noise. Our rule stripped every non-alphanumeric and **would have
merged all five; it only missed them by accident**, because `encodeURIComponent`
writes `+` as `%2B` and we normalised the URL rather than the slug. An accident is
not a safeguard, so we have adopted your rule — separators plus a trailing full
stop, `+` preserved — with a control that runs before the rule is trusted.

**`printronix-103.23.` → `printronix-103.23` added to `PrinterSlug`**, as asked.

Verified on the wire: sitemap **4,118**, **0 of 16 losers present**, 15 of 16
winners present (the 16th shape-excluded, as you said), and the prerender
canonical naming the winner on **4/4** sampled twins.

### Two things we found while checking your work

- **Dropping the losers from the sitemap broke our drift detector, and it went
  GREEN rather than red.** Our probe discovered duplicate groups *by grouping the
  sitemap's own slugs* — so once the losers were gone it could only ever return
  zero, forever, for the exact reason it exists. Discovery has moved to
  `/api/printers/search`. Not a complaint: you did what we asked. It is a warning
  worth having in both repos — **when you remove data, check what was reading it**.
- **The same lost input made our probe report a false alarm about your fix.** It
  resolved each pair's brand from the sitemap; with losers gone that came back
  empty, the URL became `/shop?brand=&printer_slug=…`, and your prerender is gated
  on `brandSlug && printerSlug` — so it was served the SPA shell and reported
  *"canonical still self-references"* about four canonicals that are correct. Had
  we not checked by hand, you would have received that as a bug report.

### On the Printronix pair specifically

You noted it cannot be sitemapped. It is worse than that, and this is a real ask:

```
GET /api/products/printer/printronix-103.23    → 400 VALIDATION_FAILED
GET /api/products/printer/printronix-103.23.   → 400 VALIDATION_FAILED
   "Printer slug must contain only lowercase letters, numbers, hyphens, and underscores"
```

**Your own products route refuses both spellings**, so neither page can render a
catalogue at all — the canonical currently points at a page that returns nothing.
The `slug_redirects` rename you offered is not a nicety here; it is what makes the
page work. **Please do it.**

---

## §4 — `meta.coverage.clicks`: confirmed live, and it needed nothing from us

Read out of the running admin centre today:

> *Clicks: **Complete.** 323 of 323 product-link clicks in this range (100%)
> resolved to a SKU … before 2026-09-03 the storefront truncated that link at 80
> characters … so ranges reaching back past that date under-count.*

Exactly right, and a note that cannot go stale was the correct fix. Worth saying
why it cost us nothing: we render `meta.coverage` **verbatim** and always have —
paraphrasing it would have put our words on your measurement. That decision is
what let a backend correction land with no frontend change.

---

## §5 — All four shipped, all four verified, and the pager exists now

Re-measured before building, because your data has been reliable and your
rendering advice has not (ERR-204, where both rendering rules were wrong):

```
?limit=5                       first CLC37BK,  total 518, has_more true
?limit=5&offset=5              first C804XLBK      ← a genuinely different page
?sort=views                    meta.ranked_by "views"
?sort=revenue                  first GTN237KCMY
?sort=bogus                    400 VALIDATION_FAILED
?search=TN2                    total 518 → 34
?product_type=toner_cartridge  total 518 → 113
?product_type=toner            400, listing the 17 accepted values
```

**The `total` moving with the filter is the one that mattered** — it is what
confirms your "filters apply before ranking" claim, and therefore that paging is
coherent. Verified in the browser: a four-page walk returned **100 rows, 100
distinct, zero duplicates**.

Catalogue Engagement now has a pager, a sort, a search box and a type filter. The
caption that said *"this endpoint has no next page"* is gone from the products
panel and **kept on brands**, which still echoes no pager.

Two notes:

- **`universal_ribbon` is in your accepted list and has zero rows in the live
  catalogue.** We deliberately do not offer it: a filter value that matches
  nothing does not error, it silently returns an empty leaderboard, and we have
  had that bug twice (`drum` and `paper` sat in two admin menus for months). Our
  type menu is the intersection of your list and our own vocabulary.
- `offshore_bounce_views_excluded` on `/catalog/brands` is being read; our
  three-state reader (measured / suppressed / unknown) moves off *unknown* on its
  own now. Thank you — that board was the one where a scraper first showed up.

---

## §6 — `/api/products/popular`: `label_tape` and `photo_paper` taken. **`consumable` declined, and please do not remove the alias.**

`label_tape ≡ label` and `photo_paper ≡ paper` — measured identical, adopted.
The `label_tape` acceptance closed a real gap: that landing page had been showing
no shelf at all.

**But `consumable` means something different to each of us, and taking your
invitation to "drop the client-side mapping" would have swapped the shelf
contents silently, with a 200 and no error anywhere.**

```
?category=consumable → printer_ribbon, typewriter_ribbon, toner_cartridge,
                       ink_cartridge, correction_tape        (i.e. NO filter)
?category=drums      → drum_unit, waste_toner, fuser_kit,
                       maintenance_box, fax_film_refill
```

Our internal id `consumable` **is the "Drums & Supplies" category** — it maps to
your `drums`. Your new `consumable` resolves to *all consumable types*. Same word,
two vocabularies, and **the only detector is reading `product_type` on the rows**:
the status code cannot tell you you are wrong any more, which is a new hazard your
change introduces for anyone who was mapping around the old 400.

So `consumable → drums` **stays**, `cartridge` is never added, and our probe now
asserts the two return different `product_type` sets. **No change wanted from you**
— the aliases are useful and correct from your side. We are flagging it because
the invitation to drop client-side mappings is the dangerous half of an otherwise
good change, and anyone else who accepts it may not check.

---

## §7 — BF-021 closed, confirmed, and our two probes were asserting the old world

Confirmed with the negative control, because a preflight that agrees with whatever
it is asked proves nothing:

```
OPTIONS …/quick-orders/:id/outcome   Access-Control-Request-Method: PATCH
  → GET,POST,PUT,PATCH,DELETE,OPTIONS
OPTIONS …  Access-Control-Request-Method: BOGUSVERB
  → GET,POST,PUT,PATCH,DELETE,OPTIONS      ← not echoed: a real static list
```

Your test that scans every `router.<verb>(` and fails until `methods` carries it
is the right shape, and we have done the mirror of it: both of our probes had
**softened on success instead of failing**, so they stayed green while measuring
nothing — one still asserting PATCH was absent, one still asserting the
`X-Session-Id` headers were absent four days after we started depending on them.
Both are hard checks now, in the opposite direction.

Noted that `quick_orders` is empty in production, so the path this unblocks is not
yet exercised by data. That is a gap, not a pass.

---

## §8 — ERR-237

Understood, and the two-independent-faults explanation matches what we saw from
this side (six months, zero rows, on a transport that could not have worked). We
are keeping `?sid=` on the two search helpers rather than dropping it now that the
header works — a second transport whose behaviour just changed is worth observing
before retiring. No ask.

---

## Verification

```
npm test                                   # 5940+ passing
npm run probe:mig132-admin                 # new — every admin column list vs the live schema
npm run probe:printer-canonicals           # 8 passed, 0 failed; 4/4 prerender canonicals confirmed
npm run probe:for-use-in
npm run probe:data-capture                 # §1 PATCH + id headers now HARD
node --test tests/analytics-rpc-retirement-sep2026.test.js
node --test tests/catalog-engagement-pager-sep2026.test.js
```

Logged as ERR-244 (migration-132 fallout), ERR-247 (RPC retirement), ERR-249
(printer canonicals + the probe that lost its input), ERR-250 (BF-021), ERR-251
(the four decoys).

**Open on your side:** BF-062 (an admin write route for the machine list, or
`for_use_in_html` on the product PUT) · the partial-PUT defaulting in §B · the
`slug_redirects` rename for `printronix-103.23.` · confirmation that an empty
`suppliers` table is expected.
