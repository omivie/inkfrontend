/**
 * ADMIN-NAV.JS
 * ============
 * Single source of truth for admin sidebar navigation.
 * Renders a consistent nav into .admin-nav on all admin pages.
 */

'use strict';

var AdminNav = {
    items: [
        { label: 'Dashboard', href: '/html/admin/index.html', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' },
        { label: 'Orders', href: '/html/admin/orders.html', badge: true, icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>' },
        { label: 'Products', href: '/html/admin/products.html', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>' },
        { label: 'Customers', href: '/html/admin/customers.html', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
        { separator: 'Analytics' },
        { label: 'Revenue', href: '/html/admin/index.html?tab=revenue', tab: 'revenue', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
        { label: 'Customer Intel', href: '/html/admin/index.html?tab=customers-tab', tab: 'customers-tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
        { label: 'Inventory', href: '/html/admin/index.html?tab=inventory', tab: 'inventory', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>' },
        { label: 'Operations', href: '/html/admin/index.html?tab=operations', tab: 'operations', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' },
        { separator: 'System' },
        { label: 'Settings', href: '/html/admin/settings.html', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' }
    ],

    render: function() {
        var nav = document.querySelector('.admin-nav');
        if (!nav) return;

        var currentPath = window.location.pathname;
        var currentTab = new URLSearchParams(window.location.search).get('tab');
        var isDashboard = currentPath.indexOf('/admin/index.html') !== -1 || currentPath.endsWith('/admin/');

        var ul = document.createElement('ul');
        ul.className = 'admin-nav__list';

        this.items.forEach(function(item) {
            var li = document.createElement('li');

            if (item.separator) {
                li.className = 'admin-nav__separator';
                li.textContent = item.separator;
                ul.appendChild(li);
                return;
            }

            li.className = 'admin-nav__item';
            var a = document.createElement('a');
            a.className = 'admin-nav__link';

            // Determine active state
            var isActive = false;
            if (item.tab) {
                // Analytics tab link: active when on dashboard with matching tab
                isActive = isDashboard && currentTab === item.tab;
            } else if (item.href === '/html/admin/index.html') {
                // Dashboard link: active when on dashboard without a tab param (or overview)
                isActive = isDashboard && (!currentTab || currentTab === 'overview');
            } else {
                // Regular page link: match by pathname
                isActive = currentPath.indexOf(item.href) !== -1;
            }

            if (isActive) {
                a.classList.add('admin-nav__link--active');
            }

            // For analytics tab links on the dashboard, use data-tab for SPA switching
            if (item.tab && isDashboard) {
                a.href = '#';
                a.setAttribute('data-tab', item.tab);
            } else {
                a.href = item.href;
            }

            a.innerHTML = item.icon + '<span>' + item.label + '</span>';

            if (item.badge) {
                var badge = document.createElement('span');
                badge.className = 'admin-nav__badge';
                badge.id = 'orders-badge';
                badge.textContent = '0';
                a.appendChild(badge);
            }

            li.appendChild(a);
            ul.appendChild(li);
        });

        nav.innerHTML = '';
        nav.appendChild(ul);
    }
};

window.AdminNav = AdminNav;
