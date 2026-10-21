// My profile: personal info, roles, effective permissions, change password.
import { supabase } from '../supabase.js';
import { state, must, me, loadContext } from '../api.js';
import { esc, $, toast, toastError, withLoading, fmtDateTime, initials } from '../ui.js';

export async function render(view, _p, _q, { setTitle }) {
  setTitle('โปรไฟล์ของฉัน');
  const p = me(); const ctx = state.ctx;
  const perms = must(await supabase.from('permissions').select('code, name').in('code', ctx.permissions.length ? ctx.permissions : ['-']));
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>โปรไฟล์ของฉัน</h1></div></div>
    <div class="detail-grid">
      <div style="display:flex;flex-direction:column;gap:22px">
        <section class="panel"><div class="panel-body" style="display:flex;gap:18px;align-items:center">
          <span class="avatar" style="width:64px;height:64px;font-size:22px">${initials(p.full_name || p.email)}</span>
          <div><h2>${esc(p.full_name)}</h2><div class="muted">${esc(p.email)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${ctx.roles.map((r) => `<span class="chip chip-navy">${esc(r.name)}</span>`).join('')}</div></div>
        </div></section>
        <section class="panel"><div class="panel-head"><h2>ข้อมูลพนักงาน</h2></div><div class="panel-body">
          <dl class="meta-list">
            <dt>รหัสพนักงาน</dt><dd>${esc(p.employee_code || '-')}</dd>
            <dt>ชื่อผู้ใช้</dt><dd>${esc(p.username || '-')}</dd>
            <dt>แผนก</dt><dd>${esc(ctx.department?.name || '-')}</dd>
            <dt>ตำแหน่ง</dt><dd>${esc(p.position || '-')}</dd>
            <dt>เข้าสู่ระบบล่าสุด</dt><dd>${esc(fmtDateTime(p.last_login_at))}</dd>
          </dl>
          <p class="muted" style="margin-top:12px">หากข้อมูลชื่อ แผนก หรือตำแหน่งไม่ถูกต้อง กรุณาแจ้งผู้ดูแลระบบ</p>
          <form data-contact style="margin-top:14px;max-width:360px">
            <div class="field"><label for="ph">เบอร์โทรศัพท์</label><input id="ph" class="input" maxlength="30" value="${esc(p.phone || '')}"></div>
            <button class="btn" type="submit">บันทึกเบอร์โทรศัพท์</button>
          </form>
        </div></section>
        <section class="panel"><div class="panel-head"><h2>เปลี่ยนรหัสผ่าน</h2></div><div class="panel-body">
          <form data-pw style="max-width:360px" novalidate>
            <div class="field"><label for="np">รหัสผ่านใหม่</label><input id="np" type="password" class="input" autocomplete="new-password">
              <span class="hint">อย่างน้อย 10 ตัวอักษร มีทั้งตัวอักษรและตัวเลข</span></div>
            <div class="field"><label for="np2">ยืนยันรหัสผ่านใหม่</label><input id="np2" type="password" class="input" autocomplete="new-password"></div>
            <button class="btn btn-primary" type="submit">เปลี่ยนรหัสผ่าน</button>
          </form>
          <p class="muted" style="margin-top:10px">บัญชีที่เข้าสู่ระบบด้วย Microsoft 365 ให้เปลี่ยนรหัสผ่านที่ Microsoft</p>
        </div></section>
      </div>
      <aside class="panel"><div class="panel-head"><h3>สิทธิ์ของฉัน</h3></div><div class="panel-body">
        <p class="muted">นอกเหนือจากการดูข่าวสาร เอกสาร และระบบที่ได้รับอนุญาต</p>
        ${perms.length ? `<ul style="padding-left:18px;margin:0">${perms.map((x) => `<li>${esc(x.name)}</li>`).join('')}</ul>` : '<p>สิทธิ์พื้นฐานของพนักงาน</p>'}
      </div></aside>
    </div>`;

  $('[data-contact]', view).addEventListener('submit', (e) => {
    e.preventDefault();
    withLoading(e.submitter, async () => {
      try { must(await supabase.from('profiles').update({ phone: $('#ph', view).value.trim() || null }).eq('id', p.id)); await loadContext(); toast('บันทึกแล้ว', 'success'); }
      catch (err) { toastError(err); }
    });
  });
  $('[data-pw]', view).addEventListener('submit', (e) => {
    e.preventDefault();
    const a = $('#np', view).value; const b = $('#np2', view).value;
    if (a.length < 10 || !/[A-Za-z]/.test(a) || !/\d/.test(a)) return toast('รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร และมีทั้งตัวอักษรและตัวเลข', 'error');
    if (a !== b) return toast('รหัสผ่านทั้งสองช่องไม่ตรงกัน', 'error');
    withLoading(e.submitter, async () => {
      const { error } = await supabase.auth.updateUser({ password: a });
      if (error) toastError(error); else { toast('เปลี่ยนรหัสผ่านแล้ว', 'success'); e.target.reset(); }
    });
  });
}
