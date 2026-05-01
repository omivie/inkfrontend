# Backend Passover

A running list of items the frontend needs from the backend. Each section is self-contained and can be tackled independently. Sections are listed newest-first; mark them resolved by adding a `**Status:** Done — <date>` line at the top of the section once shipped.

---

## Brand landing pages — wire deploy hook + add sitemap entries

**From:** Frontend (Vieland)
**Added:** 2026-05-02
**Frontend status:** Shipped in commit `91f78c1` on `main`. `inkcartridges/scripts/build-brand-pages.js` runs in Vercel's `buildCommand` and pre-renders `/brand/<slug>` for every brand returned by your `/api/landing-pages/index` endpoint, then Vercel serves them straight from the CDN. We need two things from you to make this fully production-grade.

### TL;DR — two tasks

1. **Call a Vercel deploy hook from the `refresh-brand-category-counts` cron** so brand pages auto-refresh after each daily import. Without this, the static HTML only refreshes when someone pushes a commit.
2. **Add the 27 `/brand/<slug>` URLs to `sitemap.xml`** so Google can discover and crawl the new landing pages. Without this, discovery happens slowly via internal links only.

### Background — what got built on storefront

- New script `inkcartridges/scripts/build-brand-pages.js` fetches `/api/landing-pages/index` (your MV-backed endpoint), then for each brand fetches `/api/brand-hubs/:slug`, and writes a fully-rendered `inkcartridges/brand/<slug>/index.html` per brand.
- Vercel runs the script as part of `npm run build` (chained before `stamp-versions.js`). So every deploy regenerates the brand pages with fresh data from your MV.
- Build behaviour:
  - Index endpoint failure → build **fails** (deploy aborts; previous deploy stays live).
  - Per-brand-hub failure → that brand is **skipped** with a warning; rest deploy normally.
- Internal links updated: `inkcartridges/html/brands/index.html` and `inkcartridges/js/mega-nav.js` now point at `/brand/<slug>` so users can discover the hubs.
- This supersedes Q2 in `backend-passover.md` for the **singular** `/brand/<slug>` path (the plural `/brands/:slug/:category` answer in Q2 still stands — we didn't build path-based brand-category routes).

### Task 1 — Vercel deploy hook for `refresh-brand-category-counts` cron

The full step-by-step is in `inkcartridges/scripts/README-deploy-hook.md` in the storefront repo. Short version:

**Setup (Vieland will create the hook URL and pass it to you):**

1. Vieland creates the hook in Vercel (Settings → Git → Deploy Hooks → Create Hook, name `refresh-brand-pages`, branch `main`) and gives you the resulting URL.
2. You store it in your backend env as `VERCEL_DEPLOY_HOOK_URL` (do not commit; treat it like an API key — anyone with the URL can trigger a deploy).

**Code change inside `refresh-brand-category-counts`:**

After the materialized-view refresh succeeds, fire-and-forget POST to the hook. Don't block the cron on the response — Vercel returns immediately and the build runs async on their side.

```js
// after the MV refresh succeeds
if (process.env.VERCEL_DEPLOY_HOOK_URL) {
  try {
    await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: 'POST' });
    logger.info('[refresh-brand-category-counts] Vercel deploy hook fired');
  } catch (err) {
    // Non-fatal — next push or the 03:00 fallback will catch it up.
    logger.warn('[refresh-brand-category-counts] deploy hook failed', err.message);
  }
}
```

**Cadence:** Your existing cron already runs after the 14:00 UTC import chain plus a 03:00 UTC fallback. Hooking the deploy onto the success path of the primary 14:00 run is enough; the 03:00 fallback is a safety net for the MV, not the deploy. If you also fire the hook from the fallback, we'll get a redundant deploy at 03:00 — that's harmless but unnecessary; either is fine.

**Failure mode if you skip this:** brand pages keep working but show stale data until the next git push to `main`. Not catastrophic, but defeats the purpose of a daily-refreshing landing-page system.

### Task 2 — Add brand pages to sitemap

The 27 `/brand/<slug>` URLs are not currently in `sitemap.xml` (the sitemap is rewritten to your backend per `vercel.json`). Add them so Google indexes them quickly.

**Implementation suggestion:** the same materialized view (`brand_category_counts`) that backs `/api/landing-pages/index` already has the slug list. Emit one `<url>` entry per distinct `brand_slug` where the brand has at least one active product (matches what `/api/landing-pages/index` returns):

```xml
<url>
  <loc>https://www.inkcartridges.co.nz/brand/{slug}</loc>
  <changefreq>daily</changefreq>
  <priority>0.7</priority>
  <lastmod>{date the MV was last refreshed}</lastmod>
</url>
```

`<lastmod>` should reflect when the MV last refreshed — i.e., when the brand's product/price data may have changed. If that's hard to compute per-row, using the cron's last-run timestamp for all brand entries is fine.

**Sanity check after deploy:**

```bash
curl -s https://www.inkcartridges.co.nz/sitemap.xml | grep -c '/brand/'
# should output 27 (or whatever brand count is current)
```

**Reminder for later:** when the 27 brands change (new brand added, old brand discontinued), the sitemap should reflect that automatically because it's driven by the MV. Just confirm your sitemap generator queries the MV (or the same source) and isn't a hardcoded list.

### How to verify everything is wired

1. After both tasks ship, run the cron manually (or wait for the 14:00 UTC trigger).
2. In Vercel's Deployments view, confirm a new deploy started at the cron time with commit message "Deploy Hook" or similar.
3. Once deploy is live (~1–2 min), curl one of the brand pages and confirm fresh data:
   ```bash
   curl -s https://www.inkcartridges.co.nz/brand/hp | grep -o 'Total products</div>' | head
   curl -s https://www.inkcartridges.co.nz/brand/hp | grep -B1 'Total products' | grep brand-hub-stat__value
   ```
   The number in the stats card should match the live count from `/api/brand-hubs/hp`.
4. Sitemap check: `curl -s https://www.inkcartridges.co.nz/sitemap.xml | grep '/brand/' | head` — should list all current brands.

If either fails, ping Vieland.

---

## Genuine Image Audit — verify rollout + confirm status endpoint

**From:** Frontend (Vieland)
**Added:** 2026-05-02
**Related spec:** `~/Downloads/genuine-image-audit-api.md` (the doc Vieland gave you a few days ago)
**Frontend status:** New admin surface is built and merged at `#genuine-image-audit` (file: `inkcartridges/js/admin/pages/genuine-image-audit.js`). It calls every endpoint in your spec. We need to confirm two things on the backend before the page is usable in production.

### TL;DR — two tasks

1. **Confirm the rollout steps from §"Rollout" of your spec have actually been run in prod.** Without these the page renders but every product card shows "Not checked" — so the entire surface is dead on arrival.
2. **Confirm `PUT /api/admin/image-audit/:productId/status` exists and accepts `{ status: 'checked_clean' }`.** Your spec references this endpoint in §"Recommended UI > Card footer" but does not document its request/response shape in §1–6, so we want to be sure it's actually implemented and matches what the frontend is calling.

---

### Task 1 — Verify production rollout

Walk through the four steps from §"Rollout" of `genuine-image-audit-api.md` and confirm each one is done in **production** (not just staging / local).

| # | Step | How to verify |
|---|---|---|
| 1 | Migration `049_genuine_image_vision.sql` applied | `\d products` in prod psql — confirm columns `image_vision_verdict`, `image_vision_score`, `image_vision_reasons`, `image_vision_checked_at`, `image_audit_status`, `legacy_image_url` exist. Also check `pending_product_changes` table exists if it didn't already. |
| 2 | `ANTHROPIC_API_KEY` set in Render env | Render dashboard → service → Environment. Should be a key starting with `sk-ant-`. Without this, every refetch will fail at the Vision step with an auth error. |
| 3 | `node scripts/audit-genuine-images.js --apply` has been run against prod | Run this SQL: `SELECT COUNT(*) FROM products WHERE source = 'genuine' AND pack_type = 'single' AND image_vision_checked_at IS NOT NULL;` — should be in the low thousands (matches the count of active genuine singles). If it returns 0, the script hasn't been run. Cost budget per the spec: ~$10 in Anthropic spend, ~30–60 min wall time. |
| 4 | Stats endpoint returns non-zero verdicts | `curl -H "Authorization: Bearer <super-admin-token>" "https://ink-backend-zaeq.onrender.com/api/admin/image-audit/stats?source=genuine&pack=singles_only&exclude_ribbons=true"` — `data.vision.*` should have non-zero counts. If everything is 0, step 3 wasn't run. |

If any of the four are missing, do them. **Step 3 is the most likely gap** — the migration usually ships with the deploy but the audit script has to be triggered manually.

### Task 2 — Confirm `PUT /:id/status` endpoint

The frontend's "✓ Mark verified" button calls:

```
PUT /api/admin/image-audit/:productId/status
Authorization: Bearer <super-admin-token>
Content-Type: application/json

{ "status": "checked_clean" }
```

Expected response (matches the standard backend envelope used everywhere else):

```jsonc
{
  "ok": true,
  "data": {
    "id": "uuid",
    "image_audit_status": "checked_clean"
  }
}
```

**What we need from you:**

- **If the endpoint exists** at exactly that path and accepts that body — reply "confirmed" and we're done.
- **If it exists at a different path** (e.g. you implemented it as `POST /:id/mark-status` or rolled it into `verify-with-vision`) — tell us the actual path/shape and we'll update `AdminAPI.setImageAuditStatus` in `inkcartridges/js/admin/api.js` to match.
- **If it doesn't exist yet** — please add it. Auth: `super_admin`. Accepted `status` values: `pending`, `checked_clean`, `replaced` (matches the `image_audit_status` column enum from migration 049). Should also stamp an `image_audit_status_changed_at` timestamp + `image_audit_status_changed_by_email` for audit trail if those columns exist; if they don't, just set the status.

### How to test once both tasks are done

1. Deploy / verify backend is live.
2. Log into admin as super-admin → click **Genuine Audit** in the sidebar.
3. KPI cards at the top should show non-zero values for "Verified", "Bad", "Pending review".
4. Cards in the grid should show colored verdict badges (green/amber/red), not the grey "Not checked".
5. Click ✓ on any card → toast says "<SKU> marked verified", card status pill updates to CLEAN.
6. Click ↻ on any genuine-single card → spinner ~5–15s, then either "staged for review" (success) or a reason toast (e.g. "all_candidates_rejected").
7. Open Pending Changes → the refetched product appears as a queued change.

If any of those steps fail, ping Vieland with the network tab response and we'll iterate.

---

<!-- Add new sections above this line. Keep newest-first. -->
