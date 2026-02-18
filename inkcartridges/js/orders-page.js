var OrdersPage = {
    orders: [],
    filteredOrders: [],
    customers: [],
    filters: {
        search: '',
        status: '',
        customer: '',
        dateFrom: '',
        dateTo: '',
        sort: 'newest'
    },

    init: function() {
        var self = this;
        AdminAuth.init().then(function(isAdmin) {
            if (!isAdmin) return;
            self.bindEvents();
            self.loadOrders();
        });
    },

    bindEvents: function() {
        var self = this;
        var searchInput = document.getElementById('order-search');
        var searchTimeout;

        searchInput.addEventListener('input', function(e) {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() {
                self.filters.search = e.target.value.toLowerCase();
                self.applyFilters();
            }, 200);
        });

        var chips = document.querySelectorAll('.filter-chip');
        for (var i = 0; i < chips.length; i++) {
            (function(chip) {
                chip.addEventListener('click', function() {
                    var allChips = document.querySelectorAll('.filter-chip');
                    for (var j = 0; j < allChips.length; j++) {
                        allChips[j].classList.remove('filter-chip--active');
                    }
                    chip.classList.add('filter-chip--active');
                    self.filters.status = chip.dataset.status;
                    self.applyFilters();
                });
            })(chips[i]);
        }

        document.getElementById('customer-filter').addEventListener('change', function(e) {
            self.filters.customer = e.target.value;
            self.applyFilters();
        });

        document.getElementById('date-from').addEventListener('change', function(e) {
            self.filters.dateFrom = e.target.value;
            self.applyFilters();
        });

        document.getElementById('date-to').addEventListener('change', function(e) {
            self.filters.dateTo = e.target.value;
            self.applyFilters();
        });

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

    loadOrders: function() {
        var self = this;
        API.getAdminOrders({ limit: 100, sort: this.filters.sort }).then(function(response) {
            if (response.success && response.data && response.data.orders) {
                self.orders = response.data.orders;
                self.populateCustomerFilter();
                self.updateStatusCounts();
                self.applyFilters();
            } else {
                return API.getOrders({ limit: 100 });
            }
        }).then(function(fallbackResponse) {
            if (fallbackResponse && fallbackResponse.success && fallbackResponse.data && fallbackResponse.data.orders) {
                self.orders = fallbackResponse.data.orders;
                self.populateCustomerFilter();
                self.updateStatusCounts();
                self.applyFilters();
            }
        }).catch(function(error) {
            console.error('Error loading orders:', error);
            document.getElementById('orders-table-body').innerHTML = '<tr><td colspan="7" class="empty-state">Error loading orders. Please check your admin permissions.</td></tr>';
        });
    },

    populateCustomerFilter: function() {
        var customerMap = {};
        for (var i = 0; i < this.orders.length; i++) {
            var order = this.orders[i];
            var email = order.email;
            var name = order.shipping_recipient_name || email;
            if (email && !customerMap[email]) {
                customerMap[email] = name;
            }
        }

        var customers = [];
        for (var email in customerMap) {
            customers.push([email, customerMap[email]]);
        }
        customers.sort(function(a, b) { return a[1].localeCompare(b[1]); });

        var select = document.getElementById('customer-filter');
        var html = '<option value="">All Customers</option>';
        for (var i = 0; i < customers.length; i++) {
            html += '<option value="' + Security.escapeAttr(customers[i][0]) + '">' + Security.escapeHtml(customers[i][1]) + ' (' + Security.escapeHtml(customers[i][0]) + ')</option>';
        }
        select.innerHTML = html;
    },

    updateStatusCounts: function() {
        var counts = { pending: 0, processing: 0, shipped: 0, completed: 0, cancelled: 0 };
        for (var i = 0; i < this.orders.length; i++) {
            var status = this.orders[i].status;
            if (counts[status] !== undefined) counts[status]++;
        }
        var statuses = ['pending', 'processing', 'shipped', 'completed', 'cancelled'];
        for (var i = 0; i < statuses.length; i++) {
            var el = document.getElementById('count-' + statuses[i]);
            if (el) el.textContent = counts[statuses[i]];
        }
    },

    applyFilters: function() {
        var self = this;
        var filtered = this.orders.slice();

        if (this.filters.search) {
            filtered = filtered.filter(function(order) {
                return (order.order_number && order.order_number.toLowerCase().indexOf(self.filters.search) !== -1) ||
                       (order.email && order.email.toLowerCase().indexOf(self.filters.search) !== -1) ||
                       (order.shipping_recipient_name && order.shipping_recipient_name.toLowerCase().indexOf(self.filters.search) !== -1);
            });
        }

        if (this.filters.status) {
            filtered = filtered.filter(function(order) { return order.status === self.filters.status; });
        }

        if (this.filters.customer) {
            filtered = filtered.filter(function(order) { return order.email === self.filters.customer; });
        }

        if (this.filters.dateFrom) {
            var fromDate = new Date(this.filters.dateFrom);
            filtered = filtered.filter(function(order) { return new Date(order.created_at) >= fromDate; });
        }

        if (this.filters.dateTo) {
            var toDate = new Date(this.filters.dateTo);
            toDate.setHours(23, 59, 59);
            filtered = filtered.filter(function(order) { return new Date(order.created_at) <= toDate; });
        }

        filtered.sort(function(a, b) {
            switch (self.filters.sort) {
                case 'oldest': return new Date(a.created_at) - new Date(b.created_at);
                case 'total-high': return (b.total || 0) - (a.total || 0);
                case 'total-low': return (a.total || 0) - (b.total || 0);
                default: return new Date(b.created_at) - new Date(a.created_at);
            }
        });

        this.filteredOrders = filtered;
        this.renderOrders();
        this.updateResultsCount();
        this.updateClearButton();
    },

    clearFilters: function() {
        this.filters = { search: '', status: '', customer: '', dateFrom: '', dateTo: '', sort: 'newest' };
        document.getElementById('order-search').value = '';
        document.getElementById('customer-filter').value = '';
        document.getElementById('date-from').value = '';
        document.getElementById('date-to').value = '';
        document.getElementById('sort-filter').value = 'newest';
        var chips = document.querySelectorAll('.filter-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.remove('filter-chip--active');
        }
        document.querySelector('.filter-chip[data-status=""]').classList.add('filter-chip--active');
        this.applyFilters();
    },

    updateResultsCount: function() {
        var count = this.filteredOrders.length;
        document.getElementById('results-count').innerHTML = '<strong>' + count + '</strong> order' + (count !== 1 ? 's' : '');
    },

    updateClearButton: function() {
        var hasFilters = this.filters.search || this.filters.status || this.filters.customer || this.filters.dateFrom || this.filters.dateTo;
        document.getElementById('clear-filters').style.display = hasFilters ? 'inline-flex' : 'none';
    },

    getExportData: function() {
        return this.filteredOrders.map(function(order) {
            return {
                order_number: order.order_number || '',
                date: new Date(order.created_at).toLocaleDateString('en-NZ'),
                customer: order.shipping_recipient_name || '',
                email: order.email || '',
                items_count: order.order_items ? order.order_items.length : 0,
                status: order.status || '',
                subtotal: order.subtotal || 0,
                shipping: order.shipping_cost || 0,
                tax: order.gst_amount || 0,
                total: order.total || 0
            };
        });
    },

    exportData: function(format) {
        if (this.filteredOrders.length === 0) {
            alert('No orders to export');
            return;
        }

        var data = this.getExportData();
        var filename = 'orders-export-' + new Date().toISOString().split('T')[0];

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
                this.downloadFile(this.toXML(data, 'orders', 'order'), filename + '.xml', 'application/xml');
                break;
        }
    },

    exportToPDF: function(data, filename) {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF('landscape');

        doc.setFontSize(18);
        doc.setTextColor(38, 127, 181);
        doc.text('Orders Export', 14, 20);

        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text('Generated: ' + new Date().toLocaleString('en-NZ'), 14, 28);
        doc.text('Total Orders: ' + data.length, 14, 34);

        var headers = [['Order #', 'Date', 'Customer', 'Email', 'Items', 'Status', 'Subtotal', 'Shipping', 'Total']];
        var rows = data.map(function(order) {
            return [
                order.order_number,
                order.date,
                order.customer,
                order.email,
                order.items_count,
                order.status.toUpperCase(),
                '$' + Number(order.subtotal).toFixed(2),
                '$' + Number(order.shipping).toFixed(2),
                '$' + Number(order.total).toFixed(2)
            ];
        });

        doc.autoTable({
            head: headers,
            body: rows,
            startY: 40,
            styles: { fontSize: 9, cellPadding: 3 },
            headStyles: { fillColor: [38, 127, 181], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [245, 247, 250] },
            columnStyles: {
                0: { fontStyle: 'bold' },
                5: { halign: 'center' },
                6: { halign: 'right' },
                7: { halign: 'right' },
                8: { halign: 'right', fontStyle: 'bold' }
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
        var rows = '';
        for (var i = 0; i < data.length; i++) {
            var o = data[i];
            rows += '<tr><td>' + o.order_number + '</td><td>' + o.date + '</td><td>' + o.customer + '</td><td>' + o.email + '</td><td>' + o.items_count + '</td><td>' + o.status + '</td><td>$' + Number(o.subtotal).toFixed(2) + '</td><td>$' + Number(o.shipping).toFixed(2) + '</td><td>$' + Number(o.total).toFixed(2) + '</td></tr>';
        }
        var totalRevenue = data.reduce(function(sum, o) { return sum + Number(o.total); }, 0).toFixed(2);

        var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Orders Export</title>';
        html += '<style>table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#267FB5;color:white}.money{text-align:right}</style>';
        html += '</head><body><h1>Orders Export</h1><p>Generated: ' + new Date().toLocaleString() + '</p>';
        html += '<p>Total Orders: ' + data.length + ' | Total Revenue: $' + totalRevenue + '</p>';
        html += '<table><thead><tr><th>Order #</th><th>Date</th><th>Customer</th><th>Email</th><th>Items</th><th>Status</th><th>Subtotal</th><th>Shipping</th><th>Total</th></tr></thead>';
        html += '<tbody>' + rows + '</tbody></table></body></html>';
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
    },

    renderOrders: function() {
        var tbody = document.getElementById('orders-table-body');
        var orders = this.filteredOrders;

        if (!orders || orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No orders found</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < orders.length; i++) {
            var order = orders[i];
            var itemCount = order.order_items ? order.order_items.length : 0;
            html += '<tr>' +
                '<td><strong>' + Security.escapeHtml(order.order_number || '--') + '</strong></td>' +
                '<td>' + Security.escapeHtml(new Date(order.created_at).toLocaleDateString('en-NZ')) + '</td>' +
                '<td>' + Security.escapeHtml(order.shipping_recipient_name || order.email || 'Customer') + '</td>' +
                '<td>' + itemCount + ' item' + (itemCount !== 1 ? 's' : '') + '</td>' +
                '<td><span class="order-status order-status--' + Security.escapeAttr(order.status) + '">' + Security.escapeHtml(order.status) + '</span></td>' +
                '<td><strong>' + Security.escapeHtml(formatPrice(order.total)) + '</strong></td>' +
                '<td><a href="#" class="action-link">View</a></td>' +
            '</tr>';
        }
        tbody.innerHTML = html;
    }
};

document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() { OrdersPage.init(); }, 500);
});
