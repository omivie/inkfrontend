/**
 * Control Center — Pricing tab
 *
 * Centerpiece is the Margin Simulator (spec §7.3). The user picks a source
 * (genuine / compatible), edits per-tier multipliers in-place, hits Preview,
 * and the server returns up to 5,000 affected SKUs with before/after retail,
 * net margin, and gross markup.
 *
 * Owners can edit the multipliers and hit "Confirm & save" to commit them
 * straight to the live store via `PUT /api/admin/pricing/tier-multipliers`
 * (the same endpoint the legacy /admin#analytics → Pricing form uses). The
 * Confirm payload is identical to the Copy-to-Clipboard JSON, so what you see
 * in the preview is exactly what gets saved. Staff (non-owners) still get the
 * preview + Copy-JSON path only.
 */
import { AdminAPI, AdminAuth, esc, icon } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import {
  GST_RATE, STRIPE_RATE,
  DEFAULT_TIERS, SIMULATABLE_SOURCES,
  validateTierMap, tierMidpoint, sortTierKeys, snapPriceCeil,
  coarsePreset, normalizeTierResponse,
} from '../utils/pricingCalculator.js';

const COPY = {
  title: 'Margin simulator',
  cta_preview: 'Preview impact',
  cta_confirm: 'Confirm & save',
  cta_saving: 'Saving…',
  cta_running: 'Running…',
  empty_help: 'Adjust tiers and click Preview impact to see how prices would change.',
  presets: {
    live: 'Live (current overrides)',
    defaults: 'Reset to code defaults',
    coarse_4: 'Coarse 4-tier (90/70/50/35 · 40/25/15/10)',
  },
};

let _host = null;
let _state = null;

function freshState() {
  return {
    source: 'compatible',
    preset: 'live',
    tiers: simSubset(DEFAULT_TIERS),  // current editable maps { genuine, compatible }
    liveTiers: null,                  // normalised effective (baseline for 'live')
    liveDefaults: null,               // normalised defaults (baseline for 'defaults')
    result: null,
    loading: false,
    scope: { include_overrides: false },
  };
}

// The simulator only edits the sources the /simulate endpoint accepts
// (genuine + compatible — `ribbon` exists in the store but simulate rejects it).
// Each map is copied verbatim (whatever keys the source provides), falling back
// to the bundled defaults when a source is absent.
function simSubset(sources) {
  const out = {};
  for (const s of SIMULATABLE_SOURCES) {
    out[s] = { ...((sources && sources[s]) || DEFAULT_TIERS[s] || {}) };
  }
  return out;
}

function cloneTiers(t) {
  return simSubset(t);
}

// Keys of the map currently being edited, in cost order — NEVER a hardcoded
// list. This guarantees the simulate/commit payload only ever carries live keys
// (the server schema is .unknown(false); a stale key = "Validation failed").
function tierKeysFor(source) {
  return sortTierKeys(Object.keys((_state.tiers && _state.tiers[source]) || {}));
}

function applyPreset(preset) {
  _state.preset = preset;
  if (preset === 'live' && _state.liveTiers) {
    _state.tiers = cloneTiers(_state.liveTiers);
  } else if (preset === 'defaults') {
    _state.tiers = cloneTiers(_state.liveDefaults || DEFAULT_TIERS);
  } else if (preset === 'coarse_4') {
    // Generate coarse multipliers over the LIVE key set for each source.
    const next = {};
    for (const s of SIMULATABLE_SOURCES) {
      const keys = Object.keys(
        (_state.tiers && _state.tiers[s])
        || (_state.liveTiers && _state.liveTiers[s])
        || DEFAULT_TIERS[s]
        || {}
      );
      next[s] = coarsePreset(s, keys);
    }
    _state.tiers = next;
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
          <button class="admin-btn" data-action="preview">
            ${icon('search', 14, 14)} <span data-cta>${esc(COPY.cta_preview)}</span>
          </button>
          ${AdminAuth.isOwner() ? `
          <button class="admin-btn admin-btn--primary" data-action="confirm">
            ${icon('check', 14, 14)} <span data-confirm-cta>${esc(COPY.cta_confirm)}</span>
          </button>` : ''}
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
  const confirmBtn = _host.querySelector('[data-action="confirm"]');
  if (confirmBtn) confirmBtn.addEventListener('click', confirmAndSave);
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
  const cost = tierMidpoint(tierKey);
  const m = Number(mult);
  if (!Number.isFinite(m) || m < 1.05 || m > 5) return '⚠ out of bounds';
  // Cost-plus example at the bucket midpoint for the typed multiplier. Uses the
  // key's own bounds (tierMidpoint), so it stays correct for any reband. This
  // is pre-market-cap; the authoritative figures come from /pricing/simulate.
  const retail = snapPriceCeil(cost * m * (1 + GST_RATE));
  return `cost $${cost.toFixed(2)} → $${retail.toFixed(2)}`;
}

async function runSimulation() {
  if (_state.loading) return;
  // Pre-flight validation matches server's 1.05 ≤ m ≤ 5.
  const v = validateTierMap(_state.tiers[_state.source], tierKeysFor(_state.source));
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
  } catch (e) {
    if (e.code === 'RATE_LIMITED') Toast.warning('Slow down — try again in a few seconds.');
    else if (e.code === 'FORBIDDEN') Toast.error('This action requires super_admin.');
    else if (e.code === 'VALIDATION_FAILED') Toast.error(`Validation failed: ${e.message}`);
    else Toast.error(e.message || 'Simulation failed');
  } finally {
    // Render AFTER clearing the loading flag — renderResults() paints the
    // skeleton while _state.loading is true, so calling it inside the try (with
    // loading still set) left the skeleton stuck and the aggregate never showed.
    _state.loading = false;
    setCta(false);
    if (_host) renderResults();
  }
}

function setCta(loading) {
  const btn = _host.querySelector('[data-action="preview"]');
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('[data-cta]').textContent = loading ? COPY.cta_running : COPY.cta_preview;
}

// Owner-only: persist the edited multipliers for the active source straight to
// the live tier-multipliers store. Same payload shape as Copy-JSON, so what you
// save is exactly what you'd otherwise paste into the legacy commit form.
function confirmAndSave() {
  // Pre-flight validation matches the server's 1.05 ≤ m ≤ 5.
  const v = validateTierMap(_state.tiers[_state.source], tierKeysFor(_state.source));
  if (!v.ok) {
    const first = v.errors[0];
    Toast.error(`Tier ${first.key}: ${first.reason.replace('_', ' ')}`);
    return;
  }
  const source = _state.source;
  const keys = tierKeysFor(source);
  const map = _state.tiers[source];
  const rows = keys.map(k => `<tr>
      <td class="cell-mono">${esc(k)}</td>
      <td style="text-align:right" class="cell-mono">${Number(map[k]).toFixed(4)}</td>
      <td style="text-align:right;color:var(--text-muted)">≈ ${((map[k] - 1) * 100).toFixed(0)}% markup</td>
    </tr>`).join('');
  const m = Modal.open({
    title: `Save ${source} multipliers?`,
    body: `<p style="margin:0 0 8px;color:var(--text-secondary)">These multipliers go live and all affected <strong>${esc(source)}</strong> prices reprice automatically in the background (about a minute).</p>
      <div class="admin-table-wrap"><table class="admin-table" style="margin:0">
        <thead><tr><th>Tier</th><th style="text-align:right">Multiplier</th><th style="text-align:right">Markup</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm">Save changes</button>
    `,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    const btn = m.footer.querySelector('[data-action="confirm"]');
    btn.disabled = true;
    btn.textContent = COPY.cta_saving;
    try {
      await AdminAPI.controlCenter.commitPricing({
        proposed_tiers: { [source]: map },
        apply_ending_snap: true,
      });
      // Guard against the page being unmounted mid-flight (ERR-045).
      if (!_host) return;
      Toast.success(`Saved — ${source} prices are repricing in the background.`);
      m.close();
      // Refresh the live baseline so the "Live" preset reflects what we just saved.
      const live = await AdminAPI.controlCenter.getTierMultipliers();
      if (!_host) return;
      const norm = normalizeTierResponse(live);
      if (norm.effective) {
        _state.liveTiers = simSubset(norm.effective);
        _state.liveDefaults = simSubset(norm.defaults || norm.effective);
      }
    } catch (e) {
      if (e.code === 'RATE_LIMITED') Toast.warning('Slow down — try again in a few seconds.');
      else if (e.code === 'FORBIDDEN') Toast.error('This action requires super_admin.');
      else if (e.code === 'VALIDATION_FAILED') Toast.error(`Validation failed: ${e.message}`);
      else Toast.error(e.message || 'Save failed');
      btn.disabled = false;
      btn.textContent = 'Save changes';
    }
  });
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
      <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
    </div>`;
    return;
  }
  if (!data) {
    wrap.innerHTML = `<div class="admin-card cc2-pricing__empty">
      <p>${esc(COPY.empty_help)}</p>
      <p class="cc2-pricing__legend">Net margin = profit after GST + Stripe ${(STRIPE_RATE * 100).toFixed(2)}% (incl. 15% GST on fee) as a share of ex-GST revenue.<br>Gross markup = ex-GST retail vs. cost (no fees, the "100% markup" yardstick).</p>
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
    _state = freshState();
    renderShell();

    // Fetch the live tier maps and render from WHATEVER keys the API returns —
    // never a hardcoded bucket list (the backend rebands and its schema is
    // .unknown(false)). normalizeTierResponse tolerates every response shape and
    // fails loud on an unrecognised one, so we don't silently edit bundled
    // defaults as if they were live.
    const live = await AdminAPI.controlCenter.getTierMultipliers();
    if (!_host) return;
    const norm = normalizeTierResponse(live);
    if (norm.effective) {
      _state.liveTiers = simSubset(norm.effective);
      _state.liveDefaults = simSubset(norm.defaults || norm.effective);
      _state.tiers = cloneTiers(_state.liveTiers);
    } else {
      // Loud: we could not resolve live multipliers. Show bundled defaults but
      // tell the operator so a saved edit isn't mistaken for editing live data.
      _state.preset = 'defaults';
      const sel = _host.querySelector('[data-field="preset"]');
      if (sel) sel.value = 'defaults';
      Toast.warning('Could not load live tier multipliers — showing bundled defaults. Reload before saving.');
    }
    renderTiers();
    renderResults();
  },
  destroy() { _host = null; },
};
