import { sb, state, fetchTxns, visibleAccountIds, catById, accById, learnRule, autoCategory, currentPeriod, startDay, loadCore } from '../db.js';
import { esc, fmt, niceDate, opt, toast, modal, confirmBox, download, toCSV, sha256, today, shiftPeriod, periodLabel, payeeKey, $, $$ } from '../util.js';
import { readFileText, parseRows, detectMapping, applyMapping } from '../csv.js';
import { hintCategory } from '../hints.js';
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
      <button class="btn primary" id="import">Import PDF/CSV</button>
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
    : `<div class="empty"><p>No transactions here yet.</p>${state.accounts.length ? '<p class="muted">Import a PDF statement or CSV from your bank to get started.</p>' : '<a class="btn" href="#/accounts">Add an account first</a>'}</div>`}
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

// ---------------- statement import (CSV or PDF) ----------------
function guess(r, acc) {
  const a = autoCategory(r.description); // a rule you've taught Ledger always wins
  if (a.categoryId) return { ...a, how: 'learned' };
  const h = hintCategory(r, acc, state.categories);
  return { key: a.key, categoryId: h?.id || null, how: h ? 'guess' : null };
}

function openImport(done) {
  const accs = state.accounts.filter((a) => !a.archived && ['current', 'savings', 'credit'].includes(a.account_type));
  if (!accs.length) { toast('Add a current or savings account first', 'bad'); return; }
  let rows = null; let map = null; let fileName = ''; let pdf = null;
  const m = modal(`<h2>Import PDF or CSV statement</h2>
    <p class="muted small">Choose a PDF statement or a CSV export from your bank. Only the date, description and amount are kept, never account numbers or addresses. Re-importing the same statement won't create duplicates.</p>
    <label>Which account is this from?<select id="imp-acc">${accs.map((a) => opt(a.id, `${a.name} (${a.currency})`, state.accountId === a.id)).join('')}</select></label>
    <label class="drop">Choose PDF or CSV file<input type="file" id="imp-file" accept=".pdf,application/pdf,.csv,text/csv,.txt"></label>
    <div id="imp-map"></div>`, { wide: true });

  const accSel = $('#imp-acc', m.el);
  $('#imp-file', m.el).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    fileName = file.name;
    const box = $('#imp-map', m.el);
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      box.innerHTML = '<div class="loading">Reading statement…</div>';
      try {
        const { readPdfStatement } = await import('../pdf-import.js');
        pdf = await readPdfStatement(file, accById(accSel.value).currency);
      } catch (err) {
        console.error(err);
        box.innerHTML = `<p class="err">Couldn't read that PDF (${esc(err.message)}). If it's a scanned image rather than a downloaded statement, export a CSV from your bank instead.</p>`;
        return;
      }
      rows = null; drawPdf(); return;
    }
    pdf = null;
    rows = parseRows(await readFileText(file));
    const saved = accById(accSel.value)?.csv_mapping;
    const detected = detectMapping(rows);
    map = saved && rows[saved.headerRow] && saved.date && rows[saved.headerRow].includes(saved.date) ? saved : detected;
    drawMapping();
  };

  const previewTable = (parsed, acc, limit) => `
    <div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th>Sorted as</th></tr></thead><tbody>
    ${parsed.slice(0, limit).map((r) => { const g = guess(r, acc); return `<tr><td class="nowrap">${niceDate(r.date)}</td><td>${esc(r.description)}${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td><td class="r nowrap ${r.amount > 0 ? 'pos' : ''}">${fmt(r.amount, r.currency, { sign: true })}</td><td class="${g.categoryId ? '' : 'muted'}">${g.categoryId ? `${esc(catById(g.categoryId)?.name)}${g.how === 'guess' ? ' <span class="auto">suggested</span>' : ''}` : 'you choose'}</td></tr>`; }).join('')}
    </tbody></table></div>${parsed.length > limit ? `<p class="muted small">…and ${parsed.length - limit} more.</p>` : ''}`;

  function drawPdf() {
    const acc = accById(accSel.value);
    const { rows: parsed, meta, check, currency } = pdf;
    const box = $('#imp-map', m.el);
    if (!parsed.length) {
      box.innerHTML = '<p class="err">No transactions found in this PDF. It may be a layout Ledger doesn\'t recognise yet, or a scanned image. A CSV export from the same bank will work.</p>';
      return;
    }
    const inN = parsed.filter((r) => r.amount > 0); const outN = parsed.filter((r) => r.amount < 0);
    const sorted = parsed.filter((r) => guess(r, acc).categoryId).length;
    box.innerHTML = `
      ${currency !== acc.currency ? `<p class="warn">This statement is in ${esc(currency)} but “${esc(acc.name)}” is a ${esc(acc.currency)} account. Check you picked the right account.</p>` : ''}
      <div class="flow">
        ${meta.from ? `<div><span class="muted small">Statement</span><strong>${niceDate(meta.from)} – ${niceDate(meta.to)}</strong></div>` : ''}
        <div><span class="muted small">Money in (${inN.length})</span><strong class="pos">${fmt(check.inSum, currency)}</strong></div>
        <div><span class="muted small">Money out (${outN.length})</span><strong>${fmt(check.outSum, currency)}</strong></div>
        <div class="eq"><span class="muted small">Sorted automatically</span><strong>${sorted} of ${parsed.length}</strong></div>
      </div>
      ${check.checks.length ? `<p class="small">${check.ok ? '<span class="tag good">✓ Matches the statement</span> ' : '<span class="tag bad">Doesn\'t add up</span> '}${check.checks.map((c) => `${c.ok ? '✓' : '✗'} ${esc(c.label)}${!c.ok && c.expected != null ? ` (found ${fmt(c.found, currency)}, statement says ${fmt(c.expected, currency)})` : ''}${!c.ok && c.breaks ? ` (${c.breaks} gap${c.breaks > 1 ? 's' : ''})` : ''}`).join(' · ')}</p>` : ''}
      ${!check.ok && check.checks.length ? '<p class="warn small">Some lines may have been missed or misread. You can still import and fix them afterwards, or use a CSV export for this month.</p>' : ''}
      ${previewTable(parsed, acc, 12)}
      <div class="row end"><button class="btn primary" id="imp-go">Import ${parsed.length} transactions</button></div>`;
    $('#imp-go', m.el).onclick = () => runImport(acc, parsed);
  }

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
      ${previewTable(parsed, acc, 8)}
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
  accSel.onchange = () => { if (pdf) drawPdf(); else if (rows) drawMapping(); };

  async function runImport(acc, parsed) {
    const btn = $('#imp-go', m.el); btn.disabled = true; btn.textContent = 'Importing…';
    try {
      // Payments already in this account (e.g. imported earlier from a CSV)
      // are matched on date + amount and skipped, so PDF and CSV don't double up.
      const dates = parsed.map((r) => r.date).sort();
      const existing = await fetchTxns({ from: dates[0], to: dates[dates.length - 1], accountIds: [acc.id] });
      const have = {};
      for (const t of existing) { const k = `${t.txn_date}|${Math.round(Number(t.amount) * 100)}`; have[k] = (have[k] || 0) + 1; }
      const fresh = parsed.filter((r) => { const k = `${r.date}|${Math.round(r.amount * 100)}`; if (have[k] > 0) { have[k]--; return false; } return true; });
      const already = parsed.length - fresh.length;
      if (!fresh.length) { m.close(); toast(`All ${parsed.length} transactions are already in ${acc.name}.`); return; }

      const { data: imp, error: e1 } = await sb.from('imports').insert({ account_id: acc.id, file_name: fileName, row_count: fresh.length }).select().single();
      if (e1) throw e1;
      const seen = {};
      const out = [];
      for (const r of fresh) {
        const base = `${acc.id}|${r.date}|${r.amount}|${r.description}`;
        seen[base] = (seen[base] || 0) + 1; // identical rows on the same day stay distinct
        const g = guess(r, acc);
        out.push({
          account_id: acc.id, txn_date: r.date, description: r.description, amount: r.amount, currency: r.currency,
          notes: r.notes || null, payee_key: g.key, category_id: g.categoryId, auto_categorised: !!g.categoryId, import_id: imp.id,
          dedupe_hash: await sha256(`${base}|${seen[base]}`),
        });
      }
      let added = 0;
      for (let i = 0; i < out.length; i += 500) {
        const { data, error } = await sb.from('transactions').upsert(out.slice(i, i + 500), { onConflict: 'user_id,dedupe_hash', ignoreDuplicates: true }).select('id');
        if (error) throw error;
        added += data.length;
      }
      if (map && !pdf) await sb.from('bank_accounts').update({ csv_mapping: map }).eq('id', acc.id);
      await loadCore();
      const auto = out.filter((o) => o.category_id).length;
      const skippedDupes = already + (out.length - added);
      m.close();
      toast(`Imported ${added} new transaction${added === 1 ? '' : 's'}${skippedDupes ? ` (${skippedDupes} already here)` : ''}. ${auto} sorted automatically.`);
      refreshInboxCount();
      done();
      if (out.length - auto > 0) (await import('./inbox.js')).openInbox();
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; btn.textContent = 'Try again'; }
  }
}
