/**
 * Legal Content Page — Owner-only: edit text on every footer-linked
 * policy/info page (/about /terms /privacy /returns /shipping /faq
 * /contact) plus the single-source-of-truth "Site Facts" used by
 * legal-config.js.
 *
 * Spec: readfirst/legal-content-cms-may2026.md
 * Backed by Supabase table `legal_content_overrides` (RLS public read,
 * authenticated write — same pattern as site_settings).
 */
import { AdminAuth, FilterState, esc } from '../app.js';
import { Toast } from '../components/toast.js';

const TABLE = 'legal_content_overrides';

const PAGE_TABS = [
  { slug: 'about',    label: 'About',    title: 'About Us' },
  { slug: 'terms',    label: 'Terms',    title: 'Terms of Service' },
  { slug: 'privacy',  label: 'Privacy',  title: 'Privacy Policy' },
  { slug: 'returns',  label: 'Returns',  title: 'Refund & Return Policy' },
  { slug: 'shipping', label: 'Shipping', title: 'Shipping & Delivery' },
  { slug: 'faq',      label: 'FAQ',      title: 'Frequently Asked Questions' },
  { slug: 'contact',  label: 'Contact',  title: 'Contact Us' },
];

// Order matters — rendered as the form on the Site Facts tab.
const SITE_FACT_FIELDS = [
  { group: 'Identity', fields: [
    { key: 'tradingName',    label: 'Trading name' },
    { key: 'legalEntity',    label: 'Legal entity' },
    { key: 'gstNumber',      label: 'GST number',  hint: 'e.g. 123-456-789. Empty hides the line.' },
    { key: 'nzbn',           label: 'NZBN',        hint: 'e.g. 9429012345678. Empty hides the line.' },
  ]},
  { group: 'Office address', fields: [
    { key: 'address.street',   label: 'Street'   },
    { key: 'address.suburb',   label: 'Suburb'   },
    { key: 'address.city',     label: 'City'     },
    { key: 'address.postcode', label: 'Postcode' },
    { key: 'address.country',  label: 'Country'  },
  ]},
  { group: 'Phone & email', fields: [
    { key: 'phoneDisplay',  label: 'Phone (display)', hint: 'e.g. 027 474 0115' },
    { key: 'phoneE164',     label: 'Phone (E.164)',   hint: 'e.g. +64274740115 — used for tel: links' },
    { key: 'email',         label: 'Email' },
    { key: 'hoursDisplay',  label: 'Hours (display)' },
    { key: 'responseSLA',   label: 'Response SLA',    hint: 'e.g. "within one business day"' },
  ]},
  { group: 'Commercial', fields: [
    { key: 'freeShippingThreshold', label: 'Free shipping threshold', hint: 'NZD, integer or decimal — used in pricing copy.' },
    { key: 'policyEffectiveDate',   label: 'Policy effective date',   hint: 'ISO date YYYY-MM-DD — renders as "5 May 2026".' },
    { key: 'policyVersion',         label: 'Policy version',          hint: 'Free text — appears in policy headers.' },
  ]},
  { group: 'Privacy officer', fields: [
    { key: 'privacyOfficerName',  label: 'Privacy officer name'  },
    { key: 'privacyOfficerEmail', label: 'Privacy officer email' },
  ]},
];

let _container = null;
let _currentTab = 'about';
let _overrides = {};                           // map of key → row
let _defaultsCache = {};                       // map of slug → { hero, sections: [{id, title, html}] }
let _legalConfigDefaults = null;               // cloned LegalConfig at first load

function getSb() {
  return (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
}

function setHtml(html) {
  if (_container) _container.innerHTML = html;
}

// ─── Boot ─────────────────────────────────────────────────────────────
async function load() {
  setHtml(`
    <div class="admin-page-header"><h1>Legal Content</h1></div>
    <div style="display:flex;align-items:center;justify-content:center;min-height:30vh">
      <div class="admin-loading__spinner"></div>
    </div>
  `);

  // Snapshot LegalConfig so the Site Facts tab can show defaults.
  if (!_legalConfigDefaults && typeof window.LegalConfig !== 'undefined') {
    _legalConfigDefaults = JSON.parse(JSON.stringify(window.LegalConfig));
  }
  if (!_legalConfigDefaults) {
    // legal-config.js isn't loaded on /admin (the admin shell only pulls
    // its own modules). Fetch and eval it once so we know the defaults.
    _legalConfigDefaults = await fetchLegalConfigDefaults();
  }

  await loadOverrides();
  if (!_container) return;
  render();
}

async function loadOverrides() {
  const sb = getSb();
  if (!sb) return;

  let data, error;
  try {
    ({ data, error } = await sb.from(TABLE).select('key, value, updated_at, updated_by'));
  } catch (e) { error = e; }

  if (!_container) return;

  if (error) {
    renderTableMissing(error.message || String(error));
    throw error;
  }

  _overrides = {};
  (data || []).forEach((r) => { _overrides[r.key] = r; });
}

function renderTableMissing(message) {
  setHtml(`
    <div class="admin-page-header">
      <h1>Legal Content</h1>
      <p class="admin-page-header__sub">Edit the text on every policy / about / FAQ / contact page.</p>
    </div>
    <div class="admin-card" style="padding:var(--spacing-md);border-left:4px solid #f59e0b">
      <p style="font-weight:700;margin:0 0 10px;font-size:14px">Setup required</p>
      <p style="color:var(--text-secondary);margin:0 0 14px;font-size:13px;line-height:1.6">
        The <code>legal_content_overrides</code> table doesn't exist in Supabase yet. Run the SQL below in
        <strong>Supabase Studio → SQL Editor</strong>, then reload this page.
      </p>
      <pre style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;font-size:12px;overflow-x:auto;line-height:1.6;margin:0 0 14px;white-space:pre">CREATE TABLE IF NOT EXISTS public.legal_content_overrides (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES auth.users(id)
);

ALTER TABLE public.legal_content_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read legal_content_overrides"
  ON public.legal_content_overrides FOR SELECT USING (true);

CREATE POLICY "Authenticated write legal_content_overrides"
  ON public.legal_content_overrides FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS legal_content_overrides_updated_at_idx
  ON public.legal_content_overrides (updated_at DESC);</pre>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">${esc(message)}</p>
      <button class="admin-btn admin-btn--primary admin-btn--sm" onclick="location.reload()">Reload after running SQL</button>
    </div>
  `);
}

// ─── Default-content extraction ───────────────────────────────────────
async function loadDefaults(slug) {
  if (_defaultsCache[slug]) return _defaultsCache[slug];

  // Fetch the live HTML — same-origin so no CORS issue, and the file is
  // already cached for the page-shell anyway.
  const path = '/' + slug;
  let html;
  try {
    const resp = await fetch(path, { headers: { 'Accept': 'text/html' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    // Network / 404 — fall back to /html/<slug>.html which serve.json maps to.
    const resp2 = await fetch('/html/' + slug + '.html');
    html = resp2.ok ? await resp2.text() : '';
  }

  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const hero = doc.querySelector('.legal-page__hero, .about-hero, .contact-page__header');
  const sections = Array.from(doc.querySelectorAll('.policy-section[id]')).map((sec) => ({
    id: sec.id,
    title: (sec.querySelector('h2') || {}).textContent || sec.id,
    html: sec.innerHTML.trim(),
  }));

  _defaultsCache[slug] = {
    hero: hero ? hero.innerHTML.trim() : '',
    sections,
  };
  return _defaultsCache[slug];
}

async function fetchLegalConfigDefaults() {
  // legal-config.js declares window.LegalConfig as IIFE — fetch and
  // run it inside a sandbox to read the defaults without touching the
  // admin's runtime globals.
  try {
    const resp = await fetch('/js/legal-config.js');
    if (!resp.ok) return {};
    const src = await resp.text();
    const sandbox = {};
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'globalThis', src + '\nreturn window.LegalConfig || globalThis.LegalConfig;');
    const cfg = fn(sandbox, sandbox);
    return cfg || {};
  } catch (_) {
    return {};
  }
}

// ─── Render ───────────────────────────────────────────────────────────
function render() {
  if (!_container) return;

  let html = `
    <div class="admin-page-header">
      <h1>Legal Content</h1>
      <p class="admin-page-header__sub">
        Each editor opens with the live page content already loaded —
        edit text in <strong>Visual</strong> mode, or switch to <strong>Source HTML</strong> for tag-level control.
        <strong>Save</strong> publishes; <strong>Reset to default</strong> deletes the override and reloads the source-HTML default.
      </p>
    </div>

    <div class="admin-tab-bar" id="lc-tabs" style="overflow-x:auto;flex-wrap:nowrap">
      ${PAGE_TABS.map((t) => `
        <button type="button" class="admin-tab-bar__btn ${t.slug === _currentTab ? 'active' : ''}" data-tab="${esc(t.slug)}">
          ${esc(t.label)}
          ${overrideCountForPage(t.slug) > 0 ? `<span class="lc-badge">${overrideCountForPage(t.slug)}</span>` : ''}
        </button>
      `).join('')}
      <button type="button" class="admin-tab-bar__btn ${_currentTab === '_facts' ? 'active' : ''}" data-tab="_facts">
        Site Facts
        ${overrideCountForFacts() > 0 ? `<span class="lc-badge">${overrideCountForFacts()}</span>` : ''}
      </button>
    </div>

    <div id="lc-tab-body"></div>
  `;

  _container.innerHTML = html + lcStyleBlock();
  bindTabs();
  renderTab();
}

function overrideCountForPage(slug) {
  const heroKey = slug + '.hero';
  const prefix = slug + '.section.';
  let n = 0;
  for (const k of Object.keys(_overrides)) {
    if (k === heroKey || k.indexOf(prefix) === 0) n++;
  }
  return n;
}

function overrideCountForFacts() {
  let n = 0;
  for (const k of Object.keys(_overrides)) {
    if (k.indexOf('site_facts.') === 0) n++;
  }
  return n;
}

function bindTabs() {
  _container.querySelectorAll('#lc-tabs [data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _currentTab = btn.dataset.tab;
      render();
    });
  });
}

async function renderTab() {
  const body = _container.querySelector('#lc-tab-body');
  if (!body) return;
  if (_currentTab === '_facts') {
    body.innerHTML = renderFactsTab();
    bindFactsHandlers();
    return;
  }

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
      <div class="admin-loading__spinner"></div>
    </div>
  `;
  let defaults;
  try {
    defaults = await loadDefaults(_currentTab);
  } catch (e) {
    body.innerHTML = `<div class="admin-card" style="padding:var(--spacing-md);color:var(--color-error,#dc2626)">Failed to load defaults: ${esc(e.message || String(e))}</div>`;
    return;
  }
  if (!_container || _container.querySelector('#lc-tab-body') !== body) return;

  body.innerHTML = renderPageTab(_currentTab, defaults);
  bindPageHandlers(_currentTab, defaults);
}

function renderPageTab(slug, defaults) {
  const tab = PAGE_TABS.find((t) => t.slug === slug);
  const heroKey = slug + '.hero';
  const heroOverride = _overrides[heroKey];

  const heroCard = renderEditorCard({
    key: heroKey,
    title: 'Hero — page heading + lead paragraph',
    subtitle: tab.title + ' — first block on the page',
    defaultHtml: defaults.hero,
    overrideHtml: heroOverride ? heroOverride.value : '',
    updatedAt: heroOverride ? heroOverride.updated_at : null,
  });

  const sectionCards = defaults.sections.map((sec) => {
    const k = slug + '.section.' + sec.id;
    const o = _overrides[k];
    return renderEditorCard({
      key: k,
      title: sec.title.trim(),
      subtitle: '#' + sec.id,
      defaultHtml: sec.html,
      overrideHtml: o ? o.value : '',
      updatedAt: o ? o.updated_at : null,
    });
  }).join('');

  return `
    <div class="lc-page-meta admin-card" style="padding:14px 16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted)">Editing</div>
        <div style="font-size:16px;font-weight:600;margin-top:2px">${esc(tab.title)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
          ${defaults.sections.length} section${defaults.sections.length === 1 ? '' : 's'} ·
          ${overrideCountForPage(slug)} override${overrideCountForPage(slug) === 1 ? '' : 's'} live
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="admin-btn admin-btn--ghost admin-btn--sm" href="/${esc(slug)}" target="_blank" rel="noopener">Open live page ↗</a>
      </div>
    </div>
    ${heroCard}
    ${sectionCards}
  `;
}

function renderEditorCard({ key, title, subtitle, defaultHtml, overrideHtml, updatedAt }) {
  const hasOverride = overrideHtml && overrideHtml.length > 0;
  // Pre-fill the editor with what visitors see right now: the override
  // if one exists, otherwise the source-HTML default. Empty editor on
  // first open was confusing — admins want to edit in place, not stare
  // at a blank box.
  const liveHtml = hasOverride ? overrideHtml : defaultHtml;
  const rows = Math.min(30, Math.max(10, (liveHtml.match(/\n/g) || []).length + 4));
  return `
    <article class="admin-card lc-card" data-key="${esc(key)}" data-default="${esc(defaultHtml)}" style="margin-bottom:16px">
      <header class="lc-card__head">
        <div>
          <div class="lc-card__title">${esc(title)}</div>
          <div class="lc-card__subtitle">
            <span class="lc-key">${esc(key)}</span>
            ${subtitle ? ` · <span style="color:var(--text-muted)">${esc(subtitle)}</span>` : ''}
            ${hasOverride
              ? `<span class="lc-pill lc-pill--on" data-pill>Override active${updatedAt ? ' · ' + esc(formatDate(updatedAt)) : ''}</span>`
              : `<span class="lc-pill" data-pill>Showing default</span>`}
          </div>
        </div>
        <div class="lc-card__actions">
          <div class="lc-mode" role="tablist" aria-label="Editor mode">
            <button type="button" class="lc-mode__btn active" data-mode="visual" role="tab" aria-selected="true">Visual</button>
            <button type="button" class="lc-mode__btn" data-mode="source" role="tab" aria-selected="false">Source HTML</button>
          </div>
          <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-action="preview" title="Open in a popup with the live page styles">Preview</button>
          <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-action="reset" title="Discard current edits — re-loads the default copy and (if there's an override) deletes it on save" ${hasOverride ? '' : 'disabled'}>Reset to default</button>
          <button type="button" class="admin-btn admin-btn--primary admin-btn--sm" data-action="save">Save</button>
        </div>
      </header>

      <div class="lc-editor-wrap" data-editor-wrap>
        <div
          class="lc-visual"
          contenteditable="true"
          spellcheck="true"
          data-mode-pane="visual"
          aria-label="Visual editor — click to edit text directly"
        >${liveHtml}</div>
        <textarea
          class="lc-source"
          rows="${rows}"
          spellcheck="false"
          data-mode-pane="source"
          hidden
        >${esc(liveHtml)}</textarea>
      </div>

      <details class="lc-default-ref">
        <summary>Show original default (read-only reference)</summary>
        <div class="lc-default__rendered">${defaultHtml}</div>
        <div class="lc-default__label" style="margin-top:10px">Raw HTML</div>
        <pre class="lc-default__source"><code>${esc(defaultHtml)}</code></pre>
      </details>

      <footer class="lc-card__foot">
        <span class="lc-dirty" data-dirty hidden>Unsaved changes</span>
        <span class="lc-status" data-status></span>
      </footer>
    </article>
  `;
}

function renderFactsTab() {
  const cfg = _legalConfigDefaults || {};
  let html = `
    <div class="lc-page-meta admin-card" style="padding:14px 16px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted)">Editing</div>
      <div style="font-size:16px;font-weight:600;margin-top:2px">Site facts</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:6px;line-height:1.5">
        These values feed every <code>data-legal-bind</code> across all 7 pages and the footer.
        Leave a field empty to fall back to the source-file default.
      </div>
    </div>
  `;

  for (const group of SITE_FACT_FIELDS) {
    html += `<article class="admin-card lc-facts-group" style="margin-bottom:16px">
      <header class="lc-card__head">
        <div class="lc-card__title">${esc(group.group)}</div>
      </header>
      <div class="lc-facts-grid">`;
    for (const f of group.fields) {
      const fullKey = 'site_facts.' + f.key;
      const o = _overrides[fullKey];
      const def = factDefault(f.key, cfg);
      const v = o ? o.value : '';
      html += `
        <label class="lc-fact" data-fact-key="${esc(f.key)}" data-full-key="${esc(fullKey)}">
          <span class="lc-fact__label">
            ${esc(f.label)}
            ${o ? `<span class="lc-pill lc-pill--on">override</span>` : ''}
          </span>
          ${f.hint ? `<span class="lc-fact__hint">${esc(f.hint)}</span>` : ''}
          <input class="admin-input lc-fact__input" type="text" value="${esc(v)}" placeholder="${esc(def == null ? '' : String(def))}">
          <span class="lc-fact__default">Default: <code>${esc(def == null ? '—' : String(def))}</code></span>
        </label>
      `;
    }
    html += `</div></article>`;
  }

  html += `
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="lc-facts-reset-all">Reset all overrides</button>
      <button type="button" class="admin-btn admin-btn--primary admin-btn--sm" id="lc-facts-save-all">Save all changes</button>
    </div>
  `;
  return html;
}

function factDefault(key, cfg) {
  if (key.indexOf('address.') === 0) {
    const sub = key.slice('address.'.length);
    return (cfg.address || {})[sub];
  }
  return cfg[key];
}

// ─── Handlers ─────────────────────────────────────────────────────────
function bindPageHandlers(slug, defaults) {
  const body = _container.querySelector('#lc-tab-body');
  if (!body) return;

  body.querySelectorAll('.lc-card').forEach((card) => {
    const key = card.dataset.key;
    const defaultHtml = defaultHtmlForKey(key, defaults);
    const visual = card.querySelector('.lc-visual');
    const source = card.querySelector('.lc-source');
    const dirty = card.querySelector('[data-dirty]');
    const status = card.querySelector('[data-status]');
    const resetBtn = card.querySelector('[data-action="reset"]');
    const pill = card.querySelector('[data-pill]');

    let mode = 'visual';
    let initial = currentValueOf(visual, source, mode);

    function currentValue() { return currentValueOf(visual, source, mode); }
    function markDirty() {
      const isDirty = currentValue() !== initial;
      dirty.hidden = !isDirty;
    }

    // Mode toggle
    card.querySelectorAll('.lc-mode__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.mode;
        if (next === mode) return;
        // Sync the value across before swapping panes so edits aren't
        // lost when the admin flips between Visual and Source.
        if (mode === 'visual' && next === 'source') {
          source.value = visual.innerHTML;
        } else if (mode === 'source' && next === 'visual') {
          visual.innerHTML = source.value;
        }
        mode = next;
        card.querySelectorAll('.lc-mode__btn').forEach((b) => {
          const on = b.dataset.mode === mode;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        visual.hidden = mode !== 'visual';
        source.hidden = mode !== 'source';
        if (mode === 'visual') visual.focus(); else source.focus();
      });
    });

    // Dirty tracking — fires on text change in either pane.
    visual.addEventListener('input', markDirty);
    source.addEventListener('input', markDirty);

    // Preview
    card.querySelector('[data-action="preview"]').addEventListener('click', () => {
      openPreview(key, currentValue());
    });

    // Reset to default — clears the override on the server and reloads
    // default copy into the editor. If there's no override yet, this
    // just discards local edits without a network call.
    resetBtn.addEventListener('click', async () => {
      const hadOverride = !!_overrides[key];
      const message = hadOverride
        ? `Reset "${key}" — delete the override on the server and reload the default copy into the editor?`
        : `Discard local edits and reload the default copy?`;
      if (!confirm(message)) return;
      try {
        if (hadOverride) await resetOverride(key);
        // Reload defaults into both panes so visual ↔ source stay in sync.
        visual.innerHTML = defaultHtml;
        source.value = defaultHtml;
        initial = defaultHtml;
        dirty.hidden = true;
        if (pill) {
          pill.textContent = 'Showing default';
          pill.classList.remove('lc-pill--on');
        }
        resetBtn.disabled = true;
        flashStatus(status, hadOverride ? 'Override removed. Default is now live for visitors.' : 'Reverted to default.');
      } catch (_) {
        // resetOverride toasts the error.
      }
    });

    // Save — compare against default; an override that's identical to
    // the default is a no-op (delete the row instead of storing dupe).
    card.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const value = currentValue();
      const trimmed = value.trim();
      const isEffectivelyDefault = normalizeHtml(trimmed) === normalizeHtml((defaultHtml || '').trim());

      if (!trimmed) {
        flashStatus(status, 'Editor is empty — nothing to save. Use "Reset to default" if you want to remove an override.', true);
        return;
      }

      try {
        if (isEffectivelyDefault) {
          if (_overrides[key]) {
            await resetOverride(key);
            flashStatus(status, 'Content matches default — override removed.');
            if (pill) {
              pill.textContent = 'Showing default';
              pill.classList.remove('lc-pill--on');
            }
            resetBtn.disabled = true;
          } else {
            flashStatus(status, 'No changes from default — nothing to save.');
          }
          initial = value;
          dirty.hidden = true;
          return;
        }
        await saveOverride(key, value);
        initial = value;
        dirty.hidden = true;
        if (pill) {
          pill.textContent = 'Override active · ' + new Date().toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          pill.classList.add('lc-pill--on');
        }
        resetBtn.disabled = false;
        flashStatus(status, 'Saved. Live on next page-load.');
      } catch (_) {
        // toast already raised
      }
    });
  });
}

// Read the current editor value from whichever pane is active.
function currentValueOf(visual, source, mode) {
  return mode === 'source' ? source.value : visual.innerHTML;
}

// Whitespace-tolerant compare so a stray trailing newline or run of
// spaces doesn't cause a "save default as override" round-trip.
function normalizeHtml(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/>\s+</g, '><')
    .trim();
}

function defaultHtmlForKey(key, defaults) {
  if (key.endsWith('.hero')) return defaults.hero || '';
  const m = /\.section\.(.+)$/.exec(key);
  if (m) {
    const sec = defaults.sections.find((s) => s.id === m[1]);
    return sec ? sec.html : '';
  }
  return '';
}

function bindFactsHandlers() {
  const body = _container.querySelector('#lc-tab-body');
  if (!body) return;

  body.querySelector('#lc-facts-save-all').addEventListener('click', async () => {
    const inputs = Array.from(body.querySelectorAll('.lc-fact'));
    let saved = 0, removed = 0, failed = 0;
    for (const wrap of inputs) {
      const fullKey = wrap.dataset.fullKey;
      const input = wrap.querySelector('input');
      const newVal = input.value.trim();
      const existing = _overrides[fullKey] ? _overrides[fullKey].value : '';
      if (newVal === existing) continue;
      try {
        if (newVal === '') {
          await resetOverride(fullKey);
          removed++;
        } else {
          await saveOverride(fullKey, newVal);
          saved++;
        }
      } catch (e) {
        failed++;
      }
    }
    if (saved + removed === 0 && failed === 0) {
      Toast.info('No changes to save.');
      return;
    }
    if (failed > 0) Toast.error(`Saved ${saved}, removed ${removed}, failed ${failed}.`);
    else Toast.success(`Saved ${saved}, removed ${removed}.`);
    render();
  });

  body.querySelector('#lc-facts-reset-all').addEventListener('click', async () => {
    const factKeys = Object.keys(_overrides).filter((k) => k.indexOf('site_facts.') === 0);
    if (factKeys.length === 0) { Toast.info('No overrides to reset.'); return; }
    if (!confirm(`Delete all ${factKeys.length} site-facts override${factKeys.length === 1 ? '' : 's'} and revert to defaults?`)) return;
    let n = 0;
    for (const k of factKeys) {
      try { await resetOverride(k); n++; } catch (_) {}
    }
    Toast.success(`Reset ${n} override${n === 1 ? '' : 's'}.`);
    render();
  });
}

// ─── Persistence ──────────────────────────────────────────────────────
async function saveOverride(key, value) {
  const sb = getSb();
  if (!sb) { Toast.error('Not authenticated'); throw new Error('No Supabase'); }

  const { error } = await sb.from(TABLE).upsert(
    {
      key,
      value,
      updated_at: new Date().toISOString(),
      updated_by: (typeof Auth !== 'undefined' && Auth.user?.id) ? Auth.user.id : null,
    },
    { onConflict: 'key' }
  );
  if (error) { Toast.error('Failed to save: ' + error.message); throw error; }
  _overrides[key] = { key, value, updated_at: new Date().toISOString() };
}

async function resetOverride(key) {
  const sb = getSb();
  if (!sb) { Toast.error('Not authenticated'); throw new Error('No Supabase'); }

  const { error } = await sb.from(TABLE).delete().eq('key', key);
  if (error) { Toast.error('Failed to reset: ' + error.message); throw error; }
  delete _overrides[key];
}

// ─── Misc ─────────────────────────────────────────────────────────────
function openPreview(key, html) {
  const safeKey = esc(key);
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { Toast.error('Allow popups to preview.'); return; }
  // Pull in the same stylesheets a public page uses so the preview looks
  // like the rendered output, not a bare div.
  w.document.write(`<!doctype html><html lang="en-NZ"><head><meta charset="UTF-8">
    <title>Preview · ${safeKey}</title>
    <link rel="stylesheet" href="/css/base.css">
    <link rel="stylesheet" href="/css/layout.css">
    <link rel="stylesheet" href="/css/components.css">
    <link rel="stylesheet" href="/css/pages.css">
    <style>body{padding:32px;background:#fff;color:#222;font-family:system-ui,-apple-system,sans-serif}.preview-meta{margin-bottom:24px;padding:12px 16px;background:#f1f5f9;border-radius:8px;font-size:12px;color:#475569}</style>
  </head><body>
    <div class="preview-meta">Previewing override <code>${safeKey}</code> — styles match the live page; data-legal-bind values render as-is.</div>
    <section class="legal-page"><div class="container"><article class="legal-page__body">
      <section class="policy-section">${html}</section>
    </article></div></section>
  </body></html>`);
  w.document.close();
}

function flashStatus(el, msg, isErr) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'lc-status' + (isErr ? ' lc-status--err' : ' lc-status--ok');
  setTimeout(() => {
    if (el) { el.textContent = ''; el.className = 'lc-status'; }
  }, 3500);
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function lcStyleBlock() {
  return `<style>
    .lc-badge { display:inline-block;margin-left:6px;background:var(--accent,#0ea5e9);color:#fff;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700 }
    .lc-card { padding:16px 18px }
    .lc-card__head { display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:12px }
    .lc-card__title { font-size:15px;font-weight:600;color:var(--text-primary) }
    .lc-card__subtitle { font-size:12px;color:var(--text-secondary);margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap }
    .lc-key { font-family:var(--font-mono,ui-monospace);background:var(--surface-hover,#f1f5f9);padding:1px 6px;border-radius:4px;font-size:11px }
    .lc-pill { display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;background:var(--surface-hover,#f1f5f9);color:var(--text-muted) }
    .lc-pill--on { background:#ecfdf5;color:#059669 }
    .lc-card__actions { display:flex;gap:8px;flex-wrap:wrap;align-items:center }

    /* Editor-mode tabs */
    .lc-mode { display:inline-flex;border:1px solid var(--border,#e2e8f0);border-radius:6px;overflow:hidden;background:var(--surface-hover,#f1f5f9);margin-right:4px }
    .lc-mode__btn { padding:5px 10px;font-size:11px;font-weight:600;border:none;background:none;color:var(--text-secondary);cursor:pointer;transition:background .15s,color .15s }
    .lc-mode__btn.active { background:var(--bg-card,#fff);color:var(--text-primary);box-shadow:inset 0 -2px 0 var(--accent,#0ea5e9) }
    .lc-mode__btn:hover:not(.active) { color:var(--text-primary) }

    /* Editor pane wrapper */
    .lc-editor-wrap { position:relative;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--input-bg,#fff);overflow:hidden }
    .lc-editor-wrap:focus-within { border-color:var(--accent,#0ea5e9);box-shadow:0 0 0 3px rgba(14,165,233,.12) }

    /* Visual editor — mimics the prose styles of the live policy pages
       so the admin sees what a visitor sees while editing. */
    .lc-visual {
      padding:18px 22px;
      min-height:160px;
      max-height:60vh;
      overflow:auto;
      font-size:14px;
      line-height:1.65;
      color:var(--text-primary,#1e293b);
      outline:none;
      caret-color:var(--accent,#0ea5e9);
    }
    .lc-visual:empty::before {
      content:'Click to start typing — the live page will render exactly this HTML.';
      color:var(--text-muted,#94a3b8);
      pointer-events:none;
    }
    .lc-visual h1 { font-size:24px;font-weight:700;margin:0 0 12px;line-height:1.3 }
    .lc-visual h2 { font-size:19px;font-weight:700;margin:18px 0 10px;line-height:1.35 }
    .lc-visual h3 { font-size:15px;font-weight:700;margin:14px 0 8px }
    .lc-visual p  { margin:0 0 12px }
    .lc-visual ul,.lc-visual ol { margin:0 0 12px;padding-left:22px }
    .lc-visual li { margin-bottom:5px }
    .lc-visual a  { color:var(--accent,#0ea5e9);text-decoration:underline }
    .lc-visual strong,.lc-visual b { font-weight:700 }
    .lc-visual em,.lc-visual i { font-style:italic }
    .lc-visual table { border-collapse:collapse;margin:8px 0 14px;font-size:13px }
    .lc-visual th,.lc-visual td { border:1px solid var(--border,#e2e8f0);padding:6px 10px;text-align:left }
    .lc-visual th { background:var(--surface-hover,#f1f5f9);font-weight:600 }
    .lc-visual address { font-style:normal;margin:8px 0 12px }
    .lc-visual blockquote { margin:8px 0;padding:10px 14px;border-left:3px solid var(--border,#e2e8f0);color:var(--text-secondary) }
    .lc-visual .policy-callout,.lc-visual .policy-callout--ok {
      margin:12px 0;padding:12px 14px;border-radius:8px;background:#fef9c3;border:1px solid #facc15;
    }
    .lc-visual .policy-callout--ok { background:#ecfdf5;border-color:#86efac }
    .lc-visual .policy-callout__title { font-weight:700;margin:0 0 4px }
    .lc-visual .about-values { display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:8px 0 }
    .lc-visual .about-value { padding:10px 12px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--surface-hover,#f8fafc) }
    .lc-visual .about-value__title { font-weight:700;margin:6px 0 4px;font-size:13px }
    .lc-visual .about-value__body { margin:0;font-size:12px;color:var(--text-secondary);line-height:1.5 }
    .lc-visual details.faq-item { padding:8px 0;border-bottom:1px dashed var(--border,#e2e8f0) }
    .lc-visual details.faq-item summary { font-weight:600;cursor:pointer;font-size:14px }
    .lc-visual span[data-legal-bind] { background:rgba(14,165,233,.08);border-radius:3px;padding:0 3px }

    /* Source HTML mode */
    .lc-source {
      width:100%;
      box-sizing:border-box;
      font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
      font-size:12px;
      line-height:1.55;
      padding:14px 16px;
      border:none;
      background:transparent;
      color:var(--text-primary);
      resize:vertical;
      min-height:200px;
      max-height:60vh;
      outline:none;
    }

    /* Default reference panel */
    .lc-default-ref { margin-top:10px;font-size:12px;color:var(--text-secondary) }
    .lc-default-ref summary { cursor:pointer;padding:6px 0;color:var(--text-muted);font-weight:500 }
    .lc-default-ref summary:hover { color:var(--text-primary) }
    .lc-default-ref[open] summary { color:var(--text-primary);font-weight:600 }
    .lc-default__label { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin:8px 0 6px }
    .lc-default__rendered { font-size:13px;line-height:1.6;color:var(--text-primary);max-height:280px;overflow:auto;padding:10px 14px;background:var(--surface-hover,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:6px }
    .lc-default__rendered h2,.lc-default__rendered h3{margin-top:0}
    .lc-default__source { font-family:var(--font-mono,ui-monospace);font-size:11px;background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;overflow:auto;max-height:200px;white-space:pre-wrap;margin:0 }

    /* Footer status */
    .lc-card__foot { display:flex;justify-content:space-between;align-items:center;margin-top:10px;min-height:18px;gap:12px }
    .lc-dirty { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#b45309;background:#fef3c7;padding:2px 8px;border-radius:999px }
    .lc-status { font-size:12px;font-weight:500;color:var(--text-muted);transition:opacity .2s;margin-left:auto }
    .lc-status--ok { color:#059669 }
    .lc-status--err { color:#dc2626 }

    /* Site facts */
    .lc-facts-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px }
    .lc-fact { display:flex;flex-direction:column;gap:4px;font-size:13px }
    .lc-fact__label { font-weight:600;color:var(--text-primary);display:flex;align-items:center;gap:6px }
    .lc-fact__hint { font-size:11px;color:var(--text-muted);line-height:1.4 }
    .lc-fact__default { font-size:11px;color:var(--text-muted) }
    .lc-fact__default code { font-family:var(--font-mono,ui-monospace);background:var(--surface-hover,#f1f5f9);padding:1px 5px;border-radius:3px }
    .lc-fact__input { width:100% }

    .admin-btn--danger { color:#dc2626 }
    .admin-btn--danger:hover { background:#fef2f2 }
    .admin-btn[disabled] { opacity:.4;cursor:not-allowed }

    @media (max-width: 720px) {
      .lc-card__actions { width:100% }
    }
  </style>`;
}

// ─── Public module interface ──────────────────────────────────────────
export default {
  title: 'Legal Content',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    if (typeof AdminAuth !== 'undefined' && !AdminAuth.isOwner()) {
      _container.innerHTML = `
        <div class="admin-stub">
          <div class="admin-stub__title">Access Restricted</div>
          <div class="admin-stub__text">This page is available to account owners only.</div>
        </div>`;
      return;
    }
    try {
      await load();
    } catch (_) {
      // renderTableMissing already wrote the screen.
    }
  },

  destroy() {
    _container = null;
    _overrides = {};
    _defaultsCache = {};
    _currentTab = 'about';
  },
};
