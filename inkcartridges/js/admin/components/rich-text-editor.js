/**
 * RichTextEditor — Simple WYSIWYG with contentEditable
 * Toolbar: Bold, Italic, Underline, OL, UL, Link, Source toggle
 */

const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s);

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

    // Source textarea (hidden by default)
    const source = document.createElement('textarea');
    source.className = 'rte-source';
    source.style.minHeight = `${minHeight}px`;
    source.style.display = 'none';

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

    // Paste — allow HTML paste in editor
    this._editor.addEventListener('paste', () => {
      setTimeout(() => this._fireChange(), 0);
    });
  }

  _toggleSource() {
    this._sourceMode = !this._sourceMode;
    const srcBtn = this._toolbar.querySelector('[data-cmd="source"]');

    if (this._sourceMode) {
      this._source.value = this._editor.innerHTML;
      this._editor.style.display = 'none';
      this._source.style.display = 'block';
      srcBtn.classList.add('active');
      // Disable formatting buttons in source mode
      this._toolbar.querySelectorAll('.rte-btn:not([data-cmd="source"])').forEach(b => b.disabled = true);
    } else {
      this._editor.innerHTML = this._source.value;
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
    if (this._sourceMode) return this._source.value;
    let html = this._editor.innerHTML;
    // Strip trailing empty paragraphs/divs that contentEditable inserts
    html = html.replace(/(<p>(\s|<br\s*\/?>|&nbsp;)*<\/p>|<div>(\s|<br\s*\/?>|&nbsp;)*<\/div>)+$/gi, '');
    html = html.trim();
    // Treat empty-looking content as empty string
    if (!html || html === '<br>' || html === '<div><br></div>') return '';
    return html;
  }

  setValue(html) {
    this._editor.innerHTML = html || '';
    this._source.value = html || '';
    this._fireChange();
  }

  destroy() {
    this._wrap.remove();
  }
}

export { RichTextEditor };
