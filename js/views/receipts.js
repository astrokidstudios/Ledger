import { sb, state, fetchTxns, accById } from '../db.js';
import { esc, fmt, opt, modal, toast, confirmBox, niceDate, today, addDays, download, toCSV, $, $$ } from '../util.js';

const f = { scope: '', from: `${today().slice(0, 4)}-01-01`, to: today() };

export async function renderReceipts(view) {
  let q = sb.from('receipts').select('*').order('receipt_date', { ascending: false, nullsFirst: false }).gte('receipt_date', f.from).lte('receipt_date', f.to);
  if (f.scope) q = q.eq('scope', f.scope);
  const { data: receipts, error } = await q;
  if (error) throw error;
  const { data: undated } = await sb.from('receipts').select('*').is('receipt_date', null);
  const list = [...(undated || []), ...receipts];

  view.innerHTML = `
  <div class="page-head"><h1>Receipts</h1>
    <label class="btn primary">+ Upload receipts<input type="file" id="up" accept="image/*,application/pdf" multiple hidden></label></div>
  <div class="filters card">
    <label class="small">From <input type="date" id="from" value="${f.from}"></label>
    <label class="small">To <input type="date" id="to" value="${f.to}"></label>
    <select id="scope">${opt('', 'Business & personal', !f.scope)}${opt('business', 'Business only', f.scope === 'business')}${opt('personal', 'Personal only', f.scope === 'personal')}</select>
    <button class="btn" id="zip" ${list.length ? '' : 'disabled'}>Download ZIP for accountant</button>
  </div>
  <p class="muted small">Stored privately. Only you can open them, through short-lived links. The ZIP includes every receipt in this date range plus a spreadsheet index.</p>
  <div class="receipts">
    ${list.map((r) => `<div class="rc" data-id="${r.id}">
      <div class="rc-thumb" data-open="${r.id}">${/\.pdf$/i.test(r.storage_path) ? '<span class="pdf">PDF</span>' : '<span class="muted small">Loading…</span>'}</div>
      <div class="rc-meta"><strong>${esc(r.merchant || r.file_name || 'Receipt')}</strong>
        <div class="muted small">${r.receipt_date ? niceDate(r.receipt_date) : 'No date'} · ${r.scope}${r.amount != null ? ` · ${Number(r.amount).toFixed(2)}` : ''}</div>
        ${r.transaction_id ? '<span class="tag good">linked</span>' : '<span class="tag">not linked</span>'}
      </div>
      <button class="icon-btn" data-edit="${r.id}" aria-label="Edit">✎</button>
    </div>`).join('') || '<div class="empty card"><p>No receipts in this range. Upload photos or PDFs. On your phone you can take a photo directly.</p></div>'}
  </div>`;

  const rerender = () => renderReceipts(view);
  $('#from').onchange = (e) => { f.from = e.target.value; rerender(); };
  $('#to').onchange = (e) => { f.to = e.target.value; rerender(); };
  $('#scope').onchange = (e) => { f.scope = e.target.value; rerender(); };
  $('#up').onchange = (e) => upload([...e.target.files], rerender);
  $('#zip').onclick = () => exportZip(list);
  $$('[data-edit]', view).forEach((b) => { b.onclick = () => editReceipt(list.find((r) => r.id === b.dataset.edit), rerender); });
  $$('[data-open]', view).forEach((b) => { b.onclick = () => openFile(list.find((r) => r.id === b.dataset.open)); });

  // thumbnails via short-lived signed URLs
  const imgs = list.filter((r) => !/\.pdf$/i.test(r.storage_path));
  if (imgs.length) {
    const { data } = await sb.storage.from('receipts').createSignedUrls(imgs.map((r) => r.storage_path), 300);
    (data || []).forEach((d, i) => {
      const el = $(`[data-open="${imgs[i].id}"]`, view);
      if (el && d.signedUrl) { el.innerHTML = ''; const im = new Image(); im.alt = 'Receipt'; im.src = d.signedUrl; el.appendChild(im); }
    });
  }
}

async function upload(files, done) {
  if (!files.length) return;
  const uid = state.user.id;
  let ok = 0;
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) { toast(`${file.name} is over 10 MB`, 'bad'); continue; }
    const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80);
    const path = `${uid}/${today().slice(0, 7)}/${crypto.randomUUID()}-${safe}`;
    const { error } = await sb.storage.from('receipts').upload(path, file, { contentType: file.type });
    if (error) { toast(error.message, 'bad'); continue; }
    const { data: row, error: e2 } = await sb.from('receipts').insert({ storage_path: path, file_name: file.name, receipt_date: today(), scope: state.scope === 'personal' ? 'personal' : 'business' }).select().single();
    if (e2) { toast(e2.message, 'bad'); continue; }
    ok++;
    if (files.length === 1) { await done(); editReceipt(row, done); return; }
  }
  toast(`Uploaded ${ok} receipt${ok === 1 ? '' : 's'}. Tap ✎ on each to add details.`);
  done();
}

async function openFile(r) {
  const { data } = await sb.storage.from('receipts').createSignedUrl(r.storage_path, 120);
  if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener');
}

async function editReceipt(r, done) {
  // candidate transactions within ±10 days to link to
  const d = r.receipt_date || today();
  const near = await fetchTxns({ from: addDays(d, -10), to: addDays(d, 10) });
  const cands = near.filter((t) => Number(t.amount) < 0).sort((a, b) => {
    if (r.amount == null) return 0;
    return Math.abs(-Number(a.amount) - r.amount) - Math.abs(-Number(b.amount) - r.amount);
  }).slice(0, 30);
  const m = modal(`<h2>Receipt details</h2>
  <form id="rf" class="form">
    <label>Shop / supplier<input name="merchant" value="${esc(r.merchant || '')}"></label>
    <div class="row2">
      <label>Total<input type="number" step="0.01" name="amount" value="${r.amount ?? ''}"></label>
      <label>Date<input type="date" name="receipt_date" value="${r.receipt_date || ''}"></label>
    </div>
    <label>Business or personal<select name="scope">${opt('business', 'Business', r.scope === 'business')}${opt('personal', 'Personal', r.scope === 'personal')}</select></label>
    <label>Match to a transaction<select name="transaction_id">${opt('', '— not linked —', !r.transaction_id)}${cands.map((t) => opt(t.id, `${niceDate(t.txn_date)} · ${t.description.slice(0, 40)} · ${fmt(-t.amount, t.currency)}`, r.transaction_id === t.id)).join('')}</select></label>
    <label>Notes<input name="notes" value="${esc(r.notes || '')}"></label>
    <div class="row between"><button type="button" class="btn danger ghost" id="del">Delete</button><button class="btn primary">Save</button></div>
  </form>`);
  $('#rf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.from('receipts').update({ merchant: v.merchant || null, amount: v.amount === '' ? null : Number(v.amount), receipt_date: v.receipt_date || null, scope: v.scope, transaction_id: v.transaction_id || null, notes: v.notes || null }).eq('id', r.id);
    if (error) return toast(error.message, 'bad');
    m.close(); done();
  };
  $('#del', m.el).onclick = async () => {
    if (!(await confirmBox('Delete this receipt permanently?'))) return;
    await sb.storage.from('receipts').remove([r.storage_path]);
    await sb.from('receipts').delete().eq('id', r.id);
    m.close(); done();
  };
}

async function exportZip(list) {
  toast(`Preparing ${list.length} receipts…`);
  const zip = new window.JSZip();
  const txIds = list.map((r) => r.transaction_id).filter(Boolean);
  const { data: txs } = txIds.length ? await sb.from('transactions').select('*').in('id', txIds) : { data: [] };
  const index = [];
  for (const r of list) {
    const { data: blob, error } = await sb.storage.from('receipts').download(r.storage_path);
    if (error) continue;
    const ext = (r.storage_path.split('.').pop() || 'jpg').toLowerCase();
    const name = `${r.receipt_date || 'undated'}_${(r.merchant || 'receipt').replace(/[^\w-]+/g, '_').slice(0, 40)}_${r.id.slice(0, 6)}.${ext}`;
    zip.file(`${r.scope}/${name}`, blob);
    const t = txs?.find((x) => x.id === r.transaction_id);
    index.push({ file: `${r.scope}/${name}`, date: r.receipt_date || '', supplier: r.merchant || '', total: r.amount ?? '', scope: r.scope, bank_date: t?.txn_date || '', bank_description: t?.description || '', bank_amount: t ? -t.amount : '', currency: t?.currency || '', account: t ? accById(t.account_id)?.name || '' : '', notes: r.notes || '' });
  }
  zip.file('index.csv', toCSV(index));
  const out = await zip.generateAsync({ type: 'blob' });
  download(`receipts_${f.from}_to_${f.to}.zip`, out);
}
