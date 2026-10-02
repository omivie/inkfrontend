# Backend audit — FE reply (Oct 2026)

**Answers:** `inbox/backend-audit-fe-handoff-oct2026.md` (backend `390ae16`).
**FE ref:** ERR-300. **New ask:** BF-097 (§1.2).
**Measured:** 2026-10-02, against production, before any code changed.
**Re-check:** `npm run probe:backend-audit` (READ-ONLY; `-- --site` once this deploys).

Every claim in the handoff was checked before we acted on it. Nine held. One did not
(§1.2). Two "check on your side" items turned out to be FE defects, both now fixed (§2.2, §2.3).

---

## 1. Action items

### 1.1 Guest prefill — done

- **Measured:** `POST /api/checkout/guest-prefill` with an unknown address returns
  `{"ok":true,"data":{"has_previous_order":false}}`.
- **Our side did not throw.** Checkout read flat `first_name` / `address_line1` / …
  and never read `shipping_address`. Since your fix it has been filling nothing.
- **Deleted, not guarded.** The autofill code is gone. Checkout now reads only
  `has_previous_order` and `welcome_message`, and never writes a form field from this
  response. A test sends it the OLD PII shape and asserts that nothing is filled. The
  "Welcome back" banner shows your `welcome_message` text and adds no copy about pre-filling.
- **The 400s.** Production logged two `400 VALIDATION_FAILED` from this endpoint on
  every guest checkout. We now send only an email that the browser itself validates
  (`input.validity.valid`), and each address only once. Note that your validator is
  stricter than the browser's: `x@example.invalid` gets a 400. A few 400s may remain.
  They are harmless.
- **Magic-link prefill:** not requested for now. It is the owner's call.

### 1.2 /genuine-vs-compatible — the premise does not hold (BF-097)

The handoff says bots get the backend prerender for this page. They do not:

- `middleware.js` has no prerender arm for `/genuine-vs-compatible`. Googlebot and a
  browser receive **byte-identical** static HTML (23,151 bytes each, measured).
- `/api/prerender/genuine-vs-compatible` returns **404**. We also tried `guide/`,
  `info/` and `pages/`, all 404.
- The old sentence ("They're guaranteed to work with your printer…") is **not in our
  repo and not on the live page**, in any version. The same is true of the new one.
- We searched your home, shop, ink, toner and HP brand prerenders for both sentences.
  Neither appears.

So there was nothing on our side to mirror, and the page that Google sees is ours.
**BF-097 asks:** where does that paragraph render? If it is in a prerender we do not
route to, it is not served to anyone. If it is somewhere we did not look, send us the
URL and we will check that it matches. On our side, "guaranteed to work" is now
test-banned across every customer page and script, on top of `BANNED_CLAIM_PATTERNS`.

### 1.3 Product FAQ — done, and it was hiding the FAQ entirely

- **The bug:** the PDP read `seo.jsonLd.faq_schema`. On production, `seo` has no
  `jsonLd` key; we measured `seo` = `title, description, canonical, og, keywords`.
- **The effect:** the visible FAQ accordion was **hidden on every product page**. In a
  live browser check of GLC3317BK it had 0 items.
- **The fix:** it now reads `faqJsonLd` first, with the old key as the second read.
  Locally the same PDP shows all six questions. The delivery answer reads word for word
  "Auckland metro orders placed before 14:00 NZT on a business day are dispatched the
  same day. North Island 1-3 business days; South Island 2-4 business days."
- **The text is yours.** The answers are your `faqJsonLd` text, HTML-escaped, with no
  FE copy. The page still emits no FAQPage JSON-LD of its own.

## 2. Checks

### 2.1 Unsubscribe

No change. The `?unsubscribed=` handler stays because campaign unsubscribes still
redirect to it. A comment in the code now names that as its only remaining caller.

### 2.2 `/account?subscription=…` — it never read correctly; now it does

- **There was no handler.** Nothing read `subscription` anywhere in the FE, so all four
  outcomes landed on a silent account page.
- **The param was also lost on sign-in.** A signed-out shopper (the usual case from an
  email) was sent to `/account/login?redirect=/account`, which dropped it.
- **Now:**
  - `created`, `exists`, `unavailable` and `error` each show a message.
  - The param is stripped after display.
  - It survives the sign-in round trip. Measured: we are sent to
    `/account/login?redirect=%2Faccount%3Fsubscription%3Dcreated`.
  - Only those four values are acted on or carried. Any other value is ignored and
    never reflected.

### 2.3 `?rated=N` — fixed a gap

The thank-you existed, but it ran inside the reviews-loading `try`, so a failed
reviews fetch swallowed it. It now runs after that block. Measured with the reviews
request forced to fail: "Thanks for your 5-star rating!" still shows, and the param
is stripped.

### 2.4 Same-day wording — done

- **Matched your new wording.** Our fallback titles (used when the prerender is
  unreachable) said "— Same-Day Dispatch". They now say "— Fast NZ Delivery", as yours
  do. The toner title is byte-identical to yours.
- **Fallback descriptions** say "Auckland metro: same-day dispatch by 2pm NZT." This
  is shorter than your sentence: your full sentence pushed our home and shop
  descriptions past 155 characters and truncated "Free shipping over $100".
- **Two static pages qualified:** `/business` and the `/about` heading.
- **Live countdown checked:** the PDP/cart countdown takes its "(Auckland metro)"
  qualifier from your `delivery_estimate.promise`. We confirmed it still names
  Auckland metro.
- **Locked by a test:** no customer page may say "same-day dispatch" without
  "Auckland metro" next to it.

## 3. FYI items

- **Share image:** worse than your note. Our `og:image` / `twitter:image` on **41 pages**
  pointed at `www…/assets/images/logo.png`, which **404s**; it never pointed at
  `/images/og-default.png`. All 41 now use `https://api.inkcartridges.co.nz/og-default.png`,
  with 1200×630 dimensions on the three static og pages.
- **Organization logo:** ours was `www…/logo.png`, also a **404**. It appeared in the static
  homepage JSON-LD and in the footer's site schema. It is now the exact URL your
  `/api/schema/site` emits.
- **No action needed on these:**
  - `llms.txt` is proxied to you.
  - Our brand BreadcrumbList already says "Shop".
  - We build no `/printers/{brand}/{slug}` links.

**What we rely on staying stable:** `faqJsonLd.mainEntity[].acceptedAnswer.text`,
`delivery_estimate.promise` naming "Auckland metro", and the two API image URLs. The
probe checks all three, with the old www paths as a negative control (both still 404).
