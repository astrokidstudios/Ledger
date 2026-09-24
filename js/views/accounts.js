import { sb, state, loadCore, accountBalances, toBase, base } from '../db.js';
import { esc, fmt, opt, modal, toast, confirmBox, niceDate, today, $, $$ } from '../util.js';
import { rebuild } from '../app.js';

const TYPES = { current: 'Current account', savings: 'Savings / ISA', investment: 'Investments', pension: 'Pension', credit: 'Credit card', other: 'Other asset / debt' };
const valued = (a) => ['investment', 'pension', 'other'].includes(a.account_type);

export async function renderAccounts(view) {
  const bal = await accountBalances();
  const B = base();
  const groups = ['personal', 'business'];
  const total = (sc) => state.accounts.filter((a) => !a.archived && a.scope === sc).reduce((s, a) => s + toBase(bal[a.id] || 0, a.currency), 0);

  view.innerHTML = `
  <div class="page-head"><h1>Accounts</h1><button class="btn primary" id="add">+ Add account</button></div>
  <p class="muted small">Give accounts nicknames (e.g. “Everyday”, “Business GBP”). <strong>Never enter account numbers, sort codes, card numbers or bank passwords</strong>. Ledger doesn't need them.</p>
  ${groups.map((sc) => {
    const accs = state.accounts.filter((a) => a.scope === sc && !a.archived);
    return `<section class="card">
      <div class="row between"><h3>${sc === 'personal' ? 'Personal' : 'Business'}</h3><strong>${fmt(total(sc), B)}</strong></div>
      ${accs.map((a) => `<div class="acc-row">
        <div><div><strong>${esc(a.name)}</strong> <span class="muted small">${esc(a.institution || '')}</span></div>
          <div class="muted small">${TYPES[a.account_type]} · ${a.currency}${valued(a) ? ` · value updated ${niceDate(state.values.filter((v) => v.account_id === a.id).slice(-1)[0]?.as_of) || 'never'}` : ''}</div></div>
        <div class="row"><strong class="${(bal[a.id] || 0) < 0 ? 'neg' : ''}">${fmt(bal[a.id] || 0, a.currency)}</strong>
          ${valued(a) ? `<button class="btn small" data-val="${a.id}">Update value</button>` : ''}
          <button class="icon-btn" data-edit="${a.id}" aria-label="Edit">✎</button></div>
      </div>`).join('') || '<p class="muted">None yet.</p>'}
    </section>`;
  }).join('')}
  ${state.accounts.some((a) => a.archived) ? `<details class="card"><summary>Archived accounts</summary>${state.accounts.filter((a) => a.archived).map((a) => `<div class="acc-row"><span>${esc(a.name)}</span><button class="icon-btn" data-edit="${a.id}">✎</button></div>`).join('')}</details>` : ''}`;

  const rerender = () => renderAccounts(view);
  $('#add').onclick = () => editAccount(null, rebuild);
  $$('[data-edit]', view).forEach((b) => { b.onclick = () => editAccount(state.accounts.find((a) => a.id === b.dataset.edit), rebuild); });
  $$('[data-val]', view).forEach((b) => { b.onclick = () => updateValue(state.accounts.find((a) => a.id === b.dataset.val), rerender); });
}

function editAccount(a, done) {
  const m = modal(`<h2>${a ? 'Edit' : 'Add'} account</h2>
  <form id="af" class="form">
    <label>Nickname<input name="name" required value="${esc(a?.name || '')}" placeholder="e.g. Everyday, Business GBP, ISA"></label>
    <label>Bank / provider (optional)<input name="institution" value="${esc(a?.institution || '')}" placeholder="e.g. the bank's name"></label>
    <div class="row2">
      <label>Personal or business<select name="scope">${opt('personal', 'Personal', a?.scope !== 'business')}${opt('business', 'Business', a?.scope === 'business')}</select></label>
      <label>Type<select name="account_type">${Object.entries(TYPES).map(([k, v]) => opt(k, v, (a?.account_type || 'current') === k)).join('')}</select></label>
    </div>
    <div class="row2">
      <label>Currency<select name="currency">${['GBP', 'PLN', 'EUR', 'USD'].map((c) => opt(c, c, (a?.currency || 'GBP') === c)).join('')}</select></label>
      <label>Balance before first imported transaction<input type="number" step="0.01" name="opening_balance" value="${a?.opening_balance ?? 0}"></label>
    </div>
    <p class="muted small">For investments and pensions, just use “Update value” whenever you check them. No transactions needed.</p>
    ${a ? `<label class="check"><input type="checkbox" name="archived" ${a.archived ? 'checked' : ''}> Archived (hidden, history kept)</label>` : ''}
    <div class="row between">${a ? '<button type="button" class="btn danger ghost" id="del">Delete</button>' : '<span></span>'}<button class="btn primary">Save</button></div>
  </form>`);
  $('#af', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const row = { name: d.name.trim(), institution: d.institution || null, scope: d.scope, account_type: d.account_type, currency: d.currency, opening_balance: Number(d.opening_balance || 0), archived: !!d.archived };
    const { error } = a ? await sb.from('bank_accounts').update(row).eq('id', a.id) : await sb.from('bank_accounts').insert(row);
    if (error) return toast(error.message, 'bad');
    await loadCore(); m.close(); toast('Saved'); done();
  };
  const del = $('#del', m.el);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Delete “${a.name}” and ALL its transactions? Archiving keeps the history instead.`))) return;
    const { error } = await sb.from('bank_accounts').delete().eq('id', a.id);
    if (error) return toast(error.message, 'bad');
    await loadCore(); m.close(); done();
  };
}

function updateValue(a, done) {
  const hist = state.values.filter((v) => v.account_id === a.id).slice().reverse();
  const m = modal(`<h2>${esc(a.name)} value</h2>
  <form id="vf" class="form"><div class="row2">
    <label>Value (${a.currency})<input type="number" step="0.01" name="value" required></label>
    <label>As of<input type="date" name="as_of" value="${today()}" required></label></div>
    <div class="row end"><button class="btn primary">Save</button></div></form>
  ${hist.length ? `<h3>History</h3>${hist.map((v) => `<div class="row between li"><span>${niceDate(v.as_of)}</span><span>${fmt(v.value, a.currency)}</span></div>`).join('')}` : ''}`);
  $('#vf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.from('account_values').insert({ account_id: a.id, value: Number(d.value), as_of: d.as_of });
    if (error) return toast(error.message, 'bad');
    await loadCore(); m.close(); done();
  };
}
