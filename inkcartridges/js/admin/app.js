/**
 * Admin SPA — Entry point, router, shell
 */
import { AdminAuth } from './auth.js';
import { FilterState } from './filters.js';
import { AdminAPI } from './api.js';

const esc = (s) => Security.escapeHtml(String(s));

// ---- Icons (inline SVG paths, 24x24 viewBox) ----
const I = {
  dashboard: '<path d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10-2a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6z"/>',
  orders: '<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>',
  customers: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87m-4-12a4 4 0 010 7.75"/>',
  products: '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  suppliers: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  refunds: '<path d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>',
  fulfillment: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  analytics: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  lab: '<path d="M9 3v7.2L4.8 18.4A2 2 0 006.5 21h11a2 2 0 001.7-2.6L15 10.2V3"/><path d="M7 3h10M9 14h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  moon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
};

function icon(name, w = 18, h = 18) {
  return `<svg viewBox="0 0 24 24" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[name] || ''}</svg>`;
}

// ---- Navigation config ----
const NAV_ITEMS = [
  { section: 'Main' },
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { key: 'orders', label: 'Orders', icon: 'orders' },
  { key: 'customers', label: 'Customers', icon: 'customers' },
  { section: 'Catalog' },
  { key: 'products', label: 'Products & SKUs', icon: 'products' },
  { key: 'product-review', label: 'Product Review', icon: 'orders' },
  { key: 'ribbons', label: 'Ribbons', icon: 'products' },
  { key: 'suppliers', label: 'Suppliers', icon: 'suppliers' },
  { section: 'Operations' },
  { key: 'refunds', label: 'Refunds & Chargebacks', icon: 'refunds' },
  { key: 'fulfillment', label: 'Fulfillment', icon: 'fulfillment' },
  { key: 'shipping', label: 'Shipping Rates', icon: 'suppliers' },
  { divider: true },
  { key: 'analytics', label: 'Analytics', icon: 'analytics', ownerOnly: true },
  { key: 'settings', label: 'Settings', icon: 'settings', ownerOnly: true },
  { key: 'contact-emails', label: 'Contact Emails', icon: 'mail', ownerOnly: true },
  { key: 'lab', label: 'Lab', icon: 'lab', ownerOnly: true },
];

// ---- Page module cache ----
const _pages = {};
async function loadPage(name) {
  if (_pages[name]) return _pages[name];
  try {
    const mod = await import(`./pages/${name}.js`);
    _pages[name] = mod.default;
    return mod.default;
  } catch (e) {
    DebugLog.error(`[Router] Failed to load page: ${name}`, e);
    return null;
  }
}

// ---- App State ----
let _currentPage = null;
let _currentPageName = null;

// ---- Shell Rendering ----
function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isOwner = AdminAuth.isOwner();

  let html = `
    <a class="admin-sidebar__brand" href="#dashboard">
      <div class="admin-sidebar__logo">${icon('products', 18, 18)}</div>
      <div>
        <div class="admin-sidebar__title">InkCartridges</div>
        <div class="admin-sidebar__subtitle">Admin Panel</div>
      </div>
    </a>
    <nav class="admin-sidebar__nav">
  `;

  for (const item of NAV_ITEMS) {
    if (item.ownerOnly && !isOwner) continue;
    if (item.divider) {
      html += '<div class="admin-nav-divider"></div>';
      continue;
    }
    if (item.section) {
      html += `<div class="admin-nav-section"><div class="admin-nav-section__label">${esc(item.section)}</div></div>`;
      continue;
    }
    html += `
      <div class="admin-nav-section">
        <a href="#${item.key}" class="admin-nav-item" data-nav="${item.key}">
          ${icon(item.icon)}
          <span>${esc(item.label)}</span>
        </a>
      </div>
    `;
  }

  html += `
    </nav>
    <div class="admin-sidebar__footer">
      <div class="admin-user-card" id="user-card">
        <div class="admin-avatar">${esc(AdminAuth.getInitials())}</div>
        <div class="admin-user-card__info">
          <div class="admin-user-card__name">${esc(AdminAuth.getDisplayName())}</div>
          <div class="admin-user-card__role">${esc(AdminAuth.getRoleLabel())}</div>
        </div>
      </div>
    </div>
  `;

  sidebar.innerHTML = html;

  // Back to store on user card click
  document.getElementById('user-card').addEventListener('click', () => {
    window.location.href = '/html/';
  });
}

function renderTopbar() {
  const topbar = document.getElementById('topbar');
  const isDark = document.body.dataset.theme !== 'light';

  topbar.innerHTML = `
    <button class="admin-topbar__hamburger" id="menu-toggle" aria-label="Toggle menu">
      ${icon('menu', 20, 20)}
    </button>
    <div class="admin-topbar__search">
      ${icon('search', 16, 16)}
      <input type="search" placeholder="Search orders, customers, SKUs\u2026" id="global-search" autocomplete="off">
      <kbd>/</kbd>
    </div>
    <div class="admin-topbar__spacer"></div>
    <div class="admin-topbar__actions">
      <button class="admin-topbar__btn" id="theme-toggle" aria-label="Toggle theme" data-tooltip="${isDark ? 'Light mode' : 'Dark mode'}">
        ${isDark ? icon('sun') : icon('moon')}
      </button>
      <button class="admin-topbar__btn" id="logout-btn" aria-label="Back to store" data-tooltip="Back to store">
        ${icon('logout')}
      </button>
    </div>
  `;

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Mobile menu
  document.getElementById('menu-toggle').addEventListener('click', toggleSidebar);

  // Sidebar backdrop
  document.getElementById('sidebar-backdrop').addEventListener('click', toggleSidebar);

  // Back to store
  document.getElementById('logout-btn').addEventListener('click', () => {
    window.location.href = '/html/';
  });

  // Global search — dispatches to current page
  const globalSearch = document.getElementById('global-search');
  let globalSearchTimer;
  globalSearch.addEventListener('input', () => {
    clearTimeout(globalSearchTimer);
    globalSearchTimer = setTimeout(() => {
      const query = globalSearch.value.trim();
      if (_currentPage && _currentPage.onSearch) {
        _currentPage.onSearch(query);
      }
    }, 250);
  });
  globalSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { globalSearch.value = ''; globalSearch.blur(); if (_currentPage?.onSearch) _currentPage.onSearch(''); }
  });

  // Search focus shortcut
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      document.getElementById('global-search')?.focus();
    }
  });
}

function toggleTheme() {
  const body = document.body;
  const isDark = body.dataset.theme !== 'light';
  body.dataset.theme = isDark ? 'light' : 'dark';
  localStorage.setItem('admin-theme', body.dataset.theme);
  // Re-render toggle icon
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const nowDark = body.dataset.theme !== 'light';
    btn.innerHTML = nowDark ? icon('sun') : icon('moon');
    btn.dataset.tooltip = nowDark ? 'Light mode' : 'Dark mode';
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('open');
  backdrop.classList.toggle('open');
}

// ---- Router ----
function getRouteFromHash() {
  const hash = window.location.hash.replace('#', '').split('?')[0];
  return hash || 'dashboard';
}

async function navigate(pageName) {
  // Clear global search on navigation
  const gs = document.getElementById('global-search');
  if (gs) gs.value = '';

  // Destroy current page
  if (_currentPage && _currentPage.destroy) {
    _currentPage.destroy();
  }

  // Update nav active state
  document.querySelectorAll('.admin-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === pageName);
  });

  // Close mobile sidebar
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-backdrop')?.classList.remove('open');

  // Show loading in content
  const content = document.getElementById('main-content');
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:40vh">
      <div class="admin-loading__spinner"></div>
    </div>
  `;

  // Owner-only page check
  const ownerPages = ['analytics', 'settings', 'contact-emails', 'lab'];
  if (ownerPages.includes(pageName) && !AdminAuth.isOwner()) {
    content.innerHTML = `
      <div class="admin-stub">
        <div class="admin-stub__title">Access Restricted</div>
        <div class="admin-stub__text">This page is available to account owners only.</div>
      </div>
    `;
    _currentPage = null;
    _currentPageName = null;
    return;
  }

  // Load page module
  const page = await loadPage(pageName);
  if (!page) {
    content.innerHTML = `
      <div class="admin-stub">
        <div class="admin-stub__title">Page Not Found</div>
        <div class="admin-stub__text">The page "${esc(pageName)}" could not be loaded.</div>
      </div>
    `;
    _currentPage = null;
    _currentPageName = null;
    return;
  }

  // Update title
  document.title = `${page.title || pageName} | Admin | InkCartridges.co.nz`;

  // Init page
  content.innerHTML = '';
  _currentPage = page;
  _currentPageName = pageName;

  try {
    await page.init(content);
  } catch (e) {
    DebugLog.error(`[Router] Page init error (${pageName}):`, e);
    content.innerHTML = `
      <div class="admin-stub">
        <div class="admin-stub__title">Error Loading Page</div>
        <div class="admin-stub__text">${esc(e.message)}</div>
      </div>
    `;
  }
}

// ---- Review badge ----
async function updateReviewBadge(count) {
  try {
    if (count === undefined) {
      const data = await AdminAPI.getUnreviewedProducts({}, 1, 1);
      count = data?.pagination?.total ?? data?.total ?? 0;
    }
    const navItem = document.querySelector('[data-nav="product-review"]');
    if (!navItem) return;
    const existing = navItem.querySelector('.admin-nav-badge');
    if (existing) existing.remove();
    if (count > 0) {
      navItem.insertAdjacentHTML('beforeend', `<span class="admin-nav-badge">${count > 99 ? '99+' : count}</span>`);
    }
  } catch (e) {
    // Non-critical — silently ignore
  }
}

// ---- Boot ----
async function boot() {
  const loading = document.getElementById('app-loading');
  const shell = document.getElementById('app-shell');

  try {
    // Restore theme
    const savedTheme = localStorage.getItem('admin-theme');
    if (savedTheme) document.body.dataset.theme = savedTheme;

    // Auth check
    await AdminAuth.init();

    // Render shell
    renderSidebar();
    renderTopbar();

    // Init filters
    const filterBar = document.getElementById('filter-bar');
    FilterState.init(filterBar);

    // Load brand/supplier options for filters
    const brands = await AdminAPI.getBrands();
    if (brands && Array.isArray(brands)) {
      FilterState.setOptions('brands', brands.map(b => typeof b === 'string' ? b : b.name || b.brand || String(b)));
    }
    const suppliers = await AdminAPI.getSuppliers();
    if (suppliers && Array.isArray(suppliers)) {
      FilterState.setOptions('suppliers', suppliers.map(s => typeof s === 'string' ? s : s.name || String(s)));
    }

    // Wire filter changes to current page
    FilterState.subscribe(() => {
      if (_currentPage && _currentPage.onFilterChange) {
        _currentPage.onFilterChange(FilterState);
      }
    });

    // Show shell
    loading.classList.add('fade-out');
    setTimeout(() => loading.remove(), 300);
    shell.hidden = false;

    // Initial route
    const route = getRouteFromHash();
    await navigate(route);

    // Fetch unreviewed product count for nav badge
    updateReviewBadge();

    // Hash change listener
    window.addEventListener('hashchange', () => {
      const newRoute = getRouteFromHash();
      if (newRoute !== _currentPageName) {
        navigate(newRoute);
      }
    });

  } catch (e) {
    DebugLog.error('[Admin] Boot failed:', e);
    // Auth redirect already handled in AdminAuth.init()
  }
}

// Start when module loads (deferred by type="module")
boot();

// Export for page modules
export { AdminAuth, FilterState, AdminAPI, icon, esc, updateReviewBadge };
