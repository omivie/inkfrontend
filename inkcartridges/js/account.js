/**
 * ACCOUNT.JS
 * ==========
 * Account page functionality for InkCartridges.co.nz
 * Handles loading user data, orders, addresses, and printers from API
 */

const AccountPage = {
    initialized: false,

    /**
     * Initialize account page
     */
    async init() {
        if (this.initialized) return;
        this.initialized = true;

        // Wait for Auth to initialize
        await this.waitForAuth();

        // Check authentication - redirect to login if not authenticated
        if (!Auth.isAuthenticated()) {
            window.location.href = '/html/account/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return;
        }

        // Hard-block unverified email users — redirects to verify-email page
        const verified = await Auth.requireVerifiedEmail();
        if (!verified) return;

        // Reveal account page content (hidden by CSS until auth confirmed)
        const accountEl = document.querySelector('.account-page');
        if (accountEl) accountEl.classList.add('auth-ready');

        // Load user info into sidebar (for all account pages)
        this.loadUserInfo();

        // Check admin access via backend (shows admin nav on all account pages if authorized)
        this.checkAdminAccess();

        // Check B2B status (shows business nav on all account pages if approved)
        this.checkBusinessAccess();

        // Load data based on current page
        const path = window.location.pathname;

        if (path.includes('/account/orders')) {
            await this.loadOrders();
        } else if (path.includes('/account/addresses')) {
            await this.loadAddresses();
            this.setupAddressModalHandlers();
        } else if (path.includes('/account/printers')) {
            await this.loadPrinters();
            this.setupPrinterModalHandlers();
        } else if (path.includes('/account/personal-details')) {
            // Personal details page — handled by its own inline script
        } else if (path.includes('/account')) {
            await this.loadDashboard();
        }
    },

    // Printer finder state (uses PrinterData from printer-data.js for series patterns)
    printerFinderState: {
        selectedBrand: null,
        selectedSeries: null,
        selectedModel: null,
        seriesData: [],
        modelsData: [],
        printerCache: {}
    },

    /**
     * Setup printer section handlers (inline ink-finder style)
     */
    setupPrinterModalHandlers() {
        const section = document.getElementById('add-printer-section');
        if (section) {
            const cancelBtn = document.getElementById('printer-cancel-btn');
            const saveBtn = document.getElementById('printer-save-btn');
            const closeBtn = document.getElementById('printer-modal-close-btn');
            const backdrop = section.querySelector('.printer-modal__backdrop');

            if (cancelBtn) cancelBtn.addEventListener('click', () => this.hideAddPrinterSection());
            if (saveBtn) saveBtn.addEventListener('click', () => this.savePrinter());
            if (closeBtn) closeBtn.addEventListener('click', () => this.hideAddPrinterSection());
            if (backdrop) backdrop.addEventListener('click', () => this.hideAddPrinterSection());

            // Setup brand button clicks
            const brandButtons = document.querySelectorAll('#printer-brands .ink-finder__brand-btn');
            brandButtons.forEach(btn => {
                btn.addEventListener('click', () => this.selectPrinterBrand(btn.dataset.brand));
            });

            // Setup series dropdown
            const seriesTrigger = document.getElementById('printer-series-trigger');
            const seriesDropdown = document.getElementById('printer-series-dropdown');
            if (seriesTrigger) {
                seriesTrigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!seriesTrigger.disabled) {
                        this.toggleDropdown(seriesTrigger, seriesDropdown);
                    }
                });
            }
            if (seriesDropdown) {
                seriesDropdown.addEventListener('click', (e) => {
                    const option = e.target.closest('.custom-select__option');
                    if (option) {
                        this.selectPrinterSeries(option.dataset.value, option.textContent);
                    }
                });
            }

            // Setup model dropdown
            const modelTrigger = document.getElementById('printer-model-trigger');
            const modelDropdown = document.getElementById('printer-model-dropdown');
            if (modelTrigger) {
                modelTrigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!modelTrigger.disabled) {
                        this.toggleDropdown(modelTrigger, modelDropdown);
                    }
                });
            }
            if (modelDropdown) {
                modelDropdown.addEventListener('click', (e) => {
                    const option = e.target.closest('.custom-select__option');
                    if (option) {
                        this.selectPrinterModel(option.dataset.value, option.textContent, option.dataset.fullName);
                    }
                });
            }

            // Close dropdowns when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.custom-select')) {
                    this.closeAllDropdowns();
                }
            });
        }

        // Delete printer modal
        const deleteModal = document.getElementById('delete-printer-modal');
        if (deleteModal) {
            const cancelBtn = document.getElementById('delete-printer-cancel-btn');
            const confirmBtn = document.getElementById('delete-printer-confirm-btn');
            const backdrop = deleteModal.querySelector('.modal__backdrop');

            if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeDeletePrinterModal());
            if (backdrop) backdrop.addEventListener('click', () => this.closeDeletePrinterModal());
            if (confirmBtn) confirmBtn.addEventListener('click', () => this.deletePrinter());
        }

        // Escape key to close modals and dropdowns
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const addSection = document.getElementById('add-printer-section');
                if (addSection && !addSection.hidden) this.hideAddPrinterSection();
                if (deleteModal && !deleteModal.hidden) this.closeDeletePrinterModal();
                this.closeAllDropdowns();
            }
        });

        // Add printer buttons
        const addBtn = document.getElementById('add-printer-btn');
        const addEmptyBtn = document.getElementById('add-printer-empty-btn');
        if (addBtn) addBtn.addEventListener('click', () => this.showAddPrinterSection());
        if (addEmptyBtn) addEmptyBtn.addEventListener('click', () => this.showAddPrinterSection());
    },

    /**
     * Toggle dropdown open/close
     */
    toggleDropdown(trigger, dropdown) {
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
            trigger.setAttribute('aria-expanded', 'false');
            trigger.parentElement.classList.remove('custom-select--open');
        } else {
            this.closeAllDropdowns();
            trigger.setAttribute('aria-expanded', 'true');
            trigger.parentElement.classList.add('custom-select--open');

            // Scroll the parent step into center of modal
            const step = trigger.closest('.ink-finder__step');
            if (step) {
                const stepIndex = [...step.parentElement.children].indexOf(step);
                this.scrollPrinterStepIntoView(stepIndex + 1);
            }
        }
    },

    /**
     * Close all dropdowns
     */
    closeAllDropdowns() {
        const seriesTrigger = document.getElementById('printer-series-trigger');
        const modelTrigger = document.getElementById('printer-model-trigger');

        if (seriesTrigger) {
            seriesTrigger.setAttribute('aria-expanded', 'false');
            seriesTrigger.parentElement?.classList.remove('custom-select--open');
        }
        if (modelTrigger) {
            modelTrigger.setAttribute('aria-expanded', 'false');
            modelTrigger.parentElement?.classList.remove('custom-select--open');
        }
    },

    /**
     * Select printer brand
     */
    async selectPrinterBrand(brand) {
        const state = this.printerFinderState;
        state.selectedBrand = brand;
        state.selectedSeries = null;
        state.selectedModel = null;

        // Update brand button states
        document.querySelectorAll('#printer-brands .ink-finder__brand-btn').forEach(btn => {
            btn.classList.toggle('ink-finder__brand-btn--selected', btn.dataset.brand === brand);
        });

        // Update step states
        this.updatePrinterFinderSteps();

        // Show loading state
        const seriesTrigger = document.getElementById('printer-series-trigger');
        const modelTrigger = document.getElementById('printer-model-trigger');
        seriesTrigger.querySelector('.custom-select__value').textContent = 'Loading series...';
        seriesTrigger.disabled = true;
        modelTrigger.querySelector('.custom-select__value').textContent = '← Select series';
        modelTrigger.disabled = true;
        document.getElementById('printer-save-btn').disabled = true;

        // Hide action row when changing brand
        const actionRow = document.getElementById('printer-action-row');
        if (actionRow) actionRow.hidden = true;

        // Load printers for this brand
        const series = await this.loadPrintersForBrand(brand);
        state.seriesData = series;

        if (series.length === 0) {
            seriesTrigger.querySelector('.custom-select__value').textContent = 'No printers found';
            return;
        }

        // Populate series dropdown
        this.populateDropdown('printer-series-dropdown', series, true);
        seriesTrigger.querySelector('.custom-select__value').textContent = 'Select Series';
        seriesTrigger.disabled = false;

        this.updatePrinterFinderSteps();
        this.scrollPrinterStepIntoView(2);
    },

    /**
     * Load printers for a brand from API
     */
    async loadPrintersForBrand(brand) {
        const state = this.printerFinderState;
        if (state.printerCache[brand]) {
            return state.printerCache[brand];
        }

        const brandName = PrinterData.BRAND_NAMES[brand] || brand;
        let printers = [];

        // Try Supabase direct query first (gets ALL printer models)
        const supabaseClient = (typeof Auth !== 'undefined' && Auth.supabase)
            ? Auth.supabase
            : (typeof supabase !== 'undefined' && supabase.createClient && typeof Config !== 'undefined')
                ? supabase.createClient(Config.SUPABASE_URL, Config.SUPABASE_ANON_KEY)
                : null;

        if (supabaseClient) {
            try {
                const { data: brandData, error: brandError } = await supabaseClient
                    .from('brands')
                    .select('id')
                    .ilike('name', brandName)
                    .single();

                if (!brandError && brandData) {
                    const { data: modelsData, error: modelsError } = await supabaseClient
                        .from('printer_models')
                        .select('id, model_name, full_name, slug')
                        .eq('brand_id', brandData.id)
                        .order('model_name', { ascending: true });

                    if (!modelsError && modelsData && modelsData.length > 0) {
                        printers = modelsData;
                    }
                }
            } catch (error) {
                // Supabase direct query failed, try API fallback
            }
        }

        // Fall back to API if Supabase query didn't work
        if (printers.length === 0) {
            try {
                const response = await API.getPrintersByBrand(brandName);
                if (response.ok && response.data) {
                    printers = Array.isArray(response.data) ? response.data : (response.data.printers || []);
                }
            } catch (error) {
                // API fallback also failed, will use static data
            }
        }

        // Transform and filter printers
        if (printers.length > 0) {
            const formattedPrinters = printers.map(p => {
                const modelName = p.model_name || p.model || p.name || '';
                const fullName = p.full_name || `${brandName} ${modelName}`;

                const series = PrinterData.getSeriesForModel(modelName, brand);

                return {
                    id: (p.slug || modelName).toLowerCase().replace(/\s+/g, '-'),
                    printerId: p.id || null,
                    name: modelName,
                    fullName: fullName,
                    slug: p.slug || '',
                    seriesId: series.id,
                    seriesName: series.name
                };
            }).filter(p => {
                const name = p.name.trim();
                if (!name || name.length < 2) return false;
                if (/\bprinters?\b/i.test(name)) return false;
                if (/^(inkjet|laser|colour|color|toner|cartridges?|ink|ribbon|ribbons|drums?|fax)$/i.test(name)) return false;
                if (/^\d+mm$/i.test(name)) return false;
                if (!PrinterData.isInkToner(p.seriesName, p.name, brand)) return false;
                if (p.seriesId === 'other') return false;
                return true;
            });

            const series = PrinterData.groupPrintersBySeries(formattedPrinters);
            state.printerCache[brand] = series;
            return series;
        }

        // Final fallback: use static printer data
        const staticPrinters = this.getStaticPrintersForBrand(brand);
        const series = PrinterData.groupPrintersBySeries(staticPrinters);
        state.printerCache[brand] = series;
        return series;
    },


    /**
     * Static printer data fallback
     *
     * INTENTIONAL FALLBACK: This static data is used when the /api/printers endpoint
     * is unavailable. Once the backend printers API is implemented, this data will
     * only be used as a fallback for offline/error scenarios. The primary source
     * of printer data should always be the server API.
     *
     * This matches the fallback data in ink-finder.js for consistency.
     */
    getStaticPrintersForBrand(brand) {
        const staticData = {
            brother: [
                // DCP Series
                { id: 'dcp-150c', name: 'DCP-150C', fullName: 'Brother DCP-150C', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-330c', name: 'DCP-330C', fullName: 'Brother DCP-330C', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-350c', name: 'DCP-350C', fullName: 'Brother DCP-350C', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-540cn', name: 'DCP-540CN', fullName: 'Brother DCP-540CN', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-560cn', name: 'DCP-560CN', fullName: 'Brother DCP-560CN', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-750cw', name: 'DCP-750CW', fullName: 'Brother DCP-750CW', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-770cw', name: 'DCP-770CW', fullName: 'Brother DCP-770CW', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-j125', name: 'DCP-J125', fullName: 'Brother DCP-J125', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-j140w', name: 'DCP-J140W', fullName: 'Brother DCP-J140W', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-j315w', name: 'DCP-J315W', fullName: 'Brother DCP-J315W', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-j515w', name: 'DCP-J515W', fullName: 'Brother DCP-J515W', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                { id: 'dcp-j715w', name: 'DCP-J715W', fullName: 'Brother DCP-J715W', seriesId: 'dcp', seriesName: 'DCP Series (Digital Copier)' },
                // MFC Series
                { id: 'mfc-230c', name: 'MFC-230C', fullName: 'Brother MFC-230C', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-240c', name: 'MFC-240C', fullName: 'Brother MFC-240C', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-260c', name: 'MFC-260C', fullName: 'Brother MFC-260C', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-440cn', name: 'MFC-440CN', fullName: 'Brother MFC-440CN', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-465cn', name: 'MFC-465CN', fullName: 'Brother MFC-465CN', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-5460cn', name: 'MFC-5460CN', fullName: 'Brother MFC-5460CN', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-5860cn', name: 'MFC-5860CN', fullName: 'Brother MFC-5860CN', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-665cw', name: 'MFC-665CW', fullName: 'Brother MFC-665CW', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-685cw', name: 'MFC-685CW', fullName: 'Brother MFC-685CW', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-845cw', name: 'MFC-845CW', fullName: 'Brother MFC-845CW', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-885cw', name: 'MFC-885CW', fullName: 'Brother MFC-885CW', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-j220', name: 'MFC-J220', fullName: 'Brother MFC-J220', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-j265w', name: 'MFC-J265W', fullName: 'Brother MFC-J265W', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-j410', name: 'MFC-J410', fullName: 'Brother MFC-J410', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-j415w', name: 'MFC-J415W', fullName: 'Brother MFC-J415W', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                { id: 'mfc-j615w', name: 'MFC-J615W', fullName: 'Brother MFC-J615W', seriesId: 'mfc', seriesName: 'MFC Series (Multi-Function)' },
                // HL Series
                { id: 'hl-2140', name: 'HL-2140', fullName: 'Brother HL-2140', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-2170w', name: 'HL-2170W', fullName: 'Brother HL-2170W', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-2240', name: 'HL-2240', fullName: 'Brother HL-2240', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-2240d', name: 'HL-2240D', fullName: 'Brother HL-2240D', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-2270dw', name: 'HL-2270DW', fullName: 'Brother HL-2270DW', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-3040cn', name: 'HL-3040CN', fullName: 'Brother HL-3040CN', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-3070cw', name: 'HL-3070CW', fullName: 'Brother HL-3070CW', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-4040cn', name: 'HL-4040CN', fullName: 'Brother HL-4040CN', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                { id: 'hl-4070cdw', name: 'HL-4070CDW', fullName: 'Brother HL-4070CDW', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' }
            ],
            canon: [
                // PIXMA Series
                { id: 'pixma-ip4850', name: 'PIXMA iP4850', fullName: 'Canon PIXMA iP4850', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-ip4950', name: 'PIXMA iP4950', fullName: 'Canon PIXMA iP4950', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mg5150', name: 'PIXMA MG5150', fullName: 'Canon PIXMA MG5150', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mg5250', name: 'PIXMA MG5250', fullName: 'Canon PIXMA MG5250', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mg5350', name: 'PIXMA MG5350', fullName: 'Canon PIXMA MG5350', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mg6150', name: 'PIXMA MG6150', fullName: 'Canon PIXMA MG6150', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mg6250', name: 'PIXMA MG6250', fullName: 'Canon PIXMA MG6250', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mg8150', name: 'PIXMA MG8150', fullName: 'Canon PIXMA MG8150', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mx885', name: 'PIXMA MX885', fullName: 'Canon PIXMA MX885', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                { id: 'pixma-mx895', name: 'PIXMA MX895', fullName: 'Canon PIXMA MX895', seriesId: 'pixma', seriesName: 'PIXMA Series' },
                // MAXIFY Series
                { id: 'maxify-mb2050', name: 'MAXIFY MB2050', fullName: 'Canon MAXIFY MB2050', seriesId: 'maxify', seriesName: 'MAXIFY Series' },
                { id: 'maxify-mb2350', name: 'MAXIFY MB2350', fullName: 'Canon MAXIFY MB2350', seriesId: 'maxify', seriesName: 'MAXIFY Series' },
                { id: 'maxify-mb5050', name: 'MAXIFY MB5050', fullName: 'Canon MAXIFY MB5050', seriesId: 'maxify', seriesName: 'MAXIFY Series' },
                { id: 'maxify-mb5350', name: 'MAXIFY MB5350', fullName: 'Canon MAXIFY MB5350', seriesId: 'maxify', seriesName: 'MAXIFY Series' }
            ],
            epson: [
                // XP Series
                { id: 'xp-200', name: 'XP-200', fullName: 'Epson XP-200', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-300', name: 'XP-300', fullName: 'Epson XP-300', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-310', name: 'XP-310', fullName: 'Epson XP-310', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-400', name: 'XP-400', fullName: 'Epson XP-400', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-410', name: 'XP-410', fullName: 'Epson XP-410', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-600', name: 'XP-600', fullName: 'Epson XP-600', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-610', name: 'XP-610', fullName: 'Epson XP-610', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-800', name: 'XP-800', fullName: 'Epson XP-800', seriesId: 'xp', seriesName: 'XP Series' },
                { id: 'xp-810', name: 'XP-810', fullName: 'Epson XP-810', seriesId: 'xp', seriesName: 'XP Series' },
                // WorkForce Series
                { id: 'wf-2520', name: 'WF-2520', fullName: 'Epson WF-2520', seriesId: 'wf', seriesName: 'WorkForce Series' },
                { id: 'wf-2530', name: 'WF-2530', fullName: 'Epson WF-2530', seriesId: 'wf', seriesName: 'WorkForce Series' },
                { id: 'wf-2540', name: 'WF-2540', fullName: 'Epson WF-2540', seriesId: 'wf', seriesName: 'WorkForce Series' },
                { id: 'wf-3520', name: 'WF-3520', fullName: 'Epson WF-3520', seriesId: 'wf', seriesName: 'WorkForce Series' },
                { id: 'wf-3540', name: 'WF-3540', fullName: 'Epson WF-3540', seriesId: 'wf', seriesName: 'WorkForce Series' },
                { id: 'wf-7510', name: 'WF-7510', fullName: 'Epson WF-7510', seriesId: 'wf', seriesName: 'WorkForce Series' },
                { id: 'wf-7520', name: 'WF-7520', fullName: 'Epson WF-7520', seriesId: 'wf', seriesName: 'WorkForce Series' }
            ],
            hp: [
                // DeskJet Series
                { id: 'deskjet-1000', name: 'DeskJet 1000', fullName: 'HP DeskJet 1000', seriesId: 'deskjet', seriesName: 'DeskJet Series' },
                { id: 'deskjet-2050', name: 'DeskJet 2050', fullName: 'HP DeskJet 2050', seriesId: 'deskjet', seriesName: 'DeskJet Series' },
                { id: 'deskjet-3050', name: 'DeskJet 3050', fullName: 'HP DeskJet 3050', seriesId: 'deskjet', seriesName: 'DeskJet Series' },
                { id: 'deskjet-3520', name: 'DeskJet 3520', fullName: 'HP DeskJet 3520', seriesId: 'deskjet', seriesName: 'DeskJet Series' },
                // ENVY Series
                { id: 'envy-4500', name: 'ENVY 4500', fullName: 'HP ENVY 4500', seriesId: 'envy', seriesName: 'ENVY Series' },
                { id: 'envy-5530', name: 'ENVY 5530', fullName: 'HP ENVY 5530', seriesId: 'envy', seriesName: 'ENVY Series' },
                { id: 'envy-5540', name: 'ENVY 5540', fullName: 'HP ENVY 5540', seriesId: 'envy', seriesName: 'ENVY Series' },
                { id: 'envy-7640', name: 'ENVY 7640', fullName: 'HP ENVY 7640', seriesId: 'envy', seriesName: 'ENVY Series' },
                // OfficeJet Series
                { id: 'officejet-4630', name: 'OfficeJet 4630', fullName: 'HP OfficeJet 4630', seriesId: 'officejet', seriesName: 'OfficeJet Series' },
                { id: 'officejet-6600', name: 'OfficeJet 6600', fullName: 'HP OfficeJet 6600', seriesId: 'officejet', seriesName: 'OfficeJet Series' },
                { id: 'officejet-8600', name: 'OfficeJet 8600', fullName: 'HP OfficeJet 8600', seriesId: 'officejet', seriesName: 'OfficeJet Series' },
                // LaserJet Series
                { id: 'laserjet-p1102', name: 'LaserJet P1102', fullName: 'HP LaserJet P1102', seriesId: 'laserjet', seriesName: 'LaserJet Series' },
                { id: 'laserjet-p2035', name: 'LaserJet P2035', fullName: 'HP LaserJet P2035', seriesId: 'laserjet', seriesName: 'LaserJet Series' },
                { id: 'laserjet-pro-m1212nf', name: 'LaserJet Pro M1212nf', fullName: 'HP LaserJet Pro M1212nf', seriesId: 'laserjet', seriesName: 'LaserJet Series' }
            ],
            samsung: [
                // Xpress Series
                { id: 'xpress-m2020', name: 'Xpress M2020', fullName: 'Samsung Xpress M2020', seriesId: 'xpress', seriesName: 'Xpress Series' },
                { id: 'xpress-m2070', name: 'Xpress M2070', fullName: 'Samsung Xpress M2070', seriesId: 'xpress', seriesName: 'Xpress Series' },
                { id: 'xpress-c460fw', name: 'Xpress C460FW', fullName: 'Samsung Xpress C460FW', seriesId: 'xpress', seriesName: 'Xpress Series' },
                // CLP Series
                { id: 'clp-365', name: 'CLP-365', fullName: 'Samsung CLP-365', seriesId: 'clp', seriesName: 'CLP Series' },
                { id: 'clp-415n', name: 'CLP-415N', fullName: 'Samsung CLP-415N', seriesId: 'clp', seriesName: 'CLP Series' },
                // CLX Series
                { id: 'clx-3305', name: 'CLX-3305', fullName: 'Samsung CLX-3305', seriesId: 'clx', seriesName: 'CLX Series' },
                { id: 'clx-4195fn', name: 'CLX-4195FN', fullName: 'Samsung CLX-4195FN', seriesId: 'clx', seriesName: 'CLX Series' },
                // ML Series
                { id: 'ml-2165', name: 'ML-2165', fullName: 'Samsung ML-2165', seriesId: 'ml', seriesName: 'ML Series' },
                { id: 'ml-2955nd', name: 'ML-2955ND', fullName: 'Samsung ML-2955ND', seriesId: 'ml', seriesName: 'ML Series' }
            ],
            lexmark: [
                // CX Series
                { id: 'cx310dn', name: 'CX310dn', fullName: 'Lexmark CX310dn', seriesId: 'cx', seriesName: 'CX Series (Color MFP)' },
                { id: 'cx410de', name: 'CX410de', fullName: 'Lexmark CX410de', seriesId: 'cx', seriesName: 'CX Series (Color MFP)' },
                { id: 'cx510de', name: 'CX510de', fullName: 'Lexmark CX510de', seriesId: 'cx', seriesName: 'CX Series (Color MFP)' },
                // CS Series
                { id: 'cs310dn', name: 'CS310dn', fullName: 'Lexmark CS310dn', seriesId: 'cs', seriesName: 'CS Series (Color Laser)' },
                { id: 'cs410dn', name: 'CS410dn', fullName: 'Lexmark CS410dn', seriesId: 'cs', seriesName: 'CS Series (Color Laser)' },
                { id: 'cs510de', name: 'CS510de', fullName: 'Lexmark CS510de', seriesId: 'cs', seriesName: 'CS Series (Color Laser)' },
                // MX Series
                { id: 'mx310dn', name: 'MX310dn', fullName: 'Lexmark MX310dn', seriesId: 'mx', seriesName: 'MX Series (Mono MFP)' },
                { id: 'mx410de', name: 'MX410de', fullName: 'Lexmark MX410de', seriesId: 'mx', seriesName: 'MX Series (Mono MFP)' },
                { id: 'mx510de', name: 'MX510de', fullName: 'Lexmark MX510de', seriesId: 'mx', seriesName: 'MX Series (Mono MFP)' },
                // MS Series
                { id: 'ms310dn', name: 'MS310dn', fullName: 'Lexmark MS310dn', seriesId: 'ms', seriesName: 'MS Series (Mono Laser)' },
                { id: 'ms410dn', name: 'MS410dn', fullName: 'Lexmark MS410dn', seriesId: 'ms', seriesName: 'MS Series (Mono Laser)' },
                { id: 'ms510dn', name: 'MS510dn', fullName: 'Lexmark MS510dn', seriesId: 'ms', seriesName: 'MS Series (Mono Laser)' }
            ],
            oki: [
                // C Series
                { id: 'c332dn', name: 'C332dn', fullName: 'OKI C332dn', seriesId: 'c', seriesName: 'C Series (Color)' },
                { id: 'c532dn', name: 'C532dn', fullName: 'OKI C532dn', seriesId: 'c', seriesName: 'C Series (Color)' },
                { id: 'c612dn', name: 'C612dn', fullName: 'OKI C612dn', seriesId: 'c', seriesName: 'C Series (Color)' },
                // MC Series
                { id: 'mc363dn', name: 'MC363dn', fullName: 'OKI MC363dn', seriesId: 'mc', seriesName: 'MC Series (Color MFP)' },
                { id: 'mc563dn', name: 'MC563dn', fullName: 'OKI MC563dn', seriesId: 'mc', seriesName: 'MC Series (Color MFP)' },
                // B Series
                { id: 'b432dn', name: 'B432dn', fullName: 'OKI B432dn', seriesId: 'b', seriesName: 'B Series (Mono)' },
                { id: 'b512dn', name: 'B512dn', fullName: 'OKI B512dn', seriesId: 'b', seriesName: 'B Series (Mono)' },
                // MB Series
                { id: 'mb472dnw', name: 'MB472dnw', fullName: 'OKI MB472dnw', seriesId: 'mb', seriesName: 'MB Series (Mono MFP)' },
                { id: 'mb492dn', name: 'MB492dn', fullName: 'OKI MB492dn', seriesId: 'mb', seriesName: 'MB Series (Mono MFP)' }
            ],
            'fuji-xerox': [
                // DocuPrint Series
                { id: 'docuprint-cp305d', name: 'DocuPrint CP305d', fullName: 'Fuji Xerox DocuPrint CP305d', seriesId: 'docuprint', seriesName: 'DocuPrint Series' },
                { id: 'docuprint-cm305df', name: 'DocuPrint CM305df', fullName: 'Fuji Xerox DocuPrint CM305df', seriesId: 'docuprint', seriesName: 'DocuPrint Series' },
                { id: 'docuprint-p355d', name: 'DocuPrint P355d', fullName: 'Fuji Xerox DocuPrint P355d', seriesId: 'docuprint', seriesName: 'DocuPrint Series' },
                { id: 'docuprint-m355df', name: 'DocuPrint M355df', fullName: 'Fuji Xerox DocuPrint M355df', seriesId: 'docuprint', seriesName: 'DocuPrint Series' },
                { id: 'docuprint-cp405d', name: 'DocuPrint CP405d', fullName: 'Fuji Xerox DocuPrint CP405d', seriesId: 'docuprint', seriesName: 'DocuPrint Series' },
                { id: 'docuprint-cm405df', name: 'DocuPrint CM405df', fullName: 'Fuji Xerox DocuPrint CM405df', seriesId: 'docuprint', seriesName: 'DocuPrint Series' },
                // DocuCentre Series
                { id: 'docucentre-sc2020', name: 'DocuCentre SC2020', fullName: 'Fuji Xerox DocuCentre SC2020', seriesId: 'docucentre', seriesName: 'DocuCentre Series' }
            ],
            kyocera: [
                // ECOSYS Series
                { id: 'ecosys-p2235dn', name: 'ECOSYS P2235dn', fullName: 'Kyocera ECOSYS P2235dn', seriesId: 'ecosys', seriesName: 'ECOSYS Series' },
                { id: 'ecosys-p5021cdn', name: 'ECOSYS P5021cdn', fullName: 'Kyocera ECOSYS P5021cdn', seriesId: 'ecosys', seriesName: 'ECOSYS Series' },
                { id: 'ecosys-m2040dn', name: 'ECOSYS M2040dn', fullName: 'Kyocera ECOSYS M2040dn', seriesId: 'ecosys', seriesName: 'ECOSYS Series' },
                { id: 'ecosys-m5521cdn', name: 'ECOSYS M5521cdn', fullName: 'Kyocera ECOSYS M5521cdn', seriesId: 'ecosys', seriesName: 'ECOSYS Series' },
                // TASKalfa Series
                { id: 'taskalfa-2552ci', name: 'TASKalfa 2552ci', fullName: 'Kyocera TASKalfa 2552ci', seriesId: 'taskalfa', seriesName: 'TASKalfa Series' },
                { id: 'taskalfa-3252ci', name: 'TASKalfa 3252ci', fullName: 'Kyocera TASKalfa 3252ci', seriesId: 'taskalfa', seriesName: 'TASKalfa Series' },
                // FS Series
                { id: 'fs-1041', name: 'FS-1041', fullName: 'Kyocera FS-1041', seriesId: 'fs', seriesName: 'FS Series' },
                { id: 'fs-1061dn', name: 'FS-1061DN', fullName: 'Kyocera FS-1061DN', seriesId: 'fs', seriesName: 'FS Series' }
            ]
        };
        return staticData[brand] || [];
    },

    /**
     * Populate dropdown with options
     */
    populateDropdown(dropdownId, options, isSeries = false) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;

        dropdown.innerHTML = '';

        if (options.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'custom-select__empty';
            empty.textContent = 'No options available';
            dropdown.appendChild(empty);
            return;
        }

        const cols = 3;
        const rowsPerPage = 6;
        const itemsPerPage = cols * rowsPerPage;

        options.forEach((option, i) => {
            const li = document.createElement('li');
            li.className = 'custom-select__option';
            li.setAttribute('data-value', option.id);
            li.setAttribute('data-full-name', option.fullName || option.name || '');

            const isOtherModels = option.id === 'other' || (option.name && option.name.toLowerCase().includes('other'));

            if (isOtherModels) {
                li.style.order = 99999;
            } else {
                const page = Math.floor(i / itemsPerPage);
                const indexInPage = i % itemsPerPage;
                const visualCol = Math.floor(indexInPage / rowsPerPage);
                const visualRow = indexInPage % rowsPerPage;
                const order = (page * rowsPerPage + visualRow) * cols + visualCol;
                li.style.order = order;
            }

            if (isSeries && option.models) {
                li.textContent = `${option.name} (${option.models.length} models)`;
            } else {
                li.textContent = option.name;
                if (!isSeries) {
                    li.setAttribute('data-slug', option.slug || option.id);
                }
            }

            dropdown.appendChild(li);
        });
    },

    /**
     * Select printer series
     */
    selectPrinterSeries(seriesId, label) {
        const state = this.printerFinderState;
        state.selectedSeries = seriesId;
        state.selectedModel = null;

        // Find the selected series
        const series = state.seriesData.find(s => s.id === seriesId);
        if (!series) return;

        state.modelsData = series.models;

        // Update series dropdown display
        const seriesTrigger = document.getElementById('printer-series-trigger');
        seriesTrigger.querySelector('.custom-select__value').textContent = label;
        this.closeAllDropdowns();

        // Mark option as selected
        document.querySelectorAll('#printer-series-dropdown .custom-select__option').forEach(opt => {
            opt.classList.toggle('custom-select__option--selected', opt.dataset.value === seriesId);
        });

        // Populate model dropdown
        this.populateDropdown('printer-model-dropdown', state.modelsData, false);
        const modelTrigger = document.getElementById('printer-model-trigger');
        modelTrigger.querySelector('.custom-select__value').textContent = 'Select Model';
        modelTrigger.disabled = false;
        document.getElementById('printer-save-btn').disabled = true;

        // Hide action row when changing series
        const actionRow = document.getElementById('printer-action-row');
        if (actionRow) actionRow.hidden = true;

        this.updatePrinterFinderSteps();
        this.scrollPrinterStepIntoView(3);
    },

    /**
     * Select printer model
     */
    selectPrinterModel(modelId, label, fullName) {
        const state = this.printerFinderState;
        state.selectedModel = modelId;

        // Find the model data
        const model = state.modelsData.find(m => m.id === modelId);

        // Update model dropdown display
        const modelTrigger = document.getElementById('printer-model-trigger');
        modelTrigger.querySelector('.custom-select__value').textContent = label;
        this.closeAllDropdowns();

        // Mark option as selected
        document.querySelectorAll('#printer-model-dropdown .custom-select__option').forEach(opt => {
            opt.classList.toggle('custom-select__option--selected', opt.dataset.value === modelId);
        });

        // Set hidden form values
        document.getElementById('printer-model').value = label;
        document.getElementById('printer-brand').value = PrinterData.BRAND_NAMES[state.selectedBrand] || state.selectedBrand;
        document.getElementById('printer-slug').value = model?.slug || modelId;
        document.getElementById('printer-full-name').value = fullName || model?.fullName || label;
        document.getElementById('printer-printer-id').value = model?.printerId || '';

        // Show action row (nickname + save/cancel buttons) inline
        const actionRow = document.getElementById('printer-action-row');
        if (actionRow) {
            actionRow.hidden = false;
            actionRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Enable save button
        document.getElementById('printer-save-btn').disabled = false;

        this.updatePrinterFinderSteps();
    },

    /**
     * Update printer finder step states
     */
    updatePrinterFinderSteps() {
        const state = this.printerFinderState;
        const steps = document.querySelectorAll('#printer-finder-steps .ink-finder__step');

        steps.forEach((step, index) => {
            const stepNum = index + 1;
            step.classList.remove('ink-finder__step--active', 'ink-finder__step--completed', 'ink-finder__step--disabled');

            if (stepNum === 1) {
                step.classList.add('ink-finder__step--active');
                if (state.selectedBrand) step.classList.add('ink-finder__step--completed');
            } else if (stepNum === 2) {
                if (state.selectedBrand) {
                    step.classList.add('ink-finder__step--active');
                    if (state.selectedSeries) step.classList.add('ink-finder__step--completed');
                } else {
                    step.classList.add('ink-finder__step--disabled');
                }
            } else if (stepNum === 3) {
                if (state.selectedSeries) {
                    step.classList.add('ink-finder__step--active');
                    if (state.selectedModel) step.classList.add('ink-finder__step--completed');
                } else {
                    step.classList.add('ink-finder__step--disabled');
                }
            }
        });
    },

    /**
     * Scroll a printer modal step into the center of the modal viewport
     */
    scrollPrinterStepIntoView(stepNumber) {
        const steps = document.querySelectorAll('#printer-finder-steps .ink-finder__step');
        const step = steps[stepNumber - 1];
        if (!step) return;

        const container = document.querySelector('.printer-modal__container');
        if (!container) return;

        // Small delay to let DOM update (e.g. dropdown rendering)
        requestAnimationFrame(() => {
            const containerRect = container.getBoundingClientRect();
            const stepRect = step.getBoundingClientRect();
            const stepTopInContainer = stepRect.top - containerRect.top + container.scrollTop;
            const centeredScroll = stepTopInContainer - (container.clientHeight / 2) + (stepRect.height / 2);

            container.scrollTo({
                top: Math.max(0, centeredScroll),
                behavior: 'smooth'
            });
        });
    },

    /**
     * Setup address modal handlers
     */
    setupAddressModalHandlers() {
        // Address modal
        const addressModal = document.getElementById('address-modal');
        if (addressModal) {
            const closeBtn = addressModal.querySelector('.modal__close');
            const cancelBtn = document.getElementById('address-cancel-btn');
            const saveBtn = document.getElementById('address-save-btn');
            const backdrop = addressModal.querySelector('.modal__backdrop');

            if (closeBtn) closeBtn.addEventListener('click', () => this.closeAddressModal());
            if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeAddressModal());
            if (backdrop) backdrop.addEventListener('click', () => this.closeAddressModal());
            if (saveBtn) saveBtn.addEventListener('click', () => this.saveAddress());
        }

        // Delete modal
        const deleteModal = document.getElementById('delete-modal');
        if (deleteModal) {
            const cancelBtn = document.getElementById('delete-cancel-btn');
            const confirmBtn = document.getElementById('delete-confirm-btn');
            const backdrop = deleteModal.querySelector('.modal__backdrop');

            if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeDeleteModal());
            if (backdrop) backdrop.addEventListener('click', () => this.closeDeleteModal());
            if (confirmBtn) confirmBtn.addEventListener('click', () => this.deleteAddress());
        }

        // Escape key to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (addressModal && !addressModal.hidden) this.closeAddressModal();
                if (deleteModal && !deleteModal.hidden) this.closeDeleteModal();
            }
        });
    },

    /**
     * Wait for Auth to be initialized
     * Also handles OAuth callback - waits for Supabase to process hash tokens
     */
    async waitForAuth() {
        // Wait for Auth.init() to fully complete (including getSession())
        // Auth.readyPromise resolves only after session is populated — not just after createClient()
        if (typeof Auth !== 'undefined' && Auth.readyPromise) {
            await Auth.readyPromise;
        }

        // Handle OAuth callback hash (access_token in URL fragment)
        const hash = window.location.hash;
        const hasOAuthCallback = hash && (hash.includes('access_token') || hash.includes('error'));
        if (hasOAuthCallback && typeof Auth !== 'undefined' && Auth.supabase) {
            try {
                const { data: { session }, error } = await Auth.supabase.auth.getSession();
                if (error) DebugLog.error('OAuth callback error:', error);
                Auth.session = session;
                Auth.user = session?.user ?? null;
                if (session && window.history.replaceState) {
                    window.history.replaceState(null, '', window.location.pathname + window.location.search);
                }
            } catch (e) {
                DebugLog.error('Error processing OAuth callback:', e);
            }
        }
    },

    /**
     * Get current user
     */
    getCurrentUser() {
        return Auth.getUser();
    },

    async loadDashboard() {
        // Sync profile to backend (fire-and-forget, non-blocking)
        this.syncProfileToBackend();
        // Load lifetime savings (non-blocking)
        this.loadSavingsBanner();
    },

    /**
     * Populate the dashboard savings banner from GET /api/user/savings.
     * Silent no-op if the element isn't on the current page or the call fails.
     */
    async loadSavingsBanner() {
        const banner = document.getElementById('account-savings-banner');
        if (!banner) return;
        try {
            const res = await API.getUserSavings();
            if (!res?.ok || !res.data) return;
            const d = res.data;
            const total = Number(d.total_savings ?? d.lifetime_savings ?? d.savings ?? 0);
            if (!isFinite(total) || total <= 0) return;
            const valueEl = document.getElementById('account-savings-value');
            const subEl = document.getElementById('account-savings-sub');
            if (valueEl) valueEl.textContent = (typeof formatPrice === 'function') ? formatPrice(total) : ('$' + total.toFixed(2));
            if (subEl) {
                const orders = d.order_count ?? d.orders ?? null;
                const pct = d.savings_percent ?? d.percent_saved ?? null;
                const parts = [];
                if (orders) parts.push(`${orders} order${orders === 1 ? '' : 's'}`);
                if (pct) parts.push(`${Number(pct).toFixed(0)}% off vs genuine`);
                subEl.textContent = parts.join(' • ');
            }
            banner.hidden = false;
        } catch { /* silent */ }
    },

    /**
     * Sync user profile to backend database
     * Creates or updates the user profile record
     */
    async syncProfileToBackend() {
        const user = this.getCurrentUser();
        if (!user) return;

        try {
            // Use accountSync (creates profile if missing, fills empty fields from OAuth metadata)
            const turnstileToken = typeof Auth !== 'undefined' ? await Auth.getTurnstileToken() : null;
            await API.accountSync(turnstileToken);
        } catch (error) {
            // Non-critical - auth.js onAuthStateChange also calls accountSync
        }
    },



    /**
     * Load user info into sidebar and welcome message
     */
    loadUserInfo() {
        const user = this.getCurrentUser();
        if (!user) return;

        const displayName = user.user_metadata?.full_name ||
            user.email?.split('@')[0] ||
            'User';
        const email = user.email || '';

        // Update sidebar
        const nameEl = document.getElementById('user-name');
        const emailEl = document.getElementById('user-email');
        const welcomeEl = document.getElementById('welcome-name');

        if (nameEl) nameEl.textContent = displayName;
        if (emailEl) emailEl.textContent = email;
        if (welcomeEl) welcomeEl.textContent = `, ${displayName}`;

        // Wire up logout — the dashboard uses a static modal in its HTML;
        // all other account pages get a dynamically injected confirmation modal
        const logoutLink = document.querySelector('.logout-link');
        if (logoutLink && !document.getElementById('logout-modal')) {
            // Inject modal HTML
            const modalEl = document.createElement('div');
            modalEl.id = 'logout-modal';
            modalEl.className = 'modal';
            modalEl.hidden = true;
            modalEl.innerHTML = `
                <div class="modal__backdrop"></div>
                <div class="modal__content">
                    <div class="modal__icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                            <polyline points="16 17 21 12 16 7"/>
                            <line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                    </div>
                    <h2 class="modal__title">Sign Out?</h2>
                    <p class="modal__text">Are you sure you want to sign out of your account?</p>
                    <div class="modal__actions">
                        <button type="button" class="btn btn--secondary" id="logout-cancel">Cancel</button>
                        <button type="button" class="btn btn--primary" id="logout-confirm">Yes, Sign Out</button>
                    </div>
                </div>`;
            document.body.appendChild(modalEl);

            const closeModal = () => {
                modalEl.hidden = true;
                document.body.style.overflow = '';
            };

            logoutLink.addEventListener('click', (e) => {
                e.preventDefault();
                modalEl.hidden = false;
                document.body.style.overflow = 'hidden';
            });

            document.getElementById('logout-cancel').addEventListener('click', closeModal);
            modalEl.querySelector('.modal__backdrop').addEventListener('click', closeModal);

            document.getElementById('logout-confirm').addEventListener('click', async () => {
                const confirmBtn = document.getElementById('logout-confirm');
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Signing out...';
                if (typeof Auth !== 'undefined') await Auth.signOut();
                window.location.href = '/';
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !modalEl.hidden) closeModal();
            });
        }
    },

    /**
     * Check admin access via backend API and show admin nav item if authorized
     */
    async checkAdminAccess() {
        const adminNavItem = document.getElementById('admin-nav-item');
        if (!adminNavItem) return;

        try {
            const response = await API.verifyAdmin();
            if (response.ok && response.data) {
                adminNavItem.hidden = false;

                // Role is verified server-side — no client-side cache needed
            }
        } catch {
            // Not an admin or backend unavailable — keep hidden
        }
    },

    /**
     * Check B2B status and show business nav item if approved
     */
    async checkBusinessAccess() {
        const bizNavItem = document.getElementById('biz-nav-item');
        if (!bizNavItem) return;

        try {
            const res = await API.getBusinessStatus();
            if (res.ok && res.data?.status === 'approved') {
                bizNavItem.hidden = false;
            }
        } catch {
            // Not a B2B user or backend unavailable — keep hidden
        }
    },

    /**
     * Load recent orders for dashboard (from API + local storage fallback)
     */
    async loadRecentOrders() {
        const tableWrapper = document.getElementById('orders-table-wrapper');
        const tableBody = document.getElementById('orders-table-body');
        const emptyState = document.getElementById('orders-empty');

        if (!tableBody || !emptyState) return;

        let allOrders = [];

        // Try to load from API first
        try {
            const response = await API.getOrders({ limit: 3 });
            const apiOrders = response.data?.orders || (Array.isArray(response.data) ? response.data : []);
            if (response.ok && apiOrders.length > 0) {
                allOrders = apiOrders;
            }
        } catch (error) {
            DebugLog.error('Failed to load orders from API:', error);
        }

        // Sort by date and take top 3
        allOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        allOrders = allOrders.slice(0, 3);

        if (allOrders.length > 0) {
            tableBody.innerHTML = allOrders.map(order => this.renderOrderRow(order)).join('');
            if (tableWrapper) tableWrapper.hidden = false;
            emptyState.hidden = true;
        } else {
            if (tableWrapper) tableWrapper.hidden = true;
            emptyState.hidden = false;
        }
    },

    /**
     * Render a single order row
     */
    renderOrderRow(order) {
        const date = new Date(order.created_at).toLocaleDateString('en-NZ', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });

        const statusClass = this.getStatusClass(order.status);
        const statusText = this.formatStatus(order.status);
        const total = formatPrice(order.total);

        return `
            <tr class="orders-table__row">
                <td data-label="Order #">
                    <a href="/html/account/order-detail?id=${Security.escapeAttr(order.order_number)}">#${Security.escapeHtml(order.order_number)}</a>
                </td>
                <td data-label="Date">${Security.escapeHtml(date)}</td>
                <td data-label="Status">
                    <span class="order-status order-status--${Security.escapeAttr(statusClass)}">${Security.escapeHtml(statusText)}</span>
                </td>
                <td data-label="Total">${total}</td>
                <td>
                    <a href="/html/account/order-detail?id=${Security.escapeAttr(order.order_number)}" class="btn btn--small btn--text">View</a>
                </td>
            </tr>
        `;
    },

    /**
     * Get CSS class for order status
     */
    getStatusClass(status) {
        const statusMap = {
            'pending': 'pending',
            'confirmed': 'processing',
            'paid': 'processing',
            'processing': 'processing',
            'shipped': 'shipped',
            'delivered': 'delivered',
            'completed': 'delivered',
            'cancelled': 'cancelled',
            'test_completed': 'processing'
        };
        return statusMap[status?.toLowerCase()] || 'pending';
    },

    /**
     * Format order status for display
     */
    formatStatus(status) {
        if (!status) return 'Pending';
        const statusMap = {
            'pending': 'Pending',
            'confirmed': 'Confirmed',
            'paid': 'Paid',
            'processing': 'Processing',
            'shipped': 'Shipped',
            'delivered': 'Delivered',
            'completed': 'Completed',
            'cancelled': 'Cancelled',
            'test_completed': 'Test Order'
        };
        return statusMap[status.toLowerCase()] || status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
    },

    /**
     * Load default address for dashboard
     */
    async loadDefaultAddress() {
        const addressCard = document.getElementById('default-address');
        const addressContent = document.getElementById('default-address-content');
        const emptyState = document.getElementById('address-empty');

        if (!addressContent || !emptyState) return;

        try {
            const response = await API.getAddresses();

            const addresses = Array.isArray(response.data) ? response.data : (response.data?.addresses || []);
            if (response.ok && addresses.length > 0) {
                // Find default address or use first one
                const defaultAddress = addresses.find(a => a.is_default) || addresses[0];
                addressContent.innerHTML = this.formatAddress(defaultAddress);
                if (addressCard) addressCard.hidden = false;
                emptyState.hidden = true;
            } else {
                if (addressCard) addressCard.hidden = true;
                emptyState.hidden = false;
            }
        } catch (error) {
            DebugLog.error('Failed to load addresses:', error);
            if (addressCard) addressCard.hidden = true;
            emptyState.hidden = false;
        }
    },

    /**
     * Format address for display
     */
    formatAddress(address) {
        const parts = [
            `<strong>${Security.escapeHtml(address.recipient_name || '')}</strong>`,
            Security.escapeHtml(address.address_line1 || ''),
            Security.escapeHtml(address.address_line2 || ''),
            Security.escapeHtml(address.city || ''),
            Security.escapeHtml(`${address.region || ''} ${address.postal_code || ''}`.trim()),
            Security.escapeHtml(address.country || 'NZ')
        ].filter(Boolean);

        return parts.join('<br>');
    },

    /**
     * Load saved printers for dashboard
     */
    async loadSavedPrinters() {
        const printersPreview = document.getElementById('printers-preview');
        const emptyState = document.getElementById('printers-empty');

        if (!emptyState) return;

        try {
            // Load from API (server-first)
            let printers = [];
            const response = await API.getUserPrinters();
            if (response.ok && response.data) {
                printers = Array.isArray(response.data) ? response.data : (response.data.printers || []);
            }

            printers = await this.enrichPrintersData(printers);

            if (printers.length > 0) {
                const displayPrinters = printers.slice(0, 2); // Show max 2 on dashboard
                if (printersPreview) {
                    printersPreview.innerHTML = displayPrinters.map(p => this.renderPrinterCard(p)).join('');
                    printersPreview.hidden = false;
                }
                emptyState.hidden = true;
            } else {
                if (printersPreview) printersPreview.hidden = true;
                emptyState.hidden = false;
            }
        } catch (error) {
            DebugLog.error('Failed to load printers:', error);
            if (printersPreview) printersPreview.hidden = true;
            emptyState.hidden = false;
        }
    },

    /**
     * Enrich printer records that have printer_id but are missing model info.
     * The backend may not join printer_models — this fills the gap via Supabase.
     */
    async enrichPrintersData(printers) {
        if (!printers.length) return printers;

        // Normalise nested model data if backend returns it nested (e.g. printer.printer_models)
        printers = printers.map(p => {
            const nested = p.printer_models || p.printer || null;
            if (nested && typeof nested === 'object') {
                return {
                    ...p,
                    full_name: p.full_name || nested.full_name,
                    model_name: p.model_name || nested.model_name,
                    slug: p.slug || nested.slug,
                };
            }
            return p;
        });

        // Find printers that still have no model info but have a printer_id to look up
        const needsLookup = printers.filter(p => {
            const hasModelInfo = p.full_name || p.model_name || p.model || p.name || p.slug;
            return !hasModelInfo && p.printer_id;
        });

        if (!needsLookup.length) return printers;

        try {
            const ids = needsLookup.map(p => p.printer_id);
            const { data } = await supabaseClient
                .from('printer_models')
                .select('id, full_name, model_name, slug')
                .in('id', ids);

            if (data && data.length) {
                const modelMap = {};
                data.forEach(m => { modelMap[m.id] = m; });
                return printers.map(p => {
                    if (p.printer_id && modelMap[p.printer_id]) {
                        const m = modelMap[p.printer_id];
                        return { ...p, full_name: m.full_name, model_name: m.model_name, slug: m.slug };
                    }
                    return p;
                });
            }
        } catch (e) {
            // Supabase lookup failed — continue with what we have
        }

        return printers;
    },

    /**
     * Render printer card for dashboard
     */
    renderPrinterCard(printer) {
        const model = printer.full_name || printer.model_name || printer.model || printer.name || 'Unknown Printer';
        const nickname = printer.nickname || printer.location || '';
        const slug = printer.slug || printer.printer_slug || '';

        // Build URL: prefer printer slug (direct API lookup), then printer_model (Supabase lookup)
        const searchUrl = slug
            ? `/html/shop?printer=${encodeURIComponent(slug)}`
            : model !== 'Unknown Printer'
                ? `/html/shop?printer_model=${encodeURIComponent(model)}`
                : '/html/shop';

        return `
            <div class="printer-card-preview">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M6 9V2h12v7"/>
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                    <rect x="6" y="14" width="12" height="8"/>
                </svg>
                <div class="printer-card-preview__details">
                    <span class="printer-card-preview__name">${Security.escapeHtml(model)}</span>
                    <span class="printer-card-preview__meta">${Security.escapeHtml(nickname || brand)}</span>
                </div>
                <a href="${Security.escapeAttr(searchUrl)}" class="btn btn--small btn--secondary">Find Ink</a>
            </div>
        `;
    },

    /**
     * Load full orders list (from API + local storage fallback)
     */
    async loadOrders() {
        const tableWrapper = document.getElementById('orders-table-wrapper');
        const tableBody = document.getElementById('orders-table-body');
        const emptyState = document.getElementById('orders-empty');

        if (!tableBody || !emptyState) return;

        let allOrders = [];

        // Try to load from API first
        try {
            const response = await API.getOrders({ limit: 50 });
            const apiOrders = response.data?.orders || (Array.isArray(response.data) ? response.data : []);
            if (response.ok && apiOrders.length > 0) {
                allOrders = apiOrders;
            }
        } catch (error) {
            DebugLog.error('Failed to load orders from API:', error);
        }

        // Sort by date (newest first)
        allOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (allOrders.length > 0) {
            tableBody.innerHTML = allOrders.map(order => this.renderOrderRow(order)).join('');
            if (tableWrapper) tableWrapper.hidden = false;
            emptyState.hidden = true;
        } else {
            if (tableWrapper) tableWrapper.hidden = true;
            emptyState.hidden = false;
        }
    },

    /**
     * Load all addresses
     */
    async loadAddresses() {
        const grid = document.getElementById('addresses-grid');
        const emptyState = document.getElementById('addresses-empty');
        const addBtn = document.querySelector('.account-content__header .btn--primary');

        if (!grid || !emptyState) return;

        try {
            const response = await API.getAddresses();
            this.addresses = Array.isArray(response.data) ? response.data : (response.data?.addresses || []);

            if (response.ok && this.addresses.length > 0) {
                // Sort so default address is first
                const sortedAddresses = [...this.addresses].sort((a, b) => {
                    if (a.is_default) return -1;
                    if (b.is_default) return 1;
                    return 0;
                });

                grid.innerHTML = sortedAddresses.map(address => this.renderAddressCard(address)).join('');
                grid.hidden = false;
                emptyState.hidden = true;

                // Add click handlers for actions
                this.setupAddressActionHandlers(grid);
            } else {
                grid.hidden = true;
                emptyState.hidden = false;
            }
        } catch (error) {
            DebugLog.error('Failed to load addresses:', error);
            grid.hidden = true;
            emptyState.hidden = false;
        }

        // Setup add new address button
        if (addBtn) {
            addBtn.addEventListener('click', () => this.openAddressModal());
        }
        const emptyAddBtn = document.getElementById('add-address-empty-btn');
        if (emptyAddBtn) {
            emptyAddBtn.addEventListener('click', () => this.openAddressModal());
        }
    },

    /**
     * Setup address action handlers
     */
    setupAddressActionHandlers(grid) {
        grid.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const action = btn.dataset.action;
                const id = btn.dataset.id;

                if (action === 'set-default') {
                    await this.setDefaultAddress(id);
                } else if (action === 'edit') {
                    this.openAddressModal(id);
                } else if (action === 'delete') {
                    this.confirmDeleteAddress(id);
                }
            });
        });
    },

    /**
     * Set address as default
     */
    async setDefaultAddress(addressId) {
        const btn = document.querySelector(`[data-action="set-default"][data-id="${addressId}"]`);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span>Setting...</span>';
        }

        try {
            const address = this.addresses.find(a => a.id === addressId);
            if (address) {
                const updateData = {
                    recipient_name: address.recipient_name,
                    address_line1: address.address_line1,
                    city: address.city,
                    region: address.region,
                    postal_code: address.postal_code,
                    country: address.country || 'NZ',
                    is_default: true
                };
                if (address.address_line2) updateData.address_line2 = address.address_line2;
                if (address.phone) updateData.phone = address.phone;

                await API.updateAddress(addressId, updateData);
                await this.loadAddresses();
            }
        } catch (error) {
            DebugLog.error('Failed to set default address:', error);
            this.showToast('Failed to set default address', 'error');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Set Default`;
            }
        }
    },

    /**
     * Open address modal (add or edit)
     */
    openAddressModal(addressId = null) {
        const modal = document.getElementById('address-modal');
        if (!modal) return;

        const title = document.getElementById('address-modal-title');
        const form = document.getElementById('address-form');
        const saveBtn = document.getElementById('address-save-btn');

        if (addressId) {
            // Edit mode
            const address = this.addresses.find(a => a.id === addressId);
            if (address) {
                title.textContent = 'Edit Address';
                saveBtn.textContent = 'Update Address';
                this.editingAddressId = addressId;

                // Split recipient name
                const nameParts = (address.recipient_name || '').split(' ');
                document.getElementById('address-first-name').value = nameParts[0] || '';
                document.getElementById('address-last-name').value = nameParts.slice(1).join(' ') || '';
                document.getElementById('address-line1').value = address.address_line1 || '';
                document.getElementById('address-line2').value = address.address_line2 || '';
                document.getElementById('address-city').value = address.city || '';
                document.getElementById('address-region').value = address.region || '';
                document.getElementById('address-postcode').value = address.postal_code || '';
                document.getElementById('address-phone').value = address.phone || '';
                document.getElementById('address-default').checked = address.is_default || false;
                const deliveryType = address.delivery_type || 'urban';
                const deliveryRadio = document.querySelector(`input[name="delivery_type"][value="${deliveryType}"]`);
                if (deliveryRadio) deliveryRadio.checked = true;
            }
        } else {
            // Add mode
            title.textContent = 'Add New Address';
            saveBtn.textContent = 'Save Address';
            this.editingAddressId = null;
            form.reset();
        }

        modal.hidden = false;
        document.body.style.overflow = 'hidden';
    },

    /**
     * Close address modal
     */
    closeAddressModal() {
        const modal = document.getElementById('address-modal');
        if (modal) {
            modal.hidden = true;
            document.body.style.overflow = '';
            this.editingAddressId = null;
        }
    },

    /**
     * Save address
     */
    async saveAddress() {
        const form = document.getElementById('address-form');
        const errorEl = document.getElementById('address-form-error');
        const saveBtn = document.getElementById('address-save-btn');

        // Get form values
        const firstName = document.getElementById('address-first-name').value.trim();
        const lastName = document.getElementById('address-last-name').value.trim();
        const line1 = document.getElementById('address-line1').value.trim();
        const city = document.getElementById('address-city').value.trim();
        const region = document.getElementById('address-region').value;
        const postcode = document.getElementById('address-postcode').value.trim();

        // Validate
        if (!firstName || !lastName || !line1 || !city || !region || !postcode) {
            errorEl.textContent = 'Please fill in all required fields.';
            errorEl.hidden = false;
            return;
        }

        if (!/^[0-9]{4}$/.test(postcode)) {
            errorEl.textContent = 'Please enter a valid 4-digit postcode.';
            errorEl.hidden = false;
            return;
        }

        errorEl.hidden = true;
        saveBtn.disabled = true;
        saveBtn.textContent = this.editingAddressId ? 'Updating...' : 'Saving...';

        // If this is the first address being added, make it default automatically
        const isFirstAddress = !this.editingAddressId && (!this.addresses || this.addresses.length === 0);
        const shouldBeDefault = isFirstAddress || document.getElementById('address-default').checked;

        const deliveryType = document.querySelector('input[name="delivery_type"]:checked')?.value || 'urban';

        const addressData = {
            recipient_name: `${firstName} ${lastName}`.trim(),
            address_line1: line1,
            city: city,
            region: region,
            postal_code: postcode,
            country: 'NZ',
            is_default: shouldBeDefault,
            delivery_type: deliveryType
        };

        const line2 = document.getElementById('address-line2').value.trim();
        const phone = document.getElementById('address-phone').value.trim();
        if (line2) addressData.address_line2 = line2;
        if (phone) addressData.phone = phone;

        try {
            if (this.editingAddressId) {
                await API.updateAddress(this.editingAddressId, addressData);
            } else {
                await API.addAddress(addressData);
            }
            this.closeAddressModal();
            await this.loadAddresses();
            this.showToast(this.editingAddressId ? 'Address updated' : 'Address added', 'success');
        } catch (error) {
            DebugLog.error('Failed to save address:', error);
            errorEl.textContent = error.message || 'Failed to save address.';
            errorEl.hidden = false;
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = this.editingAddressId ? 'Update Address' : 'Save Address';
        }
    },

    /**
     * Confirm delete address
     */
    confirmDeleteAddress(addressId) {
        this.deletingAddressId = addressId;
        const modal = document.getElementById('delete-modal');
        if (modal) {
            modal.hidden = false;
            document.body.style.overflow = 'hidden';
        }
    },

    /**
     * Delete address
     */
    async deleteAddress() {
        if (!this.deletingAddressId) return;

        const btn = document.getElementById('delete-confirm-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Deleting...';
        }

        try {
            await API.deleteAddress(this.deletingAddressId);
            this.closeDeleteModal();
            await this.loadAddresses();
            this.showToast('Address deleted', 'success');
        } catch (error) {
            DebugLog.error('Failed to delete address:', error);
            this.showToast('Failed to delete address', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Delete';
            }
        }
    },

    /**
     * Close delete modal
     */
    closeDeleteModal() {
        const modal = document.getElementById('delete-modal');
        if (modal) {
            modal.hidden = true;
            document.body.style.overflow = '';
            this.deletingAddressId = null;
        }
    },

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        const existing = document.querySelector('.toast-message');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast-message toast-message--${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 24px;
            background: ${type === 'error' ? '#dc2626' : '#10b981'};
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 10000;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    },

    /**
     * Render address card
     */
    renderAddressCard(address) {
        const isDefault = address.is_default;
        const name = Security.escapeHtml(address.recipient_name || '');
        const line1 = Security.escapeHtml(address.address_line1 || '');
        const line2 = address.address_line2 ? `${Security.escapeHtml(address.address_line2)}<br>` : '';
        const cityRegion = Security.escapeHtml(`${address.city || ''}, ${address.region || ''} ${address.postal_code || ''}`);
        const phone = address.phone || '';
        const escapedId = Security.escapeAttr(address.id);

        return `
            <div class="address-card ${isDefault ? 'address-card--default' : ''}" data-id="${escapedId}">
                <div class="address-card__header">
                    <div class="address-card__icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                            <circle cx="12" cy="10" r="3"/>
                        </svg>
                    </div>
                    ${isDefault ? `
                        <span class="address-card__badge">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            Default
                        </span>
                    ` : ''}
                </div>
                <div class="address-card__body">
                    <p class="address-card__name">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                        ${name}
                    </p>
                    <p class="address-card__address">
                        ${line1}<br>
                        ${line2}${cityRegion}
                    </p>
                    ${phone ? `
                        <p class="address-card__phone">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                            </svg>
                            ${Security.escapeHtml(phone)}
                        </p>
                    ` : ''}
                </div>
                <div class="address-card__actions">
                    ${!isDefault ? `
                        <button type="button" class="address-card__btn address-card__btn--default" data-action="set-default" data-id="${escapedId}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                            </svg>
                            Set Default
                        </button>
                    ` : ''}
                    <button type="button" class="address-card__btn address-card__btn--edit" data-action="edit" data-id="${escapedId}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        Edit
                    </button>
                    <button type="button" class="address-card__btn address-card__btn--delete" data-action="delete" data-id="${escapedId}" title="Delete address">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    },

    /**
     * Load all printers from API
     */
    async loadPrinters() {
        const grid = document.getElementById('printers-grid');
        const emptyState = document.getElementById('printers-empty');

        if (!grid || !emptyState) return;

        try {
            // Load from API (server-first)
            let printers = [];
            const response = await API.getUserPrinters();
            if (response.ok && response.data) {
                printers = Array.isArray(response.data) ? response.data : (response.data.printers || []);
            }

            printers = await this.enrichPrintersData(printers);
            this.printers = printers;

            if (printers.length > 0) {
                grid.innerHTML = printers.map(p => this.renderPrinterCardLarge(p)).join('');
                grid.hidden = false;
                emptyState.hidden = true;
                this.setupPrinterActionHandlers(grid);
            } else {
                grid.hidden = true;
                emptyState.hidden = false;
            }
        } catch (error) {
            DebugLog.error('Failed to load printers:', error);
            grid.hidden = true;
            emptyState.hidden = false;
        }
    },

    /**
     * Setup printer action handlers
     */
    setupPrinterActionHandlers(grid) {
        grid.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = btn.dataset.action;
                const id = btn.dataset.id;

                if (action === 'edit') {
                    this.showAddPrinterSection(id);
                } else if (action === 'delete') {
                    this.confirmDeletePrinter(id);
                }
            });
        });
    },

    /**
     * Render large printer card for printers page
     */
    renderPrinterCardLarge(printer) {
        const model = printer.full_name || printer.model_name || printer.model || printer.name || 'Unknown Printer';
        const brand = printer.brand || '';
        const nickname = printer.nickname || printer.location || '';
        const slug = printer.slug || printer.printer_slug || '';

        // Build URL: prefer printer slug (direct API lookup), then printer_model (Supabase lookup)
        const searchUrl = slug
            ? `/html/shop?printer=${encodeURIComponent(slug)}`
            : model !== 'Unknown Printer'
                ? `/html/shop?printer_model=${encodeURIComponent(model)}`
                : '/html/shop';

        const escapedId = Security.escapeAttr(printer.id);

        return `
            <div class="printer-card" data-id="${escapedId}">
                <div class="printer-card__image">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M6 9V2h12v7"/>
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                        <rect x="6" y="14" width="12" height="8"/>
                        <circle cx="18" cy="12" r="1" fill="currentColor"/>
                    </svg>
                    ${nickname ? `
                        <p class="printer-card__nickname">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                                <line x1="4" y1="22" x2="4" y2="15"/>
                            </svg>
                            ${Security.escapeHtml(nickname)}
                        </p>
                    ` : ''}
                </div>
                <div class="printer-card__body">
                    ${brand ? `<span class="printer-card__brand">${Security.escapeHtml(brand)}</span>` : ''}
                    <h3 class="printer-card__model">${Security.escapeHtml(model)}</h3>
                </div>
                <div class="printer-card__actions">
                    <a href="${Security.escapeAttr(searchUrl)}" class="printer-card__btn printer-card__btn--find">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="9" cy="21" r="1"/>
                            <circle cx="20" cy="21" r="1"/>
                            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                        </svg>
                        Compatible Products
                    </a>
                    <button type="button" class="printer-card__btn printer-card__btn--edit" data-action="edit" data-id="${escapedId}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button type="button" class="printer-card__btn printer-card__btn--delete" data-action="delete" data-id="${escapedId}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    },

    /**
     * Reset the printer finder to its initial state
     */
    resetPrinterFinder() {
        // Reset state
        this.printerFinderState.selectedBrand = null;
        this.printerFinderState.selectedSeries = null;
        this.printerFinderState.selectedModel = null;

        // Clear form values
        document.getElementById('printer-model').value = '';
        document.getElementById('printer-brand').value = '';
        document.getElementById('printer-slug').value = '';
        document.getElementById('printer-full-name').value = '';
        document.getElementById('printer-nickname').value = '';

        // Reset brand buttons
        document.querySelectorAll('#printer-brands .ink-finder__brand-btn').forEach(btn => {
            btn.classList.remove('ink-finder__brand-btn--selected');
        });

        // Reset dropdowns
        const seriesTrigger = document.getElementById('printer-series-trigger');
        const modelTrigger = document.getElementById('printer-model-trigger');
        seriesTrigger.querySelector('.custom-select__value').textContent = 'Choose a series...';
        seriesTrigger.disabled = true;
        modelTrigger.querySelector('.custom-select__value').textContent = 'Choose a model...';
        modelTrigger.disabled = true;

        // Hide action row, disable save
        const actionRow = document.getElementById('printer-action-row');
        if (actionRow) actionRow.hidden = true;
        document.getElementById('printer-save-btn').disabled = true;

        // Show steps
        const steps = document.getElementById('printer-finder-steps');
        if (steps) steps.hidden = false;

        this.updatePrinterFinderSteps();
    },

    /**
     * Show the inline add-printer section
     */
    showAddPrinterSection(printerId = null) {
        const section = document.getElementById('add-printer-section');
        if (!section) return;

        const title = document.getElementById('printer-section-title');
        const form = document.getElementById('printer-form');
        const saveBtn = document.getElementById('printer-save-btn');

        this.resetPrinterFinder();

        if (printerId) {
            // Edit mode — only show nickname field
            const printer = this.printers?.find(p => p.id === printerId);
            if (printer) {
                title.textContent = 'Edit Printer';
                saveBtn.textContent = 'Update Printer';
                this.editingPrinterId = printerId;

                // Pre-fill hidden fields
                const fullName = printer.full_name || printer.fullName || `${printer.brand || ''} ${printer.model || printer.name || ''}`.trim();
                document.getElementById('printer-model').value = printer.model || printer.name || '';
                document.getElementById('printer-brand').value = printer.brand || '';
                document.getElementById('printer-slug').value = printer.slug || printer.printer_slug || '';
                document.getElementById('printer-full-name').value = fullName;
                document.getElementById('printer-nickname').value = printer.nickname || printer.location || '';

                // Hide steps, show action row with nickname pre-filled
                const steps = document.getElementById('printer-finder-steps');
                if (steps) steps.hidden = true;

                const actionRow = document.getElementById('printer-action-row');
                if (actionRow) actionRow.hidden = false;

                saveBtn.disabled = false;
            }
        } else {
            // Add mode
            title.textContent = 'Save a Printer';
            saveBtn.textContent = 'Save Printer';
            this.editingPrinterId = null;
            form.reset();
        }

        this.updatePrinterFinderSteps();
        section.hidden = false;
        document.body.style.overflow = 'hidden';
    },

    /**
     * Hide the inline add-printer section
     */
    hideAddPrinterSection() {
        const section = document.getElementById('add-printer-section');
        if (section) {
            section.hidden = true;
            document.body.style.overflow = '';
            this.editingPrinterId = null;
            this.closeAllDropdowns();
            this.resetPrinterFinder();
        }
    },

    /**
     * Save printer to API
     */
    async savePrinter() {
        const errorEl = document.getElementById('printer-form-error');
        const saveBtn = document.getElementById('printer-save-btn');

        const model = document.getElementById('printer-model').value.trim();
        const brand = document.getElementById('printer-brand').value.trim();
        const slug = document.getElementById('printer-slug').value.trim();
        const fullName = document.getElementById('printer-full-name').value.trim();
        const nickname = document.getElementById('printer-nickname').value.trim();

        // Validate
        if (!model) {
            errorEl.textContent = 'Please select a printer model.';
            errorEl.hidden = false;
            return;
        }

        errorEl.hidden = true;
        saveBtn.disabled = true;
        saveBtn.textContent = this.editingPrinterId ? 'Updating...' : 'Saving...';

        try {
            // Server-first: use API
            if (this.editingPrinterId) {
                await API.updateUserPrinter(this.editingPrinterId, { nickname: nickname || null });
            } else {
                const printerId = document.getElementById('printer-printer-id').value;
                if (!printerId) {
                    errorEl.textContent = 'Could not find this printer in our system.';
                    errorEl.hidden = false;
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Printer';
                    return;
                }
                await API.addUserPrinter({ printer_id: printerId });
            }

            this.hideAddPrinterSection();
            await this.loadPrinters();
            this.showToast(this.editingPrinterId ? 'Printer updated' : 'Printer added', 'success');
        } catch (error) {
            DebugLog.error('Failed to save printer:', error);
            errorEl.textContent = error.message || 'Failed to save printer.';
            errorEl.hidden = false;
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = this.editingPrinterId ? 'Update Printer' : 'Save Printer';
        }
    },

    /**
     * Confirm delete printer
     */
    confirmDeletePrinter(printerId) {
        this.deletingPrinterId = printerId;
        const modal = document.getElementById('delete-printer-modal');
        if (modal) {
            modal.hidden = false;
            document.body.style.overflow = 'hidden';
        }
    },

    /**
     * Delete printer via API
     */
    async deletePrinter() {
        if (!this.deletingPrinterId) return;

        const btn = document.getElementById('delete-printer-confirm-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Removing...';
        }

        try {
            // Server-first: use API
            await API.deleteUserPrinter(this.deletingPrinterId);

            this.closeDeletePrinterModal();
            await this.loadPrinters();
            this.showToast('Printer removed', 'success');
        } catch (error) {
            DebugLog.error('Failed to delete printer:', error);
            this.showToast('Failed to remove printer', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Remove';
            }
        }
    },

    /**
     * Close delete printer modal
     */
    closeDeletePrinterModal() {
        const modal = document.getElementById('delete-printer-modal');
        if (modal) {
            modal.hidden = true;
            document.body.style.overflow = '';
            this.deletingPrinterId = null;
        }
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure Auth is initialized first
    setTimeout(() => AccountPage.init(), 200);
});

// Make available globally
window.AccountPage = AccountPage;
