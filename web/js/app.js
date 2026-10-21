// Application bootstrap: auth state, hash router, app shell.
import { supabase, config, configProblems } from './supabase.js';
import { state, loadContext, loadSettings, setting, me, isAdminArea, logEvent } from './api.js';
import { icon } from './icons.js';
import { esc, $, $$, initials, setTitle, toastError, toast, errorState } from './ui.js';
import { t, setLang, getLang } from './i18n.js';

const routes = [
  { path: '/login', page: () => import('./pages/auth.js'), fn: 'renderLogin', public: true },
  { path: '/forgot-password', page: () => import('./pages/auth.js'), fn: 'renderForgot', public: true },
  { path: '/reset-password', page: () => import('./pages/auth.js'), fn: 'renderReset', public: true },
  { path: '/register', page: () => import('./pages/auth.js'), fn: 'renderRegister', public: true },
  { path: '/', page: () => import('./pages/dashboard.js'), nav: 'dashboard' },
  { path: '/documents', page: () => import('./pages/documents.js'), nav: 'documents' },
  { path: '/documents/:id', page: () => import('./pages/documents.js'), fn: 'renderDetail', nav: 'documents' },
  { path: '/applications', page: () => import('./pages/applications.js'), nav: 'applications' },
  { path: '/news', page: () => import('./pages/news.js'), nav: 'news' },
  { path: '/news/new', page: () => import('./pages/news.js'), fn: 'renderEditor', nav: 'news' },
  { path: '/news/:id', page: () => import('./pages/news.js'), fn: 'renderDetail', nav: 'news' },
  { path: '/news/:id/edit', page: () => import('./pages/news.js'), fn: 'renderEditor', nav: 'news' },
  { path: '/favorites', page: () => import('./pages/favorites.js'), nav: 'favorites' },
  { path: '/search', page: () => import('./pages/search.js'), nav: null },
  { path: '/profile', page: () => import('./pages/profile.js'), nav: null },
  { path: '/admin', page: () => import('./pages/admin.js'), nav: 'admin' },
  { path: '/admin/:tab', page: () => import('./pages/admin.js'), nav: 'admin' },
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  for (const r of routes) {
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    const m = re.exec(path);
    if (m) return { route: r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query, path };
  }
  return { route: null, params: {}, query, path };
}

export const navigate = (h) => { if (location.hash === h) router(); else location.hash = h; };

let shellMounted = false;
let renderSeq = 0;

function appName() { return setting('company.name', 'Company Intranet Portal'); }

function mountShell() {
  const p = me();
  const roleName = state.ctx.roles?.[0]?.name || '';
  const logo = setting('company.logo_url', '');
  const nav = [
    ['dashboard', '#/', 'dashboard'], ['documents', '#/documents', 'files'], ['applications', '#/applications', 'grid'],
    ['news', '#/news', 'news'], ['favorites', '#/favorites', 'star'],
  ];
  document.getElementById('app').innerHTML = `
  <div class="shell">
    <aside class="sidebar" aria-label="เมนูหลัก">
      <div class="brand">${logo ? `<img src="${esc(logo)}" alt="">` : `<span class="brand-mark">${esc(appName().slice(0, 1))}</span>`}
        <span class="brand-name">${esc(appName())}</span></div>
      <nav class="nav">
        ${nav.map(([k, h, ic]) => `<a href="${h}" data-nav="${k}">${icon(ic)}<span>${esc(t('nav.' + k))}</span></a>`).join('')}
        ${isAdminArea() ? `<div class="nav-sep"></div><a href="#/admin" data-nav="admin">${icon('shield')}<span>${esc(t('nav.admin'))}</span></a>` : ''}
      </nav>
      <div class="sidebar-foot">${config.APP_ENV !== 'production' ? `<span class="env-badge">${esc(config.APP_ENV)}</span> ` : ''}
        <button class="btn btn-sm btn-ghost" data-lang style="color:#C3CEE2">${getLang() === 'th' ? 'English' : 'ภาษาไทย'}</button></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-icon menu-btn" data-menu aria-label="เปิดเมนู">${icon('menu')}</button>
        <form class="global-search" role="search" data-search>
          ${icon('search')}
          <label class="sr-only" for="gq">${esc(t('search.placeholder'))}</label>
          <input id="gq" name="q" type="search" placeholder="${esc(t('search.placeholder'))}" autocomplete="off">
        </form>
        <div class="topbar-right">
          <button class="user-btn" data-user aria-haspopup="menu" aria-expanded="false">
            <span class="avatar">${initials(p.full_name || p.email)}</span>
            <span class="user-meta"><b>${esc(p.full_name || p.email)}</b><span>${esc(state.ctx.department?.name || roleName)}</span></span>
          </button>
          <div class="menu-pop" data-user-menu role="menu" hidden>
            <div style="padding:8px 12px 10px;border-bottom:1px solid var(--line);margin-bottom:4px">
              <b style="display:block">${esc(p.full_name)}</b><span class="muted">${esc(p.email)}</span></div>
            <a href="#/profile" role="menuitem">${icon('user')} ${esc(t('nav.profile'))}</a>
            <button data-logout role="menuitem">${icon('logout')} ${esc(t('nav.logout'))}</button>
          </div>
        </div>
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
  </div>`;
  const shell = $('.shell');
  $('[data-menu]').addEventListener('click', () => shell.classList.toggle('nav-open'));
  shell.addEventListener('click', (e) => {
    if (shell.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('[data-menu]')) shell.classList.remove('nav-open');
  });
  const userBtn = $('[data-user]'); const menu = $('[data-user-menu]');
  userBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; userBtn.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('click', (e) => { if (!e.target.closest('[data-user-menu]')) { menu.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); } });
  $('[data-logout]').addEventListener('click', logout);
  $('[data-lang]').addEventListener('click', () => { setLang(getLang() === 'th' ? 'en' : 'th'); shellMounted = false; router(); });
  $('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#gq').value.trim();
    if (q) navigate(`#/search?q=${encodeURIComponent(q)}`);
  });
  shellMounted = true;
}

export async function logout() {
  await logEvent('auth.logout', 'profiles', me()?.id || '');
  await supabase.auth.signOut();
  state.ctx = null; shellMounted = false;
  navigate('#/login');
}

async function ensureContext() {
  if (state.ctx) return state.ctx;
  await loadContext();
  if (!state.ctx?.profile?.is_active) {
    await supabase.auth.signOut();
    state.ctx = null;
    throw Object.assign(new Error('บัญชีของคุณยังไม่เปิดใช้งานหรือถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ'), { inactive: true });
  }
  await loadSettings();
  return state.ctx;
}

async function router() {
  const seq = ++renderSeq;
  const { route, params, query, path } = parseHash();
  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;

  if (!route) { navigate('#/'); return; }

  if (route.public) {
    shellMounted = false;
    if (session && ['/login', '/register'].includes(path)) { navigate('#/'); return; }
    const mod = await route.page();
    document.getElementById('app').innerHTML = '<div id="view"></div>';
    await mod[route.fn]($('#view'), params, query);
    return;
  }

  if (!session) { navigate(`#/login?next=${encodeURIComponent(location.hash)}`); return; }
  try { await ensureContext(); }
  catch (e) {
    if (e.inactive) { sessionStorage.setItem('login_msg', e.message); navigate('#/login'); return; }
    document.getElementById('app').innerHTML = `<div class="boot"><div class="panel" style="max-width:480px">${errorState(e)}</div></div>`;
    $('[data-retry]')?.addEventListener('click', () => router());
    return;
  }
  if (!shellMounted) mountShell();
  $$('.nav a').forEach((a) => {
    if (a.dataset.nav === route.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('.shell').classList.remove('nav-open');
  if (path !== '/search') $('#gq').value = '';

  const view = $('#view');
  view.innerHTML = '<div style="padding:60px 0"><div class="spinner"></div></div>';
  try {
    const mod = await route.page();
    if (seq !== renderSeq) return;            // a newer navigation started
    // fresh container per navigation so page-level listeners never accumulate
    const page = document.createElement('div');
    view.replaceChildren(page);
    await mod[route.fn || 'render'](page, params, query, { setTitle: (x) => setTitle(x, appName()) });
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="panel">${errorState(e)}</div>`;
    $('[data-retry]', view)?.addEventListener('click', () => router());
  }
}

async function boot() {
  const app = document.getElementById('app');
  if (configProblems.length) {
    app.innerHTML = `<div class="boot"><div class="panel" style="max-width:560px;padding:28px">
      <h2>ยังตั้งค่าระบบไม่ครบ</h2><p class="muted">แก้ไขไฟล์ js/env.js (สร้างด้วย scripts/generate-env.mjs) แล้วโหลดหน้าใหม่</p>
      <ul>${configProblems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div></div>`;
    return;
  }
  setLang(getLang());
  const initialHash = location.hash;
  const isRecovery = /type=(recovery|invite)/.test(initialHash);
  const hashError = /error_description=([^&]+)/.exec(initialHash);

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') navigate('#/reset-password');
    if (event === 'SIGNED_OUT') { state.ctx = null; shellMounted = false; if (!location.hash.startsWith('#/login')) navigate('#/login'); }
  });
  await supabase.auth.getSession();          // processes tokens in the URL, if any
  try { await loadSettings(); } catch { /* anon may only read public settings */ }
  setTitle('', appName());

  if (hashError) { sessionStorage.setItem('login_msg', decodeURIComponent(hashError[1].replace(/\+/g, ' '))); location.hash = '#/login'; }
  else if (isRecovery) location.hash = '#/reset-password';
  else if (/access_token=/.test(location.hash)) location.hash = '#/';

  window.addEventListener('hashchange', router);
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toastError(e.reason); });
  await router();
}

boot().catch((e) => { console.error(e); toast(String(e.message || e), 'error'); });
