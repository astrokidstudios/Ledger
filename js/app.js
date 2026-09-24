import { sb, state, loadCore, countUncategorised } from './db.js';
import { $, $$, esc, toast, opt } from './util.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTransactions } from './views/transactions.js';
import { openInbox } from './views/inbox.js';
import { renderAccounts } from './views/accounts.js';
import { renderSubscriptions } from './views/subscriptions.js';
import { renderReceipts } from './views/receipts.js';
import { renderPlan } from './views/plan.js';
import { renderSettings } from './views/settings.js';

const ROUTES = {
  dashboard: { label: 'Overview', icon: '◎', render: renderDashboard },
  transactions: { label: 'Money in & out', icon: '⇅', render: renderTransactions },
  plan: { label: 'Goals & budget', icon: '◆', render: renderPlan },
  subscriptions: { label: 'Subscriptions', icon: '↻', render: renderSubscriptions },
  receipts: { label: 'Receipts', icon: '▤', render: renderReceipts },
  accounts: { label: 'Accounts', icon: '▣', render: renderAccounts },
  settings: { label: 'Settings', icon: '⚙', render: renderSettings },
};

const root = $('#app');

// ---------------- sign-in ----------------
function renderLogin(msg = '') {
  root.innerHTML = `
  <div class="auth">
    <div class="auth-card">
      <div class="brand big">Ledger</div>
      <p class="muted">Private finance. Sign in to continue.</p>
      <form id="login">
        <label>Email<input type="email" name="email" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required minlength="10"></label>
        <button class="btn primary full">Sign in</button>
      </form>
      <p class="err">${esc(msg)}</p>
      <details class="first-time"><summary>First time here? Create the owner account</summary>
        <p class="muted small">Only one account can ever be created. After that, sign-ups are closed permanently.</p>
        <form id="signup">
          <label>Email<input type="email" name="email" autocomplete="username" required></label>
          <label>Password (12+ characters)<input type="password" name="password" autocomplete="new-password" required minlength="12"></label>
          <button class="btn full">Create account</button>
        </form>
      </details>
    </div>
  </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) return renderLogin(error.message.includes('confirm') ? 'Please confirm your email first (check your inbox).' : 'Email or password is incorrect.');
    await afterSignIn();
  };
  $('#signup').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { data, error } = await sb.auth.signUp({
      email: f.get('email'), password: f.get('password'),
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) return renderLogin(/closed|Database error/i.test(error.message) ? 'Sign-ups are closed. This Ledger already has an owner.' : error.message);
    if (!data.session) return renderLogin('Account created. Check your email and click the confirmation link, then sign in here.');
    await afterSignIn();
  };
}

async function renderMfa() {
  root.innerHTML = `<div class="auth"><div class="auth-card">
    <div class="brand big">Ledger</div><p class="muted">Enter the 6-digit code from your authenticator app.</p>
    <form id="mfa"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required class="code-input">
    <button class="btn primary full">Verify</button></form><p class="err" id="mfa-err"></p>
    <button class="btn ghost full" id="mfa-out">Sign out</button></div></div>`;
  $('#mfa-out').onclick = signOut;
  $('#mfa').onsubmit = async (e) => {
    e.preventDefault();
    const { data: f } = await sb.auth.mfa.listFactors();
    const factor = f?.totp?.find((x) => x.status === 'verified');
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: new FormData(e.target).get('code') });
    if (error) { $('#mfa-err').textContent = 'That code did not work. Try the newest one.'; return; }
    await afterSignIn();
  };
}

async function afterSignIn() {
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return renderMfa();
  const { data: { user } } = await sb.auth.getUser();
  state.user = user;
  try { await loadCore(); } catch (e) { toast(e.message, 'bad'); }
  renderShell();
  startIdleTimer();
  route();
  const n = await countUncategorised().catch(() => 0);
  if (n > 0 && !sessionStorage.getItem('inbox-shown')) { sessionStorage.setItem('inbox-shown', '1'); openInbox(); }
}

export async function signOut() {
  await sb.auth.signOut();
  sessionStorage.clear();
  location.hash = '';
  location.reload();
}

// ---------------- idle sign-out ----------------
let idleTimer;
function startIdleTimer() {
  const mins = state.settings?.idle_minutes || 15;
  const reset = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { toast('Signed out after inactivity'); signOut(); }, mins * 60000); };
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
  reset();
}

// ---------------- layout ----------------
function renderShell() {
  const links = Object.entries(ROUTES).map(([k, r]) => `<a href="#/${k}" data-r="${k}"><span class="ic">${r.icon}</span><span>${r.label}</span></a>`).join('');
  root.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand">Ledger</div>
      <nav>${links}</nav>
      <button class="btn ghost small signout">Sign out</button>
    </aside>
    <div class="main">
      <header class="top">
        <div class="switch" id="scope">
          ${['all', 'personal', 'business'].map((s) => `<button data-s="${s}" class="${state.scope === s && !state.accountId ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
        <select id="acct-pick" aria-label="Account">
          ${opt('', 'All accounts', !state.accountId)}
          ${['personal', 'business'].map((sc) => {
            const accs = state.accounts.filter((a) => a.scope === sc && !a.archived);
            return accs.length ? `<optgroup label="${sc === 'personal' ? 'Personal' : 'Business'}">${accs.map((a) => opt(a.id, a.name, state.accountId === a.id)).join('')}</optgroup>` : '';
          }).join('')}
        </select>
        <button class="btn primary small" id="inbox-btn">To categorise <span class="pill" id="inbox-count">…</span></button>
      </header>
      <main id="view"></main>
    </div>
    <nav class="bottom">${Object.entries(ROUTES).filter(([k]) => k !== 'settings' && k !== 'accounts').map(([k, r]) => `<a href="#/${k}" data-r="${k}"><span class="ic">${r.icon}</span><span>${r.label.split(' ')[0]}</span></a>`).join('')}<a href="#/settings" data-r="settings"><span class="ic">⋯</span><span>More</span></a></nav>
  </div>`;
  $('.signout').onclick = signOut;
  $('#inbox-btn').onclick = () => openInbox();
  $$('#scope button').forEach((b) => { b.onclick = () => { state.scope = b.dataset.s; state.accountId = ''; renderShell(); route(); }; });
  $('#acct-pick').onchange = (e) => { state.accountId = e.target.value; renderShell(); route(); };
  refreshInboxCount();
}

export function rebuild() { renderShell(); route(); }

export async function refreshInboxCount() {
  const n = await countUncategorised().catch(() => 0);
  const el = $('#inbox-count'); if (el) el.textContent = n;
  const b = $('#inbox-btn'); if (b) b.classList.toggle('quiet', n === 0);
}

export async function route() {
  const key = (location.hash.replace(/^#\//, '').split('?')[0]) || 'dashboard';
  const r = ROUTES[key] || ROUTES.dashboard;
  $$('[data-r]').forEach((a) => a.classList.toggle('on', a.dataset.r === key));
  const view = $('#view');
  if (!view) return;
  view.innerHTML = '<div class="loading">Loading…</div>';
  try { await r.render(view); } catch (e) { console.error(e); view.innerHTML = `<div class="card err">Something went wrong: ${esc(e.message)}</div>`; }
}

window.addEventListener('hashchange', () => { if (state.user) route(); });

// ---------------- boot ----------------
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await afterSignIn(); else renderLogin();
})();
