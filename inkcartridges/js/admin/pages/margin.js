/**
 * Margin Analysis Page — Pricing health, cost changes, profit analysis
 */
import { AdminAuth, AdminAPI, esc } from '../app.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

function marginBadge(pct) {
  if (pct == null) return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  const num = Number(pct);
  if (num < 15) return `<span class="margin-badge margin-badge--low" title="Low Margin">\u26A0 ${num.toFixed(1)}%</span>`;
  if (num <= 30) return `<span class="margin-badge margin-badge--healthy" title="Healthy">\u2713 ${num.toFixed(1)}%</span>`;
  return `<span class="margin-badge margin-badge--high" title="High Profit">\u2197 ${num.toFixed(1)}%</span>`;
}

function changeBadge(pct) {
  if (pct == null) return MISSING;
  const num = Number(pct);
  if (num > 0) return `<span style="color:#ef4444;font-weight:600">\u2191 +${num.toFixed(1)}%</span>`;
  if (num < 0) return `<span style="color:#22c55e;font-weight:600">\u2193 ${num.toFixed(1)}%</span>`;
  return `<span style="color:#6b7280">0%</span>`;
}

let _container = null;
let _currentTab = 'overview';

function renderShell() {
  _container.innerHTML = `
    <div class="admin-page-header">
      <h1 class="admin-page-title">Margin Analysis</h1>
      <p class="admin-page-subtitle">Pricing health, supplier cost changes, and profit analysis</p>
    </div>
    <div class="admin-tabs margin-tabs" style="margin-bottom:1.5rem">
      <button class="admin-tab active" data-tab="overview">Overview</button>
      <button class="admin-tab" data-tab="recommended">Recommended Prices</button>
      <button class="admin-tab" data-tab="changes">Cost Changes</button>
      <button class="admin-tab" data-tab="oos">Out of Stock</button>
      <button class="admin-tab" data-tab="profit">Top Profit</button>
    </div>
    <div id="margin-content" class="margin-content">
      <div class="admin-loading">Loading margin data...</div>
    </div>
    <style>
      .margin-tabs { display:flex; gap:0.25rem; border-bottom:1px solid var(--admin-border,#e5e7eb); padding-bottom:0; overflow-x:auto }
      .admin-tab { padding:0.5rem 1rem; border:none; background:none; cursor:pointer; font-size:0.875rem; color:var(--admin-text-muted,#6b7280); border-bottom:2px solid transparent; white-space:nowrap }
      .admin-tab:hover { color:var(--admin-text,#111827) }
      .admin-tab.active { color:var(--admin-primary,#2563eb); border-bottom-color:var(--admin-primary,#2563eb); font-weight:600 }
      .margin-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; margin-bottom:1.5rem }
      .margin-card { background:var(--admin-surface,#fff); border:1px solid var(--admin-border,#e5e7eb); border-radius:0.75rem; padding:1.25rem }
      .margin-card__label { font-size:0.75rem; color:var(--admin-text-muted,#6b7280); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:0.25rem }
      .margin-card__value { font-size:1.75rem; font-weight:700; color:var(--admin-text,#111827) }
      .margin-card__sub { font-size:0.8rem; color:var(--admin-text-muted,#6b7280); margin-top:0.25rem }
      .margin-badge { padding:0.2rem 0.5rem; border-radius:0.375rem; font-size:0.8rem; font-weight:600 }
      .margin-badge--low { background:#fef2f2; color:#ef4444 }
      .margin-badge--healthy { background:#f0fdf4; color:#22c55e }
      .margin-badge--high { background:#eff6ff; color:#3b82f6 }
      .margin-badge--unknown { background:#f3f4f6; color:#6b7280 }
      .margin-table { width:100%; border-collapse:collapse; font-size:0.875rem }
      .margin-table th { text-align:left; padding:0.75rem; border-bottom:2px solid var(--admin-border,#e5e7eb); font-weight:600; color:var(--admin-text-muted,#6b7280); font-size:0.75rem; text-transform:uppercase }
      .margin-table td { padding:0.75rem; border-bottom:1px solid var(--admin-border,#e5e7eb) }
      .margin-table tr:hover { background:var(--admin-hover,#f9fafb) }
      .margin-table__actions button { padding:0.25rem 0.75rem; border:1px solid var(--admin-primary,#2563eb); background:none; color:var(--admin-primary,#2563eb); border-radius:0.375rem; cursor:pointer; font-size:0.8rem }
      .margin-table__actions button:hover { background:var(--admin-primary,#2563eb); color:#fff }
      .margin-empty { text-align:center; padding:3rem; color:var(--admin-text-muted,#6b7280) }
      .margin-source-badge { padding:0.15rem 0.4rem; border-radius:0.25rem; font-size:0.75rem; font-weight:500 }
      .margin-source-badge--genuine { background:#dbeafe; color:#1d4ed8 }
      .margin-source-badge--compatible { background:#fce7f3; color:#be185d }
    </style>
  `;

  _container.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _container.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _currentTab = tab.dataset.tab;
      loadTab(_currentTab);
    });
  });
}

async function loadTab(tab) {
  const content = document.getElementById('margin-content');
  if (!content) return;
  content.innerHTML = '<div class="admin-loading">Loading...</div>';

  switch (tab) {
    case 'overview': return loadOverview(content);
    case 'recommended': return loadRecommended(content);
    case 'changes': return loadChanges(content);
    case 'oos': return loadOutOfStock(content);
    case 'profit': return loadTopProfit(content);
  }
}

async function loadOverview(el) {
  const data = await AdminAPI.getMarginSummary({ days: 30 });
  if (!data?.ok) { el.innerHTML = '<div class="margin-empty">Failed to load margin summary.</div>'; return; }
  const d = data.data;
  const avgG = d.average_margin_by_source?.genuine;
  const avgC = d.average_margin_by_source?.compatible;

  el.innerHTML = `
    <div class="margin-cards">
      <div class="margin-card">
        <div class="margin-card__label">Price Changes (30d)</div>
        <div class="margin-card__value">${d.price_changes_count ?? MISSING}</div>
        <div class="margin-card__sub">Supplier cost changes detected</div>
      </div>
      <div class="margin-card">
        <div class="margin-card__label">Underpriced Products</div>
        <div class="margin-card__value" style="color:${(d.underpriced_count || 0) > 0 ? '#ef4444' : 'inherit'}">${d.underpriced_count ?? MISSING}</div>
        <div class="margin-card__sub">Below 30% target margin</div>
      </div>
      <div class="margin-card">
        <div class="margin-card__label">Out of Stock (Genuine)</div>
        <div class="margin-card__value">${d.out_of_stock_count ?? MISSING}</div>
        <div class="margin-card__sub">Zero stock from supplier</div>
      </div>
      <div class="margin-card">
        <div class="margin-card__label">Active Products</div>
        <div class="margin-card__value">${d.total_active_products ?? MISSING}</div>
      </div>
    </div>
    <div class="margin-cards" style="grid-template-columns:repeat(2,1fr)">
      <div class="margin-card">
        <div class="margin-card__label">Avg Genuine Margin</div>
        <div class="margin-card__value">${avgG != null ? marginBadge(avgG) : MISSING}</div>
      </div>
      <div class="margin-card">
        <div class="margin-card__label">Avg Compatible Margin</div>
        <div class="margin-card__value">${avgC != null ? marginBadge(avgC) : MISSING}</div>
      </div>
    </div>
    ${d.top_profit_products?.length ? `
      <h3 style="margin:1.5rem 0 0.75rem;font-size:1rem">Top Profit Products</h3>
      <table class="margin-table">
        <thead><tr>
          <th>SKU</th><th>Source</th><th>Cost</th><th>Retail</th><th>Profit (ex GST)</th><th>Margin</th>
        </tr></thead>
        <tbody>
          ${d.top_profit_products.map(p => `<tr>
            <td>${esc(p.sku || p.product_id)}</td>
            <td><span class="margin-source-badge margin-source-badge--${esc(p.source)}">${esc(p.source)}</span></td>
            <td>${formatPrice(p.cost_price)}</td>
            <td>${formatPrice(p.retail_price)}</td>
            <td>${formatPrice(p.profit_ex_gst)}</td>
            <td>${marginBadge(p.margin_pct)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    ` : ''}
  `;
}

async function loadRecommended(el) {
  const data = await AdminAPI.getRecommendedPrices({ target_margin: 30, limit: 50 });
  if (!data?.ok) { el.innerHTML = '<div class="margin-empty">Failed to load recommended prices.</div>'; return; }
  const items = data.data?.recommended_prices || [];
  if (!items.length) { el.innerHTML = '<div class="margin-empty">All products meet the 30% target margin.</div>'; return; }

  el.innerHTML = `
    <table class="margin-table">
      <thead><tr>
        <th>SKU</th><th>Name</th><th>Source</th><th>Current</th><th>Recommended</th><th>Current Margin</th><th>Gap</th><th>Action</th>
      </tr></thead>
      <tbody>
        ${items.map(p => `<tr data-product-id="${esc(p.product_id)}">
          <td>${esc(p.sku)}</td>
          <td title="${esc(p.name)}">${esc((p.name || '').substring(0, 40))}${(p.name || '').length > 40 ? '...' : ''}</td>
          <td><span class="margin-source-badge margin-source-badge--${esc(p.source)}">${esc(p.source)}</span></td>
          <td>${formatPrice(p.current_retail)}</td>
          <td style="font-weight:600">${formatPrice(p.recommended_retail)}</td>
          <td>${marginBadge(p.current_margin_pct)}</td>
          <td style="color:${(p.gap || 0) > 0 ? '#ef4444' : '#22c55e'};font-weight:600">${p.gap > 0 ? '+' : ''}${(p.gap || 0).toFixed(1)}%</td>
          <td class="margin-table__actions">
            <button data-action="update-price" data-id="${esc(p.product_id)}" data-price="${p.recommended_retail}">Apply</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;

  el.querySelectorAll('[data-action="update-price"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const price = parseFloat(btn.dataset.price);
      btn.disabled = true;
      btn.textContent = 'Updating...';
      try {
        await window.API._fetchWithAuth(`/api/admin/products/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ retail_price: price })
        });
        btn.textContent = 'Done';
        btn.style.background = '#22c55e';
        btn.style.color = '#fff';
        btn.style.borderColor = '#22c55e';
        if (typeof Toast !== 'undefined') Toast.success('Price updated');
      } catch (e) {
        btn.textContent = 'Error';
        btn.disabled = false;
        if (typeof Toast !== 'undefined') Toast.error('Failed to update price');
      }
    });
  });
}

async function loadChanges(el) {
  const data = await AdminAPI.getPriceChanges({ lookback_days: 30, min_change_pct: 5, limit: 50 });
  if (!data?.ok) { el.innerHTML = '<div class="margin-empty">Failed to load price changes.</div>'; return; }
  const items = data.data?.price_changes || [];
  if (!items.length) { el.innerHTML = '<div class="margin-empty">No significant cost changes in the last 30 days.</div>'; return; }

  el.innerHTML = `
    <table class="margin-table">
      <thead><tr>
        <th>SKU</th><th>Name</th><th>Source</th><th>Previous Cost</th><th>Current Cost</th><th>Change</th><th>Current Margin</th><th>Detected</th>
      </tr></thead>
      <tbody>
        ${items.map(p => `<tr>
          <td>${esc(p.sku)}</td>
          <td title="${esc(p.name)}">${esc((p.name || '').substring(0, 40))}${(p.name || '').length > 40 ? '...' : ''}</td>
          <td><span class="margin-source-badge margin-source-badge--${esc(p.source)}">${esc(p.source)}</span></td>
          <td>${formatPrice(p.previous_cost)}</td>
          <td>${formatPrice(p.current_cost)}</td>
          <td>${changeBadge(p.change_pct)}</td>
          <td>${marginBadge(p.current_margin_pct)}</td>
          <td>${p.detected_at ? new Date(p.detected_at).toLocaleDateString('en-NZ') : MISSING}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

async function loadOutOfStock(el) {
  const data = await AdminAPI.getOutOfStock({ limit: 50 });
  if (!data?.ok) { el.innerHTML = '<div class="margin-empty">Failed to load out-of-stock data.</div>'; return; }
  const items = data.data?.out_of_stock || [];
  const total = data.data?.total_genuine_products || 0;

  if (!items.length) {
    el.innerHTML = `<div class="margin-empty">All genuine products are in stock. (${total} total genuine)</div>`;
    return;
  }

  el.innerHTML = `
    <div class="margin-cards" style="grid-template-columns:repeat(2,1fr);margin-bottom:1.5rem">
      <div class="margin-card">
        <div class="margin-card__label">Out of Stock</div>
        <div class="margin-card__value" style="color:#ef4444">${data.data.total_out_of_stock || items.length}</div>
      </div>
      <div class="margin-card">
        <div class="margin-card__label">Total Genuine Products</div>
        <div class="margin-card__value">${total}</div>
      </div>
    </div>
    <table class="margin-table">
      <thead><tr>
        <th>SKU</th><th>Name</th><th>Brand</th><th>Type</th><th>Cost</th><th>Retail</th>
      </tr></thead>
      <tbody>
        ${items.map(p => `<tr>
          <td>${esc(p.sku)}</td>
          <td title="${esc(p.name)}">${esc((p.name || '').substring(0, 50))}${(p.name || '').length > 50 ? '...' : ''}</td>
          <td>${esc(p.brand || '')}</td>
          <td>${esc(p.product_type || '')}</td>
          <td>${formatPrice(p.cost_price)}</td>
          <td>${formatPrice(p.retail_price)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

async function loadTopProfit(el) {
  const data = await AdminAPI.getTopProfit({ metric: 'absolute_profit', limit: 20 });
  if (!data?.ok) { el.innerHTML = '<div class="margin-empty">Failed to load top profit data.</div>'; return; }
  const items = data.data?.top_products || [];
  if (!items.length) { el.innerHTML = '<div class="margin-empty">No profit data available.</div>'; return; }

  el.innerHTML = `
    <div class="margin-cards" style="margin-bottom:1.5rem">
      <div class="margin-card">
        <div class="margin-card__label">Products Evaluated</div>
        <div class="margin-card__value">${data.data.total_evaluated || MISSING}</div>
      </div>
      <div class="margin-card">
        <div class="margin-card__label">Ranked By</div>
        <div class="margin-card__value" style="font-size:1rem">${esc(data.data.metric === 'margin_pct' ? 'Margin %' : 'Absolute Profit')}</div>
      </div>
    </div>
    <table class="margin-table">
      <thead><tr>
        <th>SKU</th><th>Name</th><th>Source</th><th>Cost</th><th>Retail</th><th>Profit (ex GST)</th><th>Margin</th>
      </tr></thead>
      <tbody>
        ${items.map(p => `<tr>
          <td>${esc(p.sku)}</td>
          <td title="${esc(p.name)}">${esc((p.name || '').substring(0, 40))}${(p.name || '').length > 40 ? '...' : ''}</td>
          <td><span class="margin-source-badge margin-source-badge--${esc(p.source)}">${esc(p.source)}</span></td>
          <td>${formatPrice(p.cost_price)}</td>
          <td>${formatPrice(p.retail_price)}</td>
          <td style="font-weight:600;color:#22c55e">${formatPrice(p.profit_ex_gst)}</td>
          <td>${marginBadge(p.margin_pct)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

export default {
  title: 'Margin Analysis',

  async init(container) {
    if (!AdminAuth.isOwner()) {
      container.innerHTML = '<div class="margin-empty">Margin analysis is only available to owners.</div>';
      return;
    }
    _container = container;
    _currentTab = 'overview';
    renderShell();
    await loadTab('overview');
  },

  destroy() { _container = null; },
  onSearch() {},
  onFilterChange() { loadTab(_currentTab); }
};
