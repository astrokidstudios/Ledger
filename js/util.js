// Small shared helpers. Nothing here knows anything about the owner's money.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function fmt(amount, currency = 'GBP', opts = {}) {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency,
      maximumFractionDigits: opts.whole ? 0 : 2,
      minimumFractionDigits: opts.whole ? 0 : 2,
      signDisplay: opts.sign ? 'exceptZero' : 'auto',
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Convert between currencies using the owner's saved rates
// (rates are "value of 1 unit in GBP").
export function convert(amount, from, to, rates) {
  if (from === to) return Number(amount) || 0;
  const r = rates || {};
  const f = Number(r[from]); const t = Number(r[to]);
  if (!f || !t) return Number(amount) || 0;
  return (Number(amount) || 0) * f / t;
}

// ---------- dates ----------
export const iso = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => iso(new Date());
export const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
export function addMonths(s, n) {
  const d = parseISO(s); const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
}
export const monthsBetween = (a, b) => {
  const x = parseISO(a); const y = parseISO(b);
  return (y.getFullYear() - x.getFullYear()) * 12 + (y.getMonth() - x.getMonth()) + (y.getDate() - x.getDate()) / 30.44;
};

// A "budget month" starts on the owner's chosen day (e.g. payday).
export function periodFor(dateStr, startDay = 1) {
  const d = parseISO(dateStr);
  let y = d.getFullYear(); let m = d.getMonth();
  if (d.getDate() < startDay) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = iso(new Date(y, m, startDay));
  const end = addDays(addMonths(start, 1), -1);
  return { start, end, key: start.slice(0, 7) };
}
export const shiftPeriod = (p, n, startDay) => periodFor(addMonths(p.start, n), startDay);
export function periodLabel(p) {
  const d = parseISO(p.start);
  const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return d.getDate() === 1 ? label : `${label} (from ${d.getDate()}th)`;
}
export const niceDate = (s) => (s ? parseISO(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// ---------- payee matching ----------
// Turns messy bank descriptions into a stable key so a payee categorised once
// is recognised next time ("CARD PAYMENT TO TESCO STORES 3017 ON 12 SEP" -> "tesco stores").
const NOISE = [
  'card payment to', 'card payment', 'contactless payment', 'direct debit to', 'direct debit', 'standing order to',
  'faster payment to', 'faster payments receipt from', 'bank transfer to', 'transfer to', 'transfer from', 'payment to',
  'payment from', 'bill payment', 'debit card', 'pos ', 'dd ', 'so ', 'fpo ', 'fpi ', 'bgc ', 'deb ', 'cpt ',
  'zakup przy uzyciu karty', 'platnosc karta', 'platnosc web - kod mobilny', 'platnosc web', 'przelew wychodzacy',
  'przelew przychodzacy', 'przelew zewnetrzny wychodzacy', 'przelew zewnetrzny przychodzacy', 'przelew wlasny',
  'przelew na telefon', 'blik zakup', 'blik', 'zakup', 'oplata', 'obciazenie', 'uznanie',
];
export function payeeKey(desc) {
  let s = String(desc || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
  s = s.replace(/[*#/\\|_:;,.'"()[\]{}]+/g, ' ');
  for (const n of NOISE) if (s.startsWith(n)) { s = s.slice(n.length); break; }
  s = s
    .replace(/\bon \d{1,2} [a-z]{3}\b/g, ' ')
    .replace(/\b\d{1,2}[-\s]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g, ' ')
    .replace(/\b(gbp|pln|eur|usd)\b/g, ' ')
    .replace(/\S*\d\S*/g, ' ')
    .replace(/\b(ltd|limited|plc|sp z o o|sp|z|o|www|com|co|uk|pl|gb|london|warszawa|krakow)\b/g, ' ')
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(Boolean).slice(0, 3).join(' ') || String(desc || '').toLowerCase().trim().slice(0, 40);
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

// ---------- UI bits ----------
export function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

export function modal(html, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <button class="modal-x" aria-label="Close">×</button>${html}</div>`;
  const close = () => { wrap.remove(); onClose && onClose(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  $('.modal-x', wrap).addEventListener('click', close);
  document.body.appendChild(wrap);
  return { el: $('.modal', wrap), close };
}

export function confirmBox(message) {
  return new Promise((resolve) => {
    const m = modal(`<p>${esc(message)}</p><div class="row end"><button class="btn ghost" data-a="no">Cancel</button><button class="btn danger" data-a="yes">Yes, continue</button></div>`, { onClose: () => resolve(false) });
    $('[data-a=no]', m.el).onclick = () => { m.close(); };
    $('[data-a=yes]', m.el).onclick = () => { resolve(true); m.el.parentElement.remove(); };
  });
}

export const opt = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
