/**
 * AdminAPI — Admin-specific API layer
 * Uses window.API for REST calls + Supabase RPC for analytics
 */

// Direct RPC via Supabase REST — avoids creating a second GoTrueClient
async function rpc(fnName, params = {}, signal = null) {
  try {
    if (signal?.aborted) return null;
    const url = `${Config.SUPABASE_URL}/rest/v1/rpc/${fnName}`;
    const token = window.Auth?.session?.access_token || Config.SUPABASE_ANON_KEY;
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
    const result = await resp.json();
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
      DebugLog.warn('[AdminAPI] getOrders failed:', e.message);
      return null;
    }
  },

  async getOrder(orderId) {
    try {
      const resp = await window.API.get(`/api/admin/orders/${orderId}`);
      // Backend wraps single order in data.order
      return resp?.data?.order ?? resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getOrder failed:', e.message);
      return null;
    }
  },

  async updateOrderStatus(orderId, status, body = {}) {
    try {
      const payload = { ...body, status };
      const resp = await window.API.put(`/api/admin/orders/${orderId}`, payload);
      // Handle 409 conflict (status changed concurrently)
      if (resp && resp.ok === false) {
        throw new Error(resp.error || 'Update failed');
      }
      return resp?.data ?? null;
    } catch (e) {
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
      DebugLog.warn('[AdminAPI] getOrderEvents failed:', e.message);
      return null;
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
      DebugLog.warn('[AdminAPI] getRefunds failed:', e.message);
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

  // ---- Dashboard Analytics (RPC — owner-only by RLS) ----
  async getDashboardKPIs(filterParams, signal) {
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_kpi_summary', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
      supplier_filter: filterParams.get('suppliers') || null,
      status_filter: filterParams.get('statuses') || null,
    }, signal);
  },

  async getRevenueSeries(filterParams, signal) {
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
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_refunds_series', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
    }, signal);
  },

  async getFulfillmentSLA(filterParams, signal) {
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_fulfillment_sla', {
      date_from: from, date_to: to,
      supplier_filter: filterParams.get('suppliers') || null,
    }, signal);
  },

  // ---- Work Queue (operational — accessible by both admin + owner) ----
  async getWorkQueue(signal) {
    return rpc('admin_work_queue', {}, signal);
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
      DebugLog.warn('[AdminAPI] getCustomers failed:', e.message);
      return null;
    }
  },

  // ---- Products ----
  async getProducts(filters = {}, page = 1, limit = 200) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.brand) params.set('brand', filters.brand);
      if (filters.search) params.set('search', filters.search);
      if (filters.active !== undefined) params.set('is_active', filters.active);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      const resp = await window.API.get(`/api/admin/products?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getProducts failed:', e.message);
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
      DebugLog.warn('[AdminAPI] getUnreviewedProducts failed:', e.message);
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
      DebugLog.warn('[AdminAPI] getProduct failed:', e.message);
      return null;
    }
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
        throw new Error(msg);
      }
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateProduct failed:', e.message);
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
      DebugLog.warn('[AdminAPI] getProductDiagnostics failed:', e.message);
      return null;
    }
  },

  async bulkActivate(data) {
    try {
      return await window.API.bulkActivateProducts(data);
    } catch (e) {
      DebugLog.warn('[AdminAPI] bulkActivate failed:', e.message);
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
      DebugLog.warn('[AdminAPI] getBrands failed:', e.message);
      return null;
    }
  },

  // ---- Analytics Overview (existing endpoint) ----
  async getAnalyticsOverview(timeRange = 30) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/overview?timeRange=${timeRange}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getAnalyticsOverview failed:', e.message);
      return null;
    }
  },

  // ---- Customer Intelligence (owner-only) ----
  async getCustomerLTV(sortBy = 'ltv', limit = 20) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/customer-ltv?sort_by=${sortBy}&limit=${limit}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getCustomerLTV failed:', e.message);
      return null;
    }
  },

  async getCAC(months = 6, channel = '') {
    try {
      const params = new URLSearchParams({ months });
      if (channel) params.set('channel', channel);
      const resp = await window.API.get(`/api/admin/analytics/cac?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getCAC failed:', e.message);
      return null;
    }
  },

  async getLTVCACRatio() {
    try {
      const resp = await window.API.get('/api/admin/analytics/ltv-cac-ratio');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getLTVCACRatio failed:', e.message);
      return null;
    }
  },

  async getCohorts(months = 6, metric = 'retention') {
    try {
      const resp = await window.API.get(`/api/admin/analytics/cohorts?months=${months}&metric=${metric}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getCohorts failed:', e.message);
      return null;
    }
  },

  async getChurn(includeAtRisk = true) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/churn?include_at_risk=${includeAtRisk}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getChurn failed:', e.message);
      return null;
    }
  },

  async getCustomerHealth(status = '', sortBy = 'score', limit = 20) {
    try {
      const params = new URLSearchParams({ sort_by: sortBy, limit });
      if (status) params.set('status', status);
      const resp = await window.API.get(`/api/admin/analytics/customer-health?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getCustomerHealth failed:', e.message);
      return null;
    }
  },

  async getNPS() {
    try {
      const resp = await window.API.get('/api/admin/analytics/nps');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getNPS failed:', e.message);
      return null;
    }
  },

  async getRepeatPurchase() {
    try {
      const resp = await window.API.get('/api/admin/analytics/repeat-purchase');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getRepeatPurchase failed:', e.message);
      return null;
    }
  },

  // ---- Financial Analytics (owner-only) ----
  async getPnL(startDate, endDate, granularity = 'monthly') {
    try {
      const params = new URLSearchParams({ granularity });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      const resp = await window.API.get(`/api/admin/analytics/pnl?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getPnL failed:', e.message);
      return null;
    }
  },

  async getCashflow(months = 6, projections = true) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/cashflow?months=${months}&projections=${projections}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getCashflow failed:', e.message);
      return null;
    }
  },

  async getBurnRunway() {
    try {
      const resp = await window.API.get('/api/admin/analytics/burn-runway');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getBurnRunway failed:', e.message);
      return null;
    }
  },

  async getDailyRevenue(days = 30) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/daily-revenue?days=${days}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getDailyRevenue failed:', e.message);
      return null;
    }
  },

  async getForecasts() {
    try {
      const resp = await window.API.get('/api/admin/analytics/forecasts');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getForecasts failed:', e.message);
      return null;
    }
  },

  async getExpenses(startDate, endDate, category = '', limit = 50) {
    try {
      const params = new URLSearchParams({ limit });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (category) params.set('category', category);
      const resp = await window.API.get(`/api/admin/analytics/expenses?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getExpenses failed:', e.message);
      return null;
    }
  },

  async createExpense(data) {
    try {
      const resp = await window.API.post('/api/admin/analytics/expenses', data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createExpense failed:', e.message);
      throw e;
    }
  },

  async getExpenseCategories() {
    try {
      const resp = await window.API.get('/api/admin/analytics/expense-categories');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getExpenseCategories failed:', e.message);
      return null;
    }
  },

  // ---- Marketing Analytics (owner-only) ----
  async getCampaigns(status = '', channel = '') {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (channel) params.set('channel', channel);
      const resp = await window.API.get(`/api/admin/analytics/campaigns?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getCampaigns failed:', e.message);
      return null;
    }
  },

  async createCampaign(data) {
    try {
      const resp = await window.API.post('/api/admin/analytics/campaigns', data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createCampaign failed:', e.message);
      throw e;
    }
  },

  async logMarketingSpend(data) {
    try {
      const resp = await window.API.post('/api/admin/analytics/marketing-spend', data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] logMarketingSpend failed:', e.message);
      throw e;
    }
  },

  async getChannelEfficiency() {
    try {
      const resp = await window.API.get('/api/admin/analytics/channel-efficiency');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getChannelEfficiency failed:', e.message);
      return null;
    }
  },

  async getConversionFunnel() {
    try {
      const resp = await window.API.get('/api/admin/analytics/conversion-funnel');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getConversionFunnel failed:', e.message);
      return null;
    }
  },

  // ---- Operations Analytics (owner-only) ----
  async getInventoryTurnover(sortBy = 'turnover', limit = 20) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/inventory-turnover?sort_by=${sortBy}&limit=${limit}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getInventoryTurnover failed:', e.message);
      return null;
    }
  },

  async getDeadStock(daysThreshold = 90, minValue = 0) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/dead-stock?days_threshold=${daysThreshold}&min_value=${minValue}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getDeadStock failed:', e.message);
      return null;
    }
  },

  async getStockVelocity(limit = 20, sortBy = 'velocity') {
    try {
      const resp = await window.API.get(`/api/admin/analytics/stock-velocity?limit=${limit}&sort_by=${sortBy}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getStockVelocity failed:', e.message);
      return null;
    }
  },

  async getInventoryCashLockup() {
    try {
      const resp = await window.API.get('/api/admin/analytics/inventory-cash-lockup');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getInventoryCashLockup failed:', e.message);
      return null;
    }
  },

  async getProductPerformance(sortBy = 'revenue', limit = 20, includeUnprofitable = false) {
    try {
      const resp = await window.API.get(`/api/admin/analytics/product-performance?sort_by=${sortBy}&limit=${limit}&include_unprofitable=${includeUnprofitable}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getProductPerformance failed:', e.message);
      return null;
    }
  },

  async getPageRevenue() {
    try {
      const resp = await window.API.get('/api/admin/analytics/page-revenue');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getPageRevenue failed:', e.message);
      return null;
    }
  },

  // ---- Alerts ----
  async getAlerts(severity = '', acknowledged = '') {
    try {
      const params = new URLSearchParams();
      if (severity) params.set('severity', severity);
      if (acknowledged !== '') params.set('acknowledged', acknowledged);
      const resp = await window.API.get(`/api/admin/analytics/alerts?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getAlerts failed:', e.message);
      return null;
    }
  },

  async acknowledgeAlert(alertId) {
    try {
      const resp = await window.API.put(`/api/admin/analytics/alerts/${alertId}/acknowledge`, {});
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] acknowledgeAlert failed:', e.message);
      throw e;
    }
  },

  async getAlertThresholds() {
    try {
      const resp = await window.API.get('/api/admin/analytics/alert-thresholds');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getAlertThresholds failed:', e.message);
      return null;
    }
  },

  async updateAlertThreshold(id, data) {
    try {
      const resp = await window.API.put(`/api/admin/analytics/alert-thresholds/${id}`, data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateAlertThreshold failed:', e.message);
      throw e;
    }
  },

  // ---- Shipping Rates (admin CRUD) ----
  async getShippingRates(filters = {}, page = 1, limit = 50) {
    try {
      const params = new URLSearchParams();
      params.set('page', page);
      params.set('limit', limit);
      if (filters.zone) params.set('zone', filters.zone);
      if (filters.delivery_type) params.set('delivery_type', filters.delivery_type);
      if (filters.is_active !== undefined) params.set('is_active', filters.is_active);
      const resp = await window.API.get(`/api/admin/shipping/rates?${params}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getShippingRates failed:', e.message);
      return null;
    }
  },

  async getShippingRate(rateId) {
    try {
      const resp = await window.API.get(`/api/admin/shipping/rates/${rateId}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getShippingRate failed:', e.message);
      return null;
    }
  },

  async createShippingRate(data) {
    try {
      const resp = await window.API.post('/api/admin/shipping/rates', data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] createShippingRate failed:', e.message);
      throw e;
    }
  },

  async updateShippingRate(rateId, data) {
    try {
      const resp = await window.API.put(`/api/admin/shipping/rates/${rateId}`, data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateShippingRate failed:', e.message);
      throw e;
    }
  },

  async deleteShippingRate(rateId) {
    try {
      const resp = await window.API.delete(`/api/admin/shipping/rates/${rateId}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] deleteShippingRate failed:', e.message);
      throw e;
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
      DebugLog.warn('[AdminAPI] getAdminRibbons failed:', e.message);
      return null;
    }
  },

  async getAdminRibbon(ribbonId) {
    try {
      const resp = await window.API.get(`/api/admin/ribbons/${ribbonId}`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getAdminRibbon failed:', e.message);
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

  // ---- Contact Emails ----
  async getContactEmails() {
    try {
      const resp = await window.API.get('/api/admin/contact-emails');
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] getContactEmails failed:', e.message);
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
      return true;
    } catch (e) {
      DebugLog.warn(`[AdminAPI] exportData(${type}, ${format}) failed:`, e.message);
      throw e;
    }
  },
};

export { AdminAPI };
