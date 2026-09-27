// Reads bank-statement PDFs (e.g. Tide, and most table-style statements) into
// {date, description, amount, currency, notes} rows, entirely in the browser.
// Like the CSV importer, only those fields are kept: account numbers, sort
// codes and addresses on the statement are never stored.
//
// How it works: pdf.js gives every piece of text with its position. We find
// the table header (Date / Details / Paid in / Paid out / Balance), work out
// the columns from it, group the lines into one block per transaction, and
// read the amount from whichever money column it sits under.

import { parseAmount } from './csv.js';

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

// -> [{ items: [{ s, x, y, w, h }] }] with y measured from the top of the page
export async function extractPages(data, lib) {
  const pdf = lib || await loadPdfjs();
  const task = pdf.getDocument({ data, isEvalSupported: false, disableFontFace: true });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { height } = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      items: tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
        s: it.str.replace(/\s+/g, ' ').trim(), x: it.transform[4], y: height - it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]) || 8,
      })),
    });
  }
  await task.destroy();
  return pages;
}

export async function readPdfStatement(file, fallbackCurrency) {
  const pages = await extractPages(new Uint8Array(await file.arrayBuffer()));
  return parseStatement(pages, fallbackCurrency);
}

// ---------------- parsing (pure, testable) ----------------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
export function pdfDate(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s-,]*(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`; }
  m = t.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (m && Number(m[2]) <= 12) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  return null;
}
const isMoney = (s) => /^[-+(]?[£$€]?\s?-?\d{1,3}([ ,. ]?\d{3})*[.,]\d{2}\)?\s?-?(zł|PLN|GBP|EUR)?$/.test(s.trim());

const COLS = [
  ['date', /^(date|data|transaction date|posting date|booking date|data operacji|data księgowania|data transakcji)\b/i],
  ['type', /(transaction type|^type$|^typ|rodzaj)/i],
  ['in', /(paid in|money in|^credits?\b|deposits?|wpływy|uznania|przychody)/i],
  ['out', /(paid out|money out|^debits?\b|withdrawals?|wypływy|obciążenia|rozchody)/i],
  ['balance', /(balance|saldo)/i],
  ['amount', /(^amount|kwota|^value)/i],
  ['details', /(details|description|opis|tytuł|narrative|particulars|payee|kontrahent|reference)/i],
];
const kindOf = (s) => (COLS.find(([, re]) => re.test(s.trim())) || [null])[0];

function toLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2) last.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    // merge fragments of the same phrase ("Paid in" + "(£)")
    const merged = [];
    for (const it of l.items) {
      const p = merged[merged.length - 1];
      if (p && it.x - (p.x + p.w) < Math.max(2.5, p.h * 0.35)) { p.s = `${p.s} ${it.s}`.replace(/\s+/g, ' '); p.w = it.x + it.w - p.x; } else merged.push({ ...it });
    }
    l.items = merged;
    l.text = merged.map((i) => i.s).join(' ');
  }
  return lines;
}

function findHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    const kinds = lines[i].items.map((it) => kindOf(it.s));
    if (kinds.includes('date') && kinds.filter(Boolean).length >= 3 && kinds.some((k) => ['in', 'out', 'amount'].includes(k))) {
      const cols = lines[i].items.map((it, j) => ({ kind: kinds[j], x: it.x, w: it.w, label: it.s })).filter((c) => c.kind);
      return { index: i, y: lines[i].y, cols };
    }
  }
  return null;
}

function currencyFrom(text, fallback) {
  if (/£|GBP/.test(text)) return 'GBP';
  if (/€|EUR/.test(text)) return 'EUR';
  if (/zł|PLN/.test(text)) return 'PLN';
  if (/\$|USD/.test(text)) return 'USD';
  return fallback;
}

// money item -> column by horizontal overlap with the header label (works for
// left- and right-aligned figures); text item -> the column it starts in
function moneyCol(it, cols) {
  const money = cols.filter((c) => ['in', 'out', 'amount', 'balance'].includes(c.kind));
  let best = null; let bestScore = -Infinity;
  for (const c of money) {
    const overlap = Math.min(it.x + it.w, c.x + c.w) - Math.max(it.x, c.x);
    const score = overlap > 0 ? overlap : -Math.abs((it.x + it.w / 2) - (c.x + c.w / 2));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
function textCol(it, cols) {
  const sorted = [...cols].sort((a, b) => a.x - b.x);
  let found = sorted[0];
  for (const c of sorted) if (it.x >= c.x - 3) found = c;
  return found;
}

const NOISE = [/^tide card:.*$/i, /^card:? \*+.*$/i, /^fee \([^)]*\):\s*0\.00$/i];
function cleanDetails(parts) {
  const notes = [];
  const kept = [];
  for (let p of parts) {
    p = p.replace(/,?\s*fee \([^)]*\):\s*0\.00\s*$/i, '').trim();
    if (!p || NOISE.some((re) => re.test(p))) continue;
    if (/^orig\. amt/i.test(p)) { notes.push(p.replace(/,?\s*fee \([^)]*\):\s*[\d.]+$/i, '')); continue; }
    kept.push(p);
  }
  return { description: kept.join(' ').replace(/\s+/g, ' ').trim(), notes: notes.join('; ') };
}

export function parseStatement(pages, fallbackCurrency = 'GBP') {
  let cols = null; let currency = null;
  const summaryLines = [];
  const rows = [];
  let order = 0;

  for (const page of pages) {
    const lines = toLines(page.items);
    const header = findHeader(lines);
    if (header) {
      cols = header.cols;
      if (!currency) currency = currencyFrom(lines[header.index].text, null);
      summaryLines.push(...lines.slice(0, header.index).map((l) => l.text));
    }
    if (!cols) { summaryLines.push(...lines.map((l) => l.text)); continue; }
    const dateCol = cols.find((c) => c.kind === 'date');
    const firstMoney = Math.min(...cols.filter((c) => ['in', 'out', 'amount', 'balance'].includes(c.kind)).map((c) => c.x));
    const body = lines.filter((l) => !header || l.y > header.y);

    // a line is an "anchor" when a date sits in the date column
    const isAnchor = (l) => l.items.some((it) => Math.abs(it.x - dateCol.x) < 25 && pdfDate(it.s));
    // blocks = runs of lines without a big vertical gap
    const h = body.length ? body.map((l) => l.items[0].h).sort((a, b) => a - b)[Math.floor(body.length / 2)] : 8;
    const blocks = [];
    for (const l of body) {
      const last = blocks[blocks.length - 1];
      if (last && l.y - last[last.length - 1].y <= h * 1.4) last.push(l); else blocks.push([l]);
    }
    for (const block of blocks) {
      const anchors = block.filter(isAnchor);
      if (!anchors.length) continue;
      // split blocks holding several transactions halfway between their dates
      anchors.forEach((a, i) => {
        const lo = i === 0 ? -Infinity : (anchors[i - 1].y + a.y) / 2;
        const hi = i === anchors.length - 1 ? Infinity : (a.y + anchors[i + 1].y) / 2;
        const part = block.filter((l) => l.y > lo && l.y <= hi);
        const dateItem = a.items.find((it) => Math.abs(it.x - dateCol.x) < 25 && pdfDate(it.s));
        const vals = {}; const details = []; const types = [];
        for (const l of part) {
          for (const it of l.items) {
            if (it === dateItem) continue;
            if (isMoney(it.s) && it.x >= firstMoney - 40) {
              const c = moneyCol(it, cols);
              if (c && vals[c.kind] == null) vals[c.kind] = parseAmount(it.s.replace(/[()]/g, (m) => (m === '(' ? '-' : '')));
              continue;
            }
            const c = textCol(it, cols);
            if (c.kind === 'type') types.push(it.s);
            else if (c.kind !== 'date') details.push(it.s);
          }
        }
        let amount = null;
        if (vals.in != null && vals.in !== 0) amount = Math.abs(vals.in);
        else if (vals.out != null && vals.out !== 0) amount = -Math.abs(vals.out);
        else if (vals.amount != null) amount = vals.amount;
        const { description, notes } = cleanDetails(details);
        const type = types.join(' ').trim();
        if (amount == null || amount === 0) return;
        rows.push({
          date: pdfDate(dateItem.s),
          description: (description || type || 'Bank transaction').slice(0, 300) + (/refund/i.test(type) && !/refund/i.test(description) ? ' (refund)' : ''),
          amount: Math.round(amount * 100) / 100,
          currency: currency || fallbackCurrency,
          notes: notes || null,
          type,
          balance: vals.balance ?? null,
          order: order++,
        });
      });
    }
  }
  return { rows, meta: readSummary(summaryLines), currency: currency || fallbackCurrency, check: reconcile(rows, readSummary(summaryLines)) };
}

function readSummary(lines) {
  // the figure is the last token on the line; only comma-decimal (Polish)
  // amounts may use spaces as thousand separators ("12 345,67")
  const num = (l) => {
    const t = l.trim().split(/\s+/);
    let last = t.pop() || '';
    if (/^\d{3},\d{2}$/.test(last)) while (t.length && /^\d{1,3}$/.test(t[t.length - 1])) last = `${t.pop()}${last}`;
    return isMoney(last) ? parseAmount(last) : null;
  };
  const meta = {};
  for (const l of lines) {
    if (/total paid in|money in|total credits|suma uznań|wpływy/i.test(l) && meta.totalIn == null) meta.totalIn = num(l);
    else if (/total paid out|money out|total debits|suma obciążeń|wydatki/i.test(l) && meta.totalOut == null) meta.totalOut = num(l);
    else if (/(opening|start|balance).*(on|at|b\/f)|saldo pocz/i.test(l) && meta.opening == null) meta.opening = num(l);
    else if (/(closing|end|balance).*(on|at|c\/f)|saldo końc/i.test(l) && meta.opening != null && meta.closing == null) meta.closing = num(l);
    const p = l.match(/(\d{1,2} [A-Za-z]{3,9} \d{4})\s*[-–]\s*(\d{1,2} [A-Za-z]{3,9} \d{4})/);
    if (p && !meta.from) { meta.from = pdfDate(p[1]); meta.to = pdfDate(p[2]); }
  }
  return meta;
}

const c2 = (n) => Math.round(n * 100);
function reconcile(rows, meta) {
  const inSum = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const outSum = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  const checks = [];
  if (meta.totalIn != null) checks.push({ label: 'Money in', ok: c2(inSum) === c2(meta.totalIn), found: inSum, expected: meta.totalIn });
  if (meta.totalOut != null) checks.push({ label: 'Money out', ok: c2(outSum) === c2(meta.totalOut), found: outSum, expected: meta.totalOut });
  if (meta.opening != null && meta.closing != null) {
    checks.push({ label: 'Closing balance', ok: c2(meta.opening + inSum - outSum) === c2(meta.closing), found: meta.opening + inSum - outSum, expected: meta.closing });
  }
  // running balance: each row's balance should follow from the one before it
  // (works whichever order the statement lists them in)
  const withBal = rows.filter((r) => r.balance != null);
  let breaks = 0;
  for (let i = 1; i < withBal.length; i++) {
    const a = withBal[i - 1]; const b = withBal[i];
    const newestFirst = c2(b.balance + a.amount) === c2(a.balance);
    const oldestFirst = c2(a.balance + b.amount) === c2(b.balance);
    if (!newestFirst && !oldestFirst) breaks++;
  }
  if (withBal.length > 1) checks.push({ label: 'Running balance', ok: breaks === 0, breaks });
  return { inSum, outSum, checks, ok: checks.length > 0 && checks.every((c) => c.ok) };
}
