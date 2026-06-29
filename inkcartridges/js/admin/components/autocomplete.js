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
 */

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
  } = opts || {};

  // Ensure a positioned wrapper exists so the menu can anchor under the input.
  // Reuse an existing `.inv-ac` wrapper (invoice line items) when present.
  let wrap = input.closest('.admin-ac, .inv-ac');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'admin-ac';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
  }
  const acId = `admin-ac-${++_acSeq}`;
  let menu = wrap.querySelector('.admin-ac__menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'admin-ac__menu';
    menu.id = acId;
    menu.setAttribute('role', 'listbox');
    wrap.appendChild(menu);
  }

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

  function show() { menu.style.display = 'block'; open = true; input.setAttribute('aria-expanded', 'true'); }
  function hide() {
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

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', onBlur);
  menu.addEventListener('mousedown', onMenuDown);
  menu.addEventListener('mousemove', onMenuMove);

  return {
    destroy() {
      clearTimeout(timer);
      reqSeq++;
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('blur', onBlur);
      menu.removeEventListener('mousedown', onMenuDown);
      menu.removeEventListener('mousemove', onMenuMove);
      menu.remove();
    },
    clear() { input.value = ''; hide(); },
  };
}
