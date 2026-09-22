# Mobile Add-to-Cart dead zone — diagnosis and fix, 2026-09-21

**One-line:** on a phone, for a first-time visitor, there are scroll positions
with **no tappable Add-to-Cart at all** — the sticky bar has already stood down,
and the main button is underneath the consent banner.

Reproduce with `node scripts/verify-mobile-cta-occlusion.js --check` (exits
non-zero while the defect is present). Desktop is included as the control and
must keep passing, or suspect the probe rather than the page.

## Why this kept being reported "fixed" and then "broken"

It was measured three times in one hour with three different answers. None of
the measurements were wrong; they sampled **different scroll offsets**, and
reachability is a function of scroll offset. Swept across the page on an
iPhone 13 profile:

| scrollY | main ATC | sticky bar | tappable? |
|---|---|---|---|
| 0 | not rendered | 3/3 @ y457 | yes |
| **600** | **0/3 @ y644** | **0/3 @ y524** | **NO** |
| 900 | 3/3 @ y344 | 0/3 @ y524 | yes |
| **1200** | **0/3 @ y44** | **0/3 @ y524** | **NO** |
| 1800 | not rendered | 3/3 @ y457 | yes |

Two of twelve positions on `C43XBK`, two of fifteen on `C37ABK`. A probe that
samples one offset has a good chance of landing on a passing one.

**Two further traps for whoever re-tests this:**

1. **Use a real device profile, not a resized window.** `devices['iPhone 13']`
   has a *usable viewport of 390x664* after browser chrome — not 390x844, which
   is the physical screen. At 844 the geometry does not overlap and everything
   looks fine. At 664 it overlaps. Setting a 390x844 viewport by hand is what
   produced a false "it's fixed".
2. **Wait for the banner to finish animating.** `.consent-banner` carries
   `will-animate in-view` for a moment after load; probing during it returns a
   false pass because the element has not reached its final position.

## The mechanism

On a 664px viewport:

```
.consent-banner   y516..664   height 148   position: fixed   z-index: 600
.sticky-atc       y515..582   height  67   position: fixed   z-index: 200   bottom: 149px
```

The bar is painted underneath the banner, so every point on `#sticky-atc-btn`
hit-tests to `SECTION.consent-banner`.

That alone would be survivable — the main button is still there. The dead zone
appears because **the sticky bar retires as soon as the main button is "in
view", and the visibility test counts the bottom 148px of the viewport as
visible.** That is exactly the band the consent banner occupies. So the bar
hands over to a button that is itself underneath the banner, and for that span
of scroll there is nothing to tap.

Dismissing the banner removes the dead zone completely. That is why it only
affects first-time visitors, and why staff — who all have consent cookies — have
never once seen it. The owner said "our mobile is fine" and was right about what
they saw; both things are true at the same time.

## The fix

In whatever hides the sticky bar (IntersectionObserver or scroll handler), the
main button must not count as visible while it sits under the banner. Give the
observer a bottom root margin equal to the banner's height whenever
`.consent-banner.is-open` is present:

```js
// the banner occludes the bottom of the viewport; a button under it is not visible
const banner = document.querySelector('.consent-banner.is-open');
const occluded = banner ? Math.ceil(banner.getBoundingClientRect().height) : 0;

new IntersectionObserver(onChange, {
  rootMargin: `0px 0px -${occluded}px 0px`,
  threshold: 0.6
});
```

Re-create (or update) the observer when the banner opens and closes, since the
margin changes with it.

As defence in depth, also stop the bar being painted under the banner. Publish
the banner height as a custom property and offset the bar by it — verified live
on 2026-09-21, both the bar and the banner's own Decline/Accept stayed reachable
afterwards:

```css
body:has(.consent-banner.is-open) .sticky-atc {
  bottom: calc(var(--consent-banner-h, 148px) + 8px);
}
```

`:has()` is supported in the target browsers (verified in-page:
`CSS.supports('selector(:has(*))') === true`).

**Do not fix this by raising `.sticky-atc` above `z-index: 600`.** The bar would
then cover the banner's own text, which has to stay readable — that trades a
conversion bug for a compliance one.

## Why it matters commercially

Mobile is 65% of paid clicks and converts at 0.73% against desktop's 6.39% —
$442.39 of spend for 4 conversions in 30 days. Mobile is currently excluded at
-100% on the two generic ad groups (`Ink NZ`, `Toner NZ`) precisely because of
this. The Conquest groups deliberately keep mobile: someone typing a
competitor's name has already decided and converts at a $24.01 CPA, inside
break-even.

**When `--check` passes, tell the backend** and the exclusion is lifted with
`node scripts/ads/pause-mobile-until-checkout-fixed.js --restore --apply`.
Guard rule R7 is the stop-loss on the other side: Search mobile spending $50
over 5 days with zero conversions raises an alert to put the exclusion back.
