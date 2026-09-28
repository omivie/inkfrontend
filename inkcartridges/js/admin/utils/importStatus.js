/**
 * Supplier feed import health — pure reading of
 * GET /api/admin/supplier/import-status (Ask 6, fixed by the backend on
 * 2026-09-25 as BF-070 h: backend-docs/inbox/fe-replies-round-backend-response-sep2026.md §2).
 *
 * Until 2026-09-25 the route matched `script_name IN ('genuine.js','compatible.js')`
 * while the importers log `genuine` / `compatible`, so it never matched and
 * every card read "No import data". Now each feed returns
 *   { latest, recent_runs: [ ≤5 runs, newest first ] }
 * and each run carries `status`, `dry_run`, `started_at`, `finished_at`,
 * `products_upserted`, `errors`, `warnings`, `feed_row_count`.
 *
 * `latest` is the latest run of ANY status. The backend's own warning: "Read its
 * status field: the genuine feed has had failed runs". Measured 2026-09-28: the
 * genuine feed failed on 09-23 and 09-26 (2 of its last 5) while `latest` read
 * `completed` — so a card that shows only `latest` shows a healthy feed that
 * fails every few days. This module reads the whole window.
 *
 * Tone, worst first:
 *   unknown  the read failed (null) — nothing is known, never "no data"
 *   none     the feed has no run on record
 *   bad      the latest real run failed, or the feed has not run in STALE_MS
 *   warn     a run in the window failed, or the latest run is a dry run
 *   ok       otherwise
 *
 * Dual export (ESM for the browser, `import()` in node tests). No build step.
 */

// ponytail: a fixed 48h staleness bound. Both feeds run nightly (~14:00 UTC,
// measured), so two missed nights is the signal. Make it per-feed if a feed's
// schedule changes.
const STALE_MS = 48 * 60 * 60 * 1000;

function runTime(run) {
  const t = Date.parse((run && (run.finished_at || run.started_at)) || '');
  return Number.isFinite(t) ? t : null;
}

function summarizeFeed(feed, now = Date.now()) {
  if (feed === null || feed === undefined) return { tone: 'none', latest: null, runs: [], failed: [], reasons: ['No import run on record.'] };
  const runs = Array.isArray(feed.recent_runs) ? feed.recent_runs : [];
  const latest = feed.latest || runs[0] || null;
  if (!latest) return { tone: 'none', latest: null, runs, failed: [], reasons: ['No import run on record.'] };

  const failed = runs.filter((r) => r && r.status === 'failed');
  const reasons = [];
  let tone = 'ok';
  const worse = (t) => { if (t === 'bad' || (t === 'warn' && tone === 'ok')) tone = t; };

  if (latest.status === 'failed') { worse('bad'); reasons.push('The latest run failed.'); }
  // Staleness is judged on the latest REAL run: a dry run moves no product.
  const lastReal = [latest, ...runs].find((r) => r && !r.dry_run) || null;
  const t = runTime(lastReal);
  if (t == null) { worse('warn'); reasons.push('No finished real run in the window.'); }
  else if (now - t > STALE_MS) { worse('bad'); reasons.push(`No real run in ${Math.floor((now - t) / 86400000)} days.`); }
  if (failed.length && latest.status !== 'failed') {
    worse('warn');
    reasons.push(`${failed.length} of the last ${runs.length} runs failed.`);
  }
  if (latest.dry_run) { worse('warn'); reasons.push('The latest run was a dry run: it changed no product.'); }
  return { tone, latest, runs, failed, reasons };
}

// null = the read itself failed. Absent keys are "no run on record", not zero.
function summarizeImportStatus(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;
  return {
    genuine: summarizeFeed(data.genuine, now),
    compatible: summarizeFeed(data.compatible, now),
  };
}

// ── HTML (Site Health → Infra, and the unrouted cc-inventory page) ─────────

function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-NZ');
}

const FEEDS = [
  { key: 'genuine', label: 'DSNZ (genuine)' },
  { key: 'compatible', label: 'Augmento (compatible)' },
];
const FEED_BADGE = { completed: 'delivered', failed: 'failed', running: 'pending' };

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function runRowHtml(r, esc) {
  return `<tr class="${r.status === 'failed' ? 'cc2-infra__runfail' : ''}">
    <td>${esc(fmtWhen(r.started_at))}</td>
    <td><span class="admin-badge admin-badge--${FEED_BADGE[r.status] || 'pending'}">${esc(r.status || 'unknown')}</span>${r.dry_run ? ' <span class="admin-badge admin-badge--pending" title="A dry run changes no product">dry run</span>' : ''}</td>
    <td class="num">${fmtNum(r.products_upserted)}</td>
    <td class="num">${fmtNum(r.feed_row_count)}</td>
    <td class="num ${r.errors > 0 ? 'cc2-infra__warn' : ''}">${fmtNum(r.errors)}</td>
  </tr>`;
}

/**
 * One card per supplier feed. `data === null` is a failed read and says so —
 * it is never rendered as "no runs". `esc` is the admin's HTML escaper, passed
 * in so this module stays importable (and testable) without the admin shell.
 */
function importFeedsHtml(data, esc, now = Date.now()) {
  const sum = summarizeImportStatus(data, now);
  if (!sum) {
    return `<article class="admin-card cc2-infra-card cc2-infra-card--unmeasured" role="alert">
      <header class="cc2-section-header"><h3>Supplier feeds</h3></header>
      <p class="cc2-infra__warn">Could not load import status. Nothing is known about the feeds, so this is not "no runs".</p>
    </article>`;
  }
  return FEEDS.map(({ key, label }) => {
    const f = sum[key];
    if (f.tone === 'none') {
      return `<article class="admin-card cc2-infra-card cc2-infra-card--warn">
        <header class="cc2-section-header"><h3>${esc(label)} feed</h3></header>
        <p class="cc2-infra__warn">No import run on record.</p>
      </article>`;
    }
    const l = f.latest;
    return `<article class="admin-card cc2-infra-card cc2-infra-card--${f.tone}" aria-labelledby="cc2-infra-feed-${key}">
      <header class="cc2-section-header">
        <h3 id="cc2-infra-feed-${key}">${esc(label)} feed</h3>
        <span class="admin-badge admin-badge--${FEED_BADGE[l.status] || 'pending'}">latest: ${esc(l.status || 'unknown')}</span>
      </header>
      ${f.reasons.length ? `<p class="${f.tone === 'bad' ? 'cc2-infra__bad' : 'cc2-infra__warn'}" role="${f.tone === 'bad' ? 'alert' : 'status'}">${f.reasons.map(esc).join(' ')}</p>` : ''}
      <div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>Started</th><th>Status</th><th class="num">Upserted</th><th class="num">Feed rows</th><th class="num">Errors</th></tr></thead>
        <tbody>${(f.runs.length ? f.runs : [l]).map((r) => runRowHtml(r, esc)).join('')}</tbody>
      </table></div>
    </article>`;
  }).join('');
}

const ImportStatus = { STALE_MS, summarizeFeed, summarizeImportStatus, importFeedsHtml };
export { STALE_MS, summarizeFeed, summarizeImportStatus, importFeedsHtml, ImportStatus };
export default ImportStatus;
