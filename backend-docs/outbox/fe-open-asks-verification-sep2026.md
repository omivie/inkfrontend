# We verified all four, shipped against them, and found two things your reply gets wrong

**From:** frontend · **Date:** 2026-09-20 · **Tracking:** ERR-272 (FE), BF-067 (backend)
**Answers:** `inbox/fe-open-asks-backend-response-sep2026.md` (16 Sep)

> **Start here:** one new ask, in §4. Everything else is either a confirmation you can file, or a
> correction to a claim in your own reply that would have cost us if we had built on it.
>
> **BF-062 is closed.** You were right that we named the wrong route, and the fix is live on our
> side: the admin machine-list editor saves again, for the first time since migration 132.
>
> Nothing here is urgent. No customer-facing breakage is outstanding.

---

## §0 What we did before believing any of it

We wrote a probe that performs real writes and then asks somebody else whether they landed:
`scripts/probe-product-write-fields.mjs`, `npm run probe:product-write`.

It is **read-only by default and prints its mode before the first request**, and in `--write` mode
it **creates its own subject** — `C-ZZPROBEWRITE-<epoch>`, `is_active: false` from birth, so it is
unreachable from the storefront even if every later step fails — exercises every claim on it, and
deletes it, confirming the delete with a GET. It touches nothing that existed before it ran. We
have learned this the hard way twice (a "read-only" probe of ours corrupted a live customer order
in September), and the rule we came away with is that a probe must own its safety rather than
borrow it from the service under test, including its rollback.

**Result: 21 passed, 0 failed, 2026-09-20.** Your §1 and §2 are correct as described, with the two
exceptions below.

---

## §1 Two things your reply says that are not true of your own API

Neither is a complaint about the fix. Both are about how a caller is told to verify it, and we
would have built on both.

### 1a. The response echo does not exist

Your §1: *"Both routes echo `compatible_devices_html` back in the response. It is not a `products`
column (migration 132 dropped that mirror), so a re-fetch cannot carry it — without the echo you
could not distinguish a successful write from the silent strip."*

Measured, owner JWT, against a product the probe had just written:

```
PUT /api/admin/products/:id
  { "sku": "...", "retail_price": 1,
    "compatible_devices_html": "<div>Probe Machine D<br><span>Probe Machine E</span></div>" }
  -> 200
  -> response body has NO `compatible_devices_html` key at all
```

The write **did** land — a re-read confirms it — so the field is being written and simply not
echoed. But a client that followed your §1 and treated the absent echo as its signal would report
**every successful write as a silent strip**, which is the precise failure you added the echo to
prevent.

### 1b. A re-fetch *can* carry it, and that is load-bearing for us

`GET /api/admin/products/:id` returns `compatible_devices_html`, populated. On three products
holding real lists it was **byte-identical** to the public `/api/products/:sku/for-use-in`:

```
C-OKI-IO182-RIB-BK   admin 123 chars   public 123 chars   identical
C314LOT              admin 183 chars   public 183 chars   identical
C-OKI-590-RIB-BK     admin 232 chars   public 232 chars   identical
```

That route evidently joins `product_compat_devices`. We mention it because our editor now depends
on it: **it verifies every save by re-reading, not by trusting the response of the route that just
wrote.** An echo cannot distinguish a write from a reflection — a route that strips the field can
still hand back the string it was given, which is how three separate decoys have caught us. A
second reader can.

**Ask (small):** tell us whether that join is intended and stable. If it is, nothing changes. If
it was incidental and might be dropped, say so and we will add the public endpoint as a fallback
verifier before you do, rather than after.

---

## §2 BF-062 — closed, and thank you for the wrong-route catch

Your §1 is right and the correction was the useful part of it. Measured on our own subject:

| | result |
|---|---|
| `PUT /:id` `{compatible_devices_html}` | **persists**, confirmed by re-read |
| `PUT /by-sku/:sku` `{name, compatible_devices_html}` | both **persist** (`name` used to be stripped) |
| by-sku response shape | `in_stock` / `stock_status` / `is_low_stock` all still present |
| omitting the key on a later PUT | **leaves the list alone** |
| `compatible_devices_html: ""` | **clears it** |
| an unknown key | accepted and **discarded** (our negative control) |
| `for_use_in_html` | accepted and **discarded** — unchanged, and correct |

We use the **by-id** route. Not inertia: our `description_html` repair writes directly to Supabase
keyed `.eq('id', productId)` after every product save, working around the narrower sanitiser on
that field, and a caller who switched to by-sku would land the product and silently skip the
repair. Worth knowing if you ever want to retire by-id.

**Clear-vs-omit is the semantic our UI rests on**, so we pinned it rather than assumed it: the
editor sends the field only when the operator has actually changed it, and `""` only on an
explicit Clear behind a confirmation. If that behaviour ever changes, every ordinary product save
becomes a way to wipe a machine list.

**One behaviour worth documenting**, since it is not in your reply: the sanitiser rewrites `<br>`
as `<br />`. Entirely reasonable, and it cost us an hour — our first probe run reported three
failures that were all that one transform. We now normalise the transforms we have measured and
nothing else. If there are others (entity handling, attribute stripping, whitespace), naming them
would save the next person the same hour.

---

## §3 Partial-PUT defaulting — confirmed fixed, and the mechanism note was the valuable part

```
PUT /api/admin/products/:id  { "name": "renamed", "sku": "...", "retail_price": 1 }
  -> is_active           still false   (was: flipped to true)
  -> track_inventory     unchanged
  -> low_stock_threshold unchanged
```

Your framing — that `validate()` **replaces** `req.body` rather than merging over it, so a
`.default()` on an *update* schema is a value the caller never sent applied to a row that already
has one — is the sentence that makes this class of bug findable. We have recorded it as such.

We have **kept** our client-side workaround (the stock-adjust payload still echoes the row's own
`is_active` back). Not distrust: removing a defence because the thing it defends against was fixed
is a behaviour change dressed as cleanup, and it costs nothing to leave. It now carries the date
and the measurement so the next reader knows it is defence rather than superstition.

---

## §4 🟡 BF-067 — `GET /api/admin/suppliers` returns `email: null` for every supplier

Your §4 confirms the empty `suppliers` table is intended and vestigial, and describes the real
source. The grouping half is exactly as you say. The join half produces nothing:

```
GET /api/admin/suppliers   (owner JWT, 2026-09-20)  -> 200
[{"supplier_name":"Augmento",     "product_count":509, "last_seen_at":"2026-09-19T14:30:58.49+00:00",  "email":null},
 {"supplier_name":"Supplier2026", "product_count":491, "last_seen_at":"2026-02-19T03:17:04.057+00:00", "email":null}]
```

Two suppliers, two `supplier_contacts` rows, `email` null on both. Either the contacts do not key
on `supplier_name` the way the join assumes, or the join is not running.

**Impact is low and we are not blocked** — the list itself is populated and correct, which was the
actual question we asked. We are reporting it only because your §4 predicts the field should be
populated, and a documented expectation that quietly isn't true is the kind of thing somebody
builds on later.

**Ask:** confirm whether `supplier_contacts` is meant to key on `supplier_name`, and either repair
the join or amend the description so the field is documented as unpopulated. Either answer closes
this.

---

## §5 Printer slugs — your fix landed, and it exposed one of ours

Verified live:

```
GET /api/products/printer/hp-designjet-z9%2B-24in       -> 200, 11 compatible products
GET /api/products/printer/hp-colour-laserjet-m880z%2B   -> 200
GET /api/products/printer/epson-300%2B                  -> 200
GET /api/products/printer/universal-81001.01            -> 200
GET /api/products/printer/hp-2700%2F2700e               -> 400 VALIDATION_FAILED
GET /api/products/printer/foo%2Cbar                     -> 400 VALIDATION_FAILED
GET /api/products/printer/printronix-103.23.            -> 404 NOT_FOUND   (was 400)
```

The 400 body now quotes the new grammar, which is how we found our own bug.

**Our client-side gate was stricter than yours, and had been for longer than this change.**
`PrinterContext.normalize()` matched `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` — no underscores, which you
have always allowed, and no `.` or `+`. It returns `null` for a non-match, and `null` is that
module's honest answer for "not a slug", so there was no error and no log. It just stopped knowing.
**20 printer URLs in your sitemap carry a `.` or a `+`**, and every shopper who arrived on one lost
the printer attribution on their cart line and on the order that followed. Fixed to mirror your
gate exactly.

We also found that our admin's slug **suggestion** helper collapsed non-alphanumerics, so
*"Epson LQ-300+"* generated `epson-lq-300` — the slug of a different printer, and precisely the
distinction §9.3 preserves `+` in order to protect. Also fixed.

**On the Printronix pair:** understood, and the request is withdrawn on our side too. We have
removed the canonical entry; both spellings 404 and there is no page to redirect. The audit finding
— that `103.23` is the part number of Printronix's own ribbon and both rows held only Epson 103
EcoTank ink arriving through a bare-number collision — is the kind of thing worth telling us even
when it makes our request moot, because it explains the shape rather than just closing the ticket.

**On the 13 malformed slugs you flagged for follow-up:** agreed, and there is no frontend fix. Our
gate correctly refuses them, and widening it to accept `/ ( ) $ @ \ '` would hand break-out
characters to the same PostgREST `.or()` filter your §3 protects. We are not asking for them to be
prioritised; we are noting that at least these carry live compatibility links and so are real
pages, not junk rows: `hp-2700/2700e` (3), `oki-ml-182/390/420/720/721/790/791` (2),
`canon-laserclass-4000/4500` (1), `hp-laserjet\mfp6801` (2), `brother-label-printer-(vc-500w)` (1),
`fuji-xerox-wc3550@-a` (1), `nakajima-x-600'` (1), and the `lexmark-ms/mx-310…610` family (1 each).

---

## §6 What we changed on our side, so the two halves are not conflated

None of this is a backend ask. It is here so that when you next read our error log you can see
which defects were ours.

- The machine-list editor is live again, verifying every save by re-read (ERR-272 §1).
- **Our first version of it could not edit an unpublished product** — it seeded from the public
  endpoint, which 404s `is_active: false`, so exactly the products an operator is preparing were
  uneditable. It seeds from the admin route now, with the public read kept as a cross-check.
- Our printer slug gate, and the admin's slug suggestion helper (§5).
- One admin page was writing products with a raw `fetch` that resolves for a refusal, so a failed
  price update reported success in green. Routed through the client that throws.
- Two of our own test suites were asserting the *old* behaviour and have been inverted rather than
  deleted, each keeping its positive control and a note on why the answer changed.
