# Image Audit — we need a way to undo a quarantine (`restore-legacy`)

**Date:** 2026-09-17 · **From:** frontend · **Status:** UNANSWERED
**Relates to:** ERR-265 · `/api/admin/image-audit/*`

## The short version

Quarantine is currently a **one-way door**. It clears `products.image_url` and
archives the old value to `products.legacy_image_url`, and there is no endpoint that
moves it back. When Vision gets a verdict wrong — and it does — a correct product
image is removed from the live storefront with no route to recover it through the UI.

We would like:

```
POST /api/admin/image-audit/:id/restore-legacy
```

## Why this is needed

`GBP71GA3` ("Brother Genuine BP71GA3 Glossy Paper, 20 pages") was verdicted
`wrong_product` at **90% confidence** on 2 May 2026, reasons `["vision_wrong_product"]`.
The archived image is a photograph of a Brother BP71GA3 A3 Premium Plus Glossy Photo
Paper box, 20 sheets. **It is the correct product.** The verifier's vocabulary is
cartridge-shaped (`verified_box`, `verified_product`, `filename_tokens_match`), and the
audit sweep's default filters (`source=genuine`, `pack=singles_only`) pull photo-paper
SKUs in alongside cartridges, so a correct paper box reads as the wrong product.

Measured against the live API today:

```
GET /api/products?search=GBP71GA3   →  image_url: null,  image_thumbnail_url: null
```

So this is not a resolution failure on our side — the column really is empty, and the
storefront renders `/assets/images/placeholder-product.svg` for this product to every
customer who lands on it.

Sampling the first **600** genuine products via
`GET /api/products?source=genuine&limit=200&page=1..3`, **47 (7.8%)** have a null
`image_url`. We have not established how many of those are quarantine casualties
versus never having had an image — **that split is the first thing worth knowing**,
and you can see it from the DB in a way we cannot:

```sql
SELECT count(*) FILTER (WHERE legacy_image_url IS NOT NULL) AS recoverable,
       count(*) FILTER (WHERE legacy_image_url IS NULL)     AS never_had_one
FROM products
WHERE image_url IS NULL AND source = 'genuine';
```

If `recoverable` is non-trivial, a bulk restore matters more than the single-row one.

## Requested contract

```
POST /api/admin/image-audit/:id/restore-legacy
Auth: Bearer (owner), same as the rest of /api/admin/image-audit/*
Body: none
```

Behaviour we are asking for:

1. `image_url := legacy_image_url`, then **clear `legacy_image_url`** (the archive slot
   is now free for a future quarantine — do not leave a stale copy behind).
2. **Reset `image_vision_verdict` to NULL** and clear `image_vision_reasons` /
   `image_vision_score`. This matters: the old verdict judged this exact file and
   judged it wrong, which is *why* it is being restored. If the verdict survives the
   restore, the card comes straight back wearing the same red badge and the next sweep
   may re-quarantine it. Set `image_audit_status := 'pending'` so it re-enters review
   honestly.
3. `409` (or `422` with `{ ok: false, reason }`) when `legacy_image_url IS NULL` —
   there is nothing to restore, and we would rather show that than a false success.
4. Echo the new row state so we can repaint the card without a refetch:
   `{ image_url, image_url_resolved, legacy_image_url_resolved, image_vision_verdict, image_audit_status }`.

### Response shape

Matching the rest of the family (`/verify-with-vision`, `/refetch`):

```json
{ "ok": true, "data": { "image_url": "...", "image_url_resolved": "https://...",
                        "legacy_image_url_resolved": null,
                        "image_vision_verdict": null, "image_audit_status": "pending" } }
```

## What we shipped in the meantime

`AdminAPI.restoreLegacyImage()` (`inkcartridges/js/admin/api.js`) and a **Restore
archived image** button on the card and in the drawer, shown only when
`legacy_image_url_resolved` is present and `image_url_resolved` is not.

**It calls the endpoint above, which does not exist yet, and therefore fails.** That is
deliberate: `_imageAuditFetch` throws on any non-2xx, and the caller surfaces
`Could not restore <SKU>: HTTP 404` as an error toast. We did not stub it, hide it
behind a feature flag, or swallow the 404 — a button that silently does nothing is
indistinguishable from one that worked, which is how ERR-221 happened. It will start
working the moment the route lands, with no frontend deploy.

## Two smaller things while you are in here

1. **The archive is invisible.** `legacy_image_url` is read by exactly one drawer in
   the admin UI and by nothing in the product read path. If a product's only usable
   image is sitting there, no customer can ever see it. Worth deciding whether it
   should be a fallback in the product serializer, or whether it is purely an undo
   buffer. We have assumed **undo buffer** and labelled it "archived — not live"
   throughout the UI.

2. **Two reason tokens were never in the frontend's label map**, so they reached the
   screen title-cased as "Filename No Model Tokens" and "No Image Url". We have mapped
   `filename_no_model_tokens` and `no_image_url` now. If there are other tokens the
   verifier can emit, a canonical list would let us map them all rather than
   discovering each one from a screenshot.

## Not urgent, but noted

`PUT /api/admin/image-audit/:id/status` accepts only `pending | checked_clean`; the
`replaced` state is set by a `/replace` endpoint the frontend never calls. If
`/replace` is the intended home for this, restore could live there instead — we do not
mind which, we just need one route that puts the archived image back.
