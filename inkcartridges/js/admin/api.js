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

  async getCustomerStats(filterParams, signal) {
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_customer_stats', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
    }, signal);
  },

  async getTopProducts(filterParams, signal) {
    const { from, to } = Object.fromEntries(filterParams);
    return rpc('analytics_top_products', {
      date_from: from, date_to: to,
      brand_filter: filterParams.get('brands') || null,
      result_limit: 10,
    }, signal);
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
      if (filters.active !== undefined) params.set('is_active', filters.active);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
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
