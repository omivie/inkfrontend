/**
 * Control Center — Integrity tab (compatibility orphans)
 *
 * Surfaces the 4 audit tests from /api/admin/compat/orphans (spec §5.6).
 * Tests A and F are too expensive for live API and return null counts —
 * we render an "unmeasured" state with a copy-to-clipboard CTA for
 * `node scripts/audit-compatibility.js` so the operator can refresh
 * them out-of-band.
 */
import { AdminAPI, esc, icon } from '../app.js';
import { Toast } from '../components/toast.js';

const SCRIPT_HINT = 'node scripts/audit-compatibility.js';

const TESTS = [
  {
    key: 'test_d_orphan_printers',
    title: 'Orphan printers (Test D)',
    description: 'Printer rows with no compatible-product mapping. Likely indexed but unbuyable.',
    sampleHeaders: ['Printer', 'Brand', 'Slug'],
    sampleRow: (r) => [
      esc(r.printer_name || '—'),
      esc(r.brand_name || '—'),
      `<span class="cell-mono">${esc(r.printer_slug || '—')}</span>`,
    ],
  },
  {
    key: 'test_e_type_mismatch',
    title: 'Type mismatches (Test E)',
    description: 'Compatibility rows where product_type and printer_type disagree (e.g. ink listed for a laser printer).',
    sampleHeaders: ['SKU', 'Product type', 'Printer', 'Printer type', 'Reason'],
    sampleRow: (r) => [
      `<span class="cell-mono">${esc(r.product_sku || '—')}</span>`,
      esc(r.product_type || '—'),
      esc(r.printer_name || '—'),
      esc(r.printer_type || '—'),
      `<span class="cell-truncate" style="max-width:240px" title="${esc(r.reason || '')}">${esc(r.reason || '—')}</span>`,
    ],
  },
  {
    key: 'test_a_disjoint',
    title: 'Disjoint compatibility sets (Test A)',
    description: 'Cross-printer compatibility groups that should overlap but do not.',
    unmeasured: true,
  },
  {
    key: 'test_f_series_outlier',
    title: 'Series outliers (Test F)',
    description: 'Printers in a series whose compatibility list diverges from the series consensus.',
    unmeasured: true,
  },
];

function copyHint() {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(SCRIPT_HINT).then(
      () => Toast.success('Copied — paste into a terminal at the backend repo root'),
      () => Toast.error('Could not copy — select the command manually'),
    );
  } else {
    Toast.info(SCRIPT_HINT, 8000);
  }
}

function renderTestCard(test, payload) {
  const count = payload?.count;
  const sample = payload?.sample || [];
  const note = payload?.note || '';

  if (test.unmeasured || count == null) {
    return `
      <article class="admin-card cc2-orphan-card cc2-orphan-card--unmeasured" aria-labelledby="cc2-orphan-${esc(test.key)}">
        <header class="cc2-orphan-card__header">
          <h3 id="cc2-orphan-${esc(test.key)}">${esc(test.title)}</h3>
          <span class="admin-badge admin-badge--pending">unmeasured</span>
        </header>
        <p class="cc2-orphan-card__desc">${esc(test.description)}</p>
        ${note ? `<p class="cc2-orphan-card__note">${esc(note)}</p>` : ''}
        <div class="cc2-orphan-card__cta">
          <code class="cc2-cli">${esc(SCRIPT_HINT)}</code>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="copy-hint">${icon('copy', 14, 14)} Copy</button>
        </div>
      </article>
    `;
  }

  const sevClass = count === 0 ? 'cc2-orphan-card--ok' : count > 50 ? 'cc2-orphan-card--bad' : 'cc2-orphan-card--warn';
  const sampleHtml = sample.length === 0
    ? '<p class="cc2-orphan-card__empty">No sample rows.</p>'
    : `
      <div class="admin-table-wrap">
        <table class="admin-table cc2-orphan-table">
          <thead><tr>${test.sampleHeaders.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
            ${sample.slice(0, 10).map(r => `<tr>${test.sampleRow(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${sample.length > 10 ? `<p class="cc2-orphan-card__truncated">Showing first 10 of ${sample.length} sample rows.</p>` : ''}
    `;
  return `
    <article class="admin-card cc2-orphan-card ${sevClass}" aria-labelledby="cc2-orphan-${esc(test.key)}">
      <header class="cc2-orphan-card__header">
        <h3 id="cc2-orphan-${esc(test.key)}">${esc(test.title)}</h3>
        <span class="cc2-orphan-card__count">${Number(count).toLocaleString()}</span>
      </header>
      <p class="cc2-orphan-card__desc">${esc(test.description)}</p>
      ${sampleHtml}
    </article>
  `;
}

let _host = null;

export default {
  async init(host) {
    _host = host;
    _host.innerHTML = `
      <div class="cc2-section-header">
        <h2>Compatibility integrity</h2>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="copy-hint">
          ${icon('copy', 14, 14)} Copy audit-script command
        </button>
      </div>
      <div class="cc2-orphan-grid" id="cc2-orphan-grid">
        ${TESTS.map(t => `<div class="admin-card cc2-orphan-card">
          <div class="admin-skeleton admin-skeleton--text" style="width:60%"></div>
          <div class="admin-skeleton admin-skeleton--text" style="width:80%;margin-top:10px"></div>
        </div>`).join('')}
      </div>
    `;
    _host.querySelector('[data-action="copy-hint"]').addEventListener('click', copyHint);

    const data = await AdminAPI.controlCenter.getOrphans();
    if (!_host) return;
    const grid = _host.querySelector('#cc2-orphan-grid');
    // Even on backend failure, render the four test card shells so the
    // "Run audit script" CTA stays reachable — spec §5.6 says that hint
    // is always the user's escape hatch when counts can't be computed.
    const safe = data || {
      test_d_orphan_printers: { count: null, sample: [], note: 'Backend unreachable — try again or run the script.' },
      test_e_type_mismatch:   { count: null, sample: [], note: 'Backend unreachable — try again or run the script.' },
      test_a_disjoint:        { count: null, sample: [], note: 'Run scripts/audit-compatibility.js' },
      test_f_series_outlier:  { count: null, sample: [], note: 'Run scripts/audit-compatibility.js' },
    };
    grid.innerHTML = TESTS.map(t => {
      // Force unmeasured state when backend gave nothing for D/E
      const payload = safe[t.key];
      const effective = data ? payload : { ...payload };
      if (!data && (t.key === 'test_d_orphan_printers' || t.key === 'test_e_type_mismatch')) {
        // Render via the unmeasured branch by setting the test's flag locally
        return renderTestCard({ ...t, unmeasured: true }, effective);
      }
      return renderTestCard(t, effective);
    }).join('');
    grid.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="copy-hint"]')) copyHint();
    });

    const fetchedAt = data?.generated_at
      ? ` · generated ${new Date(data.generated_at).toLocaleTimeString('en-NZ')}`
      : (data ? '' : ' · backend unreachable');
    let meta = _host.querySelector('.cc2-orphan-meta');
    if (!meta) {
      meta = document.createElement('p');
      meta.className = 'cc2-orphan-meta';
      _host.appendChild(meta);
    }
    meta.textContent = `Counts shown as em-dash (—) are too expensive to compute on every request${fetchedAt}.`;
  },
  destroy() { _host = null; },
};
