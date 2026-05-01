# Brand-page deploy hook

Brand landing pages at `/brand/<slug>` are pre-rendered at Vercel build time
by `scripts/build-brand-pages.js`, which fetches `/api/landing-pages/index`
and `/api/brand-hubs/:slug` and writes static HTML to `brand/<slug>/index.html`.

Vercel serves those files from the CDN — TTFB ~10–50ms, no client-side fetch.

To refresh the pages after the daily backend import, the backend cron should
ping a Vercel **Deploy Hook** to trigger a fresh build.

## One-time setup (frontend side)

1. In the Vercel dashboard for `inkcartridges`:
   `Settings → Git → Deploy Hooks → Create Hook`
   - Name: `refresh-brand-pages`
   - Branch: `main`
2. Copy the resulting URL (looks like
   `https://api.vercel.com/v1/integrations/deploy/prj_…/…`).
3. Store it in the backend repo as `VERCEL_DEPLOY_HOOK_URL` (do NOT commit it).

## Backend cron change

Inside the existing `refresh-brand-category-counts` cron job, after the MV
refresh succeeds, POST to the hook:

```js
// after refresh succeeds
if (process.env.VERCEL_DEPLOY_HOOK_URL) {
  await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: 'POST' });
}
```

That's it — Vercel queues a deploy, the build runs `build-brand-pages.js`,
the new HTML lands at the edge.

## Failure behaviour

- If the index endpoint is down at build time, the build **fails** and the
  previous deploy stays live. Brand pages remain available with the last
  known data — they don't disappear.
- If a single brand's hub endpoint fails, that brand is **skipped** with a
  warning and the rest deploy normally.

## Local test

```bash
cd inkcartridges
node scripts/build-brand-pages.js
# → writes brand/<slug>/index.html for every brand returned by the API
npm run build
# → runs both build-brand-pages and stamp-versions in order (matches Vercel)
```

## Override API base for staging / local backend

```bash
API_URL=http://localhost:8080 node scripts/build-brand-pages.js
```

## Sitemap

The 27 new `/brand/<slug>` URLs are **not yet** in `sitemap.xml` (the sitemap
is rewritten to the backend per `vercel.json`). Backend dev should add them
to whichever sitemap generator covers landing pages — for example, by
SELECTing `slug` from the source feeding `brand_category_counts` and
emitting `<loc>https://www.inkcartridges.co.nz/brand/<slug></loc>` for each.

Without this, Google will discover the new pages slowly via internal links
(brands index, mega-nav) instead of via the sitemap.
