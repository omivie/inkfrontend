/**
 * Control Center — Business analytics across pricing, SEO, inventory, compliance
 * Owner-only. Sub-tabs lazy-loaded from cc-*.js modules.
 */
import { FilterState, esc, icon } from '../app.js';
import { Charts } from '../components/charts.js';

const TABS = [
  { id: 'profit',     label: 'Profit & Pricing' },
  { id: 'seo',        label: 'SEO & Trust' },
  { id: 'inventory',  label: 'Inventory & Supplier' },
  { id: 'compliance', label: 'Orders & Compliance' },
];

let _container = null;
let _activeTab = 'profit';
const _tabModules = {};
let _currentTabInstance = null;

async function loadTabModule(tabId) {
  if (_tabModules[tabId]) return _tabModules[tabId];
  const map = {
    profit: './cc-profit.js',
    seo: './cc-seo.js',
    inventory: './cc-inventory.js',
    compliance: './cc-compliance.js',
  };
  const mod = await import(map[tabId]);
  _tabModules[tabId] = mod.default;
  return mod.default;
}

function render() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="admin-page-header">
      <h1 class="admin-page-title">${icon('lab', 22, 22)} Control Center</h1>
    </div>
    <div class="admin-tabs cc-tabs" id="cc-tabs">
      ${TABS.map(t => `
        <button class="admin-tab${t.id === _activeTab ? ' active' : ''}" data-tab="${esc(t.id)}">
          ${esc(t.label)}
        </button>
      `).join('')}
    </div>
    <div id="cc-tab-content"></div>
  `;
  _container.querySelector('#cc-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || btn.dataset.tab === _activeTab) return;
    switchTab(btn.dataset.tab);
  });
  switchTab(_activeTab);
}

async function switchTab(tabId) {
  _activeTab = tabId;
  _container.querySelectorAll('.admin-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  const contentEl = _container.querySelector('#cc-tab-content');
  contentEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
    <div class="admin-loading__spinner"></div>
  </div>`;

  if (_currentTabInstance?.destroy) _currentTabInstance.destroy();
  Charts.destroyAll();

  try {
    const tabModule = await loadTabModule(tabId);
    contentEl.innerHTML = '';
    _currentTabInstance = tabModule;
    await tabModule.init(contentEl);
  } catch (e) {
    DebugLog.error(`[ControlCenter] Tab ${tabId} failed:`, e);
    contentEl.innerHTML = `<div class="admin-empty">
      <div class="admin-empty__title">Failed to load tab</div>
      <div class="admin-empty__text">${esc(e.message)}</div>
    </div>`;
  }
}

export default {
  title: 'Control Center',

  async init(container) {
    _container = container;
    _activeTab = 'profit';
    _currentTabInstance = null;
    FilterState.showBar(false);
    render();
  },

  destroy() {
    if (_currentTabInstance?.destroy) _currentTabInstance.destroy();
    Charts.destroyAll();
    _container = null;
    _currentTabInstance = null;
  },

  onSearch(query) {
    if (_currentTabInstance?.onSearch) _currentTabInstance.onSearch(query);
  },

  onFilterChange() {},
};
