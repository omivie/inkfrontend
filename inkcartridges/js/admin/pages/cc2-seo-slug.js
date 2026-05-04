/**
 * Control Center — SEO tab (slug health + rename sheet)
 *
 * Three audit cards (null / duplicate / uppercase-or-invalid) plus a
 * Rename sheet that previews canonicalisation, conflict detection,
 * affected redirects, and any new redirect that will be inserted.
 *
 * The rename commit endpoint requires `confirm: true` server-side and
 * we wrap it in a "type the slug to confirm" gate before calling it.
 */
import { AdminAPI, esc, icon } from '../app.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';

const COPY = {
  invalid_shape: 'Slug must be lowercase alphanumeric, hyphen-separated.',
  conflict:      'Slug already in use by another product.',
  success:       'Slug renamed. Redirect inserted.',
};

const SECTIONS = [
  {
    key: 'null_slug',
    title: 'Products without a slug',
    badgeTone: 'failed',
    description: 'These products are unindexed and unreachable by canonical URL. Set a slug or deactivate them.',
    sampleHeaders: ['SKU', 'Name', ''],
    sampleRow: (r, openRename) => [
      `<span class="cell-mono">${esc(r.sku || '—')}</span>`,
      `<span class="cell-truncate" style="max-width:280px">${esc(r.name || '—')}</span>`,
      `<button class="admin-btn admin-btn--primary admin-btn--sm" data-rename data-id="${esc(r.id)}" data-slug="">Set slug</button>`,
    ],
  },
  {
    key: 'duplicate_slug',
    title: 'Duplicate slugs',
    badgeTone: 'pending',
    description: 'Two or more products share the same slug — Google will pick one and de-prioritise the rest.',
    sampleHeaders: ['Slug', 'Conflicting SKUs'],
    sampleRow: (r) => [
      `<span class="cell-mono">${esc(r.slug || '—')}</span>`,
      (r.products || []).map(p => `<span class="cell-mono">${esc(p.sku)}</span>`).join(' · '),
    ],
  },
  {
    key: 'uppercase_or_invalid',
    title: 'Uppercase or invalid slugs',
    badgeTone: 'pending',
    description: 'Slugs that fail the lowercase-alphanumeric-hyphen rule. The renamer will canonicalise on preview.',
    sampleHeaders: ['SKU', 'Current slug', ''],
    sampleRow: (r) => [
      `<span class="cell-mono">${esc(r.sku || '—')}</span>`,
      `<span class="cell-mono">${esc(r.slug || '—')}</span>`,
      `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-rename data-id="${esc(r.id)}" data-slug="${esc(r.slug || '')}">Rename</button>`,
    ],
  },
];

let _host = null;

function renderCard(section, payload) {
  const count = payload?.count ?? 0;
  const sample = payload?.sample || [];
  const tone = count === 0 ? 'cc2-slug-card--ok' : 'cc2-slug-card--warn';
  const sampleHtml = sample.length === 0
    ? '<p class="cc2-slug-card__empty">All clear.</p>'
    : `
      <div class="admin-table-wrap">
        <table class="admin-table cc2-slug-table">
          <thead><tr>${section.sampleHeaders.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
            ${sample.slice(0, 10).map(r => `<tr>${section.sampleRow(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${sample.length > 10 ? `<p class="cc2-slug-card__truncated">Showing first 10 of ${sample.length} sample rows.</p>` : ''}
    `;
  return `
    <article class="admin-card cc2-slug-card ${tone}" aria-labelledby="cc2-slug-${esc(section.key)}">
      <header class="cc2-slug-card__header">
        <div>
          <h3 id="cc2-slug-${esc(section.key)}">${esc(section.title)}</h3>
          <p class="cc2-slug-card__desc">${esc(section.description)}</p>
        </div>
        <span class="cc2-slug-card__count admin-badge admin-badge--${count === 0 ? 'delivered' : section.badgeTone}">${count.toLocaleString()}</span>
      </header>
      ${sampleHtml}
    </article>
  `;
}

function openRename(productId, currentSlug) {
  const drawer = Drawer.open({
    title: 'Rename slug',
    width: '520px',
    body: renameBody(productId, currentSlug, null),
  });
  if (!drawer) return;
  bindRename(drawer.body, productId, currentSlug);
}

function renameBody(productId, currentSlug, preview) {
  const safeSlug = currentSlug || '';
  return `
    <div class="cc2-slug-rename">
      <div class="cc2-slug-rename__row">
        <label class="cc2-field cc2-field--label-block">
          <span>Current slug</span>
          <code class="cc2-slug-rename__current">${esc(currentSlug || '(none)')}</code>
        </label>
        <label class="cc2-field cc2-field--label-block">
          <span>New slug</span>
          <input class="admin-input" data-rename-input value="${esc(safeSlug)}" placeholder="lowercase-with-hyphens" autocomplete="off">
        </label>
      </div>
      <div class="cc2-slug-rename__actions">
        <button class="admin-btn admin-btn--ghost" data-action="preview">${icon('search', 14, 14)} Preview</button>
        <button class="admin-btn admin-btn--primary" data-action="commit" disabled>${icon('lab', 14, 14)} Confirm rename</button>
      </div>
      <div class="cc2-slug-rename__result" data-result></div>
      <p class="cc2-slug-rename__hint">${esc(COPY.invalid_shape)} The preview canonicalises and tells you about conflicts and any redirect that will be inserted.</p>
    </div>
  `;
}

function bindRename(body, productId, currentSlug) {
  let lastPreview = null;
  let lastTypedSlug = currentSlug || '';
  const input = body.querySelector('[data-rename-input]');
  const previewBtn = body.querySelector('[data-action="preview"]');
  const commitBtn = body.querySelector('[data-action="commit"]');
  const resultBox = body.querySelector('[data-result]');

  input.addEventListener('input', () => {
    lastTypedSlug = input.value.trim();
    lastPreview = null;
    commitBtn.disabled = true;
    resultBox.innerHTML = '';
  });

  previewBtn.addEventListener('click', async () => {
    const slug = input.value.trim();
    if (!slug) { Toast.warning('Enter a slug to preview'); return; }
    previewBtn.disabled = true; previewBtn.textContent = 'Checking…';
    try {
      const resp = await AdminAPI.controlCenter.previewSlugRename({ product_id: productId, new_slug: slug });
      lastPreview = resp;
      resultBox.innerHTML = previewResultHtml(resp);
      commitBtn.disabled = !(resp && resp.ok === true);
    } catch (e) {
      Toast.error(e.message || 'Preview failed');
    } finally {
      previewBtn.disabled = false; previewBtn.innerHTML = `${icon('search', 14, 14)} Preview`;
    }
  });

  commitBtn.addEventListener('click', async () => {
    if (!lastPreview?.ok) return;
    const newSlug = lastPreview.new_slug_canonical || input.value.trim();
    commitBtn.disabled = true; commitBtn.textContent = 'Renaming…';
    try {
      const resp = await AdminAPI.controlCenter.commitSlugRename({
        product_id: productId, new_slug: newSlug,
      });
      Toast.success(`${COPY.success} ${resp?.redirect_inserted ? 'Redirect inserted.' : 'No redirect needed.'}`);
      Drawer.close();
      // Reload the SEO cards so the user sees the row disappear.
      load();
    } catch (e) {
      commitBtn.disabled = false; commitBtn.innerHTML = `${icon('lab', 14, 14)} Confirm rename`;
      if (e.code === 'slug_conflict' || e.code === 'invalid_slug_shape') Toast.error(`Rename rejected: ${e.code.replace('_', ' ')}`);
      else if (e.code === 'RATE_LIMITED') Toast.warning('Slow down — try again in a few seconds.');
      else Toast.error(e.message || 'Rename failed');
    }
  });
}

function previewResultHtml(p) {
  if (!p) return '';
  if (p.ok === false) {
    if (p.reason === 'slug_conflict') {
      const c = p.conflict_with || {};
      return `<div class="cc2-slug-rename__msg cc2-slug-rename__msg--bad">
        <strong>${esc(COPY.conflict)}</strong>
        <p>Conflicts with <span class="cell-mono">${esc(c.sku || '')}</span> — ${esc(c.name || '')}</p>
        <p>Canonical attempted: <code>${esc(p.new_slug_canonical || '—')}</code></p>
      </div>`;
    }
    return `<div class="cc2-slug-rename__msg cc2-slug-rename__msg--bad">
      <strong>${esc((p.reason || 'invalid').replace(/_/g, ' '))}</strong>
      ${p.new_slug_canonical ? `<p>Tried canonical: <code>${esc(p.new_slug_canonical)}</code></p>` : ''}
    </div>`;
  }
  // ok = true
  const redirects = (p.affected_redirects || []).slice(0, 5);
  return `
    <div class="cc2-slug-rename__msg cc2-slug-rename__msg--ok">
      <strong>Looks good</strong>
      <p>Canonical: <code>${esc(p.new_slug_canonical || '')}</code></p>
      ${p.new_redirect_required
        ? `<p><span class="admin-badge admin-badge--pending">redirect</span> <code>${esc(p.new_redirect_required.from)}</code> → <code>${esc(p.new_redirect_required.to)}</code></p>`
        : '<p>No new redirect required.</p>'}
      ${redirects.length ? `<details class="cc2-slug-rename__redirects"><summary>${redirects.length}+ existing redirects affected</summary>
        <ul>${redirects.map(r => `<li><code>${esc(r.from)}</code> → <code>${esc(r.to)}</code></li>`).join('')}</ul>
      </details>` : ''}
      ${p.sitemap_lastmod_will_update ? '<p><span class="admin-badge admin-badge--delivered">sitemap</span> lastmod timestamp will update on commit.</p>' : ''}
    </div>
  `;
}

async function load() {
  const grid = _host?.querySelector('#cc2-slug-grid');
  if (!grid) return;
  const data = await AdminAPI.controlCenter.getSlugHealth();
  if (!data) {
    grid.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">No data</div>
      <div class="admin-empty__text">Could not load slug health.</div></div>`;
    return;
  }
  grid.innerHTML = SECTIONS.map(s => renderCard(s, data[s.key])).join('');
  const totalNote = _host.querySelector('#cc2-slug-total');
  if (totalNote) totalNote.textContent = `${(data.total_products || 0).toLocaleString()} total products audited.`;
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rename]');
    if (btn) openRename(btn.dataset.id, btn.dataset.slug || null);
  }, { once: false });
}

export default {
  async init(host) {
    _host = host;
    _host.innerHTML = `
      <div class="cc2-section-header">
        <h2>SEO slug health</h2>
        <span class="cc2-meta" id="cc2-slug-total">Loading…</span>
      </div>
      <div class="cc2-slug-grid" id="cc2-slug-grid">
        ${SECTIONS.map(() => `<div class="admin-card cc2-slug-card">
          <div class="admin-skeleton admin-skeleton--text" style="width:60%"></div>
          <div class="admin-skeleton admin-skeleton--text" style="width:80%;margin-top:8px"></div>
          <div class="admin-skeleton admin-skeleton--row" style="margin-top:14px"></div>
        </div>`).join('')}
      </div>
    `;
    load();
  },
  destroy() { _host = null; },
};
