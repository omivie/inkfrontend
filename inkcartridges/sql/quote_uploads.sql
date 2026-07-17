-- =============================================================================
-- quote-uploads — private write-only Storage bucket for /quote attachments
-- =============================================================================
-- The /quote trade-quote form (Jul 2026 redesign) lets a customer attach a
-- photo of their printer/cartridge, a supplier invoice, or a product list
-- (PDF/CSV/XLSX/JPEG/PNG/WebP). Files upload straight from the browser via
-- supabase-js into this bucket; the quote email then carries each file's
-- storage path so the owner can open it.
--
-- SECURITY MODEL — a "write-only dropbox":
--   • The bucket is PRIVATE (public = false): no anonymous reads, ever.
--   • anon + authenticated may INSERT into this bucket only. Nothing else.
--   • There is deliberately NO select / update / delete policy. Admin status
--     in this project is verified by the backend (GET /api/admin/verify), not
--     by a JWT claim or role table Postgres can see — so any
--     `for select to authenticated` policy would let EVERY signed-in customer
--     read other businesses' invoices. Until the backend grows a signed-URL
--     endpoint, the owner opens files via the Supabase dashboard (Storage →
--     quote-uploads), whose service role bypasses RLS. Paths are in the email.
--   • Server-enforced limits (cannot be bypassed by a hostile client):
--     10 MB per file, and only the six MIME types the form accepts.
--
-- ACCEPTED TRADE-OFFS (documented, revisit when a backend /api/quote ships):
--   • Orphan files: a customer can upload then abandon the form, and "remove"
--     in the UI only drops the file from the submission (anon has no DELETE).
--     Volume is tiny; prune occasionally via dashboard, or add a cleanup job
--     to the backend follow-up.
--   • No rate limiting on anonymous uploads beyond Supabase's own; the bucket
--     caps size/type but not count. Acceptable at this site's traffic.
--
-- WRITES: browser, anon supabase-js session (inkcartridges/js/quote-page.js,
--         bucket name constant BUCKET = 'quote-uploads').
-- READS:  owner only, via Supabase dashboard (service role).
--
-- Idempotent — safe to run more than once.
--
-- HOW TO APPLY:  Supabase dashboard → SQL Editor → paste this file → Run.
-- Project: lmdlgldjgcanknsjrcxh
--
-- RELATED MANUAL STEP (not SQL): Cloudflare dashboard → Turnstile → widget
-- 0x4AAAAAACoGsire3IW5cBB9 → add `localhost` and `127.0.0.1` to the allowed
-- hostnames, so the /quote CAPTCHA renders during local development instead
-- of "Unable to connect to website".
-- =============================================================================

-- ── Bucket ───────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'quote-uploads',
  'quote-uploads',
  false,                -- PRIVATE: no anonymous reads
  10485760,             -- 10 MB per file, enforced server-side
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public             = false,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── Policies ─────────────────────────────────────────────────────────────────
-- INSERT only. No select/update/delete policies exist for this bucket — see
-- the security model above before adding any.
drop policy if exists "quote_uploads_insert_anon" on storage.objects;
create policy "quote_uploads_insert_anon" on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'quote-uploads');
