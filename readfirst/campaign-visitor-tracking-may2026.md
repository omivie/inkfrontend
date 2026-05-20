# Campaign-Visitor Tracking — Storefront Spec (May 2026)

**Status:** shipped on the storefront on 2026-05-20. Backend already live on `feat/traffic-campaign-tracking` (migration 074 in prod). Pinned by `tests/campaign-visitor-tracking-may2026.test.js` (28 tests).

The backend now answers "which of the people we just emailed are visiting the site?" in `/admin#website-traffic`. The storefront has two responsibilities:

1. **Forward `utm_rid` and (when signed in) an `Authorization` header on the analytics beacon** — so the backend can attribute visits.
2. **Render the two new admin surfaces** — a `Campaign Visitors` KPI card and an `Email Campaigns` breakdown panel.

This file is the durable record of how the storefront does both. The original backend handoff is no longer in the repo (handoff .md files are deleted after delivery — see `project_backend_handoff_folder_may2026`); the contract lives here + in the pinning test.

---

## 1. Storefront tracker — `js/traffic-tracker.js`

### Endpoint
`POST {API_URL}/api/analytics/traffic-event`

### Payload additions
- `utm_rid` (string, optional) — opaque HMAC-signed recipient token. Forwarded verbatim, never decoded.

### Capture rule
On every page load, the tracker checks for `?utm_rid=<token>` in `location.search` and persists it in `sessionStorage` under the key `'utm_rid'`. Persisted tokens are then attached to **every** subsequent event (pageviews + clicks) in the same tab, regardless of whether the URL still carries the param.

Capture happens at IIFE init (before `DOMContentLoaded`) so a fast bounce still attributes. The first pageview fires after `DOMContentLoaded` so `document.referrer` is reliable.

### Forwarding contract
- The token is **opaque** to the storefront — never decode, parse, or re-encode it.
- Length-cap at 512 chars defends against URL-bomb edge cases without altering content.
- If neither URL nor sessionStorage has a token, the field is **omitted** from the payload (not sent as `null` / `""`).

### Auth-aware send path
| Visitor state | Transport | Headers |
|---|---|---|
| Anonymous (no `window.Auth.session`) | `navigator.sendBeacon` | Content-Type from Blob only |
| Signed in (`Auth.session.access_token` present) | `fetch` with `keepalive: true` | `Content-Type: application/json` + `Authorization: Bearer <access_token>` |

Why two paths: `sendBeacon` can't carry custom headers, and the backend needs `Authorization` to match the visitor against the campaign-recipient table. `fetch + keepalive` is the only modern API that supports both custom headers AND survives page unload.

The tracker awaits `Auth.readyPromise` for up to 1200 ms before deciding which path to take. If Auth never hydrates (private mode, third-party cookies blocked, very slow Supabase round-trip), we fall back to anonymous. The backend uses `optionalAuth` so anonymous events still record; they just don't count toward `authenticated_visitors`.

### Failure modes (all silent)
- `sessionStorage` throws (private mode iOS) → forwarding silently skipped that tab.
- `fetch` rejects → `.catch(() => {})` swallows. Analytics must never break the page.
- Token tampered (one char altered) → backend HMAC-verifies; `is_campaign_recipient` stays `false`. No console error.

---

## 2. Admin dashboard — `js/admin/pages/website-traffic.js`

### Backend response (new fields)
`GET /api/admin/analytics/traffic/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` now returns, alongside the existing aggregates:

```json
{
  "campaign_visitors": 87,
  "campaign_visitor_percent": 13.6,
  "authenticated_visitors": 142,
  "campaign_breakdown": [
    { "campaign_id": "may2026_recent", "unique_visitors": 54, "pageviews": 312 },
    { "campaign_id": "may2026_older",  "unique_visitors": 33, "pageviews": 198 }
  ]
}
```

Backend guarantees:
- All counts default to `0` (never `null`) when nothing matches.
- `campaign_breakdown` is always an array (possibly empty), sorted by `unique_visitors` desc, capped at 10 rows.
- `campaign_id === "unattributed"` appears when a recipient was matched by auth but the campaign was unknown.

### KPI strip (6 cards)
`Sessions / Pageviews / Unique Visitors / Campaign Visitors / Avg Session / Bounce Rate`. Grid CSS is `admin-kpi-grid--6` (added in this rollout — see `css/admin.css`).

Campaign Visitors:
- **Value:** `data.campaign_visitors` formatted via `fmt()` (en-NZ locale, thousand separators).
- **Subtitle:** `${percent.toFixed(1)}% of unique visitors`.
- NaN-guard: `Number.isFinite` checks coerce missing/malformed values to `0` so the subtitle reads `0.0% of unique visitors` rather than `NaN%`.

### Email Campaigns breakdown panel
One row per `campaign_breakdown[]` entry, rendered through the same `barRow()` helper as Device/Channel/Browser/OS so the visual language is consistent.

- Row label: `campaign_id` (passes through `esc()` — XSS-safe).
- Row value: `unique_visitors` formatted via `fmt()`.
- Missing `campaign_id` → label falls back to the literal `"unattributed"`.
- Empty array → empty-state card with the spec-mandated copy `"No campaign traffic yet."`

### XSS hygiene
`campaign_id` values arrive from the backend, which today computes them server-side. Future loaders may sync recipient lists from external sources, so the renderer treats every label as untrusted and routes it through `esc()`. The pinning test asserts a malicious `<script>` campaign_id renders as `&lt;script&gt;`.

---

## 3. Pinning test layout

`tests/campaign-visitor-tracking-may2026.test.js` runs `traffic-tracker.js` inside a `vm` sandbox with stubbed `navigator`, `sessionStorage`, `localStorage`, `fetch`, `Blob`, and `window.Auth`. This captures every outbound send so behavioural assertions can be made without a real browser. The website-traffic rendering tests pull `barRow` and `renderCampaignBreakdown` text out of the source file and execute them in a separate sandbox with stubbed `esc` and `fmt`.

The full test plan covers:

- §1  utm_rid capture from URL, persistence in sessionStorage, forwarding on subsequent events, no-decode invariant.
- §2  Anonymous → sendBeacon. Signed-in → fetch+keepalive+Authorization. Missing Auth → silent fallback.
- §3  KPI rendered with the right label, subtitle format, NaN guard, 6-column grid.
- §4  Breakdown panel: renders, empty-state copy, unattributed fallback, XSS escape, NaN-safe counts.
- §5  `admin-kpi-grid--6` CSS exists and is responsive.
- §6  Tracker keeps the `/admin` early-exit so the admin SPA doesn't double-count itself.

---

## 4. Privacy posture (recap from backend handoff)

- The recipient table stores only `HMAC-SHA-256(PII_HMAC_KEY, lower(trim(email)))` — never raw emails.
- `traffic_events` stores the boolean flag, the matched `campaign_id` slug, and the public email domain (e.g. `gmail.com`). No emails, no hashes.
- The dashboard receives **only** aggregate counts — never any identifying data.
- `email_domain` is populated for future segmentation ("% Gmail vs corporate") but is not surfaced in this dashboard pass.
