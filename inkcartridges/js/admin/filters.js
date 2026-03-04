/**
 * FilterState — Global filter state with URL sync
 * Single source of truth for all admin page filters
 */

const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s);

const PERIOD_PRESETS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: '90d', label: '90D', days: 90 },
  { key: '12m', label: '12M', days: 365 },
  { key: 'all', label: 'All', days: -1 },
  { key: 'custom', label: 'Custom', days: null },
];

const FilterState = {
  _state: {
    period: 'all',
    dateFrom: '',
    dateTo: '',
    brands: [],
    suppliers: [],
    statuses: [],
    categories: [],
  },
  _listeners: [],
  _debounceTimer: null,
  _el: null,
  _dropdowns: new Map(),

  // Available options (populated from data)
  _options: {
    brands: [],
    suppliers: [],
    statuses: ['pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled'],
    categories: [],
  },

  init(containerEl) {
    this._el = containerEl;
    this._readFromURL();
    this._render();
    this._bindGlobalClose();
  },

  get(key) {
    return this._state[key];
  },

  set(key, value) {
    const prev = JSON.stringify(this._state);
    this._state[key] = value;
    if (JSON.stringify(this._state) !== prev) {
      this._writeToURL();
      this._updateUI();
      this._notifyDebounced();
    }
  },

  getDateRange() {
    if (this._state.period === 'custom' && this._state.dateFrom && this._state.dateTo) {
      return { from: this._state.dateFrom, to: this._state.dateTo };
    }
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    if (this._state.period === 'all') {
      return { from: '2020-01-01', to };
    }
    const preset = PERIOD_PRESETS.find(p => p.key === this._state.period);
    const days = preset ? preset.days : 30;
    if (days === 0) {
      return { from: to, to };
    }
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - days);
    return { from: fromDate.toISOString().slice(0, 10), to };
  },

  getParams() {
    const { from, to } = this.getDateRange();
    const p = new URLSearchParams();
    p.set('from', from);
    p.set('to', to);
    if (this._state.brands.length) p.set('brands', this._state.brands.join(','));
    if (this._state.suppliers.length) p.set('suppliers', this._state.suppliers.join(','));
    if (this._state.statuses.length) p.set('statuses', this._state.statuses.join(','));
    if (this._state.categories.length) p.set('categories', this._state.categories.join(','));
    return p;
  },

  periodToDays() {
    const preset = PERIOD_PRESETS.find(p => p.key === this._state.period);
    if (!preset || preset.days === null || preset.days === -1) {
      const { from, to } = this.getDateRange();
      const diff = (new Date(to) - new Date(from)) / 86400000;
      return Math.min(365, Math.max(1, Math.round(diff)));
    }
    return preset.days || 1;
  },

  setOptions(key, values) {
    this._options[key] = values;
    this._render();
  },

  subscribe(cb) {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter(l => l !== cb);
    };
  },

  reset() {
    this._state = {
      period: 'all', dateFrom: '', dateTo: '',
      brands: [], suppliers: [], statuses: [], categories: [],
    };
    this._writeToURL();
    this._render();
    this._notify();
  },

  // AbortController for current request cycle
  _abortController: null,
  getAbortSignal() {
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();
    return this._abortController.signal;
  },

  _readFromURL() {
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    if (params.has('period')) this._state.period = params.get('period');
    if (params.has('from')) this._state.dateFrom = params.get('from');
    if (params.has('to')) this._state.dateTo = params.get('to');
    if (params.has('brands')) this._state.brands = params.get('brands').split(',').filter(Boolean);
    if (params.has('suppliers')) this._state.suppliers = params.get('suppliers').split(',').filter(Boolean);
    if (params.has('statuses')) this._state.statuses = params.get('statuses').split(',').filter(Boolean);
    if (params.has('categories')) this._state.categories = params.get('categories').split(',').filter(Boolean);
  },

  _writeToURL() {
    const hash = window.location.hash;
    const baseHash = hash.split('?')[0] || '#dashboard';
    const parts = [];
    if (this._state.period !== 'all') parts.push('period=' + this._state.period);
    if (this._state.dateFrom) parts.push('from=' + this._state.dateFrom);
    if (this._state.dateTo) parts.push('to=' + this._state.dateTo);
    if (this._state.brands.length) parts.push('brands=' + this._state.brands.join(','));
    if (this._state.suppliers.length) parts.push('suppliers=' + this._state.suppliers.join(','));
    if (this._state.statuses.length) parts.push('statuses=' + this._state.statuses.join(','));
    if (this._state.categories.length) parts.push('categories=' + this._state.categories.join(','));
    const newHash = parts.length ? baseHash + '?' + parts.join('&') : baseHash;
    history.replaceState(null, '', newHash);
  },

  _notify() {
    this._listeners.forEach(cb => {
      try { cb(this._state); } catch (e) { DebugLog.error('[FilterState] listener error:', e); }
    });
  },

  _notifyDebounced() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._notify(), 150);
  },

  _updateUI() {
    if (!this._el) return;
    // Update period buttons
    this._el.querySelectorAll('[data-period]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.period === this._state.period);
    });
    // Custom date visibility
    const dateEl = this._el.querySelector('.admin-filter-date');
    if (dateEl) dateEl.classList.toggle('visible', this._state.period === 'custom');
    // Multi-select triggers
    this._updateSelectTrigger('brands');
    this._updateSelectTrigger('suppliers');
    this._updateSelectTrigger('statuses');
    this._updateSelectTrigger('categories');
  },

  _updateSelectTrigger(key) {
    const trigger = this._el?.querySelector(`[data-filter-trigger="${key}"]`);
    if (!trigger) return;
    const count = this._state[key].length;
    trigger.classList.toggle('has-value', count > 0);
    const countEl = trigger.querySelector('.admin-filter-select__count');
    if (countEl) {
      countEl.textContent = count;
      countEl.style.display = count > 0 ? '' : 'none';
    }
  },

  _render() {
    if (!this._el) return;
    const s = this._state;

    let html = '<div class="admin-filters">';

    // Period presets
    html += '<div class="admin-filter-group">';
    for (const p of PERIOD_PRESETS) {
      html += `<button class="admin-filter-btn${s.period === p.key ? ' active' : ''}" data-period="${p.key}">${p.label}</button>`;
    }
    html += '</div>';

    // Custom date range
    html += `<div class="admin-filter-date${s.period === 'custom' ? ' visible' : ''}">`;
    html += `<input type="date" class="admin-date-from" value="${esc(s.dateFrom)}">`;
    html += `<span>to</span>`;
    html += `<input type="date" class="admin-date-to" value="${esc(s.dateTo)}">`;
    html += '</div>';

    // Multi-selects
    html += this._renderMultiSelect('brands', 'Brand');
    html += this._renderMultiSelect('suppliers', 'Supplier');
    html += this._renderMultiSelect('statuses', 'Status');
    html += this._renderMultiSelect('categories', 'Category');

    // Reset
    const hasFilters = s.brands.length || s.suppliers.length || s.statuses.length || s.categories.length || s.period !== 'all';
    if (hasFilters) {
      html += '<button class="admin-filter-reset" data-action="reset-filters">Clear</button>';
    }

    html += '</div>';
    this._el.innerHTML = html;
    this._bindEvents();
  },

  _renderMultiSelect(key, label) {
    const options = this._options[key] || [];
    if (key !== 'statuses' && options.length === 0) return '';
    const selected = this._state[key];
    const count = selected.length;

    let html = '<div class="admin-filter-select" data-filter-select="' + key + '">';
    html += `<button class="admin-filter-select__trigger${count ? ' has-value' : ''}" data-filter-trigger="${key}">`;
    html += `${label}`;
    html += `<span class="admin-filter-select__count" style="display:${count ? '' : 'none'}">${count}</span>`;
    html += `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;
    html += '</button>';
    html += `<div class="admin-filter-select__dropdown" data-filter-dropdown="${key}">`;
    const items = key === 'statuses' ? this._options.statuses : options;
    for (const opt of items) {
      const val = typeof opt === 'string' ? opt : opt.name || opt;
      const checked = selected.includes(val) ? ' checked' : '';
      html += `<label class="admin-filter-select__option">`;
      html += `<input type="checkbox" value="${esc(val)}"${checked}>`;
      html += `${esc(val)}`;
      html += '</label>';
    }
    html += '</div></div>';
    return html;
  },

  _bindEvents() {
    if (!this._el) return;

    // Period buttons
    this._el.querySelectorAll('[data-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._state.period = btn.dataset.period;
        if (btn.dataset.period !== 'custom') {
          this._state.dateFrom = '';
          this._state.dateTo = '';
        }
        this._writeToURL();
        this._updateUI();
        this._render();
        this._notifyDebounced();
      });
    });

    // Custom dates
    const dateFrom = this._el.querySelector('.admin-date-from');
    const dateTo = this._el.querySelector('.admin-date-to');
    if (dateFrom) dateFrom.addEventListener('change', () => {
      this._state.dateFrom = dateFrom.value;
      this._writeToURL();
      this._notifyDebounced();
    });
    if (dateTo) dateTo.addEventListener('change', () => {
      this._state.dateTo = dateTo.value;
      this._writeToURL();
      this._notifyDebounced();
    });

    // Multi-select triggers
    this._el.querySelectorAll('[data-filter-trigger]').forEach(trigger => {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = trigger.dataset.filterTrigger;
        const dd = this._el.querySelector(`[data-filter-dropdown="${key}"]`);
        // Close others
        this._el.querySelectorAll('.admin-filter-select__dropdown.open').forEach(d => {
          if (d !== dd) d.classList.remove('open');
        });
        dd.classList.toggle('open');
      });
    });

    // Checkbox changes
    this._el.querySelectorAll('[data-filter-dropdown]').forEach(dd => {
      dd.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        e.stopPropagation();
        const key = dd.dataset.filterDropdown;
        const checked = [...dd.querySelectorAll('input:checked')].map(i => i.value);
        this._state[key] = checked;
        this._writeToURL();
        this._updateSelectTrigger(key);
        this._notifyDebounced();
      });
    });

    // Reset
    const resetBtn = this._el.querySelector('[data-action="reset-filters"]');
    if (resetBtn) resetBtn.addEventListener('click', () => this.reset());
  },

  _bindGlobalClose() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.admin-filter-select')) {
        document.querySelectorAll('.admin-filter-select__dropdown.open').forEach(d => {
          d.classList.remove('open');
        });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.admin-filter-select__dropdown.open').forEach(d => {
          d.classList.remove('open');
        });
      }
    });
  },
};

export { FilterState };
