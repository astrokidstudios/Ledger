import { sb, state, loadCore, budgetPlan, base, toBase, accById, fetchTxns, startDay } from '../db.js';
import { esc, fmt, opt, modal, toast, confirmBox, niceDate, today, addMonths, $, $$ } from '../util.js';
import { lineChart } from './charts.js';

export async function renderPlan(view) {
  const B = base();
  const money = (v, o = { whole: true }) => fmt(v, B, o);
  const plan = await budgetPlan({ scope: 'personal' });

  // Forecast: savable balance over the next 12 months
  const personalLiquid = state.accounts.filter((a) => !a.archived && a.scope === 'personal' && ['current', 'savings'].includes(a.account_type));
  const startBal = personalLiquid.reduce((s, a) => s + toBase(plan.balances[a.id] || 0, a.currency), 0);
  const monthlyOut = plan.essentialsMonthly + plan.subsMonthly + plan.categories.reduce((s, c) => s + Math.max(c.allowance, 0), 0);
  const monthlyNetUsual = plan.income - plan.avgSpendTotal - plan.subsMonthly;
  const months = [...Array(13).keys()];
  const labels = months.map((i) => new Date(addMonths(today(), i)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
  const onPlan = months.map((i) => Math.round(startBal + i * (plan.income - monthlyOut)));
  const usual = months.map((i) => Math.round(startBal + i * monthlyNetUsual));

  // For event goals (e.g. a holiday), how much could you afford by that date?
  // = income, minus usual spending, subscriptions, buffer and the saving goals
  const surplusBeforeEvents = plan.income - plan.avgSpendTotal - plan.subsMonthly - plan.buffer
    - plan.goals.filter((g) => g.kind === 'saving').reduce((s, g) => s + g.perMonth, 0);

  view.innerHTML = `
  <div class="page-head"><h1>Goals & budget</h1><button class="btn primary" id="add-goal">+ Add goal</button></div>

  <section class="card">
    <h3>This month's plan <span class="muted small">(personal accounts)</span></h3>
    <div class="flow">
      <div><span class="muted small">Income (${esc(plan.incomeSource)})</span><strong>${money(plan.income)}</strong></div>
      <div><span class="muted small">− Essentials</span><strong>${money(plan.essentialsMonthly)}</strong></div>
      <div><span class="muted small">− Subscriptions</span><strong>${money(plan.subsMonthly)}</strong></div>
      <div><span class="muted small">− Goals</span><strong>${money(plan.goalsMonthly)}</strong></div>
      ${plan.buffer ? `<div><span class="muted small">− Safety buffer</span><strong>${money(plan.buffer)}</strong></div>` : ''}
      <div class="eq"><span class="muted small">= For lifestyle spending</span><strong class="${plan.discretionary < 0 ? 'neg' : ''}">${money(plan.discretionary)}</strong></div>
    </div>
    ${plan.discretionary < 0 ? '<p class="warn">⚠ Your goals and fixed costs are more than your income. Push a goal date back, lower a target, or trim essentials.</p>' : ''}
    ${!plan.hasHistory ? '<p class="muted small">No spending history yet, so essentials are counted as £0. Import a few months of bank CSVs (or set budgets below) for a realistic plan.</p>' : ''}
  </section>

  <section class="card">
    <h3>Goals</h3>
    ${plan.goals.length ? plan.goals.map((g) => {
      const target = toBase(g.target_amount, g.currency);
      const pct = Math.min(100, (g.saved / target) * 100 || 0);
      const affordable = g.kind === 'event' ? Math.max(0, g.saved + Math.max(0, surplusBeforeEvents) * g.months) : null;
      return `<div class="goal">
        <div class="row between"><div><strong>${esc(g.name)}</strong> <span class="tag">${g.kind === 'event' ? 'one-off' : 'saving'}</span>
          <div class="muted small">${money(target)} by ${niceDate(g.target_date)} · ${Math.max(0, Math.round(g.months))} months to go${g.account_id ? ` · tracks ${esc(accById(g.account_id)?.name || '')}` : ''}</div></div>
          <button class="icon-btn" data-goal="${g.id}" aria-label="Edit">✎</button></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="row between small"><span>${money(g.saved)} saved (${Math.round(pct)}%)</span><span>Put aside <strong>${money(g.perMonth)}</strong>/month</span></div>
        ${affordable != null ? `<div class="muted small">If you keep spending as you usually do and stay on track with your other goals, you could have about <strong>${money(affordable)}</strong> for this by ${niceDate(g.target_date)}.</div>` : ''}
      </div>`;
    }).join('') : '<p class="muted">No goals yet. Try “House deposit, £30,000 in 5 years” or “Holiday, June next year”.</p>'}
  </section>

  <section class="card">
    <h3>Spending allowances</h3>
    <p class="muted small">Left blank, an allowance is shared out from what's left over, based on your usual spending. Set a number to fix it.</p>
    <table class="tbl compact"><thead><tr><th>Category</th><th class="r">Usual</th><th class="r">Allowance</th><th class="r">Spent</th><th class="r">Left</th><th class="r">Fixed budget</th></tr></thead><tbody>
    ${plan.categories.map((c) => `<tr><td>${esc(c.cat.name)}</td><td class="r muted">${money(c.avg)}</td><td class="r">${money(c.allowance)}</td><td class="r">${money(c.spent)}</td>
      <td class="r ${c.left < 0 ? 'neg' : ''}">${money(c.left)}</td><td class="r"><input class="budget-in" type="number" step="1" min="0" data-cat="${c.cat.id}" value="${c.cat.monthly_budget ?? ''}" placeholder="auto"></td></tr>`).join('')}
    </tbody></table>
    <details><summary class="small">Essentials (bills, rent, groceries…)</summary>
      <table class="tbl compact"><tbody>${state.categories.filter((c) => c.kind === 'expense' && ['essentials', 'tax'].includes(c.cat_group) && c.scope !== 'business').map((c) => `<tr><td>${esc(c.name)}</td>
        <td class="r"><input class="budget-in" type="number" step="1" min="0" data-cat="${c.id}" value="${c.monthly_budget ?? ''}" placeholder="auto"></td></tr>`).join('')}</tbody></table>
    </details>
  </section>

  <section class="card">
    <h3>Next 12 months</h3>
    <p class="muted small">Projected balance of your personal current and savings accounts. The solid line assumes you use every allowance; the dashed line assumes you keep spending like the last 3 months.</p>
    <div class="chart"><canvas id="c-fc" aria-label="12 month forecast"></canvas></div>
  </section>`;

  const rerender = () => renderPlan(view);
  $('#add-goal').onclick = () => editGoal(null, rerender);
  $$('[data-goal]', view).forEach((b) => { b.onclick = () => editGoal(state.goals.find((g) => g.id === b.dataset.goal), rerender); });
  $$('.budget-in', view).forEach((inp) => {
    inp.onchange = async () => {
      const v = inp.value === '' ? null : Number(inp.value);
      const { error } = await sb.from('categories').update({ monthly_budget: v }).eq('id', inp.dataset.cat);
      if (error) return toast(error.message, 'bad');
      await loadCore(); rerender();
    };
  });
  lineChart($('#c-fc'), labels, [{ name: 'Spending your full allowances', values: onPlan }, { name: 'Spending as you do now', values: usual, dashed: true }], (v, s) => fmt(v, B, { whole: true }));
}

function editGoal(g, done) {
  const m = modal(`<h2>${g ? 'Edit' : 'New'} goal</h2>
  <form id="gf" class="form">
    <label>Name<input name="name" required value="${esc(g?.name || '')}" placeholder="e.g. House deposit, Holiday"></label>
    <label>Type<select name="kind">${opt('saving', 'Saving up (house, emergency fund…)', g?.kind !== 'event')}${opt('event', 'One-off spend (holiday, wedding…)', g?.kind === 'event')}</select></label>
    <div class="row2">
      <label>Target amount<input type="number" step="1" name="target_amount" required value="${g?.target_amount ?? ''}"></label>
      <label>Currency<select name="currency">${['GBP', 'PLN', 'EUR'].map((c) => opt(c, c, (g?.currency || base()) === c)).join('')}</select></label>
    </div>
    <label>By when<input type="date" name="target_date" required value="${g?.target_date || addMonths(today(), 12)}"></label>
    <label>Track progress from an account (optional)<select name="account_id">${opt('', 'No, I will enter the amount saved', !g?.account_id)}${state.accounts.filter((a) => a.scope === 'personal').map((a) => opt(a.id, a.name, g?.account_id === a.id)).join('')}</select></label>
    <label>Already saved (if not tracking an account)<input type="number" step="1" name="saved_amount" value="${g?.saved_amount ?? 0}"></label>
    <div class="row between">${g ? '<button type="button" class="btn danger ghost" id="del">Delete</button>' : '<span></span>'}<button class="btn primary">Save</button></div>
  </form>`);
  $('#gf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const row = { name: d.name.trim(), kind: d.kind, target_amount: Number(d.target_amount), currency: d.currency, target_date: d.target_date, account_id: d.account_id || null, saved_amount: Number(d.saved_amount || 0) };
    const { error } = g ? await sb.from('goals').update(row).eq('id', g.id) : await sb.from('goals').insert(row);
    if (error) return toast(error.message, 'bad');
    await loadCore(); m.close(); done();
  };
  const del = $('#del', m.el);
  if (del) del.onclick = async () => {
    if (!(await confirmBox('Delete this goal?'))) return;
    await sb.from('goals').delete().eq('id', g.id);
    await loadCore(); m.close(); done();
  };
}
