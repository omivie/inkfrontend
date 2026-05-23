/**
 * traffic-analytics.js — pure analysis helpers for the Website Traffic page
 * ========================================================================
 *
 * The admin Website Traffic page (pages/website-traffic.js) reads two backend
 * shapes and turns them into a marketer-readable picture:
 *
 *   1. /api/admin/analytics/traffic/timeseries?from&to
 *        → { ok, data: [ { date: 'YYYY-MM-DD', sessions, pageviews }, ... ] }
 *        Daily buckets only (the `granularity` param is ignored server-side).
 *        Backfilled to the day the first-party tracker launched; ranges with
 *        no data come back as `[]`.
 *
 *   2. /api/admin/analytics/traffic/summary?from&to
 *        → { ok, data: { sessions, pageviews, unique_visitors, bounce_rate,
 *                        avg_session_duration, device_breakdown[],
 *                        channel_breakdown[], browser_breakdown[],
 *                        os_breakdown[], top_pages[], top_referrers[],
 *                        campaign_visitors, campaign_visitor_percent } }
 *
 * Everything here is deliberately framework-free and DOM-free so it can be
 * unit-tested in isolation (tests/website-traffic-analytics.test.js). The page
 * controller owns fetching + rendering; this module owns the math and the
 * marketing judgement calls.
 *
 * Marketing intent (set by user 2026-05-22): the page must let a professional
 *   (a) see traffic direction over time at a glance,
 *   (b) read period-over-period growth, and
 *   (c) get told where to pull in MORE traffic and what already works best —
 * so we expose growth deltas + a prioritised, rule-driven insight feed.
 */

// ─── Time-series normalisation ───────────────────────────────────────────────

// Coerce the raw timeseries envelope into a clean, date-sorted array of
// { date, sessions, pageviews } with finite numbers. Tolerates the value being
// the bare array, `{ data: [...] }`, `{ series: [...] }`, null, or junk rows.
export function normalizeSeries(raw) {
  let rows = raw;
  if (rows && !Array.isArray(rows)) rows = rows.data || rows.series || rows.points || [];
  if (!Array.isArray(rows)) return [];
  const clean = [];
  for (const r of rows) {
    if (!r) continue;
    const date = r.date || r.day || r.bucket || r.t;
    if (!date) continue;
    clean.push({
      date: String(date),
      sessions: Number(r.sessions) || 0,
      pageviews: Number(r.pageviews ?? r.page_views) || 0,
    });
  }
  clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return clean;
}

// Trailing simple moving average. result[i] is the mean of the window ending at
// i; entries before a full window are null so a chart line only starts once the
// average is meaningful. Returns [] when the window can never fill.
export function movingAverage(values, window) {
  const out = [];
  const w = Math.max(1, Math.floor(window) || 1);
  if (!Array.isArray(values) || values.length < w) {
    return values && values.length ? values.map(() => null) : [];
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += Number(values[i]) || 0;
    if (i >= w) sum -= Number(values[i - w]) || 0;
    out.push(i >= w - 1 ? Math.round((sum / w) * 100) / 100 : null);
  }
  return out;
}

// Headline stats for the chart sub-line.
export function seriesTotals(series) {
  const s = Array.isArray(series) ? series : [];
  const days = s.length;
  const sessions = s.reduce((t, d) => t + (d.sessions || 0), 0);
  const pageviews = s.reduce((t, d) => t + (d.pageviews || 0), 0);
  let peak = null;
  for (const d of s) if (!peak || d.sessions > peak.sessions) peak = d;
  return {
    days,
    sessions,
    pageviews,
    avgSessionsPerDay: days ? sessions / days : 0,
    avgPageviewsPerDay: days ? pageviews / days : 0,
    pagesPerSession: sessions ? pageviews / sessions : 0,
    peak: peak ? { date: peak.date, sessions: peak.sessions } : null,
  };
}

// ─── Bucketing (chart granularity) ───────────────────────────────────────────
//
// The chart card lets the user choose 1 day / 1 week / 1 month per bar. The
// backend timeseries is daily-only, so we re-bucket client-side. All math is
// UTC day-arithmetic so DST never shifts a bucket boundary.
//
//   bucketSeries(series, 'day')   → identity passthrough (one bar per day)
//   bucketSeries(series, 'week')  → ISO Monday-start weeks
//   bucketSeries(series, 'month') → calendar months keyed YYYY-MM
//
// Every bucket carries:
//   { key, start, end, sessions, pageviews, days }
//     key   stable sort key + dataset label (YYYY-MM-DD for day/week, YYYY-MM for month)
//     start ISO date of first calendar day in the bucket (inclusive)
//     end   ISO date of last  calendar day in the bucket (inclusive)
//     days  number of days the source series contributed to this bucket
//
// `days` is the raw count of source rows that fell into the bucket — it is NOT
// the calendar span of the bucket. A partial week at either end of the window
// will have fewer than 7 days. This matters for "avg per bucket" UX copy: the
// renderer formats based on granularity, not on this number.
export const GRANULARITIES = Object.freeze(['day', 'week', 'month']);

// ms-per-day constant. Re-used by previousRange + bucketing.
const _DAY_MS = 86400000;

// UTC Monday-start of the week containing `ms`. Mirrors ISO 8601 (week starts
// Monday); chosen because NZ business weeks run Mon–Sun and our existing
// "7-day avg" pill already assumes a Monday-anchored window.
function _startOfIsoWeekUtc(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();              // 0 = Sun … 6 = Sat
  const back = day === 0 ? 6 : day - 1;   // days to roll back to Mon
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

function _iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

export function bucketSeries(series, granularity = 'day') {
  const rows = Array.isArray(series) ? series : [];
  const g = GRANULARITIES.includes(granularity) ? granularity : 'day';

  if (g === 'day') {
    return rows.map((d) => ({
      key: d.date,
      start: d.date,
      end: d.date,
      sessions: Number(d.sessions) || 0,
      pageviews: Number(d.pageviews) || 0,
      days: 1,
    }));
  }

  const map = new Map();
  for (const r of rows) {
    if (!r || !r.date) continue;
    const ms = Date.parse(r.date + 'T00:00:00Z');
    if (!Number.isFinite(ms)) continue;

    let key, startMs, endMs;
    if (g === 'week') {
      startMs = _startOfIsoWeekUtc(ms);
      endMs = startMs + 6 * _DAY_MS;
      key = _iso(startMs);
    } else { // month
      const d = new Date(ms);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth(); // 0-indexed
      startMs = Date.UTC(y, m, 1);
      endMs = Date.UTC(y, m + 1, 0); // day 0 of next month = last day of this
      key = `${y}-${String(m + 1).padStart(2, '0')}`;
    }

    let b = map.get(key);
    if (!b) {
      b = { key, start: _iso(startMs), end: _iso(endMs), sessions: 0, pageviews: 0, days: 0 };
      map.set(key, b);
    }
    b.sessions += Number(r.sessions) || 0;
    b.pageviews += Number(r.pageviews) || 0;
    b.days += 1;
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Direction of the sessions trend across the window: compares the mean of the
// first half against the mean of the second half. Returns null when there are
// too few points to say anything honest (<4 days).
export function trendDirection(series) {
  const s = Array.isArray(series) ? series : [];
  if (s.length < 4) return null;
  const mid = Math.floor(s.length / 2);
  const first = s.slice(0, mid);
  const second = s.slice(s.length - mid);
  const avg = (arr) => arr.reduce((t, d) => t + (d.sessions || 0), 0) / (arr.length || 1);
  const a = avg(first);
  const b = avg(second);
  if (a === 0) return { pct: b > 0 ? 100 : 0, dir: b > 0 ? 'up' : 'flat' };
  const pct = ((b - a) / a) * 100;
  return { pct, dir: pct > 2 ? 'up' : pct < -2 ? 'down' : 'flat' };
}

// ─── Period-over-period ──────────────────────────────────────────────────────

// The equal-length window immediately preceding [from, to] (inclusive dates).
// Used to fetch the previous summary and compute growth deltas. All math is in
// UTC day-arithmetic so DST never shifts a bucket boundary.
export function previousRange(from, to) {
  const DAY = 86400000;
  const f = Date.parse(from + 'T00:00:00Z');
  const t = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) return null;
  const lengthDays = Math.round((t - f) / DAY) + 1; // inclusive
  const prevTo = f - DAY;
  const prevFrom = prevTo - (lengthDays - 1) * DAY;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(prevFrom), to: iso(prevTo) };
}

// Signed % change with a sentiment direction. `invert` flips good/bad colouring
// for metrics where lower is better (bounce rate). Returns null when there is no
// comparable previous value, so the UI can simply omit the badge.
export function pctChange(current, previous, invert = false) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  const pct = ((cur - prev) / prev) * 100;
  const increased = pct > 0;
  const flat = Math.abs(pct) < 0.5;
  // `good` drives the green/red class: an increase is good unless inverted.
  const good = flat ? null : (increased !== invert);
  return {
    pct,
    increased,
    dir: flat ? 'flat' : good ? 'up' : 'down', // colour class suffix
    arrow: flat ? '→' : increased ? '▲' : '▼', // arrow follows the raw number
  };
}

// Build the full set of KPI deltas from current + previous summaries.
export function computeDeltas(current, previous) {
  const cur = current || {};
  const prev = previous || {};
  return {
    sessions: pctChange(cur.sessions, prev.sessions),
    pageviews: pctChange(cur.pageviews, prev.pageviews),
    unique_visitors: pctChange(cur.unique_visitors, prev.unique_visitors),
    avg_session_duration: pctChange(cur.avg_session_duration, prev.avg_session_duration),
    bounce_rate: pctChange(cur.bounce_rate, prev.bounce_rate, /* invert */ true),
  };
}

// ─── Channel mix ─────────────────────────────────────────────────────────────

// Normalise channel_breakdown into shares keyed by lowercase channel name plus
// the dominant channel. Used by both the insight engine and tests.
export function channelMix(channelBreakdown) {
  const rows = Array.isArray(channelBreakdown) ? channelBreakdown : [];
  const total = rows.reduce((t, r) => t + (Number(r.count) || 0), 0);
  const byName = {};
  let top = null;
  for (const r of rows) {
    const key = String(r.channel || 'unknown').toLowerCase();
    const count = Number(r.count) || 0;
    const share = total ? (count / total) * 100 : 0;
    byName[key] = { count, share };
    if (!top || count > top.count) top = { channel: r.channel || 'Unknown', count, share };
  }
  return { total, byName, top };
}

// ─── Insight engine ──────────────────────────────────────────────────────────

// Severity → sort weight. "opportunity" (where to win more traffic) leads,
// then "watch" (problems eating traffic), then "win" (double-down signals),
// then "info" (data hygiene / context).
const SEVERITY_ORDER = { opportunity: 0, watch: 1, win: 2, info: 3 };

// Tunable thresholds — kept as a named object so a test can pin them and a
// future tweak is a one-line change rather than a hunt through conditionals.
export const INSIGHT_THRESHOLDS = {
  organicLowShare: 20,    // % of sessions below which organic is "under-indexed"
  directHighShare: 60,    // % above which direct dependence is a concentration risk
  mobileLowShare: 30,     // % below which mobile reach looks thin for e-commerce
  bounceHigh: 60,         // % above which bounce rate is a watch item
  bounceGreat: 40,        // % below which bounce rate is a genuine win
  topPageConcentration: 45, // % of pageviews on a single path = concentration
  minSessionsForStats: 30,  // below this the window is too thin to advise on
};

// Produce a prioritised, de-duplicated list of marketing insights. Pure: takes
// the already-fetched summary, the normalised series and the computed deltas,
// returns [{ id, severity, title, detail }]. Never throws on partial data.
export function generateInsights({ summary, series, deltas } = {}) {
  const s = summary || {};
  const out = [];
  const T = INSIGHT_THRESHOLDS;
  const totalSessions = Number(s.sessions) || 0;

  if (totalSessions < T.minSessionsForStats) {
    out.push({
      id: 'thin-data',
      severity: 'info',
      title: 'Not enough traffic yet to advise',
      detail: `Only ${totalSessions.toLocaleString('en-NZ')} sessions in this window. Widen the date range or wait for more data before acting on the breakdowns below.`,
    });
    return out;
  }

  const mix = channelMix(s.channel_breakdown);
  const organic = mix.byName.organic || mix.byName['organic search'] || null;
  const direct = mix.byName.direct || null;
  const referral = mix.byName.referral || null;
  const paid = mix.byName.paid || mix.byName.cpc || mix.byName.ads || null;
  const social = mix.byName.social || null;

  // 1. Organic search under-indexed → biggest SEO upside.
  if (organic && organic.share < T.organicLowShare) {
    out.push({
      id: 'organic-low',
      severity: 'opportunity',
      title: `Organic search is only ${organic.share.toFixed(1)}% of traffic`,
      detail: `Search is your cheapest long-run channel and it is under-indexed. Prioritise on-page SEO, product schema and content for high-intent printer/cartridge queries to grow this share.`,
    });
  } else if (!organic) {
    out.push({
      id: 'organic-none',
      severity: 'opportunity',
      title: 'No organic search traffic recorded',
      detail: 'Either search engines are not indexing the site or organic visits are being misattributed. Check Google Search Console coverage and canonical tags.',
    });
  }

  // 2. No campaign-attributed visitors → email/paid not driving (or not tagged).
  const campaignVisitors = Number(s.campaign_visitors) || 0;
  if (campaignVisitors === 0) {
    out.push({
      id: 'no-campaigns',
      severity: 'opportunity',
      title: 'Zero campaign-attributed visitors',
      detail: 'No traffic is tagged to an email or ad campaign this period. Add UTM tags to outbound links and run a campaign — untracked spend can\'t be optimised.',
    });
  }

  // 3. Heavy reliance on direct → concentration risk + likely lost attribution.
  if (direct && direct.share > T.directHighShare) {
    out.push({
      id: 'direct-heavy',
      severity: 'watch',
      title: `Direct traffic is ${direct.share.toFixed(1)}% of sessions`,
      detail: 'A direct share this high usually hides untagged campaigns and stripped referrers, not just loyal repeat visitors. Tag campaigns with UTMs and diversify acquisition so a single channel isn\'t carrying the business.',
    });
  }

  // 4. Mobile reach looks thin.
  const devices = Array.isArray(s.device_breakdown) ? s.device_breakdown : [];
  const devTotal = devices.reduce((t, d) => t + (Number(d.count) || 0), 0);
  const mobileRow = devices.find((d) => String(d.device).toLowerCase() === 'mobile');
  const mobileShare = devTotal && mobileRow ? (Number(mobileRow.count) / devTotal) * 100 : null;
  if (mobileShare != null && mobileShare < T.mobileLowShare) {
    out.push({
      id: 'mobile-thin',
      severity: 'watch',
      title: `Mobile is only ${mobileShare.toFixed(1)}% of sessions`,
      detail: 'E-commerce traffic usually skews mobile. A low mobile share can mean poor mobile SEO, slow mobile pages, or ads pointed at desktop. Audit mobile speed and discoverability.',
    });
  }

  // 5. Bounce rate.
  const bounce = Number(s.bounce_rate);
  if (Number.isFinite(bounce)) {
    if (bounce > T.bounceHigh) {
      out.push({
        id: 'bounce-high',
        severity: 'watch',
        title: `Bounce rate is ${bounce.toFixed(1)}%`,
        detail: 'More than six in ten visitors leave after one page. Check landing-page relevance, page speed and that ads/keywords match what the page actually offers.',
      });
    } else if (bounce < T.bounceGreat) {
      out.push({
        id: 'bounce-great',
        severity: 'win',
        title: `Strong ${bounce.toFixed(1)}% bounce rate`,
        detail: 'Visitors are engaging past the first page. Whatever is driving this traffic is well-matched to the site — feed it more budget.',
      });
    }
  }

  // 6. What pulls in the most → double down (the "increase what works" ask).
  if (mix.top && mix.top.count > 0) {
    out.push({
      id: 'top-channel',
      severity: 'win',
      title: `${mix.top.channel} drives the most traffic (${mix.top.share.toFixed(1)}%)`,
      detail: `${mix.top.channel} is your strongest channel. Invest more where it already converts — protect and grow this source rather than starting from zero elsewhere.`,
    });
  }

  // 7. Referral as the strongest non-direct, non-organic lever.
  if (referral && referral.share >= 10 && (!mix.top || String(mix.top.channel).toLowerCase() !== 'referral')) {
    out.push({
      id: 'referral-lever',
      severity: 'win',
      title: `Referrals contribute ${referral.share.toFixed(1)}% of sessions`,
      detail: 'Referral traffic is warm and cheap. Look at the Top Referrers table below and build relationships (or backlinks/partnerships) with the sites already sending visitors.',
    });
  }

  // 8. Single-page concentration.
  const topPages = Array.isArray(s.top_pages) ? s.top_pages : [];
  const pvTotal = Number(s.pageviews) || topPages.reduce((t, p) => t + (Number(p.pageviews) || 0), 0);
  if (topPages.length && pvTotal) {
    const lead = topPages[0];
    const leadShare = (Number(lead.pageviews) / pvTotal) * 100;
    if (leadShare > T.topPageConcentration) {
      out.push({
        id: 'page-concentration',
        severity: 'info',
        title: `${leadShare.toFixed(0)}% of pageviews land on ${lead.path || '/'}`,
        detail: 'Traffic is concentrated on one page. Make sure it routes visitors deeper (clear CTAs to category/product pages) so that attention converts.',
      });
    }
  }

  // 9. Self-referral data hygiene (own domain showing up as a referrer).
  const refs = Array.isArray(s.top_referrers) ? s.top_referrers : [];
  const selfRef = refs.find((r) => /inkcartridges\.co\.nz/i.test(String(r.referrer_host || '')));
  if (selfRef) {
    out.push({
      id: 'self-referral',
      severity: 'info',
      title: 'Your own domain appears as a top referrer',
      detail: 'Self-referrals usually mean a cross-subdomain hop or a redirect is dropping the original source/UTMs. Fixing it will move that traffic back to its true channel and sharpen every number above.',
    });
  }

  // 10. Trend direction from the time series (only when we have one).
  const trend = trendDirection(series);
  if (trend) {
    if (trend.dir === 'down') {
      out.push({
        id: 'trend-down',
        severity: 'watch',
        title: `Sessions trending down ${Math.abs(trend.pct).toFixed(0)}% across the window`,
        detail: 'Second-half daily sessions are below the first half. Check for a ranking drop, a paused campaign, or seasonality before it compounds.',
      });
    } else if (trend.dir === 'up') {
      out.push({
        id: 'trend-up',
        severity: 'win',
        title: `Sessions trending up ${trend.pct.toFixed(0)}% across the window`,
        detail: 'Daily sessions are climbing. Identify what changed (content, campaign, season) and keep doing it.',
      });
    }
  }

  // Stable, deterministic ordering: severity weight, then insertion order.
  return out
    .map((ins, i) => ({ ...ins, _i: i }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a._i - b._i))
    .map(({ _i, ...ins }) => ins);
}

// Allow the test harness (which strips `export`) to reach these without ESM.
// In the browser this is a harmless no-op assignment to the module scope.
/* c8 ignore next */
export default {
  normalizeSeries, movingAverage, seriesTotals, trendDirection,
  previousRange, pctChange, computeDeltas, channelMix, generateInsights,
  bucketSeries, GRANULARITIES, INSIGHT_THRESHOLDS,
};
