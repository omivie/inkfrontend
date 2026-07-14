-- =============================================================================
-- product_codes — manual categorisation codes for products
-- =============================================================================
-- A product is categorised brand > type > CODE (e.g. Brother > Ink > LC40).
-- The /shop drilldown groups products into "code" chips. Until now those codes
-- were derived only — the backend extracts `series_codes` from each product's
-- name / SKU / part-number at query time, with no way for an admin to correct
-- or extend them.
--
-- This table is the MANUAL OVERRIDE layer. One row per (product, code). A
-- product may carry several codes so it appears under several chips at once —
-- e.g. an LC40 cartridge also tagged LC57 shows under BOTH on /shop.
--
-- SEMANTICS — "manual fully replaces auto":
--   • A product WITH any product_codes rows  → that set IS its complete code
--     list. The customer /shop ignores the backend-derived series_codes for it.
--   • A product with NO product_codes rows   → unchanged; the backend-derived
--     series_codes still drive its chips. The table is a pure override layer,
--     so products nobody has curated cost /shop nothing.
--
-- CODE FORMAT: UPPERCASE, A-Z/0-9, 2-24 chars, with "/" allowed as an internal
-- separator so the backend's merged pair codes (PG40/CL41) round-trip. See the
-- migration block below — it must be run against an existing live table.
--
-- Two admin surfaces write here:
--   • The product drawer ("Product Codes" tab) — per-product, pre-filled with
--     the product's current derived codes, so the admin always edits from a
--     correct starting point.
--   • The Product Codes page (/admin#product-codes) — per-CODE: rename, delete,
--     create, and edit which products carry a code, across a brand+category.
--
-- WRITES: browser, Supabase JS client, admin's authenticated session
--         (inkcartridges/js/admin/api.js → AdminAPI.setProductCodes).
-- READS:  customer /shop, anon — inkcartridges/js/api.js → getShopData.
--
-- Idempotent — safe to run more than once.
--
-- HOW TO APPLY:  Supabase dashboard → SQL Editor → paste this file → Run.
-- Project: lmdlgldjgcanknsjrcxh
-- =============================================================================

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.product_codes (
  product_id uuid        not null references public.products (id) on delete cascade,
  code       text        not null,
  created_at timestamptz not null default now(),
  primary key (product_id, code),
  -- Codes are stored normalised: UPPERCASE, A-Z/0-9, 2-24 chars, with "/" as an
  -- internal separator for the merged PAIR codes the backend emits (PG40/CL41,
  -- PGI5/CLI8 — a black+colour cartridge sold under one chip). The frontend
  -- normalises before writing (strips spaces/hyphens, uppercases, collapses and
  -- trims slashes) so "pg40 / cl41" and "PG40//CL41/" both land as "PG40/CL41".
  -- The segment regex permits "PG40/CL41" while still rejecting a bare "/",
  -- a trailing "PG40/", and a doubled "PG40//CL41".
  constraint product_codes_code_format
    check (code = upper(code)
           and char_length(code) between 2 and 24
           and code ~ '^[A-Z0-9]+(/[A-Z0-9]+)*$')
);

comment on table public.product_codes is
  'Manual product categorisation codes (the /shop drilldown chips). One row per (product, code). A product with rows here has its derived series_codes fully overridden on the storefront.';

-- ── Migration: allow "/" in codes (Jul 2026) ─────────────────────────────────
-- The table already exists on live, so the CHECK inside `create table if not
-- exists` above is a no-op there — the constraint has to be swapped explicitly.
--
-- WHY: the backend derives merged PAIR codes for cartridges sold as a
-- black+colour set, and emits them verbatim as /shop chips — PG40/CL41,
-- PGI5/CLI8, PG510/CL511. The original A-Z0-9-only rule made those codes
-- unrepresentable here: the frontend normaliser stripped the slash, "PG40/CL41"
-- became "PG40CL41", and it matched no product. Renaming or deleting such a chip
-- in the admin silently affected 0 products while appearing to succeed.
--
-- The new constraint is strictly LOOSER than the old one, so revalidating the
-- existing rows cannot fail. Idempotent — drop-then-add.
alter table public.product_codes
  drop constraint if exists product_codes_code_format;

alter table public.product_codes
  add constraint product_codes_code_format
  check (code = upper(code)
         and char_length(code) between 2 and 24
         and code ~ '^[A-Z0-9]+(/[A-Z0-9]+)*$');

-- "Every product with code X" — the reverse lookup the /shop ?code= recovery
-- and the chip-count views both lean on. The (product_id, code) PK already
-- indexes the forward direction.
create index if not exists product_codes_code_idx on public.product_codes (code);

-- ── Row-level security ───────────────────────────────────────────────────────
-- Codes are catalogue metadata, not sensitive: the storefront reads them
-- anonymously. Writes are limited to authenticated sessions — the same posture
-- as product_ribbon_brands, the sibling junction the admin already writes.
alter table public.product_codes enable row level security;

drop policy if exists "product_codes_select_all" on public.product_codes;
create policy "product_codes_select_all" on public.product_codes
  for select using (true);

drop policy if exists "product_codes_insert_auth" on public.product_codes;
create policy "product_codes_insert_auth" on public.product_codes
  for insert to authenticated with check (true);

drop policy if exists "product_codes_delete_auth" on public.product_codes;
create policy "product_codes_delete_auth" on public.product_codes
  for delete to authenticated using (true);

-- No UPDATE policy: setProductCodes() replaces a product's codes with a
-- delete-then-insert, never an in-place edit (codes have no mutable fields).
grant select          on public.product_codes to anon, authenticated;
grant insert, delete  on public.product_codes to authenticated;

-- ── View: code catalogue (admin picker) ──────────────────────────────────────
-- Every distinct code plus how many products carry it. Powers the admin code
-- picker's autocomplete list ("LC40 · 12 products") and dedupes typed codes.
create or replace view public.product_code_catalogue as
  select code,
         count(distinct product_id)::int as product_count
  from public.product_codes
  group by code;

comment on view public.product_code_catalogue is
  'Distinct manual codes with product counts — drives the admin Product Codes picker.';

-- ── View: chip counts (customer /shop drilldown) ─────────────────────────────
-- Manual codes rolled up by brand + product_type so the /shop codes drilldown
-- can surface a chip for a code no product was auto-detected into (the LC57
-- case). Keyed by brand SLUG + product_type — the two facts api.js holds when
-- it builds the drilldown — so no uuid/category translation is needed client
-- side.
create or replace view public.product_code_chip_counts as
  select b.slug        as brand_slug,
         p.product_type as product_type,
         pc.code        as code,
         count(distinct p.id)::int as product_count
  from public.product_codes pc
  join public.products p on p.id = pc.product_id and p.is_active = true
  join public.brands   b on b.id = p.brand_id
  group by b.slug, p.product_type, pc.code;

comment on view public.product_code_chip_counts is
  'Manual codes rolled up by brand slug + product_type — lets /shop show a drilldown chip for an entirely manual code.';

grant select on public.product_code_catalogue   to anon, authenticated;
grant select on public.product_code_chip_counts to anon, authenticated;
