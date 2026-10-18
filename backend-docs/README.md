# `backend-docs/` — correspondence with the backend dev

**The rule: everything we still need from the backend is in ONE file in `backend-docs/outbox/`**
(2026-10-18: `backend-asks-2026-10-18.md`, not sent yet; history in `STATUS.md`), never in the
repo root. That one file is what gets sent.

```
backend-docs/
  STATUS.md   the index: one row per open section, with its evidence
  outbox/     ONE file: every open ask, one numbered section each
  inbox/      theirs, copied out of ~/Downloads.
```

## Lifecycle

- **New ask:** add a numbered section to the outbox file, and a row in `STATUS.md`.
- **Answered:** check the answer against live code and the live API first. Then delete the section and its row.
- **Nothing left:** delete the file.

Answered documents are deleted, not archived. `sent/` and `bundles/` were removed on 2026-10-15 (owner).
Their text is in git history: see the commit hash in `STATUS.md`.

**A doc with no reply is not a stale doc.** Before you delete a section, check its ask against live code.
**The backend dev can read this repo**, so anything committed and pushed is available to them.

## What is NOT in here, deliberately

- **`readfirst/`** — the frozen historical inbox. Three tests hard-require paths inside it
  (`order-shipping-information-sep2026.test.js`, `admin-orders-invoice-sent-channel-sep2026.test.js`,
  `orders-tracking-requested-column-sep2026.test.js`). **Do not move it.** New incoming
  docs go to `inbox/`; the old ones stay where the tests can find them.
- **`errors.md`** — repo root, pinned by `tests/err-numbering-jul2026.test.js:38`.
- **`ADMIN_CENTRE_AUDIT.md`** — internal documentation, not correspondence.

`backend-docs/` sits at the repo root, outside `inkcartridges/` — the published web root —
so nothing in here is served (ERR-229).
