# Mobile CTA occlusion — follow-up after the 2026-09-20 fix, re-measured 2026-09-21

Thanks — **the nudge fix landed and it works.** `#rewards-nudge` no longer mounts, and
`#add-to-cart-btn` is reachable on a phone for a first-time guest. That was §1 of
`mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md` and it was the important half.

Two things are still open. One is §2 of the original doc; the other was never in it and is
the bigger of the two, because it is where most paid traffic actually lands.

Method, so you can reproduce: Chromium 390x844, `context.clearCookies()` + `localStorage`
and `sessionStorage` cleared, navigated with `domcontentloaded`, then scrolled in steps
(300/700/1100/1500px) past the nudge's own 600px threshold with a 1.2s pause at each, then
`elementFromPoint` on each button's centre. Desktop 1600x1000 run as the control.

---

## ⚠ First: your verification script cannot currently verify anything

```
$ node scripts/verify-mobile-cta-occlusion.js
FAILED: page.goto: Timeout 60000ms exceeded.
  - navigating to "https://www.inkcartridges.co.nz/products/...", waiting until "networkidle"
```

It waits on `networkidle`, which never settles on this site — something keeps a connection
open (analytics beacon or a poll). So the script times out on **every** run and reports
`FAILED` whether the page is fixed or broken. It cannot tell you the fix worked, and it
cannot tell you what is below is still broken.

Swap the wait: `waitUntil: 'domcontentloaded'` plus an explicit `waitForTimeout(2000)` and
the stepped scroll above. Until then, please do not read its red as a real signal.

---

## 1. Category pages — 0 of 4 Add buttons reachable (NOT in the original doc)

**This is the one that matters most: 68% of all paid clicks land on `/ink-cartridges`, not
on a PDP.** The original handoff only ever measured product pages, so this surface was
never in scope and is still fully blocked.

Measured on `/ink-cartridges`, 390x844, first-time guest:

| element | position | z-index | occupies | verdict |
|---|---|---|---|---|
| `#consent-banner` | fixed | 600 | y 696–844 | covers the first row of cards |
| card 1 Add button | relative | auto | y 826–872 | **BLOCKED** by the banner |
| card 2 Add button | relative | auto | y 826–872 | **BLOCKED** by the banner |
| card 3 Add button | relative | auto | y 1304–1350 | below the fold |
| card 4 Add button | relative | auto | y 1304–1350 | below the fold |

Desktop control, 1600x1000: **4 of 4 reachable.** Same page, same moment.

Two separate causes, and both need a decision:

1. **The banner covers the only two buttons on screen.** Same root cause as §2 below.
2. **826px of chrome sits above the first buy action** in an 844px viewport. Even with the
   banner gone, the first Add button is 18px above the fold. The stack above it is: logo
   bar, phone number row, search bar, breadcrumb, free-shipping strip, `<h1>`, section
   heading `Popular ink cartridges right now`, then the card image. The `<h1>` alone starts
   at y313 — nearly halfway down the first screen before the page says what it is.

Worth considering for the ad landing experience specifically: the products above the fold
render as grey `COMPATIBLE` placeholder tiles rather than photographs
(`…/compatible-tile-v1.png`). Someone arriving from a "canon ink cartridges" ad sees two
grey squares. That is a separate piece of work, flagged here only because it shares the
same real estate.

## 2. PDP sticky bar — still painted under the consent banner (§2 of the original)

Reproduced identically on two product pages:

| page | `#sticky-atc-btn` | `#consent-banner` | verdict |
|---|---|---|---|
| `…/C43XBK` | y 694–744 | y 686–834 | **BLOCKED** |
| `…/CLC73BK` | y 704–754 | y 686–834 | **BLOCKED** |

`#sticky-atc` is `fixed` at z-index **200**; `#consent-banner` is `fixed` at z-index
**600**. The bar is painted underneath by design, so the overlap is essentially its whole
height.

The original ask still stands and is still the right shape: **offset the sticky bar by the
banner's height while the banner is open** (and restore it on dismiss). Please do not fix
this by raising the bar's z-index above 600 — that puts a buy button on top of a consent
notice, which you do not want for the obvious reason.

Note the main `#add-to-cart-btn` is now fine, so this is the second-order path — it matters
for shoppers who scroll past the inline button, not for the primary flow.

---

## Why this is worth doing promptly

Mobile currently converts at **1.79%** against desktop's **6.46%** on the same campaigns,
at **$88.87** cost per order against desktop's **$46.46** — and mobile takes slightly more
ad impressions than desktop (6,919 vs 6,719 over 30 days). Those figures pre-date your
nudge fix, so treat them as the size of the prize rather than a current score; we will
re-measure once these two land.

Because the category page is still blocked, mobile has been switched off at the ad-group
level for the two biggest generic ad groups as a stop-loss (applied 2026-09-20 18:40). It
gets restored the day these ship — that is roughly 10 additional orders a month on traffic
that is already being paid for.

Page speed is **not** a factor and needs no work: TTFB 108ms, FCP 420ms, load 1.01s.
