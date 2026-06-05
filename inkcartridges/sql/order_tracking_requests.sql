-- =============================================================================
-- order_tracking_requests — customer-initiated "request tracking" queue
-- Backend migration 083 (deployed June 2026).
-- =============================================================================
-- We no longer reveal tracking to customers automatically. A customer submits
-- their order number + email on /track-order; the backend records a row here.
-- If the order ALREADY has a tracking number it emails the shipping
-- confirmation immediately; otherwise it logs a `pending` row that surfaces in
-- the admin "Tracking Requests" page.
--
-- FULFILMENT IS AUTOMATIC. There is no fulfil/dismiss endpoint. When an admin
-- sets a tracking number on the order (PUT /api/admin/orders/:id) the backend
-- flips any `pending` request for that order to `fulfilled` and emails the
-- customer their tracking. So `status` is only ever 'pending' | 'fulfilled'.
--
-- OWNERSHIP: all reads/writes go through the BACKEND (service role), never the
-- browser. The customer submit endpoint (POST /api/orders/track-request) is
-- public + rate-limited and constant-response (anti-enumeration); the admin
-- endpoints are auth-gated (super_admin | order_manager). RLS is enabled with
-- NO permissive policies — anon/authenticated clients get nothing; the service
-- role bypasses RLS as usual. This mirrors how `orders` is locked down.
--
-- This file documents the deployed schema for reference. It is reproduced here
-- (idempotent) so the frontend repo records the contract it consumes; the
-- canonical migration lives in the backend repo.
--
-- HOW TO APPLY (if recreating):  Supabase SQL Editor → paste → Run.
-- Project: lmdlgldjgcanknsjrcxh
-- =============================================================================

-- 1) The request queue ---------------------------------------------------------
create table if not exists public.order_tracking_requests (
  id              uuid         primary key default gen_random_uuid(),
  order_id        uuid         references public.orders (id) on delete cascade,
  order_number    text,                          -- the number the customer submitted
  email           text,                          -- lowercased on insert
  status          text         not null default 'pending'
                    check (status in ('pending', 'fulfilled')),
  fulfilled_at    timestamptz,                   -- null until fulfilled
  created_at      timestamptz  not null default now()
);

comment on table public.order_tracking_requests is
  'Customer-initiated tracking requests (migration 083). Submitted from /track-order; auto-fulfilled when a tracking number is set on the order (which emails the customer).';

create index if not exists order_tracking_requests_status_idx
  on public.order_tracking_requests (status, created_at desc);
create index if not exists order_tracking_requests_order_id_idx
  on public.order_tracking_requests (order_id);

-- Only ONE pending request per order. A second submission while a request is
-- still pending silently reuses the existing row instead of inserting a dupe.
create unique index if not exists order_tracking_requests_one_pending_idx
  on public.order_tracking_requests (order_id)
  where status = 'pending';

alter table public.order_tracking_requests enable row level security;
-- No policies: only the service role (backend) may read/write. Anon and
-- authenticated browser clients are intentionally denied direct access.

-- 2) Admin opt-in flag ----------------------------------------------------------
-- notification_preferences already exists (one row per contact_email_id). The
-- tracking-request opt-in controls who gets the "new tracking request" admin
-- email. Defaults TRUE so existing recipients keep getting notified until an
-- owner turns it off on the admin Settings page.
alter table public.notification_preferences
  add column if not exists notify_tracking_requests boolean not null default true;

comment on column public.notification_preferences.notify_tracking_requests is
  'When true, this recipient is emailed whenever a customer requests tracking on /track-order.';
