/**
 * Sync Report Page — Admin feed sync review & bulk publish
 * Loads data from GET /api/admin/sync-report and allows
 * publishing staged products via POST /api/admin/bulk-publish.
 *
 * Uses global window.API for REST calls (loaded via <script defer>).
 */

const SyncReportPage = {
    items: [],
    summary: null,
    importRun: null,
    selectedSkus: new Set(),
    currentPage: 1,
    totalPages: 1,
    filters: { action: '', priority: '', source: '' },

    async init() {
        this.bindEvents();
        await this.loadReport();
    },

    bindEvents() {
        // Filters
        document.getElementById('filter-action')?.addEventListener('change', (e) => {
            this.filters.action = e.target.value;
            this.currentPage = 1;
            this.loadReport();
        });
        document.getElementById('filter-priority')?.addEventListener('change', (e) => {
            this.filters.priority = e.target.value;
            this.currentPage = 1;
            this.loadReport();
        });
        document.getElementById('filter-source')?.addEventListener('change', (e) => {
            this.filters.source = e.target.value;
            this.currentPage = 1;
            this.loadReport();
        });

        // Select all checkbox
        document.getElementById('select-all-checkbox')?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            this.items.forEach(item => {
                if (!item.published_at) {
                    if (checked) this.selectedSkus.add(item.sku);
                    else this.selectedSkus.delete(item.sku);
                }
            });
            this.updateCheckboxes();
            this.updatePublishButton();
        });

        // Select all normal
        document.getElementById('select-all-normal-btn')?.addEventListener('click', () => {
            this.items.forEach(item => {
                if (!item.published_at && item.priority === 'normal') {
                    this.selectedSkus.add(item.sku);
                }
            });
            this.updateCheckboxes();
            this.updatePublishButton();
        });

        // Publish selected
        document.getElementById('publish-selected-btn')?.addEventListener('click', () => {
            this.publishSelected();
        });

        // Refresh
        document.getElementById('refresh-btn')?.addEventListener('click', () => {
            this.loadReport();
        });
    },

    async loadReport() {
        const params = {
            page: this.currentPage,
            limit: 50,
        };
        if (this.filters.action) params.action = this.filters.action;
        if (this.filters.priority) params.priority = this.filters.priority;
        if (this.filters.source) params.source = this.filters.source;

        const qp = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') qp.set(k, v); });
        const resp = await window.API.get(`/api/admin/sync-report?${qp}`);
        if (!resp || !resp.ok) {
            this.showEmpty();
            return;
        }

        const data = resp.data;
        this.items = data.items || [];
        this.summary = data.summary || {};
        this.importRun = data.import_run || null;
        this.totalPages = resp.meta?.total_pages || 1;
        this.currentPage = resp.meta?.page || 1;

        this.renderImportInfo();
        this.renderSummary();
        this.renderTable();
        this.renderPagination();
    },

    renderImportInfo() {
        const el = document.getElementById('import-info');
        if (!el || !this.importRun) {
            if (el) el.style.display = 'none';
            return;
        }
        el.style.display = 'flex';

        const scriptEl = document.getElementById('import-script');
        const statusEl = document.getElementById('import-status');
        const timeEl = document.getElementById('import-time');
        const countsEl = document.getElementById('import-counts');

        if (scriptEl) scriptEl.textContent = this.importRun.script_name || 'Unknown';
        if (statusEl) statusEl.textContent = this.importRun.status || '-';
        if (timeEl && this.importRun.finished_at) {
            const d = new Date(this.importRun.finished_at);
            timeEl.textContent = d.toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
        }
        if (countsEl) {
            const u = this.importRun.products_upserted || 0;
            const d = this.importRun.products_deactivated || 0;
            const s = this.importRun.products_skipped || 0;
            countsEl.textContent = `${u} upserted, ${d} deactivated, ${s} skipped`;
        }
    },

    renderSummary() {
        const s = this.summary;
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? '-';
        };
        set('summary-added', s.added);
        set('summary-updated', s.updated);
        set('summary-removed', s.removed);
        set('summary-high', s.high_priority);
        set('summary-auto', s.auto_approved);
    },

    renderTable() {
        const tbody = document.getElementById('sync-tbody');
        const empty = document.getElementById('sync-empty');
        const table = document.getElementById('sync-table');
        const countEl = document.getElementById('items-count');

        if (!tbody) return;

        if (!this.items.length) {
            this.showEmpty();
            return;
        }

        if (table) table.style.display = '';
        if (empty) empty.style.display = 'none';
        if (countEl) countEl.textContent = `${this.items.length} items`;

        tbody.innerHTML = this.items.map(item => {
            const checked = this.selectedSkus.has(item.sku) ? 'checked' : '';
            const disabled = item.published_at ? 'disabled' : '';
            const actionBadge = this.getActionBadge(item.action);
            const priorityBadge = this.getPriorityBadge(item);
            const details = this.getDetailsHtml(item);
            const status = item.published_at
                ? `<span class="priority-badge priority-badge--green">Published</span>`
                : `<span class="priority-badge priority-badge--gray">Pending</span>`;

            return `<tr>
                <td><input type="checkbox" data-sku="${this.esc(item.sku)}" ${checked} ${disabled}></td>
                <td><strong>${this.esc(item.sku)}</strong></td>
                <td>${this.esc(item.source || '-')}</td>
                <td>${actionBadge}</td>
                <td>${priorityBadge}</td>
                <td>${details}</td>
                <td>${status}</td>
            </tr>`;
        }).join('');

        // Bind row checkboxes
        tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const sku = cb.dataset.sku;
                if (cb.checked) this.selectedSkus.add(sku);
                else this.selectedSkus.delete(sku);
                this.updatePublishButton();
            });
        });
    },

    getActionBadge(action) {
        const map = {
            'ADD': '<span class="action-badge action-badge--add">ADD</span>',
            'UPDATE': '<span class="action-badge action-badge--update">UPDATE</span>',
            'REMOVE': '<span class="action-badge action-badge--remove">REMOVE</span>',
        };
        return map[action] || `<span class="action-badge">${this.esc(action)}</span>`;
    },

    getPriorityBadge(item) {
        if (item.priority !== 'high') return '<span class="priority-badge priority-badge--gray">Normal</span>';
        const reasons = item.priority_reasons || [];
        if (reasons.includes('price_anomaly')) return '<span class="priority-badge priority-badge--orange">Price Spike</span>';
        if (reasons.includes('missing_image')) return '<span class="priority-badge priority-badge--red">No Image</span>';
        if (reasons.includes('missing_compatibility')) return '<span class="priority-badge priority-badge--yellow">No Printers</span>';
        if (reasons.includes('duplicate_suspect')) return '<span class="priority-badge priority-badge--orange">Duplicate?</span>';
        return '<span class="priority-badge priority-badge--yellow">Review</span>';
    },

    getDetailsHtml(item) {
        if (item.action === 'ADD' && item.new_data) {
            const name = item.new_data.name || '';
            const price = item.new_data.retail_price != null ? `$${Number(item.new_data.retail_price).toFixed(2)}` : '';
            return `<div class="sync-diff"><div>${this.esc(name)}</div>${price ? `<div>${price}</div>` : ''}</div>`;
        }
        if (item.action === 'UPDATE' && item.changed_fields?.length) {
            const diffs = item.changed_fields.slice(0, 3).map(field => {
                const oldVal = item.old_data?.[field];
                const newVal = item.new_data?.[field];
                return `<div><strong>${this.esc(field)}:</strong> <span class="sync-diff__old">${this.esc(String(oldVal ?? ''))}</span> &rarr; <span class="sync-diff__new">${this.esc(String(newVal ?? ''))}</span></div>`;
            });
            if (item.changed_fields.length > 3) {
                diffs.push(`<div style="color: var(--color-text-muted);">+${item.changed_fields.length - 3} more</div>`);
            }
            return `<div class="sync-diff">${diffs.join('')}</div>`;
        }
        if (item.action === 'REMOVE') {
            const name = item.old_data?.name || item.new_data?.name || '';
            return `<div class="sync-diff" style="color: var(--color-text-muted);">${this.esc(name)}</div>`;
        }
        return '-';
    },

    showEmpty() {
        const table = document.getElementById('sync-table');
        const empty = document.getElementById('sync-empty');
        if (table) table.style.display = 'none';
        if (empty) empty.style.display = '';
        const countEl = document.getElementById('items-count');
        if (countEl) countEl.textContent = '0 items';
    },

    renderPagination() {
        const container = document.getElementById('sync-pagination');
        if (!container || this.totalPages <= 1) {
            if (container) container.style.display = 'none';
            return;
        }
        container.style.display = 'flex';
        container.innerHTML = '';

        const prevBtn = document.createElement('button');
        prevBtn.textContent = 'Prev';
        prevBtn.disabled = this.currentPage <= 1;
        prevBtn.addEventListener('click', () => { this.currentPage--; this.loadReport(); });
        container.appendChild(prevBtn);

        for (let i = 1; i <= this.totalPages; i++) {
            const btn = document.createElement('button');
            btn.textContent = i;
            if (i === this.currentPage) btn.classList.add('active');
            btn.addEventListener('click', () => { this.currentPage = i; this.loadReport(); });
            container.appendChild(btn);
        }

        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next';
        nextBtn.disabled = this.currentPage >= this.totalPages;
        nextBtn.addEventListener('click', () => { this.currentPage++; this.loadReport(); });
        container.appendChild(nextBtn);
    },

    updateCheckboxes() {
        document.querySelectorAll('#sync-tbody input[type="checkbox"]').forEach(cb => {
            cb.checked = this.selectedSkus.has(cb.dataset.sku);
        });
    },

    updatePublishButton() {
        const btn = document.getElementById('publish-selected-btn');
        const count = document.getElementById('selected-count');
        if (btn) btn.disabled = this.selectedSkus.size === 0;
        if (count) count.textContent = this.selectedSkus.size;
    },

    async publishSelected() {
        if (this.selectedSkus.size === 0) return;

        const skus = [...this.selectedSkus];
        const btn = document.getElementById('publish-selected-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Publishing...';
        }

        try {
            const bulkResp = await window.API.post('/api/admin/bulk-publish', { skus });
            const result = bulkResp?.data ?? bulkResp;
            const published = result?.published || 0;
            const invalid = result?.invalid_skus || [];

            if (typeof Toast !== 'undefined') {
                Toast.success(`Published ${published} product${published !== 1 ? 's' : ''}`);
                if (invalid.length) {
                    Toast.warning(`${invalid.length} SKU${invalid.length !== 1 ? 's' : ''} could not be published: ${invalid.join(', ')}`);
                }
            }

            this.selectedSkus.clear();
            this.updatePublishButton();
            await this.loadReport();
        } catch (e) {
            if (typeof Toast !== 'undefined') {
                Toast.error(`Publish failed: ${e.message}`);
            }
        } finally {
            if (btn) {
                btn.disabled = this.selectedSkus.size === 0;
                btn.innerHTML = `Publish Selected (<span id="selected-count">${this.selectedSkus.size}</span>)`;
            }
        }
    },

    esc(str) {
        if (typeof Security !== 'undefined' && Security.escapeHtml) return Security.escapeHtml(str);
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    },
};

// Initialize when DOM is ready and admin auth is verified
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => SyncReportPage.init(), 300);
    });
} else {
    setTimeout(() => SyncReportPage.init(), 300);
}

window.SyncReportPage = SyncReportPage;
