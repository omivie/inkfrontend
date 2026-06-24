/**
 * Settings — consolidated owner-only configuration hub (June 2026 IA overhaul).
 *
 * Four tabs, each a lazy ES module reused as a panel (same contract as the
 * Control Center / Finance hubs: `default { init(container), destroy?() }`):
 *   Notifications  → contact-emails.js   (was the standalone "Settings" page)
 *   Shipping Rates → shipping-rates.js
 *   Legal Content  → legal-content.js
 *   Site Lock      → site-lock.js
 *
 * The active tab persists to the URL hash query (#settings?tab=shipping) so
 * deep links and browser back/forward work. Owner-only — navigate() in app.js
 * gates the route, and every panel's endpoints require owner server-side too.
 */
import { FilterState, AdminAuth, esc, icon } from '../app.js';
import { Charts } from '../components/charts.js';

// Cache-buster for the dynamic panel imports — matches the app.js pattern so a
// new deploy reloads panel modules instead of serving the previous bundle.
const SETTINGS_VERSION = '2026.06.25a';

const TABS = [
  { id: 'notifications', label: 'Notifications', module: './contact-emails.js' },
  { id: 'shipping',      label: 'Shipping Rates', module: './shipping-rates.js' },
  { id: 'legal',         label: 'Legal Content',  module: './legal-content.js' },
  { id: 'site-lock',     label: 'Site Lock',      module: './site-lock.js' },
];

const TAB_IDS = TABS.map(t => t.id);

let _container = null;
let _activeTab = 'notifications';
const _tabModules = {};
let _currentTabInstance = null;
let _hashHandler = null;

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
  // replaceState so tab switches don't pollute history — only the initial
  // #settings counts as a navigation step.
  const next = `#${base || 'settings'}?${params.toString()}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

async function loadTabModule(tabId) {
  if (_tabModules[tabId]) return _tabModules[tabId];
  const def = TABS.find(t => t.id === tabId);
  if (!def) throw new Error(`Unknown tab: ${tabId}`);
  const mod = await import(`${def.module}?v=${SETTINGS_VERSION}`);
  _tabModules[tabId] = mod.default;
  return mod.default;
}

function render() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="admin-page-header">
      <h1 class="admin-page-title">${icon('settings', 22, 22)} Settings</h1>
    </div>
    <div class="admin-tabs" id="settings-tabs" role="tablist" aria-label="Settings sections">
      ${TABS.map(t => `
        <button class="admin-tab${t.id === _activeTab ? ' active' : ''}"
                data-tab="${esc(t.id)}"
                role="tab"
                aria-selected="${t.id === _activeTab ? 'true' : 'false'}">
          ${esc(t.label)}
        </button>
      `).join('')}
    </div>
    <div id="settings-tab-content" role="tabpanel"></div>
  `;
  _container.querySelector('#settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === _activeTab) return;
    switchTab(btn.dataset.tab);
  });
  switchTab(_activeTab);
}

async function switchTab(tabId) {
  if (!TAB_IDS.includes(tabId)) tabId = 'notifications';
  _activeTab = tabId;
  writeTabToHash(tabId);
  _container.querySelectorAll('#settings-tabs .admin-tab').forEach(b => {
    const on = b.dataset.tab === tabId;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const contentEl = _container.querySelector('#settings-tab-content');
  contentEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:30vh">
    <div class="admin-loading__spinner"></div>
  </div>`;

  // Tear down the previous panel before mounting the next — these modules are
  // singletons keyed on a shared module-scoped container.
  if (_currentTabInstance?.destroy) {
    try { _currentTabInstance.destroy(); } catch (_) { /* panel may have failed to init */ }
  }
  _currentTabInstance = null;
  Charts.destroyAll();

  try {
    const panel = await loadTabModule(tabId);
    contentEl.innerHTML = '';
    _currentTabInstance = panel;
    await panel.init(contentEl);
  } catch (e) {
    DebugLog.error?.(`[Settings] Tab ${tabId} failed:`, e);
    contentEl.innerHTML = `<div class="admin-empty">
      <div class="admin-empty__title">Failed to load ${esc(tabId)}</div>
      <div class="admin-empty__text">${esc(e.message || 'Unknown error')}</div>
    </div>`;
  }
}

export default {
  title: 'Settings',

  async init(container) {
    _container = container;
    _activeTab = readTabFromHash() || 'notifications';
    _currentTabInstance = null;
    // Settings panels never use the global date-range filter bar.
    FilterState.showBar(false);

    // Belt-and-braces owner gate (router already gates, but a leaked hash
    // should still land on a clear denial rather than a broken panel).
    if (!AdminAuth.isOwner()) {
      container.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__title">Access Restricted</div>
        <div class="admin-stub__text">Settings are available to account owners only.</div>
      </div>`;
      return;
    }

    render();

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
    if (_hashHandler) window.removeEventListener('hashchange', _hashHandler);
    _hashHandler = null;
    _container = null;
    _currentTabInstance = null;
  },
};
