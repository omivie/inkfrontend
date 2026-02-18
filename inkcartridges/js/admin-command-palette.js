/**
 * ADMIN-COMMAND-PALETTE.JS
 * ========================
 * Cmd+K command palette for the admin dashboard.
 * Keyboard navigable, fuzzy search on commands.
 */

'use strict';

const CommandPalette = {
    isOpen: false,
    activeIndex: 0,
    results: [],
    _inputHandler: null,
    _keyHandler: null,

    commands: [
        { label: 'Go to Orders', keywords: 'orders list manage', group: 'Navigate', action: function() { window.location.href = '/html/admin/orders.html'; } },
        { label: 'Go to Products', keywords: 'products catalog inventory', group: 'Navigate', action: function() { window.location.href = '/html/admin/products.html'; } },
        { label: 'Go to Customers', keywords: 'customers users people', group: 'Navigate', action: function() { window.location.href = '/html/admin/customers.html'; } },
        { label: 'Go to Settings', keywords: 'settings config preferences', group: 'Navigate', action: function() { window.location.href = '/html/admin/settings.html'; } },
        { label: 'View Store', keywords: 'store shop frontend site', group: 'Navigate', action: function() { window.open('/html/index.html', '_blank'); } },
        { label: 'Overview Tab', keywords: 'overview dashboard home', group: 'Tabs', action: function() { Admin.switchTab('overview'); } },
        { label: 'Revenue Tab', keywords: 'revenue sales financial money', group: 'Tabs', action: function() { Admin.switchTab('revenue'); } },
        { label: 'Customers Tab', keywords: 'customers intelligence ltv churn', group: 'Tabs', action: function() { Admin.switchTab('customers-tab'); } },
        { label: 'Inventory Tab', keywords: 'inventory stock dead low', group: 'Tabs', action: function() { Admin.switchTab('inventory'); } },
        { label: 'Operations Tab', keywords: 'operations pipeline fulfilment funnel', group: 'Tabs', action: function() { Admin.switchTab('operations'); } },
        { label: 'Toggle Dark Mode', keywords: 'theme dark light mode toggle', group: 'Actions', action: function() { Admin.toggleTheme(); } },
        { label: 'Collapse Sidebar', keywords: 'sidebar collapse expand toggle', group: 'Actions', action: function() { Admin.toggleSidebar(); } }
    ],

    open: function() {
        this.isOpen = true;
        var backdrop = document.getElementById('cmd-backdrop');
        var input = document.getElementById('cmd-input');
        if (!backdrop || !input) return;
        backdrop.classList.add('admin-cmd-backdrop--open');
        input.value = '';
        input.focus();
        this.search('');
        this.bindPaletteEvents();
    },

    close: function() {
        this.isOpen = false;
        var backdrop = document.getElementById('cmd-backdrop');
        if (backdrop) backdrop.classList.remove('admin-cmd-backdrop--open');
        this.unbindPaletteEvents();
    },

    toggle: function() {
        if (this.isOpen) this.close();
        else this.open();
    },

    bindPaletteEvents: function() {
        var self = this;
        var input = document.getElementById('cmd-input');
        var backdrop = document.getElementById('cmd-backdrop');

        this._inputHandler = function() { self.search(input.value); };
        this._keyHandler = function(e) {
            if (e.key === 'Escape') { e.preventDefault(); self.close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); self.moveSelection(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); self.moveSelection(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); self.executeSelected(); }
        };

        input.addEventListener('input', this._inputHandler);
        input.addEventListener('keydown', this._keyHandler);
        backdrop.addEventListener('click', function handler(e) {
            if (e.target === backdrop) {
                self.close();
                backdrop.removeEventListener('click', handler);
            }
        });
    },

    unbindPaletteEvents: function() {
        var input = document.getElementById('cmd-input');
        if (input && this._inputHandler) input.removeEventListener('input', this._inputHandler);
        if (input && this._keyHandler) input.removeEventListener('keydown', this._keyHandler);
    },

    search: function(query) {
        var q = query.toLowerCase().trim();
        if (q === '') {
            this.results = this.commands;
        } else {
            this.results = this.commands.filter(function(c) {
                return c.label.toLowerCase().indexOf(q) !== -1 ||
                    (c.keywords && c.keywords.indexOf(q) !== -1);
            });
        }
        this.activeIndex = 0;
        this.renderResults();
    },

    renderResults: function() {
        var container = document.getElementById('cmd-results');
        if (!container) return;

        if (this.results.length === 0) {
            container.innerHTML = '<div class="admin-cmd__empty">No results found</div>';
            return;
        }

        var self = this;
        container.innerHTML = '';

        // Group results
        var groups = {};
        this.results.forEach(function(cmd, i) {
            var g = cmd.group || 'General';
            if (!groups[g]) groups[g] = [];
            groups[g].push({ cmd: cmd, idx: i });
        });

        Object.keys(groups).forEach(function(groupName) {
            var groupLabel = document.createElement('div');
            groupLabel.className = 'admin-cmd__group';
            groupLabel.textContent = groupName;
            container.appendChild(groupLabel);

            groups[groupName].forEach(function(item) {
                var div = document.createElement('div');
                div.className = 'admin-cmd__item' + (item.idx === self.activeIndex ? ' admin-cmd__item--active' : '');
                div.setAttribute('data-index', item.idx);

                var icon = document.createElement('div');
                icon.className = 'admin-cmd__item-icon';
                icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
                div.appendChild(icon);

                var text = document.createElement('div');
                text.className = 'admin-cmd__item-text';
                text.textContent = item.cmd.label;
                div.appendChild(text);

                div.addEventListener('click', function() {
                    item.cmd.action();
                    self.close();
                });
                container.appendChild(div);
            });
        });
    },

    moveSelection: function(delta) {
        this.activeIndex = Math.max(0, Math.min(this.results.length - 1, this.activeIndex + delta));
        this.renderResults();
        // Scroll active item into view
        var active = document.querySelector('.admin-cmd__item--active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    },

    executeSelected: function() {
        if (this.results[this.activeIndex]) {
            this.results[this.activeIndex].action();
            this.close();
        }
    }
};

window.CommandPalette = CommandPalette;
