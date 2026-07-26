/**
 * PAGE COPY — edit the prose on the static content pages
 * ======================================================
 * Routed at #page-copy (index) and #page-copy?doc=<slug> (one document).
 * Owner-only.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * --------------------------------------------
 * It is a GUI over a git commit. It is NOT a CMS.
 *
 * The previous attempt (js/admin/pages/legal-content.js, deleted 2026-07-14,
 * ERR-065 → ERR-069) stored copy in a Supabase table which js/legal-page.js
 * read and injected at RENDER time. That produced two different documents from
 * one URL — the file the server sends, and the DOM a browser ends up with —
 * which is cloaking, the charge under appeal with Google Ads. It also silently
 * did nothing, because `const Config` is not a property of `window`, so the
 * reader's config lookup always returned null while the editor kept reporting
 * "Saved. Live on next page-load."
 *
 * This module fixes the class of bug, not the instance:
 *
 *   1. It edits the SOURCE. A save rewrites inkcartridges/html/<doc>.html in
 *      git; Vercel redeploys; there is still exactly one artifact, so a bot, a
 *      browser and a `curl`-based compliance grep cannot disagree.
 *   2. js/legal-page.js is not touched, imported, or extended. The storefront
 *      runtime gains nothing from this feature and keeps its zero-network-I/O
 *      property (§1/§2 of tests/legal-cms-retired-jul2026.test.js).
 *   3. Nothing here reports success it did not achieve. If the commit endpoint
 *      is absent or fails, the UI says so in those words and hands over the
 *      diff — it never shows "Saved".
 *
 * ROUTE NAMING: this file must never be named legal-content.js, and must not
 * register a Settings tab with id 'legal' — both are pinned absent by §3 of the
 * retired-CMS suite. ROUTE_REDIRECTS['legal-content'] stays pointed at
 * 'settings'; do not repoint it here.
 *
 * SHAPE OF AN EDIT
 * ----------------
 *   html file → findSections() → parseRegion() per section → blocks
 *   blocks → [owner edits] → checkRegionEdit() → serializeRegion() → spliceRegion()
 *   modified html → PR → preview → merge
 *
 * The block model (utils/page-copy-model.js) is the only thing that ever
 * writes markup. contentEditable output is parsed INTO the model and discarded;
 * `editor.innerHTML` is never written to a file, because it decodes entities,
 * reorders attributes and — via RichTextEditor.sanitizeHTML — strips the
 * `class` that makes a policy callout a policy callout.
 */

import { AdminAuth, icon, esc } from '../app.js';
import { RichTextEditor } from '../components/rich-text-editor.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

import {
    findSections,
    regionSource,
    parseRegion,
    serializeRegion,
    spliceRegion,
    isBlockEditable,
} from '../utils/page-copy-model.js';

import {
    PAGE_COPY_DOC_ORDER,
    getDoc,
    getSectionRule,
} from '../utils/page-copy-regions.js';

import { checkRegionEdit } from '../utils/page-copy-guards.js';

/* ─────────────────────────── module state ─────────────────────────── */

let _container = null;
let _slug = null;
let _originalHtml = '';      // the file as loaded
let _sections = [];          // [{ id, heading, indent, rule, original, blocks, editable }]
let _editors = [];           // live RichTextEditor instances, for destroy()
let _source = null;          // 'api' | 'http' — where _originalHtml came from
let _blobSha = null;         // git blob sha, when loaded through the API
let _token = 0;              // navigation token; guards async work after destroy
let _onHashChange = null;    // our own listener — see wireHashRouting()

/* ─────────────────────────── helpers ─────────────────────────── */

const API_BASE = () => (typeof Config !== 'undefined' && Config.API_URL) || '';

/** Auth header for the commit endpoints, or null when we have no session. */
async function authHeaders() {
    try {
        const token = await window.API.getToken();
        return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : null;
    } catch (_) {
        return null;
    }
}

/** Plain text of an <h2>…</h2> fragment, for display. */
function headingText(h2Html) {
    return String(h2Html || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&rsquo;/g, '’')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The doc slug in the current hash, or null for the index. */
function slugFromHash() {
    const q = (location.hash.split('?')[1] || '');
    const doc = new URLSearchParams(q).get('doc');
    return doc && getDoc(doc) ? doc : null;
}

/* ─────────────────────────── line diff ─────────────────────────── */

/**
 * Unified diff between two strings, 3 lines of context.
 *
 * Written here rather than reusing pending-changes.js's `pc-diff` renderer:
 * that one diffs product FIELDS (old → new pills, price tints), which is the
 * wrong shape for prose. The visual language below stays deliberately close to
 * it so the two screens read as one admin.
 */
function unifiedDiff(before, after, filePath, context = 3) {
    const a = before.split('\n');
    const b = after.split('\n');

    // Longest common subsequence over lines. These files are ~400 lines, so the
    // O(n·m) table is trivially affordable and the code stays readable.
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
        else { ops.push({ t: '+', line: b[j] }); j++; }
    }
    while (i < n) { ops.push({ t: '-', line: a[i] }); i++; }
    while (j < m) { ops.push({ t: '+', line: b[j] }); j++; }

    if (!ops.some(o => o.t !== ' ')) return '';

    // Group changed ops into hunks with `context` unchanged lines either side.
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, k) => {
        if (o.t === ' ') return;
        for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
    });

    const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
    let aLine = 1;
    let bLine = 1;
    let k = 0;
    while (k < ops.length) {
        if (!keep[k]) {
            if (ops[k].t !== '+') aLine++;
            if (ops[k].t !== '-') bLine++;
            k++;
            continue;
        }
        const startA = aLine;
        const startB = bLine;
        const body = [];
        let countA = 0;
        let countB = 0;
        while (k < ops.length && keep[k]) {
            const o = ops[k];
            body.push(o.t + o.line);
            if (o.t !== '+') { aLine++; countA++; }
            if (o.t !== '-') { bLine++; countB++; }
            k++;
        }
        out.push(`@@ -${startA},${countA} +${startB},${countB} @@`);
        out.push(...body);
    }
    return out.join('\n');
}

/* ─────────────────────────── document assembly ─────────────────────────── */

/** Rebuild the whole file from the current block state. */
function buildModifiedHtml() {
    let html = _originalHtml;
    for (const s of _sections) {
        if (!s.editable || !s.dirty) continue;
        html = spliceRegion(html, s.id, s.blocks);
    }
    return html;
}

/** True when a section's blocks differ from what was loaded. */
function recomputeDirty(section) {
    section.dirty = serializeRegion(section.blocks, section.indent) !== section.original;
}

function anyDirty() {
    return _sections.some(s => s.dirty);
}

/* ─────────────────────────── loading ─────────────────────────── */

/**
 * Fetch the document source.
 *
 * Preferred: the backend commit endpoint, which reads the blob off `main`
 * through the GitHub API and returns its sha so a save can be made
 * conditional. Fallback: fetch the deployed page over HTTP, which is enough
 * to compose and lint an edit but cannot be committed from here.
 *
 * Both outcomes are reported honestly to the caller. A failure never returns
 * an empty document that would read as "this page has no content".
 */
async function loadDocSource(slug) {
    const doc = getDoc(slug);
    const headers = await authHeaders();

    if (API_BASE() && headers) {
        try {
            const resp = await fetch(`${API_BASE()}/api/admin/page-copy/${encodeURIComponent(slug)}`, {
                headers,
                credentials: 'include',
            });
            if (resp.ok) {
                const body = await resp.json();
                const data = body?.data || body;
                if (data && typeof data.html === 'string' && data.html.length) {
                    return { ok: true, html: data.html, blobSha: data.blobSha || data.sha || null, source: 'api' };
                }
                return { ok: false, reason: 'malformed', detail: 'The commit endpoint returned no file content.' };
            }
            if (resp.status !== 404 && resp.status !== 501) {
                let detail = `HTTP ${resp.status}`;
                try {
                    const body = await resp.json();
                    if (body?.error) detail = `${detail} — ${body.error}`;
                } catch (_) { /* body was not JSON; the status alone is the signal */ }
                return { ok: false, reason: 'endpoint-error', detail };
            }
            // 404 / 501 → the endpoint is not deployed yet. Fall through.
        } catch (e) {
            return { ok: false, reason: 'network', detail: e.message };
        }
    }

    try {
        const resp = await fetch(`/${doc.path}`, { cache: 'no-store' });
        if (!resp.ok) return { ok: false, reason: 'http', detail: `HTTP ${resp.status} fetching /${doc.path}` };
        const html = await resp.text();
        if (!/policy-section/.test(html)) {
            return { ok: false, reason: 'malformed', detail: 'The fetched page does not look like a content page.' };
        }
        return { ok: true, html, blobSha: null, source: 'http' };
    } catch (e) {
        return { ok: false, reason: 'network', detail: e.message };
    }
}

/* ─────────────────────────── index view ─────────────────────────── */

function renderIndex(container) {
    const cards = PAGE_COPY_DOC_ORDER.map(slug => {
        const doc = getDoc(slug);
        const rules = Object.values(doc.sections);
        const editable = rules.filter(r => r.state === 'editable').length;
        const locked = rules.length - editable;
        return `
      <button type="button" class="pgc-card" data-doc="${esc(slug)}">
        <span class="pgc-card__title">${esc(doc.title)}</span>
        <span class="pgc-card__url">${esc(doc.url)}</span>
        <span class="pgc-card__meta">
          <span class="pgc-card__stat">${editable} editable</span>
          ${locked ? `<span class="pgc-card__stat pgc-card__stat--locked">${locked} read-only</span>` : ''}
        </span>
      </button>`;
    }).join('');

    container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1>Page Copy</h1>
        <p class="pgc-subtitle">
          Edit the words on the public information pages. Changes are written to the site's
          source files and go live through a review link — nothing is injected into the page
          at load time, so search engines and visitors always see exactly the same text.
        </p>
      </div>
    </div>
    <div class="pgc-grid">${cards}</div>
  `;

    container.querySelectorAll('.pgc-card').forEach(btn => {
        btn.addEventListener('click', () => { location.hash = `#page-copy?doc=${btn.dataset.doc}`; });
    });
}

/* ─────────────────────────── block editors ─────────────────────────── */

/**
 * Parse contentEditable output back into the block model.
 *
 * The editor's HTML is a suggestion, never the artifact. If it cannot be
 * expressed in the model it is refused here, long before anything is written.
 */
function blocksFromEditorHtml(html) {
    let src = String(html || '').trim();
    if (!src) return null;
    if (!/^<(p|ul|ol|h3|div)\b/i.test(src)) src = `<p>${src}</p>`;
    return parseRegion(src);
}

/**
 * A read-only rendering of a block.
 *
 * Two different reasons land here and they must not be confused: the whole
 * SECTION may be locked by the manifest (in which case an ordinary paragraph
 * shows read-only), or this one BLOCK may be markup the model can't express.
 * Labelling a locked paragraph "structured content" would send the owner
 * hunting for a table that isn't there.
 */
function verbatimCard(block, sectionLocked) {
    const label = sectionLocked
        ? 'Read-only — see the note above'
        : 'Read-only — structured content';
    const body = block.type === 'verbatim'
        ? block.raw
        : serializeRegion([block], 0);
    return `
    <div class="pgc-block pgc-block--verbatim">
      <div class="pgc-block__lock">${icon('lock', 13, 13)} ${label}</div>
      <div class="pgc-block__preview">${body}</div>
    </div>`;
}

/**
 * Render one editable block and wire its editor.
 * `onChange(newBlocks)` receives the block(s) this one became — a paragraph
 * split by Enter legitimately becomes several.
 */
function mountBlock(host, block, index, section, rerender) {
    const wrap = document.createElement('div');
    wrap.className = 'pgc-block';

    const controls = `
    <div class="pgc-block__bar">
      <span class="pgc-block__kind">${esc(block.type)}</span>
      <span class="pgc-block__spacer"></span>
      <button type="button" class="pgc-icon-btn" data-act="up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="pgc-icon-btn" data-act="down" title="Move down" ${index === section.blocks.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="pgc-icon-btn pgc-icon-btn--danger" data-act="del" title="Delete this block">✕</button>
    </div>`;

    const commit = (next) => {
        if (next === null) {
            wrap.classList.add('pgc-block--invalid');
            section.error = 'That formatting cannot be saved. Use plain paragraphs, lists, bold, italics and links.';
            rerender({ soft: true });
            return;
        }
        wrap.classList.remove('pgc-block--invalid');
        section.error = null;
        section.blocks.splice(index, 1, ...next);
        recomputeDirty(section);
        rerender({ soft: true });
    };

    if (block.type === 'subheading') {
        // A short heading needs no rich text, and a plain input cannot smuggle markup in.
        wrap.innerHTML = controls
            + `<input type="text" class="admin-input pgc-subheading" value="${esc(serializeRegion([block], 0).replace(/^<h3>|<\/h3>$/g, ''))}">`;
        host.appendChild(wrap);
        wrap.querySelector('input').addEventListener('input', (e) => {
            const parsed = parseRegion(`<h3>${e.target.value}</h3>`);
            commit(parsed);
        });
    } else if (block.type === 'callout') {
        wrap.innerHTML = controls
            + `<div class="pgc-callout">
           <input type="text" class="admin-input pgc-callout__title" placeholder="Callout heading"
                  value="${esc(block.title ? serializeRegion([{ type: 'paragraph', className: '', inline: block.title }], 0).replace(/^<p>|<\/p>$/g, '') : '')}">
           <div class="pgc-callout__body"></div>
         </div>`;
        host.appendChild(wrap);

        const titleInput = wrap.querySelector('.pgc-callout__title');
        const bodyHost = wrap.querySelector('.pgc-callout__body');
        const bodyHtml = block.body.map(p => serializeRegion([{ type: 'paragraph', className: '', inline: p }], 0)).join('');

        const rebuild = () => {
            const titleBlocks = titleInput.value.trim()
                ? parseRegion(`<p>${titleInput.value}</p>`)
                : null;
            const bodyBlocks = blocksFromEditorHtml(rte.getValue());
            if (bodyBlocks === null || (titleInput.value.trim() && titleBlocks === null)) return commit(null);
            if (bodyBlocks.some(b => b.type !== 'paragraph')) return commit(null);
            commit([{
                type: 'callout',
                className: block.className,
                title: titleBlocks ? titleBlocks[0].inline : null,
                body: bodyBlocks.map(b => b.inline),
            }]);
        };

        const rte = new RichTextEditor(bodyHost, { initialValue: bodyHtml, minHeight: 90, onChange: rebuild });
        _editors.push(rte);
        titleInput.addEventListener('input', rebuild);
    } else {
        // paragraph | list — both round-trip through the rich-text editor.
        wrap.innerHTML = controls + `<div class="pgc-block__editor"></div>`;
        host.appendChild(wrap);
        const initial = serializeRegion([block], 0);
        const rte = new RichTextEditor(wrap.querySelector('.pgc-block__editor'), {
            initialValue: initial,
            minHeight: block.type === 'list' ? 110 : 80,
            onChange: (html) => commit(blocksFromEditorHtml(html)),
        });
        _editors.push(rte);
    }

    wrap.querySelector('[data-act="up"]')?.addEventListener('click', () => {
        [section.blocks[index - 1], section.blocks[index]] = [section.blocks[index], section.blocks[index - 1]];
        recomputeDirty(section);
        rerender({});
    });
    wrap.querySelector('[data-act="down"]')?.addEventListener('click', () => {
        [section.blocks[index + 1], section.blocks[index]] = [section.blocks[index], section.blocks[index + 1]];
        recomputeDirty(section);
        rerender({});
    });
    wrap.querySelector('[data-act="del"]')?.addEventListener('click', () => {
        section.blocks.splice(index, 1);
        recomputeDirty(section);
        rerender({});
    });
}

/* ─────────────────────────── document view ─────────────────────────── */

function sectionStatusHtml(section) {
    if (!section.editable) {
        return `<div class="pgc-section__locked">${icon('lock', 14, 14)}<span>${esc(section.rule.reason || 'Read-only.')}</span></div>`;
    }
    if (section.blocks && !section.blocks.some(isBlockEditable)) {
        return `<div class="pgc-section__locked">${icon('lock', 14, 14)}<span>Everything in this section is structured content the editor cannot rewrite.</span></div>`;
    }
    const phrases = section.rule.requiredPhrases || [];
    if (!phrases.length) return '';
    return `<details class="pgc-section__pinned">
    <summary>${phrases.length} sentence${phrases.length > 1 ? 's' : ''} in this section must stay</summary>
    <ul>${phrases.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
  </details>`;
}

function renderDocShell(container, doc) {
    container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <a class="pgc-back" href="#page-copy">← All pages</a>
        <h1>${esc(doc.title)}</h1>
        <p class="pgc-subtitle">
          Editing <code>${esc(doc.path)}</code> —
          <a href="${esc(doc.url)}" target="_blank" rel="noopener">view the live page ↗</a>
        </p>
      </div>
      <div class="admin-page-header__actions pgc-actions" id="pgc-actions"></div>
    </div>
    <div id="pgc-notice"></div>
    <div id="pgc-sections" class="pgc-sections"></div>
  `;
}

function renderActions() {
    const host = document.getElementById('pgc-actions');
    if (!host) return;
    const dirty = anyDirty();
    host.innerHTML = `
    <button type="button" class="admin-btn admin-btn--ghost" id="pgc-preview" ${dirty ? '' : 'disabled'}>Preview</button>
    <button type="button" class="admin-btn admin-btn--ghost" id="pgc-diff" ${dirty ? '' : 'disabled'}>View changes</button>
    <button type="button" class="admin-btn admin-btn--ghost" id="pgc-discard" ${dirty ? '' : 'disabled'}>Discard</button>
    <button type="button" class="admin-btn admin-btn--primary" id="pgc-publish" ${dirty ? '' : 'disabled'}>Publish…</button>
  `;
    host.querySelector('#pgc-preview').addEventListener('click', openPreview);
    host.querySelector('#pgc-diff').addEventListener('click', openDiff);
    host.querySelector('#pgc-discard').addEventListener('click', discardChanges);
    host.querySelector('#pgc-publish').addEventListener('click', openPublish);
}

function renderSections() {
    const host = document.getElementById('pgc-sections');
    if (!host) return;

    _editors.forEach(e => { try { e.destroy(); } catch (_) { /* already gone */ } });
    _editors = [];
    host.innerHTML = '';

    for (const section of _sections) {
        const card = document.createElement('section');
        card.className = `pgc-section${section.editable ? '' : ' pgc-section--locked'}${section.dirty ? ' pgc-section--dirty' : ''}`;
        card.innerHTML = `
      <header class="pgc-section__head">
        <h2 class="pgc-section__title">${esc(section.title)}</h2>
        <span class="pgc-section__id">#${esc(section.id)}</span>
        ${section.dirty ? '<span class="pgc-section__badge">edited</span>' : ''}
      </header>
      ${sectionStatusHtml(section)}
      <div class="pgc-section__blocks"></div>
      <div class="pgc-section__foot"></div>
    `;
        host.appendChild(card);

        const blocksHost = card.querySelector('.pgc-section__blocks');
        const rerender = ({ soft } = {}) => {
            renderActions();
            updateSectionChrome(card, section);
            if (!soft) renderSections();
        };

        if (!section.blocks) {
            blocksHost.innerHTML = `<div class="pgc-block pgc-block--verbatim">
        <div class="pgc-block__lock">${icon('lock', 13, 13)} This section uses markup the editor cannot safely rewrite.</div>
      </div>`;
            continue;
        }

        section.blocks.forEach((block, i) => {
            if (!section.editable || !isBlockEditable(block)) {
                blocksHost.insertAdjacentHTML('beforeend', verbatimCard(block, !section.editable));
                return;
            }
            mountBlock(blocksHost, block, i, section, rerender);
        });

        if (section.editable && section.blocks.some(isBlockEditable)) {
            const foot = card.querySelector('.pgc-section__foot');
            foot.innerHTML = `
        <span class="pgc-add__label">Add:</span>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-add="paragraph">Paragraph</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-add="list">List</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-add="subheading">Subheading</button>`;
            foot.querySelectorAll('[data-add]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const kind = btn.dataset.add;
                    const seed = kind === 'list'
                        ? parseRegion('<ul><li>New item</li></ul>')
                        : kind === 'subheading'
                            ? parseRegion('<h3>New subheading</h3>')
                            : parseRegion('<p>New paragraph.</p>');
                    section.blocks.push(seed[0]);
                    recomputeDirty(section);
                    renderSections();
                    renderActions();
                });
            });
        }

        updateSectionChrome(card, section);
    }
}

/** Update the parts of a section card that change without a full re-render. */
function updateSectionChrome(card, section) {
    card.classList.toggle('pgc-section--dirty', !!section.dirty);
    const head = card.querySelector('.pgc-section__head');
    let badge = head.querySelector('.pgc-section__badge');
    if (section.dirty && !badge) {
        badge = document.createElement('span');
        badge.className = 'pgc-section__badge';
        badge.textContent = 'edited';
        head.appendChild(badge);
    } else if (!section.dirty && badge) {
        badge.remove();
    }

    let errBox = card.querySelector('.pgc-section__error');
    if (section.error) {
        if (!errBox) {
            errBox = document.createElement('div');
            errBox.className = 'pgc-section__error';
            card.appendChild(errBox);
        }
        errBox.textContent = section.error;
    } else if (errBox) {
        errBox.remove();
    }
}

/* ─────────────────────────── notices ─────────────────────────── */

function showNotice(kind, title, body) {
    const host = document.getElementById('pgc-notice');
    if (!host) return;
    host.innerHTML = `
    <div class="pgc-notice pgc-notice--${kind}">
      <strong>${esc(title)}</strong>
      <span>${body}</span>
    </div>`;
}

/* ─────────────────────────── actions ─────────────────────────── */

function discardChanges() {
    Modal.confirm({
        title: 'Discard changes?',
        message: 'Your edits to this page will be thrown away. This cannot be undone.',
        confirmLabel: 'Discard',
        onConfirm: () => { renderDoc(_container, _slug); },
    });
}

function openPreview() {
    const html = buildModifiedHtml();
    Modal.open({
        title: 'Preview',
        className: 'pgc-modal pgc-modal--wide',
        body: `<iframe class="pgc-preview" sandbox="allow-same-origin" srcdoc="${esc(html)}"></iframe>`,
        footer: `<p class="pgc-preview__note">This is the page exactly as it will be published, including its
             table of contents. Auto-filled values (phone, GST number, dates) render from site settings
             as usual.</p>`,
    });
}

function openDiff() {
    const doc = getDoc(_slug);
    const diff = unifiedDiff(_originalHtml, buildModifiedHtml(), `inkcartridges/${doc.path}`);
    Modal.open({
        title: 'Changes',
        className: 'pgc-modal pgc-modal--wide',
        body: `<pre class="pgc-diff">${renderDiffHtml(diff)}</pre>`,
        footer: `<button type="button" class="admin-btn admin-btn--ghost" id="pgc-copy-diff">Copy diff</button>
             <button type="button" class="admin-btn admin-btn--ghost" id="pgc-download">Download modified file</button>`,
    });
    document.getElementById('pgc-copy-diff')?.addEventListener('click', () => copyDiff(diff));
    document.getElementById('pgc-download')?.addEventListener('click', downloadFile);
}

function renderDiffHtml(diff) {
    if (!diff) return '<span class="pgc-diff__ctx">No changes.</span>';
    return diff.split('\n').map(line => {
        const cls = line.startsWith('+++') || line.startsWith('---') ? 'pgc-diff__file'
            : line.startsWith('@@') ? 'pgc-diff__hunk'
                : line.startsWith('+') ? 'pgc-diff__add'
                    : line.startsWith('-') ? 'pgc-diff__del'
                        : 'pgc-diff__ctx';
        return `<span class="${cls}">${esc(line)}</span>`;
    }).join('\n');
}

async function copyDiff(diff) {
    try {
        await navigator.clipboard.writeText(diff);
        Toast.success('Diff copied to clipboard.');
    } catch (e) {
        Toast.error(`Could not copy to the clipboard: ${e.message}. Select the text and copy it manually.`);
    }
}

function downloadFile() {
    const doc = getDoc(_slug);
    const blob = new Blob([buildModifiedHtml()], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = doc.path.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    if (_source === 'http') {
        Toast.warning('Downloaded from the deployed page, whose asset version tokens are '
            + 'rewritten at build time. Hand a developer the DIFF, not this whole file.', 9000);
    }
}

/** Run every guard over every edited section. */
function validateAll() {
    const problems = [];
    for (const section of _sections) {
        if (!section.dirty) continue;
        const before = parseRegion(section.original);
        const result = checkRegionEdit({
            slug: _slug,
            sectionId: section.id,
            before,
            after: section.blocks,
            indent: section.indent,
        });
        if (!result.ok) problems.push({ section, errors: result.errors });
    }
    return problems;
}

function openPublish() {
    const problems = validateAll();
    if (problems.length) {
        Modal.open({
            title: 'These changes cannot be published yet',
            className: 'pgc-modal',
            body: problems.map(p => `
        <div class="pgc-problem">
          <h4>${esc(p.section.title)}</h4>
          <ul>${p.errors.map(e => `<li><code>${esc(e.code)}</code> ${esc(e.message)}</li>`).join('')}</ul>
        </div>`).join(''),
            footer: `<button type="button" class="admin-btn admin-btn--ghost" data-close>Back to editing</button>`,
        });
        document.querySelector('[data-close]')?.addEventListener('click', () => Modal.close());
        return;
    }

    const edited = _sections.filter(s => s.dirty);
    Modal.open({
        title: 'Publish changes',
        className: 'pgc-modal',
        body: `
      <p class="pgc-publish__lead">
        ${edited.length} section${edited.length > 1 ? 's' : ''} changed in
        <code>${esc(getDoc(_slug).path)}</code>. All checks passed.
      </p>
      <ul class="pgc-publish__list">${edited.map(s => `<li>${esc(s.title)}</li>`).join('')}</ul>
      <label class="pgc-publish__field">
        <span>Describe the change (goes in the commit message)</span>
        <input type="text" class="admin-input" id="pgc-summary"
               value="Update ${esc(getDoc(_slug).title)} copy" maxlength="120">
      </label>
      <label class="pgc-publish__check">
        <input type="checkbox" id="pgc-substantive">
        <span>This is a substantive policy change, not a wording tidy-up</span>
      </label>
      <p class="pgc-publish__note">
        Publishing opens a review link with a preview of the built site. Nothing reaches
        customers until you press <em>Go live</em> on that link.
      </p>`,
        footer: `<button type="button" class="admin-btn admin-btn--ghost" data-close>Cancel</button>
             <button type="button" class="admin-btn admin-btn--primary" id="pgc-confirm">Create review link</button>`,
    });

    document.querySelector('[data-close]')?.addEventListener('click', () => Modal.close());
    document.getElementById('pgc-substantive')?.addEventListener('change', (e) => {
        const note = document.querySelector('.pgc-publish__note');
        if (!note) return;
        note.innerHTML = e.target.checked
            ? 'A substantive policy change also needs the <strong>Last updated</strong> date bumped. '
              + 'That date lives in <code>js/legal-config.js</code> and is shared by every policy page, '
              + 'and the backend copy must move with it — this screen deliberately will not touch it. '
              + 'Ask a developer to bump it in the same release.'
            : 'Publishing opens a review link with a preview of the built site. Nothing reaches '
              + 'customers until you press <em>Go live</em> on that link.';
        note.classList.toggle('pgc-publish__note--warn', e.target.checked);
    });
    document.getElementById('pgc-confirm')?.addEventListener('click', publish);
}

async function publish() {
    const btn = document.getElementById('pgc-confirm');
    const summary = (document.getElementById('pgc-summary')?.value || '').trim() || `Update ${_slug} copy`;
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    const headers = await authHeaders();
    if (!API_BASE() || !headers) {
        return publishUnavailable('You are not signed in with a session that can publish.');
    }

    try {
        const resp = await fetch(`${API_BASE()}/api/admin/page-copy/${encodeURIComponent(_slug)}`, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({
                blobSha: _blobSha,
                summary,
                regions: _sections.filter(s => s.dirty).map(s => ({ sectionId: s.id, blocks: s.blocks })),
            }),
        });

        if (resp.status === 404 || resp.status === 501) {
            return publishUnavailable('The publishing endpoint is not deployed on the backend yet.');
        }
        if (resp.status === 409) {
            Modal.close();
            showNotice('warn', 'Someone else changed this file',
                'Your edits were not saved. The file changed in git while you were editing, so publishing '
                + 'would have overwritten that change. Reload this page and re-apply your edit.');
            Toast.error('Not published — the file changed while you were editing.', 9000);
            return;
        }
        if (!resp.ok) {
            let detail = `HTTP ${resp.status}`;
            try {
                const body = await resp.json();
                if (body?.error) detail = body.error;
                if (Array.isArray(body?.errors) && body.errors.length) {
                    detail = body.errors.map(e => e.message || e.code).join(' · ');
                }
            } catch (_) { /* not JSON — the status is what we have */ }
            Modal.close();
            showNotice('error', 'Not published', esc(detail));
            Toast.error(`Not published: ${detail}`, 9000);
            return;
        }

        const body = await resp.json();
        const data = body?.data || body;
        Modal.close();
        showNotice('ok', 'Review link created',
            `Nothing is live yet. Open the preview, read the page, then press <em>Go live</em>.
       ${data.previewUrl ? `<a href="${esc(data.previewUrl)}" target="_blank" rel="noopener">Open preview ↗</a>` : ''}
       ${data.prUrl ? `<a href="${esc(data.prUrl)}" target="_blank" rel="noopener">Review the change ↗</a>` : ''}`);
        renderGoLive(data);
        Toast.success('Review link created. Nothing is live until you press Go live.');
    } catch (e) {
        Modal.close();
        showNotice('error', 'Not published', esc(`Could not reach the publishing endpoint: ${e.message}`));
        Toast.error(`Not published: ${e.message}`, 9000);
    }
}

/**
 * The publish path is unavailable. Say exactly that, and hand over the diff —
 * never a toast that reads like a save.
 */
function publishUnavailable(why) {
    Modal.close();
    showNotice('warn', 'Nothing was published',
        `${esc(why)} Your edits are still here and have passed every check. Use
     <strong>View changes → Copy diff</strong> and send it to a developer, who can apply it
     in one commit.`);
    Toast.warning('Nothing was published — the publishing endpoint is not available.', 9000);
}

function renderGoLive(data) {
    if (!data?.prNumber) return;
    const host = document.getElementById('pgc-notice');
    if (!host) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-btn admin-btn--primary pgc-golive';
    btn.textContent = 'Go live';
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Publishing…';
        const headers = await authHeaders();
        try {
            const resp = await fetch(`${API_BASE()}/api/admin/page-copy/${encodeURIComponent(_slug)}/publish`, {
                method: 'POST', headers, credentials: 'include',
                body: JSON.stringify({ prNumber: data.prNumber }),
            });
            if (!resp.ok) {
                let detail = `HTTP ${resp.status}`;
                try { const b = await resp.json(); if (b?.error) detail = b.error; } catch (_) { /* not JSON */ }
                btn.disabled = false;
                btn.textContent = 'Go live';
                showNotice('error', 'Not published', esc(detail));
                Toast.error(`Not published: ${detail}`, 9000);
                return;
            }
            btn.remove();
            showNotice('ok', 'Published',
                'The change is merged. The site rebuilds and goes live in about a minute.');
            Toast.success('Published. The site rebuilds in about a minute.');
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Go live';
            Toast.error(`Not published: ${e.message}`, 9000);
        }
    });
    host.appendChild(btn);
}

/* ─────────────────────────── doc view boot ─────────────────────────── */

async function renderDoc(container, slug) {
    const doc = getDoc(slug);
    const token = ++_token;

    _slug = slug;
    _sections = [];
    _editors = [];
    _originalHtml = '';
    _blobSha = null;
    _source = null;

    renderDocShell(container, doc);
    document.getElementById('pgc-sections').innerHTML =
        `<div class="pgc-section"><div class="admin-skeleton admin-skeleton--text"></div>
       <div class="admin-skeleton admin-skeleton--text"></div></div>`.repeat(4);

    const result = await loadDocSource(slug);
    if (token !== _token || !_container) return;   // navigated away mid-load

    if (!result.ok) {
        document.getElementById('pgc-sections').innerHTML = '';
        showNotice('error', 'Could not load this page',
            esc(`${result.detail || result.reason}. Nothing has been changed. Try again, `
                + `or check that the site and backend are reachable.`));
        return;
    }

    _originalHtml = result.html;
    _blobSha = result.blobSha;
    _source = result.source;

    _sections = findSections(_originalHtml).map(s => {
        const rule = getSectionRule(slug, s.id);
        const original = regionSource(_originalHtml, s).replace(/^\n/, '').replace(/\n[ \t]*$/, '');
        return {
            id: s.id,
            title: headingText(s.heading),
            indent: s.indent,
            rule,
            editable: rule.state === 'editable',
            original,
            blocks: parseRegion(original),
            dirty: false,
            error: null,
        };
    });

    if (_source === 'http') {
        showNotice('warn', 'Publishing is not available',
            'This page was read from the live site because the backend publishing endpoint is not '
            + 'deployed yet. You can still edit and check your changes here, then use '
            + '<strong>View changes → Copy diff</strong> to hand them to a developer.');
    }

    renderSections();
    renderActions();
}

/**
 * Index ⇄ document navigation, handled in-page.
 *
 * The app router's hashchange listener compares only the part of the hash
 * BEFORE `?` (getRouteFromHash in app.js), so `#page-copy` → `#page-copy?doc=about`
 * is not a route change and never re-inits this module. Hub pages that carry
 * `?tab=` have the same constraint. So we listen ourselves, and unhook in
 * destroy() — leaving it attached would let a stale listener rebuild this page
 * over whatever the user navigated to next.
 */
function wireHashRouting() {
    _onHashChange = () => {
        if (!_container) return;
        if (location.hash.split('?')[0].replace('#', '') !== 'page-copy') return;
        const next = slugFromHash();
        if (next === _slug) return;
        _editors.forEach(e => { try { e.destroy(); } catch (_) { /* already detached */ } });
        _editors = [];
        if (next) renderDoc(_container, next);
        else { _slug = null; _sections = []; renderIndex(_container); }
    };
    window.addEventListener('hashchange', _onHashChange);
}

/* ─────────────────────────── module export ─────────────────────────── */

export default {
    async init(container) {
        _container = container;

        // UI gating only. The backend endpoints do their own owner check — a
        // client-side guard is a convenience, never a control (js/admin/auth.js).
        if (!AdminAuth.isOwner()) {
            container.innerHTML = `<div class="admin-empty"><h2>Access Restricted</h2>
        <p>Page Copy is owner-only.</p></div>`;
            return;
        }

        wireHashRouting();

        const slug = slugFromHash();
        if (slug) await renderDoc(container, slug);
        else renderIndex(container);
    },

    destroy() {
        _token++;
        if (_onHashChange) { window.removeEventListener('hashchange', _onHashChange); _onHashChange = null; }
        _editors.forEach(e => { try { e.destroy(); } catch (_) { /* already detached */ } });
        _editors = [];
        _sections = [];
        _originalHtml = '';
        _slug = null;
        _blobSha = null;
        _source = null;
        _container = null;
    },
};
