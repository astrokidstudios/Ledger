import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { convert, periodFor, shiftPeriod, today, addDays, addMonths, round2, payeeKey } from './util.js';

// Session lives in sessionStorage: closing the browser tab signs you out.
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const state = {
  user: null, settings: null, accounts: [], categories: [], rules: [], subs: [], goals: [], values: [],
  scope: 'all', accountId: '',
};

function check({ data, error }) { if (error) throw error; return data; }

async function all(query) {
  const out = []; let from = 0; const size = 1000;
  for (;;) {
    const rows = check(await query().range(from, from + size - 1));
    out.push(...rows);
    if (rows.length < size) return out;
    from += size;
  }
}

export async function loadCore() {
  const [settings, accounts, categories, rules, subs, goals, values] = await Promise.all([
    sb.from('settings').select('*').maybeSingle().then(check),
    sb.from('bank_accounts').select('*').order('created_at').then(check),
    sb.from('categories').select('*').order('sort').order('name').then(check),
    sb.from('category_rules').select('*').then(check),
    sb.from('subscriptions').select('*').order('next_date', { nullsFirst: false }).then(check),
    sb.from('goals').select('*').order('target_date').then(check),
    sb.from('account_values').select('*').order('as_of').then(check),
  ]);
  Object.assign(state, {
    settings: settings || { base_currency: 'GBP', fx_rates: { GBP: 1 }, month_start_day: 1, idle_minutes: 15, monthly_buffer: 0 },
    accounts, categories, rules, subs, goals, values,
  });
  if (!settings) { // safety net if the seed trigger didn't run
    const r = await sb.from('settings').insert({}).select().single();
    if (r.data) state.settings = r.data;
  }
}

export const base = () => state.settings?.base_currency || 'GBP';
export const rates = () => state.settings?.fx_rates || { GBP: 1 };
export const toBase = (amt, cur) => convert(amt, cur || base(), base(), rates());
export const catById = (id) => state.categories.find((c) => c.id === id);
export const accById = (id) => state.accounts.find((a) => a.id === id);
export const startDay = () => state.settings?.month_start_day || 1;
export const currentPeriod = () => periodFor(today(), startDay());

// Which accounts are "in view" given the scope + account switchers.
export function visibleAccountIds() {
  return state.accounts
    .filter((a) => !a.archived)
    .filter((a) => (state.accountId ? a.id === state.accountId : state.scope === 'all' || a.scope === state.scope))
    .map((a) => a.id);
}

export async function fetchTxns({ from, to, accountIds, uncategorised } = {}) {
  return all(() => {
    let q = sb.from('transactions').select('*').order('txn_date', { ascending: false }).order('created_at', { ascending: false });
    if (from) q = q.gte('txn_date', from);
    if (to) q = q.lte('txn_date', to);
    if (accountIds) q = q.in('account_id', accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000']);
    if (uncategorised) q = q.is('category_id', null);
    return q;
  });
}

export async function countUncategorised() {
  const { count } = await sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null);
  return count || 0;
}

// ---------- categorisation rules ----------
export function ruleFor(key) { return state.rules.find((r) => r.match_text === key); }

export async function learnRule(key, categoryId) {
  const row = check(await sb.from('category_rules')
    .upsert({ match_text: key, category_id: categoryId }, { onConflict: 'user_id,match_text' }).select().single());
  state.rules = state.rules.filter((r) => r.match_text !== key).concat(row);
  // apply to every other uncategorised transaction from the same payee
  const upd = check(await sb.from('transactions').update({ category_id: categoryId, auto_categorised: true })
    .eq('payee_key', key).is('category_id', null).select('id'));
  return upd.length;
}

export async function forgetRule(id) {
  check(await sb.from('category_rules').delete().eq('id', id));
  state.rules = state.rules.filter((r) => r.id !== id);
}

export function autoCategory(desc) {
  const key = payeeKey(desc);
  const r = ruleFor(key);
  return { key, categoryId: r ? r.category_id : null };
}

// ---------- balances ----------
export async function accountBalances() {
  const sums = {};
  const rows = await all(() => sb.from('transactions').select('account_id, amount'));
  for (const r of rows) sums[r.account_id] = (sums[r.account_id] || 0) + Number(r.amount);
  const out = {};
  for (const a of state.accounts) {
    const snaps = state.values.filter((v) => v.account_id === a.id);
    const latest = snaps[snaps.length - 1];
    const valued = ['investment', 'pension', 'other'].includes(a.account_type) || (latest && !sums[a.id]);
    out[a.id] = valued && latest ? Number(latest.value) : round2(Number(a.opening_balance) + (sums[a.id] || 0));
  }
  return out;
}

// ---------- the budget engine ----------
// Works out, for the current budget month: income, fixed costs, goal savings,
// and what's left to spend on each lifestyle category.
export function monthlySubCost(s) {
  const a = toBase(s.amount, s.currency);
  return { weekly: a * 52 / 12, monthly: a, quarterly: a / 3, yearly: a / 12 }[s.cycle] || a;
}

export function goalMonthly(g, balances) {
  const acc = g.account_id && accById(g.account_id);
  const saved = acc && balances && balances[acc.id] != null
    ? toBase(balances[acc.id], acc.currency) : toBase(g.saved_amount, g.currency);
  const remaining = Math.max(0, toBase(g.target_amount, g.currency) - saved);
  const months = Math.max(1, monthsFromNow(g.target_date));
  return { saved, remaining, months, perMonth: remaining / months };
}
export function monthsFromNow(dateStr) {
  const a = new Date(); const b = new Date(dateStr);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30.44;
}

export async function budgetPlan({ scope = 'personal' } = {}) {
  const sd = startDay();
  const cur = currentPeriod();
  const hist = [1, 2, 3].map((n) => shiftPeriod(cur, -n, sd));
  const accIds = state.accounts.filter((a) => !a.archived && (scope === 'all' || a.scope === scope)).map((a) => a.id);
  const txns = await fetchTxns({ from: hist[2].start, to: cur.end, accountIds: accIds });
  const balances = await accountBalances();

  const byCatPeriod = {}; // catId -> {periodKey: total}
  let incomeHist = 0;
  const histKeys = new Set(hist.map((p) => p.key));
  const monthsWithData = new Set();
  for (const t of txns) {
    const p = periodFor(t.txn_date, sd).key;
    const c = catById(t.category_id);
    const amt = toBase(t.amount, t.currency);
    if (histKeys.has(p)) monthsWithData.add(p);
    if (c && c.kind === 'income' && histKeys.has(p)) incomeHist += amt;
    if (!c || c.kind !== 'expense') continue;
    byCatPeriod[c.id] = byCatPeriod[c.id] || {};
    byCatPeriod[c.id][p] = (byCatPeriod[c.id][p] || 0) - amt;
  }
  const n = Math.max(1, monthsWithData.size);
  const avg = (id) => hist.reduce((s, p) => s + (byCatPeriod[id]?.[p.key] || 0), 0) / n;
  const spentNow = (id) => byCatPeriod[id]?.[cur.key] || 0;

  const income = state.settings.expected_monthly_income != null
    ? Number(state.settings.expected_monthly_income) : incomeHist / n;
  const subsMonthly = state.subs.filter((s) => s.active && !s.ignored).reduce((s, x) => s + monthlySubCost(x), 0);
  const subsCat = state.categories.find((c) => c.name === 'Subscriptions');

  const expenseCats = state.categories.filter((c) => c.kind === 'expense' && (scope === 'all' || c.scope === scope || c.scope === 'both'));
  const essentials = expenseCats.filter((c) => c.cat_group === 'essentials' || c.cat_group === 'tax');
  const lifestyle = expenseCats.filter((c) => c.cat_group === 'lifestyle' && c.id !== subsCat?.id);
  const essentialsMonthly = essentials.reduce((s, c) => s + (c.monthly_budget != null ? Number(c.monthly_budget) : avg(c.id)), 0);

  const goals = state.goals.map((g) => ({ ...g, ...goalMonthly(g, balances) }));
  const goalsMonthly = goals.reduce((s, g) => s + g.perMonth, 0);
  const buffer = Number(state.settings.monthly_buffer || 0);
  const discretionary = income - essentialsMonthly - subsMonthly - goalsMonthly - buffer;

  const avgs = lifestyle.map((c) => ({ c, a: avg(c.id) }));
  const fixedBudgets = avgs.filter((x) => x.c.monthly_budget != null).reduce((s, x) => s + Number(x.c.monthly_budget), 0);
  const flexPool = Math.max(0, discretionary - fixedBudgets);
  const flexAvgTotal = avgs.filter((x) => x.c.monthly_budget == null).reduce((s, x) => s + x.a, 0);
  const flexCount = avgs.filter((x) => x.c.monthly_budget == null).length || 1;

  const daysLeft = Math.max(1, Math.round((new Date(cur.end) - new Date(today())) / 86400000) + 1);
  const categories = avgs.map(({ c, a }) => {
    const allowance = c.monthly_budget != null ? Number(c.monthly_budget)
      : flexAvgTotal > 0 ? flexPool * (a / flexAvgTotal) : flexPool / flexCount;
    const spent = spentNow(c.id);
    return { cat: c, allowance, spent, left: allowance - spent, perDay: (allowance - spent) / daysLeft, avg: a, lastMonth: byCatPeriod[c.id]?.[hist[0].key] || 0 };
  });

  const spentLifestyle = categories.reduce((s, x) => s + x.spent, 0);
  return {
    period: cur, daysLeft, income, incomeSource: state.settings.expected_monthly_income != null ? 'your setting' : `${n}-month average`,
    essentialsMonthly, subsMonthly, goalsMonthly, buffer, discretionary, categories, goals, balances,
    safeToSpend: discretionary - spentLifestyle, fixedBudgets,
    avgSpendTotal: expenseCats.filter((c) => c.id !== subsCat?.id).reduce((s, c) => s + avg(c.id), 0), hasHistory: monthsWithData.size > 0,
  };
}

// Roll past due dates forward so "next payment" stays current.
export function nextDue(s) {
  if (!s.next_date) return null;
  let d = s.next_date; const t = today(); let guard = 0;
  while (d < t && guard++ < 600) d = s.cycle === 'weekly' ? addDays(d, 7) : addMonths(d, { monthly: 1, quarterly: 3, yearly: 12 }[s.cycle] || 1);
  return d;
}
export const upcomingSubs = (days = 14) => state.subs
  .filter((s) => s.active && !s.ignored && s.next_date)
  .map((s) => ({ ...s, next_date: nextDue(s) }))
  .filter((s) => s.next_date <= addDays(today(), days))
  .sort((a, b) => a.next_date.localeCompare(b.next_date));
