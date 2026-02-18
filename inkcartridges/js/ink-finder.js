/**
 * INK FINDER - Guided Printer Selection Tool
 * ==========================================
 * Dynamically extracts printer models from product compatibility data.
 * Helps users find compatible ink/toner for their printer.
 */

(function() {
    'use strict';

    // ============================================
    // DOM ELEMENTS
    // ============================================
    const brandButtons = document.querySelectorAll('.ink-finder__brand-btn');
    const seriesTrigger = document.getElementById('ink-finder-series-trigger');
    const seriesDropdown = document.getElementById('ink-finder-series-dropdown');
    const seriesInput = document.getElementById('ink-finder-series');
    const modelTrigger = document.getElementById('ink-finder-model-trigger');
    const modelDropdown = document.getElementById('ink-finder-model-dropdown');
    const modelInput = document.getElementById('ink-finder-model');
    const submitBtn = document.getElementById('ink-finder-submit');
    const steps = document.querySelectorAll('.ink-finder__step');

    // Exit if elements don't exist (not on this page)
    if (!brandButtons.length || !seriesTrigger || !modelTrigger || !submitBtn) {
        return;
    }

    // ============================================
    // TAB SWITCHING
    // ============================================
    const tabButtons = document.querySelectorAll('.ink-finder__tab');
    const printerPanel = document.getElementById('finder-panel-printer');
    const cartridgePanel = document.getElementById('finder-panel-cartridge');

    function switchTab(selectedTab) {
        tabButtons.forEach(tab => {
            const isActive = tab === selectedTab;
            tab.classList.toggle('ink-finder__tab--active', isActive);
            tab.setAttribute('aria-selected', String(isActive));
        });

        const targetId = selectedTab.getAttribute('aria-controls');

        if (printerPanel) {
            printerPanel.classList.toggle('ink-finder__tab-panel--hidden', targetId !== 'finder-panel-printer');
        }
        if (cartridgePanel) {
            cartridgePanel.classList.toggle('ink-finder__tab-panel--hidden', targetId !== 'finder-panel-cartridge');
        }

        // Save preference
        try {
            localStorage.setItem('ink-finder-tab', targetId);
        } catch { /* ignore */ }
    }

    // Bind tab click events
    tabButtons.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab));
    });

    // Restore last used tab
    try {
        const savedTab = localStorage.getItem('ink-finder-tab');
        if (savedTab === 'finder-panel-cartridge') {
            const cartridgeTab = document.getElementById('finder-tab-cartridge');
            if (cartridgeTab) switchTab(cartridgeTab);
        }
    } catch { /* ignore */ }

    // ============================================
    // STATE
    // ============================================
    let selectedBrand = null;
    let selectedSeries = null;
    let selectedModel = null;
    let selectedPrinterName = null;
    let printerCache = {}; // Cache extracted printers by brand
    let currentSeriesData = [];
    let currentModelsData = [];

    // ============================================
    // HELPER FUNCTIONS (uses PrinterData from printer-data.js)
    // ============================================

    /**
     * Get Supabase client (creates one if needed)
     */
    function getSupabaseClient() {
        if (typeof Auth !== 'undefined' && Auth.supabase) {
            return Auth.supabase;
        }
        // Create our own client if Auth isn't available
        if (typeof supabase !== 'undefined' && supabase.createClient && typeof Config !== 'undefined') {
            return supabase.createClient(Config.SUPABASE_URL, Config.SUPABASE_ANON_KEY);
        }
        return null;
    }

    /**
     * Fetch printers for a brand - queries Supabase directly to get ALL models
     */
    async function loadPrintersForBrand(brand) {
        if (printerCache[brand]) {
            return printerCache[brand];
        }

        const brandName = PrinterData.BRAND_NAMES[brand] || brand;
        let printers = [];

        // Try Supabase direct query first (gets ALL printer models)
        const supabaseClient = getSupabaseClient();
        if (supabaseClient) {
            try {
                // First get the brand ID
                const { data: brandData, error: brandError } = await supabaseClient
                    .from('brands')
                    .select('id')
                    .ilike('name', brandName)
                    .single();

                if (!brandError && brandData) {
                    // Get all printer models for this brand
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
                if (response.success && response.data) {
                    printers = Array.isArray(response.data) ? response.data : (response.data.printers || []);
                }
            } catch (error) {
                // API fallback also failed, will use static data
            }
        }

        // Transform printers to our format
        if (printers.length > 0) {
            const formattedPrinters = printers.map(p => {
                const modelName = p.model_name || p.model || p.name || '';
                const fullName = p.full_name || `${brandName} ${modelName}`;

                // Determine series from model name
                let seriesId = 'other';
                let seriesName = 'Other Models';
                const brandPatterns = PrinterData.SERIES_PATTERNS[brand] || [];

                for (const pattern of brandPatterns) {
                    if (modelName.toUpperCase().startsWith(pattern.prefix.toUpperCase())) {
                        // Generate seriesId from series NAME (not prefix) to avoid duplicates
                        seriesId = pattern.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                        seriesName = pattern.name;
                        break;
                    }
                }

                return {
                    id: (p.slug || modelName).toLowerCase().replace(/\s+/g, '-'),
                    name: modelName,
                    fullName: fullName,
                    seriesId: seriesId,
                    seriesName: seriesName
                };
            });

            const series = PrinterData.groupPrintersBySeries(formattedPrinters);
            printerCache[brand] = series;
            return series;
        }

        // Final fallback: use static printer data
        const staticPrinters = getStaticPrintersForBrand(brand);
        const series = PrinterData.groupPrintersBySeries(staticPrinters);
        printerCache[brand] = series;
        return series;
    }

    /**
     * Static printer data fallback
     *
     * INTENTIONAL FALLBACK: This static data is used when the /api/printers endpoint
     * is unavailable. The primary source of printer data should be the server API.
     * This fallback ensures the ink finder works even if the API is temporarily down.
     */
    function getStaticPrintersForBrand(brand) {
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
                { id: 'hl-4070cdw', name: 'HL-4070CDW', fullName: 'Brother HL-4070CDW', seriesId: 'hl', seriesName: 'HL Series (Laser Printer)' },
                // PT Series (P-touch Label Printer)
                { id: 'pt-1010', name: 'PT-1010', fullName: 'Brother PT-1010', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-1280', name: 'PT-1280', fullName: 'Brother PT-1280', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-1290', name: 'PT-1290', fullName: 'Brother PT-1290', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-1880', name: 'PT-1880', fullName: 'Brother PT-1880', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-2100', name: 'PT-2100', fullName: 'Brother PT-2100', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-2700', name: 'PT-2700', fullName: 'Brother PT-2700', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-d210', name: 'PT-D210', fullName: 'Brother PT-D210', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-d450', name: 'PT-D450', fullName: 'Brother PT-D450', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-d600', name: 'PT-D600', fullName: 'Brother PT-D600', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-e550w', name: 'PT-E550W', fullName: 'Brother PT-E550W', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-h110', name: 'PT-H110', fullName: 'Brother PT-H110', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-p700', name: 'PT-P700', fullName: 'Brother PT-P700', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-p750w', name: 'PT-P750W', fullName: 'Brother PT-P750W', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-p900w', name: 'PT-P900W', fullName: 'Brother PT-P900W', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                { id: 'pt-p950nw', name: 'PT-P950NW', fullName: 'Brother PT-P950NW', seriesId: 'pt', seriesName: 'PT Series (P-touch Label)' },
                // QL Series (Label Printer)
                { id: 'ql-500', name: 'QL-500', fullName: 'Brother QL-500', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-550', name: 'QL-550', fullName: 'Brother QL-550', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-570', name: 'QL-570', fullName: 'Brother QL-570', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-580n', name: 'QL-580N', fullName: 'Brother QL-580N', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-600', name: 'QL-600', fullName: 'Brother QL-600', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-700', name: 'QL-700', fullName: 'Brother QL-700', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-710w', name: 'QL-710W', fullName: 'Brother QL-710W', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-720nw', name: 'QL-720NW', fullName: 'Brother QL-720NW', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-800', name: 'QL-800', fullName: 'Brother QL-800', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-810w', name: 'QL-810W', fullName: 'Brother QL-810W', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-820nwb', name: 'QL-820NWB', fullName: 'Brother QL-820NWB', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-1050', name: 'QL-1050', fullName: 'Brother QL-1050', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-1060n', name: 'QL-1060N', fullName: 'Brother QL-1060N', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-1100', name: 'QL-1100', fullName: 'Brother QL-1100', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                { id: 'ql-1110nwb', name: 'QL-1110NWB', fullName: 'Brother QL-1110NWB', seriesId: 'ql', seriesName: 'QL Series (Label Printer)' },
                // TD Series (Thermal Direct)
                { id: 'td-2020', name: 'TD-2020', fullName: 'Brother TD-2020', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-2120n', name: 'TD-2120N', fullName: 'Brother TD-2120N', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-2130n', name: 'TD-2130N', fullName: 'Brother TD-2130N', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-4000', name: 'TD-4000', fullName: 'Brother TD-4000', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-4100n', name: 'TD-4100N', fullName: 'Brother TD-4100N', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-4410d', name: 'TD-4410D', fullName: 'Brother TD-4410D', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-4420dn', name: 'TD-4420DN', fullName: 'Brother TD-4420DN', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-4520dn', name: 'TD-4520DN', fullName: 'Brother TD-4520DN', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' },
                { id: 'td-4550dnwb', name: 'TD-4550DNWB', fullName: 'Brother TD-4550DNWB', seriesId: 'td', seriesName: 'TD Series (Thermal Direct)' }
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
                // Expression Series
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
    }

    // ============================================
    // CUSTOM SELECT FUNCTIONS
    // ============================================

    function openDropdown(trigger, dropdown) {
        trigger.setAttribute('aria-expanded', 'true');
        dropdown.hidden = false;
        trigger.parentElement.classList.add('custom-select--open');
    }

    function closeDropdown(trigger, dropdown) {
        trigger.setAttribute('aria-expanded', 'false');
        dropdown.hidden = true;
        trigger.parentElement.classList.remove('custom-select--open');
    }

    function toggleDropdown(trigger, dropdown) {
        const isOpen = trigger.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
            closeDropdown(trigger, dropdown);
        } else {
            closeAllDropdowns();
            openDropdown(trigger, dropdown);
        }
    }

    function closeAllDropdowns() {
        closeDropdown(seriesTrigger, seriesDropdown);
        closeDropdown(modelTrigger, modelDropdown);
    }

    function populateDropdown(dropdown, options, valueKey = 'id', labelKey = 'name') {
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
        const itemsPerPage = cols * rowsPerPage;  // 18 items per "page"

        // Use CSS order property for column-first ordering within row-first grid
        // Items should fill: 6 down col 1, then 6 down col 2, then 6 down col 3, then repeat
        options.forEach((option, i) => {
            const li = document.createElement('li');
            li.className = 'custom-select__option';
            li.setAttribute('data-value', option[valueKey]);
            li.setAttribute('data-full-name', option.fullName || option.name || '');

            // "Other Models" should always appear at the end
            const isOtherModels = option[valueKey] === 'other' || (option.name && option.name.toLowerCase().includes('other'));

            if (isOtherModels) {
                // Give it a very high order value to push to the end
                li.style.order = 99999;
            } else {
                // Calculate CSS order for column-first fill in a row-first grid
                // Visual position i maps to grid order that places it in the correct cell
                const page = Math.floor(i / itemsPerPage);       // which page of 18 items
                const indexInPage = i % itemsPerPage;            // position within page (0-17)
                const visualCol = Math.floor(indexInPage / rowsPerPage);  // column 0, 1, or 2
                const visualRow = indexInPage % rowsPerPage;     // row 0-5 within column
                // Grid flows row-first, so order = row * cols + col
                const order = (page * rowsPerPage + visualRow) * cols + visualCol;
                li.style.order = order;
            }

            // Add model count for series
            if (option.models) {
                li.textContent = `${option[labelKey]} (${option.models.length} models)`;
            } else {
                li.textContent = option[labelKey];
            }

            dropdown.appendChild(li);
        });
    }

    function setSelectValue(trigger, input, value, label) {
        const valueSpan = trigger.querySelector('.custom-select__value');
        valueSpan.textContent = label;
        input.value = value;
    }

    // ============================================
    // STEP MANAGEMENT
    // ============================================

    function updateStepStates() {
        steps.forEach((step, index) => {
            const stepNum = index + 1;
            step.classList.remove('ink-finder__step--active', 'ink-finder__step--completed', 'ink-finder__step--disabled');

            if (stepNum === 1) {
                step.classList.add('ink-finder__step--active');
                if (selectedBrand) {
                    step.classList.add('ink-finder__step--completed');
                }
            } else if (stepNum === 2) {
                if (selectedBrand) {
                    step.classList.add('ink-finder__step--active');
                    if (selectedSeries) {
                        step.classList.add('ink-finder__step--completed');
                    }
                } else {
                    step.classList.add('ink-finder__step--disabled');
                }
            } else if (stepNum === 3) {
                if (selectedSeries) {
                    step.classList.add('ink-finder__step--active');
                    if (selectedModel) {
                        step.classList.add('ink-finder__step--completed');
                    }
                } else {
                    step.classList.add('ink-finder__step--disabled');
                }
            }
        });
    }

    /**
     * Handle brand selection
     */
    async function selectBrand(brand) {
        // Update button states
        brandButtons.forEach(btn => {
            btn.classList.remove('ink-finder__brand-btn--selected');
            if (btn.dataset.brand === brand) {
                btn.classList.add('ink-finder__brand-btn--selected');
            }
        });

        selectedBrand = brand;
        selectedSeries = null;
        selectedModel = null;
        selectedPrinterName = null;

        // Show loading state
        setSelectValue(seriesTrigger, seriesInput, '', 'Loading series...');
        seriesTrigger.disabled = true;
        setSelectValue(modelTrigger, modelInput, '', '← Select series');
        modelTrigger.disabled = true;
        submitBtn.disabled = true;

        updateStepStates();

        // Load printers for this brand
        const series = await loadPrintersForBrand(brand);
        currentSeriesData = series;

        if (series.length === 0) {
            setSelectValue(seriesTrigger, seriesInput, '', 'No printers found');
            return;
        }

        // Populate series dropdown
        populateDropdown(seriesDropdown, series);
        setSelectValue(seriesTrigger, seriesInput, '', 'Select Series');
        seriesTrigger.disabled = false;

        updateStepStates();
    }

    /**
     * Handle series selection
     */
    function selectSeries(seriesId) {
        selectedSeries = seriesId;
        selectedModel = null;
        selectedPrinterName = null;

        // Find the selected series
        const series = currentSeriesData.find(s => s.id === seriesId);
        if (!series) return;

        currentModelsData = series.models;

        // Populate models dropdown
        populateDropdown(modelDropdown, currentModelsData);
        setSelectValue(modelTrigger, modelInput, '', 'Select Model');
        modelTrigger.disabled = false;
        submitBtn.disabled = true;

        updateStepStates();
    }

    /**
     * Handle model selection
     */
    function selectModel(modelId, printerFullName) {
        selectedModel = modelId;
        selectedPrinterName = printerFullName;
        submitBtn.disabled = false;
        updateStepStates();
    }

    /**
     * Navigate to shop page with printer filter
     */
    function findProducts() {
        if (!selectedPrinterName || !selectedBrand) return;

        // Redirect to shop page with printer model
        // The shop page will find ALL compatible products (genuine + compatible)
        // Brand is included for display purposes but doesn't limit the search
        const searchTerm = selectedPrinterName;
        window.location.href = `/html/shop.html?printer_model=${encodeURIComponent(searchTerm)}&printer_brand=${encodeURIComponent(selectedBrand)}`;
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    // Brand button clicks
    brandButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            selectBrand(this.dataset.brand);
        });
    });

    // Series dropdown trigger
    seriesTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        if (!this.disabled) {
            toggleDropdown(seriesTrigger, seriesDropdown);
        }
    });

    // Series dropdown option selection
    seriesDropdown.addEventListener('click', function(e) {
        const option = e.target.closest('.custom-select__option');
        if (option) {
            const value = option.dataset.value;
            const label = option.textContent;

            seriesDropdown.querySelectorAll('.custom-select__option').forEach(opt => {
                opt.classList.remove('custom-select__option--selected');
            });
            option.classList.add('custom-select__option--selected');

            setSelectValue(seriesTrigger, seriesInput, value, label);
            closeDropdown(seriesTrigger, seriesDropdown);

            selectSeries(value);
        }
    });

    // Model dropdown trigger
    modelTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        if (!this.disabled) {
            toggleDropdown(modelTrigger, modelDropdown);
        }
    });

    // Model dropdown option selection
    modelDropdown.addEventListener('click', function(e) {
        const option = e.target.closest('.custom-select__option');
        if (option) {
            const value = option.dataset.value;
            const label = option.textContent;
            const fullName = option.dataset.fullName || label;

            modelDropdown.querySelectorAll('.custom-select__option').forEach(opt => {
                opt.classList.remove('custom-select__option--selected');
            });
            option.classList.add('custom-select__option--selected');

            setSelectValue(modelTrigger, modelInput, value, label);
            closeDropdown(modelTrigger, modelDropdown);

            selectModel(value, fullName);
        }
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.custom-select')) {
            closeAllDropdowns();
        }
    });

    // Keyboard support
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeAllDropdowns();
        }
    });

    // Submit button click
    submitBtn.addEventListener('click', findProducts);

    // Initialize step states
    updateStepStates();

})();
