/**
 * Admin SPA — Entry point, router, shell
 */
const APP_VERSION = '2026.04.23c';

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
  finance: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  'lock-open': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/>',
  invoice: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="12" y2="9"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

function icon(name, w = 18, h = 18) {
  return `<svg viewBox="0 0 24 24" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[name] || ''}</svg>`;
}

// ---- Navigation config ----
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { key: 'analytics', label: 'Finance', icon: 'finance', ownerOnly: true },
  { key: 'website-traffic', label: 'Website Traffic', icon: 'analytics', ownerOnly: true },
  { key: 'orders', label: 'Orders', icon: 'orders' },
  { key: 'products', label: 'Products', icon: 'products' },
  { key: 'customers', label: 'Customers', icon: 'customers' },
  { divider: true },
  { key: 'planner', label: 'Planner', icon: 'calendar' },
  { key: 'promotions', label: 'Promotions', icon: 'finance', ownerOnly: true },
  { key: 'shipping-rates', label: 'Shipping Rates', icon: 'fulfillment', ownerOnly: true },
  { key: 'abuse', label: 'Abuse', icon: 'lock', ownerOnly: true },
  { key: 'segments', label: 'Segments', icon: 'mail', ownerOnly: true },
  { divider: true },
  { key: 'control-center', label: 'Operations', icon: 'lab', ownerOnly: true },
  { key: 'sync-report', label: 'Feed Sync', icon: 'products', href: '/html/admin/sync-report.html', ownerOnly: true },
  { key: 'price-monitor', label: 'Price Monitor', icon: 'finance', ownerOnly: true },
  { key: 'recovery', label: 'Recovery', icon: 'refunds', ownerOnly: true },
  { key: 'site-lock', label: 'Site Lock', icon: 'lock', ownerOnly: true },
  { key: 'contact-emails', label: 'Settings', icon: 'settings', ownerOnly: true },
];

// Legacy route redirects — old pages now merged into parent pages
const ROUTE_REDIRECTS = {
  'refunds': 'orders',
  'ribbons': 'products',
  'reviews': 'customers',
  'margin': 'analytics',
  'financial-health': 'analytics',
  'coupons': 'promotions',
};

// ---- Page module cache ----
const _pages = {};
async function loadPage(name) {
  if (_pages[name]) return _pages[name];
  try {
    const mod = await import(`./pages/${name}.js?v=${APP_VERSION}`);
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
    <div class="admin-sidebar__brand-row">
      <a class="admin-sidebar__brand" href="#dashboard">
        <div class="admin-sidebar__logo">${icon('products', 18, 18)}</div>
        <div>
          <div class="admin-sidebar__title">InkCartridges</div>
          <div class="admin-sidebar__subtitle">Admin Panel</div>
        </div>
      </a>
      <button class="admin-sidebar__back-btn" id="back-to-site" aria-label="Back to site" data-tooltip="Back to site">
        ${icon('logout', 16, 16)}
      </button>
    </div>
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
    const navHref = item.href || `#${item.key}`;
    const badgeHtml = item.badge ? ` <span class="admin-nav-badge" id="nav-badge-${esc(item.key)}"></span>` : '';
    html += `
      <div class="admin-nav-section">
        <a href="${esc(navHref)}" class="admin-nav-item" data-nav="${item.key}" data-tooltip="${esc(item.label)}">
          ${icon(item.icon)}
          <span class="admin-nav-label">${esc(item.label)}${badgeHtml}</span>
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

  // Collapse button lives outside sidebar to avoid overflow clipping
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'admin-sidebar__collapse-btn';
  collapseBtn.id = 'sidebar-collapse-btn';
  collapseBtn.setAttribute('aria-label', 'Collapse sidebar');
  collapseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  document.getElementById('app-shell').appendChild(collapseBtn);
  collapseBtn.addEventListener('click', toggleCollapse);

  // Back to site - via explicit sidebar button and user card click
  const goToSite = () => { window.location.href = '/html/'; };
  document.getElementById('back-to-site')?.addEventListener('click', goToSite);
  document.getElementById('user-card')?.addEventListener('click', goToSite);

  // Mobile sidebar toggle - floating button, only visible on small screens via CSS
  const mobileMenu = document.getElementById('mobile-menu-toggle');
  if (mobileMenu) {
    mobileMenu.hidden = false;
    mobileMenu.addEventListener('click', toggleSidebar);
  }
  document.getElementById('sidebar-backdrop')?.addEventListener('click', toggleSidebar);
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('open');
  backdrop.classList.toggle('open');
}

function toggleCollapse() {
  const sidebar = document.getElementById('sidebar');
  const shell = document.getElementById('app-shell');
  const isNowCollapsed = sidebar.classList.toggle('admin-sidebar--collapsed');
  shell.style.setProperty('--sidebar-w', isNowCollapsed ? '60px' : '240px');
  localStorage.setItem('admin_sidebar_collapsed', isNowCollapsed ? '1' : '');
}

// ---- Router ----
function getRouteFromHash() {
  const hash = window.location.hash.replace('#', '').split('?')[0];
  return hash || 'dashboard';
}

async function navigate(pageName) {
  // Handle legacy route redirects
  if (ROUTE_REDIRECTS[pageName]) {
    pageName = ROUTE_REDIRECTS[pageName];
    window.location.hash = pageName;
    return;
  }

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
  const ownerPages = ['contact-emails', 'control-center', 'site-lock'];
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

  // Reset filter bar visibility — page init() will hide it if not needed
  FilterState.showBar(true);

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


// ---- Command Palette ----
let _cmdPaletteOpen = false;

function openCommandPalette() {
  if (_cmdPaletteOpen) return;
  _cmdPaletteOpen = true;

  const isOwner = AdminAuth.isOwner();
  const commands = NAV_ITEMS
    .filter(item => !item.divider && !item.section && (!item.ownerOnly || isOwner))
    .map(item => ({ key: item.key, label: item.label, icon: item.icon, type: 'page' }));

  commands.push(
    { key: '_theme', label: 'Toggle Theme (Light/Dark)', icon: 'sun', type: 'action' },
  );

  const overlay = document.createElement('div');
  overlay.className = 'cmd-palette-overlay';
  overlay.innerHTML = `
    <div class="cmd-palette">
      <div class="cmd-palette__input-wrap">
        ${icon('search', 18, 18)}
        <input class="cmd-palette__input" placeholder="Search pages, actions\u2026" autocomplete="off" autofocus>
      </div>
      <div class="cmd-palette__results"></div>
      <div class="cmd-palette__footer">
        <span><kbd>\u2191\u2193</kbd> Navigate</span>
        <span><kbd>Enter</kbd> Select</span>
        <span><kbd>Esc</kbd> Close</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.cmd-palette__input');
  const results = overlay.querySelector('.cmd-palette__results');
  let activeIdx = 0;
  let filtered = [...commands];

  function renderResults() {
    results.innerHTML = filtered.map((cmd, i) =>
      `<div class="cmd-palette__item${i === activeIdx ? ' active' : ''}" data-idx="${i}">
        ${icon(cmd.icon, 16, 16)}
        <span class="cmd-palette__item-label">${esc(cmd.label)}</span>
        ${cmd.type === 'page' ? `<span class="cmd-palette__item-hint">#${cmd.key}</span>` : ''}
      </div>`
    ).join('') || '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px">No results</div>';
  }

  function execCommand(cmd) {
    closeCommandPalette();
    if (cmd.type === 'page') {
      window.location.hash = cmd.key;
    } else if (cmd.key === '_theme') {
      const root = document.querySelector('.admin');
      const current = root.getAttribute('data-theme');
      root.setAttribute('data-theme', current === 'light' ? 'dark' : 'light');
    }
  }

  function closeCommandPalette() {
    overlay.remove();
    _cmdPaletteOpen = false;
  }

  renderResults();
  input.focus();

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : [...commands];
    activeIdx = 0;
    renderResults();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); renderResults(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderResults(); }
    else if (e.key === 'Enter' && filtered[activeIdx]) { e.preventDefault(); execCommand(filtered[activeIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.cmd-palette__item');
    if (item) {
      const idx = parseInt(item.dataset.idx, 10);
      if (filtered[idx]) execCommand(filtered[idx]);
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandPalette();
  });
}

// ---- Shortcuts Help ----
let _shortcutsOpen = false;

function showShortcutsHelp() {
  if (_shortcutsOpen) return;
  _shortcutsOpen = true;

  const overlay = document.createElement('div');
  overlay.className = 'shortcuts-overlay';
  overlay.innerHTML = `
    <div class="shortcuts-panel">
      <h3>Keyboard Shortcuts</h3>
      <dl>
        <dt>Ctrl+K</dt><dd>Command Palette</dd>
        <dt>/</dt><dd>Focus Search</dd>
        <dt>Esc</dt><dd>Close / Clear Search</dd>
        <dt>g d</dt><dd>Go to Dashboard</dd>
        <dt>g p</dt><dd>Go to Products</dd>
        <dt>g o</dt><dd>Go to Orders</dd>
        <dt>g a</dt><dd>Go to Profit Center</dd>
        <dt>g c</dt><dd>Go to Customers</dd>
        <dt>j / k</dt><dd>Navigate table rows</dd>
        <dt>Enter</dt><dd>Open focused row</dd>
        <dt>x</dt><dd>Toggle row selection</dd>
        <dt>?</dt><dd>Show this help</dd>
      </dl>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() { overlay.remove(); _shortcutsOpen = false; }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
  });
}

// ---- Global Keyboard Shortcuts ----
function initKeyboardShortcuts() {
  let gPending = false;
  let gTimer = null;

  document.addEventListener('keydown', (e) => {
    const inInput = e.target.closest('input, textarea, select, [contenteditable]');

    // Cmd/Ctrl+K — Command Palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }

    if (inInput) return;

    // ? — Shortcuts help
    if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      showShortcutsHelp();
      return;
    }

    // g + key — Go to page
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !gPending) {
      gPending = true;
      clearTimeout(gTimer);
      gTimer = setTimeout(() => { gPending = false; }, 500);
      return;
    }

    if (gPending) {
      gPending = false;
      clearTimeout(gTimer);
      const goMap = { d: 'dashboard', p: 'products', o: 'orders', a: 'analytics', c: 'customers', s: 'contact-emails' };
      const target = goMap[e.key];
      if (target) { e.preventDefault(); window.location.hash = target; }
      return;
    }
  });
}

// ---- Boot ----
async function boot() {
  const loading = document.getElementById('app-loading');
  const shell = document.getElementById('app-shell');

  try {
    // Auth check
    await AdminAuth.init();

    // Render shell
    renderSidebar();

    // Restore sidebar collapse state
    if (localStorage.getItem('admin_sidebar_collapsed') === '1') {
      document.getElementById('sidebar').classList.add('admin-sidebar--collapsed');
      document.getElementById('app-shell').style.setProperty('--sidebar-w', '60px');
    }

    // Global keyboard shortcuts
    initKeyboardShortcuts();

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

// ---- Export dropdown helper ----
function exportDropdown(id, label = 'Export') {
  return `
    <div class="admin-export-dropdown" id="${id}" style="position:relative;display:inline-block">
      <button class="admin-btn admin-btn--ghost" data-export-toggle>
        ${icon('download', 14, 14)} ${esc(label)}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:4px"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="admin-export-menu" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;background:var(--bg-card, #fff);border:1px solid var(--color-border-light, #e2e8f0);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:50;min-width:160px;overflow:hidden">
        <button class="admin-export-option" data-format="csv" style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:none;background:none;cursor:pointer;font-size:13px;color:var(--text-primary, #1e293b);text-align:left;transition:background .15s">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          CSV (.csv)
        </button>
        <button class="admin-export-option" data-format="excel" style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:none;background:none;cursor:pointer;font-size:13px;color:var(--text-primary, #1e293b);text-align:left;transition:background .15s">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#217346" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2l2 4 2-4h2"/></svg>
          Excel (.xlsx)
        </button>
        <button class="admin-export-option" data-format="pdf" style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:none;background:none;cursor:pointer;font-size:13px;color:var(--text-primary, #1e293b);text-align:left;transition:background .15s">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15v-2h2a2 2 0 100-4H9v6"/></svg>
          PDF (.pdf)
        </button>
      </div>
    </div>
  `;
}

function bindExportDropdown(container, id, exportFn) {
  const wrapper = container.querySelector(`#${id}`);
  if (!wrapper) return;
  const toggle = wrapper.querySelector('[data-export-toggle]');
  const menu = wrapper.querySelector('.admin-export-menu');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.style.display !== 'none';
    menu.style.display = open ? 'none' : 'block';
  });

  wrapper.querySelectorAll('[data-format]').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover, #f1f5f9)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      exportFn(btn.dataset.format);
    });
  });

  // Close on outside click
  const closeMenu = (e) => {
    if (!wrapper.contains(e.target)) menu.style.display = 'none';
  };
  document.addEventListener('click', closeMenu);
  return () => document.removeEventListener('click', closeMenu);
}

// Export for page modules
export { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown };
