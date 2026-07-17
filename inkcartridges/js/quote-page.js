/**
 * QUOTE-PAGE.JS
 * =============
 * Drives /quote — the two-stage business quote experience (Jul 2026 redesign).
 * It is the landing target for the printed QR code (see /quote-qr generator
 * tool), so the primary audience is a MOBILE visitor standing next to their
 * printer: Stage 1 asks "What do you need?" (photo/file upload, structured
 * product rows with autocomplete, printer models, pasted list, or plain-text
 * help), Stage 2 asks "Where should we send your quote?" (contact details +
 * optional business details) with an editable recap of Stage 1.
 *
 * There is no dedicated backend quote endpoint yet, so this reuses the proven
 * POST /api/contact pipeline: composeMessage() serialises the whole structured
 * request (reference, source, product rows, printers, upload paths, business
 * details) into a readable plain-text `message` body posted with subject
 * "Trade quote request", so every request lands in the existing support inbox
 * with zero backend changes. A structured /api/quote endpoint is a future
 * backend follow-up.
 *
 * File uploads go straight to the PRIVATE Supabase Storage bucket
 * 'quote-uploads' (write-only for anon — see sql/quote_uploads.sql). The email
 * carries each file's storage path; the owner opens them via the Supabase
 * dashboard. Client-side MIME/size checks run before upload; the bucket
 * enforces the same limits server-side.
 *
 * Anti-spam mirrors contact-page.js (honeypot + Turnstile + envelope-aware
 * send()); the Turnstile widget renders lazily on first entry to Stage 2 so
 * its ~5-minute token doesn't expire while the customer fills Stage 1, and a
 * failed load now shows a visible error + Retry instead of a silent null
 * token. Draft state persists in sessionStorage ('quote_draft', 30-min TTL,
 * cleared on success) so Back/refresh never lose work.
 */

(function () {
    'use strict';

    // ── Constants ────────────────────────────────────────────────────────────
    var DRAFT_KEY = 'quote_draft';
    var DRAFT_TTL_MS = 30 * 60 * 1000; // mirror checkout_state's 30-min expiry
    var BUCKET = 'quote-uploads';      // must match sql/quote_uploads.sql
    var MAX_FILE_BYTES = 10485760;     // 10 MB — bucket-enforced server-side too
    var MAX_FILES = 6;
    var MAX_ROWS = 20;                 // keeps the composed email bounded
    var ALLOWED_MIME = {
        'image/jpeg': 1,
        'image/png': 1,
        'image/webp': 1,
        'application/pdf': 1,
        'text/csv': 1,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 1,
    };
    // Some platforms hand over CSV/XLSX with an empty MIME type — fall back to
    // the extension for those two only (images/PDFs always carry a type).
    var ALLOWED_EXT_FALLBACK = /\.(csv|xlsx)$/i;
    // Campaign attribution: only values in this allowlist are ever echoed into
    // the composed message. Arbitrary ?utm_source strings are NOT trusted.
    var SOURCE_ALLOWLIST = { 'business-card': 'Business card' };
    // Human-readable reference alphabet — no 0/O/1/I so it survives being read
    // out over the phone.
    var REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var METHODS = ['upload', 'lookup', 'paste', 'help'];
    var PREF_LABELS = {
        both: 'genuine & compatible (both)',
        genuine: 'genuine/OEM only',
        compatible: 'compatible ok',
        'no-preference': 'no preference',
    };

    // ── State ────────────────────────────────────────────────────────────────
    // Dynamic collections live here; plain fields live in the DOM inputs and
    // are read on save/compose. uploads[].status: 'uploading' | 'done' | 'error'.
    var state = {
        ref: null,
        stage: 1,
        methods: { upload: false, lookup: false, paste: false, help: false },
        rows: [],      // { id, code, qty, pref, notes }
        printers: [],  // { brand, model }
        uploads: [],   // { id, path, name, size, status, file? }
        source: null,  // allowlisted label or null
    };

    var els = {};
    var rowSeq = 0;
    var fileSeq = 0;
    var started = false;           // quote_started fired once
    var printerCache = {};         // brand slug -> [model names]
    var saveDraftDebounced = null; // assigned in init

    // ── Small helpers ───────────────────────────────────────────────────────
    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function showResult(el, kind, message) {
        if (!el) return;
        el.className = 'contact-form__result contact-form__result--' + kind;
        el.textContent = message;
        el.hidden = false;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) { /* ignore */ }
    }

    function setInvalid(input, invalid) {
        if (!input) return;
        if (invalid) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }

    function val(form, name) {
        var el = form.querySelector('[name="' + name + '"]');
        return (el && el.value) ? el.value : '';
    }

    function track(eventName, params) {
        try { if (typeof gtag === 'function') gtag('event', eventName, params || {}); } catch (_) { /* ignore */ }
    }

    function markStarted() {
        if (started) return;
        started = true;
        track('quote_started');
    }

    function reducedMotion() {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    }

    function announce(message) {
        if (els.live) els.live.textContent = message;
    }

    function formatSize(bytes) {
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
    }

    // Per-field inline error, associated via aria-describedby.
    function setFieldError(input, msg) {
        if (!input) return;
        var id = 'quote-err-' + (input.name || input.id || 'field');
        var span = document.getElementById(id);
        if (msg) {
            if (!span) {
                span = document.createElement('span');
                span.id = id;
                span.className = 'quote-field-error';
                input.insertAdjacentElement('afterend', span);
            }
            span.textContent = msg;
            input.setAttribute('aria-describedby', id);
            setInvalid(input, true);
        } else {
            if (span) span.remove();
            input.removeAttribute('aria-describedby');
            setInvalid(input, false);
        }
    }

    // ── Reference ────────────────────────────────────────────────────────────
    function makeRef() {
        var chars = '';
        try {
            var buf = new Uint32Array(6);
            crypto.getRandomValues(buf);
            for (var i = 0; i < 6; i++) chars += REF_ALPHABET[buf[i] % REF_ALPHABET.length];
        } catch (_) {
            for (var j = 0; j < 6; j++) chars += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
        }
        return 'Q-' + chars;
    }

    // ── Draft persistence (sessionStorage, 30-min TTL) ──────────────────────
    // Never persists the Turnstile token or File objects — uploads persist as
    // {path,name,size} only (they're already in the bucket).
    var FIELD_NAMES = [
        'name', 'business_name', 'email', 'phone',
        'nzbn', 'account_no', 'preferred_contact', 'po_required',
        'order_frequency', 'urgency', 'delivery_suburb', 'delivery_city',
        'delivery_postcode', 'required_by', 'pasted_list', 'help_text',
    ];

    function collectDraft() {
        var fields = {};
        FIELD_NAMES.forEach(function (n) {
            var v = val(els.form, n);
            if (v) fields[n] = v;
        });
        return {
            savedAt: Date.now(),
            ref: state.ref,
            stage: state.stage,
            methods: state.methods,
            rows: state.rows,
            printers: state.printers,
            uploads: state.uploads.filter(function (u) { return u.status === 'done'; })
                .map(function (u) { return { path: u.path, name: u.name, size: u.size }; }),
            fields: fields,
        };
    }

    function saveDraft() {
        try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft())); } catch (_) { /* storage full/blocked */ }
    }

    function clearDraft() {
        try { sessionStorage.removeItem(DRAFT_KEY); } catch (_) { /* ignore */ }
    }

    function restoreDraft() {
        var draft = null;
        try {
            var raw = sessionStorage.getItem(DRAFT_KEY);
            if (raw) draft = JSON.parse(raw);
        } catch (_) { /* corrupted — start fresh */ }
        if (!draft) return false;
        if (!draft.savedAt || Date.now() - draft.savedAt > DRAFT_TTL_MS) {
            clearDraft();
            return false;
        }

        if (draft.ref) state.ref = draft.ref;
        if (draft.fields) {
            Object.keys(draft.fields).forEach(function (n) {
                var el = els.form.querySelector('[name="' + n + '"]');
                if (el) el.value = draft.fields[n];
            });
        }
        (draft.rows || []).forEach(function (r) { addRow(r, { silent: true }); });
        (draft.printers || []).forEach(function (p) {
            if (p && p.model) state.printers.push({ brand: p.brand || '', model: p.model });
        });
        renderPrinterChips();
        (draft.uploads || []).forEach(function (u) {
            if (u && u.path) {
                state.uploads.push({ id: 'qfile-' + (++fileSeq), path: u.path, name: u.name || 'file', size: u.size || 0, status: 'done' });
            }
        });
        renderFileList();
        if (draft.methods) {
            METHODS.forEach(function (m) {
                if (draft.methods[m]) setMethod(m, true, { silent: true });
            });
        }
        if (draft.stage === 2) goToStage(2, { focus: false });
        return true;
    }

    // ── Method toggles ───────────────────────────────────────────────────────
    function setMethod(key, on, opts) {
        state.methods[key] = !!on;
        var btn = document.getElementById('quote-method-' + key);
        var panel = document.getElementById('quote-panel-' + key);
        if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (panel) panel.hidden = !on;
        if (on && key === 'lookup' && state.rows.length === 0) addRow(null, { silent: true });
        if (!opts || !opts.silent) {
            if (on) track('quote_method_selected', { method: key });
            saveDraft();
        }
    }

    function wireMethods() {
        METHODS.forEach(function (key) {
            var btn = document.getElementById('quote-method-' + key);
            if (!btn) return;
            btn.addEventListener('click', function () {
                markStarted();
                var on = btn.getAttribute('aria-pressed') !== 'true';
                setMethod(key, on);
                if (on) {
                    var panel = document.getElementById('quote-panel-' + key);
                    var first = panel && panel.querySelector('input:not([hidden]), textarea, select, button');
                    if (first && typeof first.focus === 'function') first.focus();
                }
            });
        });
    }

    // ── Product rows ─────────────────────────────────────────────────────────
    function rowState(id) {
        for (var i = 0; i < state.rows.length; i++) {
            if (state.rows[i].id === id) return state.rows[i];
        }
        return null;
    }

    function addRow(data, opts) {
        if (state.rows.length >= MAX_ROWS) {
            announce('Product limit reached (' + MAX_ROWS + '). Paste the rest as a list instead.');
            return null;
        }
        var frag = els.rowTemplate.content.cloneNode(true);
        var row = frag.querySelector('.quote-row');
        var id = 'qrow-' + (++rowSeq);
        row.id = id;

        var entry = {
            id: id,
            code: (data && data.code) || '',
            qty: (data && data.qty) || 1,
            pref: (data && data.pref) || 'both',
            notes: (data && data.notes) || '',
        };
        state.rows.push(entry);

        // Wire label/input id pairs (template ships them unlinked).
        ['code', 'qty', 'notes'].forEach(function (kind) {
            var input = row.querySelector('[data-row-input="' + kind + '"]');
            var label = row.querySelector('[data-row-label="' + kind + '"]');
            if (input) input.id = id + '-' + kind;
            if (label) label.setAttribute('for', id + '-' + kind);
        });

        var codeInput = row.querySelector('[data-row-input="code"]');
        var qtyInput = row.querySelector('[data-row-input="qty"]');
        var notesInput = row.querySelector('[data-row-input="notes"]');
        codeInput.value = entry.code;
        qtyInput.value = entry.qty;
        notesInput.value = entry.notes;

        // Radios need a unique group name per row.
        var radios = row.querySelectorAll('[data-row-input="pref"]');
        Array.prototype.forEach.call(radios, function (radio) {
            radio.name = id + '-pref';
            radio.checked = (radio.value === entry.pref);
            radio.addEventListener('change', function () {
                if (radio.checked) { entry.pref = radio.value; saveDraftDebounced(); }
            });
        });

        codeInput.addEventListener('input', function () { entry.code = codeInput.value; setFieldError(codeInput, ''); saveDraftDebounced(); });
        qtyInput.addEventListener('input', function () { entry.qty = qtyInput.value; setFieldError(qtyInput, ''); saveDraftDebounced(); });
        notesInput.addEventListener('input', function () { entry.notes = notesInput.value; saveDraftDebounced(); });

        row.querySelector('[data-row-action="duplicate"]').addEventListener('click', function () {
            var copy = addRow({ code: entry.code, qty: entry.qty, pref: entry.pref, notes: entry.notes });
            if (copy) {
                row.insertAdjacentElement('afterend', copy);
                announce('Product duplicated.');
                var focusTarget = copy.querySelector('[data-row-input="code"]');
                if (focusTarget) focusTarget.focus();
            }
        });
        row.querySelector('[data-row-action="remove"]').addEventListener('click', function () {
            state.rows = state.rows.filter(function (r) { return r.id !== id; });
            row.remove();
            announce('Product removed.');
            // Keep one editable row while the panel is open.
            if (state.rows.length === 0 && state.methods.lookup) addRow(null, { silent: true });
            saveDraft();
        });

        // Cartridge-code autocomplete against /api/search/smart.
        attachCombobox(codeInput, {
            fetchItems: fetchSmartItems,
            onSelect: function (item) {
                codeInput.value = item.value;
                entry.code = item.value;
                saveDraftDebounced();
            },
        });

        els.rows.appendChild(frag);
        if (!opts || !opts.silent) {
            track('quote_product_row_added');
            saveDraft();
        }
        return document.getElementById(id);
    }

    // ── Combobox (shared autocomplete helper) ────────────────────────────────
    // Minimal ARIA combobox: debounced fetch, AbortController, arrow-key nav,
    // Enter to select, Escape to close. Options render via textContent only.
    var _acSeq = 0;
    function attachCombobox(input, opts) {
        var listbox = document.createElement('ul');
        var listId = 'quote-ac-' + (++_acSeq);
        listbox.id = listId;
        listbox.className = 'quote-ac';
        listbox.setAttribute('role', 'listbox');
        listbox.hidden = true;
        input.parentNode.appendChild(listbox);
        input.setAttribute('aria-controls', listId);

        var items = [];
        var active = -1;
        var controller = null;
        var debounceMs = 250; // matches search.js — backend bucket is 120 req/min/IP

        var run = (typeof Utils !== 'undefined' && Utils.debounce)
            ? Utils.debounce(query, debounceMs)
            : query;

        function query() {
            var q = input.value.trim();
            if (q.length < 2) { close(); return; }
            if (controller) controller.abort();
            controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            Promise.resolve(opts.fetchItems(q, controller ? controller.signal : undefined)).then(function (results) {
                items = results || [];
                render();
            }).catch(function () { /* aborted or failed — keep quiet, typing continues */ });
        }

        function render() {
            listbox.textContent = '';
            active = -1;
            if (!items.length) { close(); return; }
            items.forEach(function (item, i) {
                var li = document.createElement('li');
                li.id = listId + '-opt-' + i;
                li.className = 'quote-ac__option';
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', 'false');
                li.textContent = item.label;
                if (item.meta) {
                    var meta = document.createElement('span');
                    meta.className = 'quote-ac__meta';
                    meta.textContent = item.meta;
                    li.appendChild(meta);
                }
                // mousedown (not click) so selection wins the race with blur.
                li.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    select(i);
                });
                listbox.appendChild(li);
            });
            listbox.hidden = false;
            input.setAttribute('aria-expanded', 'true');
        }

        function setActive(i) {
            var options = listbox.children;
            if (active >= 0 && options[active]) options[active].setAttribute('aria-selected', 'false');
            active = i;
            if (active >= 0 && options[active]) {
                options[active].setAttribute('aria-selected', 'true');
                input.setAttribute('aria-activedescendant', options[active].id);
                if (options[active].scrollIntoView) options[active].scrollIntoView({ block: 'nearest' });
            } else {
                input.removeAttribute('aria-activedescendant');
            }
        }

        function select(i) {
            var item = items[i];
            close();
            if (item && opts.onSelect) opts.onSelect(item);
        }

        function close() {
            listbox.hidden = true;
            listbox.textContent = '';
            items = [];
            active = -1;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }

        input.addEventListener('input', function () { markStarted(); run(); });
        input.addEventListener('keydown', function (e) {
            if (listbox.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(active - 1, 0)); }
            else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); select(active); } }
            else if (e.key === 'Escape') { close(); }
        });
        input.addEventListener('blur', function () { setTimeout(close, 150); });

        return { close: close };
    }

    // /api/search/smart resolves cartridge codes and product names; results
    // arrive under data.products (fallback data.suggestions — see search.js).
    function fetchSmartItems(q, signal) {
        var base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
        var url = base + '/api/search/smart?q=' + encodeURIComponent(q) + '&limit=6';
        return fetch(url, { signal: signal }).then(function (res) {
            return res.json().then(function (json) {
                if (!res.ok || !json || !json.ok) return [];
                var data = json.data || {};
                var products = Array.isArray(data.products) ? data.products
                    : (Array.isArray(data.suggestions) ? data.suggestions : []);
                return products.slice(0, 6).map(function (p) {
                    var name = p.name || p.display_name || '';
                    return { value: name, label: name, meta: p.sku ? ('SKU ' + p.sku) : '' };
                }).filter(function (item) { return item.value; });
            });
        });
    }

    // ── Printer picker ───────────────────────────────────────────────────────
    function populateBrands() {
        if (typeof PrinterData === 'undefined' || !PrinterData.BRAND_NAMES) return;
        Object.keys(PrinterData.BRAND_NAMES).forEach(function (slug) {
            var opt = document.createElement('option');
            opt.value = slug;
            opt.textContent = PrinterData.BRAND_NAMES[slug];
            els.printerBrand.appendChild(opt);
        });
    }

    // One fetch per brand, then filter client-side while typing — zero
    // rate-limit pressure (mirrors Ink Finder's data source).
    function loadPrinterModels(slug) {
        if (printerCache[slug]) return Promise.resolve(printerCache[slug]);
        if (typeof API === 'undefined' || typeof API.getPrintersByBrand !== 'function') return Promise.resolve([]);
        return API.getPrintersByBrand(slug).then(function (res) {
            var models = [];
            var data = (res && res.ok && res.data) ? res.data : {};
            (data.series_groups || []).forEach(function (group) {
                (group.models || []).forEach(function (m) {
                    if (m && m.model_name) models.push(m.model_name);
                });
            });
            printerCache[slug] = models;
            return models;
        }).catch(function () { return []; });
    }

    function fetchPrinterItems(q) {
        var slug = els.printerBrand.value;
        if (!slug) return Promise.resolve([]);
        var needle = q.toLowerCase();
        return loadPrinterModels(slug).then(function (models) {
            return models.filter(function (m) { return m.toLowerCase().indexOf(needle) !== -1; })
                .slice(0, 8)
                .map(function (m) { return { value: m, label: m }; });
        });
    }

    function addPrinter() {
        var model = els.printerModel.value.trim();
        if (!model) { setFieldError(els.printerModel, 'Type a model first — e.g. HL-L2350DW.'); return; }
        setFieldError(els.printerModel, '');
        var slug = els.printerBrand.value;
        var brand = (slug && typeof PrinterData !== 'undefined' && PrinterData.BRAND_NAMES && PrinterData.BRAND_NAMES[slug]) || '';
        state.printers.push({ brand: brand, model: model });
        els.printerModel.value = '';
        renderPrinterChips();
        announce('Printer added: ' + (brand ? brand + ' ' : '') + model);
        saveDraft();
    }

    function renderPrinterChips() {
        els.printerList.textContent = '';
        state.printers.forEach(function (p, i) {
            var li = document.createElement('li');
            li.className = 'quote-chip';
            var text = (p.brand ? p.brand + ' ' : '') + p.model;
            li.appendChild(document.createTextNode(text));
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quote-chip__remove';
            btn.setAttribute('aria-label', 'Remove ' + text);
            btn.textContent = '×';
            btn.addEventListener('click', function () {
                state.printers.splice(i, 1);
                renderPrinterChips();
                announce('Printer removed.');
                saveDraft();
            });
            li.appendChild(btn);
            els.printerList.appendChild(li);
        });
    }

    // ── Uploads (private Supabase Storage bucket, write-only for anon) ──────
    function getSb() {
        return (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
    }

    function sanitizeName(name) {
        var base = String(name || 'file').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        return base.slice(0, 60) || 'file';
    }

    function makeUuid() {
        try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (_) { /* fall through */ }
        var buf = new Uint32Array(4);
        try { crypto.getRandomValues(buf); } catch (_) { for (var i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 4294967296); }
        return Array.prototype.map.call(buf, function (n) { return n.toString(16); }).join('-');
    }

    function fileAllowed(file) {
        if (file.size > MAX_FILE_BYTES) return 'Too large — files must be under 10 MB.';
        if (ALLOWED_MIME[file.type]) return null;
        if (!file.type && ALLOWED_EXT_FALLBACK.test(file.name || '')) return null;
        return 'Unsupported type — use JPG, PNG, WebP, PDF, CSV, or XLSX.';
    }

    function handleFiles(fileList) {
        markStarted();
        var files = Array.prototype.slice.call(fileList || []);
        files.forEach(function (file) {
            if (state.uploads.length >= MAX_FILES) {
                announce('File limit reached (' + MAX_FILES + ').');
                return;
            }
            var problem = fileAllowed(file);
            var entry = {
                id: 'qfile-' + (++fileSeq),
                name: file.name || 'photo',
                size: file.size || 0,
                path: null,
                status: problem ? 'error' : 'uploading',
                error: problem || null,
                file: problem ? null : file,
            };
            state.uploads.push(entry);
            if (!problem) uploadEntry(entry);
        });
        renderFileList();
    }

    function uploadEntry(entry) {
        var sb = getSb();
        if (!sb) {
            entry.status = 'error';
            entry.error = 'Uploads unavailable right now — describe your products instead.';
            renderFileList();
            return;
        }
        var now = new Date();
        var yyyymm = now.getFullYear() + ('0' + (now.getMonth() + 1)).slice(-2);
        entry.path = yyyymm + '/' + makeUuid() + '-' + sanitizeName(entry.name);
        sb.storage.from(BUCKET).upload(entry.path, entry.file, { contentType: entry.file.type || undefined })
            .then(function (res) {
                if (res && res.error) throw res.error;
                entry.status = 'done';
                entry.file = null;
                announce('Upload finished: ' + entry.name);
                track('quote_file_uploaded', { files: 1 });
            })
            .catch(function () {
                entry.status = 'error';
                entry.error = 'Upload failed — check your connection and retry.';
                announce('Upload failed: ' + entry.name);
            })
            .then(function () {
                renderFileList();
                saveDraft();
            });
    }

    function renderFileList() {
        els.fileList.textContent = '';
        state.uploads.forEach(function (u) {
            var li = document.createElement('li');
            li.className = 'quote-file' + (u.status === 'error' ? ' quote-file--error' : '');

            var name = document.createElement('span');
            name.className = 'quote-file__name';
            name.textContent = u.name;
            li.appendChild(name);

            var meta = document.createElement('span');
            meta.className = 'quote-file__meta';
            if (u.status === 'uploading') {
                var spin = document.createElement('span');
                spin.className = 'quote-file__spinner';
                spin.setAttribute('aria-hidden', 'true');
                meta.appendChild(spin);
                meta.appendChild(document.createTextNode(' Uploading…'));
            } else if (u.status === 'error') {
                meta.textContent = u.error || 'Failed';
            } else {
                meta.textContent = formatSize(u.size);
            }
            li.appendChild(meta);

            var actions = document.createElement('span');
            if (u.status === 'error' && u.file) {
                var retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'quote-file__retry';
                retry.textContent = 'Retry';
                retry.setAttribute('aria-label', 'Retry uploading ' + u.name);
                retry.addEventListener('click', function () {
                    u.status = 'uploading';
                    u.error = null;
                    renderFileList();
                    uploadEntry(u);
                });
                actions.appendChild(retry);
                actions.appendChild(document.createTextNode(' '));
            }
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'quote-file__remove';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', 'Remove ' + u.name);
            remove.addEventListener('click', function () {
                // Anon has no DELETE on the bucket — removal drops the file
                // from THIS request only (orphan cleanup is an owner task,
                // documented in sql/quote_uploads.sql).
                state.uploads = state.uploads.filter(function (x) { return x.id !== u.id; });
                renderFileList();
                announce('File removed: ' + u.name);
                saveDraft();
            });
            actions.appendChild(remove);
            li.appendChild(actions);

            els.fileList.appendChild(li);
        });
    }

    function doneUploads() {
        return state.uploads.filter(function (u) { return u.status === 'done'; });
    }

    function uploadsInFlight() {
        return state.uploads.some(function (u) { return u.status === 'uploading'; });
    }

    // ── Signed-in prefill (draft restored FIRST so auth never overwrites) ───
    function prefill() {
        if (typeof Auth === 'undefined' || !Auth.readyPromise) return;
        Auth.readyPromise.then(function () {
            if (!Auth.isAuthenticated || !Auth.isAuthenticated()) return;
            var user = (typeof Auth.getUser === 'function') ? Auth.getUser() : null;
            var meta = (user && user.user_metadata) || {};
            fillIfEmpty('name', meta.full_name);
            fillIfEmpty('email', user && user.email);
            fillIfEmpty('phone', meta.phone);
            if (typeof API === 'undefined' || typeof API.getProfile !== 'function') return;
            return API.getProfile().then(function (res) {
                if (!res || !res.ok || !res.data) return;
                var p = res.data;
                var full = [p.first_name, p.last_name].filter(Boolean).join(' ');
                fillIfEmpty('name', full);
                fillIfEmpty('email', p.email);
                fillIfEmpty('phone', p.phone);
            });
        }).catch(function () { /* prefill is best-effort */ });
    }

    function fillIfEmpty(name, value) {
        if (!value) return;
        var el = els.form.querySelector('[name="' + name + '"]');
        if (el && !el.value) el.value = value;
    }

    // ── Campaign source (allowlisted — raw params are never echoed) ─────────
    function readSource() {
        try {
            var params = new URLSearchParams(window.location.search);
            var raw = params.get('utm_source') || '';
            state.source = SOURCE_ALLOWLIST[raw] || null;
            if (raw === 'business-card') {
                var note = document.getElementById('quote-card-note');
                if (note) note.hidden = false;
            }
        } catch (_) { /* ignore */ }
    }

    // ── Stage router ─────────────────────────────────────────────────────────
    function goToStage(n, opts) {
        state.stage = n;
        els.stage1.hidden = n !== 1;
        els.stage2.hidden = n !== 2;
        var steps = els.steps.querySelectorAll('.quote-steps__step');
        Array.prototype.forEach.call(steps, function (step) {
            var num = parseInt(step.getAttribute('data-step'), 10);
            if (num === n) step.setAttribute('aria-current', 'step');
            else step.removeAttribute('aria-current');
            step.classList.toggle('quote-steps__step--done', num < n);
        });
        if (n === 2) {
            renderSummary();
            ensureTurnstile();
        }
        if (!opts || opts.focus !== false) {
            var heading = (n === 1) ? els.stage1Heading : els.stage2Heading;
            if (heading) heading.focus();
            try {
                els.card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
            } catch (_) { /* ignore */ }
        }
        saveDraft();
    }

    // ── Stage-1 recap shown on stage 2 ───────────────────────────────────────
    function renderSummary() {
        var list = els.summaryList;
        list.textContent = '';
        var lines = [];

        var files = doneUploads();
        if (files.length) {
            lines.push(files.length + ' file' + (files.length === 1 ? '' : 's') + ' uploaded: '
                + files.map(function (u) { return u.name; }).join(', '));
        }
        state.rows.forEach(function (r) {
            if (r.code && String(r.code).trim()) {
                lines.push((r.qty || 1) + ' × ' + r.code.trim() + ' (' + (PREF_LABELS[r.pref] || r.pref) + ')');
            }
        });
        if (state.printers.length) {
            lines.push('Printers: ' + state.printers.map(function (p) {
                return (p.brand ? p.brand + ' ' : '') + p.model;
            }).join(', '));
        }
        var paste = val(els.form, 'pasted_list').trim();
        if (paste) lines.push('Pasted list (' + paste.split('\n').length + ' lines)');
        var help = val(els.form, 'help_text').trim();
        if (help) lines.push('Help request: ' + (help.length > 80 ? help.slice(0, 80) + '…' : help));

        lines.forEach(function (text) {
            var li = document.createElement('li');
            li.textContent = text;
            list.appendChild(li);
        });
        els.summary.hidden = lines.length === 0;
    }

    // ── Validation ───────────────────────────────────────────────────────────
    function showErrorSummary(el, messages) {
        el.textContent = '';
        var intro = document.createElement('p');
        intro.textContent = messages.length === 1 ? 'One thing needs fixing:' : 'A few things need fixing:';
        intro.style.margin = '0';
        el.appendChild(intro);
        var ul = document.createElement('ul');
        messages.forEach(function (m) {
            var li = document.createElement('li');
            if (m.focusEl) {
                var a = document.createElement('a');
                a.href = '#';
                a.textContent = m.text;
                a.addEventListener('click', function (e) {
                    e.preventDefault();
                    m.focusEl.focus();
                });
                li.appendChild(a);
            } else {
                li.textContent = m.text;
            }
            ul.appendChild(li);
        });
        el.appendChild(ul);
        el.hidden = false;
        el.setAttribute('tabindex', '-1');
        el.focus();
    }

    function clearErrorSummary(el) {
        el.hidden = true;
        el.textContent = '';
    }

    function validateStage1() {
        var errors = [];
        clearErrorSummary(els.errorSummary1);

        var hasRows = state.rows.some(function (r) { return r.code && String(r.code).trim(); });
        var paste = val(els.form, 'pasted_list').trim();
        var help = val(els.form, 'help_text').trim();
        var hasContent = doneUploads().length > 0 || hasRows || paste.length >= 3 || help.length >= 3;

        if (uploadsInFlight()) {
            errors.push({ text: 'Wait for your uploads to finish (or remove them) before continuing.' });
        }
        if (!hasContent) {
            errors.push({ text: 'Tell us at least one thing you need — a photo, a product, a printer model, or a pasted list.' });
        }
        // Per-row quantity sanity for rows that carry a code.
        state.rows.forEach(function (r) {
            if (!r.code || !String(r.code).trim()) return;
            var qty = parseInt(r.qty, 10);
            if (!(qty >= 1)) {
                var input = document.getElementById(r.id + '-qty');
                if (input) setFieldError(input, 'Enter a quantity of at least 1.');
                errors.push({ text: 'Enter a quantity of at least 1 for ' + r.code.trim() + '.', focusEl: input });
            }
        });

        if (errors.length) {
            showErrorSummary(els.errorSummary1, errors);
            return false;
        }
        return true;
    }

    function validateStage2() {
        var errors = [];
        clearErrorSummary(els.errorSummary2);

        var nameInput = els.form.querySelector('[name="name"]');
        var businessInput = els.form.querySelector('[name="business_name"]');
        var emailInput = els.form.querySelector('[name="email"]');
        [nameInput, businessInput, emailInput].forEach(function (el) { setFieldError(el, ''); });

        if (!val(els.form, 'name').trim()) {
            setFieldError(nameInput, 'Please enter your name.');
            errors.push({ text: 'Please enter your name.', focusEl: nameInput });
        }
        if (!val(els.form, 'business_name').trim()) {
            setFieldError(businessInput, 'Please enter your business name.');
            errors.push({ text: 'Please enter your business name.', focusEl: businessInput });
        }
        var email = val(els.form, 'email').trim();
        if (!email || !isValidEmail(email)) {
            setFieldError(emailInput, 'Please enter a valid email address.');
            errors.push({ text: 'Please enter a valid email address.', focusEl: emailInput });
        }
        var postcode = val(els.form, 'delivery_postcode').trim();
        if (postcode && !/^\d{4}$/.test(postcode)) {
            var pcInput = els.form.querySelector('[name="delivery_postcode"]');
            setFieldError(pcInput, 'NZ postcodes are 4 digits.');
            errors.push({ text: 'NZ postcodes are 4 digits.', focusEl: pcInput });
        }
        if (uploadsInFlight()) {
            errors.push({ text: 'Wait for your uploads to finish (or remove them) before sending.' });
        }

        if (errors.length) {
            showErrorSummary(els.errorSummary2, errors);
            track('quote_validation_failed', { stage: 2 });
            return false;
        }
        return true;
    }

    // ── Message body (plain text — the support inbox is the reader) ─────────
    // Escaping is unnecessary: /api/contact `message` is treated as text.
    function composeMessage() {
        var f = els.form;
        var lines = ['Trade quote request via /quote'];
        lines.push('Reference: ' + state.ref);
        if (state.source) lines.push('Source: ' + state.source);
        lines.push('');
        lines.push('Business: ' + val(f, 'business_name').trim());
        lines.push('Contact: ' + val(f, 'name').trim());
        lines.push('Email: ' + val(f, 'email').trim());
        var phone = val(f, 'phone').trim();
        if (phone) lines.push('Phone: ' + phone);
        var preferred = val(f, 'preferred_contact');
        if (preferred) lines.push('Preferred contact: ' + preferred);

        var rows = state.rows.filter(function (r) { return r.code && String(r.code).trim(); });
        if (rows.length) {
            lines.push('');
            lines.push('Products & quantities:');
            rows.forEach(function (r) {
                var qty = parseInt(r.qty, 10) || 1;
                var line = '- ' + qty + 'x ' + r.code.trim() + ' — ' + (PREF_LABELS[r.pref] || r.pref);
                if (r.notes && r.notes.trim()) line += ' — ' + r.notes.trim();
                lines.push(line);
            });
        }

        if (state.printers.length) {
            lines.push('');
            lines.push('Printer models:');
            state.printers.forEach(function (p) {
                lines.push('- ' + (p.brand ? p.brand + ' ' : '') + p.model);
            });
        }

        var paste = val(f, 'pasted_list').trim();
        if (paste) {
            lines.push('');
            lines.push('Pasted product list:');
            lines.push(paste);
        }

        var help = val(f, 'help_text').trim();
        if (help) {
            lines.push('');
            lines.push('Customer needs help identifying:');
            lines.push(help);
        }

        var files = doneUploads();
        if (files.length) {
            lines.push('');
            lines.push('Uploaded files (Supabase bucket quote-uploads):');
            files.forEach(function (u) {
                lines.push('- ' + u.path + ' (' + u.name + ', ' + formatSize(u.size) + ')');
            });
        }

        var details = [];
        var nzbn = val(f, 'nzbn').trim();
        if (nzbn) details.push('NZBN: ' + nzbn);
        var account = val(f, 'account_no').trim();
        if (account) details.push('Account no: ' + account);
        var po = val(f, 'po_required');
        if (po) details.push('PO required: ' + po);
        var freq = val(f, 'order_frequency');
        if (freq) details.push('Order frequency: ' + freq);
        var urgency = val(f, 'urgency');
        if (urgency) details.push('Urgency: ' + urgency);
        if (details.length) {
            lines.push('');
            lines.push('Business details:');
            details.forEach(function (d) { lines.push(d); });
        }

        var suburb = val(f, 'delivery_suburb').trim();
        var city = val(f, 'delivery_city').trim();
        var postcode = val(f, 'delivery_postcode').trim();
        var deliveryBits = [suburb, city, postcode].filter(Boolean).join(', ');
        var requiredBy = val(f, 'required_by');
        if (deliveryBits || requiredBy) {
            lines.push('');
            if (deliveryBits) lines.push('Delivery: ' + deliveryBits);
            if (requiredBy) lines.push('Required by: ' + requiredBy);
        }

        return lines.join('\n');
    }

    // ── Turnstile (deferred to Stage 2; visible error + retry) ──────────────
    var turnstileCtl = null;

    function ensureTurnstile() {
        if (turnstileCtl) return turnstileCtl;
        turnstileCtl = initTurnstile();
        return turnstileCtl;
    }

    function initTurnstile() {
        var siteKey = (typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY) || '';
        var holder = document.getElementById('quote-turnstile');
        if (!siteKey || !holder) return { getToken: function () { return null; }, reset: function () {} };

        var widgetId = null;
        var lastToken = null;
        var errorEl = document.getElementById('quote-turnstile-error');
        var retryBtn = document.getElementById('quote-turnstile-retry');

        function showError() { if (errorEl) errorEl.hidden = false; }
        function hideError() { if (errorEl) errorEl.hidden = true; }

        function render() {
            if (typeof window.turnstile === 'undefined') return;
            if (widgetId !== null) return;
            try {
                widgetId = window.turnstile.render('#quote-turnstile', {
                    // Compact on small phones — the 300px normal widget propped
                    // the card past the viewport (text-fit audit Jul 2026;
                    // mirrors contact-page.js).
                    size: window.matchMedia('(max-width: 400px)').matches ? 'compact' : 'normal',
                    sitekey: siteKey,
                    callback: function (token) { lastToken = token; hideError(); },
                    'expired-callback': function () { lastToken = null; },
                    // A failed load (offline, or localhost missing from the
                    // widget's hostname allowlist) is VISIBLE now — the silent
                    // null token made the form look broken (ERR-093).
                    'error-callback': function () { lastToken = null; showError(); },
                });
            } catch (_) { /* render can throw if API loads twice — non-fatal */ }
        }

        if (retryBtn) {
            retryBtn.addEventListener('click', function () {
                hideError();
                lastToken = null;
                if (widgetId !== null && typeof window.turnstile !== 'undefined') {
                    try { window.turnstile.reset(widgetId); } catch (_) { /* ignore */ }
                } else {
                    render();
                }
            });
        }

        // Turnstile script may load after this runs; poll briefly.
        var tries = 0;
        var poll = setInterval(function () {
            if (typeof window.turnstile !== 'undefined') {
                clearInterval(poll);
                render();
            } else if (++tries > 40) { // ~10s
                clearInterval(poll);
                showError();
            }
        }, 250);

        return {
            getToken: function () { return lastToken; },
            reset: function () {
                lastToken = null;
                if (widgetId !== null && typeof window.turnstile !== 'undefined') {
                    try { window.turnstile.reset(widgetId); } catch (_) { /* ignore */ }
                }
            },
        };
    }

    // ── Submit ───────────────────────────────────────────────────────────────
    function submit() {
        var resultEl = els.result;
        if (resultEl) { resultEl.hidden = true; resultEl.textContent = ''; resultEl.className = 'contact-form__result'; }

        var honeypot = val(els.form, 'website');
        // Bot honeypot — silently succeed. Don't reveal the trap.
        if (honeypot) {
            showResult(resultEl, 'success', "Thanks — we'll email your quote within one business day.");
            els.form.reset();
            if (turnstileCtl) turnstileCtl.reset();
            return;
        }

        if (!validateStage2()) return;

        var ts = ensureTurnstile();
        var token = ts.getToken();
        if (!token) {
            showResult(resultEl, 'error', 'Please complete the CAPTCHA before sending.');
            return;
        }

        var name = val(els.form, 'name').trim();
        var phone = val(els.form, 'phone').trim();
        var payload = {
            name: name,
            email: val(els.form, 'email').trim(),
            subject: 'Trade quote request',
            message: composeMessage(),
            turnstile_token: token,
        };
        if (phone) payload.phone = phone;

        var submitBtn = els.submitBtn;
        var originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';

        send(payload).then(function () {
            showSuccess();
            track('quote_submitted');
        }).catch(function (err) {
            ts.reset();
            var msg = (err && err.message) ? err.message : 'Something went wrong. Please try again, or call 027 474 0115.';
            showResult(resultEl, 'error', msg);
            track('quote_submission_failed');
        }).then(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        });
    }

    function showSuccess() {
        clearDraft();
        els.form.hidden = true;
        els.steps.hidden = true;
        els.successRef.textContent = 'Reference: ' + state.ref;
        els.success.hidden = false;
        var title = els.success.querySelector('.quote-success__title');
        if (title) {
            title.setAttribute('tabindex', '-1');
            title.focus();
        }
        try {
            els.card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        } catch (_) { /* ignore */ }
    }

    function resetForAnother() {
        state.ref = makeRef();
        state.rows = [];
        state.printers = [];
        state.uploads = [];
        els.rows.textContent = '';
        renderPrinterChips();
        renderFileList();
        els.form.reset();
        METHODS.forEach(function (m) { setMethod(m, false, { silent: true }); });
        if (els.result) { els.result.hidden = true; els.result.textContent = ''; }
        els.success.hidden = true;
        els.form.hidden = false;
        els.steps.hidden = false;
        if (turnstileCtl) turnstileCtl.reset();
        goToStage(1);
    }

    function send(payload) {
        // Prefer the API helper for envelope handling; fall back to direct fetch
        // when the helper hasn't loaded (defensive — api.js is in the page deps).
        if (typeof API !== 'undefined' && typeof API.submitContactForm === 'function') {
            return API.submitContactForm(payload).then(function (res) {
                if (res && res.ok) return res;
                // 5xx now returns a structured envelope (api.js); route through mapError
                // so the user sees "Server hiccup — please try again. … reference XXXXXXXX."
                if (res && (res.code === 'INTERNAL_ERROR' || (typeof res.status === 'number' && res.status >= 500))) {
                    if (res.request_id && typeof DebugLog !== 'undefined') DebugLog.warn('[quote] submit failed', { code: res.code, request_id: res.request_id });
                    var mapped = (typeof API.mapError === 'function') ? API.mapError(res) : null;
                    throw new Error((mapped && mapped.message) || 'Server hiccup — please try again, or call 027 474 0115.');
                }
                var msg = (res && res.error && res.error.message) || (res && res.error) || 'Could not send your request.';
                throw new Error(typeof msg === 'string' ? msg : 'Could not send your request.');
            });
        }
        var base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
        var url = base ? (base + '/api/contact') : '/api/contact';
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(function (r) {
            var rid = r.headers.get('x-request-id');
            return r.json().then(function (data) {
                if (r.ok && data && data.ok) return data;
                var msg = (data && data.error && data.error.message) || (data && data.error) || 'Could not send your request.';
                if (r.status >= 500) {
                    if (rid && typeof DebugLog !== 'undefined') DebugLog.warn('[quote] submit failed', { status: r.status, request_id: rid });
                    var ref = rid ? ' (ref ' + String(rid).slice(0, 8) + ')' : '';
                    throw new Error('Server hiccup — please try again, or call 027 474 0115.' + ref);
                }
                throw new Error(typeof msg === 'string' ? msg : 'Could not send your request.');
            });
        });
    }

    // ── Support aside: always open on ≥tablet, collapsible on phones ────────
    function wireSupportPanel() {
        var support = document.getElementById('quote-support');
        if (!support) return;
        var bp = (typeof Config !== 'undefined' && Config.BREAKPOINTS && Config.BREAKPOINTS.tablet) || 768;
        var mq = window.matchMedia('(min-width: ' + bp + 'px)');
        function apply() { if (mq.matches) support.open = true; }
        apply();
        if (mq.addEventListener) mq.addEventListener('change', apply);
        else if (mq.addListener) mq.addListener(apply);
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        var form = document.getElementById('quote-form');
        if (!form) return;

        els = {
            form: form,
            card: document.querySelector('.quote-card') || form,
            steps: document.getElementById('quote-steps'),
            stage1: document.getElementById('quote-stage-1'),
            stage2: document.getElementById('quote-stage-2'),
            stage1Heading: document.getElementById('quote-stage1-heading'),
            stage2Heading: document.getElementById('quote-stage2-heading'),
            errorSummary1: document.getElementById('quote-error-summary-1'),
            errorSummary2: document.getElementById('quote-error-summary-2'),
            rows: document.getElementById('quote-rows'),
            rowTemplate: document.getElementById('quote-row-template'),
            fileList: document.getElementById('quote-file-list'),
            printerBrand: document.getElementById('quote-printer-brand'),
            printerModel: document.getElementById('quote-printer-model'),
            printerList: document.getElementById('quote-printer-list'),
            summary: document.getElementById('quote-summary'),
            summaryList: document.getElementById('quote-summary-list'),
            result: document.getElementById('quote-result'),
            submitBtn: document.getElementById('quote-submit'),
            success: document.getElementById('quote-success'),
            successRef: document.getElementById('quote-success-ref'),
        };

        saveDraftDebounced = (typeof Utils !== 'undefined' && Utils.debounce)
            ? Utils.debounce(saveDraft, 400)
            : saveDraft;

        // Screen-reader announcement region for row/file/chip changes.
        els.live = document.createElement('div');
        els.live.className = 'visually-hidden';
        els.live.setAttribute('aria-live', 'polite');
        els.card.appendChild(els.live);

        state.ref = makeRef();
        readSource();
        populateBrands();
        wireMethods();
        wireSupportPanel();

        // Stage navigation.
        document.getElementById('quote-next').addEventListener('click', function () {
            if (!validateStage1()) return;
            track('quote_stage_completed', { stage: 1 });
            goToStage(2);
        });
        document.getElementById('quote-back').addEventListener('click', function () { goToStage(1); });
        document.getElementById('quote-edit-stage1').addEventListener('click', function () { goToStage(1); });

        // Rows.
        document.getElementById('quote-add-row').addEventListener('click', function () {
            var row = addRow();
            if (row) {
                var input = row.querySelector('[data-row-input="code"]');
                if (input) input.focus();
            }
        });

        // Uploads.
        var camera = document.getElementById('quote-file-camera');
        var picker = document.getElementById('quote-file-picker');
        document.getElementById('quote-take-photo').addEventListener('click', function () { camera.click(); });
        document.getElementById('quote-choose-files').addEventListener('click', function () { picker.click(); });
        camera.addEventListener('change', function () { handleFiles(camera.files); camera.value = ''; });
        picker.addEventListener('change', function () { handleFiles(picker.files); picker.value = ''; });

        // Printers.
        document.getElementById('quote-add-printer').addEventListener('click', addPrinter);
        attachCombobox(els.printerModel, {
            fetchItems: fetchPrinterItems,
            onSelect: function (item) {
                els.printerModel.value = item.value;
                addPrinter();
            },
        });
        els.printerModel.addEventListener('keydown', function (e) {
            // Enter with no active option = add what's typed (never submit).
            if (e.key === 'Enter') {
                e.preventDefault();
                if (els.printerModel.getAttribute('aria-activedescendant')) return; // combobox handles it
                addPrinter();
            }
        });
        els.printerBrand.addEventListener('change', function () {
            markStarted();
            var slug = els.printerBrand.value;
            if (slug) loadPrinterModels(slug); // warm the cache
        });

        // Draft autosave + funnel start on any interaction.
        form.addEventListener('input', function () {
            markStarted();
            saveDraftDebounced();
        });

        document.getElementById('quote-again').addEventListener('click', resetForAnother);

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            submit();
        });

        // Draft first, then auth prefill — prefill only fills EMPTY fields, so
        // a restored draft (and any user edits) always wins.
        restoreDraft();
        prefill();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
