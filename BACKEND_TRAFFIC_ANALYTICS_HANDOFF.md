# Backend handoff — Website Traffic Analytics

Frontend has shipped a first-party traffic tracker and an admin page that reads aggregates + recent events. This doc specifies the backend work required to make the admin page populate with real data.

## 1. Supabase table

```sql
create table if not exists public.traffic_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_id text not null,
  visitor_id text not null,
  path text not null,
  referrer text,
  referrer_host text,
  user_agent text,
  device text,              -- 'mobile' | 'tablet' | 'desktop' | 'bot'
  os text,                  -- e.g. 'iOS', 'Android', 'Windows', 'macOS'
  browser text,             -- e.g. 'Safari', 'Chrome', 'Firefox'
  language text,
  screen_w int,
  screen_h int,
  viewport_w int,
  viewport_h int,
  country text,             -- from CF-IPCountry / X-Vercel-IP-Country if available
  event_type text not null, -- 'pageview' | 'click'
  element text,             -- click label (e.g. 'link:/shop', 'btn:Add to cart', '#add-to-cart')
  ip_hash text              -- sha256(ip + daily salt) for bot/abuse filtering; never store raw IP
);

create index on public.traffic_events (created_at desc);
create index on public.traffic_events (session_id);
create index on public.traffic_events (device);
create index on public.traffic_events (path);
create index on public.traffic_events (event_type, created_at desc);

alter table public.traffic_events enable row level security;
-- No policies: ingest is server-side, reads go through admin-only REST endpoints
-- backed by the service-role key.
```

## 2. Ingest endpoint

**`POST /api/analytics/traffic-event`** — public, unauthenticated, rate-limited.

Request body (JSON, reject > 2 KB):
```json
{
  "session_id": "ts_...",
  "visitor_id": "v_...",
  "event_type": "pageview" | "click",
  "path": "/shop",
  "referrer": "https://google.com/",
  "user_agent": "...",
  "language": "en-NZ",
  "screen_w": 1440, "screen_h": 900,
  "viewport_w": 1280, "viewport_h": 780,
  "element": "link:/shop",   // only for click events
  "ts": "2026-04-15T..."
}
```

Server must:
1. Rate-limit by IP (e.g. 60 req/min).
2. Parse `user_agent` → `device`, `os`, `browser` (use `ua-parser-js` or equivalent).
3. Extract `referrer_host` from `referrer` (URL hostname or null if same-origin/empty).
4. Compute `ip_hash = sha256(ip + daily_salt)`; never store raw IP.
5. Read `country` from Cloudflare/Render/Vercel geo header if present.
6. Filter obvious bots (UA regex) — still log but set `device = 'bot'`.
7. Insert row into `traffic_events`.
8. Respond `{ ok: true }` with 204/200 fast (client uses `navigator.sendBeacon`).

## 3. Admin read endpoints

All require owner auth (same middleware as existing `/api/admin/*` routes) and return the repo's standard `{ ok: true, data: ... }` envelope.

### `GET /api/admin/analytics/traffic/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`

```json
{
  "ok": true,
  "data": {
    "sessions": 4821,
    "pageviews": 12043,
    "unique_visitors": 3112,
    "avg_session_duration": 142,
    "bounce_rate": 48.3,
    "device_breakdown":  [{ "device": "mobile",  "count": 2400 }, { "device": "desktop", "count": 1900 }, { "device": "tablet", "count": 521 }],
    "browser_breakdown": [{ "browser": "Safari", "count": 2100 }, { "browser": "Chrome",  "count": 2000 }],
    "os_breakdown":      [{ "os": "iOS", "count": 1800 }, { "os": "Android", "count": 900 }, { "os": "Windows", "count": 1400 }],
    "channel_breakdown": [{ "channel": "Direct", "count": 2100 }, { "channel": "Organic", "count": 1700 }, { "channel": "Paid", "count": 600 }, { "channel": "Referral", "count": 420 }],
    "top_pages":     [{ "path": "/",       "pageviews": 3200, "unique_visitors": 2100 }],
    "top_referrers": [{ "referrer_host": "google.com", "sessions": 1620 }]
  }
}
```

Channel logic:
- `Paid`       — URL had `utm_source` and `utm_medium in ('cpc','paid','ppc')` on first pageview of session
- `Organic`    — `referrer_host` matches known search engines (google, bing, duckduckgo, yahoo, ecosia)
- `Referral`   — `referrer_host` present and not search
- `Direct`     — no referrer

A session is a block of events for one `session_id`; duration is `max(created_at) - min(created_at)`. Bounce = sessions with exactly 1 pageview.

### `GET /api/admin/analytics/traffic/recent?limit=50`

```json
{
  "ok": true,
  "data": [
    {
      "created_at": "2026-04-15T...",
      "session_id": "ts_...",
      "event_type": "click",
      "path": "/shop/brother-tn-2250",
      "element": "btn:Add to cart",
      "device": "mobile",
      "os": "iOS",
      "browser": "Safari",
      "referrer_host": "google.com"
    }
  ]
}
```

### `GET /api/admin/analytics/traffic/timeseries?from=&to=&bucket=day` *(optional, for a future sparkline)*

```json
{ "ok": true, "data": [{ "date": "2026-04-14", "sessions": 312, "pageviews": 842 }] }
```

## 4. Acceptance

- Tracker is already live: load any public page, POST to `/api/analytics/traffic-event` should be visible in Network tab (via `sendBeacon`).
- Once endpoints above exist, `/html/admin/#website-traffic` (owner login) populates KPIs, device/browser/OS/channel breakdowns, top pages, top referrers, and a recent-events table with per-click rows like *"iPhone Safari — click — /shop — btn:Add to cart"*.
