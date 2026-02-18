/**
 * ADMIN PRODUCT EDIT
 * ==================
 * Handles product editing functionality in the admin panel
 */

'use strict';

var ProductEdit = {
    productId: null,
    productSku: null,
    originalData: null,
    images: [],
    compatiblePrinters: [],
    allBrands: [],
    printerSearchTimeout: null,

    /**
     * Initialize the product edit page
     */
    init: function() {
        var self = this;

        // Get product ID from URL
        var urlParams = new URLSearchParams(window.location.search);
        this.productSku = urlParams.get('sku');
        this.productId = urlParams.get('id');
        this.demoMode = urlParams.get('demo') === 'true';

        if (!this.productSku && !this.productId) {
            this.showToast('No product specified', 'error');
            setTimeout(function() {
                window.location.href = '/html/admin/products.html';
            }, 1500);
            return;
        }

        // Check admin auth
        AdminAuth.init().then(function(isAdmin) {
            if (!isAdmin) return;

            self.showLoading(true);
            self.loadBrandsWithFallback();

            self.loadProduct().then(function() {
                self.bindEvents();
                self.showLoading(false);
            }).catch(function(error) {
                console.error('Failed to load product:', error);
                // Show API not configured message
                self.showApiNotConfigured();
                self.bindEvents();
                self.showLoading(false);
            });
        });
    },

    /**
     * Show message when API is not configured
     */
    showApiNotConfigured: function() {
        var self = this;

        // Create a notice banner
        var notice = document.createElement('div');
        notice.className = 'api-notice';
        notice.innerHTML =
            '<div class="api-notice__content">' +
                '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="12" cy="12" r="10"/>' +
                    '<line x1="12" y1="8" x2="12" y2="12"/>' +
                    '<line x1="12" y1="16" x2="12.01" y2="16"/>' +
                '</svg>' +
                '<div>' +
                    '<strong>Backend API Not Configured</strong>' +
                    '<p>The product management API endpoints need to be implemented. See the API documentation in <code>frontend-backend-admin-contract.md</code></p>' +
                '</div>' +
                '<button type="button" class="api-notice__demo-btn" id="load-demo-btn">Load Demo Data</button>' +
            '</div>';

        // Add styles for the notice
        var style = document.createElement('style');
        style.textContent =
            '.api-notice { background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; padding: 16px; margin-bottom: 24px; }' +
            '.api-notice__content { display: flex; align-items: flex-start; gap: 12px; }' +
            '.api-notice__content svg { color: #D97706; flex-shrink: 0; margin-top: 2px; }' +
            '.api-notice__content p { margin: 4px 0 0; font-size: 14px; color: #92400E; }' +
            '.api-notice__content code { background: rgba(0,0,0,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px; }' +
            '.api-notice__demo-btn { margin-left: auto; padding: 8px 16px; background: #F59E0B; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; white-space: nowrap; }' +
            '.api-notice__demo-btn:hover { background: #D97706; }';
        document.head.appendChild(style);

        // Insert notice at top of form
        var form = document.getElementById('product-form');
        form.insertBefore(notice, form.firstChild);

        // Demo button handler
        document.getElementById('load-demo-btn').addEventListener('click', function() {
            self.loadDemoData();
            notice.remove();
        });

        // Update page title
        document.getElementById('page-title').textContent = 'Edit Product (API Not Connected)';
    },

    /**
     * Load demo data for preview
     */
    loadDemoData: function() {
        var demoProduct = {
            id: 'demo-uuid',
            sku: this.productSku || 'DEMO-SKU',
            name: 'HP 65XL Black Ink Cartridge (Demo)',
            description: 'High-yield black ink cartridge for HP DeskJet, ENVY, and AMP series printers. This XL cartridge prints up to 2x more pages than the standard cartridge.',
            brand: { id: 'hp-uuid', name: 'HP' },
            product_type: 'ink_cartridge',
            color: 'black',
            source: 'genuine',
            page_yield: '300 pages',
            retail_price: 45.95,
            compare_price: 59.99,
            cost_price: 28.50,
            stock_quantity: 25,
            low_stock_threshold: 5,
            is_active: true,
            track_inventory: true,
            images: [],
            compatible_printers: [
                { id: 'printer-1', full_name: 'HP DeskJet 2620' },
                { id: 'printer-2', full_name: 'HP DeskJet 3720' },
                { id: 'printer-3', full_name: 'HP ENVY 5020' }
            ],
            meta_title: 'HP 65XL Black Ink Cartridge | Buy Online NZ',
            meta_description: 'Buy genuine HP 65XL Black ink cartridge online. Fast NZ shipping, great prices. Compatible with DeskJet 2620, 3720 and more.',
            meta_keywords: 'HP 65XL black ink'
        };

        this.originalData = demoProduct;
        this.productId = demoProduct.id;
        this.populateForm(demoProduct);
        this.showToast('Demo data loaded - changes will not be saved', 'info');
        document.getElementById('page-title').textContent = 'Edit: ' + demoProduct.name + ' (Demo Mode)';
    },

    /**
     * Load brands with fallback to static list
     */
    loadBrandsWithFallback: function() {
        var self = this;

        API.getBrands().then(function(response) {
            if (response.success && response.data) {
                self.allBrands = response.data;
                self.populateBrandSelect();
            }
        }).catch(function() {
            // Fallback to common brands
            self.allBrands = [
                { id: 'brother-uuid', name: 'Brother' },
                { id: 'canon-uuid', name: 'Canon' },
                { id: 'epson-uuid', name: 'Epson' },
                { id: 'hp-uuid', name: 'HP' },
                { id: 'lexmark-uuid', name: 'Lexmark' },
                { id: 'samsung-uuid', name: 'Samsung' },
                { id: 'xerox-uuid', name: 'Xerox' }
            ];
            self.populateBrandSelect();
        });
    },

    /**
     * Load available brands
     */
    loadBrands: function() {
        var self = this;
        return API.getBrands().then(function(response) {
            if (response.success && response.data) {
                self.allBrands = response.data;
                self.populateBrandSelect();
            }
        });
    },

    /**
     * Populate brand select dropdown
     */
    populateBrandSelect: function() {
        var select = document.getElementById('product-brand');
        this.allBrands.forEach(function(brand) {
            var option = document.createElement('option');
            option.value = brand.id;
            option.textContent = brand.name;
            select.appendChild(option);
        });
    },

    /**
     * Load product data
     */
    loadProduct: function() {
        var self = this;

        // Use the appropriate API method based on what we have
        var loadPromise;
        if (this.productId) {
            // Load by product ID using admin endpoint (returns full data including images, compatibility)
            loadPromise = API.getAdminProductById(this.productId);
        } else if (this.productSku) {
            // Load by SKU using public endpoint, then get full data by ID
            loadPromise = API.getProduct(this.productSku).then(function(response) {
                if (response.success && response.data && response.data.id) {
                    self.productId = response.data.id;
                    // Now fetch full admin data
                    return API.getAdminProductById(response.data.id);
                }
                return response;
            });
        } else {
            return Promise.reject(new Error('No product SKU or ID provided'));
        }

        return loadPromise.then(function(response) {
            if (response.success && response.data) {
                self.originalData = response.data;
                self.productId = response.data.id;
                self.populateForm(response.data);
            } else {
                throw new Error('Product not found');
            }
        });
    },

    /**
     * Populate form with product data
     */
    populateForm: function(product) {
        // Update page title
        document.getElementById('page-title').textContent = 'Edit: ' + product.name;
        document.title = 'Edit ' + product.name + ' | InkCartridges.co.nz Admin';

        // Basic info
        document.getElementById('product-sku').value = product.sku || '';
        document.getElementById('product-name').value = product.name || '';
        document.getElementById('product-description').value = product.description || '';
        this.updateCharCount('product-description', 'desc-char-count', 2000);

        // Product details
        if (product.brand && product.brand.id) {
            document.getElementById('product-brand').value = product.brand.id;
        }
        document.getElementById('product-category').value = product.product_type || '';
        document.getElementById('product-color').value = product.color ? product.color.toLowerCase().replace(' ', '_') : '';
        document.getElementById('product-source').value = product.source || 'genuine';
        document.getElementById('product-yield').value = product.page_yield || '';

        // Pricing
        document.getElementById('product-price').value = product.retail_price || 0;
        document.getElementById('product-compare-price').value = product.compare_price || '';
        document.getElementById('product-cost').value = product.cost_price || '';

        // Inventory
        document.getElementById('product-stock').value = product.stock_quantity || 0;
        document.getElementById('product-low-stock').value = product.low_stock_threshold || 5;
        document.getElementById('product-active').checked = product.is_active !== false;
        document.getElementById('product-track-inventory').checked = product.track_inventory !== false;

        // Images
        this.images = product.images || [];
        if (product.image_url && this.images.length === 0) {
            this.images.push({ url: product.image_url, is_primary: true });
        }
        this.renderImages();

        // Compatible printers
        this.compatiblePrinters = product.compatible_printers || [];
        this.renderCompatiblePrinters();

        // SEO
        document.getElementById('meta-title').value = product.meta_title || '';
        document.getElementById('meta-description').value = product.meta_description || '';
        document.getElementById('meta-keywords').value = product.meta_keywords || '';
        this.updateCharCount('meta-title', 'meta-title-count', 70);
        this.updateCharCount('meta-description', 'meta-desc-count', 160);
        this.updateSeoPreview();
    },

    /**
     * Bind event listeners
     */
    bindEvents: function() {
        var self = this;

        // Save button
        document.getElementById('btn-save').addEventListener('click', function() {
            self.saveProduct();
        });

        // Cancel button
        document.getElementById('btn-cancel').addEventListener('click', function() {
            if (confirm('Discard changes and go back?')) {
                window.location.href = '/html/admin/products.html';
            }
        });

        // Character counts
        document.getElementById('product-description').addEventListener('input', function() {
            self.updateCharCount('product-description', 'desc-char-count', 2000);
        });

        document.getElementById('meta-title').addEventListener('input', function() {
            self.updateCharCount('meta-title', 'meta-title-count', 70);
            self.updateSeoPreview();
        });

        document.getElementById('meta-description').addEventListener('input', function() {
            self.updateCharCount('meta-description', 'meta-desc-count', 160);
            self.updateSeoPreview();
        });

        document.getElementById('product-name').addEventListener('input', function() {
            self.updateSeoPreview();
        });

        // Image upload
        document.getElementById('image-input').addEventListener('change', function(e) {
            self.handleImageUpload(e.target.files);
        });

        // Printer search
        document.getElementById('printer-search').addEventListener('input', function(e) {
            clearTimeout(self.printerSearchTimeout);
            var query = e.target.value.trim();

            if (query.length < 2) {
                document.getElementById('printer-dropdown').classList.remove('is-open');
                return;
            }

            self.printerSearchTimeout = setTimeout(function() {
                self.searchPrinters(query);
            }, 300);
        });

        // Close printer dropdown when clicking outside
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.compatibility-search') && !e.target.closest('.compatibility-dropdown')) {
                document.getElementById('printer-dropdown').classList.remove('is-open');
            }
        });

        // Keyboard navigation for form
        document.getElementById('product-form').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
            }
        });
    },

    /**
     * Update character count display
     */
    updateCharCount: function(inputId, countId, max) {
        var input = document.getElementById(inputId);
        var count = document.getElementById(countId);
        var length = input.value.length;

        count.textContent = length + ' / ' + max;
        count.classList.remove('char-count--warning', 'char-count--error');

        if (length > max) {
            count.classList.add('char-count--error');
        } else if (length > max * 0.9) {
            count.classList.add('char-count--warning');
        }
    },

    /**
     * Update SEO preview
     */
    updateSeoPreview: function() {
        var name = document.getElementById('product-name').value || 'Product Name';
        var metaTitle = document.getElementById('meta-title').value;
        var metaDesc = document.getElementById('meta-description').value;
        var sku = document.getElementById('product-sku').value || 'sku';

        document.getElementById('seo-preview-title').textContent =
            (metaTitle || name) + ' | InkCartridges.co.nz';
        document.getElementById('seo-preview-url').textContent =
            'https://inkcartridges.co.nz/product/' + sku.toLowerCase();
        document.getElementById('seo-preview-desc').textContent =
            metaDesc || 'Product description will appear here...';
    },

    /**
     * Handle image upload
     */
    handleImageUpload: function(files) {
        var self = this;

        Array.from(files).forEach(function(file) {
            if (!file.type.startsWith('image/')) {
                self.showToast('Please select only image files', 'error');
                return;
            }

            if (file.size > 5 * 1024 * 1024) {
                self.showToast('Image must be less than 5MB', 'error');
                return;
            }

            // Create preview
            var reader = new FileReader();
            reader.onload = function(e) {
                self.images.push({
                    file: file,
                    url: e.target.result,
                    is_primary: self.images.length === 0,
                    isNew: true
                });
                self.renderImages();
            };
            reader.readAsDataURL(file);
        });

        // Clear the input
        document.getElementById('image-input').value = '';
    },

    /**
     * Render images in the upload area
     */
    renderImages: function() {
        var self = this;
        var container = document.getElementById('image-upload');
        var addButton = container.querySelector('.image-upload__add');

        // Remove existing image items (but keep add button)
        var items = container.querySelectorAll('.image-upload__item:not(.image-upload__add)');
        items.forEach(function(item) { item.remove(); });

        // Add image items
        this.images.forEach(function(image, index) {
            var item = document.createElement('div');
            item.className = 'image-upload__item image-upload__item--filled';
            item.innerHTML =
                '<img src="' + Security.escapeAttr(image.url) + '" alt="Product image">' +
                '<button type="button" class="image-upload__remove" data-index="' + index + '">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                        '<line x1="18" y1="6" x2="6" y2="18"/>' +
                        '<line x1="6" y1="6" x2="18" y2="18"/>' +
                    '</svg>' +
                '</button>' +
                (image.is_primary ? '<span class="image-upload__primary-badge">Primary</span>' : '');

            container.insertBefore(item, addButton);

            // Remove button handler
            item.querySelector('.image-upload__remove').addEventListener('click', function() {
                self.removeImage(index);
            });

            // Click to set as primary
            item.addEventListener('click', function(e) {
                if (!e.target.closest('.image-upload__remove')) {
                    self.setAsPrimary(index);
                }
            });
        });
    },

    /**
     * Remove an image
     */
    removeImage: function(index) {
        var image = this.images[index];
        var wasPrimary = image.is_primary;

        this.images.splice(index, 1);

        // If removed image was primary, make first image primary
        if (wasPrimary && this.images.length > 0) {
            this.images[0].is_primary = true;
        }

        this.renderImages();
    },

    /**
     * Set image as primary
     */
    setAsPrimary: function(index) {
        this.images.forEach(function(img, i) {
            img.is_primary = (i === index);
        });
        this.renderImages();
    },

    /**
     * Search for printers
     */
    searchPrinters: function(query) {
        var self = this;

        API.searchPrinters(query).then(function(response) {
            if (response.success && response.data) {
                self.renderPrinterDropdown(response.data);
            }
        }).catch(function(error) {
            console.error('Printer search failed:', error);
        });
    },

    /**
     * Render printer dropdown
     */
    renderPrinterDropdown: function(printers) {
        var self = this;
        var dropdown = document.getElementById('printer-dropdown');
        dropdown.innerHTML = '';

        if (printers.length === 0) {
            dropdown.innerHTML = '<div class="compatibility-dropdown__item">No printers found</div>';
            dropdown.classList.add('is-open');
            return;
        }

        printers.forEach(function(printer) {
            // Check if already selected
            var isSelected = self.compatiblePrinters.some(function(p) {
                return p.id === printer.id;
            });

            var item = document.createElement('div');
            item.className = 'compatibility-dropdown__item' + (isSelected ? ' compatibility-dropdown__item--selected' : '');
            item.textContent = printer.full_name;
            item.dataset.id = printer.id;

            if (!isSelected) {
                item.addEventListener('click', function() {
                    self.addPrinter(printer);
                    dropdown.classList.remove('is-open');
                    document.getElementById('printer-search').value = '';
                });
            }

            dropdown.appendChild(item);
        });

        dropdown.classList.add('is-open');
    },

    /**
     * Add a printer to compatible list
     */
    addPrinter: function(printer) {
        // Check if already added
        if (this.compatiblePrinters.some(function(p) { return p.id === printer.id; })) {
            return;
        }

        this.compatiblePrinters.push(printer);
        this.renderCompatiblePrinters();
    },

    /**
     * Remove a printer from compatible list
     */
    removePrinter: function(printerId) {
        this.compatiblePrinters = this.compatiblePrinters.filter(function(p) {
            return p.id !== printerId;
        });
        this.renderCompatiblePrinters();
    },

    /**
     * Render compatible printers list
     */
    renderCompatiblePrinters: function() {
        var self = this;
        var container = document.getElementById('compatibility-list');

        if (this.compatiblePrinters.length === 0) {
            container.innerHTML = '<span style="color: var(--color-text-muted); font-size: var(--font-size-sm);">No printers added yet</span>';
            return;
        }

        container.innerHTML = '';
        this.compatiblePrinters.forEach(function(printer) {
            var tag = document.createElement('span');
            tag.className = 'compatibility-tag';
            tag.innerHTML =
                Security.escapeHtml(printer.full_name) +
                '<button type="button" class="compatibility-tag__remove" data-id="' + Security.escapeAttr(printer.id) + '">' +
                    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                        '<line x1="18" y1="6" x2="6" y2="18"/>' +
                        '<line x1="6" y1="6" x2="18" y2="18"/>' +
                    '</svg>' +
                '</button>';

            tag.querySelector('.compatibility-tag__remove').addEventListener('click', function() {
                self.removePrinter(printer.id);
            });

            container.appendChild(tag);
        });
    },

    /**
     * Save product changes
     */
    saveProduct: function() {
        var self = this;

        // Validate form
        var form = document.getElementById('product-form');
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }

        this.showLoading(true);

        // Collect form data
        var productData = {
            name: document.getElementById('product-name').value,
            description: document.getElementById('product-description').value,
            brand_id: document.getElementById('product-brand').value,
            product_type: document.getElementById('product-category').value,
            color: document.getElementById('product-color').value,
            source: document.getElementById('product-source').value,
            page_yield: document.getElementById('product-yield').value,
            retail_price: parseFloat(document.getElementById('product-price').value),
            compare_price: parseFloat(document.getElementById('product-compare-price').value) || null,
            cost_price: parseFloat(document.getElementById('product-cost').value) || null,
            stock_quantity: parseInt(document.getElementById('product-stock').value),
            low_stock_threshold: parseInt(document.getElementById('product-low-stock').value),
            is_active: document.getElementById('product-active').checked,
            track_inventory: document.getElementById('product-track-inventory').checked,
            meta_title: document.getElementById('meta-title').value,
            meta_description: document.getElementById('meta-description').value,
            meta_keywords: document.getElementById('meta-keywords').value,
            compatible_printer_ids: this.compatiblePrinters.map(function(p) { return p.id; })
        };

        // Upload new images first if any
        var newImages = this.images.filter(function(img) { return img.isNew; });
        var uploadPromises = newImages.map(function(img) {
            return self.uploadImage(img.file);
        });

        Promise.all(uploadPromises).then(function(uploadedUrls) {
            // Update images array with uploaded URLs
            var urlIndex = 0;
            self.images = self.images.map(function(img) {
                if (img.isNew) {
                    return {
                        url: uploadedUrls[urlIndex++],
                        is_primary: img.is_primary
                    };
                }
                return img;
            });

            // Add images to product data
            productData.images = self.images;

            // Save product
            return API.updateAdminProduct(self.productId, productData);
        }).then(function(response) {
            if (response.success) {
                self.showToast('Product saved successfully', 'success');
                self.originalData = response.data;
            } else {
                throw new Error(response.error || 'Failed to save product');
            }
        }).catch(function(error) {
            console.error('Save failed:', error);
            self.showToast(error.message || 'Failed to save product', 'error');
        }).finally(function() {
            self.showLoading(false);
        });
    },

    /**
     * Upload an image to storage
     */
    uploadImage: function(file) {
        var self = this;

        // Use API helper if available
        if (typeof API !== 'undefined' && API.uploadProductImage) {
            return API.uploadProductImage(this.productId, file).then(function(data) {
                if (data.success) {
                    return data.data.url;
                }
                throw new Error(data.error || 'Upload failed');
            });
        }

        // Fallback to direct fetch
        var formData = new FormData();
        formData.append('image', file);

        return API.getToken().then(function(token) {
            return fetch(Config.API_URL + '/api/admin/products/' + self.productId + '/images', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token
                },
                body: formData
            });
        }).then(function(response) {
            return response.json();
        }).then(function(data) {
            if (data.success) {
                return data.data.url;
            }
            throw new Error(data.error || 'Upload failed');
        });
    },

    /**
     * Show/hide loading overlay
     */
    showLoading: function(show) {
        var overlay = document.getElementById('loading-overlay');
        if (show) {
            overlay.classList.remove('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    },

    /**
     * Show toast message
     */
    showToast: function(message, type) {
        var toast = document.getElementById('toast');
        var toastMessage = document.getElementById('toast-message');

        toastMessage.textContent = message;
        toast.className = 'toast toast--' + (type || 'info');
        toast.classList.add('is-visible');

        setTimeout(function() {
            toast.classList.remove('is-visible');
        }, 3000);
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    ProductEdit.init();
});
