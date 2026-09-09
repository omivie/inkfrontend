# `backend-docs/` — correspondence with the backend dev

**The rule: every backend-facing markdown file is written to `backend-docs/outbox/`,
never to the repo root.** Move it to `sent/` when a backend document answers it.

```
backend-docs/
  STATUS.md   the index — every doc, its direction, its status, the evidence
  outbox/     ours, written for the backend. No reply on record.
  sent/       ours, PROVEN received — a backend doc answers, names, or cites it.
  inbox/      theirs, copied out of ~/Downloads.
```

## What "sent" means here, and what it does not

There is **no delivery record**. Outgoing docs are handed over out-of-band; incoming
ones arrive in `~/Downloads`. So `sent/` is not "we posted it" — it is the far stronger
and far rarer claim that **the backend demonstrably read it**:

- a backend-authored doc that postdates ours **names it**, or
- that doc cites a `BF-` / `ERR-` number that **originates in ours**.

`outbox/` therefore means *no reply on record* — it does **not** mean undelivered.
**The backend dev can read this repo**: `security-hardening-sep2026-round2-FE-handoff.md`
cites `tests/security-hardening-sep2026.test.js:234`, a file that is not web-published.
Anything committed and pushed is available to them whether or not it was handed over.

## Before deleting anything in here

**A doc with no reply is not a stale doc.** Every unanswered doc audited on 2026-09-09
still carried at least one open ask that exists in no other document — `page-copy-editor-backend-brief.md`
is still the only spec for an endpoint that 404s today (`page-copy.js:926` still renders
*"Publishing is not available"*); `orders-supplier-origin-backend-brief.md` is still the
live contract for the `origin` field that `sourcing.js:18` points at. Check the ask
against live code first.

## What is NOT in here, deliberately

- **`readfirst/`** — the frozen historical inbox. Three tests hard-require paths inside it
  (`order-shipping-information-sep2026.test.js`, `admin-orders-invoice-sent-channel-sep2026.test.js`,
  `orders-tracking-requested-column-sep2026.test.js`). **Do not move it.** New incoming
  docs go to `inbox/`; the old ones stay where the tests can find them.
- **`errors.md`** — repo root, pinned by `tests/err-numbering-jul2026.test.js:38`.
- **`ADMIN_CENTRE_AUDIT.md`** — internal documentation, not correspondence.

`backend-docs/` sits at the repo root, outside `inkcartridges/` — the published web root —
so nothing in here is served (ERR-229).
