/**
 * Control Center — Pricing tab
 *
 * Centerpiece is the Margin Simulator (spec §7.3). The user picks a source
 * (genuine / compatible), edits per-tier multipliers in-place, hits Preview,
 * and the server returns up to 5,000 affected SKUs with before/after retail,
 * net margin, and gross markup.
 *
 * The simulator is preview-only — committing changes still goes through
 * the existing `PUT /api/admin/pricing/tier-multipliers` endpoint elsewhere
 * in admin (see /admin#analytics → Pricing). We surface a Copy-to-Clipboard
 * for the proposed JSON so the operator can paste into the commit form.
 */
import { AdminAPI, esc, icon } from '../app.js';
import { Toast } from '../components/toast.js';
import {
  GST_RATE, STRIPE_RATE,
  DEFAULT_TIERS, COARSE_4_TIER_PRESET,
  GENUINE_TIER_KEYS, COMPATIBLE_TIER_KEYS,
  calcRetail, netMarginPct, grossMarkupPct, validateTierMap,
} from '../utils/pricingCalculator.js';

const COPY = {
  title: 'Margin simulator',
  cta_preview: 'Preview impact',
  cta_running: 'Running…',
  empty_help: 'Adjust tiers and click Preview impact to see how prices would change.',
  presets: {
    live: 'Live (current overrides)',
    defaults: 'Reset to code defaults',
    coarse_4: 'Coarse 4-tier (90/70/50/35 · 40/25/15/10)',
  },
};

let _host = null;
let _state = {
  source: 'compatible',
  preset: 'live',
  tiers: cloneTiers(DEFAULT_TIERS),
  liveTiers: null,
  result: null,
  loading: false,
  scope: { include_overrides: false },
};

function cloneTiers(t) {
  return { genuine: { ...t.genuine }, compatible: { ...t.compatible } };
}

function tierKeysFor(source) {
  return source === 'genuine' ? GENUINE_TIER_KEYS : COMPATIBLE_TIER_KEYS;
}

function applyPreset(preset) {
  _state.preset = preset;
  if (preset === 'live' && _state.liveTiers) {
    _state.tiers = cloneTiers(_state.liveTiers);
  } else if (preset === 'defaults') {
    _state.tiers = cloneTiers(DEFAULT_TIERS);
  } else if (preset === 'coarse_4') {
    _state.tiers = cloneTiers(COARSE_4_TIER_PRESET);
  }
}

function renderShell() {
  _host.innerHTML = `
    <div class="cc2-pricing">
      <aside class="cc2-pricing__controls admin-card" aria-labelledby="cc2-pricing-controls-title">
        <header class="cc2-section-header">
          <h2 id="cc2-pricing-controls-title">${esc(COPY.title)}</h2>
        </header>
        <div class="cc2-pricing__row">
          <label class="cc2-field">
            <span>Source</span>
            <select class="admin-select" data-field="source">
              <option value="compatible">Compatible</option>
              <option value="genuine">Genuine</option>
            </select>
          </label>
          <label class="cc2-field">
            <span>Preset</span>
            <select class="admin-select" data-field="preset">
              <option value="live">${esc(COPY.presets.live)}</option>
              <option value="defaults">${esc(COPY.presets.defaults)}</option>
              <option value="coarse_4">${esc(COPY.presets.coarse_4)}</option>
            </select>
          </label>
          <label class="cc2-field cc2-field--checkbox">
            <input type="checkbox" data-field="include_overrides">
            <span>Include manual overrides</span>
          </label>
        </div>
        <div class="cc2-pricing__tiers" data-tiers></div>
        <div class="cc2-pricing__actions">
          <button class="admin-btn admin-btn--primary" data-action="preview">
            ${icon('search', 14, 14)} <span data-cta>${esc(COPY.cta_preview)}</span>
          </button>
          <button class="admin-btn admin-btn--ghost" data-action="copy-json" title="Copy proposed_tiers JSON for the commit form">
            ${icon('copy', 14, 14)} Copy proposed JSON
          </button>
        </div>
        <p class="cc2-pricing__hint">Multipliers must satisfy 1.05 ≤ m ≤ 5. The server snaps retail to the nearest .49 / .79 / .99 ceiling and the FE preview matches that math exactly.</p>
      </aside>
      <section class="cc2-pricing__results" aria-live="polite">
        <div data-results></div>
      </section>
    </div>
  `;
  // Bind controls
  _host.querySelector('[data-field="source"]').addEventListener('change', (e) => {
    _state.source = e.target.value;
    renderTiers();
    renderResults();
  });
  _host.querySelector('[data-field="preset"]').addEventListener('change', (e) => {
    applyPreset(e.target.value);
    renderTiers();
  });
  _host.querySelector('[data-field="include_overrides"]').addEventListener('change', (e) => {
    _state.scope.include_overrides = !!e.target.checked;
  });
  _host.querySelector('[data-action="preview"]').addEventListener('click', runSimulation);
  _host.querySelector('[data-action="copy-json"]').addEventListener('click', copyProposedJson);
}

function renderTiers() {
  const wrap = _host.querySelector('[data-tiers]');
  if (!wrap) return;
  const keys = tierKeysFor(_state.source);
  const map = _state.tiers[_state.source];
  wrap.innerHTML = keys.map(k => {
    const v = map[k];
    const previewRetail = previewRetailForTier(k, _state.source, v);
    return `
      <div class="cc2-tier-row" data-tier="${esc(k)}">
        <label class="cc2-tier-row__key" for="cc2-tier-${esc(k)}">${esc(k)}</label>
        <input id="cc2-tier-${esc(k)}" class="cc2-tier-row__input" type="number" min="1.05" max="5" step="0.01" value="${v}" data-tier-input="${esc(k)}">
        <span class="cc2-tier-row__markup">≈ ${((v - 1) * 100).toFixed(0)}% gross markup</span>
        <span class="cc2-tier-row__example" title="Example retail at the tier midpoint cost">${esc(previewRetail)}</span>
      </div>
    `;
  }).join('');
  wrap.querySelectorAll('[data-tier-input]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const key = e.target.dataset.tierInput;
      const next = parseFloat(e.target.value);
      _state.tiers[_state.source][key] = Number.isFinite(next) ? next : _state.tiers[_state.source][key];
      // User has gone off-preset.
      _state.preset = 'live';
      _host.querySelector('[data-field="preset"]').value = 'live';
      const row = wrap.querySelector(`[data-tier="${cssEscape(key)}"]`);
      if (row) {
        row.querySelector('.cc2-tier-row__markup').textContent = `≈ ${((next - 1) * 100).toFixed(0)}% gross markup`;
        row.querySelector('.cc2-tier-row__example').textContent = previewRetailForTier(key, _state.source, next);
      }
    });
  });
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function previewRetailForTier(tierKey, source, mult) {
  const cost = midpointCost(tierKey);
  const m = Number(mult);
  if (!Number.isFinite(m) || m < 1.05 || m > 5) return '⚠ out of bounds';
  // Build a single-tier override map then call calcRetail
  const tiers = cloneTiers(DEFAULT_TIERS);
  tiers[source][tierKey] = m;
  const retail = calcRetail(cost, source, tiers);
  return `cost $${cost.toFixed(2)} → $${retail.toFixed(2)}`;
}

function midpointCost(tierKey) {
  // Use a representative cost inside the bucket so the example feels real.
  const map = {
    '<=10': 8, '10-15': 12, '15-20': 18, '20-40': 30, '40-70': 55,
    '70-100': 85, '100-130': 115, '130-150': 140, '150-200': 175,
    '200-300': 250, '300-400': 350, '400-600': 500, '600-900': 750, '900+': 1000,
    '<=5': 4, '5-10': 7, '10-20': 15, '20-35': 27, '35-55': 45,
    '55-80': 65, '80-120': 100, '120-180': 150, '180+': 220,
  };
  return map[tierKey] ?? 50;
}

async function runSimulation() {
  if (_state.loading) return;
  // Pre-flight validation matches server's 1.05 ≤ m ≤ 5.
  const v = validateTierMap(_state.tiers[_state.source], _state.source);
  if (!v.ok) {
    const first = v.errors[0];
    Toast.error(`Tier ${first.key}: ${first.reason.replace('_', ' ')}`);
    return;
  }
  _state.loading = true;
  setCta(true);
  try {
    const resp = await AdminAPI.controlCenter.simulatePricing({
      scope: { source: _state.source, include_overrides: _state.scope.include_overrides },
      proposed_tiers: { [_state.source]: _state.tiers[_state.source] },
      apply_ending_snap: true,
      preview_limit: 500,
    });
    _state.result = resp;
    renderResults();
  } catch (e) {
    if (e.code === 'RATE_LIMITED') Toast.warning('Slow down — try again in a few seconds.');
    else if (e.code === 'FORBIDDEN') Toast.error('This action requires super_admin.');
    else if (e.code === 'VALIDATION_FAILED') Toast.error(`Validation failed: ${e.message}`);
    else Toast.error(e.message || 'Simulation failed');
  } finally {
    _state.loading = false;
    setCta(false);
  }
}

function setCta(loading) {
  const btn = _host.querySelector('[data-action="preview"]');
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('[data-cta]').textContent = loading ? COPY.cta_running : COPY.cta_preview;
}

function copyProposedJson() {
  const payload = {
    proposed_tiers: { [_state.source]: _state.tiers[_state.source] },
    apply_ending_snap: true,
  };
  const text = JSON.stringify(payload, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => Toast.success('Proposed JSON copied to clipboard'),
      () => fallbackCopy(text),
    );
  } else fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); Toast.success('Proposed JSON copied'); }
  catch { Toast.error('Could not copy — select the text manually'); }
  finally { ta.remove(); }
}

function renderResults() {
  const wrap = _host.querySelector('[data-results]');
  if (!wrap) return;
  const data = _state.result;
  if (_state.loading) {
    wrap.innerHTML = `<div class="admin-card cc2-pricing__skeleton">
      <div class="admin-skeleton admin-skeleton--text" style="width:30%"></div>
      <div class="admin-skeleton admin-skeleton--text" style="width:60%;margin-top:8px"></div>
      <div class="admin-skeleton admin-skeleton--row" style="margin-top:18px"></div>
      <div class="admin-skeleton admin-skeleton--row"></div>
      <div class="admin-skeleton admin-skeleton--row"></div>
    </div>`;
    return;
  }
  if (!data) {
    wrap.innerHTML = `<div class="admin-card cc2-pricing__empty">
      <p>${esc(COPY.empty_help)}</p>
      <p class="cc2-pricing__legend">Net margin = profit after GST + Stripe ${(STRIPE_RATE * 100).toFixed(1)}% as a share of ex-GST revenue.<br>Gross markup = ex-GST retail vs. cost (no fees, the "100% markup" yardstick).</p>
    </div>`;
    return;
  }
  const a = data.aggregate || {};
  wrap.innerHTML = `
    <div class="admin-card cc2-pricing__aggregate">
      <header class="cc2-section-header"><h3>Aggregate impact (${data.affected.toLocaleString()} SKUs)</h3></header>
      <div class="admin-kpi-grid admin-kpi-grid--4">
        <div class="admin-kpi"><div class="admin-kpi__label">Avg retail change</div><div class="admin-kpi__value">${(a.avg_retail_change_pct ?? 0).toFixed(2)}%</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">↑ ↔ ↓</div><div class="admin-kpi__value cc2-pricing__delta">${a.total_skus_with_increase ?? 0} · ${a.total_skus_unchanged ?? 0} · ${a.total_skus_with_decrease ?? 0}</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">Net margin before</div><div class="admin-kpi__value">${(a.avg_net_margin_before ?? 0).toFixed(2)}%</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">Net margin after</div><div class="admin-kpi__value cc2-pricing__after-margin" data-tone="${marginTone(a.avg_net_margin_after, a.avg_net_margin_before)}">${(a.avg_net_margin_after ?? 0).toFixed(2)}%</div></div>
      </div>
    </div>
    <div class="admin-card">
      <header class="cc2-section-header"><h3>Sample (${(data.sample || []).length.toLocaleString()} of ${data.affected.toLocaleString()})</h3></header>
      <div class="admin-table-wrap">
        <table class="admin-table cc2-pricing__table">
          <thead>
            <tr>
              <th>SKU</th><th>Brand</th>
              <th class="num">Cost</th><th class="num">Retail (was → new)</th>
              <th class="num">Δ profit/unit</th>
              <th class="num">Gross markup</th>
              <th class="num">Net margin</th>
            </tr>
          </thead>
          <tbody>
            ${(data.sample || []).slice(0, 100).map(rowHtml).join('')}
          </tbody>
        </table>
      </div>
      ${data.sample && data.sample.length > 100 ? `<p class="cc2-pricing__truncated">Showing first 100 of ${data.sample.length.toLocaleString()} sample rows.</p>` : ''}
    </div>
  `;
}

function rowHtml(r) {
  const delta = Number(r.delta_retail) || 0;
  const deltaClass = Math.abs(delta) < 0.005 ? '' : delta > 0 ? 'cc2-pricing__delta--up' : 'cc2-pricing__delta--down';
  const deltaSym = delta > 0 ? '+' : '';
  const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;
  return `
    <tr>
      <td><span class="cell-mono">${esc(r.sku)}</span></td>
      <td>${esc(r.brand || '—')}</td>
      <td class="num">$${Number(r.cost_price).toFixed(2)}</td>
      <td class="num">
        <span class="cc2-pricing__retail">$${Number(r.current_retail).toFixed(2)} → <strong>$${Number(r.new_retail).toFixed(2)}</strong></span>
        ${Math.abs(delta) >= 0.005 ? `<span class="cc2-pricing__pill ${deltaClass}">${deltaSym}$${Math.abs(delta).toFixed(2)}</span>` : ''}
      </td>
      <td class="num ${deltaClass}">${deltaSym}$${(Number(r.delta_profit_per_unit) || 0).toFixed(2)}</td>
      <td class="num">${fmtPct(r.gross_markup_before_pct)} → <strong>${fmtPct(r.gross_markup_after_pct)}</strong></td>
      <td class="num">${fmtPct(r.current_net_margin_pct)} → <strong>${fmtPct(r.new_net_margin_pct)}</strong></td>
    </tr>
  `;
}

function marginTone(after, before) {
  if (after == null || before == null) return 'neutral';
  if (after >= before) return 'up';
  if (after >= before - 1) return 'flat';
  return 'down';
}

export default {
  async init(host) {
    _host = host;
    // Reset state per mount so leaving + returning starts clean.
    _state = {
      source: 'compatible',
      preset: 'live',
      tiers: cloneTiers(DEFAULT_TIERS),
      liveTiers: null,
      result: null,
      loading: false,
      scope: { include_overrides: false },
    };
    renderShell();

    // Try to fetch live tier overrides; fall back silently if endpoint is
    // not deployed yet (it's part of the existing /pricing/tier-multipliers
    // endpoint, which may predate this spec).
    const live = await AdminAPI.controlCenter.getTierMultipliers();
    const effective = live?.effective || live;
    if (effective && (effective.genuine || effective.compatible)) {
      _state.liveTiers = {
        genuine: { ...DEFAULT_TIERS.genuine, ...(effective.genuine || {}) },
        compatible: { ...DEFAULT_TIERS.compatible, ...(effective.compatible || {}) },
      };
      _state.tiers = cloneTiers(_state.liveTiers);
    }
    renderTiers();
    renderResults();
  },
  destroy() { _host = null; },
};
