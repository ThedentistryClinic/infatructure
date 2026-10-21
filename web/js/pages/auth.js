// Login, forgot password, reset password, (optional) self-registration.
import { supabase, config } from '../supabase.js';
import { setting } from '../api.js';
import { icon } from '../icons.js';
import { esc, $, errMsg, withLoading, toast, setTitle } from '../ui.js';

const appName = () => setting('company.name', 'Company Intranet Portal');
const boolSetting = (k) => setting(k, false) === true;

function layout(inner) {
  return `<div class="login-wrap">
    <section class="login-side">
      <div class="brand" style="padding:0">${setting('company.logo_url') ? `<img src="${esc(setting('company.logo_url'))}" alt="">` : `<span class="brand-mark">${esc(appName().slice(0, 1))}</span>`}
        <span class="brand-name">${esc(appName())}</span></div>
      <div>
        <h1>ทุกอย่างที่ต้องใช้ในการทำงาน รวมไว้ที่เดียว</h1>
        <p>ข่าวประกาศ เอกสารบริษัท และทางเข้าระบบงานทั้งหมด เห็นเฉพาะสิ่งที่คุณได้รับสิทธิ์</p>
        <ul>
          <li>${icon('news')} ข่าวสารและประกาศสำคัญของบริษัท</li>
          <li>${icon('files')} เอกสาร นโยบาย และแบบฟอร์มที่เป็นปัจจุบัน</li>
          <li>${icon('grid')} ลิงก์ PR, Promotion, Repair และระบบอื่น ๆ</li>
        </ul>
      </div>
      <small style="color:#8EA0BF">หากมีปัญหาการเข้าใช้งาน กรุณาติดต่อฝ่าย IT</small>
    </section>
    <section class="login-form">${inner}</section>
  </div>`;
}

function toEmail(identifier) {
  const v = identifier.trim().toLowerCase();
  if (v.includes('@')) return v;
  const domain = String(setting('auth.login_email_domain', '') || '').replace(/^@/, '');
  return domain ? `${v}@${domain}` : null;
}

function showError(el, msg) {
  el.innerHTML = msg ? `<div class="notice notice-danger" role="alert">${icon('alert')}<div>${esc(msg)}</div></div>` : '';
}

export async function renderLogin(view, _p, query) {
  setTitle('เข้าสู่ระบบ', appName());
  const ms = boolSetting('auth.microsoft_enabled');
  const domain = setting('auth.login_email_domain', '');
  view.innerHTML = layout(`
    <h2>เข้าสู่ระบบ</h2>
    <p>ใช้อีเมลบริษัท${domain ? ' หรือชื่อผู้ใช้' : ''}และรหัสผ่านของคุณ</p>
    <div data-err></div>
    <form data-form novalidate>
      <div class="field"><label for="id">${domain ? 'อีเมลหรือชื่อผู้ใช้' : 'อีเมล'}</label>
        <input id="id" name="id" class="input" autocomplete="username" required></div>
      <div class="field"><label for="pw">รหัสผ่าน</label>
        <input id="pw" name="pw" type="password" class="input" autocomplete="current-password" required></div>
      <div style="display:flex;justify-content:flex-end;margin:-4px 0 16px"><a href="#/forgot-password">ลืมรหัสผ่าน?</a></div>
      <button class="btn btn-primary" type="submit">เข้าสู่ระบบ</button>
    </form>
    ${ms ? `<div class="divider">หรือ</div><button class="btn" data-ms>${icon('grid')} เข้าสู่ระบบด้วย Microsoft 365</button>` : ''}
    ${boolSetting('auth.allow_self_signup') ? '<p class="muted" style="margin-top:18px;text-align:center">ยังไม่มีบัญชี? <a href="#/register">ลงทะเบียน</a></p>' : ''}
  `);
  const errEl = $('[data-err]', view);
  const pending = sessionStorage.getItem('login_msg');
  if (pending) { showError(errEl, pending); sessionStorage.removeItem('login_msg'); }

  $('[data-form]', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('button[type=submit]', view);
    const email = toEmail($('#id', view).value);
    const password = $('#pw', view).value;
    if (!email) return showError(errEl, 'กรุณากรอกอีเมลให้ครบ (ระบบยังไม่ได้ตั้งค่าโดเมนสำหรับชื่อผู้ใช้)');
    if (!password) return showError(errEl, 'กรุณากรอกรหัสผ่าน');
    showError(errEl, '');
    await withLoading(btn, async () => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return showError(errEl, errMsg(error));
      await supabase.rpc('touch_last_login');
      const next = query.next && query.next.startsWith('#/') && !query.next.startsWith('#/login') ? query.next : '#/';
      location.hash = next;
    });
  });

  $('[data-ms]', view)?.addEventListener('click', async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: { scopes: 'email openid profile', redirectTo: config.APP_BASE_URL || location.origin + location.pathname },
    });
    if (error) showError(errEl, errMsg(error));
  });
}

export async function renderForgot(view) {
  setTitle('ลืมรหัสผ่าน', appName());
  view.innerHTML = layout(`
    <h2>ลืมรหัสผ่าน</h2>
    <p>กรอกอีเมลบริษัท ระบบจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ให้</p>
    <div data-err></div>
    <form data-form novalidate>
      <div class="field"><label for="em">อีเมล</label><input id="em" type="email" class="input" autocomplete="email" required></div>
      <button class="btn btn-primary" type="submit">ส่งลิงก์ตั้งรหัสผ่านใหม่</button>
    </form>
    <p style="margin-top:18px;text-align:center"><a href="#/login">กลับไปหน้าเข้าสู่ระบบ</a></p>`);
  const errEl = $('[data-err]', view);
  $('[data-form]', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = toEmail($('#em', view).value);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError(errEl, 'กรุณากรอกอีเมลให้ถูกต้อง');
    await withLoading(e.submitter, async () => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: (config.APP_BASE_URL || location.origin + location.pathname),
      });
      // Same message whether or not the address exists (no account enumeration)
      if (error && !/rate limit/i.test(error.message)) console.warn(error);
      if (error && /rate limit/i.test(error.message)) return showError(errEl, 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่');
      $('[data-form]', view).innerHTML = `<div class="notice notice-info">${icon('mail')}<div>หากอีเมลนี้มีบัญชีในระบบ คุณจะได้รับลิงก์ตั้งรหัสผ่านใหม่ภายในไม่กี่นาที</div></div>`;
    });
  });
}

export async function renderReset(view) {
  setTitle('ตั้งรหัสผ่านใหม่', appName());
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    view.innerHTML = layout(`<h2>ลิงก์หมดอายุ</h2><p>ลิงก์ตั้งรหัสผ่านใช้ไม่ได้หรือหมดอายุแล้ว กรุณาขอลิงก์ใหม่</p>
      <a class="btn btn-primary" href="#/forgot-password">ขอลิงก์ใหม่</a>`);
    return;
  }
  view.innerHTML = layout(`
    <h2>ตั้งรหัสผ่านใหม่</h2><p>สำหรับ ${esc(session.user.email)}</p>
    <div data-err></div>
    <form data-form novalidate>
      <div class="field"><label for="p1">รหัสผ่านใหม่</label><input id="p1" type="password" class="input" autocomplete="new-password" minlength="10" required>
        <span class="hint">อย่างน้อย 10 ตัวอักษร ผสมตัวอักษรและตัวเลข</span></div>
      <div class="field"><label for="p2">ยืนยันรหัสผ่านใหม่</label><input id="p2" type="password" class="input" autocomplete="new-password" required></div>
      <button class="btn btn-primary" type="submit">บันทึกรหัสผ่านใหม่</button>
    </form>`);
  const errEl = $('[data-err]', view);
  $('[data-form]', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = $('#p1', view).value; const p2 = $('#p2', view).value;
    if (p1.length < 10 || !/[A-Za-z]/.test(p1) || !/\d/.test(p1)) return showError(errEl, 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร และมีทั้งตัวอักษรและตัวเลข');
    if (p1 !== p2) return showError(errEl, 'รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    await withLoading(e.submitter, async () => {
      const { error } = await supabase.auth.updateUser({ password: p1 });
      if (error) return showError(errEl, errMsg(error));
      toast('บันทึกรหัสผ่านใหม่แล้ว', 'success');
      location.hash = '#/';
    });
  });
}

export async function renderRegister(view) {
  setTitle('ลงทะเบียน', appName());
  if (!boolSetting('auth.allow_self_signup')) {
    view.innerHTML = layout(`<h2>ปิดการลงทะเบียน</h2><p>บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบเท่านั้น กรุณาติดต่อฝ่าย IT</p>
      <a class="btn btn-primary" href="#/login">กลับไปหน้าเข้าสู่ระบบ</a>`);
    return;
  }
  view.innerHTML = layout(`
    <h2>ลงทะเบียน</h2><p>ใช้อีเมลบริษัทของคุณ</p><div data-err></div>
    <form data-form novalidate>
      <div class="field"><label for="fn">ชื่อ-นามสกุล</label><input id="fn" class="input" required></div>
      <div class="field"><label for="em">อีเมล</label><input id="em" type="email" class="input" autocomplete="email" required></div>
      <div class="field"><label for="p1">รหัสผ่าน</label><input id="p1" type="password" class="input" autocomplete="new-password" required></div>
      <button class="btn btn-primary" type="submit">ลงทะเบียน</button>
    </form><p style="margin-top:18px;text-align:center"><a href="#/login">มีบัญชีแล้ว? เข้าสู่ระบบ</a></p>`);
  const errEl = $('[data-err]', view);
  $('[data-form]', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const full_name = $('#fn', view).value.trim(); const email = $('#em', view).value.trim().toLowerCase(); const pw = $('#p1', view).value;
    if (!full_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError(errEl, 'กรุณากรอกชื่อและอีเมลให้ถูกต้อง');
    if (pw.length < 10) return showError(errEl, 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร');
    await withLoading(e.submitter, async () => {
      const { error } = await supabase.auth.signUp({ email, password: pw, options: { data: { full_name }, emailRedirectTo: config.APP_BASE_URL || undefined } });
      if (error) return showError(errEl, errMsg(error));
      $('[data-form]', view).innerHTML = `<div class="notice notice-info">${icon('mail')}<div>ลงทะเบียนแล้ว กรุณายืนยันอีเมล จากนั้นจึงเข้าสู่ระบบ</div></div>`;
    });
  });
}
