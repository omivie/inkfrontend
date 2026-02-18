'use strict';

const ProductsPage = {
    allProducts: [],
    filteredProducts: [],
    currentPage: 1,
    perPage: 100,
    filters: {
        search: '',
        stock: '',
        brand: '',
        category: '',
        sort: 'stock-low'
    },

    init() {
        AdminAuth.init().then(isAdmin => {
            if (!isAdmin) return;
            this.loadProducts().then(() => {
                this.bindEvents();
                this.readUrlFilters();
            });
        });
    },

    readUrlFilters() {
        var params = new URLSearchParams(window.location.search);
        var filter = params.get('filter');
        if (filter === 'low_stock') {
            // Activate the Low Stock chip
            var chips = document.querySelectorAll('.filter-chip[data-stock]');
            chips.forEach(function(c) { c.classList.remove('filter-chip--active'); });
            var lowStockChip = document.querySelector('.filter-chip[data-stock="low-stock"]');
            if (lowStockChip) lowStockChip.classList.add('filter-chip--active');
            this.filters.stock = 'low-stock';
            this.currentPage = 1;
            this.applyFilters();
            // Clean URL
            history.replaceState(null, '', window.location.pathname);
        }
    },

    bindEvents() {
        let searchTimeout;

        document.getElementById('product-search').addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.filters.search = e.target.value.toLowerCase();
                this.currentPage = 1;
                this.applyFilters();
            }, 200);
        });

        const chips = document.querySelectorAll('.filter-chip[data-stock]');
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                chips.forEach(c => c.classList.remove('filter-chip--active'));
                chip.classList.add('filter-chip--active');
                this.filters.stock = chip.dataset.stock;
                this.currentPage = 1;
                this.applyFilters();
            });
        });

        document.getElementById('brand-filter').addEventListener('change', (e) => {
            this.filters.brand = e.target.value;
            this.currentPage = 1;
            this.applyFilters();
        });

        document.getElementById('category-filter').addEventListener('change', (e) => {
            this.filters.category = e.target.value;
            this.currentPage = 1;
            this.applyFilters();
        });

        document.getElementById('sort-filter').addEventListener('change', (e) => {
            this.filters.sort = e.target.value;
            this.applyFilters();
        });

        document.getElementById('prev-page').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.renderProducts();
                this.updatePagination();
            }
        });

        document.getElementById('next-page').addEventListener('click', () => {
            const maxPage = Math.ceil(this.filteredProducts.length / this.perPage);
            if (this.currentPage < maxPage) {
                this.currentPage++;
                this.renderProducts();
                this.updatePagination();
            }
        });

        document.getElementById('export-format').addEventListener('change', (e) => {
            if (e.target.value) {
                this.exportData(e.target.value);
                e.target.value = '';
            }
        });
    },

    loadProducts() {
        let allProducts = [];
        let page = 1;
        const limit = 100;

        const fetchPage = () => {
            return API.getAdminProducts({ limit, page }).then(response => {
                if (response.success && response.data?.products) {
                    allProducts = allProducts.concat(response.data.products);
                    if (response.data.products.length === limit) {
                        page++;
                        return fetchPage();
                    }
                }
                return allProducts;
            });
        };

        return fetchPage().then(products => {
            this.allProducts = products;
            this.populateBrandFilter();
            this.applyFilters();
        }).catch(error => {
            console.error('Error loading products:', error);
            document.getElementById('products-table-body').innerHTML = '<tr><td colspan="8" class="empty-state">Error loading products</td></tr>';
        });
    },

    populateBrandFilter() {
        const brandSet = new Set();
        for (const product of this.allProducts) {
            const brandName = this.getBrandName(product);
            if (brandName) brandSet.add(brandName);
        }
        const brands = [...brandSet].sort();
        const brandSelect = document.getElementById('brand-filter');
        let html = '<option value="">All Brands</option>';
        for (const brand of brands) {
            html += '<option value="' + Security.escapeAttr(brand) + '">' + Security.escapeHtml(brand) + '</option>';
        }
        brandSelect.innerHTML = html;
    },

    getStockStatus(product) {
        if (!product.in_stock || product.stock_quantity === 0) return 'out-of-stock';
        if (product.stock_quantity <= 10) return 'low-stock';
        return 'in-stock';
    },

    getBrandName(product) {
        const brand = product.brand;
        if (!brand) return '';
        return typeof brand === 'object' ? (brand.name || '') : brand;
    },

    applyFilters() {
        let filtered = this.allProducts.slice();

        if (this.filters.search) {
            const search = this.filters.search;
            filtered = filtered.filter(p =>
                p.name.toLowerCase().includes(search) ||
                p.sku.toLowerCase().includes(search) ||
                this.getBrandName(p).toLowerCase().includes(search)
            );
        }

        if (this.filters.stock) {
            filtered = filtered.filter(p => this.getStockStatus(p) === this.filters.stock);
        }

        if (this.filters.brand) {
            filtered = filtered.filter(p => this.getBrandName(p) === this.filters.brand);
        }

        if (this.filters.category) {
            const category = this.filters.category;
            filtered = filtered.filter(p => {
                const cat = (p.category?.name || '').toLowerCase();
                return cat.includes(category);
            });
        }

        filtered.sort((a, b) => {
            switch (this.filters.sort) {
                case 'name-asc': return a.name.localeCompare(b.name);
                case 'name-desc': return b.name.localeCompare(a.name);
                case 'price-low': return (a.retail_price || 0) - (b.retail_price || 0);
                case 'price-high': return (b.retail_price || 0) - (a.retail_price || 0);
                case 'stock-low': return (a.stock_quantity || 0) - (b.stock_quantity || 0);
                case 'stock-high': return (b.stock_quantity || 0) - (a.stock_quantity || 0);
                default: return 0;
            }
        });

        this.filteredProducts = filtered;
        this.renderProducts();
        this.updatePagination();
        this.updateResultsCount();
    },

    updateResultsCount() {
        document.getElementById('results-count').innerHTML = '<strong>' + this.filteredProducts.length + '</strong> products';
    },

    renderProducts() {
        const tbody = document.getElementById('products-table-body');
        const start = (this.currentPage - 1) * this.perPage;
        const pageProducts = this.filteredProducts.slice(start, start + this.perPage);

        if (!pageProducts || pageProducts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No products found</td></tr>';
            return;
        }

        const statusLabels = { 'in-stock': 'Active', 'low-stock': 'Low Stock', 'out-of-stock': 'Out of Stock' };
        const statusClasses = { 'in-stock': 'active', 'low-stock': 'low-stock', 'out-of-stock': 'out-of-stock' };

        let html = '';
        for (const product of pageProducts) {
            const stockStatus = this.getStockStatus(product);

            const imgHtml = product.image_url ?
                '<img src="' + Security.escapeAttr(product.image_url) + '" alt="' + Security.escapeAttr(product.name) + '">' :
                '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

            html += '<tr>' +
                '<td><div class="product-image">' + imgHtml + '</div></td>' +
                '<td><div class="product-name">' + Security.escapeHtml(product.name) + '</div><div class="product-sku">' + Security.escapeHtml(product.sku) + '</div></td>' +
                '<td>' + Security.escapeHtml(product.sku) + '</td>' +
                '<td>' + Security.escapeHtml(product.category?.name || 'Uncategorized') + '</td>' +
                '<td>' + Security.escapeHtml(formatPrice(product.retail_price)) + '</td>' +
                '<td>' + (product.stock_quantity != null ? parseInt(product.stock_quantity, 10) : 'N/A') + '</td>' +
                '<td><span class="product-status product-status--' + Security.escapeAttr(statusClasses[stockStatus]) + '">' + Security.escapeHtml(statusLabels[stockStatus]) + '</span></td>' +
                '<td><a href="/html/admin/product-edit.html?sku=' + encodeURIComponent(product.sku) + '" class="action-link action-link--edit"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit</a><a href="/html/product/index.html?sku=' + encodeURIComponent(product.sku) + '" class="action-link action-link--view" target="_blank"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View</a></td>' +
            '</tr>';
        }
        tbody.innerHTML = html;
    },

    updatePagination() {
        const info = document.getElementById('pagination-info');
        const prevBtn = document.getElementById('prev-page');
        const nextBtn = document.getElementById('next-page');
        const total = this.filteredProducts.length;

        const start = total === 0 ? 0 : (this.currentPage - 1) * this.perPage + 1;
        const end = Math.min(this.currentPage * this.perPage, total);

        info.textContent = 'Showing ' + start + '-' + end + ' of ' + total + ' products';

        prevBtn.disabled = this.currentPage === 1;
        nextBtn.disabled = end >= total;
    },

    getExportData() {
        return this.filteredProducts.map(product => {
            let compatiblePrinters = '';
            if (product.compatible_printers?.length > 0) {
                compatiblePrinters = product.compatible_printers
                    .map(p => p.full_name || p.model_name || '')
                    .join(', ');
            }

            return {
                name: product.name || '',
                sku: product.sku || '',
                brand: this.getBrandName(product),
                category: product.category?.name || '',
                retail_price: product.retail_price || 0,
                cost_price: product.cost_price || 0,
                stock_quantity: product.stock_quantity != null ? product.stock_quantity : 0,
                status: this.getStockStatus(product),
                in_stock: product.in_stock || false,
                compatible_printers: compatiblePrinters
            };
        });
    },

    exportData(format) {
        if (this.filteredProducts.length === 0) {
            alert('No products to export');
            return;
        }

        const data = this.getExportData();
        const filename = 'products-export-' + new Date().toISOString().split('T')[0];

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
                this.downloadFile(this.toXML(data, 'products', 'product'), filename + '.xml', 'application/xml');
                break;
        }
    },

    exportToPDF(data, filename) {
        const jsPDF = window.jspdf.jsPDF;
        const doc = new jsPDF('landscape');

        doc.setFontSize(18);
        doc.setTextColor(38, 127, 181);
        doc.text('Products Export', 14, 20);

        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text('Generated: ' + new Date().toLocaleString('en-NZ'), 14, 28);
        doc.text('Total Products: ' + data.length, 14, 34);

        const headers = [['Name', 'SKU', 'Brand', 'Category', 'Price', 'Cost', 'Stock', 'Status']];
        const rows = data.map(p => [
            p.name.substring(0, 40) + (p.name.length > 40 ? '...' : ''),
            p.sku,
            p.brand,
            p.category,
            '$' + Number(p.retail_price).toFixed(2),
            '$' + Number(p.cost_price).toFixed(2),
            p.stock_quantity,
            p.status
        ]);

        doc.autoTable({
            head: headers,
            body: rows,
            startY: 40,
            styles: { fontSize: 8, cellPadding: 3 },
            headStyles: { fillColor: [38, 127, 181], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [245, 247, 250] },
            columnStyles: {
                0: { cellWidth: 60 },
                4: { halign: 'right' },
                5: { halign: 'right' },
                6: { halign: 'center' }
            }
        });

        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(150);
            doc.text('InkCartridges.co.nz - Page ' + i + ' of ' + pageCount, doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 10, { align: 'center' });
        }

        doc.save(filename + '.pdf');
    },

    exportToHTML(data, filename) {
        let rows = '';
        for (const p of data) {
            rows += '<tr><td>' + Security.escapeHtml(p.name) + '</td><td>' + Security.escapeHtml(p.sku) + '</td><td>' + Security.escapeHtml(p.brand) + '</td><td>' + Security.escapeHtml(p.category) + '</td><td>$' + Number(p.retail_price).toFixed(2) + '</td><td>$' + Number(p.cost_price).toFixed(2) + '</td><td>' + p.stock_quantity + '</td><td>' + Security.escapeHtml(p.status) + '</td></tr>';
        }

        let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Products Export</title>';
        html += '<style>table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#267FB5;color:white}</style>';
        html += '</head><body><h1>Products Export</h1><p>Generated: ' + new Date().toLocaleString() + '</p>';
        html += '<p>Total Products: ' + data.length + '</p>';
        html += '<table><thead><tr><th>Name</th><th>SKU</th><th>Brand</th><th>Category</th><th>Price</th><th>Cost</th><th>Stock</th><th>Status</th></tr></thead>';
        html += '<tbody>' + rows + '</tbody></table></body></html>';
        this.downloadFile(html, filename + '.html', 'text/html');
    },

    toCSV(data) {
        if (data.length === 0) return '';
        const headers = Object.keys(data[0]);
        const rows = data.map(row => {
            return headers.map(h => {
                const val = String(row[h] != null ? row[h] : '');
                if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                    return '"' + val.replace(/"/g, '""') + '"';
                }
                return val;
            }).join(',');
        });
        return [headers.join(','), ...rows].join('\n');
    },

    toXML(data, rootName, itemName) {
        const escapeXml = (str) => {
            return String(str).replace(/[<>&'"]/g, c => {
                const map = {'<':'&lt;', '>':'&gt;', '&':'&amp;', "'":"&apos;", '"':'&quot;'};
                return map[c];
            });
        };
        const items = data.map(item => {
            const fields = Object.keys(item).map(k => {
                return '    <' + k + '>' + escapeXml(item[k]) + '</' + k + '>';
            }).join('\n');
            return '  <' + itemName + '>\n' + fields + '\n  </' + itemName + '>';
        }).join('\n');
        return '<?xml version="1.0" encoding="UTF-8"?>\n<' + rootName + '>\n' + items + '\n</' + rootName + '>';
    },

    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => ProductsPage.init(), 500);
});
