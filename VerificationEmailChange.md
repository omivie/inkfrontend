# Verification Email — Backend Change (March 2026)

## What Changed

Verification emails are no longer sent by Supabase's built-in email system. They now go through our own Resend/SMTP pipeline so they actually get delivered and match our branding.

**No frontend API changes are required.** The existing endpoints behave the same way — same request/response shape.

## Behaviour Changes

### On Signup (`POST /api/account/sync`)

- When a new user profile is created and their email is **not yet verified**, the backend automatically sends a branded verification email.
- This is fire-and-forget — the sync response is unchanged.
- **Frontend does NOT need to call resend-verification after signup.** The email goes out automatically.

### Resend Verification (`POST /api/auth/resend-verification`)

- Works exactly the same from the frontend's perspective (same request, same response).
- Backend now sends via our own email system instead of `supabase.auth.resend()`.
- Rate limit: still 5 requests per 15 minutes (unchanged).
- Idempotency: if a verification email was already sent in the last hour, the backend skips the duplicate silently and returns success.

### Verification Link Behaviour

- The link in the email redirects to: `EMAIL_VERIFICATION_REDIRECT_URL` env var (falls back to `FRONTEND_URL/auth/verify`).
- This is the same redirect URL that was configured before — **no change to the verification flow on the frontend**.
- The link is a standard Supabase verification link. When clicked, Supabase verifies the user and redirects to the frontend with the usual token parameters.

## What the Frontend Should Do

1. **Nothing changes for the happy path.** Signup → auto verification email → user clicks link → lands on `/auth/verify` → existing flow handles it.
2. **Keep the "Resend verification" button** — it still calls `POST /api/auth/resend-verification` and works as before.
3. **Optional cleanup:** If you were calling resend-verification immediately after signup as a workaround, you can remove that — the backend now handles it automatically on account sync.

## Email Appearance

The verification email now matches our branded style (green "INK STORE" header, CTA button, footer with support email). It looks like the invoice/tracking emails users already receive.

## Debugging

Check the `email_queue` table in Supabase:
```sql
SELECT * FROM email_queue
WHERE email_type = 'email_verification'
ORDER BY created_at DESC
LIMIT 10;
```

Status values: `pending` → `processing` → `sent` (or `failed` after 3 retries).
