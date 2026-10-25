/**
 * Retention — do customers come back? (checklist 2026-10-22 item 39, ERR-372)
 * ============================================================================
 * The Retention tab of the Analytics hub (#analytics?tab=retention). ONE call,
 * GET /api/admin/analytics/retention, when the tab opens (server-cached 10 min,
 * 30/min limit). Owner only: a 403 says so instead of a table.
 *
 * Deliberately NOT beside GET /api/admin/analytics/cohorts (the Customers
 * page's stub): that older endpoint counts every guest as one customer, uses
 * UTC months and reports 0% for windows that have not ended, so its figures
 * contradict this one.
 *
 * Tooltips come from meta.definitions (never hard-coded copy). Every value
 * rule lives in utils/retention.js and is unit-tested there.
 */
import { AdminAPI, esc } from '../app.js';
import {
  SEGMENTS, SEGMENT_NOTE, WINDOWS, REVENUE_WINDOWS,
  rateCell, medianCell, revenueCell, rowsFor, footerText,
} from '../utils/retention.js';

let _container = null;
let _data = null;
let _meta = null;
let _segment = 'all';
let _abort = null;

const tip = (key) => {
  const d = _meta && _meta.definitions && _meta.definitions[key];
  return typeof d === 'string' && d ? ` data-tooltip="${esc(d)}" title="${esc(d)}"` : '';
};
const cell = (c) => `<td class="${c.small ? 'retention__small' : ''}${c.missing ? ' retention__missing' : ''}">${esc(c.text)}${c.small ? ' <span class="retention__flag">small sample</span>' : ''}</td>`;

function renderTable() {
  if (!_container || !_data) return;
  const rows = rowsFor(_data, _segment);
  const head = `<tr><th>Cohort</th><th${tip('customers')}>Customers</th>`
    + WINDOWS.map((w) => `<th${tip(`second_order_within.${w}`) || tip('second_order_within')}>2nd order ≤ ${w.slice(1)} days</th>`).join('')
    + `<th${tip('median_days_to_second_order')}>Median days</th>`
    + REVENUE_WINDOWS.map((w) => `<th${tip(`revenue_per_customer_incl_gst.${w}`) || tip('revenue_per_customer_incl_gst')}>Revenue / customer ${w.slice(1)}d</th>`).join('')
    + '</tr>';
  const body = rows.map((r) => {
    const g = r.group || {};
    const customers = typeof g.customers === 'number' ? String(g.customers) : '—';
    return `<tr class="${r.total ? 'retention__total' : ''}"><th scope="row">${esc(r.label)}${r.inProgress ? ' <span class="admin-badge retention__progress">in progress</span>' : ''}</th>`
      + `<td>${esc(customers)}</td>`
      + WINDOWS.map((w) => cell(rateCell(g.second_order_within && g.second_order_within[w]))).join('')
      + cell(medianCell(g))
      + REVENUE_WINDOWS.map((w) => cell(revenueCell(g, w))).join('')
      + '</tr>';
  }).join('');
  _container.querySelector('#retention-table').innerHTML = `<table class="admin-table retention__table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  _container.querySelectorAll('[data-segment]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.segment === _segment)));
}

async function render() {
  if (!_container) return;
  _abort?.abort();
  _abort = new AbortController();
  _container.innerHTML = '<div class="admin-card"><p class="admin-empty">Loading retention…</p></div>';
  const res = await AdminAPI.getRetention(_abort.signal);
  if (!_container || res?.aborted) return;
  if (!res?.ok) {
    const why = res?.status === 403 ? 'This report is for the owner account only.'
      : res?.rateLimited ? `Too many requests — try again in ${res.retryAfter}s.`
      : `Retention data couldn't be loaded${res?.status ? ` (HTTP ${res.status})` : ''}.`;
    _container.innerHTML = `<div class="admin-card"><p class="admin-empty" data-retention="error">${esc(why)}</p>`
      + (res?.status === 403 ? '' : '<button type="button" class="admin-btn admin-btn--small" data-retry>Retry</button>') + '</div>';
    return;
  }
  _data = res.data || {};
  _meta = res.meta || _data.meta || {};
  _container.innerHTML = `<div class="admin-card retention">`
    + `<div class="retention__bar" role="group" aria-label="Segment">`
    + SEGMENTS.map((s) => `<button type="button" class="admin-btn admin-btn--small" data-segment="${s.id}" aria-pressed="false">${esc(s.label)}</button>`).join('')
    + `</div><p class="retention__note">${esc(SEGMENT_NOTE)}</p>`
    + `<div id="retention-table" class="admin-table-wrap"></div>`
    + `<p class="retention__foot">${esc(footerText(_meta))}</p></div>`;
  renderTable();
}

function onClick(e) {
  const seg = e.target.closest('[data-segment]');
  if (seg) { _segment = seg.dataset.segment; renderTable(); return; }
  if (e.target.closest('[data-retry]')) render();
}

export default {
  title: 'Retention',
  async init(container) {
    _container = container;
    container.addEventListener('click', onClick);
    await render();
  },
  destroy() {
    _abort?.abort();
    _container?.removeEventListener('click', onClick);
    _container = null;
    _data = null;
    _meta = null;
  },
};
