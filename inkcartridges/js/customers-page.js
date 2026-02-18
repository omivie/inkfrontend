/**
 * CUSTOMERS PAGE
 * ==============
 *
 * Admin customers management page.
 * Uses backend API (GET /api/admin/customers) which:
 *   - Verifies admin role before returning data
 *   - Logs all admin data access for audit trail
 *   - Returns customer data with order statistics
 */

var CustomersPage = {
    customers: [],
    filteredCustomers: [],
    filters: {
        search: '',
        type: '',
        sort: 'newest'
    },

    init: function() {
        var self = this;
        this.loadCustomers().then(function() {
            self.bindEvents();
        });
    },

    bindEvents: function() {
        var self = this;
        var searchTimeout;

        document.getElementById('customer-search').addEventListener('input', function(e) {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() {
                self.filters.search = e.target.value.toLowerCase();
                self.applyFilters();
            }, 200);
        });

        var chips = document.querySelectorAll('.filter-chip[data-type]');
        for (var i = 0; i < chips.length; i++) {
            (function(chip) {
                chip.addEventListener('click', function() {
                    var allChips = document.querySelectorAll('.filter-chip[data-type]');
                    for (var j = 0; j < allChips.length; j++) {
                        allChips[j].classList.remove('filter-chip--active');
                    }
                    chip.classList.add('filter-chip--active');
                    self.filters.type = chip.dataset.type;
                    self.applyFilters();
                });
            })(chips[i]);
        }

        document.getElementById('sort-filter').addEventListener('change', function(e) {
            self.filters.sort = e.target.value;
            self.applyFilters();
        });

        document.getElementById('clear-filters').addEventListener('click', function() {
            self.clearFilters();
        });

        document.getElementById('export-format').addEventListener('change', function(e) {
            if (e.target.value) {
                self.exportData(e.target.value);
                e.target.value = '';
            }
        });
    },

    loadCustomers: function() {
        var self = this;

        return new Promise(async function(resolve) {
            try {
                // Use backend API instead of direct Supabase access
                const response = await API.getAdminCustomers({ limit: 100 });

                if (response.success && response.data) {
                    const customers = response.data.customers || response.data || [];

                    self.customers = customers.map(function(customer) {
                        return {
                            id: customer.id,
                            full_name: customer.full_name || '',
                            email: customer.email || '',
                            created_at: customer.created_at,
                            order_count: customer.order_count || 0,
                            total_spent: customer.total_spent || 0
                        };
                    });
                } else {
                    console.error('Error loading customers:', response.error);
                    self.customers = [];
                }

                self.applyFilters();
                resolve();

            } catch (error) {
                console.error('Error loading customers:', error);
                self.customers = [];
                self.applyFilters();
                resolve();
            }
        });
    },

    getCustomerType: function(customer) {
        var totalSpent = customer.total_spent || 0;
        var orderCount = customer.order_count || 0;
        var daysSinceJoined = customer.created_at
            ? Math.floor((Date.now() - new Date(customer.created_at).getTime()) / (1000 * 60 * 60 * 24))
            : 365;

        if (totalSpent >= 500 || orderCount >= 5) return 'vip';
        if (daysSinceJoined <= 30) return 'new';
        return 'regular';
    },

    applyFilters: function() {
        var self = this;
        var filtered = this.customers.slice();

        if (this.filters.search) {
            filtered = filtered.filter(function(c) {
                return (c.full_name || '').toLowerCase().indexOf(self.filters.search) !== -1 ||
                       (c.email || '').toLowerCase().indexOf(self.filters.search) !== -1;
            });
        }

        if (this.filters.type) {
            filtered = filtered.filter(function(c) {
                return self.getCustomerType(c) === self.filters.type;
            });
        }

        filtered.sort(function(a, b) {
            switch (self.filters.sort) {
                case 'newest': return new Date(b.created_at || 0) - new Date(a.created_at || 0);
                case 'oldest': return new Date(a.created_at || 0) - new Date(b.created_at || 0);
                case 'spent-high': return (b.total_spent || 0) - (a.total_spent || 0);
                case 'spent-low': return (a.total_spent || 0) - (b.total_spent || 0);
                case 'orders-high': return (b.order_count || 0) - (a.order_count || 0);
                case 'name-asc': return (a.full_name || '').localeCompare(b.full_name || '');
                default: return 0;
            }
        });

        this.filteredCustomers = filtered;
        this.renderCustomers();
        this.updateTypeCounts();
        this.updateResultsCount();
        this.updateClearButton();
    },

    updateTypeCounts: function() {
        var self = this;
        var counts = { all: this.customers.length, vip: 0, regular: 0, new: 0 };
        for (var i = 0; i < this.customers.length; i++) {
            var type = this.getCustomerType(this.customers[i]);
            counts[type]++;
        }
        document.getElementById('count-all').textContent = counts.all;
        document.getElementById('count-vip').textContent = counts.vip;
        document.getElementById('count-regular').textContent = counts.regular;
        document.getElementById('count-new').textContent = counts.new;
    },

    updateResultsCount: function() {
        document.getElementById('results-count').innerHTML = '<strong>' + this.filteredCustomers.length + '</strong> customers';
    },

    updateClearButton: function() {
        var hasFilters = this.filters.search || this.filters.type;
        document.getElementById('clear-filters').style.display = hasFilters ? 'inline-flex' : 'none';
    },

    clearFilters: function() {
        this.filters = { search: '', type: '', sort: 'newest' };
        document.getElementById('customer-search').value = '';
        document.getElementById('sort-filter').value = 'newest';
        var chips = document.querySelectorAll('.filter-chip[data-type]');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.remove('filter-chip--active');
        }
        document.querySelector('.filter-chip[data-type=""]').classList.add('filter-chip--active');
        this.applyFilters();
    },

    renderCustomers: function() {
        var self = this;
        var tbody = document.getElementById('customers-table-body');
        if (!this.filteredCustomers || this.filteredCustomers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No customers found</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < this.filteredCustomers.length; i++) {
            var customer = this.filteredCustomers[i];
            var type = this.getCustomerType(customer);
            var typeLabels = { vip: 'VIP', regular: 'Regular', new: 'New' };
            var joinDate = customer.created_at
                ? new Date(customer.created_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
                : '--';
            var totalSpent = customer.total_spent ? formatPrice(customer.total_spent) : '$0.00';

            html += '<tr>' +
                '<td><strong>' + Security.escapeHtml(customer.full_name || 'Unknown') + '</strong></td>' +
                '<td>' + Security.escapeHtml(customer.email || '--') + '</td>' +
                '<td><span class="customer-badge customer-badge--' + Security.escapeAttr(type) + '">' + Security.escapeHtml(typeLabels[type]) + '</span></td>' +
                '<td>' + (parseInt(customer.order_count, 10) || 0) + '</td>' +
                '<td>' + Security.escapeHtml(totalSpent) + '</td>' +
                '<td>' + Security.escapeHtml(joinDate) + '</td>' +
                '<td>' +
                    '<a href="#" class="action-link" data-action="view" data-id="' + Security.escapeAttr(customer.id) + '">View</a>' +
                    '<a href="#" class="action-link" data-action="orders" data-id="' + Security.escapeAttr(customer.id) + '">Orders</a>' +
                '</td>' +
            '</tr>';
        }
        tbody.innerHTML = html;
    },

    getExportData: function() {
        var self = this;
        var typeLabels = { vip: 'VIP', regular: 'Regular', new: 'New' };
        return this.filteredCustomers.map(function(customer) {
            return {
                name: customer.full_name || '',
                email: customer.email || '',
                type: typeLabels[self.getCustomerType(customer)],
                orders: customer.order_count || 0,
                total_spent: customer.total_spent || 0,
                joined: customer.created_at ? new Date(customer.created_at).toLocaleDateString('en-NZ') : ''
            };
        });
    },

    exportData: function(format) {
        if (this.filteredCustomers.length === 0) {
            alert('No customers to export');
            return;
        }

        var data = this.getExportData();
        var filename = 'customers-export-' + new Date().toISOString().split('T')[0];

        switch (format) {
            case 'pdf':
                this.exportToPDF(data, filename);
                break;
            case 'html':
                this.exportToHTML(data, filename);
                break;
            case 'json':
                this.downloadFile(JSON.stringify(data, null, 2), filename + '.json', 'application/json');
                break;
            case 'csv':
                this.downloadFile(this.toCSV(data), filename + '.csv', 'text/csv');
                break;
            case 'xml':
                this.downloadFile(this.toXML(data, 'customers', 'customer'), filename + '.xml', 'application/xml');
                break;
        }
    },

    exportToPDF: function(data, filename) {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF();

        doc.setFontSize(18);
        doc.setTextColor(38, 127, 181);
        doc.text('Customers Export', 14, 20);

        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text('Generated: ' + new Date().toLocaleString('en-NZ'), 14, 28);
        doc.text('Total Customers: ' + data.length, 14, 34);

        var totalRevenue = 0;
        for (var i = 0; i < data.length; i++) {
            totalRevenue += Number(data[i].total_spent);
        }
        doc.text('Total Revenue: $' + totalRevenue.toFixed(2), 14, 40);

        var headers = [['Name', 'Email', 'Type', 'Orders', 'Total Spent', 'Joined']];
        var rows = data.map(function(c) {
            return [
                c.name,
                c.email,
                c.type,
                c.orders,
                '$' + Number(c.total_spent).toFixed(2),
                c.joined
            ];
        });

        doc.autoTable({
            head: headers,
            body: rows,
            startY: 46,
            styles: { fontSize: 9, cellPadding: 3 },
            headStyles: { fillColor: [38, 127, 181], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [245, 247, 250] },
            columnStyles: {
                2: { halign: 'center' },
                3: { halign: 'center' },
                4: { halign: 'right' }
            },
            didParseCell: function(data) {
                if (data.column.index === 2 && data.section === 'body') {
                    var type = data.cell.raw;
                    if (type === 'VIP') data.cell.styles.textColor = [109, 40, 217];
                    else if (type === 'New') data.cell.styles.textColor = [6, 95, 70];
                }
            }
        });

        var pageCount = doc.internal.getNumberOfPages();
        for (var i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(150);
            doc.text('InkCartridges.co.nz - Page ' + i + ' of ' + pageCount, doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 10, { align: 'center' });
        }

        doc.save(filename + '.pdf');
    },

    exportToHTML: function(data, filename) {
        var totalRevenue = 0;
        var vipCount = 0;
        var newCount = 0;
        for (var i = 0; i < data.length; i++) {
            totalRevenue += Number(data[i].total_spent);
            if (data[i].type === 'VIP') vipCount++;
            if (data[i].type === 'New') newCount++;
        }

        var rows = '';
        for (var i = 0; i < data.length; i++) {
            var c = data[i];
            rows += '                <tr>\n' +
                '                    <td>' + c.name + '</td>\n' +
                '                    <td class="email">' + c.email + '</td>\n' +
                '                    <td><span class="type type-' + c.type.toLowerCase() + '">' + c.type + '</span></td>\n' +
                '                    <td class="orders">' + c.orders + '</td>\n' +
                '                    <td class="money">$' + Number(c.total_spent).toFixed(2) + '</td>\n' +
                '                    <td>' + c.joined + '</td>\n' +
                '                </tr>\n';
        }

        var html = '<!DOCTYPE html>\n' +
'<html lang="en-NZ">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <title>Customers Export - ' + new Date().toLocaleDateString('en-NZ') + '</title>\n' +
'    <style>\n' +
'        * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'        body { font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; padding: 40px; background: #f5f7fa; }\n' +
'        .container { max-width: 1100px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }\n' +
'        .header { background: linear-gradient(135deg, #267FB5, #1a5a80); color: white; padding: 30px; }\n' +
'        .header h1 { font-size: 24px; margin-bottom: 8px; }\n' +
'        .header p { opacity: 0.9; font-size: 14px; }\n' +
'        .stats { display: flex; gap: 20px; margin-top: 15px; flex-wrap: wrap; }\n' +
'        .stat { background: rgba(255,255,255,0.15); padding: 10px 20px; border-radius: 8px; }\n' +
'        .stat-value { font-size: 20px; font-weight: bold; }\n' +
'        .stat-label { font-size: 12px; opacity: 0.8; }\n' +
'        table { width: 100%; border-collapse: collapse; }\n' +
'        th { background: #267FB5; color: white; padding: 12px; text-align: left; font-weight: 600; font-size: 13px; }\n' +
'        td { padding: 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }\n' +
'        tr:hover { background: #f9fafb; }\n' +
'        tr:nth-child(even) { background: #f5f7fa; }\n' +
'        .email { color: #6b7280; }\n' +
'        .money { text-align: right; font-family: \'SF Mono\', Monaco, monospace; font-weight: 600; }\n' +
'        .orders { text-align: center; }\n' +
'        .type { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }\n' +
'        .type-vip { background: #EDE9FE; color: #6D28D9; }\n' +
'        .type-regular { background: #F3F4F6; color: #4B5563; }\n' +
'        .type-new { background: #D1FAE5; color: #065F46; }\n' +
'        .footer { padding: 20px 30px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px; }\n' +
'        @media print { body { padding: 0; background: white; } .container { box-shadow: none; } }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'    <div class="container">\n' +
'        <div class="header">\n' +
'            <h1>Customers Export</h1>\n' +
'            <p>Generated on ' + new Date().toLocaleString('en-NZ') + '</p>\n' +
'            <div class="stats">\n' +
'                <div class="stat"><div class="stat-value">' + data.length + '</div><div class="stat-label">Total Customers</div></div>\n' +
'                <div class="stat"><div class="stat-value">$' + totalRevenue.toFixed(2) + '</div><div class="stat-label">Total Revenue</div></div>\n' +
'                <div class="stat"><div class="stat-value">' + vipCount + '</div><div class="stat-label">VIP Customers</div></div>\n' +
'                <div class="stat"><div class="stat-value">' + newCount + '</div><div class="stat-label">New Customers</div></div>\n' +
'            </div>\n' +
'        </div>\n' +
'        <table>\n' +
'            <thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Orders</th><th>Total Spent</th><th>Joined</th></tr></thead>\n' +
'            <tbody>\n' +
rows +
'            </tbody>\n' +
'        </table>\n' +
'        <div class="footer">InkCartridges.co.nz &bull; Customers Export &bull; ' + data.length + ' customers</div>\n' +
'    </div>\n' +
'</body>\n' +
'</html>';

        this.downloadFile(html, filename + '.html', 'text/html');
    },

    toCSV: function(data) {
        if (data.length === 0) return '';
        var headers = Object.keys(data[0]);
        var rows = data.map(function(row) {
            return headers.map(function(h) {
                var val = String(row[h] != null ? row[h] : '');
                if (val.indexOf(',') !== -1 || val.indexOf('"') !== -1 || val.indexOf('\n') !== -1) {
                    return '"' + val.replace(/"/g, '""') + '"';
                }
                return val;
            }).join(',');
        });
        return [headers.join(',')].concat(rows).join('\n');
    },

    toXML: function(data, rootName, itemName) {
        var escapeXml = function(str) {
            return String(str).replace(/[<>&'"]/g, function(c) {
                var map = {'<':'&lt;', '>':'&gt;', '&':'&amp;', "'":"&apos;", '"':'&quot;'};
                return map[c];
            });
        };
        var items = data.map(function(item) {
            var fields = Object.keys(item).map(function(k) {
                return '    <' + k + '>' + escapeXml(item[k]) + '</' + k + '>';
            }).join('\n');
            return '  <' + itemName + '>\n' + fields + '\n  </' + itemName + '>';
        }).join('\n');
        return '<?xml version="1.0" encoding="UTF-8"?>\n<' + rootName + '>\n' + items + '\n</' + rootName + '>';
    },

    downloadFile: function(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    }
};

document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() { CustomersPage.init(); }, 500);
});
