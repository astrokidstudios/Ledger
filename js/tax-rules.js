// Polish tax rules for a single-owner sp. z o.o. (limited company).
// Pure functions only: no data, no DOM. Rates live in RULES by year so a
// new tax year is a matter of adding one entry. All amounts are in PLN.
//
// These are estimates to plan with. The accountant's (księgowa) figures win.

export const RULES = {
  2026: {
    cit: { small: 0.09, standard: 0.19, smallLimitEur: 2000000 },
    dividendTax: 0.19,
    vat: { standard: 0.23, exemptLimit: 240000 },
    zus: {
      // sole shareholder of a jednoosobowa sp. z o.o., full contributions
      base: 5652.00, // 60% of forecast average wage
      pension: 1103.27, disability: 452.16, sickness: 138.47, accident: 94.39, labourFund: 138.47,
      health: 432.54, // 9% of the 4,806 zł minimum wage
    },
    pit: {
      threshold: 120000, low: 0.12, high: 0.32, reduction: 3600, // 30,000 zł tax-free
      boardCostsMonthly: 250, // koszty uzyskania for board pay by resolution
      healthOnBoardPay: 0.09,
      solidarityOver: 1000000, solidarity: 0.04,
    },
    minWage: 4806,
  },
};

export const rulesFor = (year) => RULES[year] || RULES[Math.max(...Object.keys(RULES).map(Number).filter((y) => y <= year))] || RULES[2026];

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function zusMonthly(year, { sickness = true } = {}) {
  const z = rulesFor(year).zus;
  const social = z.pension + z.disability + z.accident + z.labourFund + (sickness ? z.sickness : 0);
  return { social: r2(social), health: z.health, total: r2(social + z.health) };
}

export const DEFAULT_TAX = {
  company_start: null, // date the company was entered in KRS (ZUS starts here)
  sole_shareholder: true,
  sickness: true,
  cit_rate: 0.09,
  cit_advances: 'monthly', // or 'quarterly'
  vat_registered: true,
  board_pay_monthly: 0, // planned gross board pay (powołanie)
  pit2: true, // PIT-2 filed so the monthly tax-free reduction is applied
  deduct_zus_from_pit: true, // shareholder social ZUS deducted from board-pay income
};
export const taxSettings = (s) => ({ ...DEFAULT_TAX, ...(s || {}) });

// ---------- personal income tax on board pay (annual) ----------
// Board pay by resolution: no social ZUS, 9% health on the gross, PIT on the
// scale after 250 zł/month costs. The shareholder's own social ZUS can be
// deducted from this income.
export function boardPayTax(gross, year, { months = 12, zusSocialDeductible = 0 } = {}) {
  const p = rulesFor(year).pit;
  if (gross <= 0) return { gross: 0, health: 0, pit: 0, solidarity: 0, net: 0, taxable: 0 };
  const costs = Math.min(gross, p.boardCostsMonthly * months);
  const taxable = Math.max(0, gross - costs - zusSocialDeductible);
  let pit = taxable <= p.threshold ? taxable * p.low - p.reduction
    : p.threshold * p.low - p.reduction + (taxable - p.threshold) * p.high;
  pit = Math.max(0, pit);
  const solidarity = Math.max(0, taxable - p.solidarityOver) * p.solidarity;
  const health = gross * p.healthOnBoardPay;
  return { gross, health: r2(health), pit: r2(pit), solidarity: r2(solidarity), taxable: r2(taxable), net: r2(gross - health - pit - solidarity) };
}

// ---------- how much reaches you personally ----------
// profit = company profit for the year BEFORE paying you any board pay.
// board = gross board pay for the year. Everything left is paid as dividend.
export function takeHome(profit, board, year, opts = {}) {
  const R = rulesFor(year);
  const citRate = opts.citRate ?? R.cit.small;
  const zus = opts.soleShareholder === false ? { social: 0, health: 0 } : zusMonthly(year, { sickness: opts.sickness !== false });
  const zusMonths = opts.zusMonths ?? 12;
  const zusSocialYear = zus.social * zusMonths;
  const zusHealthYear = zus.health * zusMonths;
  const b = Math.max(0, Math.min(board, profit));
  const pay = boardPayTax(b, year, { zusSocialDeductible: opts.deductZus === false ? 0 : Math.min(zusSocialYear, Math.max(0, b - R.pit.boardCostsMonthly * 12)) });
  const companyProfit = Math.max(0, profit - b);
  const cit = companyProfit * citRate;
  const dividend = companyProfit - cit;
  const divTax = dividend * R.dividendTax;
  const netDividend = dividend - divTax;
  const zusTotal = zusSocialYear + zusHealthYear;
  const net = pay.net + netDividend - zusTotal;
  const totalTax = pay.health + pay.pit + pay.solidarity + cit + divTax + zusTotal;
  return {
    profit, board: b, pay, cit: r2(cit), dividend: r2(dividend), divTax: r2(divTax), netDividend: r2(netDividend),
    zusSocial: r2(zusSocialYear), zusHealth: r2(zusHealthYear), zusTotal: r2(zusTotal),
    net: r2(net), totalTax: r2(totalTax), effective: profit > 0 ? totalTax / profit : 0,
  };
}

// Search board pay from 0 to profit for the highest take-home.
export function bestSplit(profit, year, opts = {}) {
  const step = Math.max(100, Math.round(profit / 2000 / 100) * 100);
  let best = takeHome(profit, 0, year, opts);
  for (let b = step; b <= profit; b += step) {
    const t = takeHome(profit, b, year, opts);
    if (t.net > best.net + 0.5) best = t;
  }
  // refine around the best point
  for (let b = Math.max(0, best.board - step); b <= Math.min(profit, best.board + step); b += 10) {
    const t = takeHome(profit, b, year, opts);
    if (t.net > best.net + 0.01) best = t;
  }
  return best;
}

// ---------- CIT advances (zaliczki) ----------
// monthly = [{month:1..12, revenue, costs}], returns cumulative advances.
export function citAdvances(monthly, rate, mode = 'monthly') {
  let cumRev = 0; let cumCost = 0; let paid = 0;
  return monthly.map((m) => {
    cumRev += m.revenue; cumCost += m.costs;
    const cumProfit = cumRev - cumCost;
    const isDue = mode === 'monthly' || m.month % 3 === 0;
    let advance = 0;
    if (isDue) {
      advance = Math.max(0, Math.round(Math.max(0, cumProfit) * rate) - paid); // zaliczki are rounded to whole złoty
      paid += advance;
    }
    return { ...m, profit: m.revenue - m.costs, cumProfit, advance, isDue };
  });
}

// ---------- deadlines ----------
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
const ymd = (d) => d.toISOString().slice(0, 10);
const addD = (d, n) => new Date(d.getTime() + n * 86400000);
const holidayCache = {};
export function polishHolidays(y) {
  if (holidayCache[y]) return holidayCache[y];
  const e = easter(y);
  const fixed = ['01-01', '01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-25', '12-26'];
  if (y >= 2025) fixed.push('12-24');
  const set = new Set([...fixed.map((md) => `${y}-${md}`), ymd(e), ymd(addD(e, 1)), ymd(addD(e, 49)), ymd(addD(e, 60))]);
  holidayCache[y] = set;
  return set;
}
// Tax law: a deadline on a Saturday, Sunday or public holiday moves to the next working day.
export function workingDay(dateStr) {
  let d = new Date(`${dateStr}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !polishHolidays(d.getUTCFullYear()).has(ymd(d))) break;
    d = addD(d, 1);
  }
  return ymd(d);
}
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTHS[m - 1];

// Every deadline that applies in calendar year `year` (by due date).
export function deadlines(year, t) {
  const out = [];
  const add = (date, title, detail, kind, extra = {}) => out.push({ date: workingDay(date), nominal: date, title, detail, kind, ...extra });
  const start = t.company_start || `${year - 1}-01-01`;
  for (let m = 1; m <= 12; m++) {
    // obligations for the previous month
    const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? year - 1 : year;
    const forMonthEnd = `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`;
    const active = forMonthEnd >= start;
    if (!active) continue;
    const label = `${monthName(pm)} ${py}`;
    if (t.sole_shareholder) add(`${year}-${pad(m)}-20`, 'ZUS', `Your shareholder contributions for ${label} (DRA and payment)`, 'zus', { forYear: py, forMonth: pm });
    if (t.cit_advances === 'monthly' || pm % 3 === 0) {
      add(`${year}-${pad(m)}-20`, 'CIT advance', `Company tax advance for ${t.cit_advances === 'monthly' ? label : `Q${pm / 3} ${py}`}`, 'cit', { forYear: py, forMonth: pm });
    }
    if (Number(t.board_pay_monthly) > 0) add(`${year}-${pad(m)}-20`, 'PIT on board pay', `Income tax withheld from your ${label} board pay`, 'pit');
    if (t.vat_registered) add(`${year}-${pad(m)}-25`, 'JPK_V7M + VAT', `VAT return and payment for ${label}`, 'vat', { forYear: py, forMonth: pm });
  }
  const sorted = () => out.sort((a, b) => a.date.localeCompare(b.date));
  if (start >= `${year}-01-01`) return sorted(); // no previous year to close
  add(`${year}-01-31`, 'PIT-4R · PIT-11 · PIT-8AR', `Annual withholding returns for ${year - 1} (board pay and dividend tax), filed by the company`, 'annual');
  add(`${year}-02-28`, 'PIT-11 to you', `Company gives you your ${year - 1} board-pay tax summary`, 'annual');
  add(`${year}-03-31`, 'CIT-8 + final CIT', `Company annual tax return and balance for ${year - 1}; accounts (sprawozdanie finansowe) must also be drawn up`, 'annual');
  add(`${year}-04-30`, 'Your PIT-36', `Personal tax return for ${year - 1} if you had board pay`, 'annual');
  add(`${year}-06-30`, 'Approve accounts + profit', `Shareholder resolution approving ${year - 1} accounts and deciding the dividend`, 'annual');
  add(`${year}-07-15`, 'File accounts at KRS', `Send approved ${year - 1} accounts and the resolutions to the court register (15 days after approval)`, 'annual');
  return sorted();
}
