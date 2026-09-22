# Mobile Add-to-Cart dead zone — fixed, and it was wider than the sweep found

Reply to `mobile-atc-dead-zone-FE-handoff-sep2026.md` and
`mobile-cta-occlusion-followup-sep2026.md`. Front end, 2026-09-22. Logged as **ERR-280**.

**Both handoffs were right about the mechanism.** The sticky bar was retiring into the
band the consent banner owns, and the dead zone is real, reproducible and now closed.
Thank you for the scroll sweep in particular — sampling across offsets rather than at one
is what made it findable at all, and we have rebuilt our probe around that idea.

Three things below will matter to you: the defect was wider than your table, two of the
commands in your documents point at files that do not exist in our tree, and one of your
two asks was already shipped in a better shape.

---

## 1. Fixed, with the measurement either side

`js/product-detail-page.js` built its handover like this:

```js
const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) { stickyBar.classList.remove('is-visible'); … }
}, { threshold: 0 });
observer.observe(actionsContainer);
```

You diagnosed the missing occlusion term exactly. Two details differ from your write-up,
and both make it worse than you measured:

**The visibility test was not 60%, it was zero.** There was no `threshold: 0.6` — a single
pixel anywhere in the viewport retired the bar.

**It watched the container, not the button.** On a phone `.product-info__actions` is a
two-row grid: quantity stepper on top, Add to Cart beneath it. The container's top edge
enters the viewport about 56px before the button's does, so the bar handed over while the
button was still under the banner *or still below the fold entirely*.

It watched the container for a real reason — `#add-to-cart-btn` is replaced wholesale via
`outerHTML` with a Contact us link on out-of-stock products, and a held reference would
observe a detached node. Both spellings carry `.product-info__add-to-cart`, so the fix
re-resolves that class and re-points the observer when the swap happens.

**Occlusion turned out to have two edges.** With your banner inset in place, our sweep
still found a dead window at scrollY 1200: the button sat at y 33-81 and `elementFromPoint`
at its centre returned `div.logo-block`. `.site-header` is `position: sticky; top: 0`
below 1100px at the *same* `--z-sticky` (200) the bar uses. The root is now shrunk at both
ends, from each layer's measured box.

Measured on real WebKit at an iPhone 13 profile, sweeping every 40px of scroll:

| | dead windows |
|---|---|
| before | scrollY **587-785** and **1187-1427** |
| after | **none** — 117 offsets, all tappable |

Your two named offsets, 600 and 1200, both land inside those windows. And our old
per-control check passed in the same run that found them, which is section 3 below.

We did **not** raise the bar above z-index 600. You were right that that trades a
conversion bug for a compliance one.

## 2. Two commands in your documents do not resolve here

This is not a quibble about naming — we could not reproduce your evidence, and we would
rather say so than quietly assume we know what you ran.

**`scripts/verify-mobile-cta-occlusion.js` has never existed in this repository, in any
branch** (`git log --all --diff-filter=A` finds no such file). The real artefact is
`scripts/probe-mobile-cta-occlusion.mjs`, run as `npm run probe:mobile-cta`. It has never
used `networkidle` — all three of its navigations are `domcontentloaded`, and the only two
live `networkidle` navigations anywhere in `scripts/` use a 45000ms timeout, not the
60000ms in your error. So whatever produced

```
FAILED: page.goto: Timeout 60000ms exceeded.
  - navigating to "…", waiting until "networkidle"
```

is not in our tree. If it is a script on your side we would like a copy, because a second
opinion on this surface is worth having.

**`scripts/ads/pause-mobile-until-checkout-fixed.js` is also absent here.** We assume it
lives with your ad tooling; we have no way to run the restore.

**`--check` was already the only mode.** The probe exits 1 while the defect is present and
0 when it is not, so there was nothing for the flag to switch. We now accept `--check` as
a documented alias so your command line runs as written — and we now *refuse* unknown
flags rather than ignoring them, so a typo cannot come back as a clean run.

## 3. Why it stayed hidden, which is the part worth keeping

Every control involved was in a defensible state at the same moment. The sticky bar was
**correctly hidden** — the site had decided the main button was in view. The main button
was **correctly rendered** — something was merely painted on top of it. Neither is a bug
on its own.

Our probe was green throughout, and for a good reason: after the last round it was
carefully taught that *a control which is correctly hidden is not a control that is
blocked*, and it reports such a bar as `hidden-by-design`, never as a failure. That rule is
right about a **control**. Asked one level up it hides the defect completely. A 6,532-test
suite was green too.

So the question changed. `probe:mobile-cta` now asks the shopper's question — **is any
Add to Cart tappable at this scroll offset** — swept across the whole document, and reports
dead windows in px of scroll with the offsets named. Two further details you may want in
your own tooling:

- **Each offset is sampled twice**, before and after the bars stop moving. A sample taken
  mid-transition measures the 0.3s animation; the defect worth failing over is the one that
  does *not* resolve on its own. Conflating them makes every CSS transition a failure.
- **Blockers are classified by DOM ancestry, not by the printed label.** Our element
  describer prints at most two classes, so a blocker deep inside the header reads as
  `input#search-input` with nothing about the header in it — an allowlist over that string
  would admit the header under one spelling and fail it under the next.

## 4. Your §2 was already fixed, in a better shape

You asked for:

```css
body:has(.consent-banner.is-open) .sticky-atc {
  bottom: calc(var(--consent-banner-h, 148px) + 8px);
}
```

That shipped in September as ERR-238, as:

```css
body.has-consent-banner .cart-sticky-bar,
body.has-consent-banner .sticky-atc,
body.has-consent-banner .filter-sort-bar {
    bottom: var(--consent-banner-height, 0px);
}
```

Three differences that are worth the difference: it keys off a body class the banner
already sets rather than `:has()`, it uses the height `consent-banner.js` *measured* from
the rendered box rather than a 148px fallback (the bar is 61px on a desktop and re-wraps
whenever anything changes its padding — a stale constant is how 17px of the ERR-233
collision came back), and it covers the cart bar and the shop filter bar as well.

The numbers in your follow-up table are consistent with that rule already being live: what
you measured at y 694-744 is the bar's *hidden resting position with the lift applied*.
Which, awkwardly, turned out to be its own small bug — see below.

## 5. Two more defects the sweep surfaced

**A hidden bar was still eating the tap.** `transform` animates over 0.3s, so through
every slide the bar is a painted, hit-testable box crossing content it offers nothing to.
Worse, the ERR-238 lift raises it ~149px while `translateY(100%)` pushes it back only its
own 67px — so the *resting hidden bar* sits at y 515-582 in a 664px viewport, on screen,
invisible only because the banner paints over it. It now carries `pointer-events: none`
while hidden. It had been saying this to assistive technology via `aria-hidden` all along.

**The category page, which is your §1.** You attributed it to the consent banner. The
banner is part of it — but the larger blocker was our own rewards nudge, a 366x248 card
fixed at z-index 600 that mounts at scrollY 600, which is exactly where the product grid
is. Measured: it covered a card Add button at **32 of 92 scroll offsets** on
`/ink-cartridges`.

The previous round had stopped that card covering the PDP buy button by adding routes to a
skip list — so the fix was only ever as complete as the list, and the route it did not name
is the one 68% of paid clicks land on. Below the tablet breakpoint the card is no longer an
overlay at all: it is inserted into the document just below the fold and the shopper
scrolls into it. It covers nothing, and it costs no CLS, because a layout shift of content
nobody can see scores none — `/ink-cartridges` measures 0.0088 against a 0.1 threshold,
unchanged.

What remains on that page is the two chrome bands themselves — the sticky header at the top
and the consent banner at the bottom — each covering a card for its own height as the card
scrolls through it, cleared by a flick and removed entirely once consent is answered. Our
probe now asserts that *nothing else* ever covers a card Add button.

## 6. On the 826px of chrome

Two corrections, offered because the number will mislead whoever reads it next.

**It is a scroll-0 reading.** `main.js#initStickyHeader` already collapses the phone-number
row (~44px) once the shopper passes 80px, so the header slims itself the moment anyone
moves.

**Most of it is not chrome.** Measured at a true 390x664 viewport, the first card Add
button sits at y881, which splits as **410px of chrome and 471px of card**: image 117,
title 68, colour and stock 41, price + GST + cost-per-page 45, business-price block 83,
quantity stepper 46. No amount of chrome trimming puts that button above a 664px fold.

The two levers that would are both commercial decisions rather than front-end ones, so we
have left them with the owner rather than making them quietly: the free-shipping pill that
becomes a full-width row below 480px (currently pinned deliberately by a test whose own
rationale was reclaiming that same ~40px), and the business-price block shown publicly on
every card. We would rather report the measurement than ship a 20px trim as an answer to
"826px".

Your note about the grey `COMPATIBLE` tiles is understood as separate work and has not been
touched.

## 7. One correction that affects every mobile number either of us has quoted

Your method says 390x844. **`devices['iPhone 13'].viewport` is 390x664.** 844 is the
physical screen; 664 is what is left after Safari's URL bar and toolbar.

The missing 180px is *larger than the consent banner*, so at 844 the sticky bar and the
banner do not overlap and at 664 they do. Every mobile probe in our repo hand-set 390x844
too — eight of them — so this is our finding about ourselves as much as a note about your
method. All eight now take the box from Playwright's device registry rather than retyping
it. We kept the old box under the name `PHONE_SCREEN_844`, because deleting it would not
make our earlier figures wrong, it would make them uncomparable with nothing explaining
why a re-run prints a different number.

One consequence you should know about: our layout-shift figures for the shop family move
from 0.007 to 0.0088 at the corrected viewport. The instrument moved, not the page.

## 8. One thing we would ask of you

Since the Microsoft UET tag went in, **every product page view fires `view_item` into UET
and GA4**, and your own UET notes single that event out as manufacturing a revenue-bearing
conversion in the live account. Our probe's READ-ONLY banner was true of our database and
false of our ad accounts.

`PROBE_BASE` now defaults to `http://localhost:3000`, and a production run is opt-in and
prints what it is about to fire. If you have tooling that loads PDPs in a browser against
production, it is worth checking for the same thing.

## How to verify

```sh
npx serve inkcartridges -l 3000
npm run probe:mobile-cta            # or: npm run probe:mobile-cta -- --check
```

Expect `15 passed, 0 failed, 0 not exercised`. Section 6 is the PDP sweep, section 7 the
category sweep, sections 5 and 8 are negative controls that prove the probe and the sweep
can still go red.

```sh
node --test tests/mobile-atc-dead-zone-sep2026.test.js   # 26, runs the shipped code in a vm
bash scripts/redproof-mobile-atc.sh                      # 28 mutations, 28 caught
```

**The exclusion can be lifted** on `Ink NZ` and `Toner NZ` once this is deployed and you
have re-run the probe against production yourself. We would rather you confirmed it from
your side than took our localhost run for it.
