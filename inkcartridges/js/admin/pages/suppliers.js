/**
 * Suppliers Page — Supplier directory with product counts
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';

const MISSING = '\u2014';

let _container = null;

async function loadSuppliers() {
  _container.innerHTML = `
    <div class="admin-page-header"><h1>Suppliers</h1></div>
    <div style="display:flex;align-items:center;justify-content:center;min-height:20vh"><div class="admin-loading__spinner"></div></div>
  `;

  const [suppliersRes, productsRes] = await Promise.allSettled([
    AdminAPI.getSuppliers(),
    AdminAPI.getProducts({}, 1, 200),
  ]);
  if (!_container) return; // destroyed during await

  const suppliers = suppliersRes.value;
  const productsData = productsRes.value;
  const products = productsData ? (Array.isArray(productsData) ? productsData : (productsData.products || productsData.data || [])) : [];

  // Count products per supplier
  const supplierCounts = {};
  for (const p of products) {
    const s = p.supplier || p.supplier_name || '';
    if (s) supplierCounts[s] = (supplierCounts[s] || 0) + 1;
  }

  const supplierList = suppliers && Array.isArray(suppliers) ? suppliers : [];

  let html = `<div class="admin-page-header"><h1>Suppliers</h1></div>`;

  if (!supplierList.length) {
    html += `<div class="admin-card"><div class="admin-empty"><div class="admin-empty__icon">${icon('suppliers', 40, 40)}</div><div class="admin-empty__title">No suppliers found</div><div class="admin-empty__text">Supplier data will appear once the backend endpoint is available.</div></div></div>`;
    _container.innerHTML = html;
    return;
  }

  html += `<div class="admin-supplier-grid">`;
  for (const s of supplierList) {
    const name = typeof s === 'string' ? s : s.name || s.supplier_name || 'Unknown';
    const id = typeof s === 'object' ? (s.id || name) : name;
    const count = supplierCounts[name] || (typeof s === 'object' ? (s.product_count || 0) : 0);
    const contact = typeof s === 'object' ? (s.contact_email || s.email || '') : '';
    const status = typeof s === 'object' ? (s.status || s.feed_status || '') : '';

    html += `<div class="admin-supplier-card" data-supplier="${esc(name)}">`;
    html += `<div class="admin-supplier-card__icon">${icon('suppliers', 24, 24)}</div>`;
    html += `<div class="admin-supplier-card__name">${esc(name)}</div>`;
    html += `<div class="admin-supplier-card__count">${count} product${count !== 1 ? 's' : ''}</div>`;
    if (contact) html += `<div class="admin-supplier-card__contact">${esc(contact)}</div>`;
    if (status) {
      const statusClass = status === 'active' ? 'completed' : status === 'error' ? 'failed' : 'pending';
      html += `<span class="admin-badge admin-badge--${statusClass}" style="margin-top:8px">${esc(status)}</span>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  _container.innerHTML = html;

  // Click handler to navigate to products filtered by supplier
  _container.querySelectorAll('[data-supplier]').forEach(card => {
    card.addEventListener('click', () => {
      const supplierName = card.dataset.supplier;
      openSupplierDrawer(supplierName, products.filter(p => (p.supplier || p.supplier_name || '') === supplierName));
    });
  });
}

function openSupplierDrawer(supplierName, supplierProducts) {
  const drawer = Drawer.open({
    title: esc(supplierName),
    width: '500px',
  });
  if (!drawer) return;

  let html = '';
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Products (${supplierProducts.length})</div>`;
  if (supplierProducts.length) {
    html += `<table class="admin-order-items"><thead><tr><th>Name</th><th>SKU</th><th class="cell-right">Price</th><th class="cell-center">Stock</th></tr></thead><tbody>`;
    for (const p of supplierProducts.slice(0, 30)) {
      const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
      html += `<tr>`;
      html += `<td class="cell-truncate">${esc(p.name || MISSING)}</td>`;
      html += `<td class="mono">${esc(p.sku || MISSING)}</td>`;
      html += `<td class="cell-right mono">${p.retail_price != null ? formatPrice(p.retail_price) : MISSING}</td>`;
      html += `<td class="cell-center mono">${p.stock_quantity ?? MISSING}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<p class="admin-text-muted">No products from this supplier</p>`;
  }
  html += `</div>`;

  html += `<div style="padding-top:12px"><a href="#products" class="admin-btn admin-btn--ghost admin-btn--sm">View in Products &rarr;</a></div>`;

  drawer.setBody(html);
}

export default {
  title: 'Suppliers',

  async init(container) {
    _container = container;
    await loadSuppliers();
  },

  destroy() {
    _container = null;
  },

  async onFilterChange() {
    if (_container) await loadSuppliers();
  },
};
