import { sb, state, loadCore, fetchTxns, catById, rates } from '../db.js';
import { esc, fmt, opt, modal, toast, convert, niceDate, today, $, $$ } from '../util.js';
import { barChart, lineChart } from './charts.js';
import { openInbox } from './inbox.js';
import {
  rulesFor, zusMonthly, taxSettings, takeHome, bestSplit, citAdvances, deadlines, monthName, r2,
} from '../tax-rules.js';

let displayCurrency = 'PLN';
const money = (v, o = {}) => {
  const amount = displayCurrency === 'GBP' ? convert(v, 'PLN', 'GBP', rates()) : v;
  return fmt(amount, displayCurrency, o);
};
const W = { whole: true };
const pct = (x, d = 1) => `${(x * 100).toFixed(d).replace(/\.0$/, '')}%`;
let year = new Date().getFullYear();
let cmp = null; // board-pay comparison inputs survive re-renders

export async function renderTax(view) {
  const t = taxSettings(state.settings?.tax);
  const R = rulesFor(year);
  const nowYear = new Date().getFullYear();
  const startYear = t.company_start ? Number(t.company_start.slice(0, 4)) : nowYear;
  const years = []; for (let y = Math.min(startYear, nowYear); y <= nowYear; y++) years.push(y);
  if (!years.includes(year)) year = nowYear;

  const biz = state.accounts.filter((a) => a.scope === 'business');
  const bizIds = biz.map((a) => a.id);
  const txns = bizIds.length ? await fetchTxns({ from: `${year}-01-01`, to: `${year}-12-31`, accountIds: bizIds }) : [];
  const allTax = await fetchTxns({ from: `${year}-01-01`, to: `${year}-12-31` });
  const toPLN = (amt, cur) => convert(amt, cur || 'PLN', 'PLN', rates());

  // ---------- month-by-month books ----------
  const months = [...Array(12).keys()].map((i) => ({ month: i + 1, revenue: 0, costs: 0, nonDeductible: 0, board: 0, vatOut: 0, vatIn: 0 }));
  let uncategorised = 0;
  for (const x of txns) {
    const m = months[Number(x.txn_date.slice(5, 7)) - 1];
    const c = catById(x.category_id);
    const amt = tomoney(x.amount, x.currency);
    const vat = t.vat_registered && x.vat_amount ? Math.abs(tomoney(x.vat_amount, x.currency)) : 0;
    if (!c) { uncategorised++; continue; }
    if (c.kind === 'income') { m.revenue += amt - Math.sign(amt) * vat; m.vatOut += Math.sign(amt) * vat; } else if (c.kind === 'expense' && c.cat_group !== 'tax') {
      const net = -amt - Math.sign(-amt) * vat;
      m.vatIn += Math.sign(-amt) * vat;
      if (c.tax_deductible) m.costs += net; else m.nonDeductible += net;
      if (/board pay/i.test(c.name)) m.board += net;
    }
  }
  const citRate = Number(t.cit_rate);
  const adv = citAdvances(months, citRate, t.cit_advances);
  const zus = t.sole_shareholder ? zusMonthly(year, { sickness: t.sickness }) : { social: 0, health: 0, total: 0 };
  const startMonth = t.company_start && t.company_start.slice(0, 4) === String(year) ? Number(t.company_start.slice(5, 7)) : (t.company_start && Number(t.company_start.slice(0, 4)) > year ? 13 : 1);
  const isCurrent = year === nowYear;
  const monthNow = isCurrent ? new Date().getMonth() + 1 : 12;
  const activeMonths = Math.max(0, monthNow - startMonth + 1);
  const zusMonthsYear = Math.max(0, 12 - startMonth + 1);

  const sum = (k, upto = 12) => months.slice(0, upto).reduce((s, m) => s + m[k], 0);
  const revenue = sum('revenue'); const costs = sum('costs'); const nonDed = sum('nonDeductible');
  const profit = revenue - costs;
  const citSoFar = Math.max(0, profit) * citRate;
  const vatNet = sum('vatOut') - sum('vatIn');
  const zusSoFar = zus.total * activeMonths;
  const boardYTD = sum('board');
  const boardTax = boardYTD > 0 ? boardYTD * (R.pit.healthOnBoardPay + R.pit.low) : 0; // rough accrual
  const owed = citSoFar + Math.max(0, vatNet) + zusSoFar;
  const paid = allTax.filter((x) => catById(x.category_id)?.cat_group === 'tax').reduce((s, x) => s - tomoney(x.amount, x.currency), 0);
  const afterCit = Math.max(0, profit - citSoFar);
  const cashLeft = afterCit - nonDed;

  // comparison defaults: forecast full-year profit before board pay
  const monthsWithBooks = Math.max(1, Math.min(activeMonths || 1, monthNow));
  const forecast = Math.max(0, Math.round(((profit + boardYTD) / monthsWithBooks) * Math.max(1, zusMonthsYear) / 1000) * 1000);
  if (!cmp || cmp.year !== year) cmp = { year, profit: forecast || 200000, board: Number(t.board_pay_monthly || 0) * 12 };

  // ---------- deadlines ----------
  const due = [...deadlines(year - 1, t), ...deadlines(year, t), ...deadlines(year + 1, t)];
  const amountFor = (d) => {
    if (d.kind === 'zus') return zus.total;
    if (d.forYear !== year || (isCurrent && d.forMonth >= monthNow)) return null; // month not finished yet
    if (d.kind === 'cit') return adv[d.forMonth - 1]?.advance ?? null;
    if (d.kind === 'vat') { const m = months[d.forMonth - 1]; return Math.round(m.vatOut - m.vatIn); }
    return null;
  };
  const td = today();
  const soon = due.filter((d) => d.date >= td).slice(0, 8);
  const yearList = deadlines(year, t);

  view.innerHTML = `
  <div class="page-head">
    <div class="row"><h1>Tax</h1>
      <select id="tax-year" aria-label="Tax year">${years.map((y) => opt(y, `${y}`, y === year)).join('')}</select>
      <div class="switch" id="tax-currency" aria-label="Tax display currency">
        <button type="button" data-c="PLN" class="${displayCurrency === 'PLN' ? 'on' : ''}">zł</button>
        <button type="button" data-c="GBP" class="${displayCurrency === 'GBP' ? 'on' : ''}">£</button>
      </div></div>
    <button class="btn" id="tax-settings">Tax settings</button>
  </div>

  ${!state.settings?.tax ? `<button class="banner" id="setup">Set up tax: tell Ledger when the company was registered and whether it's VAT-registered, so ZUS and deadlines start from the right month →</button>` : ''}
  ${!biz.length ? '<div class="card warn">Add your business bank account(s) under <a href="#/accounts">Accounts</a> and mark them “Business” so Ledger knows which money belongs to the company.</div>' : ''}
  ${uncategorised ? `<button class="banner" id="to-cat"><strong>${uncategorised}</strong> business transaction${uncategorised > 1 ? 's' : ''} in ${year} ${uncategorised > 1 ? 'have' : 'has'} no category, so ${uncategorised > 1 ? "they're" : "it's"} left out of the tax figures. Sort them →</button>` : ''}

  <div class="tiles">
    <div class="tile"><div class="k">Company income ${year}</div><div class="v">${money(revenue, W)}</div><div class="muted small">${t.vat_registered ? 'net of VAT' : 'as received'}</div></div>
    <div class="tile"><div class="k">Deductible costs</div><div class="v">${money(costs, W)}</div><div class="muted small">${nonDed ? `+ ${money(nonDed, W)} not deductible` : 'lower the profit that gets taxed'}</div></div>
    <div class="tile"><div class="k">Taxable profit</div><div class="v ${profit < 0 ? 'neg' : ''}">${money(profit, W)}</div><div class="muted small">CIT at ${pct(citRate)} ≈ ${money(citSoFar, W)}</div></div>
    <div class="tile"><div class="k">Still to set aside</div><div class="v ${owed - paid > 0 ? 'neg' : ''}">${money(Math.max(0, owed - paid), W)}</div><div class="muted small">owed so far minus tax paid</div></div>
  </div>

  <div class="grid2">
    <section class="card">
      <h3>Tax pot, ${year} so far</h3>
      <div class="row between li"><span>Corporation tax (CIT ${pct(citRate)} of ${money(Math.max(0, profit), W)})</span><strong>${money(citSoFar)}</strong></div>
      ${t.vat_registered ? `<div class="row between li"><span>VAT to pay <span class="muted small">(${money(sum('vatOut'), W)} charged − ${money(sum('vatIn'), W)} on costs)</span></span><strong class="${vatNet < 0 ? 'pos' : ''}">${vatNet < 0 ? `${money(-vatNet)} refund` : money(vatNet)}</strong></div>` : ''}
      ${t.sole_shareholder ? `<div class="row between li"><span>ZUS <span class="muted small">(${activeMonths} month${activeMonths === 1 ? '' : 's'} × ${money(zus.total)}; paid by you personally)</span></span><strong>${money(zusSoFar)}</strong></div>` : ''}
      <div class="row between li"><span><strong>Owed so far</strong></span><strong>${money(owed)}</strong></div>
      <div class="row between li"><span>Tax & ZUS payments recorded <span class="muted small">(category “Tax & ZUS payments”)</span></span><strong>− ${money(paid)}</strong></div>
      <div class="row between li"><span><strong>Keep aside now</strong></span><strong class="${owed - paid > 0 ? 'neg' : 'pos'}">${money(Math.max(0, owed - paid))}</strong></div>
      <p class="muted small">If the ${money(afterCit, W)} left after CIT${nonDed ? ` (${money(Math.max(0, cashLeft), W)} after non-deductible spending)` : ''} were paid out as a dividend, ${pct(R.dividendTax, 0)} dividend tax would take another ${money(Math.max(0, cashLeft) * R.dividendTax, W)}.${boardYTD ? ` Board pay so far: ${money(boardYTD, W)} (about ${money(boardTax, W)} of that goes on your health contribution and PIT).` : ''}</p>
    </section>

    <section class="card">
      <h3>Coming up</h3>
      ${soon.map((d) => { const a = amountFor(d); return `<div class="row between li"><div><strong>${esc(d.title)}</strong> <span class="muted small">${niceDate(d.date)}${d.date !== d.nominal ? ' (moved from a weekend or holiday)' : ''}</span><div class="muted small">${esc(d.detail)}</div></div>${a != null ? `<span class="nowrap">${a > 0 ? money(a) : a < 0 ? `${money(-a)} back` : '<span class="muted">nothing</span>'}</span>` : ''}</div>`; }).join('') || '<p class="muted">Nothing due. Set the company registration date in Tax settings.</p>'}
    </section>
  </div>

  <section class="card">
    <h3>Month by month, ${year}</h3>
    <div class="chart"><canvas id="c-tax" aria-label="Income, costs and tax per month"></canvas></div>
    <table class="tbl compact"><thead><tr><th>Month</th><th class="r">Income</th><th class="r">Costs</th><th class="r">Profit</th><th class="r">CIT ${t.cit_advances === 'monthly' ? 'advance' : '(quarterly)'}</th>${t.vat_registered ? '<th class="r">VAT to pay</th>' : ''}${t.sole_shareholder ? '<th class="r">ZUS</th>' : ''}</tr></thead><tbody>
    ${adv.filter((m) => m.month >= Math.min(startMonth, 12) && (m.month <= monthNow || m.revenue || m.costs)).map((m) => `<tr><td>${monthName(m.month)}</td><td class="r">${money(m.revenue, W)}</td><td class="r">${money(m.costs, W)}</td><td class="r ${m.profit < 0 ? 'neg' : ''}">${money(m.profit, W)}</td><td class="r">${m.isDue ? money(m.advance, W) : '<span class="muted">–</span>'}</td>${t.vat_registered ? `<td class="r">${money(months[m.month - 1].vatOut - months[m.month - 1].vatIn, W)}</td>` : ''}${t.sole_shareholder ? `<td class="r">${money(zus.total)}</td>` : ''}</tr>`).join('')}
    </tbody></table>
    <p class="muted small">CIT advances are worked out on the profit for the year so far, so a strong month followed by a slow one can mean nothing is due. Foreign-currency income is converted with the rates in Settings; your accountant will use the NBP rate from the working day before each invoice.</p>
  </section>

  <section class="card" id="cmp"></section>

  <section class="card">
    <details><summary><strong>All ${year} deadlines</strong> <span class="muted small">(${yearList.length})</span></summary>
      <table class="tbl compact"><thead><tr><th>Due</th><th>What</th><th></th></tr></thead><tbody>
      ${yearList.map((d) => `<tr class="${d.date < td ? 'muted' : ''}"><td class="nowrap">${niceDate(d.date)}</td><td><strong>${esc(d.title)}</strong><div class="small muted">${esc(d.detail)}</div></td><td class="r nowrap">${(() => { const a = amountFor(d); return a > 0 ? money(a, W) : ''; })()}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Dividend tax: when the company pays you a dividend it keeps back ${pct(R.dividendTax, 0)} and pays it to the tax office by the 20th of the next month. Deadlines falling on a weekend or Polish public holiday move to the next working day.</p>
    </details>
  </section>

  <section class="card">
    <details><summary><strong>How the rules work (${year})</strong></summary>
      <ul class="small">
        <li><strong>CIT ${pct(R.cit.small, 0)}</strong> applies while the company's yearly revenue stays under €${(R.cit.smallLimitEur / 1e6).toFixed(0)} million and in its first year (unless it was created from a restructuring, such as converting a sole trader business). Otherwise it's ${pct(R.cit.standard, 0)}. Go over the limit during the year and the ${pct(R.cit.small, 0)} rate is lost for the whole year.</li>
        <li><strong>ZUS</strong>: as the only shareholder you pay ${money(zusMonthly(year).social)} social (${money(zusMonthly(year, { sickness: false }).social)} without voluntary sickness cover) + ${money(R.zus.health)} health each month, whatever the company earns. There's no start-up discount for a sp. z o.o. It starts from the day the company is entered in KRS, and the first month is pro-rated. It's your personal cost, not the company's. With two or more shareholders, this doesn't apply.</li>
        <li><strong>VAT</strong>: invoices for your UK client are for services supplied outside Poland, so they carry no Polish VAT (marked “np.” / reverse charge) and still go on the JPK_V7M return. Polish costs with ${pct(R.vat.standard, 0)} VAT get that VAT back. Software or services bought from abroad (e.g. Adobe, Google) count as import of services, where you account for VAT yourself. That usually needs VAT-UE registration even if you're otherwise VAT-exempt. Record the VAT on each business transaction (the “VAT included” field) to make these figures work.</li>
        <li><strong>Board pay (powołanie)</strong> is a company cost, so it cuts CIT. You pay ${pct(R.pit.healthOnBoardPay, 0)} health on it and PIT at ${pct(R.pit.low, 0)} / ${pct(R.pit.high, 0)} with the ${money(R.pit.reduction / R.pit.low, W)} tax-free amount, after ${money(R.pit.boardCostsMonthly, W)}/month costs. Your shareholder social ZUS can be deducted from this income. There's no social ZUS on board pay.</li>
        <li><strong>Dividends</strong> come out of profit that has already had CIT, then ${pct(R.dividendTax, 0)} is withheld. That's ${pct(1 - (1 - R.cit.small) * (1 - R.dividendTax), 1)} in total at the ${pct(R.cit.small, 0)} rate. No ZUS or health on top.</li>
        <li><strong>KSeF</strong>: from ${year >= 2026 ? '1 April 2026' : 'its start date'} invoices are issued through the national e-invoice system.</li>
      </ul>
      <p class="muted small">These are planning estimates, not advice. Check anything important with your accountant.</p>
    </details>
  </section>`;

  const rerender = () => renderTax(view);
  $('#tax-year').onchange = (e) => { year = Number(e.target.value); cmp = null; rerender(); };
  $('#tax-currency button').forEach((b) => { b.onclick = () => { displayCurrency = b.dataset.c; rerender(); }; });
  $('#tax-settings').onclick = () => editTax(rerender);
  const su = $('#setup'); if (su) su.onclick = () => editTax(rerender);
  const tc = $('#to-cat'); if (tc) tc.onclick = () => openInbox();

  const shown = adv.filter((m) => m.month >= Math.min(startMonth, 12) && m.month <= Math.max(monthNow, startMonth));
  barChart($('#c-tax'), shown.map((m) => monthName(m.month).slice(0, 3)),
    [{ name: 'Income', values: shown.map((m) => Math.round(m.revenue)) }, { name: 'Costs', values: shown.map((m) => Math.round(m.costs)) },
      { name: 'Tax + ZUS', values: shown.map((m) => Math.round((m.isDue ? m.advance : 0) + (t.vat_registered ? Math.max(0, months[m.month - 1].vatOut - months[m.month - 1].vatIn) : 0) + zus.total)) }],
    (v, short) => money(v, { whole: short }));

  renderComparison($('#cmp'), t, zusMonthsYear || 12);
}

// ---------- board pay vs dividend ----------
function renderComparison(el, t, zusMonths) {
  const opts = { citRate: Number(t.cit_rate), sickness: t.sickness, soleShareholder: t.sole_shareholder, deductZus: t.deduct_zus_from_pit, zusMonths };
  const P = Math.max(0, Number(cmp.profit) || 0);
  const mine = Math.min(P, Math.max(0, Number(cmp.board) || 0));
  const div = takeHome(P, 0, year, opts);
  const you = takeHome(P, mine, year, opts);
  const best = bestSplit(P, year, opts);
  const cols = [['All dividend', div], ['Your mix', you], ['Best mix', best]];
  const row = (label, f, cls = '') => `<tr class="${cls}"><td>${label}</td>${cols.map(([, x]) => `<td class="r">${f(x)}</td>`).join('')}</tr>`;
  const gain = best.net - div.net;

  el.innerHTML = `
    <h3>Board pay or dividend?</h3>
    <p class="muted small">How much of the company's profit reaches you under each option, after CIT, PIT, health, ZUS and dividend tax. “Best mix” finds the board pay that leaves you the most.</p>
    <div class="row2 form">
      <label>Company profit for ${year} before paying yourself (zł)<input type="number" step="1000" min="0" id="cmp-profit" value="${Math.round(P)}"></label>
      <label>Board pay for the year, gross (zł)<input type="number" step="1000" min="0" id="cmp-board" value="${Math.round(mine)}"></label>
    </div>
    <input type="range" id="cmp-slide" min="0" max="${Math.max(1000, Math.round(P))}" step="1000" value="${Math.round(mine)}" aria-label="Board pay" style="width:100%">
    <table class="tbl compact"><thead><tr><th></th>${cols.map(([n]) => `<th class="r">${n}</th>`).join('')}</tr></thead><tbody>
      ${row('Board pay (gross)', (x) => money(x.board, W))}
      ${row('Health on board pay (9%)', (x) => money(x.pay.health, W))}
      ${row('PIT on board pay', (x) => money(x.pay.pit + x.pay.solidarity, W))}
      ${row(`CIT (${pct(opts.citRate)})`, (x) => money(x.cit, W))}
      ${row('Dividend paid (gross)', (x) => money(x.dividend, W))}
      ${row('Dividend tax (19%)', (x) => money(x.divTax, W))}
      ${t.sole_shareholder ? row(`Your ZUS (${zusMonths} months)`, (x) => money(x.zusTotal, W)) : ''}
      ${row('<strong>You keep</strong>', (x) => `<strong>${money(x.net, W)}</strong>`)}
      ${row('per month', (x) => money(x.net / 12, W), 'muted')}
      ${row('Total tax & ZUS rate', (x) => pct(x.effective))}
    </tbody></table>
    ${P > 0 ? `<p class="small">${gain > 1 ? `Paying yourself <strong>${money(best.board, W)}</strong> board pay (${money(best.board / 12, W)}/month) and the rest as dividend leaves you <strong>${money(gain, W)} more</strong> a year than dividends alone.` : 'Taking everything as a dividend comes out best at this profit.'}
      ${best.board > 0 && best.pay.taxable >= rulesFor(year).pit.threshold - 1 ? ` Past this point each extra złoty of board pay would be taxed at ${pct(rulesFor(year).pit.high, 0)} + 9% health, which is more than CIT plus dividend tax.` : ''}</p>` : ''}
    <div class="chart"><canvas id="c-cmp" aria-label="Take-home by amount of board pay"></canvas></div>
    <div class="row between"><p class="muted small">Board pay needs a shareholder resolution (uchwała) and must be a reasonable amount for the work done. The tax office can challenge pay that's clearly out of line.</p>
      <button class="btn small" id="cmp-save">Plan ${money(mine / 12, W)}/month board pay</button></div>`;

  const steps = 40; const labels = []; const vals = [];
  for (let i = 0; i <= steps; i++) { const b = (P * i) / steps; labels.push(`${Math.round(b / 1000)}k`); vals.push(Math.round(takeHome(P, b, year, opts).net)); }
  lineChart($('#c-cmp', el), labels, [{ name: 'You keep, by board pay', values: vals }], (v, short) => money(v, { whole: short }));

  const upd = () => renderComparison(el, t, zusMonths);
  $('#cmp-profit', el).onchange = (e) => { cmp.profit = Number(e.target.value); upd(); };
  $('#cmp-board', el).onchange = (e) => { cmp.board = Number(e.target.value); upd(); };
  $('#cmp-slide', el).oninput = (e) => { $('#cmp-board', el).value = e.target.value; };
  $('#cmp-slide', el).onchange = (e) => { cmp.board = Number(e.target.value); upd(); };
  $('#cmp-save', el).onclick = async () => { await saveTax({ ...t, board_pay_monthly: r2(mine / 12) }); toast('Board pay saved to your tax plan'); };
}

async function saveTax(tax) {
  const { error } = await sb.from('settings').update({ tax }).eq('user_id', state.user.id);
  if (error) { toast(error.message, 'bad'); throw error; }
  await loadCore();
}

function editTax(done) {
  const t = taxSettings(state.settings?.tax);
  const z = zusMonthly(year); const zn = zusMonthly(year, { sickness: false });
  const m = modal(`<h2>Tax settings</h2>
  <form id="tf" class="form">
    <label>Company registered in KRS on<input type="date" name="company_start" value="${esc(t.company_start || '')}"></label>
    <label class="check"><input type="checkbox" name="sole_shareholder" ${t.sole_shareholder ? 'checked' : ''}> I'm the only shareholder (so I pay ZUS)</label>
    <label class="check"><input type="checkbox" name="sickness" ${t.sickness ? 'checked' : ''}> Include voluntary sickness insurance (${money(z.social)} instead of ${money(zn.social)} social + ${money(z.health)} health)</label>
    <div class="row2">
      <label>CIT rate<select name="cit_rate">${opt('0.09', '9%, small taxpayer', Number(t.cit_rate) === 0.09)}${opt('0.19', '19%, standard', Number(t.cit_rate) === 0.19)}</select></label>
      <label>CIT advances<select name="cit_advances">${opt('monthly', 'Monthly', t.cit_advances === 'monthly')}${opt('quarterly', 'Quarterly', t.cit_advances === 'quarterly')}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="vat_registered" ${t.vat_registered ? 'checked' : ''}> Company is registered for VAT (monthly JPK_V7M)</label>
    <div class="row2">
      <label>Planned board pay per month, gross (zł)<input type="number" step="100" min="0" name="board_pay_monthly" value="${Number(t.board_pay_monthly) || 0}"></label>
    </div>
    <label class="check"><input type="checkbox" name="deduct_zus_from_pit" ${t.deduct_zus_from_pit ? 'checked' : ''}> Deduct my shareholder social ZUS from board-pay income</label>
    <p class="muted small">Categories marked “Business tax-deductible” count as costs. Payments to the tax office or ZUS go in “Tax & ZUS payments” so Ledger can tick them off.</p>
    <button class="btn primary">Save</button>
  </form>`);
  $('#tf', m.el).onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    await saveTax({
      company_start: d.company_start || null, sole_shareholder: !!d.sole_shareholder, sickness: !!d.sickness,
      cit_rate: Number(d.cit_rate), cit_advances: d.cit_advances, vat_registered: !!d.vat_registered,
      board_pay_monthly: Number(d.board_pay_monthly || 0), pit2: true, deduct_zus_from_pit: !!d.deduct_zus_from_pit,
    });
    cmp = null; m.close(); toast('Tax settings saved'); done();
  };
}
