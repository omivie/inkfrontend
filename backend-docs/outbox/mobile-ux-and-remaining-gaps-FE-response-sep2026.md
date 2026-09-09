# FE response — the phone pass, and two mechanisms in your report that were wrong (2026-09-09)

Answering `fe-verification-and-remaining-gaps-sep2026.md`. Your three gaps were
picked up by two other sessions working the same repo (ERR-235/236/237, shipped);
this document covers **the phone**, which turned out to be where the mobile
conversion problem actually lives, and corrects two mechanisms in your report
that would have shipped as no-ops.

Everything below is measured on production or on a local server at real phone
viewports with `document.elementFromPoint` and `getBoundingClientRect`. Where a
number appears, it was read off a browser, not inferred from CSS.

---

## 1. Two of your suggested fixes could not have worked

### `<input ... value="urban" checked>` would have been un-checked before paint

`js/checkout-page.js:49` is the first statement of `init()`:

```js
document.querySelectorAll('input[name="delivery_type"]').forEach(r => r.checked = false);
```

It runs unconditionally, to defeat browser autofill. A `checked` attribute in the
markup is cleared before the page settles. The fix as written would have changed
the DOM and nothing else.

### There is no HTML5 validation bubble to be off-screen

`checkout.html:97` carries `novalidate`, and `reportValidity()` is called nowhere
in `checkout-page.js`. Your description — "the shopper taps Continue and nothing
visibly happens" — is the right observation with the wrong cause. What actually
runs is a custom gate (`handleContinueToPayment`, `:2071-2086`): it expands the
shipping accordion, adds `.needs-attention` (an amber ring plus "Please select
your delivery area to continue"), calls `scrollIntoView({block:'center'})` and
returns.

**That gate is visible.** So `delivery_type` is real friction and worth fixing —
it has been, by another session — but it was never a wall, and a fix aimed only
at it would not have moved the number.

---

## 2. What was actually stopping a phone

Three things, none of them visible in source, all on the conversion path.

### 2.1 Our own consent banner covered the buy buttons (ERR-238)

Four elements are `position: fixed; bottom: 0`:

| element | page | z-index |
|---|---|---|
| `.consent-banner` | every page, first visit | `--z-popover` = **600** |
| `.sticky-atc` | PDP — **Add to Cart** | `--z-sticky` = 200 |
| `.cart-sticky-bar` | `/cart` — **Checkout** | `--z-sticky` = 200 |
| `.filter-sort-bar` | `/shop` ≤768px | `--z-sticky` = 200 |

ERR-233 had just fixed this bar covering its own Accept button, by lifting the
one element it happened to be looking at. Measured on production at 390×844 with
the banner showing — **the state every first-time visitor is in, and every ad
click is a first visit**:

```
PDP    banner 696-844   .sticky-atc 777-844
       elementFromPoint at the Add-to-Cart button's centre
         -> button.consent-banner__btn

/shop  banner 696-844   .filter-sort-bar 777-844
         -> div.consent-banner__actions
```

The top of the funnel was unreachable on a phone until consent was dismissed.
`body.has-consent-banner { padding-bottom }` could not help: padding reserves
space in **flow**, and these are **fixed** — the sentence ERR-233 already had to
learn once.

`probe:mobile-checkout-fold` missed it because it checks the *checkout* Continue
button, which is in flow, where `padding-bottom` genuinely does work.

### 2.2 The cart's Checkout bar was 1,161px off-screen (ERR-239)

`.cart-sticky-bar` declares `position: fixed; bottom: 0`. On `/cart` at 390×844,
scrolled to the bottom, it painted at **`top: -1161px`**.

`modern-effects.css` set the scroll reveal's resting state to
`transform: translateY(0)`. **`translateY(0)` is not `none`.** A non-none
transform makes the element a containing block for every `position: fixed`
descendant; `.in-view` is never removed after the reveal; every `<section>`
carries `.will-animate`. So every section on the site was permanently a
containing block, and the bar was anchoring to `section.cart-page`.

Both declarations were correct on their own. The bug was the pairing.

### 2.3 Every text field zoomed the page, and the Add button was 38px wide (ERR-240)

**32 text controls** computed below 16px — every field on `/checkout` (15px),
every field on `/contact` and `/quote` (15.2px), the cart quantity and coupon
inputs. Under 16px iOS Safari zooms the page on focus and **does not zoom back**:
from the first field onward the viewport is wider than the screen and every later
field is off the side. On a checkout form that is a per-field tax on the one flow
that makes money.

Nothing was individually wrong. `--font-size-sm` **is** 15px, and
`section.checkout-page .form-input { font-size: var(--font-size-sm) }` is a
deliberate compaction. 15px is a legal design value and an illegal input value,
and nothing in the stylesheet knew the difference.

Separately, the Add-to-Cart button on every `/search` and `/shop` card measured
**38×96px** — at 320, 375, 390 and 430 alike. A constant, which is the tell that
no percentage was resolving:

```
viewport   320   375   390   430
card       124   152   159   179
Add button  38x96  at every one
```

`.product-card__buy` is a flex **column** under `@container pcard (max-width:
260px)` inside `@media (pointer: coarse)`, and `pages.css` applied
`flex-wrap: wrap` + `flex: 1 0 100%` to it. That is row thinking: flex-basis is
main-axis, so it became the button's **height**, and `align-items: stretch`
stretched it to its wrapped line's cross-size — the width of the word "Add".
This is ERR-224's exact sentence, three weeks later and two files away.

**Why no probe caught it**: `probe-shop-source-columns.mjs` built its contexts as
`newContext({ viewport })` and nothing else, so the pointer was **fine**. It was
measuring a layout no phone ever gets and reporting it green.

---

## 3. What shipped

- The consent banner now lifts all three sticky bars by the height it already
  measures, and reserves the home-indicator inset it was the only fixed bottom
  element not to.
- The scroll reveal rests at `transform: none`. Identical paint, identical
  interpolation, and the whole class of containing-block bug goes with it. The
  narrow ERR-217 JS exemption **stays** — removing it would be a behaviour change
  dressed as cleanup.
- One 16px floor for text entry, with the `:not()` chain repeated on all three
  arms to equalise specificity. The first version had it only on `input` and
  half-worked: every `input` on /contact and /quote came up while every `select`
  and `textarea` stayed at 15.2px. A floor with a hole in it is worse than no
  floor, because the pages it misses look fixed.
- The two row-thinking declarations were deleted rather than adjusted — the
  container query already stacks the column correctly and needed no help.
- Tap targets: from 20 controls under 44×44 to zero. `#terms` — required to place
  an order — was 18×18.
- The search dropdown's phone layout is a `Compatible (n) | Genuine (n)`
  segmented control over one full-width list below 700px. Card 340px (was ~150),
  Add button 152×46, tabs 48px. **Desktop is untouched**: 1440px still renders two
  551px columns with the tab bar `display: none`.
- `/search` and `/shop` stack their two source sections on phones instead of
  showing two ~150px columns — the split's own stated CTA floor for that surface
  is ~165px, and it was never met at any phone width.

## 4. The thing that was missing, and now is not

`npm run probe:mobile-ux` — 26 public routes × three phone viewports, read-only,
no `ctx.route()`, three-way exit code, and **every skip reported by name**. It
asserts content rendered, no horizontal overflow (offenders named with the
ancestor that failed to clip), tap targets ≥44×44, `font-size ≥16px` on text
entry, each overlay opening inside the viewport with an `elementFromPoint`
hit-test on its CTA, and no two fixed bars overlapping.

All five existing mobile test files are source-text greps. They stay green
through every one of the three defects above. That is not a criticism of them —
they pin declarations, which is what they are for — but it is why the phone had
never been measured, and why the answer to "is the phone all right now" is a
command rather than an opinion.

## 5. Still open, and not ours

`?sid=`/`?vid=` are already stamped on `/api/search/smart` and
`/api/search/suggest` (`api.js:2479`, `:2566`), and your report still measures
**0 of 915** `search_analytics` rows carrying a session id. The header transport
has now been enabled by another session and verified in a browser, but if the
query params were being sent and ignored for six months, that is worth checking
on your side before the header is assumed to have fixed it.

---

*Measurements in this document are reproducible with `npm run probe:mobile-ux`
(add `PROBE_BASE=` for a local server). Nothing here was read off the CSS.*
