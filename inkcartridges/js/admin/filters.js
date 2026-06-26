/**
 * FilterState — Global filter state with URL sync
 * Single source of truth for all admin page filters
 */

const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s);

const PERIOD_PRESETS = [
  { key: '24h', label: '24h', days: 1 },
  { key: '72h', label: '72h', days: 3 },
  { key: '7d', label: '7d', days: 7 },
  { key: '1m', label: '1m', days: 30 },
  { key: '3m', label: '3m', days: 90 },
  { key: '6m', label: '6m', days: 180 },
  { key: '1y', label: '1y', days: 365 },
  { key: '2y', label: '2y', days: 730 },
  { key: 'all', label: 'All', days: -1 },
  { key: 'custom', label: 'Custom', days: null },
];

// Bar/bucket granularity — independent of the data range. 'auto' lets each
// page derive a sensible bucket width from the range; explicit values are sent
// to the backend so it returns pre-bucketed series (the frontend never re-buckets).
const GRANULARITY_PRESETS = [
  { key: 'auto', label: 'Auto' },
  { key: 'hour', label: 'Hour' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
];

// Approx days per bucket, used to keep the bucket count under the backend cap.
// The analytics router rejects any series with > BUCKET_CAP buckets ("Too many
// buckets … Narrow the window or use a coarser granularity"), so we disable any
// granularity that would exceed it for the selected range — otherwise picking
// e.g. Hour over All-time 400s and blanks every chart.
const GRANULARITY_DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30.4, quarter: 91 };
const BUCKET_CAP = 750;

const FilterState = {
  _state: {
    period: '3m',
    granularity: 'auto',
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
  _visibleFilters: null, // null = show all; array = only show these keys
  _showGranularity: false, // pages opt in via setGranularityVisible(true)

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
    if (this._state.granularity && this._state.granularity !== 'auto') p.set('granularity', this._state.granularity);
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

  setVisibleFilters(keys) {
    this._visibleFilters = keys; // null resets to "show all"
    this._render();
  },

  // Show/hide the bar-width (granularity) control. Off by default so it only
  // appears on pages that explicitly want it (e.g. the dashboard).
  setGranularityVisible(show = true) {
    this._showGranularity = !!show;
    // Drop a stale URL granularity that's invalid for the current range so the
    // first load doesn't fire an over-the-cap request (e.g. ?granularity=hour&period=all).
    if (show) this._clampGranularity();
    this._render();
  },

  // Real span of the selected window in days (uses the actual from/to, not the
  // 365-capped periodToDays) — needed to gate granularity against the bucket cap.
  rangeDays() {
    const { from, to } = this.getDateRange();
    const d = (new Date(to) - new Date(from)) / 86400000;
    return Math.max(1, Math.round(d));
  },

  // Would this granularity stay under the backend's bucket cap for the range?
  granularityAllowed(key) {
    if (!key || key === 'auto') return true;
    const gd = GRANULARITY_DAYS[key];
    if (!gd) return true;
    return (this.rangeDays() / gd) <= BUCKET_CAP;
  },

  // If the current granularity is now too fine for the range, fall back to 'auto'.
  // Returns true if it changed. (Caller decides whether to persist/notify.)
  _clampGranularity() {
    if (this._state.granularity !== 'auto' && !this.granularityAllowed(this._state.granularity)) {
      this._state.granularity = 'auto';
      this._writeToURL();
      return true;
    }
    return false;
  },

  // Apply page-local defaults (e.g. dashboard wants range=all) only when the
  // URL hash did not already specify them — keeps other pages' defaults intact.
  setDefaults(defaults = {}) {
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    const params = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(qIdx + 1));
    let changed = false;
    if (defaults.period !== undefined && !params.has('period')) {
      this._state.period = defaults.period; changed = true;
    }
    if (defaults.granularity !== undefined && !params.has('granularity')) {
      this._state.granularity = defaults.granularity; changed = true;
    }
    if (changed) {
      this._writeToURL();
      this._updateUI();
    }
  },

  subscribe(cb) {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter(l => l !== cb);
    };
  },

  reset() {
    this._state = {
      period: '3m', granularity: 'auto', dateFrom: '', dateTo: '',
      brands: [], suppliers: [], statuses: [], categories: [],
    };
    this._writeToURL();
    this._render();
    this._notify();
  },

  showBar(show = true) {
    const bar = document.getElementById('filter-bar');
    if (bar) bar.style.display = show ? '' : 'none';
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
    if (params.has('granularity')) this._state.granularity = params.get('granularity');
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
    if (this._state.period !== '3m') parts.push('period=' + this._state.period);
    if (this._state.granularity && this._state.granularity !== 'auto') parts.push('granularity=' + this._state.granularity);
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
    // Granularity buttons
    this._el.querySelectorAll('[data-granularity]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.granularity === this._state.granularity);
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

    // Multi-selects (only render filters relevant to the current page)
    const visible = this._visibleFilters;
    let leftHtml = '';
    if (!visible || visible.includes('brands')) leftHtml += this._renderMultiSelect('brands', 'Brand');
    if (!visible || visible.includes('suppliers')) leftHtml += this._renderMultiSelect('suppliers', 'Supplier');
    if (!visible || visible.includes('statuses')) leftHtml += this._renderMultiSelect('statuses', 'Status');
    if (!visible || visible.includes('categories')) leftHtml += this._renderMultiSelect('categories', 'Category');

    // Period presets (center)
    let centerHtml = '<div class="admin-filter-group">';
    for (const p of PERIOD_PRESETS) {
      centerHtml += `<button class="admin-filter-btn${s.period === p.key ? ' active' : ''}" data-period="${p.key}">${p.label}</button>`;
    }
    centerHtml += '</div>';

    // Custom date range (shown inline when custom selected)
    centerHtml += `<div class="admin-filter-date${s.period === 'custom' ? ' visible' : ''}">`;
    centerHtml += `<input type="date" class="admin-date-from" value="${esc(s.dateFrom)}">`;
    centerHtml += `<span>to</span>`;
    centerHtml += `<input type="date" class="admin-date-to" value="${esc(s.dateTo)}">`;
    centerHtml += '</div>';

    // Bar-width / granularity presets (opt-in per page)
    if (this._showGranularity) {
      centerHtml += '<div class="admin-filter-group admin-filter-group--granularity" title="Bar width">';
      for (const g of GRANULARITY_PRESETS) {
        const allowed = this.granularityAllowed(g.key);
        const dis = allowed ? '' : ' disabled title="Too many bars for this date range — pick a wider bar width or a shorter range"';
        centerHtml += `<button class="admin-filter-btn${s.granularity === g.key ? ' active' : ''}" data-granularity="${g.key}"${dis}>${g.label}</button>`;
      }
      centerHtml += '</div>';
    }

    // Reset button (right)
    const hasFilters = s.brands.length || s.suppliers.length || s.statuses.length || s.categories.length || s.period !== '3m';
    const rightHtml = hasFilters
      ? '<button class="admin-filter-reset" data-action="reset-filters">Clear</button>'
      : '';

    const html = `
      <div class="admin-filters">
        <div class="admin-filters__side admin-filters__side--left">${leftHtml}</div>
        <div class="admin-filters__center">${centerHtml}</div>
        <div class="admin-filters__side admin-filters__side--right">${rightHtml}</div>
      </div>
    `;

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
        this._clampGranularity();   // new range may make the bar-width too fine
        this._writeToURL();
        this._updateUI();
        this._render();
        this._notifyDebounced();
      });
    });

    // Granularity (bar-width) buttons
    this._el.querySelectorAll('[data-granularity]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;   // invalid for this range (over the bucket cap)
        this._state.granularity = btn.dataset.granularity;
        this._writeToURL();
        this._updateUI();
        this._notifyDebounced();
      });
    });

    // Custom dates
    const dateFrom = this._el.querySelector('.admin-date-from');
    const dateTo = this._el.querySelector('.admin-date-to');
    if (dateFrom) dateFrom.addEventListener('change', () => {
      this._state.dateFrom = dateFrom.value;
      this._clampGranularity();   // custom span may make the bar-width too fine
      this._writeToURL();
      this._render();             // refresh which granularity options are disabled
      this._notifyDebounced();
    });
    if (dateTo) dateTo.addEventListener('change', () => {
      this._state.dateTo = dateTo.value;
      this._clampGranularity();
      this._writeToURL();
      this._render();
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
