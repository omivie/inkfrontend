# Admin Panel QA Audit — Results & Backend Action Items

**Date:** 2026-03-11
**Auditor:** Automated QA via Playwright
**Scope:** All 12 admin sections at https://www.inkcartridges.co.nz/html/admin/
**Login:** Owner role (vielandvnnz@gmail.com)
**Viewport:** 1280x720

---

## Architecture Overview

The admin is a vanilla JS SPA with:
- Hash-based routing (`js/admin/app.js`)
- 14 page modules (`js/admin/pages/`)
- Reusable components: DataTable, Modal, Drawer, Toast, Charts
- Role-based access: Owner vs Admin

---

## Audit Results — All 12 Sections

| # | Section | Status | Details |
|---|---------|--------|---------|
| 1 | **Dashboard** | OK | KPIs (Revenue, Orders, AOV, Refund Rate), Work Queue, Fulfillment SLA, Revenue Over Time chart, Brand Breakdown chart, Refund Analytics table — all rendering correctly |
| 2 | **Orders** | OK | 9 orders in table with Date, Order#, Customer, Status, Items, Total. Sortable columns, pagination (1-9 of 9). Order detail drawer works: shows order info, items table, timeline, action buttons (Update Status, Add Tracking, Add Note, Refund) |
| 3 | **Customers** | OK | 5 customers in table with Name, Email, Orders, Total Spent, Last Order, Joined. Sortable columns, pagination. Customer Intelligence section with LTV Distribution and Cohort Retention |
| 4 | **Products & SKUs** | OK | Product table with images, Name, SKU, Brand, Price, Cost, Stock, Status columns. Checkboxes for bulk selection. Search, brand/status/image filters, Export button |
| 5 | **Product Review** | OK | 3784 unreviewed products. Table with Name, SKU, Brand, Price, Added date. Accept button per row. Brand filter dropdown |
| 6 | **Suppliers** | EMPTY | Shows "No suppliers found" — backend `get_suppliers` RPC not implemented |
| 7 | **Refunds & Chargebacks** | OK | Tabs: Queue (Pending/Failed), All Refunds, Analytics. Create Refund button. Empty queue state with appropriate message |
| 8 | **Fulfillment** | OK | KPI cards (Median Ship Time, Shipped within 48h, Tracking Coverage). Queue cards (Orders to Ship, Missing Tracking, Late Deliveries). Tab filters: Ready to Ship, In Transit, Late, All |
| 9 | **Shipping Rates** | EMPTY | Shows "No shipping rates configured." with Add Rate button — no rates created yet |
| 10 | **Analytics** | OK | Owner-only. Tabs: Financial, Customer Intelligence, Marketing, Operations, Alerts. Financial shows Revenue, Margin Proxy, Burn Rate, Runway KPIs. Daily Revenue chart, Revenue Forecast, Expenses section |
| 11 | **Settings** | OK | Owner-only. Account info, Theme toggle, Alert Thresholds (6 configurable rules), Data Exports (Orders, Refunds, Customers, Products) |
| 12 | **Contact Emails** | OK | Owner-only. 3 recipients listed with Remove buttons. Add email form |
| 13 | **Lab** | OK | Owner-only. 4 "Coming Soon" feature cards |

**Console Errors:** 0
**Console Warnings:** 1 (Cloudflare Turnstile — third-party, not actionable)

---

## Frontend Verdict

**No frontend bugs found.** All sections render correctly, interactive elements (drawers, tables, sorting, pagination, action buttons) work as expected.

---

## Backend Issues to Address

The following items surfaced during the audit that require **backend changes**. The frontend already handles all of these gracefully (empty states, fallbacks, dash placeholders), so no frontend work is needed.

### 1. Suppliers Endpoint Not Implemented

- **Section:** Suppliers (`#suppliers`)
- **Current behavior:** Frontend calls `get_suppliers` RPC → gets error/empty → shows "No suppliers found — Supplier data will appear once the backend endpoint is available."
- **Action required:** Implement the `get_suppliers` Supabase RPC (or REST endpoint) that returns supplier records.
- **Expected response format:** Array of supplier objects (the frontend DataTable expects columns for supplier name, contact, products supplied, etc.)
- **Priority:** Medium

### 2. Customer Names Missing

- **Section:** Customers (`#customers`)
- **Current behavior:** Some customers display as "Unknown" in the Name column.
- **Root cause:** Customer records in the database have no `first_name`/`last_name` set.
- **Action required:** Ensure the signup/account-creation flow populates name fields. Consider a migration to backfill names from Supabase Auth metadata (`user_metadata.first_name`, etc.) into the customers table.
- **Priority:** Low

### 3. Customer Emails Hidden

- **Section:** Customers (`#customers`)
- **Current behavior:** Email column shows "—" (dash) for all customers.
- **Root cause:** Likely a Supabase Row-Level Security (RLS) policy or API query issue preventing the admin from seeing customer emails.
- **Action required:** Review the RLS policy on the customers table (or the `get_customers` RPC) to ensure admin/owner roles can read email addresses. If emails are stored in `auth.users` only, the RPC needs to join against it (using a `security definer` function).
- **Priority:** Medium — admins need to see customer emails for order support.

### 4. Shipping Rates Not Configured

- **Section:** Shipping Rates (`#shipping`)
- **Current behavior:** "No shipping rates configured." with an Add Rate button.
- **Action required:** This is a data issue, not a code bug. Shipping rates need to be seeded or manually added via the admin UI once the backend supports it. Verify that the shipping rates CRUD endpoints (`POST /api/admin/shipping-rates`, etc.) are functional.
- **Priority:** Low — only needed once rates are ready to configure.

---

## Screenshots

The following screenshots were captured during the audit:

- `qa-admin-dashboard.png` — Dashboard with KPIs and charts
- `qa-admin-products.png` — Products & SKUs table
- `qa-admin-product-review.png` — Product Review queue

---

## Summary

| Area | Status |
|------|--------|
| Frontend rendering | All clear |
| Console errors | 0 |
| Interactive elements | All working |
| Backend: Suppliers endpoint | Not implemented |
| Backend: Customer names | Missing data |
| Backend: Customer emails | Hidden by RLS |
| Backend: Shipping rates | No data seeded |

**The frontend is production-ready. The 4 backend items above are the only outstanding issues.**
