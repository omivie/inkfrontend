# Email Verification

Supabase Auth handles email sending and token verification. The backend provides supporting endpoints and enforces verification on protected routes.

## Flow

```
1. User signs up → Supabase sends verification email automatically
2. User clicks link → redirected to frontend with token
3. Supabase JS client confirms the token → email_confirmed_at is set
4. User can now place orders
```

## Backend Endpoints

### GET /api/auth/verification-status
Check if current user's email is verified.

**Auth:** `requireAuth`
**Rate limit:** 30/min

**Response:**
```json
{
  "ok": true,
  "data": {
    "email": "user@example.com",
    "email_verified": true,
    "verified_at": "2026-03-04T12:00:00Z"
  }
}
```

### POST /api/auth/resend-verification
Resend the verification email.

**Auth:** `requireAuth`
**Rate limit:** 5 per 15 minutes

**Response:**
```json
{
  "ok": true,
  "data": {
    "message": "Verification email sent successfully",
    "email": "user@example.com"
  }
}
```

**Errors:**
- `400` — Email is already verified

### POST /api/auth/verify-email
Verify email with OTP token (for custom verification flows).

**Auth:** None (public)
**Rate limit:** 5 per 15 minutes

**Body:**
```json
{
  "token": "abc123...",
  "type": "email"
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "message": "Email verified successfully",
    "user": { "id": "...", "email": "...", "email_verified": true },
    "session": { "access_token": "...", "refresh_token": "...", "expires_at": 1234567890 }
  }
}
```

**Errors:**
- `400` — Invalid or expired verification token

## Where Verification Is Enforced

| Route | Middleware |
|---|---|
| `POST /api/orders` | `requireAuth` + `requireVerifiedEmail` |

Unverified users receive:
```json
{
  "ok": false,
  "error": {
    "code": 403,
    "message": "Please verify your email address to access this resource",
    "errorCode": "EMAIL_NOT_VERIFIED"
  }
}
```

## Frontend Integration

### 1. Signup — Pass Redirect URL
```js
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    emailRedirectTo: `${window.location.origin}/auth/verify`
  }
});
```

### 2. Verification Page (`/auth/verify`)
Supabase appends tokens to the URL hash. The Supabase JS client picks them up automatically when initialized on this page, confirming the email.

If using a custom flow, extract the token and call:
```js
const res = await fetch('/api/auth/verify-email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: tokenFromUrl, type: 'email' })
});
```

### 3. Handle EMAIL_NOT_VERIFIED Errors
When a user tries to place an order without verifying:
```js
if (error.errorCode === 'EMAIL_NOT_VERIFIED') {
  // Show verification prompt with resend button
}
```

### 4. Resend Verification Email
```js
const res = await fetch('/api/auth/resend-verification', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
```

### 5. Check Verification Status (Optional)
Show a banner on account/checkout pages for unverified users:
```js
const res = await fetch('/api/auth/verification-status', {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
const { data } = await res.json();
if (!data.email_verified) {
  // Show "Please verify your email" banner
}
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `EMAIL_VERIFICATION_REDIRECT_URL` | Override redirect URL for verification emails (optional, falls back to `FRONTEND_URL/auth/verify`) |
| `FRONTEND_URL` | Base URL of the frontend app |
