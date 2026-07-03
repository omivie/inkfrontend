/**
 * AdminAPI — Admin-specific API layer
 * Uses window.API for REST calls + Supabase RPC for analytics
 */

// Direct RPC via Supabase REST — avoids creating a second GoTrueClient
async function rpc(fnName, params = {}, signal = null) {
  try {
    if (signal?.aborted) return null;
    const token = window.Auth?.session?.access_token;
    if (!token) throw new Error('Unauthorized');
    const url = `${Config.SUPABASE_URL}/rest/v1/rpc/${fnName}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': Config.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(params),
      signal,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: resp.statusText }));
      throw new Error(err.message || `RPC ${fnName}: ${resp.status}`);
    }
    const text = await resp.text();
    const result = text ? JSON.parse(text) : true;
    // Supabase RPCs that RETURN TABLE return arrays even for single-row results.
    // Unwrap single-element arrays so callers can access fields directly.
    if (Array.isArray(result) && result.length === 1) return result[0];
    return result;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    DebugLog.warn(`[AdminAPI] RPC ${fnName} failed:`, e.message);
    return null;
  }
}

// Warn in console and show a user-visible toast for silent read failures.
// Toast may not exist in all contexts (e.g. tests) so we guard with typeof.
function adminApiWarn(label, e) {
  DebugLog.warn(`[AdminAPI] ${label} failed:`, e.message);
  if (typeof Toast !== 'undefined') Toast.error(`${label}. Please try again.`);
}

// Build an Error from a non-OK API envelope. The invoices backend uses the
// house object error shape `{ ok:false, error:{ code, message, details } }`,
// so pull `.error.message` (never let an object coerce to "[object Object]");
// stay tolerant of a legacy string `error`. Mirrors the createCoupon pattern.
function invoiceError(resp, fallback) {
  const e = resp?.error;
  let msg = (e && typeof e === 'object' ? e.message : e) || fallback;
  // VALIDATION_FAILED carries field-level specifics in details[]; surface them
  // so the operator sees what to fix, not just a generic "Validation failed".
  if (e && typeof e === 'object' && Array.isArray(e.details) && e.details.length) {
    msg += ': ' + e.details.map((d) => d.message || d).join(', ');
  }
  const err = new Error(msg);
  if (e && typeof e === 'object') { err.code = e.code; err.details = e.details; }
  // String-error envelopes (e.g. 404 "Endpoint not found") carry the machine
  // code at the top level — keep it so callers can branch (e.g. "backend pending").
  if (!err.code && resp?.code) err.code = resp.code;
  return err;
}

// Rich-text product columns that the backend's HTML sanitiser mangles.
//
// The backend's `PUT/POST /api/admin/products` runs an allowlist sanitiser
// that keeps only `p, strong, em, br, ul, ol, li` — it strips `b, i, u, a,
// span, h2` (probed live 2026-05-18). The admin rich-text editor's Bold,
// Italic, Underline and Link buttons emit exactly `<b>/<i>/<u>/<a>`, so every
// formatting change the user made was silently destroyed on save.
//
// Fix: after the backend write, re-persist these two columns straight to
// Supabase (admin RLS already permits product updates), so the editor's HTML
// round-trips losslessly. The customer PDP reads these same columns directly
// from Supabase (product-detail-page.js), so the formatting reaches the
// storefront intact. See errors.md ERR-034.
const RICH_TEXT_PRODUCT_COLUMNS = ['description_html', 'compatible_devices_html'];

// ===========================================================================
// Admin analytics — resilient HTTP wiring (ERR-010 permanent fix, Jun 2026)
// ===========================================================================
//
// The dashboard's headline analytics (KPIs, revenue series, refunds, top
// products, customer stats) used to call the Supabase Postgres RPCs DIRECTLY
// from the browser (analytics_kpi_summary, …). Those RPCs depend on a
// `GRANT EXECUTE TO authenticated` that backend redeploys keep dropping — so
// the calls intermittently 403 ("permission denied for function") and the
// dashboard silently degrades to "—" or the order-reconstructed fallback.
// (Probed live 2026-06-04: analytics_customer_stats was 403 right then.)
//
// The backend now exposes a service-role HTTP wrapper for every one of these
// under /api/admin/analytics/* (see Downloads/analytics-api-spec.md). The
// wrapper holds its own grants — immune to the authenticated-role GRANT being
// dropped — and falls back to a JS-computed equivalent server-side, flagging
// `data.fallback = true`. So we route through HTTP FIRST and keep the direct
// RPC only as a secondary fallback (covers the inverse outage: backend down
// but Postgres grant healthy). Either side of the outage, the strip self-heals.
//
// The live HTTP payloads were verified to be byte-shape-identical to the RPCs
// the dashboard already consumed, so this is a near drop-in. `normalizeKpiSummary`
// additionally tolerates the metric-keyed shape the spec DOC describes, so the
// dashboard survives a future backend reshape without code changes.

// Convert a FilterState URLSearchParams (from/to/brands/suppliers/statuses)
// into the query string the analytics HTTP endpoints expect. Accepts a
// URLSearchParams, a plain object, or a query string.
function analyticsQuery(filterParams, extra = {}) {
  const p = filterParams instanceof URLSearchParams
    ? filterParams
    : new URLSearchParams(filterParams || '');
  const q = new URLSearchParams();
  const from = p.get('from');
  const to = p.get('to');
  if (from) q.set('date_from', from);
  if (to) q.set('date_to', to);
  if (p.get('brands'))     q.set('brand_filter', p.get('brands'));
  if (p.get('suppliers'))  q.set('supplier_filter', p.get('suppliers'));
  if (p.get('statuses'))   q.set('status_filter', p.get('statuses'));
  if (p.get('categories')) q.set('category_filter', p.get('categories'));
  if (p.get('granularity')) q.set('granularity', p.get('granularity'));
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') q.set(k, String(v));
  }
  return q.toString();
}

// Normalize a kpi-summary payload (from HTTP or the direct RPC) to the
// { current, previous } shape the dashboard's resolveKpiCurrent consumes.
//   - Live shape ({ current, previous }) passes straight through (and keeps
//     any `fallback` flag the HTTP wrapper set).
//   - Spec-doc metric-keyed shape ({ revenue: {current, previous}, … } plus
//     flat scalars like new_customers) is folded into current/previous.
//   - Anything unrecognised → null, so callers can try the next source.
function normalizeKpiSummary(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.current && typeof data.current === 'object') return data;

  const METRIC_KEYS = [
    'revenue', 'gross_profit', 'net_profit', 'gross_margin',
    'net_margin', 'stripe_fees', 'orders', 'aov',
  ];
  const current = {};
  const previous = {};
  let sawMetric = false;
  for (const k of METRIC_KEYS) {
    const m = data[k];
    if (m && typeof m === 'object' && ('current' in m || 'previous' in m)) {
      sawMetric = true;
      if (m.current != null)  current[k]  = m.current;
      if (m.previous != null) previous[k] = m.previous;
    }
  }
  if (!sawMetric) return null;
  // Flat scalars ride along on `current` so the side panel / KPI tiles can read
  // them the same way they read RPC fields.
  const FLAT_KEYS = [
    'new_customers', 'returning_rate', 'returning_pct', 'runway_months',
    'total_customers', 'avg_ltv', 'churn_rate', 'nps_score', 'cash_balance',
  ];
  for (const k of FLAT_KEYS) {
    if (data[k] != null) current[k] = data[k];
  }
  const out = { current, previous };
  if (data.fallback) out.fallback = true;
  return out;
}

// Adapt the always-on /summary/customers payload into the { current, previous }
// shape the dashboard's customer KPIs consume. This is the fallback source for
// "New Customers" when the analytics_customer_stats RPC's grant is dropped —
// it has no returning-% figure, so that tile honestly stays "—". The
// new_customers_30d value is a rolling-30d count regardless of the active
// filter window; we surface it rather than show nothing.
function adaptCustomerSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const hasAny = summary.new_customers_30d != null
    || summary.total_customers != null
    || summary.avg_ltv != null;
  if (!hasAny) return null;
  return {
    current: {
      new_customers:   summary.new_customers_30d ?? null,
      total_customers: summary.total_customers ?? null,
      avg_ltv:         summary.avg_ltv ?? null,
      churn_rate:      summary.churn_rate ?? null,
      nps_score:       summary.nps_score ?? null,
      // returning_pct intentionally absent — no source in /summary/customers.
    },
    previous: {},
    _summaryFallback: true,
  };
}

// GET an analytics HTTP endpoint, unwrap the { ok, data } envelope, and return
// `data` (or null on any failure / non-200 / abort). Mirrors the swallow-and-
// return-null convention of the other read methods so one dead tile never
// blanks the whole dashboard.
// The backend rejects a too-fine granularity for a wide range with a 400 whose
// message is "Too many buckets (N) for granularity 'X'…". (Its week-bucket cap is
// currently miscounted — week@1y and week@all both report the same 751 as day@all —
// so `week`/`day` get rejected well before the real 750-bucket limit. Backend bug,
// tracked in errors.md.) We detect that specific error so the dashboard can step to
// a coarser grain instead of blanking every chart.
function isTooManyBucketsError(msg) {
  return typeof msg === 'string' && /too many buckets/i.test(msg);
}

async function analyticsHttpGet(path, signal) {
  try {
    if (signal?.aborted) return null;
    const resp = await window.API.get(path, { signal });
    if (resp && resp.ok === false) return null;
    return resp?.data ?? null;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    DebugLog.warn(`[AdminAPI] analytics GET ${path} failed:`, e.message);
    return null;
  }
}

const AdminAPI = {
  // ---- Orders ----
  async getOrders(filters = {}, page = 1, limit = 20, signal = null) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.from) params.set('date_from', filters.from);
      if (filters.to) params.set('date_to', filters.to);
      if (filters.statuses?.length) params.set('status', filters.statuses.join(','));
      if (filters.user_id) params.set('user_id', filters.user_id);
      if (filters.search) {
        // Send as customer_email if it looks like an email, otherwise as generic search
        if (filters.search.includes('@')) {
          params.set('customer_email', filters.search);
        } else {
          params.set('search', filters.search);
        }
      }
      // Map sort+order to backend's single sort param (newest|oldest|total-high|total-low)
      if (filters.sort) {
        const sortMap = {
          'created_at': filters.order === 'asc' ? 'oldest' : 'newest',
          'order_number': filters.order === 'asc' ? 'oldest' : 'newest',
          'total': filters.order === 'asc' ? 'total-low' : 'total-high',
          'status': 'newest', // status sort not supported, fallback to newest
        };
        params.set('sort', sortMap[filters.sort] || 'newest');
      }
      const resp = await window.API.get(`/api/admin/orders?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load orders', e);
      return null;
    }
  },

  // Earliest date the store has data for, as YYYY-MM-DD — the oldest order's created_at.
  // Used to anchor the dashboard's 'all' period at real data instead of a far-past floor.
  // Returns null on any failure so callers keep their fallback. The backend has no
  // dedicated min-date field (pagination.range only echoes the requested window), so we
  // read the single oldest order via the existing sort=oldest path.
  async getEarliestOrderDate() {
    try {
      const data = await this.getOrders({ sort: 'created_at', order: 'asc' }, 1, 1);
      const arr = Array.isArray(data) ? data : (data?.orders || data?.items || data?.data || []);
      const created = arr?.[0]?.created_at;
      return typeof created === 'string' && created.length >= 10 ? created.slice(0, 10) : null;
    } catch (e) {
      adminApiWarn('Failed to load earliest order date', e);
      return null;
    }
  },

  async getOrder(orderId) {
    try {
      const resp = await window.API.get(`/api/admin/orders/${orderId}`);
      // Backend wraps single order in data.order
      return resp?.data?.order ?? resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load order', e);
      return null;
    }
  },

  async updateOrderStatus(orderId, status, body = {}) {
    try {
      const payload = { ...body, status };
      const resp = await window.API.put(`/api/admin/orders/${orderId}`, payload);
      if (resp && resp.ok === false) {
        throw new Error(resp.error || 'Update failed');
      }
      return resp?.data ?? null;
    } catch (e) {
      // If backend rejects the transition, force it via direct Supabase RPC
      if (e.message && /terminal.state|cannot transition|invalid.*transition/i.test(e.message)) {
        DebugLog.warn('[AdminAPI] Backend blocked transition, using admin force RPC');
        const result = await rpc('admin_force_order_status', {
          p_order_id: orderId,
          p_status: status,
          p_carrier: body.carrier || null,
          p_tracking_number: body.tracking_number || null,
        });
        if (!result) throw new Error('Force status update failed');
        return result;
      }
      DebugLog.warn('[AdminAPI] updateOrderStatus failed:', e.message);
      throw e;
    }
  },

  async updateTracking(orderId, carrier, trackingNumber, shippedAt) {
    try {
      const resp = await window.API.put(`/api/admin/orders/${orderId}`, {
        carrier, tracking_number: trackingNumber, shipped_at: shippedAt
      });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateTracking failed:', e.message);
      throw e;
    }
  },

  async addOrderNote(orderId, note, type = 'note') {
    try {
      const resp = await window.API.post(`/api/admin/orders/${orderId}/events`, {
        type, payload: { note }
      });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] addOrderNote failed:', e.message);
      throw e;
    }
  },

  async getOrderEvents(orderId) {
    try {
      const resp = await window.API.get(`/api/admin/orders/${orderId}/events`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load order history', e);
      return null;
    }
  },

  async createOrder(payload) {
    try {
      const resp = await window.API.post('/api/admin/orders', payload);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createOrder failed:', e.message);
      throw e;
    }
  },

  async deleteOrder(orderId) {
    try {
      const resp = await window.API.delete(`/api/admin/orders/${orderId}`);
      if (resp && resp.ok === false) throw new Error(resp.error || 'Delete failed');
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteOrder failed:', e.message);
      throw e;
    }
  },

  // ---- Refunds ----
  async getRefunds(filters = {}, page = 1, limit = 20) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.from) params.set('dateFrom', filters.from);
      if (filters.to) params.set('dateTo', filters.to);
      if (filters.type) params.set('type', filters.type);
      if (filters.status) params.set('status', filters.status);
      if (filters.search) params.set('search', filters.search);
      const resp = await window.API.get(`/api/admin/refunds?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load refunds', e);
      return null;
    }
  },

  async createRefund(orderId, { type, amount, reasonCode, reasonNote }) {
    try {
      const resp = await window.API.post('/api/admin/refunds', {
        order_id: orderId,
        type: type || 'refund',
        amount,
        reason_code: reasonCode,
        reason_note: reasonNote || null,
      });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createRefund failed:', e.message);
      throw e;
    }
  },

  async updateRefundStatus(refundId, status) {
    try {
      const resp = await window.API.put(`/api/admin/refunds/${refundId}`, { status });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateRefundStatus failed:', e.message);
      throw e;
    }
  },

  async deleteRefund(refundId) {
    try {
      const resp = await window.API.delete(`/api/admin/refunds/${refundId}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteRefund failed:', e.message);
      throw e;
    }
  },

  // ---- Dashboard Analytics ----
  // Each method hits the resilient backend HTTP wrapper first (service-role
  // grants survive redeploys + server-side fallback) and only drops to the
  // direct Supabase RPC if the HTTP layer is unreachable. See the block comment
  // above `analyticsQuery` for the ERR-010 rationale.

  async getDashboardKPIs(filterParams, signal) {
    const qs = analyticsQuery(filterParams);
    const http = normalizeKpiSummary(
      await analyticsHttpGet(`/api/admin/analytics/kpi-summary?${qs}`, signal)
    );
    if (http?.current?.revenue != null) return http;
    // HTTP missing/empty → direct RPC (covers backend-down, grant-healthy).
    const { from, to } = Object.fromEntries(filterParams);
    const rpcData = normalizeKpiSummary(await rpc('analytics_kpi_summary', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
      supplier_filter: filterParams.get('suppliers') || null,
      status_filter: filterParams.get('statuses') || null,
    }, signal));
    return rpcData ?? http;
  },

  async getRevenueSeries(filterParams, signal) {
    const qs = analyticsQuery(filterParams);
    const http = await analyticsHttpGet(`/api/admin/analytics/revenue-series?${qs}`, signal);
    if (Array.isArray(http?.series) || Array.isArray(http)) return http;
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_revenue_series', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
      supplier_filter: filterParams.get('suppliers') || null,
    }, signal);
  },

  async getBrandBreakdown(filterParams, metric = 'revenue', signal) {
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_brand_breakdown', {
      date_from: from, date_to: to, metric,
      supplier_filter: filterParams.get('suppliers') || null,
      status_filter: filterParams.get('statuses') || null,
    }, signal);
  },

  async getRefundAnalytics(filterParams, signal) {
    const qs = analyticsQuery(filterParams);
    const http = await analyticsHttpGet(`/api/admin/analytics/refunds-series?${qs}`, signal);
    if (Array.isArray(http?.series) || Array.isArray(http)) return http;
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_refunds_series', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
    }, signal);
  },

  async getCustomerStats(filterParams, signal) {
    // Prefer the HTTP wrapper (migration 092, Jun 2026). The direct
    // analytics_customer_stats RPC is deliberately locked to the service role,
    // so a browser .rpc() call 403s BY DESIGN — calling it first just burns a
    // request and a console error. The wrapper returns the same rich shape
    // ({ current, previous } with returning_pct) the KPI strip consumes.
    const http = await analyticsHttpGet(`/api/admin/analytics/customer-stats?${analyticsQuery(filterParams)}`, signal);
    if (http?.current && (http.current.new_customers != null || http.current.returning_pct != null)) {
      return http;
    }
    // Fallbacks for an old cached payload / wrapper outage: the direct RPC (if
    // its grant is somehow intact), then /summary/customers (New Customers only,
    // no returning_pct — that tile honestly stays "—").
    const { from, to } = Object.fromEntries(filterParams);
    const rpcData = await rpc('analytics_customer_stats', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
    }, signal);
    if (rpcData?.current?.new_customers != null || rpcData?.current?.returning_pct != null) {
      return rpcData;
    }
    const summary = await analyticsHttpGet('/api/admin/analytics/summary/customers', signal);
    return adaptCustomerSummary(summary) ?? http ?? rpcData;
  },

  async getTopProducts(filterParams, signal) {
    const qs = analyticsQuery(filterParams, { result_limit: 10 });
    const http = await analyticsHttpGet(`/api/admin/analytics/top-products-rpc?${qs}`, signal);
    if (Array.isArray(http)) return http;
    if (Array.isArray(http?.products)) return http.products;  // tolerate { products: [...] }
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_top_products', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
      result_limit: 10,
    }, signal);
  },

  // ---- Dashboard graph series (paired-row redesign, Jun 2026) ----
  // Every chart below pulls a backend-computed, backend-bucketed payload — the
  // frontend never aggregates or computes margins/profit itself. `granularity`
  // (the bar width: hour|day|week|month|quarter) is resolved by the dashboard
  // and forwarded so the backend returns one row per bucket. Each method
  // returns the raw `data` (or null when the endpoint is missing) so a not-yet-
  // implemented endpoint renders an "awaiting data" empty state, never a crash.

  // Preferred path: one request for every chart (backend buckets + computes all).
  // Avoids the per-chart parallel fan-out that tripped the rate limiter. Returns
  // the `data` map ({ revenue_series, top_skus_revenue, ... }) or null on failure.
  async getDashboardBundle(filterParams, granularity, signal) {
    // Auto-escalate on the backend's bucket-cap rejection: try the requested grain,
    // then step coarser (…→week→month→quarter) until one is accepted. Stamp the grain
    // that actually served on the payload (`_granularity`) so the x-axis labels match
    // the bars. A non-cap failure (or running out of grains) returns null → the chart's
    // normal "awaiting data" empty state. See isTooManyBucketsError above.
    const order = ['day', 'week', 'month', 'quarter'];
    const start = order.indexOf(granularity);
    const ladder = start === -1 ? [granularity || 'day'] : order.slice(start);
    for (const g of ladder) {
      if (signal?.aborted) return null;
      try {
        const resp = await window.API.get(
          `/api/admin/analytics/dashboard-bundle?${analyticsQuery(filterParams, { granularity: g })}`,
          { signal }
        );
        if (resp && resp.ok === false) {
          if (isTooManyBucketsError(resp.error || resp.message)) continue;
          return null;
        }
        const data = resp?.data ?? null;
        if (data && typeof data === 'object') data._granularity = g;
        return data;
      } catch (e) {
        if (e?.name === 'AbortError') return null;
        if (isTooManyBucketsError(e?.message)) continue;
        DebugLog.warn(`[AdminAPI] dashboard-bundle (${g}) failed:`, e.message);
        return null;
      }
    }
    return null;
  },

  async getSeriesRevenue(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/revenue?${analyticsQuery(filterParams, { granularity })}`, signal);
  },
  async getSeriesGrossProfit(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/gross-profit?${analyticsQuery(filterParams, { granularity })}`, signal);
  },
  async getSeriesOrders(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/orders?${analyticsQuery(filterParams, { granularity })}`, signal);
  },
  async getSeriesAOV(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/aov?${analyticsQuery(filterParams, { granularity })}`, signal);
  },
  async getSeriesRefundRate(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/refund-rate?${analyticsQuery(filterParams, { granularity })}`, signal);
  },
  async getRevenueByCustomerType(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/revenue-by-customer-type?${analyticsQuery(filterParams, { granularity })}`, signal);
  },
  async getRevenueForecast(filterParams, granularity, signal) {
    return analyticsHttpGet(`/api/admin/analytics/forecast/revenue?${analyticsQuery(filterParams, { granularity })}`, signal);
  },

  async getTopSkusByRevenue(filterParams, limit = 10, signal) {
    return analyticsHttpGet(`/api/admin/analytics/top-skus/revenue?${analyticsQuery(filterParams, { result_limit: limit })}`, signal);
  },
  async getTopSkusByProfit(filterParams, limit = 10, signal) {
    return analyticsHttpGet(`/api/admin/analytics/top-skus/gross-profit?${analyticsQuery(filterParams, { result_limit: limit })}`, signal);
  },
  async getMarginByBrand(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/margin/by-brand?${analyticsQuery(filterParams)}`, signal);
  },
  async getMarginByCategory(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/margin/by-category?${analyticsQuery(filterParams)}`, signal);
  },

  async getTrafficBySource(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/series/traffic-by-source?${analyticsQuery(filterParams)}`, signal);
  },
  async getConversionBySource(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/conversion-by-source?${analyticsQuery(filterParams)}`, signal);
  },

  async getSupplierRevenue(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/suppliers/revenue?${analyticsQuery(filterParams)}`, signal);
  },
  async getSupplierProblemRate(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/suppliers/problem-rate?${analyticsQuery(filterParams)}`, signal);
  },

  async getReorderInterval(filterParams, signal) {
    return analyticsHttpGet(`/api/admin/analytics/customers/reorder-interval?${analyticsQuery(filterParams)}`, signal);
  },

  async getTopConvertingSearches(filterParams, limit = 10, signal) {
    return analyticsHttpGet(`/api/admin/analytics/search/top-converting?${analyticsQuery(filterParams, { result_limit: limit })}`, signal);
  },
  async getZeroResultSearches(filterParams, limit = 10, signal) {
    return analyticsHttpGet(`/api/admin/analytics/search/zero-result?${analyticsQuery(filterParams, { result_limit: limit })}`, signal);
  },

  async getNewOrders24h(signal) {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const data = await this.getOrders({
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0],
    }, 1, 1, signal);
    return data?.pagination?.total ?? data?.total ?? null;
  },

  // ---- Customers ----
  async getCustomers(filters = {}, page = 1, limit = 20) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.search) params.set('search', filters.search);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      const resp = await window.API.get(`/api/admin/customers?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load customers', e);
      return null;
    }
  },

  // ---- Customer loyalty points (admin) ----
  // Contract documented in admin-loyalty-endpoints-jun2026.md (repo root). Read is fail-soft
  // (returns null so the drawer degrades gracefully); adjust throws so the modal
  // can surface the backend message. Both 404 until the backend ships them.
  async getCustomerLoyalty(customerId) {
    try {
      const resp = await window.API.get(`/api/admin/customers/${customerId}/loyalty`);
      return resp?.data?.loyalty ?? resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load customer loyalty', e);
      return null;
    }
  },

  async adjustCustomerPoints(customerId, { points, reason, type = 'adjust' }) {
    const resp = await window.API.post(`/api/admin/customers/${customerId}/loyalty/adjust`, { points, reason, type });
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Adjustment failed');
    return resp?.data?.loyalty ?? resp?.data ?? null;
  },

  // Save a customer's reusable invoicing profile (bill-to / deliver-to defaults
  // used to pre-fill invoices). Fail-soft like loyalty: the backend route
  // PUT /api/admin/customers/:id/invoicing is pending and 404s until it ships,
  // so the drawer surfaces a clean toast and nothing breaks. The saved profile
  // is echoed back on the customer row as `invoicing` (tolerant if absent).
  async updateCustomerInvoicing(customerId, payload) {
    const resp = await window.API.put(`/api/admin/customers/${customerId}/invoicing`, payload);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Save invoicing details failed');
    return resp?.data?.customer ?? resp?.data ?? null;
  },

  // ---- Contacts (manually-entered billing/delivery parties for invoicing) ----
  // Standalone address book that lives alongside Customers. Reads fail soft
  // (return null/empty so the page degrades); writes throw so the editor can
  // surface the backend message. All routes 404 until the backend ships them.
  async listContacts(filters = {}, page = 1, limit = 20) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.search) params.set('search', filters.search);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      const resp = await window.API.get(`/api/admin/contacts?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load contacts', e);
      return null;
    }
  },

  async getContact(contactId) {
    try {
      const resp = await window.API.get(`/api/admin/contacts/${encodeURIComponent(contactId)}`);
      return resp?.data?.contact ?? resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load contact', e);
      return null;
    }
  },

  async createContact(payload) {
    const resp = await window.API.post('/api/admin/contacts', payload);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Create contact failed');
    return resp?.data?.contact ?? resp?.data ?? null;
  },

  async updateContact(contactId, payload) {
    const resp = await window.API.put(`/api/admin/contacts/${encodeURIComponent(contactId)}`, payload);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Update contact failed');
    return resp?.data?.contact ?? resp?.data ?? null;
  },

  async deleteContact(contactId) {
    const resp = await window.API.delete(`/api/admin/contacts/${encodeURIComponent(contactId)}`);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Delete contact failed');
    return resp?.data ?? null;
  },

  // ---- Customer Intelligence (stubs — backend endpoints not yet implemented) ----
  async getCustomerLTV() { return null; },
  async getCohorts() { return null; },
  async getChurn() { return null; },
  async getNPS() { return null; },
  async getRepeatPurchase() { return null; },

  // ---- Products ----
  async getProducts(filters = {}, page = 1, limit = 200) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.brand) params.set('brand', filters.brand);
      if (filters.search) params.set('search', filters.search);
      if (filters.active !== undefined && filters.active !== '') params.set('is_active', filters.active);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      if (filters.source) params.set('source', filters.source);
      if (filters.product_type) params.set('product_type', filters.product_type);
      if (filters.category) params.set('category', filters.category);
      if (filters.has_images !== undefined && filters.has_images !== '') params.set('has_images', filters.has_images);
      if (filters.stock_status) params.set('stock_status', filters.stock_status);
      if (filters.is_reviewed !== undefined && filters.is_reviewed !== '') params.set('is_reviewed', filters.is_reviewed);
      const resp = await window.API.get(`/api/admin/products?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load products', e);
      return null;
    }
  },

  // ---- Product Review ----
  async getUnreviewedProducts(filters = {}, page = 1, limit = 20) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      params.set('is_reviewed', 'false');
      if (filters.brand) params.set('brand', filters.brand);
      if (filters.search) params.set('search', filters.search);
      const resp = await window.API.get(`/api/admin/products?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load products', e);
      return null;
    }
  },

  async reviewProduct(productId, isReviewed = true) {
    return this.updateProduct(productId, { is_reviewed: isReviewed });
  },

  // ---- Product CRUD ----
  async getProduct(productId) {
    try {
      const resp = await window.API.get(`/api/admin/products/${productId}`);
      return resp?.data?.product ?? resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load product', e);
      return null;
    }
  },

  async generateProductSEO(sku) {
    try {
      const resp = await window.API.post(`/api/admin/products/${encodeURIComponent(sku)}/generate-seo`, {});
      if (resp && resp.ok === false) throw new Error(resp.error || 'Generate SEO failed');
      return resp?.data ?? resp;
    } catch (e) {
      DebugLog.warn('[AdminAPI] generateProductSEO failed:', e.message);
      throw e;
    }
  },

  // ---- Per-product margin (inline edit on the Products table) ----
  // The operator types a target net margin %; the backend derives the relative
  // gross-markup offset that achieves it, stores it (so it persists across
  // general-margin changes), re-prices the row (clearing any retail freeze) and
  // returns the new retail_price / net_margin_incl_fixed_pct / offset.
  async setProductTargetMargin(productId, targetMarginPct, notes) {
    const body = { target_margin_pct: targetMarginPct };
    if (notes) body.notes = notes;
    const resp = await window.API.put(`/api/admin/products/${encodeURIComponent(productId)}/margin-offset`, body);
    return resp?.data ?? null;
  },

  async updateProduct(productId, data) {
    try {
      const resp = await window.API.put(`/api/admin/products/${productId}`, data);
      if (resp && resp.ok === false) {
        let msg = resp.error || 'Update failed';
        if (resp.details) {
          if (Array.isArray(resp.details)) {
            msg += ': ' + resp.details.map(d => d.message || d).join(', ');
          } else if (typeof resp.details === 'string') {
            msg += ': ' + resp.details;
          }
        }
        // Append the 8-char Render request_id so admins can grep stderr when
        // the backend returns a generic 500. Cross-origin exposure of
        // x-request-id shipped 2026-05-11 (CORS allowlist now includes it).
        if (resp.request_id) msg += ` (ref ${String(resp.request_id).slice(0, 8)})`;
        const err = new Error(msg);
        err.code = resp.code;
        err.status = resp.status;
        err.request_id = resp.request_id;
        throw err;
      }
      // Repair the rich-text columns the backend sanitiser strips. The product
      // itself saved fine above, so this is intentionally non-fatal.
      await this.persistRichTextColumns(productId, data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateProduct failed:', e.message);
      throw e;
    }
  },

  async updateProductOverrides(productId, overrides) {
    try {
      const resp = await window.API.put(`/api/admin/products/${productId}/overrides`, { overrides });
      if (resp && resp.ok === false) throw new Error(resp.error || 'Update overrides failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateProductOverrides failed:', e.message);
      throw e;
    }
  },

  async toggleImportLock(productId) {
    try {
      const resp = await window.API.put(`/api/admin/products/${productId}/import-lock`);
      if (resp && resp.ok === false) throw new Error(resp.error || 'Toggle import lock failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] toggleImportLock failed:', e.message);
      throw e;
    }
  },

  async toggleProductReviewed(productId) {
    try {
      const resp = await window.API.put(`/api/admin/products/${productId}/reviewed`);
      if (resp && resp.ok === false) throw new Error(resp.error || 'Toggle reviewed failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] toggleProductReviewed failed:', e.message);
      throw e;
    }
  },

  async createProduct(data) {
    try {
      const resp = await window.API.post('/api/admin/products', data);
      if (resp && resp.ok === false) {
        let msg = resp.error || 'Create failed';
        if (resp.details) {
          msg += ': ' + (Array.isArray(resp.details)
            ? resp.details.map(d => d.message || d).join(', ')
            : resp.details);
        }
        throw new Error(msg);
      }
      const result = resp?.data ?? resp;
      // Repair the rich-text columns the backend sanitiser strips on create.
      const newId = result?.product?.id ?? result?.id;
      if (newId) await this.persistRichTextColumns(newId, data);
      return result;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createProduct failed:', e.message);
      throw e;
    }
  },

  async uploadProductImage(productId, file) {
    try {
      return await window.API.uploadProductImage(productId, file);
    } catch (e) {
      DebugLog.warn('[AdminAPI] uploadProductImage failed:', e.message);
      throw e;
    }
  },

  async deleteProduct(productId) {
    try {
      return await window.API.deleteProduct(productId);
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteProduct failed:', e.message);
      throw e;
    }
  },

  async deleteProductImage(productId, imageId) {
    try {
      return await window.API.deleteProductImage(productId, imageId);
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteProductImage failed:', e.message);
      throw e;
    }
  },

  async deleteProductImageUrl(productId) {
    try {
      return await window.API.deleteProductImageUrl(productId);
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteProductImageUrl failed:', e.message);
      throw e;
    }
  },

  async reorderProductImages(productId, images) {
    try {
      return await window.API.reorderProductImages(productId, images);
    } catch (e) {
      DebugLog.warn('[AdminAPI] reorderProductImages failed:', e.message);
      throw e;
    }
  },

  async getProductDiagnostics() {
    try {
      return await window.API.getAdminProductDiagnostics();
    } catch (e) {
      adminApiWarn('Failed to load product diagnostics', e);
      return null;
    }
  },

  async bulkGenerateAllSeo() {
    return await window.API.post('/api/admin/products/bulk-generate-seo', {});
  },

  async bulkActivate(data) {
    try {
      return await window.API.bulkActivateProducts(data);
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkActivate failed:', e.message);
      throw e;
    }
  },

  async bulkDeactivate(data) {
    try {
      return await window.API.bulkDeactivateProducts(data);
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkDeactivate failed:', e.message);
      throw e;
    }
  },

  async updateBySku(sku, data) {
    try {
      return await window.API.updateProductBySku(sku, data);
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateBySku failed:', e.message);
      throw e;
    }
  },

  // ---- Genuine Image Audit ----
  // Lower-level fetch that preserves response body regardless of HTTP status.
  // /refetch and /bulk-refetch return their result envelope on 422 (e.g. when
  // candidates are rejected) — the generic API helper would throw and lose it.
  async _imageAuditFetch(path, { method = 'GET', body } = {}) {
    const baseUrl = Config.API_URL;
    const token = window.Auth?.session?.access_token;
    if (!token) throw new Error('Unauthorized');
    const headers = { 'Authorization': `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await resp.json(); } catch (_) { /* non-JSON */ }
    if (resp.status === 429) {
      const code = json?.error?.code || 'RATE_LIMITED';
      const msg = json?.error?.message || 'Rate limited. Please slow down.';
      const err = new Error(msg);
      err.code = code;
      err.status = 429;
      throw err;
    }
    // 2xx + 422 (semantic failure with body): return the body directly so callers
    // can inspect data.ok / data.reason. Other errors throw.
    if (resp.ok || resp.status === 422) {
      return json;
    }
    const msg = json?.error?.message || json?.error || `HTTP ${resp.status}`;
    throw new Error(msg);
  },

  async getImageAuditStats({ source, pack, exclude_ribbons, brand } = {}) {
    try {
      const params = new URLSearchParams();
      if (source) params.set('source', source);
      if (pack) params.set('pack', pack);
      if (exclude_ribbons) params.set('exclude_ribbons', 'true');
      if (brand) params.set('brand', brand);
      const qs = params.toString();
      const resp = await window.API.get(`/api/admin/image-audit/stats${qs ? `?${qs}` : ''}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load image audit stats', e);
      return null;
    }
  },

  async getImageAuditList(filters = {}, page = 1, limit = 50) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.source) params.set('source', filters.source);
      if (filters.pack) params.set('pack', filters.pack);
      if (filters.verdict) params.set('verdict', filters.verdict);
      if (filters.exclude_ribbons) params.set('exclude_ribbons', 'true');
      if (filters.missing_only) params.set('missing_only', 'true');
      if (filters.external_only) params.set('external_only', 'true');
      if (filters.brand) params.set('brand', filters.brand);
      if (filters.search) params.set('search', filters.search);
      if (filters.status) params.set('status', filters.status);
      if (filters.sort) params.set('sort', filters.sort);
      const resp = await window.API.get(`/api/admin/image-audit/list?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load image audit list', e);
      return null;
    }
  },

  async verifyImageWithVision(productId, useVision = true) {
    const json = await this._imageAuditFetch(
      `/api/admin/image-audit/${encodeURIComponent(productId)}/verify-with-vision`,
      { method: 'POST', body: { use_vision: useVision } }
    );
    if (json && json.ok === false) {
      throw new Error(json.error?.message || 'Verification failed');
    }
    return json?.data ?? null;
  },

  async refetchImage(productId, { useVision = true, directApply = false } = {}) {
    const json = await this._imageAuditFetch(
      `/api/admin/image-audit/${encodeURIComponent(productId)}/refetch`,
      { method: 'POST', body: { use_vision: useVision, direct_apply: directApply } }
    );
    // Spec: HTTP 422 returns { ok: true, data: { ok: false, reason, ... } }
    // Spec: HTTP 200 returns { ok: true, data: { ok: true, chosen_url, ... } }
    if (json && json.ok === false) {
      throw new Error(json.error?.message || 'Refetch failed');
    }
    return json?.data ?? null;
  },

  async bulkRefetchImages(productIds, { useVision = true, directApply = false } = {}) {
    const json = await this._imageAuditFetch(
      '/api/admin/image-audit/bulk-refetch',
      { method: 'POST', body: { product_ids: productIds, use_vision: useVision, direct_apply: directApply } }
    );
    if (json && json.ok === false) {
      throw new Error(json.error?.message || 'Bulk refetch failed');
    }
    return json?.data ?? null;
  },

  async bulkQuarantineImages(productIds) {
    try {
      const resp = await window.API.post('/api/admin/image-audit/bulk-quarantine', { product_ids: productIds });
      if (resp && resp.ok === false) throw new Error(resp.error || 'Bulk quarantine failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkQuarantineImages failed:', e.message);
      throw e;
    }
  },

  async setImageAuditStatus(productId, status) {
    // Backend `PUT /api/admin/image-audit/:id/status` accepts only
    // `pending | checked_clean` — the third state `replaced` is set by
    // the dedicated `/replace` endpoint (per backend dev note 2026-05-11).
    // Fail fast on the wrong shape so callers can't silently no-op.
    if (status !== 'pending' && status !== 'checked_clean') {
      throw new Error(`setImageAuditStatus: status must be 'pending' or 'checked_clean' (got "${status}"). For 'replaced' use the /replace endpoint.`);
    }
    try {
      const resp = await window.API.put(
        `/api/admin/image-audit/${encodeURIComponent(productId)}/status`,
        { status }
      );
      if (resp && resp.ok === false) throw new Error(resp.error || 'Update status failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] setImageAuditStatus failed:', e.message);
      throw e;
    }
  },

  imageAuditSearchUrl(productId) {
    return `${Config.API_URL}/api/admin/image-audit/${encodeURIComponent(productId)}/search-url`;
  },

  // ---- Pending Changes (import review queue) ----
  async getPendingChangesSummary() {
    try {
      const resp = await window.API.get('/api/admin/pending-changes/summary');
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load pending changes summary', e);
      return null;
    }
  },

  async getPendingChanges(filters = {}, page = 1, limit = 50) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.status) params.set('status', filters.status);
      if (filters.change_type) params.set('change_type', filters.change_type);
      if (filters.field) params.set('field', filters.field);
      if (filters.search) params.set('search', filters.search);
      const resp = await window.API.get(`/api/admin/pending-changes?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load pending changes', e);
      return null;
    }
  },

  async reviewPendingChange(id, decisions, note = '') {
    try {
      const body = { decisions };
      if (note) body.note = note;
      const resp = await window.API.post(`/api/admin/pending-changes/${id}/review`, body);
      if (resp && resp.ok === false) throw new Error(resp.error || 'Review failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] reviewPendingChange failed:', e.message);
      throw e;
    }
  },

  async bulkReviewPendingChanges(ids, action, note = '') {
    try {
      const body = { ids, action };
      if (note) body.note = note;
      const resp = await window.API.post('/api/admin/pending-changes/bulk-review', body);
      if (resp && resp.ok === false) throw new Error(resp.error || 'Bulk review failed');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkReviewPendingChanges failed:', e.message);
      throw e;
    }
  },

  // ---- Suppliers ----
  async getSuppliers() {
    return rpc('get_suppliers');
  },

  // ---- Brands (for filter options) ----
  async getBrands() {
    try {
      const resp = await window.API.get('/api/brands');
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load brands', e);
      return null;
    }
  },

  // ---- Ribbons (admin CRUD) ----
  async getAdminRibbons(filters = {}, page = 1, limit = 200) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.search) params.set('search', filters.search);
      if (filters.brand) params.set('brand', filters.brand);
      if (filters.type) params.set('type', filters.type);
      if (filters.is_active !== undefined) params.set('is_active', filters.is_active);
      if (filters.sort) params.set('sort', filters.sort);
      const resp = await window.API.get(`/api/admin/ribbons?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load ribbons', e);
      return null;
    }
  },

  async getAdminRibbon(ribbonId) {
    try {
      const resp = await window.API.get(`/api/admin/ribbons/${ribbonId}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load ribbon', e);
      return null;
    }
  },

  async createAdminRibbon(data) {
    try {
      const resp = await window.API.post('/api/admin/ribbons', data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createAdminRibbon failed:', e.message);
      throw e;
    }
  },

  async updateAdminRibbon(ribbonId, data) {
    try {
      const resp = await window.API.put(`/api/admin/ribbons/${ribbonId}`, data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateAdminRibbon failed:', e.message);
      throw e;
    }
  },

  async deleteAdminRibbon(ribbonId) {
    try {
      const resp = await window.API.delete(`/api/admin/ribbons/${ribbonId}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteAdminRibbon failed:', e.message);
      throw e;
    }
  },

  // ---- Ribbon Products (Supabase direct — includes new columns) ----
  async getRibbonProducts(filters = {}) {
    try {
      const sb = this._sb();
      if (!sb) return null;
      const selectCols = '*, ribbon_brands!products_ribbon_brand_id_fkey(id, name, slug, image_url)';
      let query = sb.from('products').select(selectCols, { count: 'exact' })
        .in('product_type', ['printer_ribbon', 'typewriter_ribbon', 'correction_tape']);
      if (filters.ribbon_brand_id) {
        const { data: junctionRows } = await sb.from('product_ribbon_brands')
          .select('product_id').eq('ribbon_brand_id', filters.ribbon_brand_id);
        const ids = (junctionRows || []).map(r => r.product_id);
        if (ids.length === 0) return { products: [], total: 0, page: filters.page || 1, limit: filters.limit || 200 };
        query = query.in('id', ids);
      }
      if (filters.product_type) query = query.eq('product_type', filters.product_type);
      if (filters.is_active !== undefined && filters.is_active !== '') query = query.eq('is_active', filters.is_active === 'true' || filters.is_active === true);
      if (filters.search) query = query.or(`name.ilike.%${filters.search}%,sku.ilike.%${filters.search}%`);
      query = query.order(filters.sort || 'name', { ascending: filters.sortDir !== 'desc' });
      const limit = filters.limit || 200;
      const page = filters.page || 1;
      query = query.range((page - 1) * limit, page * limit - 1);
      const { data, error, count } = await query;
      if (error) throw error;
      const products = data || [];
      // Attach junction brand data in a second query
      if (products.length > 0) {
        const pIds = products.map(p => p.id);
        const { data: jRows } = await sb.from('product_ribbon_brands')
          .select('product_id, ribbon_brand_id, ribbon_brands!product_ribbon_brands_ribbon_brand_id_fkey(id, name, slug)')
          .in('product_id', pIds);
        const map = {};
        for (const r of (jRows || [])) { (map[r.product_id] = map[r.product_id] || []).push(r); }
        for (const p of products) { p.product_ribbon_brands = map[p.id] || []; }
      }
      return { products, total: count || 0, page, limit };
    } catch (e) {
      adminApiWarn('Failed to load ribbon products', e);
      return null;
    }
  },

  async getRibbonProduct(productId) {
    try {
      const sb = this._sb();
      if (!sb) return null;
      const { data, error } = await sb.from('products').select('*, ribbon_brands!products_ribbon_brand_id_fkey(id, name, slug)')
        .eq('id', productId).single();
      if (error) throw error;
      if (data) {
        const { data: jRows } = await sb.from('product_ribbon_brands')
          .select('ribbon_brand_id, ribbon_brands!product_ribbon_brands_ribbon_brand_id_fkey(id, name, slug)')
          .eq('product_id', productId);
        data.product_ribbon_brands = jRows || [];
      }
      return data;
    } catch (e) {
      adminApiWarn('Failed to load ribbon product', e);
      return null;
    }
  },

  async createRibbonProduct(data) {
    try {
      // Route through backend so compatible_devices auto-parsing from description fires.
      const payload = { ...data };
      if (payload.description_html != null && payload.description == null) payload.description = payload.description_html;
      const resp = await window.API.request('/api/admin/ribbons', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (resp && resp.ok === false) throw new Error(resp.error || 'Create failed');
      return resp?.data || resp;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createRibbonProduct failed:', e.message);
      throw e;
    }
  },

  async updateRibbonProduct(productId, data) {
    try {
      const payload = { ...data };
      if (payload.description_html != null && payload.description == null) payload.description = payload.description_html;
      const resp = await window.API.request(`/api/admin/ribbons/${encodeURIComponent(productId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (resp && resp.ok === false) throw new Error(resp.error || 'Update failed');
      return resp?.data || resp;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateRibbonProduct failed:', e.message);
      throw e;
    }
  },

  async deleteRibbonProduct(productId) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      // Remove all FK references before deleting the product
      const fkTables = [
        'product_ribbon_brands', 'product_compatibility', 'product_images',
        'product_faqs', 'reviews', 'user_favourites', 'cart_items',
        'cart_analytics_events', 'page_views', 'order_items',
      ];
      await Promise.all(fkTables.map(t => sb.from(t).delete().eq('product_id', productId)));
      const { error } = await sb.from('products').delete().eq('id', productId);
      if (error) throw error;
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteRibbonProduct failed:', e.message);
      throw e;
    }
  },

  // ---- Product ↔ Ribbon Brand assignments (junction table) ----
  async getProductRibbonBrands(productId) {
    try {
      const sb = this._sb();
      if (!sb) return [];
      const { data, error } = await sb.from('product_ribbon_brands')
        .select('ribbon_brand_id, ribbon_brands!product_ribbon_brands_ribbon_brand_id_fkey(id, name, slug)')
        .eq('product_id', productId);
      if (error) throw error;
      return data || [];
    } catch (e) {
      adminApiWarn('Failed to load product ribbon brands', e);
      return [];
    }
  },

  async setProductRibbonBrands(productId, brandIds) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      // Delete existing assignments
      const { error: delErr } = await sb.from('product_ribbon_brands')
        .delete().eq('product_id', productId);
      if (delErr) throw delErr;
      // Insert new assignments
      if (brandIds.length > 0) {
        const rows = brandIds.map(bid => ({ product_id: productId, ribbon_brand_id: bid }));
        const { error: insErr } = await sb.from('product_ribbon_brands').insert(rows);
        if (insErr) throw insErr;
      }
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] setProductRibbonBrands failed:', e.message);
      throw e;
    }
  },

  // ---- Product Codes (Supabase direct — /shop categorisation codes) ----
  // A product's codes are the drilldown chips it appears under (LC40, 200XL…).
  // Stored normalised UPPERCASE alphanumeric — see sql/product_codes.sql. The
  // table is an OVERRIDE layer: a product with rows here has its backend-derived
  // series_codes fully replaced on the storefront; a product with none is
  // untouched.

  /** Normalise a raw code: uppercase, strip everything but A-Z/0-9. */
  normalizeProductCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  },

  /** Codes assigned to one product, ascending. Returns null on error. */
  async getProductCodes(productId) {
    try {
      const sb = this._sb();
      if (!sb) return null;
      const { data, error } = await sb.from('product_codes')
        .select('code').eq('product_id', productId).order('code', { ascending: true });
      if (error) throw error;
      return (data || []).map(r => r.code);
    } catch (e) {
      adminApiWarn('Failed to load product codes', e);
      return null;
    }
  },

  /**
   * Replace a product's entire code set (delete-then-insert). Codes are
   * normalised + de-duped here so a malformed UI value can never reach the
   * table's CHECK constraint. Passing [] clears the product's codes, reverting
   * it to backend-derived series_codes on the storefront. Returns the cleaned
   * list that was actually persisted.
   */
  async setProductCodes(productId, codes) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      const clean = [...new Set((codes || [])
        .map(c => this.normalizeProductCode(c))
        .filter(c => c.length >= 2 && c.length <= 24))];
      const { error: delErr } = await sb.from('product_codes')
        .delete().eq('product_id', productId);
      if (delErr) throw delErr;
      if (clean.length) {
        const rows = clean.map(code => ({ product_id: productId, code }));
        const { error: insErr } = await sb.from('product_codes').insert(rows);
        if (insErr) throw insErr;
      }
      return clean;
    } catch (e) {
      DebugLog.warn('[AdminAPI] setProductCodes failed:', e.message);
      throw e;
    }
  },

  /**
   * The distinct-code catalogue (code + product_count) that powers the picker's
   * autocomplete list. Reads the product_code_catalogue view. Returns null on
   * error — the picker stays usable (search + inline create) without it.
   */
  async getCodeCatalogue() {
    try {
      const sb = this._sb();
      if (!sb) return null;
      const { data, error } = await sb.from('product_code_catalogue')
        .select('code, product_count').order('code', { ascending: true });
      if (error) throw error;
      return data || [];
    } catch (e) {
      adminApiWarn('Failed to load code catalogue', e);
      return null;
    }
  },

  /**
   * Brand-wide code edit: delete `fromCode`, or rename it to `toCode`, across
   * EVERY product in brandSlug+category whose effective codes include it.
   *
   * Walks the /shop code-filtered drilldown (which already merges manual codes)
   * to find affected products, then writes a product_codes override on each:
   * the product's effective codes with `fromCode` removed (delete) or swapped
   * for `toCode` (rename). Materialising the override is the only storefront
   * lever — codes the backend auto-derives can't be erased at the source, so a
   * future import may re-derive `fromCode`; the UI flags that caveat.
   *
   * @returns {{ changed:number, failed:number, products:number }}
   */
  async applyBrandCodeChange({ brandSlug, category, fromCode, toCode = null }) {
    const from = this.normalizeProductCode(fromCode);
    if (from.length < 2) throw new Error('No code to change');
    const to = toCode == null ? null : this.normalizeProductCode(toCode);
    if (toCode != null && (to.length < 2 || to.length > 24)) {
      throw new Error('The new code must be 2–24 letters or numbers');
    }
    if (to === from) return { changed: 0, failed: 0, products: 0 };
    if (!brandSlug || !category || typeof window === 'undefined'
        || !window.API || typeof window.API.getShopData !== 'function') {
      throw new Error('Cannot resolve the brand’s products');
    }

    // Gather every product whose EFFECTIVE codes include `from`. getShopData's
    // code filter already folds in manually-assigned codes and overrides
    // series_codes to the effective set, so p.series_codes is authoritative.
    const affected = new Map(); // productId → effective codes[]
    for (let page = 1; page <= 30; page++) {
      let resp;
      try {
        resp = await window.API.getShopData({ brand: brandSlug, category, code: from, page, limit: 200 });
      } catch (e) {
        throw new Error('Couldn’t load the affected products: ' + e.message);
      }
      const products = (resp && resp.ok && resp.data && Array.isArray(resp.data.products))
        ? resp.data.products : [];
      for (const p of products) {
        if (!p || !p.id || affected.has(p.id)) continue;
        const codes = [...new Set((p.series_codes || [])
          .map(c => this.normalizeProductCode(c)).filter(c => c.length >= 2))];
        if (codes.includes(from)) affected.set(p.id, codes);
      }
      if (products.length < 200) break;
    }

    let changed = 0, failed = 0;
    for (const [id, codes] of affected) {
      const next = codes.filter(c => c !== from);
      if (to && !next.includes(to)) next.push(to);
      try {
        await this.setProductCodes(id, next);
        changed++;
      } catch (e) {
        failed++;
        DebugLog.warn('[AdminAPI] applyBrandCodeChange row failed:', id, e.message);
      }
    }
    // The storefront's manual-code cache is now stale for this brand.
    try {
      if (window.API && window.API._manualCodeCache && window.API._manualCodeCache.clear) {
        window.API._manualCodeCache.clear();
      }
    } catch (_) { /* non-fatal */ }
    return { changed, failed, products: affected.size };
  },

  // ---- Printer Models (Supabase direct) ----

  async getPrinters({ search = '', brandId = '', sort = 'full_name', order = 'asc', page = 1, limit = 200 } = {}) {
    try {
      const sb = this._sb();
      if (!sb) return { printers: [], total: 0 };
      let query = sb.from('printer_models')
        .select('id, full_name, model_name, slug, brand_id, brands(name)', { count: 'exact' });
      if (search) query = query.or(`full_name.ilike.%${search}%,model_name.ilike.%${search}%`);
      if (brandId) query = query.eq('brand_id', brandId);
      const col = ['full_name', 'model_name', 'slug'].includes(sort) ? sort : 'full_name';
      query = query.order(col, { ascending: order !== 'desc' });
      const offset = (page - 1) * limit;
      query = query.range(offset, offset + limit - 1);
      const { data, count, error } = await query;
      if (error) throw error;
      return { printers: data || [], total: count || 0 };
    } catch (e) {
      adminApiWarn('Failed to load printers', e);
      return { printers: [], total: 0 };
    }
  },

  async updatePrinter(id, data) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      const { data: printer, error } = await sb.from('printer_models').update(data).eq('id', id).select().single();
      if (error) throw error;
      return printer;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updatePrinter failed:', e.message);
      throw e;
    }
  },

  async deletePrinter(id) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      const { error: compatError } = await sb.from('product_compatibility').delete().eq('printer_model_id', id);
      if (compatError) throw compatError;
      const { error } = await sb.from('printer_models').delete().eq('id', id);
      if (error) throw error;
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deletePrinter failed:', e.message);
      throw e;
    }
  },

  // ---- Ribbon Brands (Supabase direct) ----
  _sb() {
    return (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
  },

  /**
   * Re-persist the rich-text product columns straight to Supabase, undoing the
   * backend sanitiser that strips `<b>/<i>/<u>/<a>` (see RICH_TEXT_PRODUCT_COLUMNS).
   *
   * Called after every createProduct / updateProduct. Only columns actually
   * present on `data` are written, so a partial update (e.g. a bulk price
   * edit) never blanks a rich-text field it wasn't touching. A `null` value is
   * written through deliberately — that is how the editor clears a field.
   *
   * Non-fatal: the backend write already succeeded, so a Supabase hiccup here
   * is logged but never thrown. Returns true when the repair was applied.
   *
   * @param {string} productId
   * @param {Object} data - the same payload sent to the backend
   * @returns {Promise<boolean>}
   */
  async persistRichTextColumns(productId, data) {
    if (!productId || !data) return false;
    const patch = {};
    for (const col of RICH_TEXT_PRODUCT_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(data, col)) {
        patch[col] = data[col] == null ? null : data[col];
      }
    }
    if (!Object.keys(patch).length) return false;
    const sb = this._sb();
    if (!sb) {
      DebugLog.warn('[AdminAPI] rich-text repair skipped — no Supabase client');
      return false;
    }
    try {
      const { error } = await sb.from('products').update(patch).eq('id', productId);
      if (error) {
        DebugLog.warn('[AdminAPI] rich-text repair failed:', error.message);
        return false;
      }
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] rich-text repair threw:', e.message);
      return false;
    }
  },

  // ─── Per-admin UI preferences ──────────────────────────────────────────────
  // A tiny key/value store scoped to ONE admin account, so each admin can shape
  // their own admin surface (which table columns are visible, etc.) without
  // affecting anyone else.
  //
  //   Durable layer  — Supabase table `admin_ui_prefs` (one JSONB row per user,
  //                    RLS-locked to auth.uid()). Follows the account to any
  //                    browser or device.
  //   Instant layer  — localStorage, keyed by the account id, so the saved
  //                    layout paints on first frame and survives the table
  //                    being briefly unreachable (Render/Supabase cold start).
  //
  // Fail-open by design: if the table does not exist yet, or the network is
  // down, getUiPrefs() still returns the localStorage copy and setUiPref()
  // still persists locally — the feature degrades to per-browser, never breaks.
  // The SQL to create the table lives in inkcartridges/sql/admin_ui_prefs.sql.
  _uiPrefsCache: null,    // the RESOLVED prefs object (set only once reconciled)
  _uiPrefsPromise: null,  // the in-flight getUiPrefs() promise — shared by
                          // concurrent callers so a second call can never
                          // observe the half-resolved (local-only) state.

  _uiPrefsAccountId() {
    return (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) ? Auth.user.id : 'anon';
  },

  _uiPrefsLocalKey() {
    return `admin_ui_prefs:${this._uiPrefsAccountId()}`;
  },

  _uiPrefsReadLocal() {
    try {
      const raw = localStorage.getItem(this._uiPrefsLocalKey());
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch { return {}; }
  },

  _uiPrefsWriteLocal(prefs) {
    try { localStorage.setItem(this._uiPrefsLocalKey(), JSON.stringify(prefs)); } catch { /* quota / private mode */ }
  },

  /**
   * Read this admin's full preference object — the localStorage copy reconciled
   * against Supabase. Always resolves to an object.
   *
   * Race-safe: the reconciliation runs exactly once and every caller (even ones
   * that arrive mid-fetch) awaits the SAME promise. An earlier version cached
   * the local-only value synchronously before the Supabase round-trip, so a
   * second caller arriving during the fetch got stale per-browser defaults
   * instead of the durable cross-device prefs.
   */
  getUiPrefs() {
    if (this._uiPrefsCache) return Promise.resolve(this._uiPrefsCache);
    if (this._uiPrefsPromise) return this._uiPrefsPromise;
    this._uiPrefsPromise = (async () => {
      let resolved = this._uiPrefsReadLocal();
      try {
        const sb = this._sb();
        const uid = (typeof Auth !== 'undefined' && Auth.user) ? Auth.user.id : null;
        if (sb && uid) {
          const { data, error } = await sb
            .from('admin_ui_prefs').select('prefs').eq('user_id', uid).maybeSingle();
          if (error) throw error;
          if (data && data.prefs && typeof data.prefs === 'object' && !Array.isArray(data.prefs)) {
            resolved = data.prefs;
            this._uiPrefsWriteLocal(data.prefs);
          }
        }
      } catch (e) {
        adminApiWarn('getUiPrefs: using local cache (table missing or offline)', e);
      }
      this._uiPrefsCache = resolved;  // publish only the fully-reconciled value
      return resolved;
    })();
    return this._uiPrefsPromise;
  },

  /**
   * Persist a single preference key. Writes localStorage synchronously (so the
   * change is durable even if Supabase rejects) then upserts the whole object
   * to Supabase. Returns true when the durable write succeeded.
   */
  async setUiPref(key, value) {
    const next = { ...(this._uiPrefsCache || this._uiPrefsReadLocal()), [key]: value };
    // Keep cache AND the shared promise pointing at the new value, so a later
    // getUiPrefs() (or one still in flight) can never resurrect a stale object.
    this._uiPrefsCache = next;
    this._uiPrefsPromise = Promise.resolve(next);
    this._uiPrefsWriteLocal(next);
    try {
      const sb = this._sb();
      const uid = (typeof Auth !== 'undefined' && Auth.user) ? Auth.user.id : null;
      if (!sb || !uid) return false;
      const { error } = await sb.from('admin_ui_prefs').upsert(
        { user_id: uid, prefs: next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
      if (error) throw error;
      return true;
    } catch (e) {
      adminApiWarn('setUiPref: saved locally only (table missing or offline)', e);
      return false;
    }
  },

  async getRibbonBrands() {
    try {
      const sb = this._sb();
      if (!sb) return null;
      const { data, error } = await sb.from('ribbon_brands').select('*').eq('is_active', true).order('sort_order', { ascending: true });
      if (error) throw error;
      return data;
    } catch (e) {
      adminApiWarn('Failed to load ribbon brands', e);
      return null;
    }
  },

  async getAdminRibbonBrands() {
    try {
      const sb = this._sb();
      if (!sb) return null;
      const { data, error } = await sb.from('ribbon_brands').select('*').order('sort_order', { ascending: true });
      if (error) throw error;
      return data;
    } catch (e) {
      adminApiWarn('Failed to load admin ribbon brands', e);
      return null;
    }
  },

  async createRibbonBrand(data) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      const { data: brand, error } = await sb.from('ribbon_brands').insert(data).select().single();
      if (error) throw error;
      return brand;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createRibbonBrand failed:', e.message);
      throw e;
    }
  },

  async updateRibbonBrand(id, data) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      const { data: brand, error } = await sb.from('ribbon_brands').update(data).eq('id', id).select().single();
      if (error) throw error;
      return brand;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateRibbonBrand failed:', e.message);
      throw e;
    }
  },

  async deleteRibbonBrand(id) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      const { error } = await sb.from('ribbon_brands').delete().eq('id', id);
      if (error) throw error;
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteRibbonBrand failed:', e.message);
      throw e;
    }
  },

  async reorderRibbonBrands(brands) {
    try {
      const sb = this._sb();
      if (!sb) throw new Error('Supabase not available');
      for (let i = 0; i < brands.length; i++) {
        const { error } = await sb.from('ribbon_brands').update({ sort_order: (i + 1) * 10 }).eq('id', brands[i].id);
        if (error) throw error;
      }
      return true;
    } catch (e) {
      DebugLog.warn('[AdminAPI] reorderRibbonBrands failed:', e.message);
      throw e;
    }
  },

  async uploadRibbonBrandImage(brandId, file) {
    try {
      const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
      if (!sb) throw new Error('Supabase client not available');
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `ribbon-brands/${brandId}.${ext}`;
      const { error: upErr } = await sb.storage.from('product-images').upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: urlData } = sb.storage.from('product-images').getPublicUrl(path);
      const publicUrl = urlData?.publicUrl;
      if (!publicUrl) throw new Error('Failed to get public URL');
      // Update the ribbon_brands record with the image URL
      const { error: dbErr } = await sb.from('ribbon_brands').update({ image_url: publicUrl }).eq('id', brandId);
      if (dbErr) throw dbErr;
      return { image_url: publicUrl };
    } catch (e) {
      DebugLog.warn('[AdminAPI] uploadRibbonBrandImage failed:', e.message);
      throw e;
    }
  },

  // ---- Contact Emails ----
  async getContactEmails() {
    try {
      const resp = await window.API.get('/api/admin/contact-emails');
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load contact emails', e);
      return null;
    }
  },

  async addContactEmail(email) {
    try {
      const resp = await window.API.post('/api/admin/contact-emails', { email });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] addContactEmail failed:', e.message);
      throw e;
    }
  },

  async removeContactEmail(id) {
    try {
      const resp = await window.API.delete(`/api/admin/contact-emails/${id}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] removeContactEmail failed:', e.message);
      throw e;
    }
  },

  // ---- Tracking Requests (customer-initiated, June 2026) ----
  // Customers submit their order number on /track-order; the backend records a
  // row in `order_tracking_requests` (migration 083) and emails the opted-in
  // admins. Fulfilment is AUTOMATIC — there is no fulfil/dismiss endpoint. When
  // an admin sets a tracking number on the order via PUT /api/admin/orders/:id,
  // the backend flips any pending request for that order to `fulfilled` and
  // emails the customer their tracking. So this surface only LISTS requests and
  // routes the admin to the order to add tracking (see pages/tracking-requests.js).
  //
  // Contract (verified against the live backend, June 2026):
  //   GET /api/admin/tracking-requests?status=pending|fulfilled|all
  //     → { ok:true, data:{ requests:[{ id, order_number, email, status,
  //         fulfilled_at, created_at, order:{ status, tracking_number, carrier } }],
  //         total } }
  //   Flat `data.total` — there is no `pagination` object and no page/limit/search.

  /**
   * List tracking requests. `status` is 'pending' | 'fulfilled' | 'all'.
   * Returns { requests, total } or null on error.
   */
  async getTrackingRequests(filters = {}) {
    try {
      const status = filters.status || 'pending';
      const params = new URLSearchParams({ status });
      const resp = await window.API.get(`/api/admin/tracking-requests?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load tracking requests', e);
      return null;
    }
  },

  /** Count of pending tracking requests (for the nav badge). 0 on error. */
  async getPendingTrackingRequestCount() {
    try {
      const resp = await window.API.get('/api/admin/tracking-requests?status=pending');
      const data = resp?.data ?? null;
      if (typeof data?.total === 'number') return data.total;
      return Array.isArray(data?.requests) ? data.requests.length : 0;
    } catch (e) {
      return 0;
    }
  },

  // ---- Compatibility ----
  async addCompatiblePrinter(sku, printerId) {
    try {
      const resp = await window.API.post('/api/admin/compatibility', { sku, printer_id: printerId });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] addCompatiblePrinter failed:', e.message);
      throw e;
    }
  },

  async removeCompatiblePrinter(sku, printerId) {
    try {
      const resp = await window.API.delete(`/api/admin/compatibility/${encodeURIComponent(sku)}/${encodeURIComponent(printerId)}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] removeCompatiblePrinter failed:', e.message);
      throw e;
    }
  },

  async bulkUpsertCompatibility(sku, models) {
    try {
      const resp = await window.API.post('/api/admin/compatibility/bulk-upsert', { sku, models });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkUpsertCompatibility failed:', e.message);
      throw e;
    }
  },

  async bulkApplyCompatibility(skuPrefix, printerIds) {
    try {
      const resp = await window.API.post('/api/admin/compatibility/bulk-by-prefix', {
        sku_prefix: skuPrefix,
        printer_ids: printerIds,
      });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkApplyCompatibility failed:', e.message);
      throw e;
    }
  },

  async createPrinter(name) {
    try {
      const resp = await window.API.post('/api/admin/printers', { name });
      // 409 — printer already exists; return the existing record so callers work transparently
      if (resp?.ok === false) {
        const existing = resp?.data?.error?.details?.printer;
        if (existing) return existing;
        throw new Error(resp?.error || 'Failed to create printer');
      }
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createPrinter failed:', e.message);
      throw e;
    }
  },

  /**
   * Search for a printer by name; create it if not found.
   * Returns { id, name, wasCreated }
   */
  async getOrCreatePrinterId(rawName) {
    const name = rawName.trim();
    if (!name) throw new Error('Printer name cannot be empty');
    // Search first to detect existing without relying on 409
    const searchResp = await window.API.searchPrinters(name);
    const results = searchResp?.data?.printers || searchResp?.data || [];
    const existing = Array.isArray(results) ? results[0] : null;
    if (existing?.id) {
      return { id: String(existing.id), name: existing.full_name || name, wasCreated: false };
    }
    const printer = await this.createPrinter(name);
    const id = String(printer?.id || printer?.printer_id || '');
    if (!id) throw new Error(`Could not get ID for printer: ${name}`);
    return { id, name: printer?.full_name || printer?.name || name, wasCreated: true };
  },

  /**
   * Link a printer to a product by SKU — skips if already linked locally.
   * linkedIds: string[] of already-linked printer IDs from local state.
   * Returns { status: 'added' | 'already_linked' }
   */
  async ensureCompatibility(sku, printerId, linkedIds = []) {
    if (linkedIds.includes(String(printerId))) return { status: 'already_linked' };
    await this.addCompatiblePrinter(sku, printerId);
    return { status: 'added' };
  },

  // ---- Margin Analysis ----
  async getMarginSummary(params = {}) {
    try {
      const qs = new URLSearchParams(params).toString();
      return await window.API.get(`/api/admin/margin/summary${qs ? '?' + qs : ''}`);
    } catch (e) { adminApiWarn('Margin summary', e); return null; }
  },

  async getRecommendedPrices(params = {}) {
    try {
      const qs = new URLSearchParams(params).toString();
      return await window.API.get(`/api/admin/margin/recommended-prices${qs ? '?' + qs : ''}`);
    } catch (e) { adminApiWarn('Recommended prices', e); return null; }
  },

  async getPriceChanges(params = {}) {
    try {
      const qs = new URLSearchParams(params).toString();
      return await window.API.get(`/api/admin/margin/price-changes${qs ? '?' + qs : ''}`);
    } catch (e) { adminApiWarn('Price changes', e); return null; }
  },

  async getOutOfStock(params = {}) {
    try {
      const qs = new URLSearchParams(params).toString();
      return await window.API.get(`/api/admin/margin/out-of-stock${qs ? '?' + qs : ''}`);
    } catch (e) { adminApiWarn('Out of stock', e); return null; }
  },

  async getTopProfit(params = {}) {
    try {
      const qs = new URLSearchParams(params).toString();
      return await window.API.get(`/api/admin/margin/top-profit${qs ? '?' + qs : ''}`);
    } catch (e) { adminApiWarn('Top profit', e); return null; }
  },

  // ---- Data Export (streaming from backend) ----
  async exportCSV(type, filterParams) {
    return this.exportData(type, 'csv', filterParams);
  },

  async exportData(type, format = 'csv', filterParams) {
    try {
      const baseUrl = Config.API_URL;
      const token = window.Auth?.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const url = `${baseUrl}/api/admin/export/${type}?format=${format}&${filterParams}`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);

      const truncated = resp.headers.get('X-Export-Truncated') === 'true';
      const limit = resp.headers.get('X-Export-Limit');

      const ext = { csv: 'csv', excel: 'xlsx', pdf: 'pdf' }[format] || format;
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${type}-${new Date().toISOString().slice(0, 10)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      if (truncated && typeof Toast !== 'undefined') {
        Toast.warning(`Export truncated${limit ? ` to ${limit} rows` : ''}. Narrow filters for a complete export.`);
      }
      return true;
    } catch (e) {
      DebugLog.warn(`[AdminAPI] exportData(${type}, ${format}) failed:`, e.message);
      throw e;
    }
  },

  // ---- Control Center: Profit & Pricing ----
  async getPricingHeatmap(source = 'genuine') {
    try {
      const resp = await window.API.get(`/api/admin/pricing/heatmap?source=${encodeURIComponent(source)}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Pricing heatmap', e); return null; }
  },

  async getUnderMarginProducts(source = 'genuine', page = 1, limit = 50, mode = 'under-margin', sort_by = 'net_margin', sort_order = 'asc') {
    try {
      const qs = new URLSearchParams({ source, page, limit, mode, sort_by, sort_order });
      const resp = await window.API.get(`/api/admin/pricing/under-margin?${qs}`);
      return resp ?? null;
    } catch (e) { adminApiWarn('Under-margin products', e); return null; }
  },

  async getGlobalOffset() {
    try {
      const resp = await window.API.get('/api/admin/pricing/global-offset');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Global offset', e); return null; }
  },

  async updateGlobalOffset(offset, notes) {
    try {
      const resp = await window.API.put('/api/admin/pricing/global-offset', { offset, notes });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateGlobalOffset failed:', e.message);
      throw e;
    }
  },

  // Poll the background reprice job kicked off by a tier-multiplier / global-offset
  // change (both PUTs return 202 + a reprice.job_id). Returns the job row
  // { id, status, trigger, counts, error, ... } or null on failure.
  async getRepriceJob(jobId) {
    try {
      const resp = await window.API.get(`/api/admin/pricing/reprice-jobs/${encodeURIComponent(jobId)}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Reprice job status', e); return null; }
  },

  // ---- Control Center: SEO & Trust ----
  async getSeoIndexingStatus() {
    try {
      const resp = await window.API.get('/api/admin/seo/indexing-status');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('SEO indexing status', e); return null; }
  },

  async getSerpRankings(keyword = '') {
    try {
      const params = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
      const resp = await window.API.get(`/api/admin/seo/serp-rankings${params}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('SERP rankings', e); return null; }
  },

  async bulkApproveReviews(minRating, dryRun = true) {
    try {
      const resp = await window.API.post('/api/admin/reviews/bulk-approve', {
        min_rating: minRating,
        dry_run: dryRun,
      });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkApproveReviews failed:', e.message);
      throw e;
    }
  },

  // ---- Control Center: Inventory & Supplier ----
  async getSupplierImportStatus() {
    try {
      const resp = await window.API.get('/api/admin/supplier/import-status');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Import status', e); return null; }
  },

  async getPriceDiscrepancies(params = {}) {
    try {
      const qs = new URLSearchParams({
        min_change_pct: params.min_change_pct ?? 20,
        days: params.days ?? 30,
        page: params.page ?? 1,
        limit: params.limit ?? 50,
      });
      const resp = await window.API.get(`/api/admin/supplier/price-discrepancies?${qs}`);
      return resp ?? null;
    } catch (e) { adminApiWarn('Price discrepancies', e); return null; }
  },

  async triggerReconcile() {
    try {
      const resp = await window.API.post('/api/admin/supplier/trigger-reconcile');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] triggerReconcile failed:', e.message);
      throw e;
    }
  },

  // ---- Control Center: Orders & Compliance ----
  async getPaymentBreakdown(startDate, endDate) {
    try {
      const qs = new URLSearchParams();
      if (startDate) qs.set('start_date', startDate);
      if (endDate) qs.set('end_date', endDate);
      const resp = await window.API.get(`/api/admin/audit/payment-breakdown?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Payment breakdown', e); return null; }
  },

  async getInvoicePreviewUrl(orderId) {
    try {
      const token = window.Auth?.session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const resp = await fetch(`${Config.API_URL}/api/admin/audit/invoice-preview/${encodeURIComponent(orderId)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`Invoice fetch failed: ${resp.status}`);
      const blob = await resp.blob();
      return URL.createObjectURL(blob);
    } catch (e) {
      DebugLog.warn('[AdminAPI] getInvoicePreviewUrl failed:', e.message);
      throw e;
    }
  },

  async getAuditLogs(params = {}) {
    try {
      const qs = new URLSearchParams();
      if (params.action) qs.set('action', params.action);
      qs.set('page', params.page ?? 1);
      qs.set('limit', params.limit ?? 50);
      const resp = await window.API.get(`/api/admin/audit/logs?${qs}`);
      return resp ?? null;
    } catch (e) { adminApiWarn('Audit logs', e); return null; }
  },

  // ---- Order Integrity ----
  async getOrderBreakdown(orderId) {
    try {
      const resp = await window.API.get(`/api/admin/audit/order-breakdown/${encodeURIComponent(orderId)}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Order breakdown', e); return null; }
  },

  // ---- Pricing: Tier Multipliers ----
  async getTierMultipliers() {
    try {
      const resp = await window.API.get('/api/admin/pricing/tier-multipliers');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Tier multipliers', e); return null; }
  },

  async updateTierMultipliers(multipliers) {
    try {
      const resp = await window.API.put('/api/admin/pricing/tier-multipliers', multipliers);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateTierMultipliers failed:', e.message);
      throw e;
    }
  },

  // ---- Market Intel ----
  async getMarketIntelReport() {
    try {
      const resp = await window.API.get('/api/admin/market-intel/report');
      return resp?.data ?? null;
    } catch (e) {
      // Distinguish "no report yet" (expected) from real errors
      if (e.status === 404 || /NOT_FOUND|No reconciliation report/i.test(e.message || '')) {
        return { _empty: true, _hint: 'No report yet — run a competitive price check to generate one.' };
      }
      adminApiWarn('Market intel report', e);
      return null;
    }
  },

  async getOverpricedProducts(page = 1, limit = 50, brand = '') {
    try {
      const qs = new URLSearchParams({ page, limit });
      if (brand) qs.set('brand', brand);
      const resp = await window.API.get(`/api/admin/market-intel/overpriced?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Overpriced products', e); return null; }
  },

  async getMarketDiscrepancies(minVariance = 15) {
    try {
      const qs = new URLSearchParams({ min_variance: minVariance });
      const resp = await window.API.get(`/api/admin/market-intel/discrepancies?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Market discrepancies', e); return null; }
  },

  async matchPrice(sku, targetPrice) {
    try {
      const resp = await window.API.post('/api/admin/market-intel/match-price', {
        sku, target_price: targetPrice,
      });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] matchPrice failed:', e.message);
      throw e;
    }
  },

  // ---- Tech Monitoring ----
  async getCronHistory(params = {}) {
    try {
      const qs = new URLSearchParams();
      if (params.job_name) qs.set('job_name', params.job_name);
      if (params.status) qs.set('status', params.status);
      qs.set('page', params.page ?? 1);
      qs.set('limit', params.limit ?? 50);
      const resp = await window.API.get(`/api/admin/monitoring/cron-history?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Cron history', e); return null; }
  },

  async getCronSummary() {
    try {
      const resp = await window.API.get('/api/admin/monitoring/cron-summary');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Cron summary', e); return null; }
  },

  async getHealthCheck() {
    try {
      const resp = await window.API.get('/api/admin/monitoring/health');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Health check', e); return null; }
  },

  async getRlsStatus() {
    try {
      const resp = await window.API.get('/api/admin/monitoring/rls-status');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('RLS status', e); return null; }
  },

  // ---- Customer Reviews ----
  async getReviews(filters = {}, page = 1, limit = 20) {
    try {
      const qs = new URLSearchParams({ page, limit });
      if (filters.status) qs.set('status', filters.status);
      if (filters.search) qs.set('search', filters.search);
      if (filters.min_rating) qs.set('min_rating', filters.min_rating);
      const resp = await window.API.get(`/api/admin/reviews?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('Reviews', e); return null; }
  },

  async updateReview(reviewId, data) {
    try {
      const resp = await window.API.put(`/api/admin/reviews/${encodeURIComponent(reviewId)}`, data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateReview failed:', e.message);
      throw e;
    }
  },


  // ---- Feed Sync Report & Bulk Publish ----

  /**
   * Get the latest feed sync report with summary and item details.
   * @param {object} filters - { import_run_id, action, priority, source, has_price_anomaly, page, limit }
   */
  async getSyncReport(filters = {}, signal = null) {
    try {
      if (signal?.aborted) return null;
      const params = new URLSearchParams();
      if (filters.import_run_id) params.set('import_run_id', filters.import_run_id);
      if (filters.action) params.set('action', filters.action);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.source) params.set('source', filters.source);
      if (filters.has_price_anomaly !== undefined) params.set('has_price_anomaly', filters.has_price_anomaly);
      params.set('page', filters.page || 1);
      params.set('limit', filters.limit || 50);
      const resp = await window.API.get(`/api/admin/sync-report?${params}`);
      return resp ?? null;
    } catch (e) {
      adminApiWarn('Failed to load sync report', e);
      return null;
    }
  },

  /**
   * Publish staged new products by SKU list.
   * @param {string[]} skus - Array of SKUs to publish
   */
  async bulkPublish(skus) {
    try {
      const resp = await window.API.post('/api/admin/bulk-publish', { skus });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkPublish failed:', e.message);
      throw e;
    }
  },

  // =========================================================================
  // Admin P1 — Resend invoice
  // =========================================================================
  async resendInvoice(orderId) {
    const resp = await window.API.post(`/api/admin/orders/${orderId}/resend-invoice`, {});
    if (resp && resp.ok === false) throw new Error(resp.error || 'Resend failed');
    return resp?.data ?? null;
  },

  // =========================================================================
  // Admin — Standalone Invoices (manual / order-sourced invoicing page)
  // ---------------------------------------------------------------------
  // Backend endpoints are NOT live yet — these follow the agreed contract so
  // the frontend is wired ahead of the backend handoff. Reads fail soft
  // (null + toast); writes throw so the page can surface a clean error.
  // The backend is the authority on invoice_number and the saved totals.
  // =========================================================================
  async listInvoices(filters = {}, page = 1, limit = 20) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.search) params.set('search', filters.search);
      if (filters.status) params.set('status', filters.status);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      const resp = await window.API.get(`/api/admin/invoices?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load invoices', e);
      return null;
    }
  },

  async getInvoice(invoiceId) {
    try {
      const resp = await window.API.get(`/api/admin/invoices/${encodeURIComponent(invoiceId)}`);
      return resp?.data?.invoice ?? resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load invoice', e);
      return null;
    }
  },

  // Suggested next invoice number for a new draft (auto-filled but editable).
  // Prefers a dedicated peek endpoint; falls back to max(invoice_number)+1 from
  // the first list page. Read-soft: returns null if neither works (field left blank).
  async nextInvoiceNumber() {
    try {
      const resp = await window.API.get('/api/admin/invoices/next-number');
      const n = resp?.data?.next ?? resp?.data?.invoice_number ?? resp?.data;
      if (n != null && Number.isFinite(Number(n))) return Number(n);
    } catch (e) { adminApiWarn('Next invoice number lookup failed', e); }
    try {
      const data = await this.listInvoices({ sort: 'invoice_number', order: 'desc' }, 1, 1);
      const rows = data?.invoices ?? data?.items ?? (Array.isArray(data) ? data : []);
      const max = rows.reduce((m, r) => Math.max(m, Number(r?.invoice_number) || 0), 0);
      if (max > 0) return max + 1;
    } catch (e) { adminApiWarn('Next invoice number fallback failed', e); }
    return null;
  },

  // Backend assigns the next invoice_number in series and returns the
  // authoritative subtotal/gst/total on the saved record.
  async createInvoice(payload) {
    const resp = await window.API.post('/api/admin/invoices', payload);
    if (resp && resp.ok === false) throw invoiceError(resp, 'Create invoice failed');
    return resp?.data?.invoice ?? resp?.data ?? null;
  },

  async updateInvoice(invoiceId, payload) {
    const resp = await window.API.put(`/api/admin/invoices/${encodeURIComponent(invoiceId)}`, payload);
    if (resp && resp.ok === false) throw invoiceError(resp, 'Update invoice failed');
    return resp?.data?.invoice ?? resp?.data ?? null;
  },

  async voidInvoice(invoiceId) {
    const resp = await window.API.post(`/api/admin/invoices/${encodeURIComponent(invoiceId)}/void`, {});
    if (resp && resp.ok === false) throw invoiceError(resp, 'Void invoice failed');
    return resp?.data ?? null;
  },

  // Flip an invoice's internal paid/unpaid status from the list (inline toggle).
  // Mirrors the /void sub-route shape; backend route POST /api/admin/invoices/:id/paid
  // is pending — a 404 surfaces as err.code 'NOT_FOUND' so the caller fails soft.
  async markInvoicePaid(invoiceId, paid) {
    const resp = await window.API.post(`/api/admin/invoices/${encodeURIComponent(invoiceId)}/paid`, { paid: !!paid });
    if (resp && resp.ok === false) throw invoiceError(resp, 'Mark invoice paid/unpaid failed');
    return resp?.data ?? null;
  },

  // Hard-delete (permanent removal) — for operator cleanup of test/erroneous
  // invoices. Normal lifecycle is void (kept for records). Backend route
  // DELETE /api/admin/invoices/:id is pending; a 404 surfaces as a clean toast.
  async deleteInvoice(invoiceId) {
    const resp = await window.API.delete(`/api/admin/invoices/${encodeURIComponent(invoiceId)}`);
    if (resp && resp.ok === false) throw invoiceError(resp, 'Delete invoice failed');
    return resp?.data ?? null;
  },

  // Email the invoice PDF to the customer. Optional message = { to, subject, body }
  // from the composer; when omitted (empty {}) the backend uses its default template
  // and the invoice's stored customer email (backward compatible).
  async emailInvoice(invoiceId, message) {
    const resp = await window.API.post(`/api/admin/invoices/${encodeURIComponent(invoiceId)}/email`, message || {});
    if (resp && resp.ok === false) throw invoiceError(resp, 'Email invoice failed');
    return resp?.data ?? null;
  },

  // Upload the frontend-rendered PDF so the backend stores it and serves/emails THAT
  // exact file (single source of truth = the frontend layout). pdfBase64 is the raw
  // base64 (no data: prefix). Backend endpoint is pending — a 404 is expected until
  // it ships, and the caller swallows the error so saves never break.
  async uploadInvoicePdf(invoiceId, pdfBase64, filename) {
    const resp = await window.API.post(`/api/admin/invoices/${encodeURIComponent(invoiceId)}/pdf`, { pdf_base64: pdfBase64, filename });
    if (resp && resp.ok === false) throw invoiceError(resp, 'Upload invoice PDF failed');
    return resp?.data ?? null;
  },

  // =========================================================================
  // Admin — Quick Orders (phone / walk-in order register)
  // =========================================================================
  // Deliberately separate from website Orders. Reads fail soft (return null so
  // the page degrades to an empty list); writes throw so the editor can surface
  // the backend message. All routes 404 until the backend ships them — contract
  // in readfirst/quick-orders-backend-jul2026.md.
  async listQuickOrders(filters = {}, page = 1, limit = 20) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.search) params.set('search', filters.search);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      const resp = await window.API.get(`/api/admin/quick-orders?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load quick orders', e);
      return null;
    }
  },

  async getQuickOrder(quickOrderId) {
    try {
      const resp = await window.API.get(`/api/admin/quick-orders/${encodeURIComponent(quickOrderId)}`);
      return resp?.data?.quick_order ?? resp?.data ?? null;
    } catch (e) {
      adminApiWarn('Failed to load quick order', e);
      return null;
    }
  },

  async createQuickOrder(payload) {
    const resp = await window.API.post('/api/admin/quick-orders', payload);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Create quick order failed');
    return resp?.data?.quick_order ?? resp?.data ?? null;
  },

  async updateQuickOrder(quickOrderId, payload) {
    const resp = await window.API.put(`/api/admin/quick-orders/${encodeURIComponent(quickOrderId)}`, payload);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Update quick order failed');
    return resp?.data?.quick_order ?? resp?.data ?? null;
  },

  async deleteQuickOrder(quickOrderId) {
    const resp = await window.API.delete(`/api/admin/quick-orders/${encodeURIComponent(quickOrderId)}`);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Delete quick order failed');
    return resp?.data ?? null;
  },

  // Backend-rendered PDF — returns a Blob object URL (mirrors
  // getInvoicePreviewUrl). The page falls back to client-side jsPDF when this
  // endpoint isn't available yet, so a 404/network error is expected pre-backend.
  async downloadInvoicePdf(invoiceId) {
    const token = window.Auth?.session?.access_token;
    if (!token) throw new Error('Not authenticated');
    const resp = await fetch(`${Config.API_URL}/api/admin/invoices/${encodeURIComponent(invoiceId)}/pdf`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Invoice PDF fetch failed: ${resp.status}`);
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  },

  // =========================================================================
  // Admin — Shipping rates CRUD
  // =========================================================================
  async getShippingRates() {
    const resp = await window.API.get('/api/admin/shipping/rates');
    return resp?.data ?? null;
  },
  async createShippingRate(payload) {
    const resp = await window.API.post('/api/admin/shipping/rates', payload);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Create failed');
    return resp?.data ?? null;
  },
  async updateShippingRate(id, payload) {
    const resp = await window.API.put(`/api/admin/shipping/rates/${id}`, payload);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Update failed');
    return resp?.data ?? null;
  },
  async deleteShippingRate(id) {
    const resp = await window.API.delete(`/api/admin/shipping/rates/${id}`);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Delete failed');
    return true;
  },

  // =========================================================================
  // Admin — Promotions CRUD (coupon codes)
  // =========================================================================
  async getPromotions(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const resp = await window.API.get(`/api/admin/promotions${qs ? '?' + qs : ''}`);
    return resp?.data ?? null;
  },
  async createPromotion(payload) {
    const resp = await window.API.post('/api/admin/promotions', payload);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Create failed');
    return resp?.data ?? null;
  },
  async updatePromotion(id, payload) {
    const resp = await window.API.put(`/api/admin/promotions/${id}`, payload);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Update failed');
    return resp?.data ?? null;
  },
  async deletePromotion(id) {
    const resp = await window.API.delete(`/api/admin/promotions/${id}`);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Delete failed');
    return true;
  },

  // =========================================================================
  // Admin — Coupons CRUD (/api/admin/coupons)
  // =========================================================================
  async getCoupons(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const resp = await window.API.get(`/api/admin/coupons${qs ? '?' + qs : ''}`);
    return resp?.data ?? null;
  },
  async createCoupon(payload) {
    const resp = await window.API.post('/api/admin/coupons', payload);
    if (resp && resp.ok === false) {
      const err = new Error(resp.error?.message || resp.error || 'Create failed');
      err.code = resp.error?.code;
      err.details = resp.error?.details;
      throw err;
    }
    return resp?.data ?? null;
  },
  async updateCoupon(id, payload) {
    const resp = await window.API.put(`/api/admin/coupons/${id}`, payload);
    if (resp && resp.ok === false) {
      const err = new Error(resp.error?.message || resp.error || 'Update failed');
      err.code = resp.error?.code;
      err.details = resp.error?.details;
      throw err;
    }
    return resp?.data ?? null;
  },
  async deleteCoupon(id, permanent = false) {
    const qs = permanent ? '?permanent=true' : '';
    const resp = await window.API.delete(`/api/admin/coupons/${id}${qs}`);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Delete failed');
    return true;
  },
  async getCouponLogs(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const resp = await window.API.get(`/api/admin/coupons/logs${qs ? '?' + qs : ''}`);
    return resp?.data ?? null;
  },

  // =========================================================================
  // Admin — Abuse detection
  // =========================================================================
  async getAbuseFlags(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const resp = await window.API.get(`/api/admin/abuse/flags${qs ? '?' + qs : ''}`);
    return resp?.data ?? null;
  },
  async resolveAbuseFlag(id, notes = '') {
    const resp = await window.API.put(`/api/admin/abuse/flags/${id}/resolve`, { notes });
    if (resp && resp.ok === false) throw new Error(resp.error || 'Resolve failed');
    return resp?.data ?? null;
  },
  async getCouponSignals(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const resp = await window.API.get(`/api/admin/abuse/coupon-signals${qs ? '?' + qs : ''}`);
    return resp?.data ?? null;
  },
  async getBlockedDomains() {
    const resp = await window.API.get('/api/admin/abuse/blocked-domains');
    return resp?.data ?? null;
  },
  async addBlockedDomain(domain, reason = '') {
    const resp = await window.API.post('/api/admin/abuse/blocked-domains', { domain, reason });
    if (resp && resp.ok === false) throw new Error(resp.error || 'Block failed');
    return resp?.data ?? null;
  },
  async removeBlockedDomain(id) {
    const resp = await window.API.delete(`/api/admin/abuse/blocked-domains/${id}`);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Unblock failed');
    return true;
  },

  // =========================================================================
  // Admin — Customer segments + campaign email
  // =========================================================================
  async getSegments() {
    const resp = await window.API.get('/api/admin/segments');
    return resp?.data ?? null;
  },
  async createSegment(payload) {
    const resp = await window.API.post('/api/admin/segments', payload);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Create failed');
    return resp?.data ?? null;
  },
  async assignSegmentUsers(segmentId, userIds) {
    const resp = await window.API.post(`/api/admin/segments/${segmentId}/users`, { user_ids: userIds });
    if (resp && resp.ok === false) throw new Error(resp.error || 'Assign failed');
    return resp?.data ?? null;
  },
  async sendAnnouncement(payload) {
    const resp = await window.API.post('/api/admin/email/send-announcement', payload);
    if (resp && resp.ok === false) throw new Error(resp.error || 'Send failed');
    return resp?.data ?? null;
  },

  // =========================================================================
  // Admin — Recovery & data-integrity
  // =========================================================================
  async getRecoveryHealth() {
    const resp = await window.API.get('/api/admin/recovery/health-check');
    return resp?.data ?? null;
  },
  async runDataIntegrityAudit() {
    const resp = await window.API.post('/api/admin/recovery/data-integrity-audit', {});
    if (resp && resp.ok === false) throw new Error(resp.error || 'Audit failed');
    return resp?.data ?? null;
  },

  // =========================================================================
  // Admin — Price Monitor
  // =========================================================================
  priceMonitor: {
    async getScrapeStatus() {
      try {
        const resp = await window.API.get('/api/admin/price-monitor/scrape-status');
        return resp?.data ?? null;
      } catch (e) {
        adminApiWarn('Load scrape status', e);
        return null;
      }
    },
    async getProducts({ page = 1, limit = 25, search, brand, source, sort, margin_alert, out_of_stock_cheapest } = {}) {
      try {
        const p = new URLSearchParams();
        p.set('page', page);
        p.set('limit', Math.min(Number(limit) || 25, 200));
        if (search) p.set('search', search);
        if (brand) p.set('brand', brand);
        if (source) p.set('source', source);
        if (sort) p.set('sort', sort);
        if (margin_alert) p.set('margin_alert', 'true');
        if (out_of_stock_cheapest) p.set('out_of_stock_cheapest', 'true');
        const resp = await window.API.get(`/api/admin/price-monitor/products?${p}`);
        return resp ?? null;
      } catch (e) {
        adminApiWarn('Load price monitor products', e);
        return null;
      }
    },
    async bulkAction({ action, product_ids, undercut_amount }) {
      const payload = { action, product_ids };
      if (undercut_amount != null) payload.undercut_amount = undercut_amount;
      const resp = await window.API.post('/api/admin/price-monitor/bulk-action', payload);
      if (resp && resp.ok === false) throw new Error(resp.error || 'Bulk action failed');
      return resp?.data ?? null;
    },
    async updatePrice(sku, target_price) {
      const resp = await window.API.post('/api/admin/price-monitor/update-price', { sku, target_price });
      if (resp && resp.ok === false) throw new Error(resp.error || 'Update failed');
      return resp?.data ?? null;
    },
    async generateExport() {
      const resp = await window.API.post('/api/admin/price-monitor/exports/generate', {});
      if (resp && resp.ok === false) throw new Error(resp.error || 'Generate failed');
      return resp?.data ?? null;
    },
    async listExports() {
      try {
        const resp = await window.API.get('/api/admin/price-monitor/exports');
        return resp?.data ?? [];
      } catch (e) {
        adminApiWarn('List exports', e);
        return [];
      }
    },
    async downloadExport(filename) {
      const token = window.Auth?.session?.access_token;
      const url = `${Config.API_URL}/api/admin/price-monitor/export/${encodeURIComponent(filename)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  },

  // ---- Financial Health Analytics ----
  async getAdminAnalyticsOverview(timeRange = 30) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/overview?timeRange=${timeRange}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/overview', e); return null; }
  },
  async getAdminAnalyticsPnL(days = 30) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/pnl?days=${days}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/pnl', e); return null; }
  },
  async getAdminAnalyticsCashflow(months = 12) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/cashflow?months=${months}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/cashflow', e); return null; }
  },
  async getAdminAnalyticsBurnRunway() {
    try {
      const resp = await window.API.get('/api/admin/analytics/burn-runway');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/burn-runway', e); return null; }
  },
  async getAdminAnalyticsForecasts() {
    try {
      const resp = await window.API.get('/api/admin/analytics/forecasts');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/forecasts', e); return null; }
  },
  async getAdminAnalyticsForecastHistory(days = 90, horizon = 30) {
    try {
      const d = Math.min(365, Math.max(1, Number(days) || 90));
      const h = [30, 60, 90].includes(Number(horizon)) ? Number(horizon) : 30;
      const resp = await window.API.get(`/api/admin/analytics/forecast-history?days=${d}&horizon=${h}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/forecast-history', e); return null; }
  },
  async getAdminAnalyticsDailyRevenue(days = 365) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/daily-revenue?days=${days}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/daily-revenue', e); return null; }
  },
  async getAdminAnalyticsExpenses(limit = 50) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/expenses?limit=${limit}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('analytics/expenses', e); return null; }
  },
  async addAdminAnalyticsExpense(expense) {
    const resp = await window.API.post('/api/admin/analytics/expenses', expense);
    if (resp && resp.ok === false) throw new Error(resp.error?.message || resp.error || 'Save failed');
    return resp?.data ?? null;
  },

  // =========================================================================
  // Admin — Control Center (May 2026 spec, src/routes/adminControlCenter.js)
  // 11 endpoints: super_admin only. See readfirst/control-center-may2026.md.
  //
  // Convention:
  //   - Read methods swallow errors and return null (toast on failure) so
  //     dashboards stay rendered even if one tile is down.
  //   - Write methods throw with a structured error so the caller can map
  //     413 / 422 / 429 to inline UX (see ccErrorToast helper below).
  // =========================================================================
  controlCenter: {
    async healthSummary(signal = null) {
      try {
        const resp = await window.API.get('/api/admin/health/summary', { signal });
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load health summary', e); return null; }
    },

    async simulatePricing(payload) {
      const resp = await window.API.post('/api/admin/pricing/simulate', payload);
      if (resp && resp.ok === false) {
        const err = new Error(resp.error?.message || resp.error || 'Simulate failed');
        err.code = resp.error?.code; err.details = resp.error?.details;
        throw err;
      }
      return resp?.data ?? null;
    },

    async getTierMultipliers() {
      try {
        const resp = await window.API.get('/api/admin/pricing/tier-multipliers');
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load tier multipliers', e); return null; }
    },

    // Commit edited tier multipliers. Mirrors the Copy-JSON payload exactly:
    // { proposed_tiers: { [source]: {...} }, apply_ending_snap: true }.
    // Surfaces backend error codes (FORBIDDEN / VALIDATION_FAILED / RATE_LIMITED).
    async commitPricing(payload) {
      const resp = await window.API.put('/api/admin/pricing/tier-multipliers', payload);
      if (resp && resp.ok === false) {
        const err = new Error(resp.error?.message || resp.error || 'Commit failed');
        err.code = resp.error?.code; err.details = resp.error?.details;
        throw err;
      }
      return resp?.data ?? null;
    },

    async getPackHealth(skuOrId) {
      try {
        const resp = await window.API.get(`/api/admin/packs/${encodeURIComponent(skuOrId)}/health`);
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load pack health', e); return null; }
    },

    async getPackHealthList({ source, filter = 'both', page = 1, limit = 50 } = {}) {
      try {
        const p = new URLSearchParams();
        if (source) p.set('source', source);
        if (filter) p.set('filter', filter);
        p.set('page', String(page));
        p.set('limit', String(Math.min(Number(limit) || 50, 200)));
        const resp = await window.API.get(`/api/admin/packs/health/list?${p}`);
        return resp ?? null; // keep envelope so caller sees meta
      } catch (e) { adminApiWarn('Load pack health list', e); return null; }
    },

    async bulkPackAction({ pack_ids, action, dry_run = true, reason }) {
      const resp = await window.API.post('/api/admin/packs/bulk-action', {
        pack_ids, action, dry_run, ...(reason ? { reason } : {}),
      });
      if (resp && resp.ok === false) {
        const err = new Error(resp.error?.message || resp.error || 'Bulk action failed');
        err.code = resp.error?.code; err.details = resp.error?.details;
        throw err;
      }
      return resp?.data ?? null;
    },

    async getOrphans() {
      try {
        const resp = await window.API.get('/api/admin/compat/orphans');
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load compat orphans', e); return null; }
    },

    async getSlugHealth() {
      try {
        const resp = await window.API.get('/api/admin/seo/slug-health');
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load slug health', e); return null; }
    },

    async previewSlugRename({ product_id, new_slug }) {
      const resp = await window.API.post('/api/admin/seo/slug-rename-preview', { product_id, new_slug });
      // Preview can return ok:false with a *reason* — that's not an error,
      // it's the spec's way of reporting conflicts. Return the body verbatim
      // so the SlugRenameSheet can branch on resp.reason.
      return resp ?? null;
    },

    async commitSlugRename({ product_id, new_slug, reason }) {
      const resp = await window.API.post('/api/admin/seo/slug-rename', {
        product_id, new_slug, confirm: true, ...(reason ? { reason } : {}),
      });
      if (resp && resp.ok === false) {
        const err = new Error(resp.error?.message || resp.error || resp.reason || 'Rename failed');
        err.code = resp.error?.code || resp.reason; err.details = resp.error?.details;
        throw err;
      }
      return resp?.data ?? resp ?? null;
    },

    async getPrerenderHealth() {
      try {
        const resp = await window.API.get('/api/admin/infra/prerender-health');
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load prerender health', e); return null; }
    },

    async getImagePipeline() {
      try {
        const resp = await window.API.get('/api/admin/infra/image-pipeline');
        return resp?.data ?? null;
      } catch (e) { adminApiWarn('Load image pipeline health', e); return null; }
    },
  },
};

// ---- Supabase REST table helper (PostgREST) ----
async function supabaseREST(method, path, body = null, signal = null) {
  const token = window.Auth?.session?.access_token;
  if (!token) throw new Error('Unauthorized');
  const url = `${Config.SUPABASE_URL}/rest/v1/${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': Config.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Prefer': 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: resp.statusText }));
    throw new Error(err.message || `REST ${method} ${path}: ${resp.status}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : [];
}

const PlannerAPI = {
  async getTasks(fromDate, toDate, optsOrSignal = null) {
    // Backwards compatible: 3rd arg may be an AbortSignal or an options bag.
    const opts = (optsOrSignal && typeof optsOrSignal === 'object' && !('aborted' in optsOrSignal))
      ? optsOrSignal
      : { signal: optsOrSignal };
    const { owner = null, includeCompleted = true, signal = null } = opts;
    try {
      const parts = [`due_date=gte.${fromDate}`, `due_date=lte.${toDate}`];
      if (owner) parts.push(`owner=eq.${owner}`);
      if (!includeCompleted) parts.push('completed=eq.false');
      const q = `planner_tasks?${parts.join('&')}&order=due_date.asc,priority.asc`;
      return await supabaseREST('GET', q, null, signal) || [];
    } catch (e) {
      if (e.name === 'AbortError') return [];
      adminApiWarn('Failed to load planner tasks', e);
      return [];
    }
  },

  async createTask(data) {
    try {
      const rows = await supabaseREST('POST', 'planner_tasks', data);
      return Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { adminApiWarn('Failed to create task', e); return null; }
  },

  async updateTask(id, data) {
    try {
      data.updated_at = new Date().toISOString();
      const rows = await supabaseREST('PATCH', `planner_tasks?id=eq.${id}`, data);
      return Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { adminApiWarn('Failed to update task', e); return null; }
  },

  async toggleComplete(id, currentlyCompleted) {
    return this.updateTask(id, {
      completed: !currentlyCompleted,
      completed_at: !currentlyCompleted ? new Date().toISOString() : null,
    });
  },

  async deleteTask(id) {
    try {
      await supabaseREST('DELETE', `planner_tasks?id=eq.${id}`);
      return true;
    } catch (e) { adminApiWarn('Failed to delete task', e); return false; }
  },
};

const PlannerNotesAPI = {
  async list(signal = null) {
    try {
      const q = 'planner_notes?order=pinned.desc,updated_at.desc';
      return await supabaseREST('GET', q, null, signal) || [];
    } catch (e) {
      if (e.name === 'AbortError') return [];
      adminApiWarn('Failed to load planner notes', e);
      return [];
    }
  },

  async create(data) {
    try {
      const rows = await supabaseREST('POST', 'planner_notes', data);
      return Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { adminApiWarn('Failed to create note', e); return null; }
  },

  async update(id, data) {
    try {
      data.updated_at = new Date().toISOString();
      const rows = await supabaseREST('PATCH', `planner_notes?id=eq.${id}`, data);
      return Array.isArray(rows) ? rows[0] : rows;
    } catch (e) { adminApiWarn('Failed to update note', e); return null; }
  },

  async togglePin(id, currentlyPinned) {
    return this.update(id, { pinned: !currentlyPinned });
  },

  async remove(id) {
    try {
      await supabaseREST('DELETE', `planner_notes?id=eq.${id}`);
      return true;
    } catch (e) { adminApiWarn('Failed to delete note', e); return false; }
  },
};

export {
  AdminAPI, PlannerAPI, PlannerNotesAPI,
  // Pure analytics-shape helpers — exported for unit tests (see
  // tests/admin-analytics-wiring.test.js).
  analyticsQuery, normalizeKpiSummary, adaptCustomerSummary,
};
