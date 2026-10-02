# Backend audit — FE handoff (Oct 2026)

Backend commit `390ae16`, live on `api.inkcartridges.co.nz` since 2026-09-30 21:32 UTC.
The backend side of everything below is done and deployed. This note lists what
the storefront must change, what to check, and what changed with no FE action.

---

## 1. Action required

### 1.1 Guest checkout prefill no longer returns personal data (security fix)

`POST /api/checkout/guest-prefill` answered an **unauthenticated** request with
the guest's name, phone and full street address, given only an email address.
Anyone who knew a customer's email could read their home address. It now
returns only the returning-customer flag.

Before:

```json
{ "ok": true, "data": {
  "has_previous_order": true, "customer_status": "returning",
  "welcome_message": "Welcome back! Your address is pre-filled below.",
  "name": "…", "phone": "…",
  "shipping_address": { "address_line1": "…", "address_line2": "…", "city": "…", "region": "…", "postal_code": "…" }
} }
```

Now:

```json
{ "ok": true, "data": { "has_previous_order": true, "customer_status": "returning", "welcome_message": "Welcome back!" } }
```

or `{ "ok": true, "data": { "has_previous_order": false } }`.

**FE to do**

- Stop reading `name`, `phone` and `shipping_address` from this response. If
  checkout does `data.shipping_address.address_line1` whenever
  `has_previous_order` is true, it now throws. Guard it or delete the autofill.
- Keep using `has_previous_order` / `welcome_message` for the "Welcome back"
  copy. Remove any copy that says the address was pre-filled.
- Autofill can come back only behind proof of email ownership (magic link or
  one-time code). Ask the backend if you want that built.

### 1.2 Mirror the reworded /genuine-vs-compatible paragraph

www serves hand-authored static HTML for `/genuine-vs-compatible`, while bots
get the backend prerender. The two must stay the same (Google cloaking check).
"Guaranteed to work" is a banned claim class (CLAUDE.md invariant 13), so the
backend copy changed. Mirror this one sentence in the FE static page.

Old:

> They're guaranteed to work with your printer, deliver the manufacturer's stated print yield and quality, and include the brand's full warranty.

New:

> They're made by your printer's own manufacturer, deliver the manufacturer's stated print yield and quality, and include the brand's full warranty.

The rest of the paragraph is unchanged.

### 1.3 Product FAQ answers changed — visible FAQ must render from `faqJsonLd`

`GET /api/products/:sku` returns `faqJsonLd`. Three answers now come from the
live trust signals (`getTrustSignals()`) instead of hard-coded text. If the SPA
renders its visible FAQ from its own copy instead of from `faqJsonLd`, the
visible text and the JSON-LD now differ (invariant 11). Render the visible FAQ
from `faqJsonLd.mainEntity`. Current answers (values follow the env config):

| Question | New answer |
|---|---|
| How long does delivery take? | Auckland metro orders placed before 14:00 NZT on a business day are dispatched the same day. North Island 1-3 business days; South Island 2-4 business days. |
| Is there a warranty on this compatible …? | Our compatible cartridges are covered by a 30-day satisfaction guarantee. If a compatible cartridge isn't right for you, return it within 30 days for a replacement or refund. Your statutory rights under the New Zealand Consumer Guarantees Act 1993 also apply — see our /returns policy for details. |
| Can I return this product? | Yes. Faulty, damaged, or incorrectly-supplied items can be returned within 30 days. Change-of-mind returns on unopened items within 30 days. Refunds are processed within 3–5 business days of receipt. See our /returns policy for full details. |

Delivery used to say "Auckland metro: 1-2 business days", which no trust signal
backs.

---

## 2. Check on your side (no change expected)

### 2.1 Unsubscribe links now show a confirm page

`GET /api/email/unsubscribe?token=…&type=…` (every lifecycle and outreach email
footer) no longer unsubscribes on open. Mail scanners (Microsoft Safe Links,
Mimecast) open every link, so recipients were being unsubscribed without asking.

- GET renders a backend confirm page with an **Unsubscribe** button. It writes
  nothing. A bad or expired token gets a 400 error page.
- The button POSTs back. The backend unsubscribes and renders a backend result
  page ("You're unsubscribed from … emails").
- It no longer redirects to `/account/settings?unsubscribed=<type>`. Guests
  (most recipients) have no account page to land on. If the SPA handles that
  query param only for this flow, the handler is now unused. Campaign
  unsubscribes (`/api/campaigns/unsubscribe/:id`) are unchanged and still
  redirect there.
- RFC 8058 one-click unsubscribe from Gmail/Yahoo is unchanged.

### 2.2 "Set up scheduled reorder" link (order confirmation email) asks first

`GET /api/subscriptions/subscribe-from-order/:orderId?t=…` now renders a
backend confirm page. The shopper's click POSTs, and the backend then redirects
to `/account?subscription=created|exists|unavailable|error` as before. The
destination and params are unchanged; there is one extra click. Please check
the `/account?subscription=…` landing still reads correctly.

### 2.3 One-click review rating now lands on the storefront in Chrome

The quick-rating confirm page (`/api/reviews/quick-rating`) redirects after its
POST to `/products/{slug}/{SKU}?rated=N` (or `/account/reviews?rated=N`).
Chromium blocked that redirect: the API's CSP `form-action 'self'` applies to
the redirect after a form submission. So the rating was saved, then the shopper
saw a blocked-navigation page. The CSP now allows the storefront origin. If the
PDP shows a thank-you for `?rated=N`, that is now what people see — please
check it once.

### 2.4 Same-day dispatch wording

Every backend meta description and FAQ now says "**Auckland metro** orders by
2pm NZT dispatch same day". The unqualified "same-day dispatch" was removed:
the promise only covers Auckland metro (same rule as BF-078). If any FE-authored
copy still says unqualified "same-day dispatch", qualify it the same way.

---

## 3. FYI — changed, no FE action

- **Default share image.** The fallback `og:image` / `twitter:image` is now
  `https://api.inkcartridges.co.nz/og-default.png` (1200×630, served with
  `Cross-Origin-Resource-Policy: cross-origin`). The old
  `https://www.inkcartridges.co.nz/images/og-default.png` returned 404. You may
  point FE meta at the API URL, or ship your own asset at the old path.
- **Organization / LocalBusiness JSON-LD `logo`/`image`** now use
  `https://api.inkcartridges.co.nz/api/images/optimize?url=site/IC_2.png…`. The
  www URL returned 404 (www answers every `/api/*` with 404). If the FE emits its
  own Organization JSON-LD, check its logo URL is not the www one.
- **`/llms.txt`** now lists every JSON endpoint on the API host, not www.
- **`/api/schema/printer/:slug`** accepts printer slugs with `.` and `+`
  (it returned 400 before). Its `collectionPage.url` is now the canonical
  `/shop?brand=…&printer_slug=…` (was a non-existent `/printers/{brand}/{slug}`).
  `/api/schema/collection` no longer lists products without a slug.
- **Bot-facing prerender (via middleware):**
  - Brand pages show real counts. HP was "200 … 200 genuine, 0 compatible"; now "870 … 659 genuine, 211 compatible".
  - `/shop` brand counts page past the 1,000-row cap.
  - The PDP breadcrumb matches its BreadcrumbList.
  - Compatible image alt text starts with "Compatible".
  - The printer page `og:image` is no longer the manufacturer's logo.
  - `ProductGroup` uses the real family code.
- **Brand BreadcrumbList** level 2 is named "Shop" (was "Brands"), matching the
  visible breadcrumb.
- **Admin analytics** (`/api/analytics/*`, `/api/admin/analytics/*`) now really
  get the 30s timeout (a 15s timer used to fire first), so there should be fewer
  504s on heavy dashboard reads.
- **No response-shape changes** to cart, orders, products, search or
  shipping.

---

## Backend follow-ups (not FE, not blocking)

These are open on the backend side only; none needs FE work:

- Check whether the Render origin accepts a client-sent `X-Forwarded-For`
  (possible per-IP rate-limit bypass).
- Password change without re-authentication.
- Role gating on P&L / money-moving admin routes (all admins are super_admin
  today).
- Reorder / pause email links still act on GET.
