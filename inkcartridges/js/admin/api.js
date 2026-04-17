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
      if (filters.active !== undefined && filters.active !== '') params.set('is_active', filters.active);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.order) params.set('order', filters.order);
      if (filters.source) params.set('source', filters.source);
      if (filters.product_type) params.set('product_type', filters.product_type);
      if (filters.category) params.set('category', filters.category);
      if (filters.has_images !== undefined && filters.has_images !== '') params.set('has_images', filters.has_images);
      if (filters.stock_status) params.set('stock_status', filters.stock_status);
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
      return resp?.data ?? resp;
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

  // ---- Ribbon Brands (Supabase direct) ----
  _sb() {
    return (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
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

  // ---- B2B Management ----
  async getBusinessApplications(filters = {}, page = 1, limit = 20) {
    try {
      const qs = new URLSearchParams({ page, limit });
      if (filters.status) qs.set('status', filters.status);
      if (filters.search) qs.set('search', filters.search);
      const resp = await window.API.get(`/api/admin/business/applications?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('B2B applications', e); return null; }
  },

  async getBusinessApplication(id) {
    try {
      const resp = await window.API.get(`/api/admin/business/applications/${encodeURIComponent(id)}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('B2B application detail', e); return null; }
  },

  async approveBusinessApplication(id, settings = {}) {
    try {
      const resp = await window.API.post(`/api/admin/business/applications/${encodeURIComponent(id)}/approve`, settings);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] approveBusinessApplication failed:', e.message);
      throw e;
    }
  },

  async declineBusinessApplication(id, reason = '') {
    try {
      const resp = await window.API.post(`/api/admin/business/applications/${encodeURIComponent(id)}/decline`, { reason });
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] declineBusinessApplication failed:', e.message);
      throw e;
    }
  },

  async updateBusinessSettings(id, settings) {
    try {
      const resp = await window.API.put(`/api/admin/business/accounts/${encodeURIComponent(id)}`, settings);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] updateBusinessSettings failed:', e.message);
      throw e;
    }
  },

  async getBusinessInvoicesAdmin(filters = {}, page = 1, limit = 20) {
    try {
      const qs = new URLSearchParams({ page, limit });
      if (filters.status) qs.set('status', filters.status);
      if (filters.company) qs.set('company', filters.company);
      if (filters.from) qs.set('from', filters.from);
      if (filters.to) qs.set('to', filters.to);
      const resp = await window.API.get(`/api/admin/business/invoices?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('B2B invoices', e); return null; }
  },

  async generateInvoicePdf(invoiceId) {
    try {
      const resp = await window.API.post(`/api/admin/business/invoices/${encodeURIComponent(invoiceId)}/generate-pdf`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] generateInvoicePdf failed:', e.message);
      throw e;
    }
  },

  async sendInvoiceEmail(invoiceId) {
    try {
      const resp = await window.API.post(`/api/admin/business/invoices/${encodeURIComponent(invoiceId)}/send-email`);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] sendInvoiceEmail failed:', e.message);
      throw e;
    }
  },

  async recordInvoicePayment(invoiceId, data = {}) {
    try {
      const resp = await window.API.post(`/api/admin/business/invoices/${encodeURIComponent(invoiceId)}/record-payment`, data);
      return resp?.data ?? null;
    } catch (e) {
      DebugLog.warn('[AdminAPI] recordInvoicePayment failed:', e.message);
      throw e;
    }
  },

  async getBusinessPendingCount() {
    try {
      const resp = await window.API.get('/api/admin/business/applications?status=pending&limit=1');
      return resp?.data?.total ?? 0;
    } catch (e) { return 0; }
  },

  async getBusinessStats() {
    try {
      const resp = await window.API.get('/api/admin/business/stats');
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('B2B stats', e); return null; }
  },

  async getBusinessAccounts(filters = {}, page = 1, limit = 20) {
    try {
      const qs = new URLSearchParams({ page, limit });
      if (filters.search) qs.set('search', filters.search);
      if (filters.status) qs.set('status', filters.status);
      const resp = await window.API.get(`/api/admin/business/accounts?${qs}`);
      return resp?.data ?? null;
    } catch (e) { adminApiWarn('B2B accounts', e); return null; }
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
};

export { AdminAPI };
