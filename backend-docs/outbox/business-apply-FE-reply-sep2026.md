# FE reply: /business Apply is live (your round-2 §8), and three things we measured (BF-095)

**From:** FE developer · **For:** backend · **Date:** 2026-09-29
**Answers:** `fe-best-sellers-and-four-replies-round2-backend-response-sep2026.md` §8, and turnaround doc #10
**FE record:** ERR-297. Best sellers (BF-089/090) and BF-088/091/092/093 are answered separately (ERR-299).

Thank you for §8. You were right: our 404 came from a GET.

## What we built

`/business` is now an open page for everyone who is not an approved account:
- the terms (Net 30 once approved, GST tax invoices, PO number);
- the volume ladder from `GET /api/site/value-props`;
- a named contact and phone number;
- links to `/quote` and `/bulk-pricing`;
- an Apply panel.

The Apply panel reads `GET /api/business/status`:

| `status` / `can_apply` | Panel |
|---|---|
| signed out | Sign in / create an account, then back to `/business#apply` |
| `personal` | Form, posts to `POST /api/business/apply` |
| `rejected` | "Apply again" form, posts to `POST /api/business/reapply` |
| `pending` | "We have your application", no form |
| `suspended`, `closed`, or `can_apply: false` | "Talk to us", no form |
| `approved` | The Business Centre dashboard, as before |

We send the three required fields plus any optional field the user filled in. Blank optional fields are left out, not sent as `""`.

After a refused POST we do not guess from the error code. We re-read `/status` and render what it says.

## BF-095: three things we measured

**1. `can_apply` is not in the `/api/business/status` response.** Measured 2026-09-29 on the owner's approved account, the response keys are `status`, `application`, `credit_limit`, `credit_remaining` and `net30_approved`. There is no `can_apply`. §8 says `/status` returns it.
- Is it returned only for non-approved users, or not deployed yet?
- Until we know, we treat a missing `can_apply` as **unknown**: we show the form and let your 409 decide. We never read it as `false`, because that would hide the form from every prospect.
- Please confirm it is always present for `personal`, `pending` and `rejected`.

**2. `POST /api/business/apply` allows 5 requests per IP per 24 hours, counted before sign-in.** The response headers were:

```
ratelimit-policy: 5;w=86400
ratelimit-remaining: 0
retry-after: 84657
```

We reached the limit with two unauthenticated test requests and one probe run. All of them were refused with 401, but each still counted. Two concerns:
- Several people applying from one office connection (one NAT address) share the 5.
- Requests that fail sign-in still use up the quota. Anyone on a shared connection can use it up for the next real applicant.

Could the limiter count per signed-in user, after authentication? Or could it count only requests that pass sign-in?

For now the page tells a rate-limited applicant to call or email. Our probe's POST checks are opt-in.

**3. What is the request body of `POST /api/business/credit-reference`?** §8 names the route but not its body. We have not built a trade-references step because we would have to guess the fields.
- Please send the required and optional fields, the responses, and whether it may be called while the application is `pending`.

## Also

- A 409 from `/apply` reaches us with an error code we don't know. What is the code for "already pending" and for "already approved"? We handle both by re-reading `/status`, so this is only for our logs.
- One fix on our side, found while building this: our post-sign-in redirect check accepted `/\evil.com`, which browsers resolve to `https://evil.com/`. It is fixed. We mention it only in case the backend's prerender or email links build similar same-site checks.
