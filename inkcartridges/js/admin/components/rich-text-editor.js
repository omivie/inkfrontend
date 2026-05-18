/**
 * RichTextEditor — Simple WYSIWYG with contentEditable
 * Toolbar: Bold, Italic, Underline, OL, UL, Link, Source toggle
 *
 * Source mode contract (May 2026): the </> view shows real HTML — loose text
 * runs are wrapped in <p>, browser-inserted <div> line wrappers are promoted
 * to <p>, and block elements are pretty-printed one per line. Saves persist
 * the same normalized HTML so the source view round-trips.
 */

const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s);

/**
 * Strip all inline styles, classes, and style-only wrapper elements from HTML.
 * Keeps structural elements (b, strong, em, i, u, ol, ul, li, a, p, br, div).
 */
function sanitizeHTML(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Remove all style and class attributes
  tmp.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
  tmp.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));

  // Unwrap <font> elements (legacy Word/browser formatting)
  tmp.querySelectorAll('font').forEach(el => {
    el.replaceWith(...el.childNodes);
  });

  // Unwrap <span> elements that have no meaningful attributes left
  tmp.querySelectorAll('span').forEach(el => {
    if (!el.attributes.length) {
      el.replaceWith(...el.childNodes);
    }
  });

  // Normalise presentational tags to their semantic equivalents.
  // document.execCommand('bold'/'italic') emits <b>/<i>; the rest of the stack
  // — the backend sanitiser allowlist, the storefront PDP, schema.org markup —
  // expects <strong>/<em>. Rewriting here means Bold/Italic survive even a
  // round-trip through the stricter backend sanitiser. (Underline has no
  // semantic tag, so <u> is kept as-is.)
  const retag = (fromTag, toTag) => {
    tmp.querySelectorAll(fromTag).forEach(el => {
      const repl = document.createElement(toTag);
      while (el.firstChild) repl.appendChild(el.firstChild);
      el.replaceWith(repl);
    });
  };
  retag('b', 'strong');
  retag('i', 'em');

  return tmp.innerHTML;
}

const BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Wrap loose top-level inline / text runs in <p>, promote stray <div> line
 * wrappers to <p>, and drop trailing <br> inside paragraphs. Result is HTML
 * the source view can render as real structural markup.
 */
function normalizeBlocks(html) {
  const src = document.createElement('div');
  src.innerHTML = html;

  // Promote stray <div> line wrappers to <p>.
  src.querySelectorAll('div').forEach(div => {
    const p = document.createElement('p');
    while (div.firstChild) p.appendChild(div.firstChild);
    div.replaceWith(p);
  });

  // Walk top-level nodes; group consecutive inline runs into a <p>.
  const out = document.createElement('div');
  let runP = null;
  const isInlineLike = (n) => {
    if (n.nodeType === Node.TEXT_NODE) return true;
    if (n.nodeType !== Node.ELEMENT_NODE) return false;
    return !BLOCK_TAGS.has(n.tagName.toLowerCase());
  };
  const isMeaningful = (p) => {
    if (!p) return false;
    if (p.textContent.replace(/\s| /g, '') !== '') return true;
    return !!p.querySelector('img, a[href]');
  };
  const flushRun = () => {
    if (runP && isMeaningful(runP)) out.appendChild(runP);
    runP = null;
  };

  Array.from(src.childNodes).forEach(node => {
    if (isInlineLike(node)) {
      if (!runP) runP = document.createElement('p');
      runP.appendChild(node);
    } else {
      flushRun();
      out.appendChild(node);
    }
  });
  flushRun();

  // Strip trailing <br> inside each <p>.
  out.querySelectorAll('p').forEach(p => {
    while (p.lastChild && p.lastChild.nodeType === Node.ELEMENT_NODE && p.lastChild.tagName.toLowerCase() === 'br') {
      p.removeChild(p.lastChild);
    }
  });

  return out.innerHTML;
}

/**
 * Pretty-print HTML so block elements appear on their own line. Read-only
 * formatting for the source textarea — does not change semantics.
 */
function prettyPrintHTML(html) {
  if (!html) return '';
  let out = html;
  out = out.replace(/(<(p|div|ul|ol|li|blockquote|pre|h[1-6])(\s[^>]*)?>)/gi, '\n$1');
  out = out.replace(/(<\/(p|div|ul|ol|li|blockquote|pre|h[1-6])>)/gi, '$1\n');
  out = out.replace(/\n{2,}/g, '\n').trim();
  return out;
}

class RichTextEditor {
  /**
   * @param {HTMLElement} container - Element to render the editor into
   * @param {Object} opts
   * @param {string} opts.initialValue - Initial HTML content
   * @param {Function} opts.onChange - Called with HTML string on content change
   * @param {string} opts.placeholder - Placeholder text
   * @param {number} opts.minHeight - Min height in px (default 160)
   */
  constructor(container, { initialValue = '', onChange = null, placeholder = '', minHeight = 160 } = {}) {
    this._container = container;
    this._onChange = onChange;
    this._sourceMode = false;
    this._render(initialValue, placeholder, minHeight);
  }

  _render(initialValue, placeholder, minHeight) {
    const wrap = document.createElement('div');
    wrap.className = 'rte-wrap';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'rte-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="rte-btn" data-cmd="bold" title="Bold"><strong>B</strong></button>
      <button type="button" class="rte-btn" data-cmd="italic" title="Italic"><em>I</em></button>
      <button type="button" class="rte-btn" data-cmd="underline" title="Underline"><u>U</u></button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" data-cmd="insertOrderedList" title="Ordered List">OL</button>
      <button type="button" class="rte-btn" data-cmd="insertUnorderedList" title="Unordered List">UL</button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn rte-btn--link" data-cmd="createLink" title="Insert Link">🔗</button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn rte-btn--source" data-cmd="source" title="Toggle HTML source">&lt;/&gt;</button>
    `;

    // WYSIWYG area
    const editor = document.createElement('div');
    editor.className = 'rte-editor';
    editor.contentEditable = 'true';
    editor.style.minHeight = `${minHeight}px`;
    if (placeholder) editor.dataset.placeholder = placeholder;
    if (initialValue) editor.innerHTML = initialValue;

    // Force <p> as the default paragraph wrapper so Enter creates structural
    // markup rather than <div> (Chrome) or naked text (Safari).
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}

    // Source textarea (hidden by default) — monospace so HTML reads as code.
    const source = document.createElement('textarea');
    source.className = 'rte-source';
    source.style.minHeight = `${minHeight}px`;
    source.style.display = 'none';
    source.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    source.style.whiteSpace = 'pre';
    source.setAttribute('spellcheck', 'false');

    wrap.appendChild(toolbar);
    wrap.appendChild(editor);
    wrap.appendChild(source);
    this._container.appendChild(wrap);

    this._wrap = wrap;
    this._toolbar = toolbar;
    this._editor = editor;
    this._source = source;

    this._bindEvents();
  }

  _bindEvents() {
    // Toolbar buttons
    this._toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.rte-btn');
      if (!btn) return;
      e.preventDefault();
      const cmd = btn.dataset.cmd;

      if (cmd === 'source') {
        this._toggleSource();
        return;
      }

      if (cmd === 'createLink') {
        const url = prompt('Enter URL:');
        if (url) document.execCommand('createLink', false, url);
        this._fireChange();
        return;
      }

      document.execCommand(cmd, false, null);
      this._editor.focus();
      this._fireChange();
    });

    // Content changes
    this._editor.addEventListener('input', () => this._fireChange());

    // Source textarea changes
    this._source.addEventListener('input', () => this._fireChange());

    // Paste — strip inline styles from pasted content
    this._editor.addEventListener('paste', (e) => {
      e.preventDefault();
      const html = e.clipboardData.getData('text/html');
      const text = e.clipboardData.getData('text/plain');

      if (html) {
        const clean = sanitizeHTML(html);
        document.execCommand('insertHTML', false, clean);
      } else if (text) {
        document.execCommand('insertText', false, text);
      }
      this._fireChange();
    });
  }

  _toggleSource() {
    this._sourceMode = !this._sourceMode;
    const srcBtn = this._toolbar.querySelector('[data-cmd="source"]');

    if (this._sourceMode) {
      // Normalize first so the source view shows real <p> tags around loose
      // content, then pretty-print so each block sits on its own line.
      const normalized = normalizeBlocks(sanitizeHTML(this._editor.innerHTML));
      this._editor.innerHTML = normalized;
      this._source.value = prettyPrintHTML(normalized);
      this._editor.style.display = 'none';
      this._source.style.display = 'block';
      srcBtn.classList.add('active');
      this._toolbar.querySelectorAll('.rte-btn:not([data-cmd="source"])').forEach(b => b.disabled = true);
    } else {
      // Source → WYSIWYG: collapse the cosmetic newlines so they don't render
      // as extra whitespace, then push back into the editor.
      const html = this._source.value.replace(/>\s+</g, '><').trim();
      this._editor.innerHTML = html;
      this._source.style.display = 'none';
      this._editor.style.display = 'block';
      srcBtn.classList.remove('active');
      this._toolbar.querySelectorAll('.rte-btn').forEach(b => b.disabled = false);
    }
    this._fireChange();
  }

  _fireChange() {
    if (this._onChange) this._onChange(this.getValue());
  }

  getValue() {
    let html;
    if (this._sourceMode) {
      // Strip cosmetic whitespace between tags so saved HTML is compact.
      html = this._source.value.replace(/>\s+</g, '><').trim();
    } else {
      html = this._editor.innerHTML;
    }
    // Strip trailing empty paragraphs/divs that contentEditable inserts
    html = html.replace(/(<p>(\s|<br\s*\/?>|&nbsp;)*<\/p>|<div>(\s|<br\s*\/?>|&nbsp;)*<\/div>)+$/gi, '');
    html = html.trim();
    if (!html || html === '<br>' || html === '<div><br></div>') return '';
    return sanitizeHTML(html);
  }

  setValue(html) {
    const normalized = normalizeBlocks(sanitizeHTML(html || ''));
    this._editor.innerHTML = normalized;
    this._source.value = prettyPrintHTML(normalized);
    this._fireChange();
  }

  destroy() {
    this._wrap.remove();
  }
}

export { RichTextEditor };
