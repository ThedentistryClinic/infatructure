// Admin Panel. Each tab is shown only with the matching permission, and every
// write is re-checked by RLS / database functions (the UI is not the guard).
import { supabase } from '../supabase.js';
import {
  state, must, can, me, hasRole, getDepartments, getRoles, getGroups, getPeople, getCategories, invalidate,
  adminUsers, loadContext, loadSettings, DOC_ACCESS,
} from '../api.js';
import { principalPicker } from '../components.js';
import { icon } from '../icons.js';
import {
  esc, $, modal, confirmDialog, toast, toastError, withLoading, loadingState, emptyState, errorState,
  fmtDate, fmtDateTime, fmtRelative, fmtSize, opts, formData, pager, debounce, likePattern, initials,
} from '../ui.js';
import { renderAdmin as renderAppsAdmin } from './applications.js';
import { renderAdmin as renderNewsAdmin } from './news.js';
import { openPermissionsModal, accessChip } from './documents.js';

const TABS = [
  ['users', 'ผู้ใช้งาน', 'users', () => can('users.view')],
  ['departments', 'แผนก', 'building', () => can('departments.manage')],
  ['roles', 'บทบาทและสิทธิ์', 'key', () => can('users.view') || can('roles.manage')],
  ['groups', 'กลุ่มผู้ใช้', 'users', () => can('groups.manage')],
  ['categories', 'หมวดหมู่เอกสาร', 'folder', () => can('doc_categories.manage')],
  ['access', 'สิทธิ์เอกสาร', 'lock', () => can('documents.manage_all')],
  ['apps', 'ลิงก์ระบบ', 'grid', () => can('apps.manage')],
  ['news', 'ข่าวสาร', 'news', () => can('news.manage') || can('news.create')],
  ['storage', 'พื้นที่จัดเก็บ', 'database', () => can('storage.view')],
  ['audit', 'Audit Logs', 'history', () => can('audit.view')],
  ['settings', 'ตั้งค่าระบบ', 'settings', () => can('settings.manage')],
];
const myLevel = () => Math.max(0, ...state.ctx.roles.map((r) => r.level));
const isSuper = () => hasRole('super_admin');

export async function render(view, { tab }, _q, { setTitle }) {
  const allowed = TABS.filter((t) => t[3]());
  if (!allowed.length) { view.innerHTML = `<div class="panel">${emptyState('คุณไม่มีสิทธิ์เข้าถึงหน้าจัดการระบบ', '', '', 'lock')}</div>`; return; }
  const current = allowed.find((t) => t[0] === tab) || allowed[0];
  setTitle(`จัดการระบบ · ${current[1]}`);
  view.innerHTML = `<div class="page-head"><div class="grow"><h1>จัดการระบบ</h1><p>${esc(current[1])}</p></div></div>
    <nav class="tabs" aria-label="หมวดการจัดการ">${allowed.map((t) => `<a href="#/admin/${t[0]}" aria-selected="${t[0] === current[0]}">${esc(t[1])}</a>`).join('')}</nav>
    <div data-tab></div>`;
  const el = $('[data-tab]', view);
  const fn = { users, departments, roles, groups, categories, access, apps: renderAppsAdmin, news: renderNewsAdmin, storage, audit, settings }[current[0]];
  await fn(el);
}

const err = (el, e, retry) => { el.innerHTML = errorState(e, !!retry); if (retry) $('[data-retry]', el)?.addEventListener('click', retry); };
const formModal = (title, bodyHtml, onSave, { size = '', saveText = 'บันทึก' } = {}) => {
  const m = modal({ title, size, body: `<form data-f novalidate>${bodyHtml}</form>`, footer: `<button class="btn" data-close>ยกเลิก</button><button class="btn btn-primary" data-save>${esc(saveText)}</button>` });
  const submit = (btn) => withLoading(btn, async () => { try { if (await onSave(formData($('[data-f]', m.el)), m) !== false) m.close(); } catch (e) { toastError(e); } });
  $('[data-save]', m.el).addEventListener('click', (e) => submit(e.currentTarget));
  $('[data-f]', m.el).addEventListener('submit', (e) => { e.preventDefault(); submit($('[data-save]', m.el)); });
  return m;
};

// ================================================================== users
async function users(el) {
  const [departments, roles] = await Promise.all([getDepartments(), getRoles()]);
  el.innerHTML = `<div class="toolbar">
      <input class="input search-input" type="search" data-q placeholder="ค้นหาชื่อ อีเมล หรือรหัสพนักงาน" aria-label="ค้นหาผู้ใช้">
      <select class="select" data-dept aria-label="แผนก">${opts(departments, '', { empty: 'ทุกแผนก' })}</select>
      <select class="select" data-role aria-label="บทบาท">${opts(roles, '', { empty: 'ทุกบทบาท' })}</select>
      <select class="select" data-status aria-label="สถานะ"><option value="">ทุกสถานะ</option><option value="1">ใช้งานอยู่</option><option value="0">ปิดใช้งาน</option></select>
      ${can('users.manage') ? `<button class="btn btn-primary" data-new>${icon('plus')} เพิ่มผู้ใช้</button>` : ''}
    </div><div class="panel" data-list>${loadingState(6)}</div>`;
  const listEl = $('[data-list]', el);
  const st = { q: '', dept: '', role: '', status: '', page: 1 };
  const deptName = Object.fromEntries(departments.map((d) => [d.id, d.name]));
  const roleName = Object.fromEntries(roles.map((r) => [r.id, r.name]));
  let all = [];
  async function load() {
    try {
      all = must(await supabase.from('profiles').select('id, email, full_name, username, employee_code, position, phone, department_id, is_active, last_login_at, created_at, user_roles(role_id)').order('full_name').limit(5000));
      draw();
    } catch (e) { err(listEl, e, load); }
  }
  function draw() {
    const q = st.q.toLowerCase();
    const list = all.filter((u) => (!q || `${u.full_name} ${u.email} ${u.employee_code || ''} ${u.username || ''}`.toLowerCase().includes(q))
      && (!st.dept || u.department_id === st.dept) && (!st.role || u.user_roles.some((r) => r.role_id === st.role))
      && (st.status === '' || String(Number(u.is_active)) === st.status));
    const pageRows = list.slice((st.page - 1) * 25, st.page * 25);
    listEl.innerHTML = list.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>ผู้ใช้</th><th>แผนก / ตำแหน่ง</th><th>บทบาท</th><th>สถานะ</th><th>เข้าระบบล่าสุด</th></tr></thead><tbody>
      ${pageRows.map((u) => `<tr class="clickable" data-id="${esc(u.id)}">
        <td data-label="ผู้ใช้"><div style="display:flex;gap:10px;align-items:center"><span class="avatar" style="width:32px;height:32px;font-size:12px">${initials(u.full_name || u.email)}</span>
          <div><div class="cell-title">${esc(u.full_name || '-')}</div><div class="cell-sub">${esc(u.email)}${u.employee_code ? ' · ' + esc(u.employee_code) : ''}</div></div></div></td>
        <td data-label="แผนก">${esc(deptName[u.department_id] || '-')}<div class="cell-sub">${esc(u.position || '')}</div></td>
        <td data-label="บทบาท">${u.user_roles.map((r) => `<span class="chip">${esc(roleName[r.role_id] || '?')}</span>`).join(' ')}</td>
        <td data-label="สถานะ">${u.is_active ? '<span class="chip chip-ok">ใช้งานอยู่</span>' : '<span class="chip chip-danger">ปิดใช้งาน</span>'}</td>
        <td data-label="เข้าระบบล่าสุด">${esc(u.last_login_at ? fmtRelative(u.last_login_at) : 'ยังไม่เคย')}</td></tr>`).join('')}
      </tbody></table></div>${pager(st.page, 25, list.length)}` : emptyState('ไม่พบผู้ใช้', '', '', 'users');
  }
  listEl.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-page]'); if (pg) { st.page = Number(pg.dataset.page); draw(); return; }
    const row = e.target.closest('[data-id]'); if (row) openUser(all.find((u) => u.id === row.dataset.id), load);
  });
  $('[data-q]', el).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; draw(); }, 200));
  $('[data-dept]', el).addEventListener('change', (e) => { st.dept = e.target.value; st.page = 1; draw(); });
  $('[data-role]', el).addEventListener('change', (e) => { st.role = e.target.value; st.page = 1; draw(); });
  $('[data-status]', el).addEventListener('change', (e) => { st.status = e.target.value; st.page = 1; draw(); });
  $('[data-new]', el)?.addEventListener('click', () => createUser(departments, roles, load));
  load();
}

function assignableRoles(roles) {
  return roles.filter((r) => isSuper() || (can('roles.assign') && r.level < myLevel()));
}

function createUser(departments, roles, onDone) {
  formModal('เพิ่มผู้ใช้', `
    <div class="grid-2">
      <div class="field"><label for="u-name">ชื่อ-นามสกุล *</label><input id="u-name" name="full_name" class="input"></div>
      <div class="field"><label for="u-email">อีเมลบริษัท *</label><input id="u-email" name="email" type="email" class="input"></div>
      <div class="field"><label for="u-user">ชื่อผู้ใช้</label><input id="u-user" name="username" class="input"></div>
      <div class="field"><label for="u-code">รหัสพนักงาน</label><input id="u-code" name="employee_code" class="input"></div>
      <div class="field"><label for="u-dept">แผนก</label><select id="u-dept" name="department_id" class="select">${opts(departments.filter((d) => d.is_active), '', { empty: '— ไม่ระบุ —' })}</select></div>
      <div class="field"><label for="u-pos">ตำแหน่ง</label><input id="u-pos" name="position" class="input"></div>
    </div>
    <div class="field"><label>บทบาท</label><div style="display:flex;gap:16px;flex-wrap:wrap">
      ${assignableRoles(roles).map((r) => `<label class="check"><input type="checkbox" name="role_${esc(r.code)}" ${r.code === 'employee' ? 'checked disabled' : ''}> ${esc(r.name)}</label>`).join('')}</div></div>
    <div class="field"><label for="u-pw">รหัสผ่านเริ่มต้น</label><input id="u-pw" name="password" type="password" class="input" autocomplete="new-password">
      <span class="hint">เว้นว่างเพื่อส่งอีเมลเชิญให้ผู้ใช้ตั้งรหัสผ่านเอง (แนะนำ)</span></div>`,
  async (f) => {
    if (!f.full_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { toast('กรุณากรอกชื่อและอีเมลให้ถูกต้อง', 'error'); return false; }
    const role_codes = Object.keys(f).filter((k) => k.startsWith('role_') && f[k]).map((k) => k.slice(5));
    const res = await adminUsers({ action: 'create_user', email: f.email, full_name: f.full_name, username: f.username, employee_code: f.employee_code, department_id: f.department_id || null, position: f.position, password: f.password || undefined, role_codes });
    toast(f.password ? 'เพิ่มผู้ใช้แล้ว' : 'เพิ่มผู้ใช้และส่งอีเมลเชิญแล้ว', 'success');
    if (res.role_errors?.length) toast(`กำหนดบทบาทบางรายการไม่สำเร็จ: ${res.role_errors.join(', ')}`, 'error', 8000);
    invalidate('people'); onDone();
  }, { size: 'lg', saveText: 'เพิ่มผู้ใช้' });
}

async function openUser(u, onDone) {
  const [departments, roles, groups, perms] = await Promise.all([
    getDepartments(), getRoles(), getGroups(), supabase.from('permissions').select('code, name, category').order('category').then(must),
  ]);
  const [userPerms, members] = await Promise.all([
    supabase.from('user_permissions').select('*').eq('user_id', u.id).then(must),
    supabase.from('group_members').select('group_id').eq('user_id', u.id).then(must),
  ]);
  const canEdit = can('users.manage') && (isSuper() || (u.id !== me().id && Math.max(0, ...u.user_roles.map((r) => roles.find((x) => x.id === r.role_id)?.level || 0)) < myLevel()));
  const assignable = new Set(assignableRoles(roles).map((r) => r.id));
  const has = new Set(u.user_roles.map((r) => r.role_id));
  const inGroup = new Set(members.map((m) => m.group_id));
  const m = modal({
    title: u.full_name || u.email, size: 'lg',
    body: `
      ${canEdit ? '' : `<div class="notice notice-info">${icon('info')}<div>คุณดูข้อมูลผู้ใช้นี้ได้ แต่ไม่มีสิทธิ์แก้ไข (ต้องมีระดับบทบาทสูงกว่าผู้ใช้รายนี้)</div></div>`}
      <form data-f>
      <div class="grid-2">
        <div class="field"><label>ชื่อ-นามสกุล</label><input name="full_name" class="input" value="${esc(u.full_name)}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label>อีเมล</label><input class="input" value="${esc(u.email)}" disabled></div>
        <div class="field"><label>ชื่อผู้ใช้</label><input name="username" class="input" value="${esc(u.username || '')}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label>รหัสพนักงาน</label><input name="employee_code" class="input" value="${esc(u.employee_code || '')}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label>แผนก</label><select name="department_id" class="select" ${canEdit ? '' : 'disabled'}>${opts(departments, u.department_id, { empty: '— ไม่ระบุ —' })}</select></div>
        <div class="field"><label>ตำแหน่ง</label><input name="position" class="input" value="${esc(u.position || '')}" ${canEdit ? '' : 'disabled'}></div>
      </div>
      ${canEdit ? '<button type="button" class="btn btn-primary" data-saveprofile>บันทึกข้อมูลผู้ใช้</button>' : ''}
      </form>
      <h3 style="margin:22px 0 10px">บทบาท</h3>
      <div style="display:flex;gap:16px;flex-wrap:wrap">${roles.map((r) => `<label class="check"><input type="checkbox" data-role="${esc(r.id)}" ${has.has(r.id) ? 'checked' : ''} ${assignable.has(r.id) && u.id !== me().id || isSuper() ? '' : 'disabled'}> ${esc(r.name)}</label>`).join('')}</div>
      ${can('groups.manage') ? `<h3 style="margin:22px 0 10px">กลุ่ม</h3><div style="display:flex;gap:16px;flex-wrap:wrap">${groups.length ? groups.map((g) => `<label class="check"><input type="checkbox" data-group="${esc(g.id)}" ${inGroup.has(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('') : '<span class="muted">ยังไม่มีกลุ่ม</span>'}</div>` : ''}
      <h3 style="margin:22px 0 6px">สิทธิ์เพิ่มเติมรายบุคคล</h3>
      <p class="muted">ใช้เมื่อต้องการให้สิทธิ์เฉพาะบุคคลโดยไม่เปลี่ยนบทบาท (เฉพาะ Super Admin)</p>
      <ul class="list" data-uperms>${userPerms.length ? userPerms.map((p) => `<li style="display:flex;gap:10px;align-items:center;padding:8px 0">
        <span style="flex:1">${esc(perms.find((x) => x.code === p.permission_code)?.name || p.permission_code)}${p.expires_at ? ` <span class="muted">ถึง ${esc(fmtDate(p.expires_at))}</span>` : ''}</span>
        ${isSuper() ? `<button class="btn btn-sm btn-ghost" data-rmperm="${esc(p.id)}">${icon('x')} นำออก</button>` : ''}</li>`).join('') : '<li class="muted" style="padding:6px 0">ไม่มี</li>'}</ul>
      ${isSuper() ? `<div class="grid-3" style="align-items:end;margin-top:8px"><div class="field"><label>สิทธิ์</label><select class="select" data-newperm>${opts(perms, '', { value: 'code', label: 'name' })}</select></div>
        <div class="field"><label>หมดอายุ (ไม่บังคับ)</label><input type="date" class="input" data-permexp></div>
        <div class="field"><button class="btn" data-addperm>${icon('plus')} ให้สิทธิ์</button></div></div>` : ''}
      ${canEdit && u.id !== me().id ? `<h3 style="margin:22px 0 10px">บัญชี</h3><div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn ${u.is_active ? 'btn-danger' : 'btn-primary'}" data-active>${u.is_active ? 'ปิดใช้งานบัญชี' : 'เปิดใช้งานบัญชี'}</button>
        <button class="btn" data-reset>${icon('mail')} ส่งลิงก์ตั้งรหัสผ่านใหม่</button></div>` : ''}`,
    footer: '<button class="btn btn-primary" data-close>ปิด</button>',
  });
  m.onClose(onDone);
  $('[data-saveprofile]', m.el)?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const f = formData($('[data-f]', m.el));
    try {
      const rows = must(await supabase.from('profiles').update({ full_name: f.full_name, username: f.username?.toLowerCase() || null, employee_code: f.employee_code || null, department_id: f.department_id || null, position: f.position || null }).eq('id', u.id).select('id'));
      if (!rows.length) throw new Error('ไม่มีสิทธิ์แก้ไขผู้ใช้รายนี้');
      invalidate('people'); toast('บันทึกข้อมูลผู้ใช้แล้ว', 'success');
    } catch (er) { toastError(er); }
  }));
  m.body.addEventListener('change', async (e) => {
    const r = e.target.closest('[data-role]'); const g = e.target.closest('[data-group]');
    try {
      if (r) {
        if (r.checked) must(await supabase.from('user_roles').insert({ user_id: u.id, role_id: r.dataset.role }));
        else { const rows = must(await supabase.from('user_roles').delete().eq('user_id', u.id).eq('role_id', r.dataset.role).select('user_id')); if (!rows.length) throw new Error('ไม่มีสิทธิ์ถอนบทบาทนี้'); }
        toast('อัปเดตบทบาทแล้ว', 'success');
        if (u.id === me().id) await loadContext();
      }
      if (g) {
        if (g.checked) must(await supabase.from('group_members').insert({ group_id: g.dataset.group, user_id: u.id }));
        else must(await supabase.from('group_members').delete().eq('group_id', g.dataset.group).eq('user_id', u.id));
        toast('อัปเดตกลุ่มแล้ว', 'success');
      }
    } catch (er) { if (r) r.checked = !r.checked; if (g) g.checked = !g.checked; toastError(er); }
  });
  m.body.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rmperm]');
    if (rm) { try { must(await supabase.from('user_permissions').delete().eq('id', rm.dataset.rmperm)); rm.closest('li').remove(); toast('นำสิทธิ์ออกแล้ว', 'success'); } catch (er) { toastError(er); } }
    if (e.target.closest('[data-addperm]')) {
      const code = $('[data-newperm]', m.el).value; const exp = $('[data-permexp]', m.el).value;
      try { must(await supabase.from('user_permissions').insert({ user_id: u.id, permission_code: code, expires_at: exp ? new Date(exp + 'T23:59:59').toISOString() : null })); toast('ให้สิทธิ์แล้ว', 'success'); m.close(); }
      catch (er) { toastError(er); }
    }
    const act = e.target.closest('[data-active]');
    if (act) {
      const turnOn = !u.is_active;
      if (!turnOn && !await confirmDialog({ title: 'ปิดใช้งานบัญชี', message: `${u.full_name} จะเข้าสู่ระบบไม่ได้ และสิทธิ์ทั้งหมดจะหยุดมีผลทันที`, confirmText: 'ปิดใช้งาน', danger: true })) return;
      withLoading(act, async () => {
        try { await adminUsers({ action: 'set_active', user_id: u.id, active: turnOn }); toast(turnOn ? 'เปิดใช้งานบัญชีแล้ว' : 'ปิดใช้งานบัญชีแล้ว', 'success'); m.close(); }
        catch (er) { toastError(er); }
      });
    }
    const rs = e.target.closest('[data-reset]');
    if (rs) withLoading(rs, async () => { try { await adminUsers({ action: 'send_password_reset', user_id: u.id }); toast('ส่งลิงก์ตั้งรหัสผ่านใหม่แล้ว', 'success'); } catch (er) { toastError(er); } });
  });
}

// ============================================================ departments
async function departments(el) {
  el.innerHTML = `<div class="toolbar"><span class="grow" style="flex:1"></span><button class="btn btn-primary" data-new>${icon('plus')} เพิ่มแผนก</button></div><div class="panel" data-list>${loadingState(5)}</div>`;
  const listEl = $('[data-list]', el);
  async function load() {
    invalidate('departments');
    try {
      const [list, people] = await Promise.all([getDepartments(), getPeople()]);
      const counts = must(await supabase.from('profiles').select('department_id').eq('is_active', true));
      const cnt = counts.reduce((a, r) => { a[r.department_id] = (a[r.department_id] || 0) + 1; return a; }, {});
      const pn = Object.fromEntries(people.map((p) => [p.id, p.full_name]));
      listEl.innerHTML = list.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>รหัส</th><th>ชื่อแผนก</th><th>ผู้จัดการ</th><th>พนักงาน</th><th>สถานะ</th><th></th></tr></thead><tbody>
        ${list.map((d) => `<tr data-id="${esc(d.id)}"><td data-label="รหัส"><b>${esc(d.code)}</b></td><td data-label="ชื่อแผนก">${esc(d.name)}<div class="cell-sub">${esc(d.name_en || '')}</div></td>
          <td data-label="ผู้จัดการ">${esc(pn[d.manager_id] || '-')}</td><td data-label="พนักงาน">${cnt[d.id] || 0}</td>
          <td data-label="สถานะ">${d.is_active ? '<span class="chip chip-ok">ใช้งาน</span>' : '<span class="chip">ปิด</span>'}</td>
          <td class="actions"><button class="btn btn-sm" data-edit>${icon('edit')} แก้ไข</button> <button class="btn btn-sm btn-danger" data-del aria-label="ลบ">${icon('trash')}</button></td></tr>`).join('')}
        </tbody></table></div>` : emptyState('ยังไม่มีแผนก', 'เพิ่มแผนกก่อนกำหนดผู้ใช้และสิทธิ์เอกสารระดับแผนก', '', 'building');
      listEl.onclick = async (e) => {
        const row = e.target.closest('[data-id]'); if (!row) return;
        const d = list.find((x) => x.id === row.dataset.id);
        if (e.target.closest('[data-edit]')) edit(d, list, people);
        if (e.target.closest('[data-del]')) {
          if (!await confirmDialog({ title: 'ลบแผนก', message: `ลบ "${d.name}"? ผู้ใช้และเอกสารของแผนกนี้จะไม่มีแผนก แนะนำให้ปิดการใช้งานแทน`, confirmText: 'ลบแผนก', danger: true })) return;
          try { must(await supabase.from('departments').delete().eq('id', d.id)); toast('ลบแผนกแล้ว', 'success'); load(); } catch (er) { toastError(er); }
        }
      };
    } catch (e) { err(listEl, e, load); }
  }
  function edit(d, list, people) {
    const x = d || { is_active: true, sort_order: (list.length + 1) * 10 };
    formModal(d ? 'แก้ไขแผนก' : 'เพิ่มแผนก', `<div class="grid-2">
      <div class="field"><label>รหัสแผนก * <span class="hint">A-Z, 0-9</span></label><input name="code" class="input" maxlength="20" value="${esc(x.code || '')}" style="text-transform:uppercase"></div>
      <div class="field"><label>ลำดับ</label><input name="sort_order" type="number" class="input" value="${esc(x.sort_order)}"></div>
      <div class="field"><label>ชื่อแผนก (ไทย) *</label><input name="name" class="input" value="${esc(x.name || '')}"></div>
      <div class="field"><label>ชื่อแผนก (อังกฤษ)</label><input name="name_en" class="input" value="${esc(x.name_en || '')}"></div>
      <div class="field"><label>สังกัด</label><select name="parent_id" class="select">${opts(list.filter((o) => o.id !== x.id), x.parent_id, { empty: '— ไม่มี —' })}</select></div>
      <div class="field"><label>ผู้จัดการแผนก</label><select name="manager_id" class="select">${opts(people, x.manager_id, { label: (p) => p.full_name || p.email, empty: '— ไม่ระบุ —' })}</select></div></div>
      <div class="field"><label>รายละเอียด</label><input name="description" class="input" value="${esc(x.description || '')}"></div>
      <label class="check"><input type="checkbox" name="is_active" ${x.is_active ? 'checked' : ''}> ใช้งาน</label>`,
    async (f) => {
      const row = { ...f, code: f.code.toUpperCase(), sort_order: Number(f.sort_order) || 0, parent_id: f.parent_id || null, manager_id: f.manager_id || null };
      if (!/^[A-Z0-9_-]{2,20}$/.test(row.code) || !row.name) { toast('กรุณากรอกรหัส (2-20 ตัว A-Z 0-9) และชื่อแผนก', 'error'); return false; }
      if (d) must(await supabase.from('departments').update(row).eq('id', d.id)); else must(await supabase.from('departments').insert(row));
      toast('บันทึกแล้ว', 'success'); load();
    }, { size: 'lg' });
  }
  $('[data-new]', el).addEventListener('click', async () => edit(null, await getDepartments(), await getPeople()));
  load();
}

// ================================================================== roles
async function roles(el) {
  el.innerHTML = `<div data-body>${loadingState(6)}</div>`;
  const body = $('[data-body]', el);
  async function load() {
    invalidate('roles');
    try {
      const [list, perms, rp] = await Promise.all([getRoles(), supabase.from('permissions').select('*').order('category').order('code').then(must), supabase.from('role_permissions').select('*').then(must)]);
      const set = new Set(rp.map((x) => `${x.role_id}:${x.permission_code}`));
      const editable = isSuper();
      body.innerHTML = `
        <div class="notice notice-info">${icon('info')}<div>บทบาทกำหนดสิทธิ์พื้นฐาน สิทธิ์การเข้าถึงเอกสาร ข่าว และระบบงานรายรายการกำหนดที่ตัวรายการนั้น ๆ
          สิทธิ์เพิ่มเติมรายบุคคลกำหนดได้ที่หน้าผู้ใช้งาน ${editable ? '' : '<br>เฉพาะ Super Admin เท่านั้นที่แก้ไขตารางสิทธิ์ได้'}</div></div>
        <section class="panel" style="margin-bottom:22px"><div class="panel-head"><h2>บทบาท</h2>${can('roles.manage') ? `<button class="btn btn-sm btn-primary" data-newrole>${icon('plus')} เพิ่มบทบาท</button>` : ''}</div>
          <div class="table-wrap"><table class="table responsive"><thead><tr><th>บทบาท</th><th>รหัส</th><th>ระดับ</th><th>คำอธิบาย</th><th></th></tr></thead><tbody>
          ${list.map((r) => `<tr data-id="${esc(r.id)}"><td data-label="บทบาท"><b>${esc(r.name)}</b><div class="cell-sub">${esc(r.name_en || '')}</div></td><td data-label="รหัส"><code>${esc(r.code)}</code></td><td data-label="ระดับ">${r.level}</td>
            <td data-label="คำอธิบาย">${esc(r.description || '')}</td><td class="actions">${can('roles.manage') ? `<button class="btn btn-sm" data-editrole>${icon('edit')}</button>${r.is_system ? '' : ` <button class="btn btn-sm btn-danger" data-delrole>${icon('trash')}</button>`}` : ''}</td></tr>`).join('')}
          </tbody></table></div></section>
        <section class="panel"><div class="panel-head"><h2>ตารางสิทธิ์ตามบทบาท</h2></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>สิทธิ์</th>${list.map((r) => `<th style="text-align:center">${esc(r.name)}</th>`).join('')}</tr></thead><tbody>
          ${perms.map((p) => `<tr><td><div class="cell-title">${esc(p.name)}</div><div class="cell-sub">${esc(p.description || '')} · <code>${esc(p.code)}</code></div></td>
            ${list.map((r) => `<td style="text-align:center">${r.code === 'super_admin' ? `<span title="Super Admin มีทุกสิทธิ์">${icon('check')}</span>`
              : `<input type="checkbox" aria-label="${esc(r.name)}: ${esc(p.name)}" data-rp="${esc(r.id)}|${esc(p.code)}" ${set.has(`${r.id}:${p.code}`) ? 'checked' : ''} ${editable ? '' : 'disabled'}>`}</td>`).join('')}</tr>`).join('')}
          </tbody></table></div></section>`;
      body.onchange = async (e) => {
        const cb = e.target.closest('[data-rp]'); if (!cb) return;
        const [role_id, permission_code] = cb.dataset.rp.split('|');
        try {
          if (cb.checked) must(await supabase.from('role_permissions').insert({ role_id, permission_code }));
          else must(await supabase.from('role_permissions').delete().eq('role_id', role_id).eq('permission_code', permission_code));
          toast('อัปเดตสิทธิ์ของบทบาทแล้ว', 'success');
        } catch (er) { cb.checked = !cb.checked; toastError(er); }
      };
      body.onclick = async (e) => {
        if (e.target.closest('[data-newrole]')) return editRole(null);
        const row = e.target.closest('[data-id]'); if (!row) return;
        const r = list.find((x) => x.id === row.dataset.id);
        if (e.target.closest('[data-editrole]')) editRole(r);
        if (e.target.closest('[data-delrole]')) {
          if (!await confirmDialog({ title: 'ลบบทบาท', message: `ลบบทบาท "${r.name}"? ผู้ใช้ที่มีบทบาทนี้จะเสียสิทธิ์ที่มาจากบทบาทนี้`, confirmText: 'ลบบทบาท', danger: true })) return;
          try { must(await supabase.from('roles').delete().eq('id', r.id)); toast('ลบบทบาทแล้ว', 'success'); load(); } catch (er) { toastError(er); }
        }
      };
    } catch (e) { err(body, e, load); }
  }
  function editRole(r) {
    const x = r || { level: 20 };
    formModal(r ? 'แก้ไขบทบาท' : 'เพิ่มบทบาท', `<div class="grid-2">
      <div class="field"><label>รหัสบทบาท * <span class="hint">a-z และ _</span></label><input name="code" class="input" value="${esc(x.code || '')}" ${r?.is_system ? 'disabled' : ''}></div>
      <div class="field"><label>ระดับ (0-100) *</label><input name="level" type="number" min="0" max="100" class="input" value="${esc(x.level)}">
        <span class="hint">ผู้ที่มีระดับสูงกว่าเท่านั้นจึงจัดการผู้ใช้ระดับต่ำกว่าได้</span></div>
      <div class="field"><label>ชื่อบทบาท *</label><input name="name" class="input" value="${esc(x.name || '')}"></div>
      <div class="field"><label>ชื่อภาษาอังกฤษ</label><input name="name_en" class="input" value="${esc(x.name_en || '')}"></div></div>
      <div class="field"><label>คำอธิบาย</label><input name="description" class="input" value="${esc(x.description || '')}"></div>`,
    async (f) => {
      const row = { name: f.name, name_en: f.name_en || null, description: f.description || null, level: Number(f.level) };
      if (!r) row.code = f.code;
      if (!row.name || (!r && !/^[a-z_]{2,40}$/.test(row.code))) { toast('กรุณากรอกรหัสและชื่อบทบาทให้ถูกต้อง', 'error'); return false; }
      if (r) must(await supabase.from('roles').update(row).eq('id', r.id)); else must(await supabase.from('roles').insert(row));
      toast('บันทึกแล้ว', 'success'); load();
    });
  }
  load();
}

// ================================================================= groups
async function groups(el) {
  el.innerHTML = `<div class="toolbar"><span style="flex:1"></span><button class="btn btn-primary" data-new>${icon('plus')} เพิ่มกลุ่ม</button></div><div class="panel" data-list>${loadingState(5)}</div>`;
  const listEl = $('[data-list]', el);
  async function load() {
    invalidate('groups');
    try {
      const list = must(await supabase.from('groups').select('*, group_members(count)').order('name'));
      listEl.innerHTML = list.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>กลุ่ม</th><th>สมาชิก</th><th>สถานะ</th><th></th></tr></thead><tbody>
        ${list.map((g) => `<tr data-id="${esc(g.id)}"><td data-label="กลุ่ม"><b>${esc(g.name)}</b><div class="cell-sub">${esc(g.description || '')}</div></td>
          <td data-label="สมาชิก">${g.group_members?.[0]?.count ?? 0} คน</td><td data-label="สถานะ">${g.is_active ? '<span class="chip chip-ok">ใช้งาน</span>' : '<span class="chip">ปิด</span>'}</td>
          <td class="actions"><button class="btn btn-sm" data-members>${icon('users')} สมาชิก</button> <button class="btn btn-sm" data-edit>${icon('edit')}</button> <button class="btn btn-sm btn-danger" data-del>${icon('trash')}</button></td></tr>`).join('')}
        </tbody></table></div>` : emptyState('ยังไม่มีกลุ่ม', 'กลุ่มช่วยให้สิทธิ์เอกสาร ข่าว และระบบกับคนข้ามแผนก เช่น ทีมโครงการ', '', 'users');
      listEl.onclick = async (e) => {
        const row = e.target.closest('[data-id]'); if (!row) return;
        const g = list.find((x) => x.id === row.dataset.id);
        if (e.target.closest('[data-edit]')) edit(g);
        if (e.target.closest('[data-members]')) membersModal(g);
        if (e.target.closest('[data-del]')) {
          if (!await confirmDialog({ title: 'ลบกลุ่ม', message: `ลบกลุ่ม "${g.name}"? สิทธิ์ที่ให้ผ่านกลุ่มนี้จะถูกลบด้วย`, confirmText: 'ลบกลุ่ม', danger: true })) return;
          try { must(await supabase.from('groups').delete().eq('id', g.id)); toast('ลบกลุ่มแล้ว', 'success'); load(); } catch (er) { toastError(er); }
        }
      };
    } catch (e) { err(listEl, e, load); }
  }
  function edit(g) {
    const x = g || { is_active: true };
    formModal(g ? 'แก้ไขกลุ่ม' : 'เพิ่มกลุ่ม', `<div class="field"><label>ชื่อกลุ่ม *</label><input name="name" class="input" value="${esc(x.name || '')}"></div>
      <div class="field"><label>คำอธิบาย</label><input name="description" class="input" value="${esc(x.description || '')}"></div>
      <label class="check"><input type="checkbox" name="is_active" ${x.is_active ? 'checked' : ''}> ใช้งาน</label>`,
    async (f) => {
      if (!f.name) { toast('กรุณาระบุชื่อกลุ่ม', 'error'); return false; }
      if (g) must(await supabase.from('groups').update(f).eq('id', g.id)); else must(await supabase.from('groups').insert(f));
      toast('บันทึกแล้ว', 'success'); load();
    });
  }
  async function membersModal(g) {
    const m = modal({ title: `สมาชิกกลุ่ม — ${g.name}`, size: 'lg', body: `<div data-mlist>${loadingState(3)}</div><h3 style="margin:18px 0 8px">เพิ่มสมาชิก</h3><div data-picker></div><button class="btn btn-primary" data-add>${icon('plus')} เพิ่มสมาชิก</button>`, footer: '<button class="btn btn-primary" data-close>เสร็จสิ้น</button>' });
    m.onClose(load);
    const picker = await principalPicker($('[data-picker]', m.el), ['user']);
    const draw = async () => {
      const rows = must(await supabase.from('group_members').select('user_id, profiles(full_name, email)').eq('group_id', g.id));
      $('[data-mlist]', m.el).innerHTML = rows.length ? `<ul class="list">${rows.map((r) => `<li style="display:flex;align-items:center;gap:10px;padding:8px 0"><span style="flex:1">${esc(r.profiles?.full_name || '-')} <span class="muted">${esc(r.profiles?.email || '')}</span></span>
        <button class="btn btn-sm btn-ghost" data-rm="${esc(r.user_id)}">${icon('x')} นำออก</button></li>`).join('')}</ul>` : '<p class="muted">ยังไม่มีสมาชิก</p>';
    };
    m.body.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rm]');
      try {
        if (rm) { must(await supabase.from('group_members').delete().eq('group_id', g.id).eq('user_id', rm.dataset.rm)); await draw(); }
        if (e.target.closest('[data-add]')) { const p = picker.get(); if (p) { must(await supabase.from('group_members').insert({ group_id: g.id, user_id: p.id })); await draw(); } }
      } catch (er) { toastError(er); }
    });
    draw().catch((e) => err($('[data-mlist]', m.el), e));
  }
  $('[data-new]', el).addEventListener('click', () => edit(null));
  load();
}

// ============================================================= categories
async function categories(el) {
  el.innerHTML = `<div class="toolbar"><span style="flex:1"></span><button class="btn btn-primary" data-new>${icon('plus')} เพิ่มหมวดหมู่</button></div><div class="panel" data-list>${loadingState(5)}</div>`;
  const listEl = $('[data-list]', el);
  async function load() {
    invalidate('categories');
    try {
      const list = await getCategories();
      const byId = Object.fromEntries(list.map((c) => [c.id, c.name]));
      listEl.innerHTML = list.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>ลำดับ</th><th>หมวดหมู่</th><th>อยู่ภายใต้</th><th>สถานะ</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr data-id="${esc(c.id)}"><td data-label="ลำดับ">${c.sort_order}</td><td data-label="หมวดหมู่"><b>${esc(c.name)}</b><div class="cell-sub">${esc(c.description || '')}</div></td>
          <td data-label="อยู่ภายใต้">${esc(byId[c.parent_id] || '-')}</td><td data-label="สถานะ">${c.is_active ? '<span class="chip chip-ok">ใช้งาน</span>' : '<span class="chip">ปิด</span>'}</td>
          <td class="actions"><button class="btn btn-sm" data-edit>${icon('edit')} แก้ไข</button> <button class="btn btn-sm btn-danger" data-del>${icon('trash')}</button></td></tr>`).join('')}
        </tbody></table></div>` : emptyState('ยังไม่มีหมวดหมู่', '', '', 'folder');
      listEl.onclick = async (e) => {
        const row = e.target.closest('[data-id]'); if (!row) return;
        const c = list.find((x) => x.id === row.dataset.id);
        if (e.target.closest('[data-edit]')) edit(c, list);
        if (e.target.closest('[data-del]')) {
          if (!await confirmDialog({ title: 'ลบหมวดหมู่', message: `ลบ "${c.name}"? เอกสารในหมวดนี้จะไม่มีหมวดหมู่`, confirmText: 'ลบหมวดหมู่', danger: true })) return;
          try { must(await supabase.from('document_categories').delete().eq('id', c.id)); toast('ลบแล้ว', 'success'); load(); } catch (er) { toastError(er); }
        }
      };
    } catch (e) { err(listEl, e, load); }
  }
  function edit(c, list) {
    const x = c || { is_active: true, sort_order: (list.length + 1) * 10 };
    formModal(c ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่', `<div class="grid-2">
      <div class="field"><label>ชื่อหมวดหมู่ *</label><input name="name" class="input" value="${esc(x.name || '')}"></div>
      <div class="field"><label>ชื่อภาษาอังกฤษ</label><input name="name_en" class="input" value="${esc(x.name_en || '')}"></div>
      <div class="field"><label>อยู่ภายใต้</label><select name="parent_id" class="select">${opts(list.filter((o) => o.id !== x.id), x.parent_id, { empty: '— ไม่มี —' })}</select></div>
      <div class="field"><label>ลำดับ</label><input name="sort_order" type="number" class="input" value="${esc(x.sort_order)}"></div></div>
      <div class="field"><label>คำอธิบาย</label><input name="description" class="input" value="${esc(x.description || '')}"></div>
      <label class="check"><input type="checkbox" name="is_active" ${x.is_active ? 'checked' : ''}> ใช้งาน</label>`,
    async (f) => {
      if (!f.name) { toast('กรุณาระบุชื่อหมวดหมู่', 'error'); return false; }
      const row = { ...f, parent_id: f.parent_id || null, sort_order: Number(f.sort_order) || 0, name_en: f.name_en || null };
      if (c) must(await supabase.from('document_categories').update(row).eq('id', c.id)); else must(await supabase.from('document_categories').insert(row));
      toast('บันทึกแล้ว', 'success'); load();
    }, { size: 'lg' });
  }
  $('[data-new]', el).addEventListener('click', async () => edit(null, await getCategories()));
  load();
}

// ================================================= document access control
async function access(el) {
  el.innerHTML = `<div class="toolbar">
    <input class="input search-input" type="search" data-q placeholder="ค้นหาเอกสาร" aria-label="ค้นหาเอกสาร">
    <select class="select" data-level aria-label="ระดับสิทธิ์">${opts(Object.entries(DOC_ACCESS).map(([k, v]) => ({ id: k, name: v.label })), '', { empty: 'ทุกระดับสิทธิ์' })}</select></div>
    <div class="panel" data-list>${loadingState(6)}</div>`;
  const listEl = $('[data-list]', el); const st = { q: '', level: '', page: 1 };
  async function load() {
    try {
      let q = supabase.from('documents').select('id, title, doc_number, access_level, departments(name), document_permissions(count)', { count: 'exact' }).is('deleted_at', null);
      if (st.q) q = q.ilike('search_text', likePattern(st.q));
      if (st.level) q = q.eq('access_level', st.level);
      const { data, count } = must(await q.order('updated_at', { ascending: false }).range((st.page - 1) * 25, st.page * 25 - 1));
      listEl.innerHTML = data.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>เอกสาร</th><th>แผนก</th><th>ระดับสิทธิ์</th><th>สิทธิ์เพิ่มเติม</th><th></th></tr></thead><tbody>
        ${data.map((d) => `<tr data-id="${esc(d.id)}"><td data-label="เอกสาร"><a class="cell-title" href="#/documents/${esc(d.id)}">${esc(d.title)}</a><div class="cell-sub">${esc(d.doc_number || '')}</div></td>
          <td data-label="แผนก">${esc(d.departments?.name || '-')}</td><td data-label="ระดับสิทธิ์">${accessChip(d.access_level)}</td>
          <td data-label="สิทธิ์เพิ่มเติม">${d.document_permissions?.[0]?.count ?? 0} รายการ</td>
          <td class="actions"><button class="btn btn-sm" data-perm>${icon('key')} จัดการสิทธิ์</button></td></tr>`).join('')}
        </tbody></table></div>${pager(st.page, 25, count || 0)}` : emptyState('ไม่พบเอกสาร', '', '', 'files');
      listEl.onclick = (e) => {
        const pg = e.target.closest('[data-page]'); if (pg) { st.page = Number(pg.dataset.page); load(); return; }
        const b = e.target.closest('[data-perm]'); if (!b) return;
        openPermissionsModal(data.find((x) => x.id === b.closest('[data-id]').dataset.id)).catch(toastError);
      };
    } catch (e) { err(listEl, e, load); }
  }
  $('[data-q]', el).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }, 350));
  $('[data-level]', el).addEventListener('change', (e) => { st.level = e.target.value; st.page = 1; load(); });
  load();
}

// ================================================================ storage
async function storage(el) {
  el.innerHTML = loadingState(6);
  try {
    const [stats, largest, trash] = await Promise.all([
      supabase.rpc('storage_stats').then(must),
      supabase.from('documents').select('id, title, file_size, current_version').not('file_size', 'is', null).order('file_size', { ascending: false }).limit(10).then(must),
      supabase.from('documents').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null),
    ]);
    const by = Object.fromEntries(stats.map((s) => [s.bucket_id, s]));
    const tile = (label, value, sub) => `<div class="panel"><div class="panel-body"><div class="muted">${esc(label)}</div><div style="font-size:26px;font-weight:600">${esc(value)}</div><div class="muted">${esc(sub)}</div></div></div>`;
    el.innerHTML = `<div class="card-grid" style="margin-bottom:22px">
        ${tile('เอกสาร (bucket documents)', fmtSize(by.documents?.total_bytes || 0), `${Number(by.documents?.object_count || 0).toLocaleString('th-TH')} ไฟล์ รวมทุกเวอร์ชัน`)}
        ${tile('ข่าวสาร (bucket news)', fmtSize(by.news?.total_bytes || 0), `${Number(by.news?.object_count || 0).toLocaleString('th-TH')} ไฟล์`)}
        ${tile('กิจกรรม (bucket activities)', fmtSize(by.activities?.total_bytes || 0), `${Number(by.activities?.object_count || 0).toLocaleString('th-TH')} ไฟล์ (รูปเต็ม + รูปย่อ)`)}
        ${tile('เอกสารในถังขยะ', (trash.count || 0).toLocaleString('th-TH'), 'กู้คืนหรือลบถาวรได้จากหน้าเอกสาร')}
      </div>
      <section class="panel"><div class="panel-head"><h2>เอกสารที่มีไฟล์ขนาดใหญ่ที่สุด</h2></div>
        ${largest.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>เอกสาร</th><th>เวอร์ชัน</th><th>ขนาดไฟล์ปัจจุบัน</th></tr></thead><tbody>
        ${largest.map((d) => `<tr><td data-label="เอกสาร"><a href="#/documents/${esc(d.id)}">${esc(d.title)}</a></td><td data-label="เวอร์ชัน">${d.current_version}</td><td data-label="ขนาด">${esc(fmtSize(d.file_size))}</td></tr>`).join('')}
        </tbody></table></div>` : emptyState('ยังไม่มีไฟล์', '', '', 'database', true)}
        <p class="muted" style="padding:12px 20px">รายการนี้แสดงเฉพาะเอกสารที่คุณมีสิทธิ์ดู ส่วนตัวเลขรวมด้านบนนับทุกไฟล์ใน Storage · ขีดจำกัดขนาดและประเภทไฟล์กำหนดที่ Bucket ใน Supabase</p></section>`;
  } catch (e) { err(el, e, () => storage(el)); }
}

// ================================================================== audit
async function audit(el) {
  const people = await getPeople().catch(() => []);
  el.innerHTML = `<div class="toolbar">
    <input class="input" data-action placeholder="การกระทำ เช่น document, user_roles" aria-label="การกระทำ">
    <select class="select" data-actor aria-label="ผู้ใช้">${opts(people, '', { label: (p) => p.full_name || p.email, empty: 'ทุกผู้ใช้' })}</select>
    <input class="input" type="date" data-from aria-label="ตั้งแต่วันที่"><input class="input" type="date" data-to aria-label="ถึงวันที่">
  </div><div class="panel" data-list>${loadingState(8)}</div>`;
  const listEl = $('[data-list]', el); const st = { action: '', actor: '', from: '', to: '', page: 1 };
  async function load() {
    try {
      let q = supabase.from('audit_logs').select('*', { count: 'exact' });
      if (st.action) q = q.ilike('action', likePattern(st.action));
      if (st.actor) q = q.eq('actor_id', st.actor);
      if (st.from) q = q.gte('created_at', new Date(st.from + 'T00:00:00').toISOString());
      if (st.to) q = q.lte('created_at', new Date(st.to + 'T23:59:59').toISOString());
      const { data, count } = must(await q.order('created_at', { ascending: false }).range((st.page - 1) * 50, st.page * 50 - 1));
      listEl.innerHTML = data.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>เวลา</th><th>ผู้ทำรายการ</th><th>การกระทำ</th><th>รายการ</th><th>รายละเอียด</th></tr></thead><tbody>
        ${data.map((a) => `<tr><td data-label="เวลา" style="white-space:nowrap">${esc(fmtDateTime(a.created_at))}</td><td data-label="ผู้ทำรายการ">${esc(a.actor_email || (a.actor_id ? a.actor_id.slice(0, 8) : 'ระบบ'))}</td>
          <td data-label="การกระทำ"><code>${esc(a.action)}</code></td><td data-label="รายการ">${esc(a.entity_type)}<div class="cell-sub">${esc(a.summary || a.entity_id || '')}</div></td>
          <td data-label="รายละเอียด"><details><summary class="muted" style="cursor:pointer">ดู</summary><pre style="white-space:pre-wrap;font-size:12px;max-width:420px;overflow:auto">${esc(JSON.stringify(a.details, null, 2))}</pre></details></td></tr>`).join('')}
        </tbody></table></div>${pager(st.page, 50, count || 0)}` : emptyState('ไม่พบประวัติ', '', '', 'history');
    } catch (e) { err(listEl, e, load); }
  }
  listEl.addEventListener('click', (e) => { const pg = e.target.closest('[data-page]'); if (pg) { st.page = Number(pg.dataset.page); load(); } });
  const bind = (sel, key, ev = 'change') => $(sel, el).addEventListener(ev, debounce((e) => { st[key] = e.target.value.trim(); st.page = 1; load(); }, 300));
  bind('[data-action]', 'action', 'input'); bind('[data-actor]', 'actor'); bind('[data-from]', 'from'); bind('[data-to]', 'to');
  load();
}

// =============================================================== settings
async function settings(el) {
  el.innerHTML = loadingState(8);
  try {
    const rows = must(await supabase.from('system_settings').select('*').order('key'));
    const VIS = { public: 'ทุกคน (รวมหน้า Login)', authenticated: 'ผู้ใช้ที่เข้าสู่ระบบ', admin: 'ผู้ดูแลเท่านั้น' };
    const editor = (r) => {
      const v = r.value;
      if (typeof v === 'boolean') return `<label class="check"><input type="checkbox" data-val ${v ? 'checked' : ''}> เปิดใช้งาน</label>`;
      if (typeof v === 'number') return `<input type="number" class="input" data-val value="${esc(v)}" style="max-width:160px">`;
      if (typeof v === 'string') return `<input class="input" data-val value="${esc(v)}">`;
      return `<textarea class="input" data-val style="font-family:monospace;font-size:13px">${esc(JSON.stringify(v, null, 1))}</textarea>`;
    };
    el.innerHTML = `<div class="notice notice-warn">${icon('alert')}<div>การเปิด "อนุญาตให้สมัครสมาชิกเอง" ต้องเปิดที่ Supabase → Authentication → Sign In / Providers ด้วย และการเข้าสู่ระบบด้วย Microsoft ต้องตั้งค่า Azure provider ก่อน (ดู README)</div></div>
      <div class="panel"><ul class="list">${rows.map((r) => `<li data-key="${esc(r.key)}"><div class="grid-2" style="align-items:center">
        <div><div class="cell-title">${esc(r.description || r.key)}</div><div class="cell-sub"><code>${esc(r.key)}</code> · มองเห็นโดย: ${esc(VIS[r.visibility])} · แก้ไขล่าสุด ${esc(fmtRelative(r.updated_at))}</div></div>
        <div style="display:flex;gap:8px;align-items:center">${editor(r)}<button class="btn btn-sm" data-save>บันทึก</button></div></div></li>`).join('')}</ul></div>`;
    el.onclick = async (e) => {
      const b = e.target.closest('[data-save]'); if (!b) return;
      const li = b.closest('[data-key]'); const r = rows.find((x) => x.key === li.dataset.key); const input = $('[data-val]', li);
      let value;
      try {
        if (typeof r.value === 'boolean') value = input.checked;
        else if (typeof r.value === 'number') { value = Number(input.value); if (!Number.isFinite(value)) throw new Error('ต้องเป็นตัวเลข'); }
        else if (typeof r.value === 'string') value = input.value;
        else value = JSON.parse(input.value);
      } catch (er) { toast(`ค่าไม่ถูกต้อง: ${er.message}`, 'error'); return; }
      withLoading(b, async () => {
        try { must(await supabase.from('system_settings').update({ value }).eq('key', r.key)); r.value = value; await loadSettings(); toast('บันทึกการตั้งค่าแล้ว', 'success'); }
        catch (er) { toastError(er); }
      });
    };
  } catch (e) { err(el, e, () => settings(el)); }
}
