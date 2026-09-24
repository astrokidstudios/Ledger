// Reads bank CSV exports (most banks, English or Polish headers) into
// {date, description, amount, currency}. Only those columns are kept, so
// things like sort codes and account numbers in the file are never stored.

export async function readFileText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) {
    try { text = new TextDecoder('windows-1250').decode(buf); } catch { /* keep utf-8 */ }
  }
  return text.replace(/^﻿/, '');
}

export function parseRows(text) {
  // Pick the delimiter from the busiest line (bank files often start with title lines)
  const sample = text.split(/\r?\n/).slice(0, 40);
  const score = (d) => Math.max(...sample.map((l) => l.split(d).length - 1));
  const delimiter = [',', ';', '\t', '|'].sort((a, b) => score(b) - score(a))[0];
  const res = window.Papa.parse(text.trim(), { skipEmptyLines: 'greedy', delimiter });
  return res.data.map((r) => r.map((c) => String(c ?? '').trim()));
}

const clean = (h) => h.toLowerCase().replace(/^#/, '').trim();
const find = (headers, re, not) => headers.find((h) => re.test(clean(h)) && !(not && not.test(clean(h))));

export function detectMapping(rows, forcedHeaderRow) {
  // header = first row with 3+ cells that mentions a date-ish word
  let headerRow = forcedHeaderRow ?? rows.findIndex((r) => r.filter(Boolean).length >= 3 && r.some((c) => /date|data|datum/i.test(c)));
  if (headerRow < 0 || headerRow >= rows.length) headerRow = 0;
  const headers = rows[headerRow] || [];
  const date = find(headers, /^(transaction date|date|data operacji|data transakcji|data|booking date|posted date)$/) || find(headers, /date|data/);
  const debit = find(headers, /^(debit amount|debit|money out|paid out|out|withdrawals?)$/);
  const credit = find(headers, /^(credit amount|credit|money in|paid in|in|deposits?)$/);
  const amount = (!debit || !credit) ? (find(headers, /^(amount|kwota|value|kwota operacji|transaction amount)$/) || find(headers, /amount|kwota/, /local|balance|saldo/)) : null;
  const currency = find(headers, /^(currency|waluta)$/);
  const descCandidates = [
    find(headers, /^(transaction description|description|opis operacji|opis|details|narrative|reference)$/),
    find(headers, /^(name|payee|merchant|nadawca\/odbiorca|counterparty|tytul|tytuł)$/),
  ].filter(Boolean);
  const desc = descCandidates.length ? [...new Set(descCandidates)] : [headers.find((h) => h !== date && h !== amount) || headers[1]];
  const sample = rows.slice(headerRow + 1).map((r) => r[headers.indexOf(date)]).find(Boolean) || '';
  const dateFmt = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(sample) ? 'ymd' : 'dmy';
  // Prefer a clean "name/payee" column before a longer description column
  desc.sort((a, b) => (/name|nadawca|payee|merchant/i.test(a) ? -1 : 0) - (/name|nadawca|payee|merchant/i.test(b) ? -1 : 0));
  return { headerRow, date, dateFmt, desc, amount, debit: amount ? null : debit, credit: amount ? null : credit, currency, invert: false };
}

export function parseAmount(v) {
  if (v == null) return null;
  let s = String(v).replace(/[\s ]/g, '').replace(/[A-Za-zł£$€zł]+/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  const lc = s.lastIndexOf(','); const ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc > -1) s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}

export function parseDate(v, fmt) {
  const s = String(v || '').trim().split(/[ T]/)[0];
  const p = s.split(/[-./]/).map((x) => parseInt(x, 10));
  if (p.length < 3 || p.some(Number.isNaN)) return null;
  let y; let m; let d;
  if (fmt === 'ymd') [y, m, d] = p;
  else if (fmt === 'mdy') [m, d, y] = p;
  else [d, m, y] = p;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function applyMapping(rows, map, fallbackCurrency) {
  const headers = rows[map.headerRow] || [];
  const idx = (h) => (h ? headers.indexOf(h) : -1);
  const di = idx(map.date); const ai = idx(map.amount); const dbi = idx(map.debit); const cri = idx(map.credit); const ci = idx(map.currency);
  const descIdx = (map.desc || []).map(idx).filter((i) => i >= 0);
  const out = []; const skipped = [];
  rows.slice(map.headerRow + 1).forEach((r, i) => {
    const date = parseDate(r[di], map.dateFmt);
    let amount = null;
    if (ai >= 0) amount = parseAmount(r[ai]);
    else {
      const dv = parseAmount(r[dbi]); const cv = parseAmount(r[cri]);
      if (dv != null || cv != null) amount = (cv ? Math.abs(cv) : 0) - (dv ? Math.abs(dv) : 0);
    }
    if (map.invert && amount != null) amount = -amount;
    const description = descIdx.map((j) => r[j]).filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(' · ');
    if (!date || amount == null || amount === 0 || !description) { skipped.push(i + map.headerRow + 2); return; }
    const currency = ci >= 0 && /^[A-Z]{3}$/.test(r[ci]) ? r[ci] : fallbackCurrency;
    out.push({ date, description: description.slice(0, 300), amount: Math.round(amount * 100) / 100, currency });
  });
  return { rows: out, skipped };
}
