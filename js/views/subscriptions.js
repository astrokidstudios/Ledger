import { sb, state, loadCore, fetchTxns, monthlySubCost, base, catById, accById, nextDue } from '../db.js';
import { esc, fmt, opt, modal, toast, confirmBox, niceDate, today, addMonths, addDays, periodFor, $, $$ } from '../util.js';

const CYCLES = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly' };

async function suggestions() {
  const since = addMonths(today(), -6);
  const txns = await fetchTxns({ from: since });
  const known = new Set(state.subs.map((s) => s.payee_match).filter(Boolean));
  const g = {};
  for (const t of txns) {
    if (Number(t.amount) >= 0 || !t.payee_key || known.has(t.payee_key)) continue;
    const c = catById(t.category_id);
    if (c && c.kind !== 'expense') continue;
    (g[t.payee_key] ||= []).push(t);
  }
  const out = [];
  for (const [key, ts] of Object.entries(g)) {
    const months = new Set(ts.map((t) => periodFor(t.txn_date, 1).key));
    if (months.size < 3) continue;
    const amts = ts.map((t) => -Number(t.amount));
    const avg = amts.reduce((a, b) => a + b, 0) / amts.length;
    const spread = Math.max(...amts) - Math.min(...amts);
    if (spread > avg * 0.2 || ts.length > months.size * 1.5) continue; // too variable or too frequent: probably not a subscription
    const last = ts[0];
    out.push({ key, name: last.description, amount: Math.round(avg * 100) / 100, currency: last.currency, last: last.txn_date, account_id: last.account_id, category_id: last.category_id });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export async function renderSubscriptions(view) {
  const B = base();
  const listed = state.subs.filter((s) => !s.ignored);
  const active = listed.filter((s) => s.active);
  const monthly = active.reduce((s, x) => s + monthlySubCost(x), 0);
  const sugg = await suggestions();

  view.innerHTML = `
  <div class="page-head"><h1>Subscriptions & regular payments</h1><button class="btn primary" id="add">+ Add</button></div>
  <div class="tiles">
    <div class="tile"><div class="k">Per month</div><div class="v">${fmt(monthly, B)}</div></div>
    <div class="tile"><div class="k">Per year</div><div class="v">${fmt(monthly * 12, B)}</div></div>
    <div class="tile"><div class="k">Active</div><div class="v">${active.length}</div></div>
  </div>
  ${sugg.length ? `<section class="card accent"><h3>Spotted in your transactions</h3><p class="muted small">These look like regular payments. Add the ones that are subscriptions.</p>
    ${sugg.map((s, i) => `<div class="row between li"><span>${esc(s.name)} <span class="muted small">~${fmt(s.amount, s.currency)} monthly · last ${niceDate(s.last)}</span></span>
      <span class="row"><button class="btn small" data-sugg="${i}">Add</button><button class="btn ghost small" data-ignore="${i}">Not a subscription</button></span></div>`).join('')}
  </section>` : ''}
  <section class="card flush">
    ${listed.length ? `<table class="tbl"><thead><tr><th>Name</th><th>How often</th><th>Next payment</th><th>Account</th><th class="r">Amount</th><th class="r">Per month</th><th></th></tr></thead><tbody>
    ${listed.slice().sort((a, b) => (nextDue(a) || '9').localeCompare(nextDue(b) || '9')).map((s) => `<tr class="${s.active ? '' : 'muted'}">
      <td><strong>${esc(s.name)}</strong>${s.active ? '' : ' <span class="tag">cancelled</span>'}</td><td>${CYCLES[s.cycle]}</td>
      <td>${niceDate(nextDue(s)) || '—'}</td><td class="muted small">${esc(accById(s.account_id)?.name || '')}</td>
      <td class="r">${fmt(s.amount, s.currency)}</td><td class="r muted">${s.active ? fmt(monthlySubCost(s), B) : '—'}</td>
      <td><button class="icon-btn" data-edit="${s.id}" aria-label="Edit">✎</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty"><p>No subscriptions yet. Add them here, or import a few months of transactions and Ledger will spot them for you.</p></div>'}
  </section>`;

  const rerender = () => renderSubscriptions(view);
  $('#add').onclick = () => editSub(null, rerender);
  $$('[data-edit]', view).forEach((b) => { b.onclick = () => editSub(state.subs.find((s) => s.id === b.dataset.edit), rerender); });
  $$('[data-sugg]', view).forEach((b) => {
    const s = sugg[b.dataset.sugg];
    b.onclick = () => editSub({ name: s.name, payee_match: s.key, amount: s.amount, currency: s.currency, cycle: 'monthly', next_date: addMonths(s.last, 1), account_id: s.account_id, category_id: s.category_id || state.categories.find((c) => c.name === 'Subscriptions')?.id, active: true }, rerender, true);
  });
  $$('[data-ignore]', view).forEach((b) => {
    const s = sugg[b.dataset.ignore];
    b.onclick = async () => { // remember as ignored by storing an inactive entry
      await sb.from('subscriptions').insert({ name: s.name, payee_match: s.key, amount: s.amount, currency: s.currency, active: false, ignored: true });
      await loadCore(); rerender();
    };
  });
}

function editSub(s, done, isNew = !s?.id) {
  const m = modal(`<h2>${isNew ? 'Add' : 'Edit'} subscription</h2>
  <form id="sf" class="form">
    <label>Name<input name="name" required value="${esc(s?.name || '')}" placeholder="e.g. Netflix, Adobe, Gym"></label>
    <div class="row2">
      <label>Amount<input type="number" step="0.01" name="amount" required value="${s?.amount ?? ''}"></label>
      <label>Currency<select name="currency">${['GBP', 'PLN', 'EUR', 'USD'].map((c) => opt(c, c, (s?.currency || 'GBP') === c)).join('')}</select></label>
    </div>
    <div class="row2">
      <label>How often<select name="cycle">${Object.entries(CYCLES).map(([k, v]) => opt(k, v, (s?.cycle || 'monthly') === k)).join('')}</select></label>
      <label>Next payment<input type="date" name="next_date" value="${s?.next_date || ''}"></label>
    </div>
    <div class="row2">
      <label>Paid from<select name="account_id">${opt('', '—', !s?.account_id)}${state.accounts.map((a) => opt(a.id, a.name, s?.account_id === a.id)).join('')}</select></label>
      <label>Category<select name="category_id">${opt('', '—', !s?.category_id)}${state.categories.filter((c) => c.kind === 'expense').map((c) => opt(c.id, c.name, s?.category_id === c.id)).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="active" ${s?.active === false ? '' : 'checked'}> Active (untick when cancelled)</label>
    <div class="row between">${!isNew ? '<button type="button" class="btn danger ghost" id="del">Delete</button>' : '<span></span>'}<button class="btn primary">Save</button></div>
  </form>`);
  $('#sf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const row = { name: d.name.trim(), amount: Number(d.amount), currency: d.currency, cycle: d.cycle, next_date: d.next_date || null, account_id: d.account_id || null, category_id: d.category_id || null, active: !!d.active, payee_match: s?.payee_match || null };
    const { error } = isNew ? await sb.from('subscriptions').insert(row) : await sb.from('subscriptions').update(row).eq('id', s.id);
    if (error) return toast(error.message, 'bad');
    await loadCore(); m.close(); toast('Saved'); done();
  };
  const del = $('#del', m.el);
  if (del) del.onclick = async () => {
    if (!(await confirmBox('Delete this subscription?'))) return;
    await sb.from('subscriptions').delete().eq('id', s.id);
    await loadCore(); m.close(); done();
  };
}
