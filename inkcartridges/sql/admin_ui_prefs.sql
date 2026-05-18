-- =============================================================================
-- admin_ui_prefs — per-admin UI preferences
-- =============================================================================
-- One JSONB row per admin account. Powers the per-account column picker on the
-- admin Products table (key "products.columns") and is reusable for any future
-- per-admin layout state. Read and written directly from the browser via the
-- Supabase JS client, so the table is RLS-locked: an admin can only ever see or
-- change their OWN row — one account can keep "For Use In" always on while
-- another keeps it off, with zero cross-talk.
--
-- The frontend (inkcartridges/js/admin/api.js → AdminAPI.getUiPrefs / setUiPref)
-- is fail-open: if this table does not exist yet it silently falls back to
-- localStorage. Running this script upgrades the feature to cross-device sync.
--
-- Idempotent — safe to run more than once.
--
-- HOW TO APPLY:  Supabase dashboard → SQL Editor → paste this file → Run.
-- Project: lmdlgldjgcanknsjrcxh
-- =============================================================================

create table if not exists public.admin_ui_prefs (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  prefs      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.admin_ui_prefs is
  'Per-admin UI preferences (e.g. Products table column visibility). One row per account, RLS-locked to the owning user.';

alter table public.admin_ui_prefs enable row level security;

-- An admin may only read their own preferences row.
drop policy if exists "admin_ui_prefs_select_own" on public.admin_ui_prefs;
create policy "admin_ui_prefs_select_own" on public.admin_ui_prefs
  for select using (auth.uid() = user_id);

-- ...and only insert a row keyed to themselves.
drop policy if exists "admin_ui_prefs_insert_own" on public.admin_ui_prefs;
create policy "admin_ui_prefs_insert_own" on public.admin_ui_prefs
  for insert with check (auth.uid() = user_id);

-- ...and only update their own row (both the existing row and the new values).
drop policy if exists "admin_ui_prefs_update_own" on public.admin_ui_prefs;
create policy "admin_ui_prefs_update_own" on public.admin_ui_prefs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The browser client authenticates as the `authenticated` role. The upsert in
-- setUiPref() needs INSERT + UPDATE; reads need SELECT. No DELETE is granted —
-- preferences are only ever overwritten, never removed.
grant select, insert, update on public.admin_ui_prefs to authenticated;
