/**
 * Invoice Generator — create and download professional invoices as PDF
 */
import { icon, esc, FilterState } from '../app.js';

// ── Fixed "from" details ────────────────────────────────────────────────────
const FROM_DEFAULTS = {
  company:    'Office Consumables Ltd',
  gst:        '94509459',
  address1:   '37A Archibald Rd',
  address2:   'Kelston',
  address3:   'Auckland 0602',
  phone:      '09 8133882',
  contact:    'Trevor Walker',
  bankName:   'Office Consumables Ltd',
  bankNumber: '01 0186 0335027 00',
};

const GST_RATE = 0.15;
const LS_KEY   = 'inv_state_v1';

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadFrom() {
  try {
    const stored = JSON.parse(localStorage.getItem('inv_from_v1') || '{}');
    return { ...FROM_DEFAULTS, ...stored };
  } catch { return { ...FROM_DEFAULTS }; }
}

function saveFrom(from) {
  localStorage.setItem('inv_from_v1', JSON.stringify(from));
}

function nextInvoiceNo() {
  const last = parseInt(localStorage.getItem('inv_last_num') || '3236', 10);
  return last + 1;
}

function fmtDateFull(d) {
  const day = d.getDate();
  const sfx = [11,12,13].includes(day % 100) ? 'th'
    : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  const mo = ['January','February','March','April','May','June','July',
               'August','September','October','November','December'][d.getMonth()];
  return `${day}${sfx} ${mo} ${d.getFullYear()}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isoToDisplay(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return fmtDateFull(d);
}

function calcTotals(items, freight) {
  const subtotal  = items.reduce((s, it) => s + (parseFloat(it.qty)||0) * (parseFloat(it.cost)||0), 0);
  const freightN  = (freight === '' || freight === 'free') ? 0 : parseFloat(freight) || 0;
  const gst       = (subtotal + freightN) * GST_RATE;
  const total     = subtotal + freightN + gst;
  return { subtotal, freightN, gst, total };
}

function money(n) { return n.toFixed(2); }

// ── Smart-paste parser ───────────────────────────────────────────────────────
function parsePaste(raw) {
  const lines = raw.split('\n').map(l => l.trim());

  const out = { attn:'', company:'', address:'', phone:'', email:'', freight:'free', items:[] };
  const labeled = {};
  const addrLines = [];   // lines belonging to the address block
  const unclassified = []; // unlabeled lines outside any known block
  let inAddress = false;

  for (const line of lines) {
    // Blank line ends address continuation
    if (!line) { inAddress = false; continue; }

    // Pipe-separated item line: CODE | Description | Qty | Cost
    const pipe = line.match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+(?:\.\d*)?)\s*\|\s*([\d.]+)\s*$/);
    if (pipe) {
      inAddress = false;
      out.items.push({ code: pipe[1].trim(), description: pipe[2].trim(), qty: parseFloat(pipe[3]), cost: parseFloat(pipe[4]) });
      continue;
    }

    // Key: Value labeled line
    const kv = line.match(/^([a-z][a-z\s\-]{0,18}):\s*(.+)$/i);
    if (kv) {
      inAddress = false;
      const key = kv[1].toLowerCase().trim();
      const val = kv[2].trim();
      if (key === 'address' || key === 'addr' || key === 'street') {
        addrLines.push(val);
        inAddress = true; // following unlabeled lines are address continuations
      } else {
        labeled[key] = val;
      }
      continue;
    }

    // Unlabeled line
    if (inAddress) {
      // Continue address block — unless it clearly looks like phone or email
      if (!out.email && line.includes('@')) { out.email = line; inAddress = false; }
      else if (!out.phone && /^[\d\s\-()]{5,15}$/.test(line)) { out.phone = line; inAddress = false; }
      else { addrLines.push(line); }
    } else {
      unclassified.push(line);
    }
  }

  // Map labeled keys
  out.attn    = labeled['attn'] || labeled['attention'] || '';
  out.company = labeled['company'] || labeled['business'] || labeled['name'] || labeled['invoice to'] || '';
  out.address = addrLines.join('\n');
  out.phone   = out.phone || labeled['phone'] || labeled['ph'] || labeled['tel'] || labeled['mobile'] || labeled['fax'] || '';
  out.email   = out.email || labeled['email'] || '';
  if (labeled['freight'] || labeled['shipping']) out.freight = labeled['freight'] || labeled['shipping'];

  // Heuristic fallback for fully unlabeled paste (no Key: Value lines at all)
  if (!out.company && unclassified.length) {
    let i = 0;
    if (/^invoice\s+to/i.test(unclassified[0])) i++;
    // First substantive non-phone non-email line → company
    if (i < unclassified.length) {
      const l = unclassified[i];
      if (!l.includes('@') && !/^[\d\s\-()]{5,15}$/.test(l)) { out.company = l; i++; }
    }
    const extraAddr = [];
    while (i < unclassified.length) {
      const l = unclassified[i++];
      if (!out.email && l.includes('@')) { out.email = l; continue; }
      if (!out.phone && /^[\d\s\-()]{5,15}$/.test(l)) { out.phone = l; continue; }
      extraAddr.push(l);
    }
    if (!out.address && extraAddr.length) out.address = extraAddr.join('\n');
  }

  return out;
}

// ── State ────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    invoiceNo: nextInvoiceNo(),
    date: todayISO(),
    attn: '',
    company: '',
    address: '',
    phone: '',
    email: '',
    freight: 'free',
    items: [{ code: '', description: '', qty: 1, cost: '' }],
    from: loadFrom(),
  };
}

let _state  = defaultState();
let _container = null;

// ── Preview renderer ─────────────────────────────────────────────────────────
function renderPreview() {
  const el = _container?.querySelector('#inv-preview');
  if (!el) return;

  const s = _state;
  const f = s.from;
  const { subtotal, freightN, gst, total } = calcTotals(s.items, s.freight);
  const dateDisplay = isoToDisplay(s.date) || '';

  const itemRows = s.items
    .filter(it => it.description || it.code)
    .map(it => {
      const lineTotal = (parseFloat(it.qty)||0) * (parseFloat(it.cost)||0);
      return `
        <tr>
          <td class="inv-td inv-td--code">${esc(it.code)}</td>
          <td class="inv-td">${esc(it.description)}</td>
          <td class="inv-td inv-td--center">${esc(String(it.qty||1))}</td>
          <td class="inv-td inv-td--right">${money(lineTotal)}</td>
        </tr>`;
    }).join('');

  const freightDisplay = (s.freight === '' || s.freight === 'free') ? 'free' : `$${money(parseFloat(s.freight)||0)}`;

  el.innerHTML = `
    <div class="inv-sheet">
      <div class="inv-header-grid">
        <div class="inv-from">
          <div class="inv-from__label">Invoice from:</div>
          <div class="inv-from__company">${esc(f.company)}</div>
          <div class="inv-meta">
            <div class="inv-meta__row"><span class="inv-meta__key">Invoice No:</span><span class="inv-meta__val">${esc(String(s.invoiceNo))}</span></div>
            <div class="inv-meta__row"><span class="inv-meta__key">Date:</span><span class="inv-meta__val">${esc(dateDisplay)}</span></div>
            <div class="inv-meta__row"><span class="inv-meta__key">GST:</span><span class="inv-meta__val">${esc(f.gst)}</span></div>
          </div>
          <div class="inv-addr">
            <div>${esc(f.address1)}</div>
            <div>${esc(f.address2)}</div>
            <div>${esc(f.address3)}</div>
            <div>ph: ${esc(f.phone)}</div>
            <div>Contact: ${esc(f.contact)}</div>
          </div>
        </div>

        <div class="inv-to">
          ${s.attn ? `<div class="inv-to__attn">Attn: <strong>${esc(s.attn)}</strong></div>` : ''}
          <div class="inv-to__label">Invoice To:</div>
          <div class="inv-to__company">${esc(s.company || '—')}</div>
          ${s.address ? s.address.split('\n').map(l=>`<div class="inv-to__line">${esc(l)}</div>`).join('') : ''}
          ${s.phone   ? `<div class="inv-to__line">${esc(s.phone)}</div>` : ''}
          ${s.email   ? `<div class="inv-to__line">${esc(s.email)}</div>` : ''}
        </div>
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th class="inv-th inv-th--code">Product Code</th>
            <th class="inv-th">Description</th>
            <th class="inv-th inv-th--center">Number</th>
            <th class="inv-th inv-th--right">Cost</th>
          </tr>
        </thead>
        <tbody>${itemRows || '<tr><td colspan="4" class="inv-td inv-td--empty">No items added</td></tr>'}</tbody>
      </table>

      <div class="inv-totals">
        <div class="inv-totals__row"><span>Sub Total</span><span>${money(subtotal)}</span></div>
        <div class="inv-totals__row"><span>Freight</span><span>${esc(freightDisplay)}</span></div>
        <div class="inv-totals__row"><span>GST</span><span>${money(gst)}</span></div>
        <div class="inv-totals__row inv-totals__row--total"><span>Total</span><span>$${money(total)}</span></div>
      </div>

      <div class="inv-footer">
        <div class="inv-footer__thanks">Thank you for your order</div>
        <div class="inv-footer__pay">Please pay to:</div>
        <div class="inv-footer__bank">
          <span class="inv-footer__bank-label">a/c Name:</span>
          <span class="inv-footer__bank-val">${esc(f.bankName)}</span>
        </div>
        <div class="inv-footer__bank">
          <span class="inv-footer__bank-label">a/c Number:</span>
          <span class="inv-footer__bank-val">${esc(f.bankNumber)}</span>
        </div>
        <div class="inv-footer__closing">
          Thank you very much for your business and for checking out InkCartridges.co.nz.
        </div>
      </div>
    </div>
  `;
}

// ── PDF generation ───────────────────────────────────────────────────────────
function generatePDF() {
  const jspdf = window.jspdf;
  if (!jspdf) { alert('PDF library not loaded yet — please wait a moment and try again.'); return; }

  const { jsPDF } = jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

  const s = _state;
  const f = s.from;
  const { subtotal, freightN, gst, total } = calcTotals(s.items, s.freight);
  const dateDisplay = isoToDisplay(s.date) || '';
  const PW = 210, ML = 18, MR = 18, RW = PW - ML - MR;
  const col2 = PW / 2 + 8;

  // ---- Helpers ----
  const txt = (str, x, y, opts) => doc.text(String(str), x, y, opts);
  function setStyle(size, weight, color) {
    doc.setFontSize(size);
    doc.setFont('helvetica', weight || 'normal');
    if (color !== undefined) doc.setTextColor(...(Array.isArray(color) ? color : [color,color,color]));
  }

  // ── LEFT column ──
  let lY = 22;

  setStyle(7.5, 'normal', 120);
  txt('Invoice from:', ML, lY); lY += 5.5;

  setStyle(17, 'bold', 10);
  txt(f.company, ML, lY); lY += 8;

  // Invoice meta
  const metaLabelX = ML;
  const metaValX   = ML + 22;
  const metaRows   = [['Invoice No:', String(s.invoiceNo)], ['Date:', dateDisplay], ['GST:', f.gst]];
  for (const [lbl, val] of metaRows) {
    setStyle(8.5, 'normal', 110); txt(lbl, metaLabelX, lY);
    setStyle(8.5, 'bold',   20);  txt(val, metaValX,   lY);
    lY += 5;
  }
  lY += 3;

  setStyle(8.5, 'normal', 80);
  for (const line of [f.address1, f.address2, f.address3, `ph: ${f.phone}`, `Contact: ${f.contact}`]) {
    txt(line, ML, lY); lY += 4.5;
  }

  // ── RIGHT column ──
  let rY = 22;

  if (s.attn) {
    setStyle(9, 'normal', 100);
    txt('Attn: ', col2, rY);
    setStyle(10, 'bold', 10);
    txt(s.attn, col2 + 11, rY);
    rY += 7;
  }

  setStyle(8, 'normal', 110);
  txt('Invoice To:', col2, rY); rY += 5;

  setStyle(13, 'bold', 10);
  // Word-wrap company name if wide
  const coLines = doc.splitTextToSize(s.company || '', PW - col2 - MR);
  doc.text(coLines, col2, rY);
  rY += coLines.length * 5.5 + 2;

  setStyle(8.5, 'normal', 70);
  const toLines = [
    ...s.address.split('\n').filter(Boolean),
    s.phone,
    s.email,
  ].filter(Boolean);
  for (const line of toLines) {
    txt(line, col2, rY); rY += 4.5;
  }

  // ── Divider ──
  const sepY = Math.max(lY, rY) + 6;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.25);
  doc.line(ML, sepY, PW - MR, sepY);

  // ── Line items table ──
  const visItems = s.items.filter(it => it.description || it.code);
  const tableBody = visItems.map(it => {
    const lt = (parseFloat(it.qty)||0) * (parseFloat(it.cost)||0);
    return [it.code, it.description, String(it.qty||1), money(lt)];
  });

  doc.autoTable({
    head: [['Product Code', 'Description', 'Number', 'Cost']],
    body: tableBody,
    startY: sepY + 4,
    margin: { left: ML, right: MR },
    styles: { fontSize: 8.5, cellPadding: { top:3, bottom:3, left:2, right:2 }, textColor: [40,40,40] },
    headStyles: {
      fillColor: [255,255,255],
      textColor: [0,0,0],
      fontStyle: 'bold',
      lineWidth: { bottom: 0.4 },
      lineColor: [180,180,180],
      fontSize: 9,
    },
    columnStyles: {
      0: { cellWidth: 38, fontStyle: 'normal' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 18, halign: 'center' },
      3: { cellWidth: 24, halign: 'right' },
    },
    alternateRowStyles: { fillColor: [250,250,252] },
    theme: 'plain',
  });

  const afterTable = doc.lastAutoTable.finalY + 6;

  // ── Totals ──
  const totLabelX = PW - MR - 50;
  const totValX   = PW - MR;
  let tY = afterTable;

  const freightDisplay = (s.freight === '' || s.freight === 'free') ? 'free' : `$${money(parseFloat(s.freight)||0)}`;

  for (const [lbl, val] of [['Sub Total', money(subtotal)], ['Freight', freightDisplay], ['GST', money(gst)]]) {
    setStyle(9, 'normal', 80);  txt(lbl, totLabelX, tY);
    setStyle(9, 'normal', 20);  txt(val, totValX, tY, { align: 'right' });
    tY += 5.5;
  }

  tY += 1;
  doc.setLineWidth(0.5); doc.setDrawColor(30,30,30);
  doc.line(totLabelX, tY, totValX, tY);
  tY += 5.5;

  setStyle(10.5, 'bold', 10);
  txt('Total', totLabelX, tY);
  txt(`$${money(total)}`, totValX, tY, { align: 'right' });

  // ── Footer ──
  const footY = 260;
  doc.setLineWidth(0.25); doc.setDrawColor(200,200,200);
  doc.line(ML, footY, PW - MR, footY);

  let fY = footY + 7;
  setStyle(9, 'bold', 10);
  txt('Thank you for your order', ML, fY); fY += 5;
  txt('Please pay to:', ML, fY); fY += 7;

  setStyle(9, 'normal', 30);
  txt('a/c Name:',   ML,      fY);
  setStyle(9, 'bold', 10);
  txt(f.bankName,   ML + 24, fY); fY += 5;
  setStyle(9, 'normal', 30);
  txt('a/c Number:', ML,      fY);
  setStyle(9, 'bold', 10);
  txt(f.bankNumber, ML + 24, fY); fY += 8;

  setStyle(8.5, 'bold', 10);
  txt('Thank you very much for your business and for checking out InkCartridges.co.nz.', ML, fY);

  doc.save(`Invoice${s.invoiceNo}.pdf`);

  // Remember this invoice number as the last used
  localStorage.setItem('inv_last_num', String(s.invoiceNo));
}

// ── UI ────────────────────────────────────────────────────────────────────────
function renderItemRows() {
  const el = _container?.querySelector('#inv-items-body');
  if (!el) return;
  el.innerHTML = _state.items.map((it, i) => `
    <tr class="inv-form-item-row" data-idx="${i}">
      <td><input class="inv-input" data-field="code" data-idx="${i}" value="${esc(it.code)}" placeholder="e.g. COMPTN2584PK"></td>
      <td><input class="inv-input" data-field="description" data-idx="${i}" value="${esc(it.description)}" placeholder="Description"></td>
      <td><input class="inv-input inv-input--narrow" type="number" min="1" data-field="qty" data-idx="${i}" value="${it.qty||1}"></td>
      <td><input class="inv-input inv-input--narrow" type="number" step="0.01" min="0" data-field="cost" data-idx="${i}" value="${it.cost!==''?it.cost:''}" placeholder="0.00"></td>
      <td>
        <button class="inv-row-del" data-del="${i}" title="Remove row" ${_state.items.length === 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      </td>
    </tr>
  `).join('');

  // Wire item inputs
  el.querySelectorAll('[data-field]').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx   = parseInt(inp.dataset.idx, 10);
      const field = inp.dataset.field;
      _state.items[idx][field] = inp.value;
      renderPreview();
    });
  });

  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.del, 10);
      if (_state.items.length > 1) {
        _state.items.splice(idx, 1);
        renderItemRows();
        renderPreview();
      }
    });
  });
}

function bindField(selector, stateKey, transform) {
  const el = _container?.querySelector(selector);
  if (!el) return;
  el.addEventListener('input', () => {
    const val = transform ? transform(el.value) : el.value;
    if (stateKey.startsWith('from.')) {
      _state.from[stateKey.slice(5)] = val;
      saveFrom(_state.from);
    } else {
      _state[stateKey] = val;
    }
    renderPreview();
  });
}

export default {
  title: 'Invoice Generator',

  init(container) {
    _container = container;
    _state = defaultState();

    const s = _state;
    const f = s.from;

    FilterState.showBar(false);

    container.innerHTML = `
      <div class="inv-workspace">

        <!-- ── LEFT: form ── -->
        <div class="inv-form-panel">

          <div class="inv-form-section">
            <h3 class="inv-section-title">Invoice Details</h3>
            <div class="inv-form-row">
              <label class="inv-label">Invoice Number
                <input class="inv-input" id="f-invno" type="number" value="${esc(String(s.invoiceNo))}">
              </label>
              <label class="inv-label">Date
                <input class="inv-input" id="f-date" type="date" value="${esc(s.date)}">
              </label>
            </div>
          </div>

          <!-- Smart paste -->
          <div class="inv-form-section inv-paste-section">
            <div class="inv-paste-header">
              <div>
                <h3 class="inv-section-title" style="margin:0">Smart Paste</h3>
                <p class="inv-paste-hint">Paste customer info + items — the form fills automatically.</p>
              </div>
              <button class="inv-paste-help-btn" id="paste-help-btn" title="Show format guide">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                Format guide
              </button>
            </div>
            <div class="inv-paste-guide" id="paste-guide" hidden>
              <p><strong>Customer block</strong> (Key: Value, one per line):</p>
              <pre>Attn: Felix Wong
Company: Tai Ping Asian Supermarket
Address: 3037 Great North Rd
New Lynn
Auckland
Phone: 8250448
Email: felix.tpnl@gmail.com</pre>
              <p><strong>Items</strong> (pipe-separated, after a blank line):</p>
              <pre>COMPTN2584PK | Brother Comp.TN258 Set of 4 Toner | 1 | 170.43
COMPTN2150 | Brother Comp. TN2150 Toner BLACK | 1 | 32.00</pre>
              <p style="color:var(--color-text-muted);font-size:12px">Labels are optional — unlabeled lines are parsed heuristically.</p>
            </div>
            <textarea class="inv-paste-area" id="paste-area" placeholder="Paste customer details and/or item lines here, then click Parse…"></textarea>
            <div class="inv-paste-actions">
              <button class="inv-btn inv-btn--primary" id="parse-btn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                Parse &amp; fill
              </button>
              <button class="inv-btn inv-btn--ghost" id="clear-paste-btn">Clear</button>
              <span class="inv-parse-msg" id="parse-msg"></span>
            </div>
          </div>

          <!-- Customer / Invoice To -->
          <div class="inv-form-section">
            <h3 class="inv-section-title">Invoice To</h3>
            <div class="inv-form-row">
              <label class="inv-label">Attention (contact person)
                <input class="inv-input" id="f-attn" value="${esc(s.attn)}" placeholder="e.g. Felix Wong">
              </label>
            </div>
            <div class="inv-form-row">
              <label class="inv-label" style="flex:1">Company / Customer name
                <input class="inv-input" id="f-company" value="${esc(s.company)}" placeholder="e.g. Tai Ping Asian Supermarket">
              </label>
            </div>
            <div class="inv-form-row">
              <label class="inv-label" style="flex:1">Address <span style="font-weight:400;font-size:11px;color:var(--color-text-muted)">(one line per row — use Enter)</span>
                <textarea class="inv-input inv-textarea" id="f-address" rows="3" placeholder="3037 Great North Rd&#10;New Lynn&#10;Auckland">${esc(s.address)}</textarea>
              </label>
            </div>
            <div class="inv-form-row">
              <label class="inv-label">Phone
                <input class="inv-input" id="f-phone" value="${esc(s.phone)}" placeholder="e.g. 09 123 4567">
              </label>
              <label class="inv-label">Email
                <input class="inv-input" id="f-email" type="email" value="${esc(s.email)}" placeholder="customer@email.com">
              </label>
            </div>
          </div>

          <!-- Line items -->
          <div class="inv-form-section">
            <h3 class="inv-section-title">Line Items</h3>
            <table class="inv-items-table">
              <thead>
                <tr>
                  <th>Product Code</th>
                  <th>Description</th>
                  <th class="inv-th--narrow">Qty</th>
                  <th class="inv-th--narrow">Unit Cost ($)</th>
                  <th style="width:32px"></th>
                </tr>
              </thead>
              <tbody id="inv-items-body"></tbody>
            </table>
            <button class="inv-btn inv-btn--ghost inv-add-row" id="add-row-btn">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add row
            </button>
          </div>

          <!-- Freight -->
          <div class="inv-form-section">
            <h3 class="inv-section-title">Shipping &amp; Charges</h3>
            <div class="inv-form-row">
              <label class="inv-label">Freight
                <input class="inv-input inv-input--narrow" id="f-freight" value="${esc(s.freight)}" placeholder="free">
              </label>
              <div class="inv-label" style="color:var(--color-text-muted);font-size:12px;align-self:flex-end;padding-bottom:8px">
                Type "free" for no charge, or enter a dollar amount (e.g. 12.50)
              </div>
            </div>
          </div>

          <!-- From (collapsed by default) -->
          <details class="inv-from-details">
            <summary class="inv-from-summary">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Edit "Invoice From" details
            </summary>
            <div class="inv-from-fields">
              <div class="inv-form-row">
                <label class="inv-label" style="flex:1">Company name
                  <input class="inv-input" id="ff-company" value="${esc(f.company)}">
                </label>
                <label class="inv-label">GST number
                  <input class="inv-input" id="ff-gst" value="${esc(f.gst)}">
                </label>
              </div>
              <div class="inv-form-row">
                <label class="inv-label" style="flex:1">Address line 1
                  <input class="inv-input" id="ff-addr1" value="${esc(f.address1)}">
                </label>
              </div>
              <div class="inv-form-row">
                <label class="inv-label">City / Suburb
                  <input class="inv-input" id="ff-addr2" value="${esc(f.address2)}">
                </label>
                <label class="inv-label">City &amp; Postcode
                  <input class="inv-input" id="ff-addr3" value="${esc(f.address3)}">
                </label>
              </div>
              <div class="inv-form-row">
                <label class="inv-label">Phone
                  <input class="inv-input" id="ff-phone" value="${esc(f.phone)}">
                </label>
                <label class="inv-label">Contact name
                  <input class="inv-input" id="ff-contact" value="${esc(f.contact)}">
                </label>
              </div>
              <div class="inv-form-row">
                <label class="inv-label" style="flex:1">Bank account name
                  <input class="inv-input" id="ff-bankname" value="${esc(f.bankName)}">
                </label>
                <label class="inv-label" style="flex:1">Bank account number
                  <input class="inv-input" id="ff-banknum" value="${esc(f.bankNumber)}">
                </label>
              </div>
            </div>
          </details>

          <!-- Actions -->
          <div class="inv-form-actions">
            <button class="inv-btn inv-btn--secondary" id="reset-btn">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
              New invoice
            </button>
            <button class="inv-btn inv-btn--download" id="download-btn">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              Download PDF
            </button>
          </div>

        </div><!-- /inv-form-panel -->

        <!-- ── RIGHT: live preview ── -->
        <div class="inv-preview-panel">
          <div class="inv-preview-label">Live Preview</div>
          <div id="inv-preview" class="inv-preview-scroll"></div>
        </div>

      </div>

      <style>
        /* ── Workspace layout ───────────────────────────────── */
        .inv-workspace {
          display: grid;
          grid-template-columns: 480px 1fr;
          gap: 0;
          height: calc(100vh - 56px);
          overflow: hidden;
        }
        .inv-form-panel {
          overflow-y: auto;
          padding: 24px 24px 40px;
          border-right: 1px solid var(--color-border, #e2e8f0);
          background: var(--color-background, #fff);
          display: flex;
          flex-direction: column;
          gap: 0;
        }
        .inv-preview-panel {
          overflow-y: auto;
          background: #e8ecf0;
          display: flex;
          flex-direction: column;
        }
        .inv-preview-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: .06em;
          text-transform: uppercase;
          color: var(--color-text-muted, #64748b);
          padding: 14px 24px 8px;
          flex-shrink: 0;
        }
        .inv-preview-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 0 24px 40px;
        }

        /* ── Form sections ──────────────────────────────────── */
        .inv-form-section {
          margin-bottom: 20px;
          padding-bottom: 20px;
          border-bottom: 1px solid var(--color-border-light, #f1f5f9);
        }
        .inv-form-section:last-of-type { border-bottom: none; }
        .inv-section-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: .05em;
          text-transform: uppercase;
          color: var(--color-text-muted, #64748b);
          margin: 0 0 12px;
        }
        .inv-form-row {
          display: flex;
          gap: 12px;
          margin-bottom: 10px;
          flex-wrap: wrap;
        }
        .inv-label {
          display: flex;
          flex-direction: column;
          gap: 5px;
          font-size: 12px;
          font-weight: 600;
          color: var(--color-text, #1e293b);
          flex: 1;
          min-width: 140px;
        }
        .inv-input {
          padding: 7px 10px;
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: 6px;
          font-size: 13px;
          color: var(--color-text, #1e293b);
          background: var(--color-background, #fff);
          transition: border-color .15s, box-shadow .15s;
          width: 100%;
          box-sizing: border-box;
          font-family: inherit;
        }
        .inv-input:focus { outline: none; border-color: var(--color-primary, #267fb5); box-shadow: 0 0 0 3px rgba(38,127,181,.1); }
        .inv-input--narrow { width: 90px; flex: 0 0 90px; min-width: 70px; }
        .inv-textarea { resize: vertical; min-height: 72px; line-height: 1.5; }

        /* ── Smart paste ────────────────────────────────────── */
        .inv-paste-section { background: var(--color-background-alt, #f8fafc); border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; border: 1px dashed var(--color-border, #e2e8f0); }
        .inv-paste-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
        .inv-paste-hint { font-size: 12px; color: var(--color-text-muted, #64748b); margin: 3px 0 0; }
        .inv-paste-help-btn { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--color-primary, #267fb5); background: none; border: 1px solid currentColor; border-radius: 5px; padding: 4px 9px; cursor: pointer; white-space: nowrap; flex-shrink: 0; opacity: .8; transition: opacity .15s; }
        .inv-paste-help-btn:hover { opacity: 1; }
        .inv-paste-guide { background: var(--color-background, #fff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 7px; padding: 12px 14px; margin-bottom: 10px; font-size: 12px; }
        .inv-paste-guide pre { background: #f1f5f9; border-radius: 5px; padding: 8px 10px; font-size: 11px; overflow-x: auto; margin: 5px 0 10px; line-height: 1.6; }
        .inv-paste-guide p { margin: 0 0 4px; }
        .inv-paste-area { width: 100%; min-height: 90px; padding: 9px 11px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 7px; font-size: 12.5px; font-family: 'SF Mono', 'Cascadia Code', monospace; resize: vertical; background: var(--color-background, #fff); box-sizing: border-box; color: var(--color-text, #1e293b); }
        .inv-paste-area:focus { outline: none; border-color: var(--color-primary, #267fb5); }
        .inv-paste-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
        .inv-parse-msg { font-size: 12px; }
        .inv-parse-msg--ok  { color: #16a34a; }
        .inv-parse-msg--err { color: #dc2626; }

        /* ── Buttons ────────────────────────────────────────── */
        .inv-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; border-radius: 7px; font-size: 13px;
          font-weight: 600; cursor: pointer; border: 1px solid transparent;
          transition: all .15s; font-family: inherit;
        }
        .inv-btn--primary  { background: var(--color-primary, #267fb5); color: #fff; border-color: var(--color-primary, #267fb5); }
        .inv-btn--primary:hover { filter: brightness(1.1); }
        .inv-btn--ghost    { background: transparent; color: var(--color-text, #1e293b); border-color: var(--color-border, #e2e8f0); }
        .inv-btn--ghost:hover { background: var(--color-background-alt, #f8fafc); }
        .inv-btn--secondary { background: transparent; color: var(--color-text-muted, #64748b); border-color: var(--color-border, #e2e8f0); }
        .inv-btn--secondary:hover { background: var(--color-background-alt, #f8fafc); color: var(--color-text, #1e293b); }
        .inv-btn--download { background: #16a34a; color: #fff; border-color: #16a34a; padding: 9px 20px; font-size: 14px; }
        .inv-btn--download:hover { background: #15803d; }
        .inv-form-actions { display: flex; align-items: center; justify-content: space-between; padding-top: 4px; }

        /* ── Items table ────────────────────────────────────── */
        .inv-items-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 10px; }
        .inv-items-table th { padding: 0 6px 6px; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--color-text-muted, #64748b); border-bottom: 1px solid var(--color-border, #e2e8f0); }
        .inv-th--narrow { width: 80px; }
        .inv-form-item-row td { padding: 5px 4px; vertical-align: middle; }
        .inv-row-del { background: none; border: none; cursor: pointer; color: var(--color-text-muted, #64748b); padding: 4px; border-radius: 5px; display: flex; align-items: center; transition: color .15s, background .15s; }
        .inv-row-del:hover:not(:disabled) { color: #dc2626; background: #fef2f2; }
        .inv-row-del:disabled { opacity: .3; cursor: default; }
        .inv-add-row { margin-top: 4px; font-size: 12px; padding: 5px 10px; }

        /* ── From details (collapsible) ─────────────────────── */
        .inv-from-details { margin-top: -8px; margin-bottom: 20px; }
        .inv-from-summary { font-size: 12px; font-weight: 600; color: var(--color-text-muted, #64748b); cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 6px 0; list-style: none; user-select: none; }
        .inv-from-summary::-webkit-details-marker { display: none; }
        .inv-from-summary:hover { color: var(--color-primary, #267fb5); }
        .inv-from-fields { padding: 14px 0 0; display: flex; flex-direction: column; gap: 0; }

        /* ── Invoice sheet (preview) ────────────────────────── */
        .inv-sheet {
          background: #fff;
          border-radius: 4px;
          box-shadow: 0 2px 16px rgba(0,0,0,.12);
          padding: 40px 44px;
          max-width: 640px;
          margin: 0 auto;
          font-family: 'Times New Roman', Times, serif;
          font-size: 13.5px;
          color: #1a1a1a;
          line-height: 1.5;
        }
        .inv-header-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          margin-bottom: 28px;
          padding-bottom: 22px;
          border-bottom: 1px solid #ccc;
        }
        .inv-from__label { font-size: 11px; color: #666; margin-bottom: 4px; }
        .inv-from__company { font-size: 22px; font-weight: bold; margin-bottom: 12px; line-height: 1.2; }
        .inv-meta { margin-bottom: 14px; }
        .inv-meta__row { display: flex; gap: 8px; margin-bottom: 2px; font-size: 12.5px; }
        .inv-meta__key { color: #555; min-width: 80px; }
        .inv-meta__val { font-weight: bold; }
        .inv-addr { font-size: 12px; color: #444; line-height: 1.7; }
        .inv-to { }
        .inv-to__attn { font-size: 13.5px; margin-bottom: 8px; color: #333; }
        .inv-to__label { font-size: 11px; color: #666; margin-bottom: 4px; }
        .inv-to__company { font-size: 17px; font-weight: bold; margin-bottom: 7px; line-height: 1.3; }
        .inv-to__line { font-size: 12.5px; color: #444; line-height: 1.7; }

        /* Items table in preview */
        .inv-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12.5px; }
        .inv-th { padding: 6px 8px; text-align: left; font-weight: bold; border-bottom: 1.5px solid #222; }
        .inv-th--code { width: 130px; }
        .inv-th--center { text-align: center; width: 70px; }
        .inv-th--right { text-align: right; width: 80px; }
        .inv-td { padding: 5px 8px; border-bottom: 1px solid #eee; }
        .inv-td--code { font-size: 12px; }
        .inv-td--center { text-align: center; }
        .inv-td--right { text-align: right; }
        .inv-td--empty { text-align: center; color: #aaa; font-style: italic; padding: 20px; }

        /* Totals */
        .inv-totals { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; margin-bottom: 28px; }
        .inv-totals__row { display: flex; gap: 40px; font-size: 12.5px; min-width: 200px; justify-content: space-between; }
        .inv-totals__row--total { font-weight: bold; font-size: 14px; border-top: 1.5px solid #222; padding-top: 6px; margin-top: 4px; }

        /* Footer */
        .inv-footer { border-top: 1px solid #ccc; padding-top: 18px; font-size: 12.5px; }
        .inv-footer__thanks, .inv-footer__pay { font-weight: bold; text-decoration: underline; margin-bottom: 3px; }
        .inv-footer__bank { display: flex; gap: 16px; margin-bottom: 3px; }
        .inv-footer__bank-label { font-weight: bold; min-width: 84px; }
        .inv-footer__bank-val { font-weight: bold; }
        .inv-footer__closing { margin-top: 14px; font-weight: bold; font-size: 12px; }
      </style>
    `;

    // Render items
    renderItemRows();
    renderPreview();

    // ── Wire form fields ──
    bindField('#f-invno',   'invoiceNo', v => parseInt(v,10)||1);
    bindField('#f-date',    'date');
    bindField('#f-attn',    'attn');
    bindField('#f-company', 'company');
    bindField('#f-address', 'address');
    bindField('#f-phone',   'phone');
    bindField('#f-email',   'email');
    bindField('#f-freight', 'freight');

    // From fields
    bindField('#ff-company', 'from.company');
    bindField('#ff-gst',     'from.gst');
    bindField('#ff-addr1',   'from.address1');
    bindField('#ff-addr2',   'from.address2');
    bindField('#ff-addr3',   'from.address3');
    bindField('#ff-phone',   'from.phone');
    bindField('#ff-contact', 'from.contact');
    bindField('#ff-bankname','from.bankName');
    bindField('#ff-banknum', 'from.bankNumber');

    // Add row
    container.querySelector('#add-row-btn').addEventListener('click', () => {
      _state.items.push({ code:'', description:'', qty:1, cost:'' });
      renderItemRows();
      renderPreview();
    });

    // Smart paste guide toggle
    container.querySelector('#paste-help-btn').addEventListener('click', () => {
      const guide = container.querySelector('#paste-guide');
      guide.hidden = !guide.hidden;
    });

    // Parse
    container.querySelector('#parse-btn').addEventListener('click', () => {
      const raw  = container.querySelector('#paste-area').value;
      const msg  = container.querySelector('#parse-msg');
      if (!raw.trim()) { msg.textContent = 'Nothing to parse.'; msg.className = 'inv-parse-msg inv-parse-msg--err'; return; }

      const parsed = parsePaste(raw);
      let filled = 0;

      function setField(id, key, val) {
        if (!val) return;
        _state[key] = val;
        const el = container.querySelector(id);
        if (el) el.value = val;
        filled++;
      }

      setField('#f-attn',    'attn',    parsed.attn);
      setField('#f-company', 'company', parsed.company);
      setField('#f-address', 'address', parsed.address);
      setField('#f-phone',   'phone',   parsed.phone);
      setField('#f-email',   'email',   parsed.email);
      if (parsed.freight && parsed.freight !== 'free') {
        _state.freight = parsed.freight;
        const el = container.querySelector('#f-freight');
        if (el) el.value = parsed.freight;
        filled++;
      }

      if (parsed.items.length) {
        _state.items = parsed.items;
        renderItemRows();
        filled += parsed.items.length;
      }

      renderPreview();
      msg.textContent = `Filled ${filled} field${filled!==1?'s':''}.`;
      msg.className = filled > 0 ? 'inv-parse-msg inv-parse-msg--ok' : 'inv-parse-msg inv-parse-msg--err';
    });

    // Clear paste
    container.querySelector('#clear-paste-btn').addEventListener('click', () => {
      container.querySelector('#paste-area').value = '';
      container.querySelector('#parse-msg').textContent = '';
    });

    // Download PDF
    container.querySelector('#download-btn').addEventListener('click', generatePDF);

    // New invoice
    container.querySelector('#reset-btn').addEventListener('click', () => {
      if (!confirm('Start a new blank invoice? This will clear all fields.')) return;
      _state = defaultState();
      // Re-init by re-calling init
      this.init(container);
    });
  },

  destroy() {
    _container = null;
  },
};
