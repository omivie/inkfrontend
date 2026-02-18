# Security Documentation — InkCartridges.co.nz Frontend

> Last updated: 2026-02-07
> Audited by: Security audit (automated + manual review)

---

## 1. Threat Model

### Application Architecture
- **Frontend**: Vanilla JavaScript served as static HTML (no framework SSR)
- **Backend**: Express.js on Render (`https://ink-backend-zaeq.onrender.com`)
- **Auth**: Supabase Auth (JWT tokens, stored in Supabase client SDK)
- **Payments**: Stripe (server-created PaymentIntents, client-side confirmation)
- **Database**: Supabase PostgreSQL with Row-Level Security (RLS)

### Trust Boundaries
```
[Browser] ←→ [Static HTML/JS] ←→ [Backend API] ←→ [Supabase DB]
                                 ←→ [Stripe API]
```

1. **Browser → Frontend**: User input (forms, search, URL params) is UNTRUSTED
2. **Backend → Frontend**: API responses are SEMI-TRUSTED (data originates from DB, but could be poisoned via admin/import)
3. **Frontend → Backend**: All prices, totals, and business logic must be validated SERVER-SIDE
4. **URL Parameters**: UNTRUSTED — used for filters, redirects, and product lookups

### Key Assets
| Asset | Risk | Protection |
|-------|------|------------|
| User credentials | Credential theft | Supabase Auth handles storage; frontend never sees raw passwords |
| Payment data | Financial fraud | Stripe Elements (PCI-compliant iframe); frontend only handles `client_secret` |
| Session tokens | Session hijack | Stored in Supabase SDK (httpOnly where possible); Bearer token in API headers |
| Product prices | Price tampering | Server-side validation on all orders; frontend prices are display-only |
| Guest cart cookie | Cart manipulation | httpOnly cookie managed by backend; `credentials: 'include'` required |
| Admin access | Privilege escalation | Role-based verification via `/api/admin/verify` on every admin page load |

### Threat Actors
1. **External attacker**: XSS via product data poisoning, open redirect phishing, CSRF
2. **Malicious product data**: Stored XSS via compromised product names/descriptions in database
3. **Shared device user**: Data leakage from incomplete session cleanup
4. **Network attacker**: MITM (mitigated by HTTPS)

---

## 2. Vulnerabilities Found & Fixed

### CRITICAL

#### C-1: Open Redirect in Login Flow
- **Severity**: CRITICAL
- **Files**: `html/account/login.html` (lines 468, 552, 792)
- **Threat**: Attacker crafts `login.html?redirect=https://evil.com/phish`. After successful login, user is redirected to a phishing page mimicking InkCartridges.
- **Exploit**: `https://inkcartridges.co.nz/html/account/login.html?redirect=https://evil.com`
- **Fix**: All three redirect consumption points now use `Security.safeRedirect()` which only allows same-origin paths (must start with `/`, rejects `//`, `http:`, `javascript:`, etc.)
- **Defense**: Allowlist-based — only relative paths pass validation

### HIGH

#### H-1: DOM XSS in Search Autocomplete
- **Severity**: HIGH
- **Files**: `js/main.js` (lines 217-259)
- **Threat**: User's search query reflected in innerHTML without escaping. API response data (product names, SKUs) also injected raw.
- **Exploit**: Search for `<img src=x onerror=alert(document.cookie)>` — executes in autocomplete dropdown
- **Fix**: All dynamic values escaped with `Security.escapeHtml()` (text) and `Security.escapeAttr()` (attributes)

#### H-2: DOM XSS in Product Card Rendering
- **Severity**: HIGH
- **Files**: `js/products.js` (lines 33-97)
- **Threat**: Product data from API (name, brand, SKU, image_url, color) injected into innerHTML without escaping. Stored XSS if product data is poisoned.
- **Exploit**: Product with name `<img src=x onerror=steal(cookies)>` renders as executable HTML on shop pages
- **Fix**: All product fields escaped with appropriate Security methods

#### H-3: DOM XSS in Favourites Rendering
- **Severity**: HIGH
- **Files**: `js/favourites.js` (lines 436-468, 541-553, 561-584)
- **Threat**: Same as H-2 but in favourites page and toggle buttons across the site
- **Fix**: 19 injection points secured with escaping

#### H-4: DOM XSS in Toast Notifications
- **Severity**: HIGH
- **Files**: `js/main.js` (line 414)
- **Threat**: `showToast(message)` injects message param into innerHTML. If called with API error messages, attacker-controlled content executes.
- **Fix**: Message escaped with `Security.escapeHtml()`

#### H-5: DOM XSS in Admin Pages
- **Severity**: HIGH
- **Files**: `js/orders-page.js`, `js/products-page.js`, `js/customers-page.js`
- **Threat**: Order/product/customer data rendered without escaping. If a customer submits a malicious name/email, admin users get XSS'd.
- **Fix**: All dynamic fields in render functions escaped

#### H-6: DOM XSS in Product Detail Page
- **Severity**: HIGH
- **Files**: `html/product/index.html` (lines 677-782)
- **Threat**: Breadcrumbs, images, specs, features, descriptions all inject product data via innerHTML
- **Fix**: All dynamic data escaped; description templates have individual field escaping

#### H-7: DOM XSS in Account Page Rendering
- **Severity**: HIGH
- **Files**: `js/account.js` (renderOrderRow, formatAddress, renderAddressCard, renderPrinterCard, renderPrinterCardLarge)
- **Threat**: User address data, printer names, order data rendered without escaping
- **Fix**: All 5 render methods updated with field-level escaping

#### H-8: DOM XSS in Admin Product Edit
- **Severity**: HIGH
- **Files**: `js/admin-product-edit.js` (lines 446, 592-599)
- **Threat**: Product image URLs and printer names injected without escaping
- **Fix**: `image.url` escaped in src attributes, printer data escaped in tags

### MEDIUM

#### M-1: Sensitive Data in Console Logs
- **Severity**: MEDIUM
- **Files**: `js/api.js` (line 71), `html/account/login.html` (multiple)
- **Threat**: Full API error responses logged to console may contain tokens, internal server details, or PII. XSS attacker can harvest via `console` access.
- **Fix**: Replaced verbose `JSON.stringify(data)` logging with minimal `response.status + error message`. Removed auth event and email logging from login page.

#### M-2: Incomplete Logout Cleanup
- **Severity**: MEDIUM
- **Files**: `js/auth.js` (signOut method)
- **Threat**: On shared devices, favourites localStorage, sessionStorage order data, and cached user info persisted after logout.
- **Fix**: `signOut()` now clears `inkcartridges_favourites` from localStorage and calls `sessionStorage.clear()`

#### M-3: Email Verification Bypass
- **Severity**: MEDIUM
- **Files**: `js/auth.js` (line 289)
- **Threat**: `checkEmailVerification()` returned `true` on API error, allowing unverified users to proceed when the verification endpoint is unreachable.
- **Fix**: Changed to return `false` on error (deny by default)

#### M-4: No CSP or Security Headers (NOT FIXED — requires server config)
- **Severity**: MEDIUM
- **Recommendation**: Add these headers via the hosting platform or a reverse proxy:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https://ink-backend-zaeq.onrender.com https://*.supabase.co https://api.stripe.com; frame-src https://js.stripe.com;
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  ```

#### M-5: `credentials: 'include'` on All Requests (ACCEPTED RISK)
- **Severity**: MEDIUM
- **Files**: `js/api.js` (line 42)
- **Status**: Intentional — required for guest cart cookies. Backend must ensure CSRF protections (SameSite cookies, origin checking).

### LOW

#### L-1: Hardcoded API Keys (ACCEPTED RISK)
- **Severity**: LOW
- **Files**: `js/config.js`
- **Status**: Supabase anon key and Stripe publishable key are public-by-design. Ensure Supabase RLS policies are enforced and Stripe secret key is never exposed.

#### L-2: sessionStorage Order Data
- **Severity**: LOW
- **Files**: `html/payment.html`
- **Status**: Fixed by M-2 — sessionStorage is now cleared on logout

---

## 3. Security Utilities Reference (`js/security.js`)

### `Security.escapeHtml(str)`
Escapes `& < > " ' / \`` for safe insertion into innerHTML templates.
```js
Security.escapeHtml(product.name) // "Toner &lt;script&gt;" → safe
```

### `Security.escapeAttr(str)`
Same as `escapeHtml` — use when building attribute values: `src="..."`, `data-*="..."`, `alt="..."`.
```js
`<img src="${Security.escapeAttr(url)}" alt="${Security.escapeAttr(name)}">`
```

### `Security.sanitizeUrl(url, fallback)`
Validates URLs for href/src. Only allows `http:`, `https:`, and relative paths (starting with `/`). Blocks `javascript:`, `data:`, `vbscript:`, and protocol-relative `//` URLs.
```js
Security.sanitizeUrl(userUrl, '#') // "javascript:alert(1)" → "#"
```

### `Security.safeRedirect(url, fallback)`
Validates redirect targets. Only allows same-origin relative paths (starting with `/`, not `//`). Returns fallback for any absolute or suspicious URL.
```js
Security.safeRedirect(params.get('redirect')) // "https://evil.com" → "/html/account/index.html"
```

### `Security.sanitizeForLog(data)`
Recursively redacts sensitive keys (token, password, secret, etc.) from objects before logging.
```js
console.log(Security.sanitizeForLog(apiResponse)) // { token: "[REDACTED]", ... }
```

---

## 4. Secure Coding Rules

### Rule 1: Never Insert Untrusted Data into innerHTML Without Escaping
```js
// BAD
element.innerHTML = `<span>${userInput}</span>`;

// GOOD
element.innerHTML = `<span>${Security.escapeHtml(userInput)}</span>`;

// BEST (when possible) — use textContent instead
element.textContent = userInput;
```

### Rule 2: Escape Attribute Values Separately
```js
// BAD — image_url with " breaks out of src attribute
`<img src="${product.image_url}">`

// GOOD
`<img src="${Security.escapeAttr(product.image_url)}">`
```

### Rule 3: Validate All Redirect Targets
```js
// BAD — open redirect
window.location.href = params.get('redirect');

// GOOD — same-origin only
window.location.href = Security.safeRedirect(params.get('redirect'));
```

### Rule 4: Never Trust Frontend Prices
All prices displayed on the frontend are for display only. The backend validates all prices at:
- Cart retrieval (`GET /api/cart`)
- Cart validation (`POST /api/cart/validate`)
- Order creation (`POST /api/orders`)

### Rule 5: Never Log Sensitive Data
```js
// BAD
console.log('API response:', JSON.stringify(response));

// GOOD
console.log('API error:', response.status, response.error);
```

### Rule 6: Clean Up All User Data on Logout
When adding new user-specific localStorage/sessionStorage keys, ensure they are cleared in `Auth.signOut()`.

### Rule 7: Deny by Default for Auth Checks
```js
// BAD — assumes verified on error
catch (e) { return true; }

// GOOD — deny on error
catch (e) { return false; }
```

### Rule 8: Use textContent Over innerHTML When Possible
If you're only setting text (no HTML structure needed), use `textContent` or `innerText` which are inherently XSS-safe.

---

## 5. New Feature Security Checklist

When adding new features, verify:

- [ ] **Dynamic HTML rendering**: All server data escaped with `Security.escapeHtml()` / `Security.escapeAttr()` before innerHTML insertion
- [ ] **URL parameters**: Any URL parameter used in redirects validated with `Security.safeRedirect()`
- [ ] **Image URLs**: User-provided or DB-sourced URLs sanitized with `Security.sanitizeUrl()` and attribute-escaped
- [ ] **New localStorage/sessionStorage keys**: Added to `Auth.signOut()` cleanup
- [ ] **API error handling**: Error messages never expose raw server responses in UI; console logs use `Security.sanitizeForLog()`
- [ ] **New HTML pages**: Include `<script src="/js/security.js"></script>` after `config.js` and before any rendering scripts
- [ ] **Price displays**: Purely cosmetic; never used for order calculations
- [ ] **Admin features**: Protected by `admin-auth.js` role verification; admin data also escaped (defense in depth)
- [ ] **External links**: Include `rel="noopener noreferrer"` and `target="_blank"` attributes
- [ ] **Form submissions**: Input validation on both client (UX) and server (security) sides

---

## 6. Recommended Server-Side Improvements

These cannot be fixed in the frontend alone:

1. **Add CSP headers** via hosting platform (see M-4 above for recommended policy)
2. **Add `X-Frame-Options: DENY`** to prevent clickjacking
3. **Ensure SameSite=Lax or Strict** on guest cart cookies to mitigate CSRF
4. **Rate-limit the search API** endpoint server-side (frontend has debounce but no hard limit)
5. **Validate `Origin` header** on state-changing API requests
6. **Set `Secure` flag** on all cookies in production

---

## 7. Dependencies & Supply Chain

### External CDN Scripts
| Script | Source | Risk | Mitigation |
|--------|--------|------|------------|
| Supabase JS v2 | `cdn.jsdelivr.net` | CDN compromise | Consider adding SRI (Subresource Integrity) hash |
| Stripe.js | `js.stripe.com` | Stripe-hosted (trusted) | Loaded from Stripe's own domain; PCI compliant |

### Recommendations
- Add Subresource Integrity (SRI) hashes to CDN script tags:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
          integrity="sha384-..." crossorigin="anonymous"></script>
  ```
- No `eval()`, `Function()`, or other code generation patterns found in the codebase
- No npm dependencies in the frontend (vanilla JS) — minimal supply chain surface

---

## 8. Files Modified in This Audit

| File | Changes |
|------|---------|
| `js/security.js` | **NEW** — Centralized security utilities |
| `js/main.js` | XSS fixes in search autocomplete and showToast |
| `js/products.js` | XSS fixes in product card rendering |
| `js/favourites.js` | XSS fixes in favourites rendering, image HTML, and buttons |
| `js/cart.js` | Already had `escapeHtml()` — no changes needed |
| `js/account.js` | XSS fixes in 5 render methods |
| `js/orders-page.js` | XSS fixes in order rendering and customer filter |
| `js/products-page.js` | XSS fixes in product rendering and brand filter |
| `js/customers-page.js` | XSS fixes in customer rendering |
| `js/admin-product-edit.js` | XSS fixes in image and printer rendering |
| `js/auth.js` | Logout cleanup, email verification deny-by-default |
| `js/api.js` | Sanitized console logging |
| `html/account/login.html` | Open redirect fix (3 locations), removed sensitive logs |
| `html/product/index.html` | XSS fixes in product detail rendering |
| All 30 HTML files | Added `security.js` script tag |
