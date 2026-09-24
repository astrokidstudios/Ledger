import { sb, state, fetchTxns, learnRule, catById, accById } from '../db.js';
import { esc, fmt, modal, niceDate, opt, toast, $, $$ } from '../util.js';
import { refreshInboxCount, route } from '../app.js';

export function categoryOptions(selected, amount) {
  const kinds = amount >= 0 ? ['income', 'transfer', 'expense'] : ['expense', 'transfer', 'income'];
  const label = { expense: 'Spending', income: 'Income', transfer: 'Transfers & savings' };
  return opt('', '— choose —', !selected) + kinds.map((k) => `<optgroup label="${label[k]}">${
    state.categories.filter((c) => c.kind === k).map((c) => opt(c.id, c.name + (c.scope === 'business' ? ' (business)' : ''), c.id === selected)).join('')
  }</optgroup>`).join('');
}

// The "to categorise" pop-up: uncategorised transactions grouped by payee,
// so one choice sorts every payment from the same place and is remembered.
export async function openInbox() {
  const txns = await fetchTxns({ uncategorised: true });
  const groups = {};
  for (const t of txns) (groups[t.payee_key || t.description] ||= []).push(t);
  const list = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

  const m = modal(`
    <h2>To categorise</h2>
    ${list.length ? `<p class="muted small">Payments from the same place are grouped. Pick a category once and Ledger remembers it for next time.</p>
    <div class="inbox">
      ${list.map(([key, ts], gi) => {
        const total = ts.reduce((s, t) => s + Number(t.amount), 0);
        const t0 = ts[0];
        const acc = accById(t0.account_id);
        return `<div class="inbox-item" data-g="${gi}">
          <div class="ii-main">
            <div class="ii-title">${esc(t0.description)}</div>
            <div class="muted small">${ts.length > 1 ? `${ts.length} payments · ` : ''}${niceDate(t0.txn_date)} · ${esc(acc?.name || '')}</div>
          </div>
          <div class="ii-amt ${total < 0 ? '' : 'pos'}">${fmt(total, t0.currency, { sign: true })}</div>
          <div class="ii-ctrl">
            <select data-g="${gi}">${categoryOptions(null, Number(t0.amount))}</select>
            <label class="check small"><input type="checkbox" data-remember="${gi}" checked> Always for “${esc(key)}”</label>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="row end"><button class="btn primary" id="inbox-done">Done</button></div>`
    : '<p>All caught up. Nothing waiting to be categorised. 🎉</p>'}`, { wide: true, onClose: () => { refreshInboxCount(); route(); } });

  $$('select[data-g]', m.el).forEach((sel) => {
    sel.onchange = async () => {
      const gi = Number(sel.dataset.g);
      const [key, ts] = list[gi];
      const catId = sel.value; if (!catId) return;
      const remember = $(`[data-remember="${gi}"]`, m.el).checked;
      try {
        if (remember) {
          await learnRule(key, catId); // also sorts every other waiting payment from this payee
        } else {
          const { error } = await sb.from('transactions').update({ category_id: catId, auto_categorised: false }).in('id', ts.map((t) => t.id));
          if (error) throw error;
        }
        const row = sel.closest('.inbox-item');
        row.classList.add('done');
        row.querySelector('.ii-ctrl').innerHTML = `<span class="tag good">✓ ${esc(catById(catId)?.name)}</span>`;
      } catch (e) { toast(e.message, 'bad'); }
    };
  });
  const done = $('#inbox-done', m.el); if (done) done.onclick = () => m.close();
}
