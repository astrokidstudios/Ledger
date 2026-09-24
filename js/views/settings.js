import { sb, state, loadCore, catById } from '../db.js';
import { esc, opt, modal, toast, confirmBox, download, today, $, $$ } from '../util.js';
import { signOut } from '../app.js';

const GROUPS = { essentials: 'Essentials', lifestyle: 'Lifestyle', business: 'Business costs', tax: 'Tax', income: 'Income', transfer: 'Transfer', savings: 'Savings' };

export async function renderSettings(view) {
  const s = state.settings;
  const { data: mf } = await sb.auth.mfa.listFactors();
  const totp = mf?.totp?.find((f) => f.status === 'verified');

  view.innerHTML = `
  <div class="page-head"><h1>Settings</h1><button class="btn ghost" id="so">Sign out</button></div>
  <nav class="mobile-more"><a href="#/accounts" class="btn">Accounts</a><a href="#/receipts" class="btn">Receipts</a></nav>

  <section class="card">
    <h3>Security</h3>
    <div class="row between li"><div><strong>Two-step sign-in</strong><div class="muted small">${totp ? 'On. A code from your authenticator app is needed every time you sign in.' : 'Strongly recommended. Uses an app like Google Authenticator, Microsoft Authenticator or 1Password.'}</div></div>
      ${totp ? '<span class="tag good">On</span>' : '<button class="btn primary" id="mfa-on">Turn on</button>'}</div>
    <div class="row between li"><div><strong>Password</strong><div class="muted small">Signed in as ${esc(state.user.email)}</div></div><button class="btn" id="pw">Change</button></div>
    <form id="gen" class="row between li"><div><strong>Auto sign-out</strong><div class="muted small">After this many minutes without activity. Closing the tab also signs you out.</div></div>
      <input type="number" min="2" max="120" name="idle_minutes" value="${s.idle_minutes}" class="narrow"></form>
  </section>

  <section class="card">
    <h3>Money</h3>
    <form id="money" class="form">
      <div class="row2">
        <label>Main currency<select name="base_currency">${['GBP', 'PLN', 'EUR'].map((c) => opt(c, c, s.base_currency === c)).join('')}</select></label>
        <label>Budget month starts on day<input type="number" min="1" max="28" name="month_start_day" value="${s.month_start_day}"></label>
      </div>
      <div class="row2">
        <label>Expected monthly income (personal, after tax)<input type="number" step="1" name="expected_monthly_income" value="${s.expected_monthly_income ?? ''}" placeholder="auto from history"></label>
        <label>Monthly safety buffer<input type="number" step="1" name="monthly_buffer" value="${s.monthly_buffer ?? 0}"></label>
      </div>
      <label>Exchange rates (value of 1 unit in GBP)</label>
      <div class="row2">${['PLN', 'EUR', 'USD'].map((c) => `<label class="small">${c}<input type="number" step="0.0001" name="fx_${c}" value="${s.fx_rates?.[c] ?? ''}"></label>`).join('')}</div>
      <div class="row between"><button type="button" class="btn ghost small" id="fx">Fetch today's rates</button><button class="btn primary">Save</button></div>
    </form>
  </section>

  <section class="card">
    <div class="row between"><h3>Categories</h3><button class="btn small" id="add-cat">+ Add</button></div>
    <table class="tbl compact"><thead><tr><th>Name</th><th>Type</th><th>Group</th><th>For</th><th>Tax-deductible</th><th></th></tr></thead><tbody>
    ${state.categories.map((c) => `<tr><td>${esc(c.name)}</td><td class="muted">${c.kind}</td><td class="muted">${GROUPS[c.cat_group] || c.cat_group}</td><td class="muted">${c.scope}</td><td>${c.tax_deductible ? '✓' : ''}</td><td><button class="icon-btn" data-cat="${c.id}">✎</button></td></tr>`).join('')}
    </tbody></table>
  </section>

  <section class="card">
    <h3>Auto-sort rules <span class="muted small">(${state.rules.length})</span></h3>
    <p class="muted small">Learned when you categorise a payment. Delete one to stop it sorting automatically.</p>
    ${state.rules.slice().sort((a, b) => a.match_text.localeCompare(b.match_text)).map((r) => `<div class="row between li"><span>“${esc(r.match_text)}” → ${esc(catById(r.category_id)?.name || '?')}</span><button class="icon-btn" data-rule="${r.id}" aria-label="Delete rule">×</button></div>`).join('') || '<p class="muted">None yet.</p>'}
  </section>

  <section class="card">
    <h3>Your data</h3>
    <div class="row between li"><div>Download everything (accounts, transactions, goals, rules…) as a backup file.</div><button class="btn" id="backup">Download backup</button></div>
  </section>`;

  const rerender = () => renderSettings(view);
  $('#so').onclick = signOut;
  const on = $('#mfa-on'); if (on) on.onclick = () => enrollMfa(rerender);
  $('#pw').onclick = changePassword;
  $('#gen input').onchange = async (e) => { await save({ idle_minutes: Math.min(120, Math.max(2, Number(e.target.value))) }); toast('Saved. Takes effect next sign-in.'); };
  $('#money').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const fx = { ...(s.fx_rates || {}), GBP: 1 };
    ['PLN', 'EUR', 'USD'].forEach((c) => { if (d[`fx_${c}`]) fx[c] = Number(d[`fx_${c}`]); });
    await save({ base_currency: d.base_currency, month_start_day: Number(d.month_start_day), expected_monthly_income: d.expected_monthly_income === '' ? null : Number(d.expected_monthly_income), monthly_buffer: Number(d.monthly_buffer || 0), fx_rates: fx });
    toast('Saved'); rerender();
  };
  $('#fx').onclick = async () => {
    try {
      const r = await fetch('https://api.frankfurter.dev/v1/latest?base=GBP&symbols=PLN,EUR,USD').then((x) => x.json());
      const fx = { GBP: 1 }; Object.entries(r.rates).forEach(([k, v]) => { fx[k] = Math.round((1 / v) * 10000) / 10000; });
      await save({ fx_rates: fx }); toast(`Rates updated (${r.date})`); rerender();
    } catch { toast('Could not fetch rates right now', 'bad'); }
  };
  $('#add-cat').onclick = () => editCat(null, rerender);
  $$('[data-cat]', view).forEach((b) => { b.onclick = () => editCat(catById(b.dataset.cat), rerender); });
  $$('[data-rule]', view).forEach((b) => { b.onclick = async () => { await sb.from('category_rules').delete().eq('id', b.dataset.rule); await loadCore(); rerender(); }; });
  $('#backup').onclick = backup;
}

async function save(patch) {
  const { error } = await sb.from('settings').update(patch).eq('user_id', state.user.id);
  if (error) { toast(error.message, 'bad'); throw error; }
  await loadCore();
}

function editCat(c, done) {
  const m = modal(`<h2>${c ? 'Edit' : 'New'} category</h2>
  <form id="cf" class="form">
    <label>Name<input name="name" required value="${esc(c?.name || '')}"></label>
    <div class="row2">
      <label>Type<select name="kind">${['expense', 'income', 'transfer'].map((k) => opt(k, k === 'expense' ? 'Spending' : k === 'income' ? 'Income' : 'Transfer / savings', (c?.kind || 'expense') === k)).join('')}</select></label>
      <label>Group<select name="cat_group">${Object.entries(GROUPS).map(([k, v]) => opt(k, v, (c?.cat_group || 'lifestyle') === k)).join('')}</select></label>
    </div>
    <div class="row2">
      <label>Used for<select name="scope">${opt('personal', 'Personal', c?.scope === 'personal' || !c)}${opt('business', 'Business', c?.scope === 'business')}${opt('both', 'Both', c?.scope === 'both')}</select></label>
      <label class="check"><input type="checkbox" name="tax_deductible" ${c?.tax_deductible ? 'checked' : ''}> Business tax-deductible</label>
    </div>
    <p class="muted small">“Essentials” are treated as fixed costs in your budget; “Lifestyle” gets a flexible allowance.</p>
    <div class="row between">${c ? '<button type="button" class="btn danger ghost" id="del">Delete</button>' : '<span></span>'}<button class="btn primary">Save</button></div>
  </form>`);
  $('#cf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const row = { name: d.name.trim(), kind: d.kind, cat_group: d.cat_group, scope: d.scope, tax_deductible: !!d.tax_deductible };
    const { error } = c ? await sb.from('categories').update(row).eq('id', c.id) : await sb.from('categories').insert(row);
    if (error) return toast(error.message, 'bad');
    await loadCore(); m.close(); done();
  };
  const del = $('#del', m.el);
  if (del) del.onclick = async () => {
    if (!(await confirmBox(`Delete “${c.name}”? Transactions in it become uncategorised.`))) return;
    await sb.from('categories').delete().eq('id', c.id);
    await loadCore(); m.close(); done();
  };
}

async function enrollMfa(done) {
  // clear any half-finished attempts first
  const { data: existing } = await sb.auth.mfa.listFactors();
  for (const f of existing?.all || []) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Ledger ${Date.now()}` });
  if (error) return toast(error.message, 'bad');
  const m = modal(`<h2>Turn on two-step sign-in</h2>
    <ol class="small"><li>Open your authenticator app and scan this code.</li><li>Enter the 6-digit code it shows.</li></ol>
    <div class="qr"><img alt="QR code" src="${esc(data.totp.qr_code)}"></div>
    <details class="small"><summary>Can't scan? Enter this key instead</summary><code class="secret">${esc(data.totp.secret)}</code></details>
    <form id="mv" class="form"><input name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" required class="code-input" autocomplete="one-time-code">
    <button class="btn primary full">Verify & turn on</button></form>`);
  $('#mv', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: new FormData(e.target).get('code') });
    if (e2) return toast('That code did not work. Try the newest one.', 'bad');
    m.close(); toast('Two-step sign-in is on'); done();
  };
}

function changePassword() {
  const m = modal(`<h2>Change password</h2><form id="pf" class="form">
    <label>New password (12+ characters)<input type="password" name="p1" minlength="12" required autocomplete="new-password"></label>
    <label>Repeat<input type="password" name="p2" minlength="12" required autocomplete="new-password"></label>
    <button class="btn primary full">Update</button></form>`);
  $('#pf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (d.p1 !== d.p2) return toast('Passwords do not match', 'bad');
    const { error } = await sb.auth.updateUser({ password: d.p1 });
    if (error) return toast(error.message, 'bad');
    m.close(); toast('Password updated');
  };
}

async function backup() {
  const tables = ['settings', 'bank_accounts', 'account_values', 'categories', 'category_rules', 'transactions', 'subscriptions', 'goals', 'receipts', 'imports'];
  const out = { exported_at: new Date().toISOString() };
  for (const t of tables) {
    const rows = []; let from = 0;
    for (;;) {
      const { data, error } = await sb.from(t).select('*').range(from, from + 999);
      if (error) return toast(error.message, 'bad');
      rows.push(...data); if (data.length < 1000) break; from += 1000;
    }
    out[t] = rows;
  }
  download(`ledger-backup-${today()}.json`, JSON.stringify(out, null, 2), 'application/json');
}
