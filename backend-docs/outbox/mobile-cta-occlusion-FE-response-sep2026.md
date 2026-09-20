# Mobile CTA occlusion + the SEO / CWV items — FE response

**Answers** `mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md` (2026-09-16, re-measured 2026-09-20).
**Filed** 2026-09-20. **Frontend: shipped.** `errors.md` ERR-276.

---

## The short version

The P0 is fixed and measured. **Three of your seven asks are not what the document says they are**,
and two of those would have shipped as fixes that changed nothing or broke something. Those three
are the first section here, because they are the part you most need back.

Nothing in this document is an opinion about your measurements — every one of them was reproduced.
Two of them were correct readings of a state that was not the state you thought you were in.

---

## 1. Three corrections, with the measurements

### 1a. The consent banner does NOT cover the sticky Add-to-Cart bar. It has not since ERR-238.

Your table reads:

| element | position | z-index | occupies | your verdict |
|---|---|---|---|---|
| `SECTION#consent-banner` | fixed | 600 | y 516–664 (148px) | covers the sticky bar |
| `DIV#sticky-atc` | fixed | 200 | y 515–582 (67px) | sits *under* the banner |

**Your own numbers show the lift was applied.** `.sticky-atc` carries
`transform: translateY(100%)` until `product-detail-page.js` adds `.is-visible`. With ERR-238's
`bottom: var(--consent-banner-height)` (148px) applied **and the bar in its hidden resting state**,
its box lands at y 516–583 — which is what you measured, to the pixel. With **no** lift it would
have been off-screen at y 664–731.

The bar was hidden because your run scrolled "so the main button is in view", and that is precisely
the state in which `product-detail-page.js:3127` removes `.is-visible`. It is an
`IntersectionObserver` on `.product-info__actions`: main CTA visible ⇒ sticky bar deliberately down.

> **A control that is correctly hidden is not a control that is blocked.**

The same artefact explains "clicking **Accept** flips `#add-to-cart-btn` from blocked to reachable
in the same session, with nothing else changed". Dismissing the banner calls `releaseSpace()`, which
removes 148px of `body { padding-bottom }`. The document reflows, the page slides up under a fixed
scroll offset, and the button moves out from under **the rewards nudge**. That is a scroll shift,
not causality — and it very nearly buried the real blocker, which was one row above it in your own
table.

Verified live, both before and after our fix, with the sticky bar in its **visible** state (scrolled
far enough that `.product-info__actions` leaves the viewport):

```
sticky ATC  y 637-687 (50px) · host #sticky-atc is-visible=true aria-hidden=false bottom=149px z=200
            verdict: reachable (elementFromPoint at its own centre -> button#sticky-atc-btn)
--consent-banner-height=149px, from a banner measuring 148.06px (consent-banner.js uses Math.ceil)
```

**So asks §1.2 and §1.3 need no code change.** Raising the bar's z-index above the banner — which
you correctly flagged as undesirable — is also unnecessary: the bar is *offset*, not *layered*, and
the offset is the banner's measured height kept live by a `ResizeObserver`.

What §1.2 and §1.3 did need was a check that cannot make this mistake again. Every control in
`npm run probe:mobile-cta` now reports its **state before its verdict** — `display`, `.is-visible`,
`aria-hidden`, whether its box is in the viewport — and a control that is hidden by design is
reported **NOT EXERCISED**. Never a pass, never a failure.

### 1b. The homepage count is 926+, it is yours, and it understates

`grep -rn "930"` across `inkcartridges/` returns **zero hits**. Measured on production:

| surface | `<meta name="description">` |
|---|---|
| `/` as a browser (our static `index.html`) | "Find the right ink cartridge for your printer in seconds…" — **already count-free** |
| `/` as Googlebot | "NZ-owned since 2008. **926+** ink cartridges & toner…" |
| `…/api/prerender/home` direct | **byte-identical to the Googlebot response** |

The string is authored by the prerender. The frontend's only involvement is `SeoMeta.reconcile()`,
which copies your title and description into the rendered DOM so the human and the crawler see the
same copy — deliberately, as an anti-cloaking measure.

So we cannot fix it, and **there is less to fix than you thought**: 926+ against roughly 3,270 live
ink + toner cartridges is an *under*-claim. Given the May 2026 suspension the risk worth guarding is
the number drifting **above** the catalogue, not below it.

**Ask for you:** either make it count-free, or keep it provably below the live count — and if you
want, expose the figure it is derived from so a probe on our side can assert
`claimed <= actual` rather than eyeballing it.

### 1c. §6a's fix is one level below where the space is actually lost

You attributed 0.464 of 0.472 to `DIV.shop-section-card` and asked us to reserve its height. The
attribution is right; the instruction does not reach the cause. Details in §3 — the summary is that
reserving that element's height does not work, because under your own throttling profile
DOMContentLoaded does not fire until ~5s, so **any JavaScript-applied reservation is itself the
shift**. Two different structural causes had to be fixed instead, and CLS is now 0.007.

---

## 2. §1 — the P0, fixed

**Cause.** `js/rewards-nudge.js` is two components. Above `Config.BREAKPOINTS.tablet` it is a small
popover anchored under the header Account button. Below it, `position()` makes it a
`position: fixed`, `vw − 24px` card at `--z-popover` (600) pinned at `header.bottom + 8px` and
re-pinned on every scroll. Its skip list was `['/cart']` and nothing else.

**One thing you should know, because it affects how you re-verify.** The occlusion is a *scroll
window*, not a state. The nudge is `fixed`, so it owns a constant band of the viewport (y 144–392 on
a 390×844 phone); `#add-to-cart-btn` is in normal flow, so it travels up through that band. The
button is unreachable for roughly 250px of scroll and perfectly reachable on either side of it. Our
first probe scrolled to a fixed offset and reported the button **reachable** on a definitively
broken build. It was not wrong about that pixel — it was asking at the wrong pixel. The probe now
computes the scroll offset that puts the button in the middle of the band and asks there.

**Before** (production, 2026-09-20):

```
worst case: scrollY 1027 puts #add-to-cart-btn inside the band y 144-392 (the mounted nudge)
inline ATC   y 244-292 (48px)
             verdict: blocked (elementFromPoint at its own centre
                      -> aside#rewards-nudge.rewards-nudge.rewards-nudge--card)
```

**After**, same viewport, same SKU, same scroll position:

```
inline ATC   y 244-292 (48px)
             verdict: reachable (-> button#add-to-cart-btn.btn.btn--primary)
nudge module suppressed=true postAddArmed=true
```

**What shipped**, against your ask §1.1:

- A narrow-viewport gate on the buying path. **All four URL spellings**: `/products/:slug/:sku`,
  `/product/:slug`, `/p/:sku` and the raw-file `/html/product/index.html`, plus `/cart`,
  `/checkout`, `/payment`. Your suggested regex `/^\/(products\/|cart|checkout|payment)/` would have
  missed `/product/:slug`, `/ribbon/:sku` and `/p/:sku`, and would have been dead on `npx serve`.
- Desktop is untouched, and that is asserted rather than assumed: the probe checks
  `suppressed === false` and "not in card mode" at 1440px on the same page.
- `/ink-cartridges` and the other browsing surfaces keep their nudge — also asserted.
- **The ask is moved, not deleted.** `js/cart.js` now dispatches a `cart:item-added` event at the
  add-to-cart toast and the nudge re-arms one-shot for that moment, gated so it can never land
  under the cross-sell modal.

**On the order-confirmation half of §1.1: deliberately not done, and we think you will agree.** That
page already carries a guest-gated `#create-account-prompt`, and the nudge would bail there anyway —
it anchors to `a.header-actions__item[href="/account"]` and the page runs the stripped
`.site-header--checkout`, which has no such link. Two account prompts on one page is not twice the
conversion. What *was* missing was the offer, so that card now carries the same earn/redeem claim
the nudge makes, pinned across all three surfaces so a rate change cannot land on only two of them.

**Note on `scripts/verify-mobile-cta-occlusion.js`.** It does not exist in this repo, nor does
`mobile-atc-occlusion-iphone13.jpeg` — both live in your tree. Our equivalent is
`npm run probe:mobile-cta`, and it carries a **negative control**: it injects an overlay over the
button and asserts the probe goes red, because an occlusion check that cannot report occlusion is
green for the rest of its life.

**Engine.** Playwright's WebKit was not installed here; it is now, and the probe runs on real
WebKit and **prints which engine it used**, falling back to chromium with a printed note rather than
silently claiming Safari.

---

## 3. §6 — Core Web Vitals

### 3a. CLS: 0.68 → 0.007, and `/ribbons` was missing from your table

Measured on your profile (Pixel-5, 4× CPU throttle, ~1.6Mbps):

| route | before | after |
|---|---|---|
| `/ink-cartridges` | 0.679 POOR | **0.007** |
| `/toner-cartridges` | 0.674 POOR | **0.007** |
| `/ribbons` | **0.607 POOR** | **0.001** |
| `/shop` | 0.089 | **0.001** |

`/ribbons` was not in your table and was as bad as the two that were.

**Two causes, neither of them "reserve height on `.shop-section-card`":**

1. **The empty level shell.** `#level-brands` shipped *visible and empty* while `#drilldown-loading`
   shipped *hidden*. So the page painted ~317px of empty section cards, and then — once scripts ran
   — `hideAllLevels()` removed them and the loading block jumped up into the gap. The skeleton was
   built to be the reservation and was never on screen when it mattered. The other three levels
   already shipped `hidden`; the brands level was the odd one out.
2. **The shelf opening into a page already on screen.** `#popular-row` sits above the brand picker
   (ERR-236 put it there deliberately) and was un-hidden only once `/api/products/popular` answered.
   `renderBrands` does not await it and `loadBrands` reveals the level as soon as `renderBrands`
   returns, so a 1,140px shelf opened on top of a page the shopper was already looking at. It is now
   un-hidden **synchronously, before the await**, with four placeholder cards holding the height.

**One thing worth passing on, because it nearly shipped as done.** Cause 2 is a race. With
`/api/products/popular` warm, the shelf landed before the level was revealed and `/ink-cartridges`
measured 0.007 — good, and pure luck. The same page on a cold cache measured **0.53**. A single
green measurement of a race is not evidence. `npm run probe:shop-cls` is committed, runs the four
routes, and refuses to score a page that never finished rendering.

### 3b. `G-YJXTSGLM28` was not deliberate. Removed.

Confirmed with the owner: not theirs. Removed from `js/gtag.js`.

Worth stating precisely, because "a property nobody sends events to costs nothing" is the intuition
that let it survive: every `gtag('config', …)` call makes the browser fetch **that destination's own
bundle** — ~187KB here — whether or not anything is ever sent to it. And every *unscoped* custom
event on the site (`contact_form_submit`, `faq_open`, `quote_started`) was being silently duplicated
into it, because an event with no `send_to` goes to every configured destination.

Verified on the wire: production requests three gtag bundles, the fixed build two. The destination
list is now pinned as an **exact set**, not a count — a count passes when one id is swapped for
another.

### 3c. Customer Reviews opt-in — already deferred

`footer.js` loads `apis.google.com/js/platform.js` with `async` on a dynamically-created script,
from inside `initFooter()`, which itself runs from a `defer`red module. It is already off the
critical path. The ~250KB is a product decision, as you say; we have not changed it.

---

## 4. Also shipped: the duplicate JSON-LD (§3)

Confirmed and fixed. Measured in a browser: **7 `ld+json` nodes on production after JS, 4 after the
fix** — Organization ×2, WebSite ×2, LocalBusiness ×2 collapsed to one each.

Your prerender was always clean (one Organization, one WebSite), so this only ever affected the
rendered DOM — i.e. Rich Results testing the live URL, and JS-executing crawlers. Lower severity
than the handoff implies, but real.

The static blocks in `index.html` are kept as the no-JS copy; they simply had no `id`, which is why
`js/schema.js`'s existing id-based dedupe could not see them. The fix is the `id`, not a deletion.

---

## 5. Not ours / already done

- **§2 (middleware query string)** and **§4 (`/cart?add=`)** were both implemented in parallel by
  other sessions — ERR-270 and ERR-269 respectively. §2 landed as an **allowlist** (`code`,
  `category`) rather than the full `url.search` you suggested, to avoid fragmenting the edge cache
  on `utm_*`/`gclid`; and it correctly landed on **both** sides, because `js/seo-meta.js`
  mirrors that branch and `SeoMeta.reconcile()` would otherwise have overwritten the code-specific
  title with the generic one on the same URL.
- **§5 (`POST /api/analytics/traffic-event` 500s)** — noted, yours.

---

## 6. What we need back

1. **The homepage count (§1b).** Make it count-free, or keep it provably below the live catalogue.
   If you expose the source figure we will assert `claimed <= actual` on our side.
2. **Reverse the ads stop-loss the day this deploys** —
   `node scripts/ads/pause-mobile-until-checkout-fixed.js --restore --apply`, your tree.
3. **Re-measure the 7-day mobile `checkout_started → completed` rate** as you planned. Our
   acceptance was "an Add-to-Cart control is tappable within 2s as a fresh guest without dismissing
   anything", and that now passes on real WebKit at 390×844 in 11ms. The funnel number is the one
   that settles it.

**Verification available to you:** `npm run probe:mobile-cta` and `npm run probe:shop-cls`, both
read-only, both printing their engine and profile, both carrying controls that fail when the check
itself stops working.
