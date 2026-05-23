-- =============================================================================
-- tracking_requests — customer-initiated "request tracking" queue (May 2026)
-- =============================================================================
-- We no longer reveal tracking to customers automatically. A customer submits
-- their order number on /track-order; the backend records a row here and emails
-- the admins who opted into `notify_tracking_requests`. An admin then fulfils
-- the request (carrier + tracking number) from the admin "Tracking Requests"
-- page, which writes the tracking onto the order, advances it to `shipped`,
-- marks the request fulfilled, and emails the customer their tracking details.
--
-- OWNERSHIP: all reads/writes go through the BACKEND (service role), never the
-- browser. The customer submit endpoint (POST /api/orders/track-request) is
-- public + rate-limited; the admin endpoints are auth-gated. RLS is therefore
-- enabled with NO permissive policies — anon/authenticated clients get nothing,
-- and the service role bypasses RLS as usual. This mirrors how `orders` is
-- locked down (order data is never read directly from the browser).
--
-- Idempotent — safe to run more than once.
--
-- HOW TO APPLY:  Supabase dashboard → SQL Editor → paste this file → Run.
-- Project: lmdlgldjgcanknsjrcxh
-- =============================================================================

-- 1) The request queue ---------------------------------------------------------
create table if not exists public.tracking_requests (
  id              uuid         primary key default gen_random_uuid(),
  order_number    text         not null,
  order_id        uuid         references public.orders (id) on delete set null,
  email           text,                          -- email the customer supplied / order email
  customer_name   text,
  status          text         not null default 'pending'
                    check (status in ('pending', 'fulfilled', 'dismissed')),
  carrier         text,                          -- set on fulfilment
  tracking_number text,                          -- set on fulfilment
  note            text,                           -- optional message included in the customer email
  request_ip      text,                           -- captured for abuse / rate-limit auditing
  created_at      timestamptz  not null default now(),
  fulfilled_at    timestamptz,
  fulfilled_by    uuid         references auth.users (id) on delete set null
);

comment on table public.tracking_requests is
  'Customer-initiated tracking requests. Submitted from /track-order, fulfilled from the admin Tracking Requests page (which emails the customer their tracking).';

create index if not exists tracking_requests_status_idx
  on public.tracking_requests (status, created_at desc);
create index if not exists tracking_requests_order_number_idx
  on public.tracking_requests (order_number);

alter table public.tracking_requests enable row level security;
-- No policies: only the service role (backend) may read/write. Anon and
-- authenticated browser clients are intentionally denied direct access.

-- 2) Admin opt-in flag ----------------------------------------------------------
-- notification_preferences already exists (one row per contact_email_id). Add
-- the tracking-request opt-in; defaults TRUE so existing recipients keep getting
-- notified until an owner turns it off on the admin Settings page.
alter table public.notification_preferences
  add column if not exists notify_tracking_requests boolean not null default true;

comment on column public.notification_preferences.notify_tracking_requests is
  'When true, this recipient is emailed whenever a customer requests tracking on /track-order.';
