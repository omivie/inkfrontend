/**
 * Drawer — Slide-in panel from right
 */

const Drawer = {
  _root: null,
  _current: null,

  _getRoot() {
    if (!this._root) this._root = document.getElementById('drawer-root');
    return this._root;
  },

  open({ title, body, footer, width, onClose }) {
    this.close();
    const root = this._getRoot();
    if (!root) return null;

    const backdrop = document.createElement('div');
    backdrop.className = 'admin-drawer-backdrop';

    const drawer = document.createElement('div');
    drawer.className = 'admin-drawer';
    if (width) drawer.style.width = width;

    drawer.innerHTML = `
      <div class="admin-drawer__header">
        <span class="admin-drawer__title">${Security.escapeHtml(title)}</span>
        <button class="admin-drawer__close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="admin-drawer__body"></div>
      ${footer ? '<div class="admin-drawer__footer"></div>' : ''}
    `;

    root.appendChild(backdrop);
    root.appendChild(drawer);

    // Set body
    const bodyEl = drawer.querySelector('.admin-drawer__body');
    if (typeof body === 'string') {
      bodyEl.innerHTML = body;
    } else if (body instanceof HTMLElement) {
      bodyEl.appendChild(body);
    }

    // Set footer
    if (footer) {
      const footerEl = drawer.querySelector('.admin-drawer__footer');
      if (typeof footer === 'string') footerEl.innerHTML = footer;
      else if (footer instanceof HTMLElement) footerEl.appendChild(footer);
    }

    // Animate in
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      drawer.classList.add('open');
    });

    // Close handlers
    const close = () => this.close();
    drawer.querySelector('.admin-drawer__close').addEventListener('click', close);
    backdrop.addEventListener('click', close);
    const onKeydown = (e) => {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeydown); }
    };
    document.addEventListener('keydown', onKeydown);

    this._current = { backdrop, drawer, onClose, onKeydown };

    return {
      el: drawer,
      body: bodyEl,
      footer: drawer.querySelector('.admin-drawer__footer'),
      close,
      setLoading(loading) {
        if (loading) {
          bodyEl.innerHTML = `
            <div class="admin-skeleton admin-skeleton--text"></div>
            <div class="admin-skeleton admin-skeleton--text" style="width:60%"></div>
            <div class="admin-skeleton admin-skeleton--row"></div>
            <div class="admin-skeleton admin-skeleton--row"></div>
            <div class="admin-skeleton admin-skeleton--row"></div>
          `;
        }
      },
      setBody(content) {
        if (typeof content === 'string') bodyEl.innerHTML = content;
        else { bodyEl.innerHTML = ''; bodyEl.appendChild(content); }
      },
    };
  },

  close() {
    if (!this._current) return;
    const { backdrop, drawer, onClose, onKeydown } = this._current;
    backdrop.classList.remove('open');
    drawer.classList.remove('open');
    document.removeEventListener('keydown', onKeydown);
    setTimeout(() => {
      backdrop.remove();
      drawer.remove();
    }, 300);
    if (onClose) onClose();
    this._current = null;
  },

  isOpen() {
    return this._current !== null;
  },
};

export { Drawer };
