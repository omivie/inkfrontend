/**
 * Admin Planner — single dashboard layout
 * Top bar · Mini calendar + General column · Sticky notes · Vieland + Jackson columns
 */

import { AdminAuth, FilterState } from '../app.js';
import { PlannerAPI, PlannerNotesAPI } from '../api.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const esc = (s) => Security.escapeHtml(String(s ?? ''));

// ---- Constants ----

const OWNERS = ['general', 'vieland', 'jackson'];
const OWNER_META = {
  general: { label: 'General / Company', accent: '#6b7280', email: null,                       name: null       },
  vieland: { label: 'Vieland',           accent: '#267FB5', email: 'vielandvnnz@gmail.com',    name: 'Vieland'  },
  jackson: { label: 'Jackson',           accent: '#f59e0b', email: 'junjackson0915@gmail.com', name: 'Jackson'  },
};

const CATEGORIES = {
  marketing:  { label: 'Marketing',  color: '#6366f1' },
  operations: { label: 'Operations', color: '#f59e0b' },
  customer:   { label: 'Customer',   color: '#10b981' },
  general:    { label: 'General',    color: '#6b7280' },
};

const PRIORITIES = {
  high:   { label: 'High',   dot: '#ef4444' },
  medium: { label: 'Medium', dot: '#f59e0b' },
  low:    { label: 'Low',    dot: null },
};

const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'gray'];

const DOW_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- Module state ----

let _container    = null;
let _tasks        = [];
let _notes        = [];
let _anchorDate   = new Date();
let _selectedDate = null;            // 'YYYY-MM-DD' — ring on mini-cal + focus in columns
let _abortTasks   = null;
let _abortNotes   = null;
let _myOwner      = null;
const _noteSaveTimers = new Map();   // noteId -> timeout id (debounced autosave)

// ---- Utility ----

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getInitials(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0][0] || '').toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatCardDate(str) {
  const today = isoDate(new Date());
  const tomorrow = isoDate(new Date(Date.now() + 86400000));
  if (str === today) return 'Today';
  if (str === tomorrow) return 'Tomorrow';
  return parseLocalDate(str).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTopHeading(str) {
  const d = parseLocalDate(str);
  const today = isoDate(new Date());
  const label = d.toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return str === today ? `Today · ${label}` : label;
}

function formatMonthYear(date) {
  return date.toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' });
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)  return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7)    return `${days}d ago`;
  return new Date(isoStr).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

function addMonths(date, delta) {
  const d = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  // preserve day-of-month clamp
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), lastDay));
  return d;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Press Enter to click `buttonId` while the button is in the DOM,
// unless focus is inside a textarea (newline) or contenteditable.
// Auto-cleans up when the button is removed (drawer/modal closed).
function setupEnterToClick(buttonId) {
  const onKey = (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const btn = document.getElementById(buttonId);
    if (!btn) { document.removeEventListener('keydown', onKey); return; }
    const tgt = e.target;
    const tag = (tgt?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tgt?.isContentEditable) return; // let newline happen
    e.preventDefault();
    btn.click();
  };
  document.addEventListener('keydown', onKey);
}

// ---- Data flow ----

async function loadTasks() {
  _abortTasks?.abort();
  _abortTasks = new AbortController();
  const y = _anchorDate.getFullYear();
  const m = _anchorDate.getMonth();
  // window: one month before anchor → end of one month after anchor (covers grid + lookahead)
  const from = isoDate(new Date(y, m - 1, 1));
  const to   = isoDate(new Date(y, m + 2, 0));
  _tasks = await PlannerAPI.getTasks(from, to, { signal: _abortTasks.signal }) || [];
  renderAll();
}

async function loadNotes() {
  _abortNotes?.abort();
  _abortNotes = new AbortController();
  _notes = await PlannerNotesAPI.list(_abortNotes.signal) || [];
  const region = _container?.querySelector('[data-region="notes"]');
  if (region) renderNotes(region);
}

function tasksByOwner() {
  const map = { general: [], vieland: [], jackson: [] };
  for (const t of _tasks) {
    const o = OWNERS.includes(t.owner) ? t.owner : 'general';
    map[o].push(t);
  }
  return map;
}

function splitTodayUpcoming(list) {
  const today = isoDate(new Date());
  const todayOrOverdue = [];
  const upcoming = [];
  for (const t of list) {
    // Hide completed tasks once their due date has passed — they've served their purpose.
    if (t.completed && t.due_date < today) continue;
    if (t.due_date <= today) todayOrOverdue.push(t);
    else                     upcoming.push(t);
  }
  const sortBy = (a, b) => {
    // Completed tasks sink to the bottom of their section
    if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
    // Selected day floats to the top (among incomplete)
    if (_selectedDate && !a.completed) {
      const aSel = a.due_date === _selectedDate ? 0 : 1;
      const bSel = b.due_date === _selectedDate ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
    }
    return a.due_date.localeCompare(b.due_date);
  };
  todayOrOverdue.sort(sortBy);
  upcoming.sort(sortBy);
  return { todayOrOverdue, upcoming };
}

function resolveMyOwner() {
  const me = (AdminAuth.user?.email || '').toLowerCase();
  for (const k of OWNERS) {
    const email = OWNER_META[k].email;
    if (email && email.toLowerCase() === me) return k;
  }
  return null;
}

// ---- Scaffold ----

function scaffold() {
  _container.innerHTML = `
    <div class="planner-topbar" data-region="topbar"></div>
    <div class="planner-dashboard">
      <section class="planner-left">
        <div class="planner-mini-cal" data-region="mini-cal"></div>
        <div class="planner-notes-region" data-region="notes"></div>
      </section>
      <section class="planner-right">
        <div class="planner-col planner-col--general planner-col--horizontal" data-region="general"></div>
        <div class="planner-right__people">
          <div class="planner-col planner-col--vieland" data-region="vieland"></div>
          <div class="planner-col planner-col--jackson" data-region="jackson"></div>
        </div>
      </section>
    </div>
  `;
}

// ---- Top bar ----

function renderTopBar(el) {
  el.innerHTML = `
    <div class="planner-topbar__nav">
      <button class="planner-iconbtn" data-act="prev-month" title="Previous month">&laquo;</button>
      <button class="planner-iconbtn" data-act="prev-day"   title="Previous day">&lsaquo;</button>
    </div>
    <div class="planner-topbar__heading">${esc(formatTopHeading(_selectedDate))}</div>
    <div class="planner-topbar__nav">
      <button class="planner-iconbtn" data-act="next-day"   title="Next day">&rsaquo;</button>
      <button class="planner-iconbtn" data-act="next-month" title="Next month">&raquo;</button>
    </div>
    <button class="admin-btn admin-btn--sm admin-btn--ghost" data-act="today">Today</button>
    <div class="planner-topbar__spacer"></div>
    <button class="admin-btn admin-btn--sm admin-btn--primary" data-act="new-task">+ New Task</button>
  `;

  el.querySelector('[data-act="prev-day"]')   ?.addEventListener('click', () => shiftDay(-1));
  el.querySelector('[data-act="next-day"]')   ?.addEventListener('click', () => shiftDay(+1));
  el.querySelector('[data-act="prev-month"]') ?.addEventListener('click', () => shiftMonth(-1));
  el.querySelector('[data-act="next-month"]') ?.addEventListener('click', () => shiftMonth(+1));
  el.querySelector('[data-act="today"]')      ?.addEventListener('click', () => {
    _anchorDate = new Date();
    _selectedDate = isoDate(new Date());
    loadTasks();
  });
  el.querySelector('[data-act="new-task"]')   ?.addEventListener('click', () => {
    openTaskDrawer(null, { date: _selectedDate, owner: 'general' });
  });
}

function shiftDay(delta) {
  const d = parseLocalDate(_selectedDate);
  d.setDate(d.getDate() + delta);
  const prevMonth = _anchorDate.getMonth();
  _selectedDate = isoDate(d);
  // If day crosses the currently loaded window, reload
  if (d.getMonth() !== prevMonth || d.getFullYear() !== _anchorDate.getFullYear()) {
    _anchorDate = new Date(d);
    loadTasks();
  } else {
    renderAll();
  }
}

function shiftMonth(delta) {
  _anchorDate = addMonths(_anchorDate, delta);
  // keep selected day in view: if selected date's month is outside the new window, snap to 1st
  const sel = parseLocalDate(_selectedDate);
  if (sel.getMonth() !== _anchorDate.getMonth() || sel.getFullYear() !== _anchorDate.getFullYear()) {
    _selectedDate = isoDate(new Date(_anchorDate.getFullYear(), _anchorDate.getMonth(), 1));
  }
  loadTasks();
}

// ---- Mini calendar ----

function renderMiniCalendar(el) {
  el.innerHTML = buildCalendarHtml({ large: false });
  attachCalendarHandlers(el, { closeModalAfterSelect: false });

  el.querySelector('[data-act="mini-prev"]')?.addEventListener('click', () => shiftMonth(-1));
  el.querySelector('[data-act="mini-next"]')?.addEventListener('click', () => shiftMonth(+1));
  el.querySelector('[data-act="expand"]')    ?.addEventListener('click', () => openExpandedCalendar());
}

function buildCalendarHtml({ large }) {
  const year = _anchorDate.getFullYear();
  const month = _anchorDate.getMonth();
  const todayStr = isoDate(new Date());

  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // Mon-first
  const gridStart = new Date(year, month, 1 - startOffset);

  const taskMap = {};
  for (const t of _tasks) {
    if (!taskMap[t.due_date]) taskMap[t.due_date] = [];
    taskMap[t.due_date].push(t);
  }

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dateStr = isoDate(date);
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === _selectedDate;
    const inMonth = date.getMonth() === month;
    const dayTasks = taskMap[dateStr] || [];

    cells += `<div class="planner-mini-cal__cell${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}${!inMonth ? ' other-month' : ''}" data-date="${dateStr}">
      <span class="planner-mini-cal__day">${date.getDate()}</span>
      ${daySummaryHtml(dayTasks)}
    </div>`;
  }

  const header = `
    <div class="planner-mini-cal__header">
      <span class="planner-mini-cal__title">${esc(formatMonthYear(_anchorDate))}</span>
      ${large ? '' : `<div class="planner-topbar__nav">
        <button class="planner-iconbtn" data-act="mini-prev">&lsaquo;</button>
        <button class="planner-iconbtn" data-act="mini-next">&rsaquo;</button>
      </div>`}
    </div>
  `;

  const dowHeader = DOW_MON.map(d => `<div class="planner-mini-cal__dow">${d}</div>`).join('');
  const expand = large ? '' : `<button class="planner-mini-cal__expand-btn" data-act="expand" title="Expand calendar">Expand ⤢</button>`;

  return `${header}<div class="planner-mini-cal__grid">${dowHeader}${cells}</div>${expand}`;
}

function daySummaryHtml(tasks) {
  if (!tasks.length) return '';
  const active    = tasks.filter(t => !t.completed);
  const completed = tasks.length - active.length;
  const total     = tasks.length;

  // Owner dots: one per owner that has active tasks on this day
  const ownersSeen = new Set();
  for (const t of active) {
    const o = OWNERS.includes(t.owner) ? t.owner : 'general';
    ownersSeen.add(o);
  }
  const dots = OWNERS
    .filter(o => ownersSeen.has(o))
    .map(o => `<span class="planner-mini-cal__owner-dot" style="background:${OWNER_META[o].accent}"></span>`)
    .join('');

  // Label: "N" when all active, "N/T" when some done, "✓ T" when all done
  let label;
  let cls = 'planner-mini-cal__summary';
  if (active.length === 0) {
    label = `<span class="planner-mini-cal__check">✓</span>${total}`;
    cls += ' is-done';
  } else if (completed > 0) {
    label = `${active.length}<span class="planner-mini-cal__slash">/${total}</span>`;
  } else {
    label = `${active.length}`;
  }

  return `<div class="${cls}" title="${total} task${total === 1 ? '' : 's'}${completed ? `, ${completed} done` : ''}">
    ${dots ? `<span class="planner-mini-cal__dots">${dots}</span>` : ''}
    <span class="planner-mini-cal__count">${label}</span>
  </div>`;
}

function attachCalendarHandlers(el, { closeModalAfterSelect }) {
  el.querySelectorAll('.planner-mini-cal__cell').forEach(cell => {
    cell.addEventListener('click', () => {
      _selectedDate = cell.dataset.date;
      // If clicked date is in another month, also shift the anchor
      const d = parseLocalDate(_selectedDate);
      if (d.getMonth() !== _anchorDate.getMonth() || d.getFullYear() !== _anchorDate.getFullYear()) {
        _anchorDate = new Date(d);
        if (closeModalAfterSelect) Modal.close();
        loadTasks();
        return;
      }
      if (closeModalAfterSelect) Modal.close();
      renderAll();
    });
  });
}

function openExpandedCalendar() {
  const body = document.createElement('div');
  body.className = 'planner-mini-cal';
  body.innerHTML = buildCalendarHtml({ large: true });
  attachCalendarHandlers(body, { closeModalAfterSelect: true });

  Modal.open({
    title: formatMonthYear(_anchorDate),
    body,
    footer: `<button class="admin-btn admin-btn--sm admin-btn--ghost" id="planner-expand-close">Close</button>`,
    className: 'planner-expanded-modal',
  });
  setTimeout(() => {
    document.getElementById('planner-expand-close')?.addEventListener('click', () => Modal.close());
  }, 50);
}

// ---- Columns (General / Vieland / Jackson) ----

function renderColumn(el, owner) {
  const meta = OWNER_META[owner];
  const byOwner = tasksByOwner()[owner];
  const { todayOrOverdue, upcoming } = splitTodayUpcoming(byOwner);
  const today = isoDate(new Date());
  const overdueCount = todayOrOverdue.filter(t => !t.completed && t.due_date < today).length;

  const todayHtml    = todayOrOverdue.length ? todayOrOverdue.map(t => taskCardHtml(t, owner)).join('')
                                              : `<div class="planner-col__empty">Nothing on today's plate.</div>`;
  const upcomingHtml = upcoming.length       ? upcoming.map(t => taskCardHtml(t, owner)).join('')
                                              : `<div class="planner-col__empty">No upcoming tasks.</div>`;

  el.classList.toggle('is-mine', _myOwner === owner && owner !== 'general');
  el.innerHTML = `
    <div class="planner-col__header">
      <span class="planner-col__title">${esc(meta.label)}</span>
      ${overdueCount > 0 ? `<span class="planner-col__overdue-badge" data-count="${overdueCount}" title="${overdueCount} overdue">${overdueCount} overdue</span>` : ''}
      <span class="planner-col__spacer"></span>
      <button class="planner-col__add" data-act="add" title="New task for ${esc(meta.label)}">+</button>
    </div>
    <div class="planner-col__sections">
      <div class="planner-col__section">
        <div class="planner-col__subheader">Today / Overdue</div>
        <div class="planner-col__list">${todayHtml}</div>
      </div>
      <div class="planner-col__section">
        <div class="planner-col__subheader">Upcoming</div>
        <div class="planner-col__list">${upcomingHtml}</div>
      </div>
    </div>
  `;

  el.querySelector('[data-act="add"]')?.addEventListener('click', () => {
    openTaskDrawer(null, { date: _selectedDate, owner });
  });

  el.querySelectorAll('.planner-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.planner-card__checkbox')) return;
      const task = _tasks.find(t => t.id === card.dataset.taskId);
      if (task) openTaskDrawer(task);
    });
  });

  el.querySelectorAll('.planner-card__checkbox').forEach(cb => {
    cb.addEventListener('change', async () => {
      const taskId = cb.closest('[data-task-id]').dataset.taskId;
      const task = _tasks.find(t => t.id === taskId);
      if (!task) return;
      cb.disabled = true;
      const ok = await PlannerAPI.toggleComplete(taskId, task.completed);
      if (!ok) Toast.error('Could not update task');
      await loadTasks();
    });
  });
}

function taskCardHtml(task, owner) {
  const cat = CATEGORIES[task.category] || CATEGORIES.general;
  const pri = PRIORITIES[task.priority] || PRIORITIES.medium;
  const today = isoDate(new Date());
  const overdue = !task.completed && task.due_date < today;
  const selected = task.due_date === _selectedDate;
  const initials = getInitials(task.assigned_to_name) || (OWNER_META[owner]?.name ? getInitials(OWNER_META[owner].name) : '');

  return `<div class="planner-card${task.completed ? ' planner-card--completed' : ''}${overdue ? ' planner-card--overdue' : ''}${selected ? ' planner-card--selected-day' : ''}" data-task-id="${esc(task.id)}">
    <input type="checkbox" class="planner-card__checkbox" ${task.completed ? 'checked' : ''} aria-label="Mark complete">
    <div class="planner-card__main">
      <span class="planner-card__title">${esc(task.title)}</span>
      <div class="planner-card__meta">
        <span class="planner-card__date">${esc(formatCardDate(task.due_date))}</span>
        <span class="planner-cat-badge" style="color:${cat.color};border-color:${cat.color}55">${esc(cat.label)}</span>
        ${pri.dot ? `<span class="planner-pri-dot" style="background:${pri.dot}" title="${esc(pri.label)} priority"></span>` : ''}
      </div>
    </div>
    <div class="planner-card__right">
      ${initials ? `<span class="planner-initials-badge">${esc(initials)}</span>` : ''}
    </div>
  </div>`;
}

// ---- Notes ----

function renderNotes(el) {
  el.dataset.painted = '1';
  const notes = [..._notes].sort((a, b) => {
    if (!!b.pinned - !!a.pinned !== 0) return !!b.pinned - !!a.pinned;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });

  el.innerHTML = `
    <div class="planner-notes-region__header">
      <span class="planner-notes-region__title">Notes &amp; Ideas</span>
      <span class="planner-notes-region__spacer"></span>
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-act="add-note">+ Add note</button>
    </div>
    <div class="planner-notes__grid">
      ${notes.length ? notes.map(n => noteHtml(n)).join('') : `<div class="planner-notes__empty" style="grid-column:1/-1">No notes yet — capture an idea to start.</div>`}
    </div>
  `;

  el.querySelector('[data-act="add-note"]')?.addEventListener('click', createNote);

  el.querySelectorAll('.planner-note').forEach(noteEl => {
    const id = noteEl.dataset.noteId;
    const titleEl = noteEl.querySelector('.planner-note__title');
    const bodyEl  = noteEl.querySelector('.planner-note__body');

    const scheduleSave = debounce(async () => {
      const patch = { title: titleEl.value, body: bodyEl.value };
      const updated = await PlannerNotesAPI.update(id, patch);
      if (updated) {
        const idx = _notes.findIndex(n => n.id === id);
        if (idx !== -1) _notes[idx] = updated;
        // update stamp silently
        const stamp = noteEl.querySelector('.planner-note__stamp');
        if (stamp) stamp.textContent = stampLabel(updated);
      }
    }, 600);

    titleEl?.addEventListener('input', scheduleSave);
    bodyEl ?.addEventListener('input', scheduleSave);

    if (bodyEl) {
      autoSizeNoteBody(bodyEl);
      bodyEl.addEventListener('input', () => autoSizeNoteBody(bodyEl));
    }

    noteEl.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
      const current = _notes.find(n => n.id === id);
      if (!current) return;
      const updated = await PlannerNotesAPI.togglePin(id, current.pinned);
      if (updated) {
        const idx = _notes.findIndex(n => n.id === id);
        if (idx !== -1) _notes[idx] = updated;
        Toast.success(updated.pinned ? 'Pinned' : 'Unpinned');
        renderNotes(el);
      }
    });

    noteEl.querySelector('[data-act="delete"]')?.addEventListener('click', () => confirmDeleteNote(id, el));

    noteEl.querySelectorAll('[data-color]').forEach(sw => {
      sw.addEventListener('click', async () => {
        const color = sw.dataset.color;
        const updated = await PlannerNotesAPI.update(id, { color });
        if (updated) {
          const idx = _notes.findIndex(n => n.id === id);
          if (idx !== -1) _notes[idx] = updated;
          renderNotes(el);
        }
      });
    });
  });
}

function noteHtml(note) {
  const color = NOTE_COLORS.includes(note.color) ? note.color : 'yellow';
  const swatches = NOTE_COLORS.map(c => `<button class="planner-note__color-swatch${c === color ? ' is-active' : ''}" data-color="${c}" style="background:var(--planner-swatch-${c}, ${swatchColor(c)})" aria-label="${c}"></button>`).join('');
  return `<div class="planner-note planner-note--${color}${note.pinned ? ' is-pinned' : ''}" data-note-id="${esc(note.id)}">
    <input class="planner-note__title" type="text" placeholder="Title" value="${esc(note.title || '')}" maxlength="120">
    <textarea class="planner-note__body" placeholder="Write an idea…">${esc(note.body || '')}</textarea>
    <div class="planner-note__colors">${swatches}</div>
    <div class="planner-note__footer">
      <span class="planner-note__stamp">${esc(stampLabel(note))}</span>
      <button class="planner-note__action${note.pinned ? ' is-active' : ''}" data-act="pin" title="${note.pinned ? 'Unpin' : 'Pin'}">${note.pinned ? '📌' : '📍'}</button>
      <button class="planner-note__action" data-act="delete" title="Delete">✕</button>
    </div>
  </div>`;
}

function autoSizeNoteBody(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function swatchColor(name) {
  return ({
    yellow: '#F4C430', pink: '#ec4899', blue: '#267FB5',
    green:  '#34D399', purple: '#8b5cf6', gray: '#9ca3af',
  })[name] || '#F4C430';
}

function stampLabel(note) {
  const who = note.created_by_name || note.created_by_email?.split('@')[0] || '';
  const when = relativeTime(note.updated_at || note.created_at);
  if (who && when) return `${who} · ${when}`;
  return when || who;
}

async function createNote() {
  const user = AdminAuth.user;
  const payload = {
    title: '',
    body: '',
    color: 'yellow',
    pinned: false,
    created_by_email: user?.email || null,
    created_by_name:  user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split('@')[0] || null,
  };
  const created = await PlannerNotesAPI.create(payload);
  if (!created) { Toast.error('Could not create note'); return; }
  _notes.unshift(created);
  const region = _container.querySelector('[data-region="notes"]');
  if (region) {
    renderNotes(region);
    region.querySelector(`[data-note-id="${created.id}"] .planner-note__title`)?.focus();
  }
  Toast.success('Note added');
}

function confirmDeleteNote(id, regionEl) {
  const note = _notes.find(n => n.id === id);
  const label = note?.title?.trim() || 'this note';
  Modal.open({
    title: 'Delete Note',
    body: `<p>Delete "<strong>${esc(label)}</strong>"? This cannot be undone.</p>`,
    footer: `<button class="admin-btn admin-btn--ghost admin-btn--sm" id="del-note-cancel">Cancel</button>
             <button class="admin-btn admin-btn--danger admin-btn--sm" id="del-note-confirm">Delete</button>`,
  });
  setTimeout(() => {
    document.getElementById('del-note-cancel')?.addEventListener('click', () => Modal.close());
    document.getElementById('del-note-confirm')?.addEventListener('click', async () => {
      Modal.close();
      const ok = await PlannerNotesAPI.remove(id);
      if (!ok) { Toast.error('Could not delete'); return; }
      _notes = _notes.filter(n => n.id !== id);
      renderNotes(regionEl);
      Toast.success('Note deleted');
    });
    setupEnterToClick('del-note-confirm');
  }, 50);
}

// ---- Render orchestrator ----

function renderAll() {
  if (!_container) return;
  const q = (sel) => _container.querySelector(sel);
  const topbar = q('[data-region="topbar"]');
  if (topbar) renderTopBar(topbar);
  const mini = q('[data-region="mini-cal"]');
  if (mini) renderMiniCalendar(mini);
  const general = q('[data-region="general"]');
  if (general) renderColumn(general, 'general');
  const vieland = q('[data-region="vieland"]');
  if (vieland) renderColumn(vieland, 'vieland');
  const jackson = q('[data-region="jackson"]');
  if (jackson) renderColumn(jackson, 'jackson');
  // notes are rendered on their own cadence (loadNotes paints them once loaded)
  const notes = q('[data-region="notes"]');
  if (notes && !notes.dataset.painted) {
    // show a lightweight placeholder until loadNotes paints them
    notes.innerHTML = `
      <div class="planner-notes-region__header">
        <span class="planner-notes-region__title">Notes &amp; Ideas</span>
      </div>
      <div class="planner-notes__empty">Loading notes…</div>
    `;
  }
}

// ---- Task drawer (create / edit) ----

function openTaskDrawer(task, opts = {}) {
  const isEdit = !!task;
  const { date = null, owner = null } = opts;
  const defaultOwner = task?.owner || owner || 'general';
  const defaultDate  = task?.due_date || date || isoDate(new Date());

  const user = AdminAuth.user;
  const myName  = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split('@')[0] || '';
  const myEmail = user?.email || '';

  // If new task and owner is vieland/jackson, prefill assignee from OWNER_META
  let assigneeName  = task?.assigned_to_name  ?? '';
  let assigneeEmail = task?.assigned_to_email ?? '';
  if (!isEdit) {
    if (defaultOwner === 'vieland' || defaultOwner === 'jackson') {
      assigneeName  = OWNER_META[defaultOwner].name  || '';
      assigneeEmail = OWNER_META[defaultOwner].email || '';
    } else {
      assigneeName  = myName;
      assigneeEmail = myEmail;
    }
  }

  const body = `
    <form id="planner-task-form" class="planner-form">
      <div class="planner-form-row">
        <label class="planner-form-label">Title <span class="planner-required">*</span></label>
        <input class="admin-input" name="title" required maxlength="200" value="${esc(task?.title || '')}" placeholder="What needs to be done?">
      </div>
      <div class="planner-form-row planner-form-row--2col">
        <div>
          <label class="planner-form-label">Column</label>
          <select class="admin-input" name="owner" id="planner-owner-select">
            <option value="general" ${defaultOwner === 'general' ? 'selected' : ''}>General / Company</option>
            <option value="vieland" ${defaultOwner === 'vieland' ? 'selected' : ''}>Vieland</option>
            <option value="jackson" ${defaultOwner === 'jackson' ? 'selected' : ''}>Jackson</option>
          </select>
        </div>
        <div>
          <label class="planner-form-label">Due Date <span class="planner-required">*</span></label>
          <input class="admin-input" type="date" name="due_date" required value="${esc(defaultDate)}">
        </div>
      </div>
      <div class="planner-form-row planner-form-row--2col">
        <div>
          <label class="planner-form-label">Category</label>
          <select class="admin-input" name="category">
            ${Object.entries(CATEGORIES).map(([k, v]) =>
              `<option value="${k}" ${(task?.category || 'general') === k ? 'selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label class="planner-form-label">Priority</label>
          <select class="admin-input" name="priority">
            ${Object.entries(PRIORITIES).map(([k, v]) =>
              `<option value="${k}" ${(task?.priority || 'medium') === k ? 'selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="planner-form-row planner-form-row--2col">
        <div>
          <label class="planner-form-label">Recurrence</label>
          <select class="admin-input" name="recurrence" id="planner-rec-select">
            <option value=""        ${!task?.recurrence                 ? 'selected' : ''}>None</option>
            <option value="daily"   ${task?.recurrence === 'daily'      ? 'selected' : ''}>Daily</option>
            <option value="weekly"  ${task?.recurrence === 'weekly'     ? 'selected' : ''}>Weekly</option>
            <option value="monthly" ${task?.recurrence === 'monthly'    ? 'selected' : ''}>Monthly</option>
          </select>
        </div>
        <div id="planner-rec-end-wrap" style="display:${task?.recurrence ? 'block' : 'none'}">
          <label class="planner-form-label">Repeat until</label>
          <input class="admin-input" type="date" name="recurrence_end_date" value="${esc(task?.recurrence_end_date || '')}">
        </div>
      </div>
      <div class="planner-form-row planner-form-row--2col">
        <div>
          <label class="planner-form-label">Assignee name</label>
          <input class="admin-input" name="assigned_to_name" value="${esc(assigneeName)}" placeholder="Full name">
        </div>
        <div>
          <label class="planner-form-label">Assignee email</label>
          <input class="admin-input" type="email" name="assigned_to_email" value="${esc(assigneeEmail)}" placeholder="email@example.com">
        </div>
      </div>
      <div class="planner-form-row">
        <label class="planner-form-label">Details</label>
        <textarea class="admin-input planner-textarea" name="description" rows="3" placeholder="Optional notes, context or links…">${esc(task?.description || '')}</textarea>
      </div>
    </form>
  `;

  const footer = `
    <div class="planner-drawer-footer">
      ${isEdit ? `<button class="admin-btn admin-btn--danger admin-btn--sm" id="planner-delete-btn">Delete</button>` : ''}
      <span style="flex:1"></span>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="planner-cancel-btn">Cancel</button>
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="planner-save-btn">${isEdit ? 'Save Changes' : 'Create Task'}</button>
    </div>
  `;

  Drawer.open({ title: isEdit ? 'Edit Task' : 'New Task', body, footer, width: '460px' });

  setTimeout(() => {
    const recSel = document.getElementById('planner-rec-select');
    const recEndWrap = document.getElementById('planner-rec-end-wrap');
    recSel?.addEventListener('change', () => {
      if (recEndWrap) recEndWrap.style.display = recSel.value ? 'block' : 'none';
    });

    // When owner changes on a new task, auto-update assignee fields if they still match the previous owner's defaults (or are blank).
    const ownerSel = document.getElementById('planner-owner-select');
    const nameInput  = document.querySelector('input[name="assigned_to_name"]');
    const emailInput = document.querySelector('input[name="assigned_to_email"]');
    if (!isEdit) {
      ownerSel?.addEventListener('change', () => {
        const newOwner = ownerSel.value;
        const meta = OWNER_META[newOwner];
        const currName  = nameInput?.value?.trim();
        const currEmail = emailInput?.value?.trim();
        // Figure out if the current values look like a previous owner's preset — if so, swap them out.
        const isPreset = OWNERS.some(k => {
          const m = OWNER_META[k];
          return (m.name && m.name === currName) || (m.email && m.email === currEmail);
        }) || (currName === myName && currEmail === myEmail);
        if (!isPreset && currName) return; // user has typed something, don't overwrite
        if (newOwner === 'vieland' || newOwner === 'jackson') {
          if (nameInput)  nameInput.value  = meta.name  || '';
          if (emailInput) emailInput.value = meta.email || '';
        } else {
          if (nameInput)  nameInput.value  = myName;
          if (emailInput) emailInput.value = myEmail;
        }
      });
    }

    document.getElementById('planner-cancel-btn')?.addEventListener('click', () => Drawer.close());

    const triggerSave = async () => {
      const form = document.getElementById('planner-task-form');
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const data = Object.fromEntries(new FormData(form));
      await saveTask(task, data, myEmail, myName);
    };
    document.getElementById('planner-save-btn')?.addEventListener('click', triggerSave);
    // Enter-in-input submits the form (browser may submit to nothing since save button isn't type=submit)
    document.getElementById('planner-task-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      triggerSave();
    });
    // Enter outside any text field clicks Save
    setupEnterToClick('planner-save-btn');

    if (isEdit) {
      document.getElementById('planner-delete-btn')?.addEventListener('click', () => {
        Modal.open({
          title: 'Delete Task',
          body: `<p>Delete "<strong>${esc(task.title)}</strong>"? This cannot be undone.</p>`,
          footer: `<button class="admin-btn admin-btn--ghost admin-btn--sm" id="del-cancel">Cancel</button>
                   <button class="admin-btn admin-btn--danger admin-btn--sm" id="del-confirm">Delete</button>`,
        });
        setTimeout(() => {
          document.getElementById('del-cancel')?.addEventListener('click', () => Modal.close());
          document.getElementById('del-confirm')?.addEventListener('click', async () => {
            Modal.close();
            Drawer.close();
            const ok = await PlannerAPI.deleteTask(task.id);
            if (ok) Toast.success('Task deleted');
            await loadTasks();
          });
          setupEnterToClick('del-confirm');
        }, 50);
      });
    }
  }, 50);
}

async function saveTask(existingTask, formData, createdByEmail, createdByName) {
  const btn = document.getElementById('planner-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const base = {
    title:               formData.title,
    description:         formData.description || null,
    due_date:            formData.due_date,
    owner:               formData.owner || 'general',
    priority:            formData.priority || 'medium',
    category:            formData.category || 'general',
    assigned_to_name:    formData.assigned_to_name  || null,
    assigned_to_email:   formData.assigned_to_email || null,
    recurrence:          formData.recurrence || null,
    recurrence_end_date: formData.recurrence_end_date || null,
  };

  if (existingTask) {
    const result = await PlannerAPI.updateTask(existingTask.id, { ...base });
    if (result) {
      Toast.success('Task saved');
      Drawer.close();
      await loadTasks();
    } else if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  } else {
    const tasks = expandRecurrence(base, createdByEmail, createdByName);
    let success = true;
    for (const t of tasks) {
      const result = await PlannerAPI.createTask(t);
      if (!result) { success = false; break; }
    }
    if (success) {
      Toast.success(tasks.length > 1 ? `${tasks.length} tasks created` : 'Task created');
      Drawer.close();
      await loadTasks();
    } else if (btn) {
      btn.disabled = false;
      btn.textContent = 'Create Task';
    }
  }
}

function expandRecurrence(base, createdByEmail, createdByName) {
  const common = {
    ...base,
    created_by_email: createdByEmail,
    created_by_name:  createdByName,
    recurrence:          null,
    recurrence_end_date: null,
  };

  if (!base.recurrence || !base.recurrence_end_date) {
    return [{ ...common, recurrence: base.recurrence || null, recurrence_end_date: base.recurrence_end_date || null }];
  }

  const LIMITS = { daily: 90, weekly: 52, monthly: 24 };
  const instances = [];
  const start = parseLocalDate(base.due_date);
  const end   = parseLocalDate(base.recurrence_end_date);
  let cur = new Date(start);
  let count = 0;
  const limit = LIMITS[base.recurrence] || 52;

  while (cur <= end && count < limit) {
    instances.push({ ...common, due_date: isoDate(cur) });
    count++;
    if      (base.recurrence === 'daily')   cur.setDate(cur.getDate() + 1);
    else if (base.recurrence === 'weekly')  cur.setDate(cur.getDate() + 7);
    else                                    cur.setMonth(cur.getMonth() + 1);
  }

  return instances.length ? instances : [common];
}

// ---- Page module ----

export default {
  title: 'Planner',

  async init(container) {
    _container    = container;
    _anchorDate   = new Date();
    _selectedDate = isoDate(new Date());
    _myOwner      = resolveMyOwner();
    FilterState.setVisibleFilters([]);
    FilterState.showBar(false);
    scaffold();
    renderAll();
    // Kick off both loads in parallel
    loadTasks();
    loadNotes();
  },

  destroy() {
    _abortTasks?.abort();
    _abortNotes?.abort();
    for (const t of _noteSaveTimers.values()) clearTimeout(t);
    _noteSaveTimers.clear();
    _container = null;
    _tasks = [];
    _notes = [];
  },
};
