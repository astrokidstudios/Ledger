import { sb, state, fetchTxns, visibleAccountIds, catById, accById, learnRule, autoCategory, currentPeriod, startDay, loadCore } from '../db.js';
import { esc, fmt, niceDate, opt, toast, modal, confirmBox, download, toCSV, sha256, today, shiftPeriod, periodLabel, payeeKey, $, $$ } from '../util.js';
import { readFileText, parseRows, detectMapping, applyMapping } from '../csv.js';
import { categoryOptions } from './inbox.js';
import { refreshInboxCount } from '../app.js';

const f = { offset: 0, cat: '', q: '', all: false };

export async function renderTransactions(view) {
  const sd = startDay();
  const p = shiftPeriod(currentPeriod(), f.offset, sd);
  const ids = visibleAccountIds();
  let txns = await fetchTxns(f.all ? { accountIds: ids } : { from: p.start, to: p.end, accountIds: ids });
  if (f.cat === 'none') txns = txns.filter((t) => !t.category_id);
  else if (f.cat) txns = txns.filter((t) => t.category_id === f.cat);
  if (f.q) { const q = f.q.toLowerCase(); txns = txns.filter((t) => (t.description + ' ' + (t.notes || '')).toLowerCase().includes(q)); }

  view.innerHTML = `
  <div class="page-head">
    <h1>Money in & out</h1>
    <div class="row">
      <button class="btn" id="add">+ Add</button>
      <button class="btn primary" id="import">Import bank CSV</button>
    </div>
  </div>
  <div class="filters card">
    <div class="month-nav">
      <button class="btn ghost small" id="prev" ${f.all ? 'disabled' : ''}>‹</button>
      <strong>${f.all ? 'All time' : esc(periodLabel(p))}</strong>
      <button class="btn ghost small" id="next" ${f.all || f.offset >= 0 ? 'disabled' : ''}>›</button>
      <label class="check small"><input type="checkbox" id="all" ${f.all ? 'checked' : ''}> All time</label>
    </div>
    <select id="fcat">${opt('', 'All categories', !f.cat)}${opt('none', 'Not categorised', f.cat === 'none')}${state.categories.map((c) => opt(c.id, c.name, f.cat === c.id)).join('')}</select>
    <input type="search" id="q" placeholder="Search…" value="${esc(f.q)}">
    <button class="btn ghost small" id="export">Export CSV</button>
  </div>
  <div class="card flush">
    ${txns.length ? `<table class="tbl txns"><thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th class="r">Amount</th><th></th></tr></thead><tbody>
    ${txns.map((t) => `<tr data-id="${t.id}">
      <td class="nowrap">${niceDate(t.txn_date)}</td>
      <td><div class="desc">${esc(t.description)}</div><div class="muted small m-only">${niceDate(t.txn_date)}</div>${t.notes ? `<div class="muted small">${esc(t.notes)}</div>` : ''}</td>
      <td class="muted small">${esc(accById(t.account_id)?.name || '')}</td>
      <td><select class="cat-sel ${t.category_id ? '' : 'empty'}" data-id="${t.id}">${categoryOptions(t.category_id, Number(t.amount))}</select>${t.auto_categorised ? '<span class="auto" title="Sorted automatically">auto</span>' : ''}</td>
      <td class="r nowrap ${Number(t.amount) >= 0 ? 'pos' : ''}">${fmt(t.amount, t.currency, { sign: true })}</td>
      <td><button class="icon-btn" data-edit="${t.id}" aria-label="Edit">✎</button></td>
    </tr>`).join('')}</tbody></table>`
    : `<div class="empty"><p>No transactions here yet.</p>${state.accounts.length ? '<p class="muted">Import a CSV from your bank to get started.</p>' : '<a class="btn" href="#/accounts">Add an account first</a>'}</div>`}
  </div>`;

  const rerender = () => renderTransactions(view);
  $('#prev').onclick = () => { f.offset -= 1; rerender(); };
  $('#next').onclick = () => { f.offset += 1; rerender(); };
  $('#all').onchange = (e) => { f.all = e.target.checked; rerender(); };
  $('#fcat').onchange = (e) => { f.cat = e.target.value; rerender(); };
  let tmr; $('#q').oninput = (e) => { clearTimeout(tmr); tmr = setTimeout(() => { f.q = e.target.value; rerender().then(() => { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
  $('#export').onclick = () => download(`ledger-transactions-${today()}.csv`, toCSV(txns.map((t) => ({
    date: t.txn_date, description: t.description, account: accById(t.account_id)?.name, category: catById(t.category_id)?.name || '',
    amount: t.amount, currency: t.currency, vat: t.vat_amount ?? '', notes: t.notes || '',
  }))), 'text/csv');
  $('#import').onclick = () => (state.accounts.length ? openImport(rerender) : toast('Add an account first', 'bad'));
  $('#add').onclick = () => (state.accounts.length ? editTxn(null, rerender) : toast('Add an account first', 'bad'));

  $$('.cat-sel', view).forEach((sel) => {
    sel.onchange = async () => {
      const t = txns.find((x) => x.id === sel.dataset.id);
      const catId = sel.value || null;
      const { error } = await sb.from('transactions').update({ category_id: catId, auto_categorised: false }).eq('id', t.id);
      if (error) return toast(error.message, 'bad');
      sel.classList.toggle('empty', !catId);
      if (catId && t.payee_key) {
        const others = await learnRule(t.payee_key, catId);
        toast(others ? `Saved. Also sorted ${others} other payment${others > 1 ? 's' : ''} from the same place.` : 'Saved. Future payments from here will be sorted automatically.');
        if (others) rerender();
      }
      refreshInboxCount();
    };
  });
  $$('[data-edit]', view).forEach((b) => { b.onclick = () => editTxn(txns.find((t) => t.id === b.dataset.edit), rerender); });
}

function editTxn(t, done) {
  const accs = state.accounts.filter((a) => !a.archived);
  const m = modal(`<h2>${t ? 'Edit' : 'Add'} transaction</h2>
  <form id="tx" class="form">
    <label>Account<select name="account_id">${accs.map((a) => opt(a.id, a.name, t ? t.account_id === a.id : state.accountId === a.id)).join('')}</select></label>
    <div class="row2">
      <label>Date<input type="date" name="txn_date" value="${t?.txn_date || today()}" required></label>
      <label>Amount (minus for money out)<input type="number" step="0.01" name="amount" value="${t?.amount ?? ''}" required placeholder="-12.50"></label>
    </div>
    <label>Description<input name="description" value="${esc(t?.description || '')}" required></label>
    <label>Category<select name="category_id">${categoryOptions(t?.category_id, Number(t?.amount ?? -1))}</select></label>
    <div class="row2">
      <label>VAT included (optional)<input type="number" step="0.01" name="vat_amount" value="${t?.vat_amount ?? ''}"></label>
      <label>Notes<input name="notes" value="${esc(t?.notes || '')}"></label>
    </div>
    <div class="row between">
      ${t ? '<button type="button" class="btn danger ghost" id="del">Delete</button>' : '<span></span>'}
      <button class="btn primary">Save</button>
    </div>
  </form>`);
  $('#tx', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const acc = accById(d.account_id);
    const row = {
      account_id: d.account_id, txn_date: d.txn_date, amount: Number(d.amount), description: d.description.trim(),
      category_id: d.category_id || null, vat_amount: d.vat_amount === '' ? null : Number(d.vat_amount), notes: d.notes || null,
      currency: acc.currency, payee_key: payeeKey(d.description), auto_categorised: false,
    };
    const q = t ? sb.from('transactions').update(row).eq('id', t.id) : sb.from('transactions').insert(row);
    const { error } = await q;
    if (error) return toast(error.message, 'bad');
    m.close(); toast('Saved'); refreshInboxCount(); done();
  };
  const del = $('#del', m.el);
  if (del) del.onclick = async () => {
    if (!(await confirmBox('Delete this transaction?'))) return;
    const { error } = await sb.from('transactions').delete().eq('id', t.id);
    if (error) return toast(error.message, 'bad');
    m.close(); done();
  };
}

// ---------------- CSV import ----------------
function openImport(done) {
  const accs = state.accounts.filter((a) => !a.archived && ['current', 'savings', 'credit'].includes(a.account_type));
  if (!accs.length) { toast('Add a current or savings account first', 'bad'); return; }
  let rows = null; let map = null; let fileName = '';
  const m = modal(`<h2>Import bank CSV</h2>
    <p class="muted small">Download a CSV (or "spreadsheet") export from your bank's app or website, then choose it here. Only the date, description and amount are kept. Account numbers in the file are ignored. Re-importing the same file won't create duplicates.</p>
    <label>Which account is this from?<select id="imp-acc">${accs.map((a) => opt(a.id, `${a.name} (${a.currency})`, state.accountId === a.id)).join('')}</select></label>
    <label class="drop">Choose CSV file<input type="file" id="imp-file" accept=".csv,text/csv,.txt"></label>
    <div id="imp-map"></div>`, { wide: true });

  const accSel = $('#imp-acc', m.el);
  $('#imp-file', m.el).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    fileName = file.name;
    rows = parseRows(await readFileText(file));
    const saved = accById(accSel.value)?.csv_mapping;
    const detected = detectMapping(rows);
    map = saved && rows[saved.headerRow] && saved.date && rows[saved.headerRow].includes(saved.date) ? saved : detected;
    drawMapping();
  };

  function drawMapping() {
    const headers = rows[map.headerRow] || [];
    const hOpts = (sel, none = true) => (none ? opt('', '—', !sel) : '') + headers.map((h) => opt(h, h.replace(/^#/, ''), sel === h)).join('');
    const acc = accById(accSel.value);
    const { rows: parsed, skipped } = applyMapping(rows, map, acc.currency);
    $('#imp-map', m.el).innerHTML = `
      <details ${parsed.length ? '' : 'open'}><summary>Column matching ${parsed.length ? '(detected automatically)' : '(please check)'}</summary>
      <div class="map-grid">
        <label>Header row<input type="number" min="1" id="m-hr" value="${map.headerRow + 1}"></label>
        <label>Date column<select id="m-date">${hOpts(map.date, false)}</select></label>
        <label>Date format<select id="m-df">${opt('dmy', 'Day/Month/Year', map.dateFmt === 'dmy')}${opt('ymd', 'Year-Month-Day', map.dateFmt === 'ymd')}${opt('mdy', 'Month/Day/Year', map.dateFmt === 'mdy')}</select></label>
        <label>Description column(s)<select id="m-desc" multiple size="4">${headers.map((h) => opt(h, h.replace(/^#/, ''), (map.desc || []).includes(h))).join('')}</select></label>
        <label>Amount (one column)<select id="m-amt">${hOpts(map.amount)}</select></label>
        <label>…or Money out column<select id="m-deb">${hOpts(map.debit)}</select></label>
        <label>…and Money in column<select id="m-cred">${hOpts(map.credit)}</select></label>
        <label>Currency column<select id="m-cur">${hOpts(map.currency)}</select></label>
        <label class="check"><input type="checkbox" id="m-inv" ${map.invert ? 'checked' : ''}> Flip signs (if spending shows as positive)</label>
      </div></details>
      <h3>${parsed.length} transactions found${skipped.length ? ` <span class="muted small">(${skipped.length} rows skipped, e.g. blank or summary lines)</span>` : ''}</h3>
      <table class="tbl compact"><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th>Will be sorted as</th></tr></thead><tbody>
      ${parsed.slice(0, 8).map((r) => { const a = autoCategory(r.description); return `<tr><td class="nowrap">${niceDate(r.date)}</td><td>${esc(r.description)}</td><td class="r nowrap">${fmt(r.amount, r.currency, { sign: true })}</td><td class="muted">${a.categoryId ? esc(catById(a.categoryId)?.name) : 'you choose'}</td></tr>`; }).join('')}
      </tbody></table>
      <div class="row end"><button class="btn primary" id="imp-go" ${parsed.length ? '' : 'disabled'}>Import ${parsed.length} transactions</button></div>`;

    const bind = (id, fn) => { $(id, m.el).onchange = (e) => { fn(e.target); drawMapping(); }; };
    bind('#m-hr', (el) => { map = detectMapping(rows, Math.min(rows.length - 1, Math.max(0, el.value - 1))); });
    bind('#m-date', (el) => { map.date = el.value; });
    bind('#m-df', (el) => { map.dateFmt = el.value; });
    bind('#m-desc', (el) => { map.desc = [...el.selectedOptions].map((o) => o.value); });
    bind('#m-amt', (el) => { map.amount = el.value || null; });
    bind('#m-deb', (el) => { map.debit = el.value || null; });
    bind('#m-cred', (el) => { map.credit = el.value || null; });
    bind('#m-cur', (el) => { map.currency = el.value || null; });
    bind('#m-inv', (el) => { map.invert = el.checked; });
    $('#imp-go', m.el).onclick = () => runImport(acc, parsed);
  }
  accSel.onchange = () => { if (rows) drawMapping(); };

  async function runImport(acc, parsed) {
    const btn = $('#imp-go', m.el); btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const { data: imp, error: e1 } = await sb.from('imports').insert({ account_id: acc.id, file_name: fileName, row_count: parsed.length }).select().single();
      if (e1) throw e1;
      const seen = {};
      const out = [];
      for (const r of parsed) {
        const base = `${acc.id}|${r.date}|${r.amount}|${r.description}`;
        seen[base] = (seen[base] || 0) + 1; // identical rows on the same day stay distinct
        const a = autoCategory(r.description);
        out.push({
          account_id: acc.id, txn_date: r.date, description: r.description, amount: r.amount, currency: r.currency,
          payee_key: a.key, category_id: a.categoryId, auto_categorised: !!a.categoryId, import_id: imp.id,
          dedupe_hash: await sha256(`${base}|${seen[base]}`),
        });
      }
      let added = 0;
      for (let i = 0; i < out.length; i += 500) {
        const { data, error } = await sb.from('transactions').upsert(out.slice(i, i + 500), { onConflict: 'user_id,dedupe_hash', ignoreDuplicates: true }).select('id');
        if (error) throw error;
        added += data.length;
      }
      await sb.from('bank_accounts').update({ csv_mapping: map }).eq('id', acc.id);
      await loadCore();
      const auto = out.filter((o) => o.category_id).length;
      m.close();
      toast(`Imported ${added} new transaction${added === 1 ? '' : 's'}${out.length - added ? ` (${out.length - added} already here)` : ''}. ${auto} sorted automatically.`);
      refreshInboxCount();
      done();
      if (out.length - auto > 0) (await import('./inbox.js')).openInbox();
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; btn.textContent = 'Try again'; }
  }
}
