/**
 * Control Center — May 2026 spec (readfirst/control-center-may2026.md)
 *
 * Six tabs from the backend's adminControlCenter route file:
 *   Overview · Pricing · Packs · Integrity · SEO · Infra
 *
 * Each tab is a lazy ES module loaded on demand. The active tab persists
 * to the URL hash query (#control-center?tab=pricing) so deep links and
 * browser back/forward work, and the keyboard quick-nav (g h/p/k/i/s/f)
 * routes through hashchange just like top-level page navigation.
 *
 * Owner-only (super_admin in spec terminology) — gate is enforced by
 * navigate() in app.js, but every endpoint also requires server-side
 * super_admin so a leaked link cannot get past the API.
 */
import { FilterState, AdminAuth, esc, icon } from '../app.js';
import { Charts } from '../components/charts.js';

const TABS = [
  { id: 'overview',   label: 'Overview',  shortcut: 'h', module: './cc2-overview.js' },
  { id: 'pricing',    label: 'Pricing',   shortcut: 'p', module: './cc2-pricing.js' },
  { id: 'packs',      label: 'Packs',     shortcut: 'k', module: './cc2-packs.js' },
  { id: 'integrity',  label: 'Integrity', shortcut: 'i', module: './cc2-integrity.js' },
  { id: 'seo',        label: 'SEO',       shortcut: 's', module: './cc2-seo-slug.js' },
  { id: 'infra',      label: 'Infra',     shortcut: 'f', module: './cc2-infra.js' },
];

const COPY = {
  title: 'Control Center',
  subtitle: 'Health, pricing, packs, integrity & SEO',
  keyboard_hint: 'Press ⌘K for commands · g + letter to navigate tabs',
};

let _container = null;
let _activeTab = 'overview';
const _tabModules = {};
let _currentTabInstance = null;
let _gKeyHandler = null;
let _hashHandler = null;
let _topBarRefreshTimer = null;

const TAB_IDS = TABS.map(t => t.id);

function readTabFromHash() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const t = params.get('tab');
  return TAB_IDS.includes(t) ? t : null;
}

function writeTabToHash(tabId) {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const [base, query] = hash.split('?');
  const params = new URLSearchParams(query || '');
  params.set('tab', tabId);
  // Use replaceState so tab switches don't pollute browser history with
  // dozens of entries — only the initial #control-center counts as a step.
  const next = `#${base || 'control-center'}?${params.toString()}`;
  if (window.location.hash !== next) {
    history.replaceState(null, '', next);
  }
}

// Cache-buster for dynamic imports — matches the pattern in app.js
// (`import('./pages/${name}.js?v=${APP_VERSION}')`) so a new deploy actually
// reloads tab modules instead of serving the previous bundle from cache.
const CC_VERSION = '2026.05.04c';

async function loadTabModule(tabId) {
  if (_tabModules[tabId]) return _tabModules[tabId];
  const def = TABS.find(t => t.id === tabId);
  if (!def) throw new Error(`Unknown tab: ${tabId}`);
  const mod = await import(`${def.module}?v=${CC_VERSION}`);
  _tabModules[tabId] = mod.default;
  return mod.default;
}

function render() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="admin-page-header cc2-header">
      <div>
        <h1 class="admin-page-title">${icon('lab', 22, 22)} ${esc(COPY.title)}</h1>
        <div class="cc2-subtitle">${esc(COPY.subtitle)}</div>
      </div>
      <div class="cc2-header__hint" aria-keyshortcuts="Meta+K Control+K">${esc(COPY.keyboard_hint)}</div>
    </div>
    <div id="cc2-topbar" class="cc2-topbar" role="region" aria-label="System health summary"></div>
    <div class="admin-tabs cc2-tabs" id="cc2-tabs" role="tablist" aria-label="Control Center sections">
      ${TABS.map(t => `
        <button class="admin-tab cc2-tab${t.id === _activeTab ? ' active' : ''}"
                data-tab="${esc(t.id)}"
                role="tab"
                aria-selected="${t.id === _activeTab ? 'true' : 'false'}"
                aria-keyshortcuts="g ${t.shortcut}">
          ${esc(t.label)}<span class="cc2-tab__hint">g${t.shortcut}</span>
        </button>
      `).join('')}
    </div>
    <div id="cc2-tab-content" role="tabpanel"></div>
  `;
  _container.querySelector('#cc2-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === _activeTab) return;
    switchTab(btn.dataset.tab);
  });

  // Mount the top-bar health row (also drives the Overview tab data).
  mountTopBar();

  switchTab(_activeTab);
}

async function mountTopBar() {
  // Lazy-load the topbar so the initial control-center bundle stays small.
  const mod = await import(`./cc2-topbar.js?v=${CC_VERSION}`);
  const host = _container?.querySelector('#cc2-topbar');
  if (!host) return;
  await mod.default.init(host, { onTileClick: (tabId) => switchTab(tabId) });
  // Refresh every 60s — matches the 30/min read budget in spec §4.
  clearInterval(_topBarRefreshTimer);
  _topBarRefreshTimer = setInterval(() => mod.default.refresh?.(), 60_000);
}

async function switchTab(tabId) {
  if (!TAB_IDS.includes(tabId)) tabId = 'overview';
  _activeTab = tabId;
  writeTabToHash(tabId);
  _container.querySelectorAll('.cc2-tab').forEach(b => {
    const on = b.dataset.tab === tabId;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const contentEl = _container.querySelector('#cc2-tab-content');
  contentEl.innerHTML = `<div class="cc2-loading" aria-busy="true">
    <div class="admin-loading__spinner"></div>
  </div>`;

  if (_currentTabInstance?.destroy) {
    try { _currentTabInstance.destroy(); } catch (e) { /* swallow — tab may have failed to init */ }
  }
  Charts.destroyAll();

  try {
    const tabModule = await loadTabModule(tabId);
    contentEl.innerHTML = '';
    _currentTabInstance = tabModule;
    await tabModule.init(contentEl, { switchTab });
  } catch (e) {
    DebugLog.error?.(`[ControlCenter] Tab ${tabId} failed:`, e);
    contentEl.innerHTML = `<div class="admin-empty">
      <div class="admin-empty__title">Failed to load tab</div>
      <div class="admin-empty__text">${esc(e.message || 'Unknown error')}</div>
    </div>`;
  }
}

function installKeyboardShortcuts() {
  // `g + <letter>` — switch tab. We listen on document so it works while the
  // user's focus is anywhere on the page (except inside an input field).
  // Pairs with the global g-shortcut in app.js: page nav uses g + d/p/o/...,
  // and inside the control-center we layer g + h/p/k/i/s/f for tabs.
  let gPending = false;
  let gTimer = null;
  _gKeyHandler = (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey && !gPending) {
      gPending = true;
      clearTimeout(gTimer);
      gTimer = setTimeout(() => { gPending = false; }, 600);
      return;
    }
    if (gPending) {
      gPending = false;
      clearTimeout(gTimer);
      const target = TABS.find(t => t.shortcut === e.key);
      if (target) {
        e.preventDefault();
        switchTab(target.id);
      }
    }
  };
  document.addEventListener('keydown', _gKeyHandler);
}

function uninstallKeyboardShortcuts() {
  if (_gKeyHandler) document.removeEventListener('keydown', _gKeyHandler);
  _gKeyHandler = null;
}

export default {
  title: 'Control Center',

  async init(container) {
    _container = container;
    _activeTab = readTabFromHash() || 'overview';
    _currentTabInstance = null;
    FilterState.showBar(false);

    // Belt-and-braces: the global router already gates owner-only pages,
    // but Control Center demands super_admin so we want a clear denial UI
    // even if a non-owner reaches this module via direct hash.
    if (!AdminAuth.isOwner()) {
      container.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__title">Access Restricted</div>
        <div class="admin-stub__text">The Control Center is available to super-admins only.</div>
      </div>`;
      return;
    }

    render();
    installKeyboardShortcuts();

    _hashHandler = () => {
      const t = readTabFromHash();
      if (t && t !== _activeTab) switchTab(t);
    };
    window.addEventListener('hashchange', _hashHandler);
  },

  destroy() {
    if (_currentTabInstance?.destroy) {
      try { _currentTabInstance.destroy(); } catch (_) {}
    }
    Charts.destroyAll();
    uninstallKeyboardShortcuts();
    if (_hashHandler) window.removeEventListener('hashchange', _hashHandler);
    _hashHandler = null;
    clearInterval(_topBarRefreshTimer);
    _topBarRefreshTimer = null;
    _container = null;
    _currentTabInstance = null;
  },

  onSearch(query) {
    if (_currentTabInstance?.onSearch) _currentTabInstance.onSearch(query);
  },

  onFilterChange() {},
};
