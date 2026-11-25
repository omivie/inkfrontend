/**
 * Trends -- every chart/card the old Dashboard shows below its alerts row, as a tab of the
 * Analytics hub (#analytics?tab=trends). Nov 2026: the new Dashboard keeps only the money
 * boxes, the Performance overview and the to-do list; the rest lives here.
 *
 * Same rows, same order, same canvas ids and helpers as pages/dashboard.js (utils/dash-charts.js
 * holds the one copy of each). Each fetch fails soft INDEPENDENTLY: a card whose request
 * failed says so on its face, never a zero or "nothing to do" (fail-soft must be loud).
 */
import { FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import {
  rangeLabel, resolveGranularity, setEffectiveGranularity, bundleToGraphs, normalizeWorstMargin,
  drawSeries, drawRanked, drawShare, drawRevenueProfit, drawForecast,
  chartCard, row, rowN, renderFunnelCard, renderTopProductsCard, wireTopProductsToggle,
  renderRecentOrdersCard, wireOrderRowClicks, renderFulfillmentCard,
} from '../utils/dash-charts.js';

let _container = null;
let _seq = 0;   // a stale load must never paint over a newer one

const failCard = (title, why) => `
  <div class="admin-dash__cell--6 admin-card">
    <div class="admin-card__title">${esc(title)}</div>
    <div class="admin-dash-inline-empty" data-trends="error">${esc(why)}</div>
  </div>`;

function drawAll(d) {
  try {
    drawRevenueProfit(d);
    drawForecast('dash-c-forecast', d.forecast);
    drawRanked('dash-c-sku-revenue', d.topSkusRev, { listKeys: ['products', 'skus'], labelKey: 'sku', valueKey: 'revenue', color: 'success', isMoney: true });
    drawRanked('dash-c-sku-profit', d.topSkusProfit, { listKeys: ['products', 'skus'], labelKey: 'sku', valueKey: 'gross_profit', color: 'cyan', isMoney: true });
    drawRanked('dash-c-sku-worst-margin', d.worstMarginSkus, { listKeys: ['products', 'rows', 'data'], labelKey: '_label', valueKey: '_marginPct', color: 'danger', isMoney: false, isPercent: true, sort: false, limit: 8 });
    drawSeries('dash-c-orders', d.sOrders, { type: 'line', additive: true, metrics: [{ label: 'Orders', key: 'orders', color: 'yellow' }], isMoney: false });
    drawSeries('dash-c-aov', d.sAov, { type: 'line', metrics: [{ label: 'AOV', key: 'aov', color: 'cyan' }], isMoney: true });
    drawRanked('dash-c-margin-brand', d.marginBrand, { listKeys: ['brands'], labelKey: 'brand', valueKey: 'margin_pct', color: 'magenta', isMoney: false, isPercent: true });
    drawRanked('dash-c-margin-category', d.marginCategory, { listKeys: ['categories'], labelKey: 'category', valueKey: 'margin_pct', color: 'magenta', isMoney: false, isPercent: true });
    drawShare('dash-c-traffic-source', d.trafficSource, { listKeys: ['sources'], labelKey: 'source', valueKey: 'sessions' });
    drawSeries('dash-c-cust-type', d.custType, { type: 'bar', stacked: true, additive: true, isMoney: true, metrics: [{ label: 'New', key: 'new_revenue', color: 'cyan' }, { label: 'Returning', key: 'returning_revenue', color: 'success' }] });
    drawRanked('dash-c-reorder', d.reorder, { listKeys: ['buckets'], labelKey: 'days_label', valueKey: 'customer_count', color: 'cyan', isMoney: false, horizontal: false, sort: false, limit: 24 });
    drawRanked('dash-c-search-top', d.searchTop, { listKeys: ['terms', 'searches'], labelKey: 'term', valueKey: 'searches', color: 'success', isMoney: false });
    drawRanked('dash-c-search-zero', d.searchZero, { listKeys: ['terms', 'searches'], labelKey: 'term', valueKey: 'searches', color: 'yellow', isMoney: false });
    drawSeries('dash-c-refund-rate', d.sRefundRate, { type: 'line', metrics: [{ label: 'Refund rate', key: 'refund_rate_pct', color: 'danger' }], isMoney: false, isPercent: true });
    drawShare('dash-c-refund-reasons', d.refunds, { listKeys: ['reasons'], labelKey: 'reason_code', valueKey: 'count' });
  } catch (e) {
    window.DebugLog?.warn?.('[Trends] chart draw error:', e?.message);
  }
}

function render(d) {
  const label = esc(rangeLabel());
  _container.innerHTML = `
    ${rowN('Products', 'cyan', [
      chartCard('Top SKUs by revenue', 'top 8', 'dash-c-sku-revenue', 4),
      chartCard('Top SKUs by gross profit', 'top 8', 'dash-c-sku-profit', 4),
      chartCard('Worst-margin SKUs', 'lowest net %', 'dash-c-sku-worst-margin', 4),
    ])}
    ${row('Search', 'magenta', chartCard('Top searches', 'by volume', 'dash-c-search-top'), chartCard('Zero-result searches', 'demand gaps', 'dash-c-search-zero'))}
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Operations <small>${label}</small></div>
      <div class="admin-dash">
        ${d.recentOrders == null ? failCard('Recent Orders', 'Recent orders could not be loaded.') : renderRecentOrdersCard(d.recentOrders)}
        ${d.trackingOrders == null ? failCard('Needs tracking', 'Orders awaiting tracking could not be loaded.') : renderFulfillmentCard(d)}
      </div>
    </section>
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Money <small>${label}</small></div>
      <div class="admin-dash">
        <div class="admin-dash__cell--6 admin-card">
          <div class="admin-card__title"><span>Revenue &amp; gross profit <small>over time</small></span></div>
          <div class="admin-chart-box"><canvas id="dash-c-revenue-profit"></canvas></div>
        </div>
        <div class="admin-dash__cell--6 admin-card">
          <div class="admin-card__title"><span>30-day revenue estimate <small>actual + projection · trend only, bands pending</small></span></div>
          <div class="admin-chart-box"><canvas id="dash-c-forecast"></canvas></div>
        </div>
      </div>
    </section>
    ${row('Sales', 'yellow', chartCard('Orders', 'over time', 'dash-c-orders'), chartCard('Average order value', 'over time', 'dash-c-aov'))}
    ${row('Margin', 'magenta', chartCard('Gross margin by brand', '%', 'dash-c-margin-brand'), chartCard('Gross margin by category', '%', 'dash-c-margin-category'))}
    ${row('Customers', 'cyan', chartCard('New vs returning revenue', 'over time', 'dash-c-cust-type'), chartCard('Reorder interval', 'days between orders', 'dash-c-reorder'))}
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Marketing <small>${label}</small></div>
      <div class="admin-dash">
        ${chartCard('Traffic by source', 'sessions · approx', 'dash-c-traffic-source')}
        ${renderTopProductsCard(d.topProducts)}
        ${renderFunnelCard(d.funnel)}
      </div>
    </section>
    ${row('Risk', 'danger', chartCard('Refund rate', 'over time', 'dash-c-refund-rate'), chartCard('Refund reasons', 'share', 'dash-c-refund-reasons'))}
  `;
  drawAll(d);
  wireOrderRowClicks(_container);
  wireTopProductsToggle(_container);
}

async function load() {
  if (!_container) return;
  const mySeq = ++_seq;
  FilterState.setBusy(true);
  try {
    const params = FilterState.getParams();
    const signal = FilterState.getAbortSignal();
    const from = params.get('from'), to = params.get('to');
    const g = resolveGranularity();
    const r = await Promise.allSettled([
      AdminAPI.getDashboardBundle(params, g, signal),                 // 0 graph charts
      AdminAPI.getBestSellers(params, signal),                        // 1 most-bought card
      AdminAPI.getConversionFunnel(signal),                           // 2 funnel (fixed 30-day window)
      AdminAPI.getOrders({ from, to }, 1, 8, signal),                 // 3 recent orders
      AdminAPI.getUnderMarginProducts('genuine', 1, 60, 'under-margin', 'net_margin', 'asc', signal),    // 4
      AdminAPI.getUnderMarginProducts('compatible', 1, 60, 'under-margin', 'net_margin', 'asc', signal), // 5
      AdminAPI.getRefundAnalytics(params, signal),                    // 6 refund reasons
      AdminAPI.getOrders({ from, to, statuses: ['paid', 'processing'] }, 1, 50, signal), // 7 needs tracking
    ]);
    if (mySeq !== _seq || !_container) return;   // superseded or left the tab
    const val = (i) => (r[i].status === 'fulfilled' ? r[i].value : null);
    const bundle = val(0);
    setEffectiveGranularity((bundle && bundle._granularity) || g);
    Charts.destroyAll();
    render({
      ...bundleToGraphs(bundle),
      topProducts: val(1), funnel: val(2), recentOrders: val(3),
      worstMarginSkus: normalizeWorstMargin([val(4), val(5)]),
      refunds: val(6), trackingOrders: val(7),
    });
  } finally {
    if (mySeq === _seq) FilterState.setBusy(false);
  }
}

export default {
  title: 'Trends',

  async init(container) {
    _container = container;
    FilterState.setGranularityVisible(true);
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:20vh"><div class="admin-loading__spinner"></div></div>';
    await load();
  },

  async onFilterChange() {
    if (_container) await load();
  },

  destroy() {
    Charts.destroyAll();
    FilterState.setGranularityVisible(false);
    FilterState.setBusy(false);
    _container = null;
    _seq++;   // any in-flight load now bails
  },
};
