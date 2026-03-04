/**
 * Toast — Notification system
 */

const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
};

const Toast = {
  _container: null,

  _getContainer() {
    if (!this._container) {
      this._container = document.getElementById('toast-root');
    }
    return this._container;
  },

  show(message, type = 'info', duration = 4000) {
    const container = this._getContainer();
    if (!container) return;

    const el = document.createElement('div');
    el.className = `admin-toast admin-toast--${type}`;
    el.innerHTML = `
      <span class="admin-toast__icon">${ICONS[type] || ICONS.info}</span>
      <span class="admin-toast__message">${typeof Security !== 'undefined' ? Security.escapeHtml(message) : message}</span>
      <button class="admin-toast__dismiss" aria-label="Dismiss">&times;</button>
      ${duration > 0 ? `<span class="admin-toast__progress" style="animation-duration:${duration}ms"></span>` : ''}
    `;

    // Dismiss handler
    el.querySelector('.admin-toast__dismiss').addEventListener('click', () => this._remove(el));

    container.appendChild(el);

    if (duration > 0) {
      setTimeout(() => this._remove(el), duration);
    }

    return el;
  },

  success(msg, duration) { return this.show(msg, 'success', duration); },
  error(msg, duration) { return this.show(msg, 'error', duration ?? 6000); },
  warning(msg, duration) { return this.show(msg, 'warning', duration); },
  info(msg, duration) { return this.show(msg, 'info', duration); },

  _remove(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('removing');
    setTimeout(() => el.remove(), 200);
  },
};

export { Toast };
