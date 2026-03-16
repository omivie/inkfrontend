/**
 * Lab Page — Owner-only, enhanced visual stub with styled feature cards
 */
import { FilterState, icon, esc } from '../app.js';

const FEATURES = [
  { name: 'A/B Testing', desc: 'Run experiments on product pages, pricing, and checkout flows to optimize conversions.', ic: 'analytics', color: 'cyan' },
  { name: 'Data Sandbox', desc: 'Query and explore raw data with an interactive SQL sandbox for ad-hoc analysis.', ic: 'dashboard', color: 'magenta' },
  { name: 'Feature Flags', desc: 'Roll out new features gradually with audience targeting and kill switches.', ic: 'settings', color: 'yellow' },
  { name: 'Prototype Playground', desc: 'Test new UI components and workflows before deploying to production.', ic: 'lab', color: 'success' },
];

export default {
  title: 'Lab',

  init(container) {
    FilterState.showBar(false);
    let html = `<div class="admin-page-header"><h1>Lab</h1></div>`;
    html += `<p style="color:var(--text-secondary);margin-bottom:24px">Experimental features and tools. These are in development and not yet available for production use.</p>`;
    html += `<div class="admin-grid-4">`;
    for (const f of FEATURES) {
      html += `<div class="admin-card admin-card--${f.color}">`;
      html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">`;
      html += `<div style="width:40px;height:40px;border-radius:var(--radius);background:var(--${f.color}-dim);display:flex;align-items:center;justify-content:center;color:var(--${f.color}-text)">${icon(f.ic, 20, 20)}</div>`;
      html += `<div style="font-size:15px;font-weight:600">${esc(f.name)}</div>`;
      html += `</div>`;
      html += `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px;line-height:1.5">${esc(f.desc)}</p>`;
      html += `<span class="admin-badge admin-badge--pending">Coming Soon</span>`;
      html += `</div>`;
    }
    html += `</div>`;

    container.innerHTML = html;
  },

  destroy() {},
};
