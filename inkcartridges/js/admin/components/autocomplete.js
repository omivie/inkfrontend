/**
 * Admin Autocomplete — storefront-grade async picker for admin inputs.
 *
 * Generalises the patterns the customer-facing SmartSearch uses (js/search.js):
 * debounced fetch, a dropdown menu, keyboard navigation (Arrow/Enter/Escape),
 * and explicit loading / no-results / error states — none of which the old
 * invoice-page primitive had.
 *
 * Usage:
 *   const ac = attachAutocomplete(inputEl, {
 *     fetch:  async (q) => [item, ...] | [{ title, items }, ...],  // flat OR sectioned
 *     render: (item) => 'html',          // caller escapes its own dynamic text
 *     onPick: (item) => { ... },
 *     minChars: 2, debounce: 250,
 *     emptyText: 'No matches',
 *   });
 *   ac.destroy();   // remove listeners + menu (call on drawer/page teardown)
 *
 * A `fetch` that returns section objects ({ title, items }) renders a grouped
 * menu with section headers (used by the invoice "Fill details from…" picker to
 * split Contacts from Customers, mirroring the storefront Compatible/Genuine
 * split). Keyboard nav treats the flattened item list as one cycle.
 *
 * POSITIONING (ERR-107, Jul 2026) — the menu is PORTALLED to <body> and placed
 * with `position: fixed` against the input's measured rect. It used to be an
 * absolutely-positioned child of the input wrapper, which meant any ancestor
 * with `overflow` clipped it: in the product modal the Related Products picker
 * sits at the bottom of `.admin-product-modal__tab-panels` (overflow-y:auto)
 * inside `.admin-product-modal__inner` (overflow:hidden), so all but the first
 * two rows were cut off and unreachable. z-index cannot fix that — a clipped
 * element is clipped, not painted under. Escaping to <body> is the only fix
 * that works from ANY container, and it also buys flip-up + shrink-to-fit so
 * the menu is never taller than the space actually available.
 *
 * The alternative in-flow pattern (.admin-brandpicker, css/admin.css:1551) is
 * still valid for pickers that WANT to push content down; this one overlays.
 */

// Gap between the input and the menu, and the minimum breathing room we keep
// against the viewport edge.
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
// Below this, a downward menu is too squashed to be usable — flip up instead
// even when there is technically more room below.
const MIN_USABLE_HEIGHT = 200;

// The nearest ancestor that scrolls. Used to hide the menu once the operator
// scrolls its input out of view: a body-level fixed menu has no clipping
// ancestor left, so without this it would hang over unrelated UI.
function nearestScrollParent(el) {
  let node = el?.parentElement;
  while (node && node !== document.body) {
    const { overflowY, overflowX } = getComputedStyle(node);
    if (/(auto|scroll|hidden)/.test(overflowY) || /(auto|scroll|hidden)/.test(overflowX)) return node;
    node = node.parentElement;
  }
  return null;
}

const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
const escH = (s) => (window.Security?.escapeHtml ? Security.escapeHtml(String(s ?? '')) : String(s ?? ''));

let _acSeq = 0;

export function attachAutocomplete(input, opts) {
  if (!input) return { destroy() {} };
  const {
    fetch: doFetch,
    render,
    onPick,
    minChars = 2,
    debounce = 250,
    emptyText = 'No matches',
    menuClass = '',        // extra class(es) on the dropdown menu (e.g. a wider product variant)
    // Pull the input into view on focus. Opt-in: worth it for a field at the
    // bottom of a tall modal panel (Related Products), jarring for line-item
    // inputs inside a table (Invoices / Quick Order).
    scrollIntoViewOnFocus = false,
  } = opts || {};

  // Re-attaching to the same input used to be harmless because the menu was
  // reused from the wrapper. Now that it's a <body> child, a second attach
  // would strand the first menu there forever — so tear it down first.
  input._adminAc?.destroy?.();

  // Wrapper keeps the input's own sizing (and the `.admin-pc-filter-icon`
  // overlay) intact. Reuse an existing `.inv-ac` wrapper (invoice line items)
  // when present. The MENU no longer lives here — see the portal note above.
  let wrap = input.closest('.admin-ac, .inv-ac');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'admin-ac';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
  }
  const acId = `admin-ac-${++_acSeq}`;
  const menu = document.createElement('div');
  menu.className = 'admin-ac__menu';
  menu.id = acId;
  menu.setAttribute('role', 'listbox');
  if (menuClass) menu.classList.add(...String(menuClass).split(/\s+/).filter(Boolean));
  document.body.appendChild(menu);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', acId);

  // `flat` is the keyboard-navigable list of picked-able items (sections flattened).
  let flat = [];
  let active = -1;
  let timer = null;
  let reqSeq = 0;          // guards against out-of-order fetches
  let open = false;

  const isSectioned = (res) => Array.isArray(res) && res.length > 0 && res[0] && typeof res[0] === 'object' && Array.isArray(res[0].items);

  /**
   * Place the fixed menu against the input, flipping up and shrinking to fit.
   *
   * Called on every show AND on scroll/resize while open, because a fixed
   * element does not travel with a scrolling ancestor the way an absolute one
   * does — nothing else keeps it glued to the input.
   */
  function positionMenu() {
    const rect = input.getBoundingClientRect();
    // Base variant matches the input's width; `--product` overrides with its
    // own fixed width in CSS. Cascade decides, so JS never has to know which.
    menu.style.setProperty('--admin-ac-anchor-w', `${rect.width}px`);

    const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    // Prefer downward; flip only when down is genuinely cramped AND up is roomier.
    const flipUp = below < MIN_USABLE_HEIGHT && above > below;
    const space = flipUp ? above : below;

    // Publish the available space and let CSS min() it against the variant's
    // own ceiling. Writing an inline max-height instead would mean reading the
    // CSS ceiling back to clamp against — and a `vh`-based ceiling read once
    // goes stale the moment the window is resized.
    menu.style.setProperty('--admin-ac-fit', `${Math.max(0, space)}px`);
    if (flipUp) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - rect.top + MENU_GAP}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${rect.bottom + MENU_GAP}px`;
    }

    // Clamp horizontally so a menu wider than its input can't push off-screen
    // (the product variant is 560px against a much narrower line-item input).
    const width = menu.offsetWidth || rect.width;
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    menu.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft))}px`;
  }

  const scrollParent = nearestScrollParent(input);

  // Scrolled the input out of its own container (or off-screen)? The menu has
  // no clipping ancestor to hide it any more, so close rather than let it
  // float over unrelated UI.
  function inputStillVisible() {
    const rect = input.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    if (scrollParent) {
      const box = scrollParent.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) return false;
    }
    return true;
  }

  const reposition = () => {
    if (!open) return;
    if (!inputStillVisible()) { hide(); return; }
    positionMenu();
  };

  function show() {
    menu.style.display = 'block';
    open = true;
    input.setAttribute('aria-expanded', 'true');
    positionMenu();
    // Capture phase is REQUIRED: the element that scrolls is the modal's tab
    // panel, not the window, and scroll events don't bubble.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  }
  function hide() {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    menu.style.display = 'none'; menu.innerHTML = ''; open = false; active = -1;
    flat = []; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }

  function renderSkeleton() {
    menu.innerHTML = `<div class="admin-ac__state">${
      Array.from({ length: 4 }, () => '<div class="admin-ac__skel"></div>').join('')
    }</div>`;
    show();
  }

  function renderMessage(text, cls) {
    menu.innerHTML = `<div class="admin-ac__state admin-ac__msg${cls ? ' ' + cls : ''}">${escH(text)}</div>`;
    show();
  }

  function renderResults(res) {
    flat = [];
    let html = '';
    const pushItem = (item) => {
      const i = flat.length;
      flat.push(item);
      html += `<button type="button" class="admin-ac__item" role="option" id="${acId}-opt-${i}" data-i="${i}">${render(item)}</button>`;
    };
    if (isSectioned(res)) {
      for (const sec of res) {
        if (!sec.items || !sec.items.length) continue;
        html += `<div class="admin-ac__section">${escH(sec.title || '')}</div>`;
        sec.items.forEach(pushItem);
      }
    } else {
      (res || []).forEach(pushItem);
    }
    if (!flat.length) { renderMessage(emptyText); return; }
    menu.innerHTML = html;
    show();
  }

  function setActive(i) {
    const items = menu.querySelectorAll('.admin-ac__item');
    if (!items.length) return;
    if (i < 0) i = items.length - 1;
    if (i >= items.length) i = 0;
    active = i;
    items.forEach((el, idx) => el.classList.toggle('admin-ac__item--active', idx === active));
    const el = items[active];
    if (el) {
      input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function pick(i) {
    const item = flat[i];
    hide();
    if (item && onPick) onPick(item);
  }

  async function runFetch(q) {
    const seq = ++reqSeq;
    renderSkeleton();
    let res;
    try {
      res = await doFetch(q);
    } catch (e) {
      if (seq !== reqSeq) return;       // superseded
      renderMessage('Couldn’t search — try again', 'admin-ac__msg--error');
      return;
    }
    if (seq !== reqSeq) return;          // a newer keystroke already fired
    renderResults(res);
  }

  const onInput = () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < minChars) { hide(); return; }
    timer = setTimeout(() => runFetch(q), debounce);
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // Re-open on arrow if there's a pending query.
      if (input.value.trim().length >= minChars) onInput();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); pick(active); }
    } else if (e.key === 'Escape') {
      if (open) { e.stopPropagation(); hide(); }
    }
  };

  // mousedown fires before the input's blur so the pick isn't lost to the hide.
  const onMenuDown = (e) => {
    const btn = e.target.closest('.admin-ac__item');
    if (!btn) return;
    e.preventDefault();
    pick(+btn.dataset.i);
  };
  const onMenuMove = (e) => {
    const btn = e.target.closest('.admin-ac__item');
    if (btn) setActive(+btn.dataset.i);
  };
  const onBlur = () => setTimeout(hide, 150);
  // Pull a field sitting at the bottom of a tall scroll panel up into view, so
  // the operator can see the input AND its results without hunting.
  const onFocus = () => { try { input.scrollIntoView({ block: 'center' }); } catch (e) { /* older engines */ } };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', onBlur);
  if (scrollIntoViewOnFocus) input.addEventListener('focus', onFocus);
  menu.addEventListener('mousedown', onMenuDown);
  menu.addEventListener('mousemove', onMenuMove);

  const api = {
    destroy() {
      clearTimeout(timer);
      reqSeq++;
      if (input._adminAc === api) delete input._adminAc;
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('focus', onFocus);
      menu.removeEventListener('mousedown', onMenuDown);
      menu.removeEventListener('mousemove', onMenuMove);
      // The menu is a <body> child now, so it does NOT go away with the modal.
      // Dropping these two and removing the node is what stops an orphaned
      // dropdown (and a live scroll listener) surviving a drawer teardown.
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      menu.remove();
    },
    clear() { input.value = ''; hide(); },
  };
  input._adminAc = api;
  return api;
}
