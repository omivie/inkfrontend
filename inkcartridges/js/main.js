/**
 * MAIN.JS
 * =======
 * Main JavaScript file for InkCartridges.co.nz
 *
 * This file contains:
 * - Global site initialization
 * - Navigation functionality
 * - Header interactions
 * - Common UI behaviors
 *
 * This is a structural placeholder. Full functionality
 * will be implemented when building pages in PART 3.
 */

'use strict';

/**
 * SITE INITIALIZATION
 * ===================
 */

document.addEventListener('DOMContentLoaded', function() {
    initNavigation();
    initActiveNavLink();
    initAdminHeaderLink();
    initSearch();
    initStickyHeader();
    initCurrentYear();
    initDropdowns();
    initMegaPanels();
    initCartBadgeFromStorage();
    captureGclid();
});

/**
 * Mobile sticky-header compaction (mobile-ux-audit-jul2026 §2a/§8.2).
 *
 * On mobile the whole `.site-header` is `position: sticky` (see layout.css) so
 * the search box and cart stay reachable on long PDPs/listings — the audit's
 * "search a different code" journey. Past a small scroll threshold we add
 * `.site-header--scrolled`, which collapses the tap-to-call contact chip and
 * the logo tagline so the pinned header slims toward `--header-h`. Pure
 * class-toggle; the CSS does the visual work and only inside the mobile
 * breakpoint, so desktop is untouched. Fail-soft when there's no header.
 */
function initStickyHeader() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    const THRESHOLD = 80;
    let ticking = false;
    const apply = function() {
        ticking = false;
        header.classList.toggle('site-header--scrolled', window.scrollY > THRESHOLD);
    };
    const onScroll = function() {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(apply);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    apply(); // set initial state (e.g. on a bfcache restore mid-page)
}

/**
 * Light up the nav item that matches the current URL.
 *
 * Each `.nav-menu__link` declares the path prefixes it owns via
 * `data-nav-match` (comma-separated, with "/" matching the home page only).
 * The longest matching prefix wins, so `/products/...` activates Shop rather
 * than the generic `/` home rule. This lives in JS so every page can ship
 * the same byte-identical navbar markup (see project_navbar_parity_may2026).
 */
function initActiveNavLink() {
    const links = document.querySelectorAll('.primary-nav [data-nav-match]');
    if (!links.length) return;
    const path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';

    let best = null;
    let bestLen = -1;
    links.forEach(function(link) {
        const patterns = (link.getAttribute('data-nav-match') || '').split(',');
        patterns.forEach(function(raw) {
            const pat = raw.trim();
            if (!pat) return;
            const matches = (pat === '/')
                ? path === '/'
                : (path === pat || path.startsWith(pat + '/'));
            if (matches && pat.length > bestLen) {
                best = link;
                bestLen = pat.length;
            }
        });
    });
    if (best) best.classList.add('nav-menu__link--active');
}

/**
 * Reveal the header "Admin" shortcut for verified admin accounts only.
 *
 * The Admin link is NO LONGER shipped in static page markup. It used to sit
 * `hidden` in every page's header, but that exposed `href="/admin"` in the
 * public HTML source of every customer-facing page — a Google Merchant Center
 * "site quality" flag. It is now created and inserted into `.header-actions`
 * by this function ONLY after the account is verified as admin, so guests and
 * ordinary customers never receive the element at all (Jul 2026, MC audit).
 *
 * Security model is unchanged: this is UI sugar, not an access gate. The
 * /admin route re-verifies the role server-side on every visit (middleware +
 * js/admin/auth.js), so a wrongly-shown link grants nothing. The authoritative
 * check here is `API.verifyAdmin()` (GET /api/admin/verify).
 *
 * UX: a per-session sessionStorage hint (`ink_admin_header_hint`, keyed to
 * the user id) makes the link appear instantly on subsequent page loads so
 * an admin doesn't watch it pop in after every navigation. The background
 * verify call always runs and reconciles the hint — so a revoked role, or a
 * stale hint, self-corrects within one page load.
 *
 * Guests and signed-in non-admins trigger no extra network request beyond
 * the single verify call (guests skip even that).
 */
function initAdminHeaderLink() {
    if (typeof Auth === 'undefined') return;

    var HINT_KEY = 'ink_admin_header_hint';

    // Lazily build + insert the link the first time it's needed; return the
    // existing node on subsequent calls. Kept out of static markup so the
    // /admin route is never advertised in public page source.
    function ensureLink() {
        var existing = document.getElementById('header-admin-link');
        if (existing) return existing;
        var actions = document.querySelector('.header-actions');
        if (!actions) return null;
        var a = document.createElement('a');
        a.href = '/admin';
        a.className = 'header-actions__item header-actions__item--admin';
        a.id = 'header-admin-link';
        a.setAttribute('aria-label', 'Admin');
        a.innerHTML = '<span class="header-actions__icon">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
            '</span><span>Admin</span>';
        // Insert as the first action so it sits before Account, matching the
        // previous markup order.
        actions.insertBefore(a, actions.firstElementChild);
        return a;
    }

    function removeLink() {
        var el = document.getElementById('header-admin-link');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function readHint() {
        try { return sessionStorage.getItem(HINT_KEY); } catch (e) { return null; }
    }
    function writeHint(value) {
        try {
            if (value) sessionStorage.setItem(HINT_KEY, value);
            else sessionStorage.removeItem(HINT_KEY);
        } catch (e) { /* sessionStorage unavailable (private mode) — ignore */ }
    }

    function evaluate() {
        // Wait for the Supabase session to be resolved before deciding.
        var ready = Auth.readyPromise || Promise.resolve();
        ready.then(function() {
            // Guests never see the link and never trigger a verify call.
            if (!Auth.isAuthenticated || !Auth.isAuthenticated()) {
                removeLink();
                writeHint(null);
                return;
            }

            var user = (Auth.getUser && Auth.getUser()) || {};
            var userId = user.id || user.email || '';

            // Instant-show from a verification earlier this session.
            if (userId && readHint() === userId) {
                ensureLink();
            }

            // Authoritative server-side role check.
            if (typeof API === 'undefined' || !API.verifyAdmin) return;
            API.verifyAdmin().then(function(res) {
                var isAdmin = !!(res && res.ok && res.data);
                if (isAdmin) ensureLink();
                else removeLink();
                writeHint(isAdmin && userId ? userId : null);
            }).catch(function() {
                // Backend unreachable — keep whatever the hint decided.
                // A stale hint at worst shows a link the /admin page rejects.
            });
        });
    }

    evaluate();

    // Re-evaluate on sign-in / sign-out so the link appears or disappears
    // without a page reload.
    if (typeof Auth.onAuthStateChange === 'function') {
        Auth.onAuthStateChange(function() { evaluate(); });
    }
}

/**
 * Capture Google Ads click ID (gclid) from URL and store in localStorage.
 * Expires after 90 days. Sent with checkout requests for conversion tracking.
 */
function captureGclid() {
    var params = new URLSearchParams(window.location.search);
    var gclid = params.get('gclid');
    if (gclid) {
        localStorage.setItem('gclid', gclid);
        localStorage.setItem('gclid_expiry', Date.now() + 90 * 24 * 60 * 60 * 1000);
    }
}

/**
 * Retrieve stored gclid if not expired.
 * @returns {string|null}
 */
function getGclid() {
    var expiry = localStorage.getItem('gclid_expiry');
    if (expiry && Date.now() > Number(expiry)) {
        localStorage.removeItem('gclid');
        localStorage.removeItem('gclid_expiry');
        return null;
    }
    return localStorage.getItem('gclid');
}

/**
 * Read GA4 client ID from the _ga cookie (format: GA1.1.<client_id>).
 * Sent with checkout requests so backend can attribute orders via GA4 Measurement Protocol.
 * @returns {string|null}
 */
function getGaClientId() {
    var match = document.cookie.match(/_ga=GA\d+\.\d+\.(.+?)(?:;|$)/);
    return match ? match[1] : null;
}

/**
 * Read localStorage cart count immediately to prevent badge showing "0"
 * before Cart.init() completes (which may involve async server calls).
 */
function initCartBadgeFromStorage() {
    try {
        // Fast path: read simple integer count (no JSON parsing)
        const cachedCount = localStorage.getItem('cart_count');
        if (cachedCount) {
            const count = parseInt(cachedCount, 10);
            if (count > 0) {
                updateCartCount(count);
                return;
            }
        }
        // Fallback: parse full cart data
        const stored = localStorage.getItem('inkcartridges_cart');
        if (stored) {
            const data = JSON.parse(stored);
            const items = data.items || data;
            if (Array.isArray(items) && items.length > 0) {
                const count = items.reduce((sum, item) => sum + (item.quantity || 1), 0);
                updateCartCount(count);
            }
        }
    } catch (e) {
        // Silently fail - Cart.init() will set the correct count
    }
}


/**
 * NAVIGATION
 * ==========
 */

function initNavigation() {
    const navToggle = $('.nav-toggle');
    const navMenu = $('#nav-menu');

    if (navToggle && navMenu) {
        navToggle.addEventListener('click', function() {
            const isOpen = navMenu.classList.toggle('is-open');
            navToggle.setAttribute('aria-expanded', isOpen);
        });
    }

    // Close mobile menu when clicking outside
    document.addEventListener('click', function(e) {
        if (navMenu && navMenu.classList.contains('is-open')) {
            if (!e.target.closest('.primary-nav')) {
                navMenu.classList.remove('is-open');
                navToggle.setAttribute('aria-expanded', 'false');
            }
        }
    });


    // Handle dropdown navigation for keyboard users
    const dropdownItems = $$('.nav-menu__item--has-dropdown');
    dropdownItems.forEach(function(item) {
        const link = item.querySelector('a');
        const dropdown = item.querySelector('.nav-dropdown');

        link.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const isExpanded = link.getAttribute('aria-expanded') === 'true';
                link.setAttribute('aria-expanded', !isExpanded);
            }
        });
    });
}


/**
 * MEGA PANELS
 * ===========
 */

function initMegaPanels() {
    const megaToggles = document.querySelectorAll('.nav-mega-toggle');

    megaToggles.forEach(function(toggle) {
        toggle.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            const targetPanel = document.getElementById(targetId);
            const isExpanded = this.getAttribute('aria-expanded') === 'true';

            // Close all other panels first
            megaToggles.forEach(function(otherToggle) {
                if (otherToggle !== toggle) {
                    otherToggle.setAttribute('aria-expanded', 'false');
                    const otherId = otherToggle.getAttribute('data-target');
                    const otherPanel = document.getElementById(otherId);
                    if (otherPanel) {
                        otherPanel.hidden = true;
                    }
                }
            });

            // Toggle this panel
            if (targetPanel) {
                const newState = !isExpanded;
                this.setAttribute('aria-expanded', newState);
                targetPanel.hidden = !newState;
            }
        });
    });

    // Close panels when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.nav-mega-toggle') && !e.target.closest('.mega-panel')) {
            megaToggles.forEach(function(toggle) {
                toggle.setAttribute('aria-expanded', 'false');
                const targetId = toggle.getAttribute('data-target');
                const targetPanel = document.getElementById(targetId);
                if (targetPanel) {
                    targetPanel.hidden = true;
                }
            });
        }
    });
}


/**
 * SEARCH WITH AUTOCOMPLETE
 * ========================
 * Searches for products and printers, shows autocomplete suggestions
 */

function initSearch() {
    const searchForms = $$('.search-form');
    if (!searchForms.length) return;

    searchForms.forEach(function(searchForm) {
        const searchInput = searchForm.querySelector('input[type="search"]');
        if (!searchInput) return;

        // Only apply expand/overlay animation for forms inside .primary-nav
        const primaryNav = searchForm.closest('.primary-nav');
        if (primaryNav) {
            const searchWrapper = searchForm.closest('.search-wrapper');
            // Expand the outermost element (wrapper if present, otherwise form itself)
            const expandTarget = searchWrapper || searchForm;

            searchInput.addEventListener('focus', function() {
                expandTarget.classList.add('is-expanded');
                primaryNav.classList.add('search-active');
            });

            document.addEventListener('click', function(e) {
                if (!expandTarget.contains(e.target)) {
                    expandTarget.classList.remove('is-expanded');
                    primaryNav.classList.remove('search-active');
                }
            });

            // Close search overlay on Escape key
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && primaryNav.classList.contains('search-active')) {
                    expandTarget.classList.remove('is-expanded');
                    primaryNav.classList.remove('search-active');
                    searchInput.blur();
                }
            });
        }

        // Autocomplete is owned by /js/search.js (SmartSearch). It is loaded
        // synchronously before /js/main.js on every page that has a search
        // form, so the global is always defined when initSearch() runs after
        // DOMContentLoaded. The legacy basic-autocomplete fallback (~210
        // lines) was deleted in the 2026-05-03 search audit (see
        // readfirst/SEARCH_AUDIT.md) as it duplicated logic the backend
        // already returns through /api/search/suggest.
        if (typeof SmartSearch !== 'undefined') {
            SmartSearch.init(searchForm, searchInput);
        } else if (typeof DebugLog !== 'undefined') {
            DebugLog.warn('[search] SmartSearch not loaded — autocomplete disabled, submit-on-Enter still works');
        }

        // Backend /api/search/* requires q.length >= 2 (Joi). Mirror that here so
        // users can't fire a 400 — disable submit until the input has 2+ chars.
        const submitBtn = searchForm.querySelector('button[type="submit"]');
        const MIN_LEN = 2;
        const syncSubmitState = () => {
            if (!submitBtn) return;
            const q = searchInput.value.trim();
            const tooShort = q.length < MIN_LEN;
            submitBtn.disabled = tooShort;
            submitBtn.setAttribute('aria-disabled', tooShort ? 'true' : 'false');
        };
        searchInput.addEventListener('input', syncSubmitState);
        // Defense-in-depth (search-recent-chip-no-submit-jun2026.md): a
        // programmatic `value =` fires no 'input' event, so re-sync on
        // focus/change too — else a stale-disabled submit kills Enter+magnifier.
        searchInput.addEventListener('focus', syncSubmitState);
        searchInput.addEventListener('change', syncSubmitState);
        syncSubmitState();

        // Handle form submission.
        //
        // Spec (search-dropdown-routing.md, "Three-handler invariant"):
        // Search bar Enter / form submit ALWAYS goes to /search?q=<query>.
        // Do NOT branch on matched_printer here — the form has no business
        // reading dropdown state, and branching on it collapses the user's
        // disambiguation choice (e.g. q=200 matches both an Epson 200 ink
        // family AND the trailing digits of "Canon LASER SHOT LBP 5200" —
        // the dropdown surfaces both; Enter must take the user to the
        // generic search-results page so they can still choose).
        //
        // The /search route rewrites to the shop page (vercel.json), which
        // already handles ?q= via shop-page.js's search-results level.
        searchForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const query = searchInput.value.trim();
            if (query.length < MIN_LEN) return;
            window.location.href = `/search?q=${encodeURIComponent(query)}`;
        });
    });
}

/**
 * DROPDOWNS
 * =========
 */

function initDropdowns() {
    // Generic dropdown initialization for select elements, etc.
    const dropdowns = $$('[data-dropdown]');

    dropdowns.forEach(function(dropdown) {
        const trigger = dropdown.querySelector('[data-dropdown-trigger]');
        const content = dropdown.querySelector('[data-dropdown-content]');

        if (trigger && content) {
            trigger.addEventListener('click', function() {
                const isOpen = content.classList.toggle('is-open');
                trigger.setAttribute('aria-expanded', isOpen);
            });
        }
    });
}


/**
 * CURRENT YEAR
 * ============
 * Updates copyright year automatically
 */

function initCurrentYear() {
    const yearElements = $$('#current-year');
    const currentYear = new Date().getFullYear();

    yearElements.forEach(function(el) {
        el.textContent = currentYear;
    });
}


/**
 * CART COUNT
 * ==========
 * Updates cart count badge
 */

function updateCartCount(count) {
    const cartCounts = $$('.cart-count');

    cartCounts.forEach(function(el) {
        el.textContent = count;
        el.setAttribute('aria-label', `${count} items in cart`);

        // Show/hide badge based on count
        if (count > 0) {
            el.classList.add('has-items');
            el.hidden = false;
        } else {
            el.classList.remove('has-items');
            el.hidden = true;
        }
    });

    // Keep the header cart link's accessible name in sync with the count
    // (mobile-parity-may2026 S0.1). On mobile the visible "Cart" label is
    // hidden and the badge is aria-hidden, so without this a screen reader
    // hears only "link". The audit acceptance checks aria-label ~= /cart.*\d/i.
    const n = Number(count) || 0;
    $$('a.header-actions__item[href="/cart"]').forEach(function(link) {
        link.setAttribute('aria-label', n > 0
            ? `Cart, ${n} item${n === 1 ? '' : 's'}`
            : 'Cart, empty');
    });

    // Persist count for fast-path on next page load
    try {
        localStorage.setItem('cart_count', count);
    } catch (e) {
        // Storage full or unavailable
    }
}


/**
 * TOAST NOTIFICATIONS
 * ===================
 * Display temporary messages to users
 */

function showToast(message, type = 'info', duration = 3000) {
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `
        <span class="toast__message">${Security.escapeHtml(message)}</span>
        <button type="button" class="toast__close" aria-label="Close">&times;</button>
    `;

    // Add to page
    let container = $('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(function() {
        toast.classList.add('toast--visible');
    });

    // Close button
    toast.querySelector('.toast__close').addEventListener('click', function() {
        removeToast(toast);
    });

    // Auto remove
    if (duration > 0) {
        setTimeout(function() {
            removeToast(toast);
        }, duration);
    }

    return toast;
}

function removeToast(toast) {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', function() {
        toast.remove();
    });
}


/**
 * SMOOTH SCROLL
 * =============
 * Handle anchor links with smooth scrolling
 */

document.addEventListener('click', function(e) {
    const anchor = e.target.closest('a[href^="#"]');

    if (anchor) {
        const targetId = anchor.getAttribute('href');
        if (targetId === '#') return;

        const target = document.querySelector(targetId);
        if (target) {
            e.preventDefault();

            // For ink-finder, center the entire wrapper box on screen
            if (targetId === '#ink-finder-heading') {
                const wrapper = document.querySelector('.ink-finder__wrapper');
                if (wrapper) {
                    const wrapperRect = wrapper.getBoundingClientRect();
                    const wrapperHeight = wrapperRect.height;
                    const windowHeight = window.innerHeight;
                    const wrapperTop = window.pageYOffset + wrapperRect.top;
                    // If wrapper is taller than viewport, align to top with small offset.
                    // Otherwise, center it vertically.
                    const scrollTop = wrapperHeight >= windowHeight
                        ? wrapperTop - 16
                        : wrapperTop - (windowHeight - wrapperHeight) / 2;

                    window.scrollTo({
                        top: Math.max(0, scrollTop),
                        behavior: 'smooth'
                    });
                } else {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            } else {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }

            // Update URL without scrolling (skip for ink-finder — keeping
            // the hash would make reloads land scrolled-down on mobile).
            if (targetId !== '#ink-finder-heading') {
                history.pushState(null, null, targetId);
            }
        }
    }
});

// Stale ink-finder hash cleanup — older builds pushed this into the URL.
// Never want a reload to land the user mid-page with the header hidden.
if (window.location.hash === '#ink-finder-heading') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    window.scrollTo({ top: 0, behavior: 'auto' });
}

// Cross-page deep-link to the ink-finder via ?scroll=ink-finder.
// Used by the "Printer Models" nav link when the user is on another page.
// (A hash would be simpler, but server redirects on clean-URL routes drop
// the fragment in some setups — a query param survives redirects cleanly.)
if (new URLSearchParams(window.location.search).get('scroll') === 'ink-finder') {
    const scrollToFinder = () => {
        const wrapper = document.querySelector('.ink-finder__wrapper');
        const target = document.getElementById('ink-finder-heading');
        if (wrapper) {
            const rect = wrapper.getBoundingClientRect();
            const wrapperTop = window.pageYOffset + rect.top;
            const scrollTop = rect.height >= window.innerHeight
                ? wrapperTop - 16
                : wrapperTop - (window.innerHeight - rect.height) / 2;
            window.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
        } else if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        // Strip the param so a later reload still lands at top.
        const params = new URLSearchParams(window.location.search);
        params.delete('scroll');
        const qs = params.toString();
        history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    };
    if (document.readyState === 'complete') {
        setTimeout(scrollToFinder, 50);
    } else {
        window.addEventListener('load', () => setTimeout(scrollToFinder, 50), { once: true });
    }
}

// Opt out of browser scroll restoration — on the home page it leaves the
// viewport scrolled to wherever the user last was, hiding the header.
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}
