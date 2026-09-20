# FE response — the two items that were not live (2026-09-15 verification round)

**From:** frontend · **Date:** 2026-09-20 · **Re:** `fe-verification-results-two-fixes-sep15-2026.md`

Both are fixed and on disk. Thank you for the verification round — both reports were accurate, and
I reproduced each one against production before changing anything. Two corrections to the
diagnosis, one of which materially changed the shape of the work, plus one measurement of yours
that a parallel session read backwards.

**Status:** committed, **not yet deployed**. `npm run probe:chip-prerender` is RED against
production right now and is *meant* to be until this ships — it runs your two acceptance checks
verbatim. I'll re-run it the moment it deploys and send you the output.

---

## Fix 1 — the middleware dropped the query string

### Correction 1: we are not on Next.js

The doc prescribes:

```js
const qs = request.nextUrl.search;
return NextResponse.rewrite(`${API}/api/prerender/brand/${brand}${qs}`);
```

`inkcartridges/middleware.js` is **Vercel Edge Middleware**, not a Next.js middleware. There is no
`NextResponse` and no `nextUrl`; it `fetch`es the backend and returns the body with its own
headers. The shape of your advice was right and the diagnosis was right — the rewrite really was
built without the query string. Only the API differs.

### Correction 2: it was not one line, and the second half would have undone the first

This is the part worth your time, because it explains why a middleware-only fix might have looked
like it worked for a week and then regressed.

`js/seo-meta.js` carries a deliberate mirror of the middleware's routing
(`prerenderPathForLocation`), and `SeoMeta.reconcile()` performs what its own comment calls an
*"authoritative parity overwrite"* of `<title>` and `<meta name="description">` — it fetches the
prerender and copies its head into the live SPA, so a human and a crawler see byte-identical copy
and we take no cloaking penalty. That mirror dropped `?code=` exactly like the middleware did.

Google's JavaScript render pass executes that SPA. So an edge-only fix would have served Googlebot
`Brother LC73 Ink Cartridges NZ` in the initial HTML and then, on render, fetched the **generic**
brand prerender and overwritten it. Fixing one side of a mirror is a fix plus a mechanism for
reverting it.

It was also already costing us on the human side, which nobody had reported: on
`/shop?brand=brother&code=LC73` the shop page set a correct code-specific title and `SeoMeta` then
replaced it with "Brother NZ — Fast NZ Delivery" on every load.

Three files, not one: `middleware.js`, `js/seo-meta.js` (the mirror), and `js/shop-page.js` (the
canonical — see below).

### We forward an allowlist, not the whole search string

Your safety claim is **true**, and we verified it rather than taking it on trust. Measured
2026-09-20 against `ink-backend-zaeq.onrender.com`:

| request | result |
|---|---|
| `?code=NOSUCHCODE123` | 200, generic body, canonical collapses to `/shop?brand=brother` |
| `?code=<script>` | canonical collapses to `/shop?brand=brother` |
| `?code=lc73`, `?code=LC73%20` | canonical normalises to `…&code=LC73` |
| `?utm_source=newsletter`, `?bogusparam=xyz` | ignored, clean canonical |
| `?category=NOTACAT` | ignored, clean canonical |

Your prerender is genuinely defensive and never mints a junk canonical. We still forward only
`code` and `category`, because each distinct URL is its own `s-maxage=3600` edge-cache entry **and
its own fetch to your origin** — forwarding `utm_*`, `gclid` and `fbclid` would fragment the CDN
and multiply your load for byte-identical content. If you ever add a parameter the brand prerender
consumes, tell us and we'll add it to the list; it is one array in two files, pinned by a test that
asserts both sides build a byte-identical URL.

`category` is canonical-or-absent by the time it reaches that arm: our 301 normaliser runs for all
user agents ahead of the bot gate, so `consumable` / `ribbons` / unknowns are already stripped or
aliased.

### One thing to know about your own endpoint: it is resolution, not precedence

A parallel session here measured `?category=toner&code=TN2330` → the **toner** page and concluded
"category beats code at the origin; code is ignored". That reading would have sent us the wrong
way, so we re-measured, same host, same minute:

```
?category=toner&code=LC73     -> Brother LC73 …   canonical …?brand=brother&code=LC73
?category=ink&code=LC73       -> Brother LC73 …   canonical …?brand=brother&code=LC73
?code=LC73XL                  -> Brother LC73 …   canonical …?brand=brother&code=LC73
?category=toner&code=TN2330   -> Brother Toner …  canonical …?brand=brother&category=toner
?code=TN2330  (alone)         -> Brother NZ …     canonical …?brand=brother
```

`?code=TN2330` **on its own** falls back to the bare brand page. That is the tell: TN2330 is simply
not a code that endpoint resolves for Brother, so it falls through to whatever else is on the URL.
A code that *does* resolve wins over the category every time, and your canonical drops the category
when it does. One unresolved sample reads exactly like the opposite rule — worth knowing if anyone
on your side benchmarks this.

Two useful consequences we've relied on:

- **You collapse the yield suffix yourself** (`LC73XL` → the `LC73` page, canonical `…&code=LC73`),
  so we have deliberately NOT put a copy of `SeriesCodes.collapseYieldSuffix` at the edge. One
  owner.
- **The printer and category prerenders both ignore `?code=`.** We forward nothing on those arms,
  since it would be inert. `/api/prerender/printer/brother/mfc-j430w` also 404s, which is
  pre-existing and out of scope here — flagging it in case it is news.

### Our canonical now matches yours

`js/shop-page.js` emitted `/shop?brand=…&category=…&code=…` while your prerender emits
`/shop?brand=…&code=…`. Since Googlebot reads **your** canonical on these URLs, ours differing was
ERR-242's duplicate-canonical shape arriving from our side. We now omit `category` whenever `code`
is set, matching you exactly.

One divergence we have deliberately left: `brand && category && code` still emits
`noindex, follow` from the SPA while your prerender says `index, follow`. Both sides now agree the
canonical target is the two-param `?brand&code` URL, which is indexable on both sides, so the
three-param URL deferring to its canonical is coherent. Say the word if you'd rather we dropped the
noindex entirely.

### Your acceptance checks

Both are wired into `npm run probe:chip-prerender` verbatim, alongside the junk-code and
tracking-param cases and a parity check that compares what the edge serves against what
`SeoMeta.reconcile()` fetches.

---

## Fix 2 — `/cart?add=SKU:QTY`

Implemented to the addendum spec: uppercase SKUs, quantity 1–20, maximum 12 entries, added through
the normal add-to-cart call under the visitor's own session, then stripped with
`history.replaceState` before the first add so a refresh cannot double-add.

Beyond the spec, because the spec's "add each entry" hides three sharp edges on our side:

- **Quantity is validated, not clamped.** `SKU:0`, `SKU:21`, `SKU:2.5` and `SKU:abc` are reported
  to the shopper as unreadable rather than silently becoming 1 or 20.
- **Duplicate SKUs sum**, then cap at 20, and the cap is reported.
- **Partial delivery is stated, by name.** Every SKU costs one `getProduct` lookup (there is no
  batch endpoint), so a discontinued line means a partial cart. The shopper sees
  *"Added 2 of 3 — we couldn't add C73NM."*, never an unqualified success. If you'd like the
  backend to know about partials too, we can beacon it — say so and we'll wire it.

**Verified end-to-end against production** with `npm run probe:cart-deep-link -- --write`: a guest
add returns `201` and the line reads back, then is removed and verified gone.

### One question, so we don't ship dead code

The doc calls the `?reorder=loaded|unavailable|invalid|guest` toast an "optional nicety" and says
*"our redirects already emit these"*. We've implemented all four, but we could not find the
endpoint that emits them to confirm the vocabulary.

**Please confirm the exact set of values and the URL shape that carries them.** If any of the four
is never emitted, that branch is dead code and we'd rather delete it than carry a branch nobody can
reach. If there are values we have missed, an unknown status currently falls through silently —
which is the safe direction, but it means the shopper gets no message at all.

### One thing worth fixing on your side

`POST /api/cart/items` **ignores a client-supplied `X-Guest-Session` and mints its own**, returning
it in the response header. That is correct and our client already re-reads it — but it is not
written down anywhere we could find, and it cost us real time: our first probe sent an invented id,
added a line, read the cart back with the same invented id, got an empty cart, and reported a
clean rollback of a line it had never been able to see. A line in your cart-API docs saying the
server is authoritative for the guest session id would have saved that.

---

## What this unblocks on your side

Both of the things your doc said would ship the moment these land:

1. **Chip/code pages into the sitemap.** Our probe checks `sitemap.xml` for a code/chip shard and
   currently reports its absence as a **note, not a failure**, because nothing in our repo can move
   it. Current shards: static, products, brands, brand-categories, printers, accessories.
2. **Guest reorder emails switching from `/shop` to `/cart?add=…`.** Ready when you are. Please
   send uppercase SKUs and keep each link to 12 entries; anything past 12 is reported to the
   shopper as truncated rather than dropped silently.

Ping us when the sitemap shard is live and we'll confirm the canonical chain end to end.
