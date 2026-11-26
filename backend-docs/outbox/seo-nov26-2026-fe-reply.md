# FE reply: SEO recovery handoff (26 Nov 2026) and the P1 bundle

**To:** backend. **From:** frontend (`omivie/inkfrontend`). **Re:** `fe-handoff-seo-nov26-2026.md` and `fe-p1-bundle.md` (both copied to `backend-docs/inbox/`).
**FE log entry:** `errors.md` ERR-400. **Probe:** `npm run probe:seo-nov26` (READ-ONLY by default; `--burst`, `--backend-limit`, `--base <url> --preview`).
All times UTC, 2026-11-26. No deploy was made inside 13:55–15:30.

## Summary

| Item | State |
|---|---|
| P0 crawler IP + secret, 429 ⇒ 503 | **LIVE** in production `eaa22f6e` (06:56). Secret set in Vercel (Production + Preview, Sensitive). **The match with Render is proved** (row 3 and the 25 = 30 − 5 test). |
| P2 trailing slash 404 ⇒ 308 | **LIVE** (`trailingSlash: false`). |
| P2 apex 307 ⇒ 308 | **LIVE.** It was a Vercel Domains setting (the 307 carried `x-vercel-id`). Now 308; see row 5. |
| P1 FE-1…FE-4b | Applied on `seo-phase2-preview`, **tree matches** `4ef169c7`, tests fail 0, Vercel **Preview built**. Preview is behind Vercel Deployment Protection (see §P1). **Not merged.** The rebase onto main **conflicts in `middleware.js`** (one hunk; not resolved, as asked). |
| Item 32 | Logo sizes + WebP, cart/order thumbnails, staggered list fade removed: **LIVE**. pages.css split: **still declined by the owner**. PDP hero `width`/`height`: **not done, measured regression**. |

## P0: what we shipped

In `middleware.js`:
- Your helpers, as given: `CF_V4`, `CF_V6`, `inV4`, `fromCloudflare`, `crawlerIp`, `prerenderProxyHeaders`.
  - We re-checked the ranges against cloudflare.com/ips-v4 and /ips-v6 today. They are identical.
- The two headers go on the `BACKEND` `/api/prerender/*` fetch only. `slugHop()` never carries them (pinned by a test).
- `if (response.status >= 500 || response.status === 429) return prerenderUnavailable();`

Two small changes from your snippet:
- **The secret is read as `globalThis.process?.env?.PRERENDER_PROXY_SECRET`, and the headers are built before the `try`.** If `process` were ever missing at the edge, a `ReferenceError` inside the `try` would have become a 503 for every bot.
- **A new response header on every bot answer: `X-Prerender-Client: forwarded | shared`.** It carries neither the IP nor the secret.
  - `forwarded` means the env var reached the middleware and a client IP was sent.
  - It does **not** prove the value matches yours; row 3 does that.
  - It closes the "nothing will tell you" gap on the FE side.

Tests (`tests/seo-handoff-nov26-2026.test.js`, 16 tests) cover:
- your four cases;
- IPv6 and the 2a06:98c0::/29 edge;
- the 104.16/13 and 172.64/13 boundaries;
- a fake `cf-connecting-ip` from a non-Cloudflare IP;
- 429, 404 and 500;
- "humans fetch nothing".

Six of them fail against the old middleware. The full suite: 7,464 tests, fail 0.

### §5 rows

**Row 1** (one network, Googlebot UA, 40 cold `sitemap-printers.xml` URLs, 06:57):
```
     21 × 200 true  client=forwarded
     19 × 503 -     client=forwarded
      0 × 200 -
```
Before the fix you measured 30 × `200 true` then 10 × `200 -`. Now no bot gets the shell. The 503s are the 429 path, not timeouts: five of them re-timed at 0.24–0.32 s each. The cut came at 21, not 30, because about 9 bot requests from this network (the probe's own checks and a curl) fell in the same minute.

**Row 2** (second network straight after): **owner action.** It needs a second network, such as a phone hotspot. Command:
`node scripts/probe-seo-nov26.mjs --burst 40 --offset 40`. Pass = it starts again at `200 true`.

**Row 3** (backend alone, 35 TEST-NET IPs with the secret, 07:27): `{"200":35}`. **PASS.** The owner ran it with the secret from the clipboard; it was never printed. A first run at 07:25 with the wrong clipboard contents (86 characters, not the 64-hex value) gave 26 × 200 then 9 × 429. That is what a rejected secret looks like: the requests were keyed on the owner's own IP, and 26 = 30 − 4 earlier requests.

**Vercel's value = Render's value, proved end to end (07:29–07:30).** Steps: wait 65 s; send 5 Googlebot requests through www (all `200 forwarded`); then send direct backend requests from the same machine with no secret until the first 429. Result: **25** answered 200. That is 30 − 5, so the 5 www requests were counted against this machine's IP. That only happens when the backend accepts the secret Vercel sends. Had the values differed, they would have landed in Vercel's shared bucket and the run would have stopped at 30.

**Row 4** (trailing slash, 06:57): PASS.
- `/ink-cartridges/` → `308 /ink-cartridges`
- `/ribbons/` → `308 /ribbons`
- `/shop/?brand=hp` → `308 /shop?brand=hp` (query kept)
- `/ink-cartridges`, `/shop?brand=hp` and `/products/x/GLC233BK` still answer 200.

**Row 5** (apex): **PASS** after the owner set `redirectStatusCode: 308` on the Vercel domain (the target is unchanged). `https://inkcartridges.co.nz/ink-cartridges?x=1` now answers `308` with location `https://www.inkcartridges.co.nz/ink-cartridges?x=1`. `/` and a printer URL with two parameters also answer `308` with the path and query kept, and www answers 200.

**Row 6** (unknown printer/product): `200`, no `x-robots-tag`, for bot and browser, as expected. FE-2 is in P1 Stage A, which is not in production.

**Row 7**: `<link rel="canonical" href="https://www.inkcartridges.co.nz/ink-cartridges">` PASS.

## P1: Preview

| | |
|---|---|
| Branch | `seo-phase2-preview` (from `064879a50945cae357f682570629e19a3287c1cc`) |
| SHA256SUMS | all 6 OK |
| `git am --3way` | clean |
| Tip commit | `b7bbb3c3b0bf5f666b3efce70c15691647e49d7d` (SHAs differ from yours, as you said) |
| Tree | `4ef169c76c334ed680e1bb37079bef07e8e919cc`, **matches** |
| `node --test tests/*.test.js` | 7,468 tests, 7,445 pass, **0 fail**, 23 skipped (identical to your run) |
| Preview URL | `https://inkfrontend-93bsa68lh-omivies-projects.vercel.app` (GitHub deployment 8078626692, state success) |

**The Preview is behind Vercel Deployment Protection.** Every request gets `302` to `vercel.com/sso-api`, so neither curl nor the probe can read it. We did not switch protection off. To run the §5 table:
1. The owner creates a **Protection Bypass for Automation** secret (Vercel → Settings → Deployment Protection).
2. Copy it to the clipboard and run:
   `VERCEL_BYPASS="$(pbpaste)" node scripts/probe-seo-nov26.mjs --base https://inkfrontend-93bsa68lh-omivies-projects.vercel.app --preview`

The probe sends that header only to the `--base` host and never prints it. The §5 table, the bot-vs-Chrome parity rows and the 0005 FAQ check will follow from that run. PENDING the bypass secret.

**Rebase onto main: one conflict, in `middleware.js`, at 0002 (FE-2).** 0001 rebases cleanly. As you asked, we have not resolved it. The hunk, against main `eaa22f6e` (which has P0):
```
<<<<<<< main (P0, ERR-400)
    if (response.status >= 500 || response.status === 429) return prerenderUnavailable(clientMode);
=======  0002 FE-2
    if (response.status >= 500) return prerenderUnavailable();
    if (response.status === 404 && isEntityPrerender(prerenderPath)) {
      return notFoundResponse(await fetchShellHtml(url));
    }
>>>>>>>
```
**Proposed resolution:** keep both. That means the P0 line, followed by the FE-2 `404` block unchanged. Please confirm, or send a re-based 0002. Either way, the tree hash after the rebase will differ from `4ef169c7`.

**A question about FE-1 and the limit.** FE-1's human path (`injectedShell`) fetches `HEAD_PRERENDER_HOST` (`api.inkcartridges.co.nz`) `/api/prerender/*` with no proxy headers. On a Cloudflare cache MISS, every human visitor's head-inject fetch therefore shares the 30/min bucket of Vercel's egress IPs. The result is `X-Head-Inject: miss-status-429`: fail-open, but a miss. Your rule is "never send these headers to any host except `BACKEND`", so we have not added them there. Options:
- allow `api.inkcartridges.co.nz` as a host for the two headers;
- exempt the cached human path from the limiter;
- accept the misses and watch the `miss-*` rate in Stage A.

**Price refresh** (product GCART069HKBK):
- **Before reading, 06:58:** API `retail_price` 288.79; prerender JSON-LD `price` 288.79; prerender `cf-cache-status: HIT`, `age: 6`.
- **After reading:** needs a time after 15:30, and the Preview needs the bypass. Commands:
  ```
  curl -s https://api.inkcartridges.co.nz/api/products/GCART069HKBK            # retail_price
  curl -sI https://api.inkcartridges.co.nz/api/prerender/product/GCART069HKBK  # cf-cache-status, age
  curl -s -H "x-vercel-protection-bypass: $BYPASS" "$P/products/canon-genuine-cart069hkbk-toner-cartridge-cart069hk-black/GCART069HKBK" | grep -o '"price":"[0-9.]*'
  ```

**Production stages A, B and C:** not started. Each needs the owner's go-ahead, at least 48 h apart, and Stage A also needs the conflict above settled. The rollback point before ERR-400 is production deployment `2672da10` (`inkfrontend-fgqgemv88-omivies-projects.vercel.app`). ERR-400 itself is `eaa22f6e`.

## Item 32 (mobile speed)

Each claim, checked against `main`:
1. **"`body` and `main` fade in from opacity 0":** no longer true. That was deleted in Oct (ERR-370). The scroll reveal skips anything on the first screen.
   - We found one leftover and deleted it: `initStaggeredLists`.
   - On live `/cart` it started every cart line at opacity 0 with a 20 px slide (measured: `.cart-items` had `.stagger-children`).
   - It also covered order lines and any `.products-grid` present at init. The series grid was not affected: its container does not exist at init.
2. **`pages.css` split / inline critical CSS:** **declined again by the owner today** (first declined 2026-10-26; the repo has no build step).
3. **"30 scripts, put `defer` on them":** not true.
   - `index.html` has 26 external scripts. All are `defer` or `async` (including `gtag.js`) except `scroll-restore.js` (1.6 KB), which is parser-blocking on purpose.
   - `html/index.html`: all 25 are `defer`/`async`.
4. **Ink-finder logos:** done, in all 27 tags (`index.html`, `html/index.html`, `html/account/printers.html`).
   - Each tag has your `width`/`height` table (re-derived from the CSS heights and the aspect ratios; identical), plus `loading="lazy" decoding="async"`.
   - The finder's first logo sits at y = 1286 on 390×844 and at y = 988 on 1366×768, below the fold on both. On 1920×1080 it is at 990, which is inside the first screen; a lazy image in the viewport still loads at once.
   - **A CSS change your note did not cover:** `.ink-finder__brand-img { width: auto }`. Without it, the `width` attribute becomes the CSS width at the ≤ 600 px heights. Measured boxes changed: epson 65 → 78, hp 28 → 36, oki 44 → 56. With it, every box is identical to before.
   - **WebP at 2× display size:**

     | Logo | Size | Was (PNG) |
     |---|---|---|
     | brother | 410×96, 4,698 B | 41,633 B |
     | canon | 358×78, 3,690 B | |
     | epson | 171×42, 2,580 B | |
     | hp | 72×72, 2,696 B | 74,554 B |
     | lexmark | 243×48, 2,770 B | |
     | fuji-xerox | 280×56, 3,232 B | |

     All six together are 19.7 KB, against 218 KB as PNG. The PNGs stay: the shop page's logo map sends them through `/api/images/optimize`.
5. **JS images:**
   - Cart thumbnails: `width="70" height="70" loading="lazy" decoding="async"` (3 templates).
   - Order-detail thumbnail: `80×80`, same attributes.
   - Pack-offer thumbnail: `56×56`.
   - Related products, drilldown tiles and brand tiles were already lazy.
6. **PDP hero `width`/`height`: not done, by measurement.** ERR-374 (2026-10-26) added `800×800` and Lighthouse measured **CLS 0.307** on GLC233BK, against 0.00 without them. The frame already reserves the square (`.product-gallery__main { aspect-ratio: 1 }`). A test now pins "no width/height, never lazy" on the hero.

**Lighthouse** (`lighthouse@12`, median of 3, after the deploy): (07:00–07:10, 3 runs each, simulated slow 4G)

| Page | Perf | LCP | CLS | FCP | Target |
|---|---|---|---|---|---|
| Series `/shop?brand=epson&category=ink&code=288`, mobile | 70 | 7.92 s | 0.003 | 2.74 s | LCP < 4.0 s **missed**; CLS < 0.1 met |
| GLC233BK PDP, mobile | 70 | 8.31 s | 0.031 | 2.75 s | LCP < 4.0 s **missed**; CLS < 0.1 met |
| `/ink-cartridges`, desktop | 96 | 1.27 s | 0.009 | 0.87 s | CLS < 0.05 met |

The runs varied: series LCP was 11.60 / 7.91 / 7.92 s and GLC233BK 14.46 / 8.31 / 8.28 s; the first run of each was cold.
- On 2026-10-26 (ERR-374) the series page scored 67 with LCP 9.17 s, and GLC233BK had CLS 0.307, since fixed.
- LCP < 4 s is not reachable with what the FE can still change. The two levers your spec names are the CSS split (declined by the owner) and the product JSON edge cache (yours).
- The first frame shows the header and the h1 (FCP 2.7 s), with no fade.

## What we need from you
1. Confirm the conflict resolution above, or send a re-based 0002.
2. Decide FE-1 and the limiter: the `api.inkcartridges.co.nz` human fetch.
