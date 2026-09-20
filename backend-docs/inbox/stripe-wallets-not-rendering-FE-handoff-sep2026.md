# Apple Pay / Google Pay are not rendering — FE handoff (Sep 2026)

**Audience:** Storefront SPA developer
**Backend owner:** ink_backend
**Status:** One required FE fix (CSP), one verification step (Safari). No backend change.
**Supersedes nothing** — extends `stripe-link-express-checkout-fe-spec-jul2026.md`, which shipped the Express Checkout Element (ECE) on `/payment`.

---

## TL;DR

The wallet row on `/payment` has **never produced a single payment**. Not one Apple Pay,
not one Google Pay, in the entire live charge history.

```
173 live charges, 2026-03-10 → 2026-09-17
  card        118
  link         46
  card/link     9
  apple_pay     0
  google_pay    0      ← including Aug (59 charges), well after ECE shipped in Jul
```

Everything on the Stripe side is correct (verified against the live account, below). The one
defect found is in the **storefront's `Content-Security-Policy`**: it is missing four entries
Stripe documents as required, including the two for **Link — which is 24% of our payments and
is currently riding an undocumented fallback.**

---

## Already verified — do NOT re-check these

| Thing | State |
|---|---|
| `payment_method_domains` → `www.inkcartridges.co.nz` | registered, `enabled: true` |
| ↳ `apple_pay` | `status: active` |
| ↳ `google_pay` / `link` / `klarna` / `paypal` / `amazon_pay` | `status: active` |
| Pinned PMC `pmc_1SmAm80gOo8rzNMQdYWvtJFA` | `apple_pay=on google_pay=on link=on card=on klarna=on` |
| `js/payment-page.js` `initExpressCheckout()` | correctly implemented — separate Elements instance, deferred intent, Turnstile gated at `click`, `paymentFailed()` on every pre-redirect failure |
| `#express-checkout-wrapper` in `/payment` DOM | present |
| Totals gate before ECE mount | passes (`loadCart()` is awaited before `initStripe()`) |
| `Permissions-Policy` header | `camera=(), microphone=(), geolocation=()` — `payment` unrestricted, defaults to `self`, Stripe delegates via its own iframe `allow` attribute. **Not the problem.** |
| `/.well-known/apple-developer-merchantid-domain-association` | 404s, and that is **fine** — Stripe handles Apple merchant validation for `payment_method_domains`. Do not add the file. |

---

## Fix 1 (required) — four missing CSP entries

Stripe's [integration security guide](https://docs.stripe.com/security/guide) lists the full
required set. We are missing four. This is the class of bug that **passes every server-side
test and every `curl`** — only a real browser refuses the frame.

The tell: `frame-src` already carries `https://pay.google.com`. Someone added the Google half
of the wallet support and never the Stripe/Link half.

### `frame-src`

```diff
- frame-src https://js.stripe.com https://pay.google.com https://challenges.cloudflare.com https://*.paypal.com https://*.paypalobjects.com https://www.google.com
+ frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://link.com https://*.link.com https://pay.google.com https://challenges.cloudflare.com https://*.paypal.com https://*.paypalobjects.com https://www.google.com
```

- `https://*.js.stripe.com` — Stripe.js starts Element frames on separate origins where
  permitted; blocked, it silently degrades.
- `https://hooks.stripe.com` — **3D Secure challenge iframes.** A card that triggers a 3DS
  step today has nowhere to render it.
- `https://link.com`, `https://*.link.com` — Link's auth UI and static assets
  (`checkout.link.com`, `statics.link.com`). Link is 46 of our last 173 charges.

### `script-src`

```diff
- script-src 'self' https://cdn.jsdelivr.net https://js.stripe.com ...
+ script-src 'self' https://cdn.jsdelivr.net https://js.stripe.com https://*.js.stripe.com ...
```

### `connect-src`

```diff
- connect-src 'self' ... https://*.stripe.com ...
+ connect-src 'self' ... https://*.stripe.com https://link.com https://*.link.com ...
```

`https://*.stripe.com` already covers `api.stripe.com` — only the Link domains are missing.
`img-src` is `'self' https: data:`, which already covers `*.link.com`. No change needed there.

### Ready to paste — the complete corrected header

Generated from the header live on `www.inkcartridges.co.nz` on 2026-09-19, with only the seven
additions above; every existing entry is byte-identical. The rule is global — it is served on
every path including static assets and 404s — so there is exactly one place to change it
(Vercel `vercel.json` `headers` / `_headers`, or a Cloudflare Transform Rule; whichever owns it
on your side).

```
default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://js.stripe.com https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://static.cloudflareinsights.com https://challenges.cloudflare.com https://www.paypal.com https://*.paypal.com https://*.paypalobjects.com https://apis.google.com https://*.js.stripe.com 'sha256-n8SeBQJ44hfg74TlDOKj4U2ORkgMfIj5ms8CC25yEBk='; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://*.google.co.nz https://api.inkcartridges.co.nz https://ink-backend-zaeq.onrender.com https://*.supabase.co https://*.stripe.com https://*.google-analytics.com https://www.googletagmanager.com https://*.google.com https://*.doubleclick.net https://www.googleadservices.com https://cdn.jsdelivr.net https://challenges.cloudflare.com https://static.cloudflareinsights.com https://*.paypal.com https://*.paypalobjects.com https://fonts.googleapis.com https://link.com https://*.link.com; base-uri 'none'; object-src 'none'; form-action 'self' https://www.paypal.com https://*.paypal.com https://js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; frame-src https://js.stripe.com https://pay.google.com https://challenges.cloudflare.com https://*.paypal.com https://*.paypalobjects.com https://www.google.com https://*.js.stripe.com https://hooks.stripe.com https://link.com https://*.link.com; upgrade-insecure-requests
```

**After deploying, verify from a terminal** — the whole point is that this header is invisible
to our test suite:

```sh
curl -sI https://www.inkcartridges.co.nz/payment \
  | tr ';' '\n' | grep -E 'frame-src|connect-src|script-src'
```

Expect `*.js.stripe.com` and `hooks.stripe.com` in `frame-src`, and `link.com` + `*.link.com`
in both `frame-src` and `connect-src`.

---

## Fix 2 (required) — verify in Safari, not Chrome

**Apple Pay on the web is a Safari/WebKit API.** It will never render in Chrome on macOS, no
matter what we configure. Stripe: *"If you don't meet device and integration requirements,
Stripe doesn't show Apple Pay as a payment option."*

After the CSP ships:

1. Open `/payment` (a real cart → checkout → step 3) in **Safari on a Mac with a card in
   Wallet and Touch ID**, or on an iPhone.
2. DevTools console — `js/payment-page.js` already logs the answer:
   - `Express Checkout ready: applePay, link` → working
   - `Express Checkout: no eligible wallet — block hidden` → the browser reported nothing eligible
   - any `Refused to frame …` / `Refused to load …` line → a CSP entry is still missing
3. Isolate site-vs-browser with Stripe's own ECE demo — <https://docs.stripe.com/testing/wallets?ui=express-checkout-element>.
   If Stripe's page shows Apple Pay in that same browser and ours doesn't, it's our page.
4. Google Pay: Chrome signed into a Google account **with a saved card**. A clean profile
   shows nothing, which is expected and not a bug.

### Note the missing safety net

`initStripe()` mounts the Payment Element with:

```js
wallets: { applePay: 'never', googlePay: 'never' }
```

That is deliberate (§ the Jul spec — no duplicate buttons), but it means **if the ECE row
fails, Apple/Google Pay disappear from the page entirely with no fallback.** That is consistent
with the zero-charge history. Consider flipping these to `'auto'` temporarily while diagnosing.

---

## Not next: wallet buttons on the cart page (Option B)

Requested, and worth doing eventually — but the premise "all the data is already there" is
backwards. `/cart` shows *"Shipping — Calculated at checkout"*: there is no address, no email,
no shipping cost. The point of a cart-level wallet button is the opposite — **the wallet
supplies the address** and we build the order from what it returns.

Backend work that needs scoping first:

1. **`POST /api/orders`** → `create_order_atomic()` requires the full address up front, and the
   idempotency key is `SHA256(userId + items + address)`. Wallet-first means the address
   arrives *after* the customer authorises. Needs a new path (inv 15 — still one transaction).
2. **Shipping priced inside the wallet sheet** — ECE `onShippingAddressChange` → price the NZ
   address → `elements.update({ amount })` so the sheet shows the true total before the
   customer confirms.
3. **`orders.delivery_type`** (mig 171, §12.6d) is rural/urban and a wallet address does not
   state it. That recovery has to run server-side on the wallet address or we book the wrong
   supplier freight.
4. **Guest Turnstile** must gate the sheet at `click`, before it opens (§14 card-testing
   prevention). The pattern already exists in `payment-page.js`.
5. Coupons, the volume ladder and contract pricing ride `POST /api/orders` unchanged — no work.

**Sequencing:** ship the CSP fix → prove one wallet payment completes on `/payment` → then
build the cart button. Adding a second wallet surface before the first has ever produced a
payment just doubles the surface of something unproven.

---

## Wider context

Mobile completes **5/81 checkouts vs desktop 20/72**. The Sep 16 audit traced that to the
rewards popover + cookie banner covering *both* Add-to-Cart buttons on iPhone
(`mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md`) — upstream of the cart, and a bigger
lever than wallet buttons. Wallets help the same audience; they are not a substitute for that
fix.
