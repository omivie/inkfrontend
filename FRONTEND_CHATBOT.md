# Frontend Integration

Backend API contracts for the frontend. Covers the chatbot widget, landing page features, and shared conventions.

---

## Chatbot Widget

API contract for `js/chatbot.js` + `css/chatbot.css`, loaded on all customer-facing pages.

### GET /api/chat/health

Called on every page load before the widget renders. Acts as a gate — if `success` is `false`, the widget is never injected into the DOM.

**Auth:** None

**Response (available):**
```json
{ "success": true }
```

**Response (unavailable):**
```json
{ "success": false }
```

Returns `false` when:
- `ANTHROPIC_API_KEY` is not set
- Chatbot is disabled via settings

This endpoint must be fast and lightweight — no database calls, no external requests.

---

### POST /api/chat

Main chat endpoint. Accepts a user message and returns an AI response.

**Auth:** Optional. Bearer token sent automatically if the user is logged in. Anonymous users send no token.

**Request body:**
```json
{
  "message": "What ink does my Brother printer need?",
  "session_id": "chat_1707912345678_abc1234",
  "context": {
    "page": "product_detail",
    "current_product_sku": "B131B"
  }
}
```

**Field details:**

| Field | Type | Required | Constraints | Notes |
|-------|------|----------|-------------|-------|
| `message` | string | Yes | 1–2000 chars | Frontend enforces `maxlength="2000"` |
| `session_id` | string | Yes | Max 100 chars | Format: `chat_<timestamp>_<7-char-random>` |
| `context` | object | Yes | — | Always sent, never null |
| `context.page` | string | Yes | Enum (see below) | Determined from URL path |
| `context.current_product_sku` | string | No | — | Only present on `product_detail` pages |

**Page mapping:**

| URL contains | `context.page` value |
|---|---|
| `/shop` | `products` |
| `/product/` | `product_detail` |
| `/cart` | `cart` |
| `/checkout` or `/payment` | `checkout` |
| `/order` | `orders` |
| `/account` | `account` |
| anything else | `home` |

**Success response:**
```json
{
  "success": true,
  "data": {
    "response": "For your Brother MFC-J870DW, I'd recommend...",
    "session_id": "chat_1707912345678_abc1234"
  }
}
```

| Response field | Frontend usage |
|---|---|
| `data.response` | Rendered as the bot's message bubble (HTML-escaped via `Security.escapeHtml()`) |
| `data.session_id` | Frontend updates its stored session ID to this value |

**Error response:**
```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

The frontend displays `error` in a banner. Falls back to "Could not get a response. Please try again." if `error` is missing.

---

### DELETE /api/chat/session/:session_id

Called when the user clicks "New conversation" (refresh icon in chat header).

**Auth:** Optional (same as POST).

**Example:** `DELETE /api/chat/session/chat_1707912345678_abc1234`

**Response:** Always returns `{ "success": true }` regardless of whether the session existed. The frontend ignores the response (fire-and-forget).

---

### Chatbot Rate Limiting

The frontend does not enforce rate limits — it relies on the backend to return errors.

| Scope | Limit |
|---|---|
| Anonymous | 10 req/min per IP |
| Authenticated | 20 req/min per user |
| Per session | 100 req/hour per session |

**Rate-limited response:**
```json
{
  "success": false,
  "error": "Too many messages. Please wait a moment before trying again."
}
```

### Feature Flag

`GET /api/settings` includes `chatbot_enabled` in the `FEATURES` object:

```json
{
  "FEATURES": {
    "chatbot_enabled": true
  }
}
```

The frontend does not read `chatbot_enabled` directly — it relies entirely on the health endpoint to gate the widget. When `chatbot_enabled` is false, the health endpoint returns `{ "success": false }`.

### Session Management

- Session IDs are generated client-side: `chat_<Date.now()>_<7-char-base36-random>`
- Sessions are stored in `sessionStorage` (cleared when the browser tab closes)
- The backend stores conversation history keyed by `session_id` (in-memory, 1-hour TTL)
- `DELETE /api/chat/session/:session_id` clears server-side history for that session

### AI Context

The backend uses the `context` object to provide relevant data to the AI:

- **`product_detail` page** with `current_product_sku`: looks up product name, price, compatibility, and stock status
- **`cart` / `checkout` pages**: AI is helpful about shipping, payment, and order questions
- AI knows about: free shipping threshold ($100), NZ-only shipping, Stripe payments, product catalog (ink cartridges, toner, ribbons)
- AI only references products that exist in the database — never makes up product information

---

## Landing Page

API contracts for the redesigned landing page (`landing.js`).

### POST /api/newsletter/subscribe

Subscribe an email to the newsletter. Called from the landing page footer form.

**Auth:** None

**Rate limit:** 3 attempts per IP per hour

**Request body:**
```json
{
  "email": "user@example.com",
  "source": "landing"
}
```

| Field | Type | Required | Constraints | Notes |
|-------|------|----------|-------------|-------|
| `email` | string | Yes | Valid email, max 255 chars | Trimmed and lowercased server-side |
| `source` | string | No | Max 50 chars | Defaults to `"landing"` |

**Success response (new subscriber):**
```json
{
  "success": true,
  "message": "Subscribed successfully"
}
```

**Success response (duplicate):**
```json
{
  "success": true,
  "message": "Already subscribed"
}
```

Both return 200 — the backend does not leak whether an email is already subscribed via status codes.

**Validation error:**
```json
{
  "success": false,
  "error": "Invalid email address"
}
```

**Rate-limited response:**
```json
{
  "success": false,
  "error": "Too many attempts. Please try again later."
}
```

---

### GET /api/products (Featured Products)

The landing page calls `Products.loadFeatured()` → `API.getProducts({ limit: 8 })`.

The frontend filters for `is_featured === true` and falls back to the first 4 products. The `is_featured` field is included in the product response — no special endpoint needed.

---

### GET /api/products?search= (Cartridge Code Search)

The ink finder's cartridge code tab submits a form to `/html/shop.html?q=...`. The shop page reads `q` from the URL and passes it to `GET /api/products?search=...`.

Search matches across:
- `name` (e.g. "Brother TN-2450 Compatible Toner")
- `sku` (e.g. "B2450")
- `manufacturer_part_number` (e.g. "TN-2450")

Partial matching is supported via `ILIKE %...%`.

---

### Reviews Summary (Future)

Static text ("Trusted by 2,000+ Kiwi customers") is used until a reviews system is implemented.

Future endpoint: `GET /api/reviews/summary`

---

### Analytics Events (Future)

Landing page conversion events (ink finder interactions, newsletter subscriptions, popular printer clicks) are not yet tracked. Implement when analytics infrastructure is ready.

---

## CORS

All endpoints follow the `/api/*` pattern and are covered by the existing CORS config. Chat and newsletter endpoints accept both authenticated and unauthenticated requests.
