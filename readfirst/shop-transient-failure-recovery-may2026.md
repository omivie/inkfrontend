# Shop transient-failure recovery — May 2026

**Status:** Shipped 2026-05-11.
**Pin:** `tests/shop-transient-failure-recovery-may2026.test.js` (25 tests).

## What the customer saw

Opens `/shop?brand=canon&category=ink` on a cold browser. The codes drilldown
flashes to:

> 🔍 **No products found**
> Failed to load products. Please try again.

Reloads the page. The exact same URL now renders 50+ Canon ink chips
correctly. Customer is left guessing whether the site is broken — and the
"Try again" instruction is a dead end because there's no button to click.

## Root cause

Two cooperating mistakes:

1. **api.js had no transient-failure retry.** `_fetchWithAuth` retried 429
   (rate-limit) and 401 (auth refresh), but a 5xx, network error, or
   timeout on an idempotent GET propagated up immediately. Render's free
   dyno cold-starts in 5–15s, and the first request on a cold visit
   routinely 502s before the upstream is ready.
2. **shop-page.js dumped both "really empty" and "fetch failed" into one
   `showEmpty(...)` pane.** Same SVG (magnifying glass), same `<h3>No
   products found</h3>`, no retry button — so a transient failure looked
   identical to a genuinely empty catalogue.

The combination produced the user-visible bug: the first attempt failed
quickly (api.js gave up), the failure painted into the "empty" pane with
no recovery path, and only a manual reload restored the user.

## The fix — two layers

### Layer A — api.js auto-retries idempotent GETs

`inkcartridges/js/api.js::_fetchWithAuth` adds a new `transientRetry`
counter to its opts threading, alongside the existing `retryCount`
(auth-refresh) and `rateLimitRetry` (429) counters.

Constants:

```
MAX_TRANSIENT_RETRIES: 2          // 3 total attempts
TRANSIENT_RETRY_BASE_MS: 300      // 300ms × 3ⁿ → 300ms, 900ms
```

Retries on, for `method === 'GET' || method === 'HEAD'` only:

- **Response status 500-599** — Render cold-start 502/503/504, brief
  upstream blip.
- **TypeError thrown by `fetch()`** — DNS, TLS, connection refused, the
  browser is offline.
- **AbortError thrown by our `REQUEST_TIMEOUT_MS` guard** — backend taking
  longer than our timeout (Render warm-up).

Never retries on:

- Any non-idempotent method (POST/PUT/PATCH/DELETE). Replaying a POST
  could double-charge Stripe, double-send a newsletter sub, etc.
- 4xx responses — those are definitive answers; retrying just wastes a
  round trip.

The structured 5xx envelope path still runs when retries are exhausted —
callers that want to surface a friendly message via `mapError` continue
to work.

### Layer B — shop-page.js distinct error pane + Retry button

New DOM (`inkcartridges/html/shop.html`):

```html
<div class="drilldown-error" id="drilldown-error" hidden role="alert" aria-live="polite">
  <svg ...refresh icon.../>
  <h3>We couldn't load products</h3>
  <p id="error-message">The server may be warming up. Please try again.</p>
  <button type="button" id="drilldown-retry-btn" class="drilldown-error__btn">
    <svg .../> Try again
  </button>
</div>
```

Styling (`inkcartridges/css/pages.css`) mirrors `.drilldown-empty` so the
container chrome matches, then adds primary-CTA styling for the button
with `:hover`, `:active`, `:focus-visible`, and `[disabled]` states.

New method `showError(message, onRetry)` in `shop-page.js`. Contract:

- Honours the same `_unloading` bfcache guard as `showEmpty` so a
  navigation-away reject can't poison the snapshot.
- Hides the empty pane (the two states are mutually exclusive).
- Wires the Retry button. On click:
  1. Disables itself (`cursor: progress`).
  2. Bumps `navigationVersion` so any zombie in-flight fetch from the
     first attempt can't paint over the retry's render.
  3. Shows the skeleton (`showLoading(true)`).
  4. `await onRetry(navigationVersion)`.

Listener is replaced on every call (via `cloneNode`) so successive
`showError` invocations don't stack click handlers.

`hideAllLevels()` and the `pageshow` bfcache handler both hide the error
pane.

The five loader-catch sites that previously called
`showEmpty('Failed to load products. Please try again.')` now call
`showError(...)` with a retry callback that re-invokes themselves:

| Loader                       | Retry callback                                  |
|------------------------------|-------------------------------------------------|
| `loadProductCodes`           | `(v) => this.loadProductCodes(v)`               |
| `loadProducts`               | `(v) => this.loadProducts(v)`                   |
| `loadPrinterProducts`        | `(v) => this.loadPrinterProducts(v)`            |
| `loadPrinterModelProducts`   | `(v) => this.loadPrinterModelProducts(v)`       |
| `loadSearchResults`          | `(v) => this.loadSearchResults(v)`              |

## What the customer sees now

Same `/shop?brand=canon&category=ink` cold-start scenario:

1. Skeleton renders immediately (was already the case).
2. First `/api/shop?...` returns 502. api.js waits 300ms, retries.
3. Second attempt returns 502. api.js waits 900ms, retries.
4. Third attempt: Render is warm, returns 200. Chips render.

Total user-visible delay: ~1.5s of skeleton, then the real grid — no
flash of "No products found", no need to reload.

If all 3 attempts fail (genuine outage):

1. `showError` paints the new pane with "We couldn't load products. The
   server may be warming up — please try again."
2. The Retry button is one click away from re-running the loader.

## What's NOT changed

- `showEmpty("No products found for this category.")` (and the other
  "No X found for Y" messages) — these are legitimate empty results, not
  failures. They keep the existing empty pane with no retry button.
- The one-shot 800ms ad-hoc retry inside `loadPrinterProducts` at the
  inner-try level (lines 1919-1930) — left in place as belt-and-suspenders
  insurance on top of the api.js layer. Cheap to keep.
- POST/PUT/DELETE — explicitly never retried (mutation safety).

## Test coverage

Run: `node --test tests/shop-transient-failure-recovery-may2026.test.js`

- **§1 source-contract (5 tests):** constants exist, opts threading,
  5xx/network/timeout retry branches gated on `isIdempotent`.
- **§2 behavioural (8 tests):** sandbox-loaded api.js with a mock fetch
  asserts `getProducts` retries on 503, `getShopData` retries on 502 (×2
  retries), GET gives up after 3 attempts, GET retries on TypeError, GET
  retries on AbortError, POST never retries on 5xx or TypeError, 4xx is
  not retried.
- **§3 shop-page.js wiring (8 tests):** element bindings, showError
  signature + `_unloading` guard + empty-pane hide, Retry button bumps
  navigationVersion + shows loading skeleton, every loader passes its
  own re-invoke as the retry callback, the old wording is gone,
  hideAllLevels + pageshow clear the error pane.
- **§4 HTML/CSS contract (4 tests):** pane exists with required ids,
  starts hidden, accessibility-tagged, CSS styling + hover/focus
  pseudo-classes.

Also updated: `tests/printer-not-found-redirect.test.js` — the
"retains a Please try again empty state" assertion was updated to expect
`showError(...)` with the printer-specific message and retry callback
(the slug-validation redirects are unchanged).
