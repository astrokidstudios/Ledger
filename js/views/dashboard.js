import { state, fetchTxns, visibleAccountIds, toBase, base, catById, currentPeriod, startDay, budgetPlan, upcomingSubs, accountBalances, accById } from '../db.js';
import { esc, fmt, shiftPeriod, periodLabel, niceDate, $ } from '../util.js';
import { barChart } from './charts.js';
import { openInbox } from './inbox.js';

let offset = 0; // months back from current

export async function renderDashboard(view) {
  const sd = startDay();
  const B = base();
  const money = (v, o) => fmt(v, B, o);
  const cur = shiftPeriod(currentPeriod(), offset, sd);
  const six = [5, 4, 3, 2, 1, 0].map((n) => shiftPeriod(cur, -n, sd));
  const hist = [1, 2, 3].map((n) => shiftPeriod(cur, -n, sd));
  const ids = visibleAccountIds();

  if (!state.accounts.length) {
    view.innerHTML = `<div class="empty card"><h2>Welcome to Ledger</h2>
      <p>Start by adding your bank accounts (personal and business). Then import a CSV export from each bank and Ledger will learn how to sort your spending.</p>
      <a class="btn primary" href="#/accounts">Add your first account</a></div>`;
    return;
  }

  const txns = await fetchTxns({ from: six[0].start, to: cur.end, accountIds: ids });
  const inPeriod = (t, p) => t.txn_date >= p.start && t.txn_date <= p.end;

  const totals = (p) => {
    let inc = 0; let out = 0;
    for (const t of txns) {
      if (!inPeriod(t, p)) continue;
      const c = catById(t.category_id);
      if (c && c.kind === 'transfer') continue;
      const a = toBase(t.amount, t.currency);
      if (a >= 0) inc += a; else out -= a;
    }
    return { inc, out };
  };
  const now = totals(cur);
  const series = six.map(totals);

  // category comparison
  const byCat = {};
  for (const t of txns) {
    const c = catById(t.category_id);
    if (c && c.kind !== 'expense') continue;
    const id = c ? c.id : 'none';
    const a = -toBase(t.amount, t.currency);
    byCat[id] = byCat[id] || { now: 0, last: 0, hist: 0 };
    if (inPeriod(t, cur)) byCat[id].now += a;
    if (inPeriod(t, hist[0])) byCat[id].last += a;
    if (hist.some((p) => inPeriod(t, p))) byCat[id].hist += a / 3;
  }
  const rows = Object.entries(byCat).filter(([, v]) => v.now || v.last || v.hist)
    .sort((a, b) => b[1].now - a[1].now);

  const balances = await accountBalances();
  const netWorth = state.accounts.filter((a) => !a.archived && ids.includes(a.id))
    .reduce((s, a) => s + toBase(balances[a.id] || 0, a.currency), 0);

  const showPlan = offset === 0 && state.scope !== 'business' && !state.accountId;
  const plan = showPlan ? await budgetPlan({ scope: 'personal' }) : null;
  const uncategorised = txns.filter((t) => !t.category_id && inPeriod(t, cur)).length;

  // business: deductible spend this tax year-ish (calendar year for Poland)
  const bizIds = state.accounts.filter((a) => a.scope === 'business').map((a) => a.id);
  const yearStart = `${cur.start.slice(0, 4)}-01-01`;
  const deductible = txns.filter((t) => bizIds.includes(t.account_id) && t.txn_date >= yearStart && catById(t.category_id)?.tax_deductible)
    .reduce((s, t) => s - toBase(t.amount, t.currency), 0);

  const monthOver = offset < 0;
  const delta = (v, ref) => {
    if (!ref) return v > 0 ? '<span class="tag">new</span>' : '';
    const pct = ((v - ref) / ref) * 100;
    if (pct > 10) return `<span class="tag bad">▲ ${Math.round(pct)}% above usual</span>`;
    if (Math.abs(pct) <= 10) return '<span class="tag">≈ usual</span>';
    return monthOver ? `<span class="tag good">▼ ${Math.round(-pct)}% below usual</span>` : ''; // don't praise a month that isn't finished
  };

  view.innerHTML = `
  <div class="page-head">
    <div class="month-nav">
      <button class="btn ghost small" id="prev">‹</button>
      <h1>${esc(periodLabel(cur))}</h1>
      <button class="btn ghost small" id="next" ${offset >= 0 ? 'disabled' : ''}>›</button>
    </div>
    <span class="muted small">${state.accountId ? esc(accById(state.accountId)?.name) : state.scope === 'all' ? 'All accounts' : state.scope === 'personal' ? 'Personal accounts' : 'Business accounts'}</span>
  </div>

  ${uncategorised ? `<button class="banner" id="to-cat"><strong>${uncategorised}</strong> transaction${uncategorised > 1 ? 's' : ''} this month need a category, sort them in a few taps →</button>` : ''}

  <div class="tiles">
    <div class="tile"><div class="k">Money in</div><div class="v">${money(now.inc)}</div></div>
    <div class="tile"><div class="k">Money out</div><div class="v">${money(now.out)}</div></div>
    <div class="tile"><div class="k">Difference</div><div class="v ${now.inc - now.out < 0 ? 'neg' : ''}">${money(now.inc - now.out, { sign: true })}</div></div>
    <div class="tile"><div class="k">Balance of these accounts</div><div class="v">${money(netWorth)}</div></div>
  </div>

  ${plan ? `
  <section class="card hero">
    <div>
      <div class="k">Safe to spend on fun stuff this month</div>
      <div class="hero-num ${plan.safeToSpend < 0 ? 'neg' : ''}">${money(plan.safeToSpend, { whole: true })}</div>
      <div class="muted small">${plan.daysLeft} days left · about ${money(Math.max(0, plan.safeToSpend) / plan.daysLeft, { whole: true })} a day · after bills, subscriptions and ${money(plan.goalsMonthly, { whole: true })} towards your goals</div>
      ${!plan.hasHistory && state.settings.expected_monthly_income == null ? '<p class="muted small">Import a few months of transactions, or set your expected income in Settings, to make this accurate.</p>' : ''}
    </div>
    <div class="allow">
      ${plan.categories.filter((c) => c.allowance > 0 || c.spent > 0).map((c) => {
        const pct = c.allowance > 0 ? Math.min(100, (c.spent / c.allowance) * 100) : 100;
        const over = c.spent > c.allowance;
        return `<div class="allow-row"><div class="row between"><span>${esc(c.cat.name)}</span><span class="${over ? 'neg' : ''}">${over ? `${money(-c.left, { whole: true })} over` : `${money(c.left, { whole: true })} left`}</span></div>
        <div class="bar"><i style="width:${pct}%" class="${over ? 'over' : ''}"></i></div></div>`;
      }).join('') || '<p class="muted small">Categories appear here once you have some spending history.</p>'}
      <a href="#/plan" class="small">Adjust budgets & goals →</a>
    </div>
  </section>` : ''}

  <div class="grid2">
    <section class="card">
      <h3>In and out, last 6 months</h3>
      <div class="chart"><canvas id="c-io" aria-label="Money in and out per month"></canvas></div>
    </section>
    <section class="card">
      <h3>Spending vs. last month</h3>
      ${rows.length ? `<table class="tbl compact"><thead><tr><th>Category</th><th class="r">This month</th><th class="r">Last month</th><th class="r">3-mo avg</th><th></th></tr></thead><tbody>
      ${rows.map(([id, v]) => `<tr><td>${id === 'none' ? '<em>Not sorted yet</em>' : esc(catById(id)?.name)}</td><td class="r">${money(v.now, { whole: true })}</td><td class="r muted">${money(v.last, { whole: true })}</td><td class="r muted">${money(v.hist, { whole: true })}</td><td>${id === 'none' ? '' : delta(v.now, v.hist)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No spending recorded for this month yet.</p>'}
    </section>
  </div>

  <div class="grid2">
    <section class="card">
      <h3>Coming up (next 14 days)</h3>
      ${upcomingSubs(14).map((s) => `<div class="row between li"><span>${esc(s.name)} <span class="muted small">${niceDate(s.next_date)}</span></span><span>${fmt(s.amount, s.currency)}</span></div>`).join('') || '<p class="muted">No payments due. Add subscriptions to see them here.</p>'}
    </section>
    ${bizIds.length && state.scope !== 'personal' ? `<section class="card">
      <h3>Business, ${cur.start.slice(0, 4)} so far</h3>
      <div class="row between li"><span>Deductible expenses recorded</span><strong>${money(deductible)}</strong></div>
      <a href="#/tax" class="small">Tax, ZUS, VAT and deadlines →</a>
    </section>` : ''}
  </div>`;

  $('#prev').onclick = () => { offset -= 1; renderDashboard(view); };
  $('#next').onclick = () => { if (offset < 0) { offset += 1; renderDashboard(view); } };
  const tc = $('#to-cat'); if (tc) tc.onclick = () => openInbox();
  barChart($('#c-io'), six.map((p) => new Date(p.start).toLocaleDateString('en-GB', { month: 'short' })),
    [{ name: 'Money in', values: series.map((s) => Math.round(s.inc)) }, { name: 'Money out', values: series.map((s) => Math.round(s.out)) }],
    (v, short) => fmt(v, B, { whole: short }));
}
