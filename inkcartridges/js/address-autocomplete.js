/**
 * Shared NZ address autocomplete (ERR-096, Jul 2026)
 * ===================================================
 * One implementation for every structured address form (checkout + account
 * addresses modal). Extracted from checkout-page.js so the two pages can't
 * drift — the checkout copy had an Enter-key crash (nonexistent
 * `fillFromDetails`) and per-keystroke request amplification that burned the
 * shared per-IP rate budget while both providers were down.
 *
 * Backend contract (ADDRESS_AUTOCOMPLETE_HANDOFF.md):
 *   GET /api/address/nzpost/suggest?q=&max=   → { ok, data: [{ dpid, full_address }] }
 *   GET /api/address/nzpost/details?dpid=     → { ok, data: { address_line1, ... } }
 *   GET /api/address/autocomplete?q=          → { ok, data: [{ place_id, description }] }
 *   GET /api/address/details?place_id=        → { ok, data: { address_line1, address_line2, city, region, postal_code } }
 * Both providers share a 30 req/min/IP limiter (429 → RATE_LIMITED) that also
 * draws from the global per-IP budget covering account writes, so this module
 * is deliberately frugal:
 *   - 300ms debounce, min 2 chars (handoff advises ≥300ms)
 *   - session cache per query (including empty results)
 *   - stale-response guard — only the latest in-flight lookup may render
 *   - NZ Post circuit breaker — one 5xx ("not configured") disables it for the session
 *   - RATE_LIMITED backoff shared across ALL attached inputs (same server budget)
 *   - suggestion GETs use { noRetry: true } (api.js) — a replayed suggestion is
 *     stale by the time it lands, and each retry burns budget the user needs
 *     for their actual save
 *
 * Fail-soft must be LOUD (project rule): when suggestions are paused or both
 * providers fail, a visible hint tells the user to type manually — degraded
 * autocomplete must never read as "nothing happened". Manual entry always works.
 */

const AddressAutocomplete = {
    // Monotonic token — a debounced lookup only renders if it is still the
    // newest one when its network round-trip resolves (stale-response guard).
    _seq: 0,

    // Session cache: query → mapped suggestions array (empty arrays cached too,
    // so retyping the same dead-end query costs zero requests).
    _cache: new Map(),

    // Circuit breaker: NZ Post responded 5xx ("NZ Post address service not
    // configured") — skip it for the rest of the session instead of paying a
    // doomed request per keystroke before every Google fallback.
    _nzpostDisabled: false,

    // Epoch-ms until which ALL attached inputs skip lookups after a
    // RATE_LIMITED response — the budget is per-IP, not per-field.
    _pausedUntil: 0,

    /**
     * Enhance a street-address input with an autocomplete dropdown.
     * @param {string} inputId - id of the address line 1 input
     * @param {object} fieldMap - element ids: { line1, line2, city, region, postcode }
     * @param {object} [opts]
     * @param {function} [opts.onApply] - called with the details payload after fields fill (e.g. checkout shipping-cost refresh)
     * @param {number} [opts.debounceMs=300]
     * @param {number} [opts.minChars=2]
     */
    attach(inputId, fieldMap, opts = {}) {
        const input = document.getElementById(inputId);
        if (!input || input.dataset.autocompleteAttached === 'true') return;
        input.dataset.autocompleteAttached = 'true';

        const debounceMs = opts.debounceMs || 300;
        const minChars = opts.minChars || 2;

        // Dropdown + wrapper
        const dropdown = document.createElement('ul');
        dropdown.className = 'address-autocomplete__dropdown';
        dropdown.setAttribute('role', 'listbox');
        dropdown.setAttribute('aria-label', 'Address suggestions');
        dropdown.hidden = true;

        // Loud fail-soft hint — visible whenever suggestions are degraded.
        const hint = document.createElement('div');
        hint.className = 'address-autocomplete__hint';
        hint.setAttribute('aria-live', 'polite');
        hint.hidden = true;

        const wrapper = document.createElement('div');
        wrapper.className = 'address-autocomplete__wrapper';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);
        wrapper.appendChild(dropdown);
        wrapper.appendChild(hint);

        let debounceTimer = null;
        let currentSuggestions = [];

        const showHint = (message) => {
            hint.textContent = message;
            hint.hidden = false;
        };
        const hideHint = () => {
            hint.hidden = true;
            hint.textContent = '';
        };

        const hideSuggestions = () => {
            dropdown.hidden = true;
            dropdown.innerHTML = '';
            currentSuggestions = [];
        };

        // Fill address fields from a details response (shared by both providers)
        const applyAddressDetails = (d) => {
            const setField = (id, value) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.value = value || '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };

            setField(fieldMap.line1, d.address_line1);
            setField(fieldMap.line2, d.address_line2);
            setField(fieldMap.city, d.city);
            setField(fieldMap.postcode, d.postal_code);

            if (fieldMap.region && d.region) {
                const regionEl = document.getElementById(fieldMap.region);
                if (regionEl) this._applyRegion(regionEl, d.region);
            }

            if (typeof opts.onApply === 'function') opts.onApply(d);
        };

        // A RATE_LIMITED result (thrown error from api.js OR resolved envelope)
        // pauses lookups module-wide and says so. Returns true if handled.
        const handleRateLimit = (errOrEnv) => {
            const code = errOrEnv && errOrEnv.code;
            if (code !== 'RATE_LIMITED') return false;
            const seconds = errOrEnv.retryAfter || errOrEnv.retry_after || 30;
            AddressAutocomplete._pausedUntil = Date.now() + seconds * 1000;
            hideSuggestions();
            showHint('Address suggestions are paused — please type your address manually.');
            return true;
        };

        // Resolve a selected suggestion into structured fields. Failure here is
        // shown, not swallowed — the user just picked a suggestion, so silence
        // would read as "it worked" while the fields stay empty.
        const fillFromSelection = async (suggestion) => {
            try {
                const res = suggestion.provider === 'nzpost'
                    ? await API.nzpostDetails(suggestion.id)
                    : await API.addressDetails(suggestion.id);
                if (res && res.ok && res.data) {
                    applyAddressDetails(res.data);
                    hideHint();
                    return;
                }
                if (handleRateLimit(res)) return;
                showHint('Couldn’t fill the address automatically — please complete the fields manually.');
            } catch (e) {
                if (handleRateLimit(e)) return;
                showHint('Couldn’t fill the address automatically — please complete the fields manually.');
            }
        };

        const selectSuggestion = (suggestion) => {
            input.value = suggestion.label;
            hideSuggestions();
            fillFromSelection(suggestion);
        };

        // Render suggestions in the dropdown
        const renderSuggestions = (suggestions) => {
            currentSuggestions = suggestions;
            dropdown.innerHTML = '';
            suggestions.forEach((suggestion) => {
                const li = document.createElement('li');
                li.className = 'address-autocomplete__option';
                li.setAttribute('role', 'option');
                li.setAttribute('tabindex', '-1');
                li.textContent = suggestion.label;
                li.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    selectSuggestion(suggestion);
                });
                dropdown.appendChild(li);
            });
            dropdown.hidden = false;
            hideHint();
        };

        // Fetch suggestions for a query: NZ Post first (more accurate for NZ),
        // Google Places fallback. Returns {suggestions, failed} — failed=true
        // means every attempted provider errored (vs a healthy empty result).
        const fetchSuggestions = async (q) => {
            let suggestions = [];
            let nzpostFailed = false;
            let googleFailed = false;

            if (!AddressAutocomplete._nzpostDisabled) {
                try {
                    const nzRes = await API.nzpostSuggest(q);
                    if (nzRes && nzRes.ok && nzRes.data?.length) {
                        suggestions = nzRes.data.map(s => ({
                            id: s.dpid,
                            label: s.full_address || s.description,
                            provider: 'nzpost'
                        }));
                    } else if (nzRes && nzRes.ok === false) {
                        if (handleRateLimit(nzRes)) return { suggestions: [], failed: true, rateLimited: true };
                        nzpostFailed = true;
                        // 5xx = service not configured/down — stop paying for it this session
                        if (nzRes.code === 'INTERNAL_ERROR' || (nzRes.status && nzRes.status >= 500)) {
                            AddressAutocomplete._nzpostDisabled = true;
                            DebugLog.warn('AddressAutocomplete: NZ Post suggest unavailable — disabled for this session');
                        }
                    }
                } catch (e) {
                    if (handleRateLimit(e)) return { suggestions: [], failed: true, rateLimited: true };
                    nzpostFailed = true;
                }
            } else {
                nzpostFailed = true;
            }

            if (!suggestions.length) {
                try {
                    const res = await API.addressAutocomplete(q);
                    if (res && res.ok && res.data?.length) {
                        suggestions = res.data.map(s => ({
                            id: s.place_id,
                            label: s.description,
                            provider: 'google'
                        }));
                    } else if (res && res.ok === false) {
                        if (handleRateLimit(res)) return { suggestions: [], failed: true, rateLimited: true };
                        googleFailed = true;
                    }
                } catch (e) {
                    if (handleRateLimit(e)) return { suggestions: [], failed: true, rateLimited: true };
                    googleFailed = true;
                }
            }

            return { suggestions, failed: nzpostFailed && googleFailed && !suggestions.length };
        };

        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const q = input.value.trim();
            if (q.length < minChars) {
                hideSuggestions();
                hideHint();
                return;
            }

            debounceTimer = setTimeout(async () => {
                // Backoff window from an earlier RATE_LIMITED — no request at all.
                if (Date.now() < AddressAutocomplete._pausedUntil) {
                    hideSuggestions();
                    showHint('Address suggestions are paused — please type your address manually.');
                    return;
                }

                // Session cache — retyping a seen query costs zero requests.
                if (AddressAutocomplete._cache.has(q)) {
                    const cached = AddressAutocomplete._cache.get(q);
                    if (cached.length) renderSuggestions(cached);
                    else { hideSuggestions(); hideHint(); }
                    return;
                }

                const mySeq = ++AddressAutocomplete._seq;
                const result = await fetchSuggestions(q);

                // Stale-response guard — a newer lookup superseded this one.
                if (mySeq !== AddressAutocomplete._seq) return;
                if (result.rateLimited) return; // hint already shown, don't cache

                AddressAutocomplete._cache.set(q, result.suggestions);

                if (result.suggestions.length) {
                    renderSuggestions(result.suggestions);
                } else {
                    hideSuggestions();
                    if (result.failed) {
                        // LOUD fail-soft: both providers errored ≠ "no matches".
                        showHint('Address suggestions are unavailable right now — please type your address manually.');
                    } else {
                        hideHint();
                    }
                }
            }, debounceMs);
        });

        // Keyboard navigation
        input.addEventListener('keydown', (e) => {
            if (dropdown.hidden) return;
            const items = dropdown.querySelectorAll('.address-autocomplete__option');
            const focused = dropdown.querySelector('.address-autocomplete__option--focused');
            let idx = focused ? Array.from(items).indexOf(focused) : -1;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                focused?.classList.remove('address-autocomplete__option--focused');
                idx = (idx + 1) % items.length;
                items[idx]?.classList.add('address-autocomplete__option--focused');
                items[idx]?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                focused?.classList.remove('address-autocomplete__option--focused');
                idx = (idx - 1 + items.length) % items.length;
                items[idx]?.classList.add('address-autocomplete__option--focused');
                items[idx]?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && focused) {
                e.preventDefault();
                // Same path as mousedown — the old checkout copy called a
                // nonexistent fill helper with the wrong property names here
                // and threw a ReferenceError on every keyboard selection.
                const suggestion = currentSuggestions[Array.from(items).indexOf(focused)];
                if (suggestion) selectSuggestion(suggestion);
            } else if (e.key === 'Escape') {
                hideSuggestions();
            }
        });

        // Hide on outside click
        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) hideSuggestions();
        });

        // Hide on blur (delay allows mousedown on option to fire first)
        input.addEventListener('blur', () => {
            setTimeout(hideSuggestions, 150);
        });
    },

    /**
     * Canonical slug for a region string: lowercase, diacritics stripped
     * (ū→u), apostrophes dropped, whitespace/underscores → hyphens. Both
     * page vocabularies and both provider spellings collapse to one key:
     *   "Manawatū-Whanganui" / "Manawatu-Wanganui" → manawatu-wanganui (via alias)
     *   "Hawke's Bay" / "hawkes-bay"              → hawkes-bay
     */
    _slugifyRegion(value) {
        if (!value) return '';
        const slug = String(value)
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/['’]/g, '')
            .replace(/[\s_]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        // Historic spelling variants fold to one canonical key. The alias map
        // matters: checkout options say "manawatu-wanganui" (no h) while the
        // account modal and Google say "Manawatū-Whanganui" — raw equality
        // would leave the region select unset and block the required-field save.
        const ALIASES = {
            'manawatu-whanganui': 'manawatu-wanganui'
        };
        return ALIASES[slug] || slug;
    },

    /**
     * Apply a provider region string to a form control. For a <select> the
     * match is by canonical slug against each option's OWN value, so the same
     * normalizer serves checkout (slug values) and the account modal (display
     * names). Non-selects just get the raw string.
     */
    _applyRegion(regionEl, region) {
        if (regionEl.tagName !== 'SELECT') {
            regionEl.value = region || '';
            regionEl.dispatchEvent(new Event('input', { bubbles: true }));
            regionEl.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        const target = this._slugifyRegion(region);
        if (!target) return;
        const match = Array.from(regionEl.options)
            .find(opt => opt.value && this._slugifyRegion(opt.value) === target);
        if (match) {
            regionEl.value = match.value;
            regionEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
};

window.AddressAutocomplete = AddressAutocomplete;
