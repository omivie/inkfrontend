/**
 * Modal — Dialog system
 */

const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s);

const Modal = {
  _root: null,
  _current: null,

  _getRoot() {
    if (!this._root) this._root = document.getElementById('modal-root');
    return this._root;
  },

  open({ title, body, footer, onClose, className = '' }) {
    this.close();
    const root = this._getRoot();
    if (!root) return null;

    const backdrop = document.createElement('div');
    backdrop.className = 'admin-modal-backdrop';
    backdrop.innerHTML = `
      <div class="admin-modal ${className}">
        <div class="admin-modal__header">
          <h3>${esc(title)}</h3>
          <button class="admin-modal__close" aria-label="Close">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="admin-modal__body">${typeof body === 'string' ? body : ''}</div>
        <div class="admin-modal__footer">${typeof footer === 'string' ? footer : ''}</div>
      </div>
    `;

    root.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));

    // Close handlers
    const closeBtn = backdrop.querySelector('.admin-modal__close');
    closeBtn.addEventListener('click', () => this.close());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });
    const onKeydown = (e) => {
      if (e.key === 'Escape') { this.close(); document.removeEventListener('keydown', onKeydown); }
    };
    document.addEventListener('keydown', onKeydown);

    this._current = { backdrop, onClose, onKeydown };

    // If body is a DOM node
    if (body instanceof HTMLElement) {
      backdrop.querySelector('.admin-modal__body').innerHTML = '';
      backdrop.querySelector('.admin-modal__body').appendChild(body);
    }

    return {
      el: backdrop.querySelector('.admin-modal'),
      body: backdrop.querySelector('.admin-modal__body'),
      footer: backdrop.querySelector('.admin-modal__footer'),
      close: () => this.close(),
    };
  },

  close() {
    if (!this._current) return;
    const { backdrop, onClose, onKeydown } = this._current;
    backdrop.classList.remove('open');
    document.removeEventListener('keydown', onKeydown);
    setTimeout(() => backdrop.remove(), 250);
    if (onClose) onClose();
    this._current = null;
  },

  confirm({ title, message, confirmLabel = 'Confirm', confirmClass = 'admin-btn--danger', onConfirm }) {
    const modal = this.open({
      title,
      body: `<p style="margin:0;color:var(--text-secondary)">${esc(message)}</p>`,
      footer: `
        <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
        <button class="admin-btn ${confirmClass}" data-action="confirm">${esc(confirmLabel)}</button>
      `,
    });
    if (!modal) return;

    modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => this.close());
    modal.footer.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
      const btn = modal.footer.querySelector('[data-action="confirm"]');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      try {
        await onConfirm();
      } catch (e) {
        DebugLog.error('[Modal] confirm error:', e);
      }
      this.close();
    });
  },
};

export { Modal };
