/**
 * DataTable — Reusable data table with sort, pagination, loading states
 */

const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s);

class DataTable {
  /**
   * @param {HTMLElement} container
   * @param {Object} config
   * @param {Array<{key, label, sortable?, render?, className?, align?}>} config.columns
   * @param {Function} config.onRowClick
   * @param {Function} config.onSort
   * @param {Function} config.onPageChange
   * @param {string} config.emptyMessage
   * @param {string} config.emptyIcon
   * @param {string} config.rowKey - property name for unique row ID
   */
  constructor(container, config) {
    this.container = container;
    this.config = config;
    this.data = [];
    this.pagination = null;
    this.sortKey = null;
    this.sortDir = 'desc';
    this._render();
  }

  setData(rows, pagination = null) {
    this.data = rows || [];
    this.pagination = pagination;
    this._render();
  }

  setLoading(loading) {
    if (loading) {
      let html = '<div class="admin-card"><div class="admin-table-wrap"><table class="admin-table"><thead><tr>';
      for (const col of this.config.columns) {
        html += `<th>${esc(col.label)}</th>`;
      }
      html += '</tr></thead><tbody>';
      for (let i = 0; i < 8; i++) {
        html += '<tr>';
        for (const col of this.config.columns) {
          html += `<td><div class="admin-skeleton admin-skeleton--text" style="width:${60 + Math.random() * 30}%"></div></td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div></div>';
      this.container.innerHTML = html;
    }
  }

  setSort(key, dir) {
    this.sortKey = key;
    this.sortDir = dir;
    this._render();
  }

  _render() {
    const { columns, onRowClick, emptyMessage, emptyIcon } = this.config;

    if (!this.data.length) {
      this.container.innerHTML = `
        <div class="admin-card">
          <div class="admin-empty">
            ${emptyIcon ? `<div class="admin-empty__icon">${emptyIcon}</div>` : ''}
            <div class="admin-empty__title">${esc(emptyMessage || 'No data found')}</div>
            <div class="admin-empty__text">Try adjusting your filters or search terms.</div>
          </div>
        </div>
      `;
      return;
    }

    let html = '<div class="admin-card admin-mb-0"><div class="admin-table-wrap"><table class="admin-table"><thead><tr>';
    for (const col of columns) {
      const sortCls = col.sortable ? ' sortable' : '';
      const activeCls = this.sortKey === col.key ? ` sort-${this.sortDir}` : '';
      const arrow = col.sortable ? `<span class="sort-arrow">${this.sortKey === col.key ? (this.sortDir === 'asc' ? '▲' : '▼') : '▽'}</span>` : '';
      const alignCls = col.align === 'right' ? ' cell-right' : '';
      html += `<th class="${sortCls}${activeCls}${alignCls}" data-sort-key="${col.key || ''}">${esc(col.label)}${arrow}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const row of this.data) {
      const rowKey = this.config.rowKey ? row[this.config.rowKey] : '';
      const clickable = onRowClick ? ' clickable' : '';
      html += `<tr class="${clickable}" data-row-key="${esc(String(rowKey))}">`;
      for (const col of columns) {
        const alignCls = col.align === 'right' ? ' cell-right' : '';
        const extraCls = col.className ? ` ${col.className}` : '';
        const value = col.render ? col.render(row) : (row[col.key] ?? '\u2014');
        html += `<td class="${alignCls}${extraCls}">${value}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    // Pagination
    if (this.pagination) {
      html += this._renderPagination();
    }

    html += '</div>';
    this.container.innerHTML = html;
    this._bindEvents();
  }

  _renderPagination() {
    const p = this.pagination;
    const total = p.total || 0;
    const page = p.page || 1;
    const limit = p.limit || p.per_page || 20;
    const totalPages = Math.ceil(total / limit) || 1;
    const from = ((page - 1) * limit) + 1;
    const to = Math.min(page * limit, total);

    let html = '<div class="admin-pagination">';
    html += `<span class="admin-pagination__info">${from}\u2013${to} of ${total}</span>`;
    html += '<div class="admin-pagination__btns">';
    html += `<button class="admin-pagination__btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>\u2190 Prev</button>`;

    // Page numbers (max 5 shown)
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html += `<button class="admin-pagination__btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }

    html += `<button class="admin-pagination__btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Next \u2192</button>`;
    html += '</div></div>';
    return html;
  }

  _bindEvents() {
    // Sort
    if (this.config.onSort) {
      this.container.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.dataset.sortKey;
          if (this.sortKey === key) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            this.sortKey = key;
            this.sortDir = 'desc';
          }
          this.config.onSort(this.sortKey, this.sortDir);
        });
      });
    }

    // Row click
    if (this.config.onRowClick) {
      this.container.querySelectorAll('tr.clickable').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input')) return;
          const sel = window.getSelection();
          if (sel && sel.toString().length > 0) return;
          const key = tr.dataset.rowKey;
          const row = this.data.find(r => String(r[this.config.rowKey]) === key);
          if (row) this.config.onRowClick(row);
        });
      });
    }

    // Pagination
    if (this.config.onPageChange) {
      this.container.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          const page = parseInt(btn.dataset.page, 10);
          if (page > 0) this.config.onPageChange(page);
        });
      });
    }
  }

  destroy() {
    this.container.innerHTML = '';
    this.data = [];
  }
}

export { DataTable };
