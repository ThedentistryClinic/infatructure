// Application Center (user view) + Application Links Management (admin tab).
// Hiding a link only controls visibility in the portal; each target system must
// still enforce its own authentication and authorisation.
import { supabase } from '../supabase.js';
import { must, can, setting, nameMaps, getFavoriteIds, setFavorite, PRINCIPAL_LABEL } from '../api.js';
import { principalPicker, principalColumns, principalName } from '../components.js';
import { icon, APP_ICONS } from '../icons.js';
import { esc, $, $$, modal, confirmDialog, toast, toastError, withLoading, loadingState, emptyState, errorState, formData, opts, debounce } from '../ui.js';

export function appIcon(a, size = 40) {
  const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#1E3A8A';
  return `<span class="app-ic" style="background:${color};width:${size}px;height:${size}px">${icon(a.icon || 'grid')}</span>`;
}

/** Open a system link and record usage (popup opened synchronously to avoid blockers). */
export function openApplication(a) {
  if (!a) return;
  if (!a.is_active) { toast('ระบบนี้ปิดใช้งานชั่วคราว', 'error'); return; }
  if (!/^https?:\/\//i.test(a.url)) { toast('URL ของระบบไม่ถูกต้อง', 'error'); return; }
  const track = supabase.rpc('track_application_open', { p_application_id: a.id }).then(({ error }) => error && console.warn(error));
  if (a.open_in_new_tab) window.open(a.url, '_blank', 'noopener,noreferrer');
  else track.finally(() => { location.href = a.url; });
}

const categoriesList = () => setting('apps.categories', ['IT', 'HR', 'Finance', 'Operations', 'Management', 'Other']);

export async function render(view, _p, _q, { setTitle }) {
  setTitle('ระบบงาน');
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>ศูนย์รวมระบบงาน</h1><p>เปิดระบบงานต่าง ๆ ของบริษัทได้จากที่นี่ ระบบปลายทางอาจขอให้เข้าสู่ระบบอีกครั้ง</p></div>
      ${can('apps.manage') ? `<a class="btn" href="#/admin/apps">${icon('settings')} จัดการลิงก์ระบบ</a>` : ''}</div>
    <div class="toolbar">
      <input class="input search-input" type="search" data-q placeholder="ค้นหาระบบ" aria-label="ค้นหาระบบ">
      <div class="seg" role="group" aria-label="หมวดหมู่" data-cats></div>
    </div>
    <div data-list>${loadingState(5)}</div>`;
  const listEl = $('[data-list]', view);
  let apps = []; let favs = new Set(); let cat = ''; let q = '';

  try {
    [apps, favs] = await Promise.all([
      supabase.from('applications').select('id, name, description, url, icon, color, category, open_in_new_tab, is_active, sort_order')
        .order('sort_order').order('name').then(must),
      getFavoriteIds('application'),
    ]);
  } catch (e) { listEl.innerHTML = `<div class="panel">${errorState(e)}</div>`; $('[data-retry]', listEl)?.addEventListener('click', () => render(view, _p, _q, { setTitle })); return; }

  const cats = [...new Set([...categoriesList(), ...apps.map((a) => a.category)])].filter((c) => apps.some((a) => a.category === c));
  $('[data-cats]', view).innerHTML = `<button data-cat="" aria-pressed="true">ทั้งหมด</button>` +
    cats.map((c) => `<button data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('');

  function draw() {
    const list = apps.filter((a) => (!cat || a.category === cat) &&
      (!q || `${a.name} ${a.description || ''}`.toLowerCase().includes(q)));
    if (!list.length) {
      listEl.innerHTML = `<div class="panel">${emptyState(apps.length ? 'ไม่พบระบบที่ค้นหา' : 'ยังไม่มีระบบที่คุณเข้าถึงได้', apps.length ? 'ลองใช้คำค้นอื่น' : '', '', 'grid')}</div>`;
      return;
    }
    const groups = cats.filter((c) => list.some((a) => a.category === c));
    listEl.innerHTML = groups.map((c) => `<h2 class="cat-title">${esc(c)}</h2><div class="card-grid">${list.filter((a) => a.category === c).map((a) => `
      <article class="app-card ${a.is_active ? '' : 'inactive'}">
        <button class="btn btn-ghost btn-sm btn-icon fav-btn" data-fav="${esc(a.id)}" aria-pressed="${favs.has(a.id)}" aria-label="รายการโปรด">${icon('star')}</button>
        <div class="head">${appIcon(a)}<div><h3>${esc(a.name)}</h3>${a.is_active ? '' : '<span class="chip">ปิดใช้งาน</span>'}</div></div>
        <p>${esc(a.description || '')}</p>
        <div class="foot"><button class="btn ${a.is_active ? 'btn-primary' : ''} btn-sm" data-open="${esc(a.id)}" ${a.is_active ? '' : 'disabled'}>
          ${icon(a.open_in_new_tab ? 'external' : 'link')} เปิดระบบ</button>
          <span class="muted">${a.open_in_new_tab ? 'แท็บใหม่' : 'แท็บเดิม'}</span></div>
      </article>`).join('')}</div>`).join('');
  }
  listEl.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]'); if (o) { openApplication(apps.find((a) => a.id === o.dataset.open)); return; }
    const f = e.target.closest('[data-fav]'); if (!f) return;
    const on = f.getAttribute('aria-pressed') !== 'true';
    try { await setFavorite('application', f.dataset.fav, on); f.setAttribute('aria-pressed', String(on)); on ? favs.add(f.dataset.fav) : favs.delete(f.dataset.fav); }
    catch (err) { toastError(err); }
  });
  $('[data-q]', view).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150));
  $('[data-cats]', view).addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    cat = b.dataset.cat; $$('[data-cat]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw();
  });
  draw();
}

// =================================================================== admin
export async function renderAdmin(el) {
  el.innerHTML = `<div class="toolbar"><input class="input search-input" type="search" data-q placeholder="ค้นหาระบบ" aria-label="ค้นหา">
    <button class="btn btn-primary" data-new>${icon('plus')} เพิ่มระบบ</button></div><div data-list class="panel">${loadingState(5)}</div>`;
  const listEl = $('[data-list]', el);
  let apps = []; let q = '';
  async function load() {
    try {
      apps = must(await supabase.from('applications').select('*, application_permissions(count)').order('sort_order').order('name'));
      draw();
    } catch (e) { listEl.innerHTML = errorState(e); $('[data-retry]', listEl)?.addEventListener('click', load); }
  }
  function draw() {
    const list = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.url || '').toLowerCase().includes(q));
    if (!list.length) { listEl.innerHTML = emptyState(apps.length ? 'ไม่พบระบบ' : 'ยังไม่มีระบบ', 'เพิ่มระบบแรกเพื่อให้พนักงานเปิดใช้งานจากพอร์ทัลได้', '', 'grid'); return; }
    listEl.innerHTML = `<div class="table-wrap"><table class="table responsive"><thead><tr><th>ลำดับ</th><th>ระบบ</th><th>หมวดหมู่</th><th>การมองเห็น</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${list.map((a) => `<tr data-id="${esc(a.id)}">
        <td data-label="ลำดับ" style="white-space:nowrap">${q ? '' : `<button class="btn btn-ghost btn-sm btn-icon" data-move="-1" aria-label="เลื่อนขึ้น">${icon('up')}</button><button class="btn btn-ghost btn-sm btn-icon" data-move="1" aria-label="เลื่อนลง">${icon('down')}</button>`}</td>
        <td data-label="ระบบ"><div style="display:flex;gap:12px;align-items:center">${appIcon(a, 34)}<div><div class="cell-title">${esc(a.name)}</div><div class="cell-sub">${esc(a.url)}</div></div></div></td>
        <td data-label="หมวดหมู่">${esc(a.category)}${a.is_quick_access ? ' <span class="chip">เมนูด่วน</span>' : ''}</td>
        <td data-label="การมองเห็น">${a.visibility === 'all' ? 'พนักงานทุกคน' : `เฉพาะที่กำหนด (${a.application_permissions?.[0]?.count ?? 0})`}</td>
        <td data-label="สถานะ">${a.is_active ? '<span class="chip chip-ok">Active</span>' : '<span class="chip">Inactive</span>'}</td>
        <td class="actions"><button class="btn btn-sm" data-edit>${icon('edit')} แก้ไข</button> <button class="btn btn-sm btn-danger" data-del aria-label="ลบ">${icon('trash')}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  listEl.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-id]'); if (!row) return;
    const a = apps.find((x) => x.id === row.dataset.id);
    if (e.target.closest('[data-edit]')) openAppEditor(a, load);
    if (e.target.closest('[data-del]')) {
      if (!await confirmDialog({ title: 'ลบระบบ', message: `ลบ "${a.name}" ออกจากพอร์ทัล? (ไม่กระทบระบบปลายทาง)`, confirmText: 'ลบระบบ', danger: true })) return;
      try { must(await supabase.from('applications').delete().eq('id', a.id)); toast('ลบระบบแล้ว', 'success'); load(); } catch (err) { toastError(err); }
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const idx = apps.indexOf(a); const to = idx + Number(mv.dataset.move);
      if (to < 0 || to >= apps.length) return;
      const ids = apps.map((x) => x.id); [ids[idx], ids[to]] = [ids[to], ids[idx]];
      try { must(await supabase.rpc('reorder_applications', { p_ids: ids })); load(); } catch (err) { toastError(err); }
    }
  });
  $('[data-q]', el).addEventListener('input', debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150));
  $('[data-new]', el).addEventListener('click', () => openAppEditor(null, load));
  load();
}

async function openAppEditor(app, onDone) {
  const a = app || { icon: 'grid', color: '#1E3A8A', category: categoriesList()[0], open_in_new_tab: true, is_active: true, visibility: 'all' };
  const m = modal({
    title: app ? `แก้ไขระบบ — ${app.name}` : 'เพิ่มระบบ', size: 'lg',
    body: `<form data-f novalidate>
      <div class="grid-2">
        <div class="field"><label for="a-name">ชื่อระบบ *</label><input id="a-name" name="name" class="input" maxlength="120" value="${esc(a.name || '')}"></div>
        <div class="field"><label for="a-cat">หมวดหมู่</label><select id="a-cat" name="category" class="select">${opts([...new Set([...categoriesList(), a.category])].map((c) => ({ id: c, name: c })), a.category)}</select></div>
      </div>
      <div class="field"><label for="a-url">URL *</label><input id="a-url" name="url" class="input" type="url" placeholder="https://" value="${esc(a.url || '')}"></div>
      <div class="field"><label for="a-desc">คำอธิบาย</label><input id="a-desc" name="description" class="input" maxlength="300" value="${esc(a.description || '')}"></div>
      <div class="grid-2">
        <div class="field"><label for="a-icon">ไอคอน</label><select id="a-icon" name="icon" class="select">${opts(APP_ICONS.map((i) => ({ id: i, name: i })), a.icon)}</select></div>
        <div class="field"><label for="a-color">สีประจำระบบ</label><input id="a-color" name="color" type="color" class="input" style="padding:4px;height:40px" value="${esc(a.color)}"></div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px"><span data-preview>${appIcon(a)}</span><span class="muted">ตัวอย่างไอคอน</span></div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px">
        <label class="check"><input type="checkbox" name="open_in_new_tab" ${a.open_in_new_tab ? 'checked' : ''}> เปิดในแท็บใหม่</label>
        <label class="check"><input type="checkbox" name="is_quick_access" ${a.is_quick_access ? 'checked' : ''}> แสดงในเมนูด่วนหน้าแรก</label>
        <label class="check"><input type="checkbox" name="is_active" ${a.is_active ? 'checked' : ''}> เปิดใช้งาน (Active)</label>
      </div>
      <div class="field"><label for="a-vis">ผู้ที่มองเห็นระบบนี้</label><select id="a-vis" name="visibility" class="select">
        <option value="all" ${a.visibility === 'all' ? 'selected' : ''}>พนักงานทุกคน</option>
        <option value="restricted" ${a.visibility === 'restricted' ? 'selected' : ''}>เฉพาะบทบาท แผนก กลุ่ม หรือบุคคลที่กำหนด</option></select>
        <span class="hint">เป็นการควบคุมการมองเห็นในพอร์ทัลเท่านั้น ระบบปลายทางต้องตรวจสอบสิทธิ์ของตนเองด้วย</span></div>
    </form>
    <div data-perms ${a.visibility === 'restricted' ? '' : 'hidden'}></div>`,
    footer: `<button class="btn" data-close>ยกเลิก</button><button class="btn btn-primary" data-save>บันทึก</button>`,
  });
  const form = $('[data-f]', m.el);
  const refreshPreview = () => { const f = formData(form); $('[data-preview]', m.el).innerHTML = appIcon(f); };
  form.addEventListener('change', (e) => {
    refreshPreview();
    if (e.target.name === 'visibility') {
      const show = e.target.value === 'restricted' && !!app;
      $('[data-perms]', m.el).hidden = !show;
      if (show && !permsDrawn) { permsDrawn = true; drawAppPerms($('[data-perms]', m.el), app.id); }
    }
  });
  let permsDrawn = false;
  if (app && a.visibility === 'restricted') { permsDrawn = true; drawAppPerms($('[data-perms]', m.el), app.id); }

  $('[data-save]', m.el).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const f = formData(form);
    if (!f.name) return toast('กรุณาระบุชื่อระบบ', 'error');
    if (!/^https?:\/\/[^\s]+$/i.test(f.url)) return toast('URL ต้องขึ้นต้นด้วย http:// หรือ https://', 'error');
    try {
      if (app) {
        must(await supabase.from('applications').update(f).eq('id', app.id));
        toast('บันทึกแล้ว', 'success'); m.close(); onDone();
      } else {
        const maxOrder = Math.max(0, ...(await supabase.from('applications').select('sort_order').then(must)).map((x) => x.sort_order));
        const created = must(await supabase.from('applications').insert({ ...f, sort_order: maxOrder + 10 }).select('*').single());
        toast('เพิ่มระบบแล้ว', 'success'); m.close(); onDone();
        if (created.visibility === 'restricted') { toast('กำหนดผู้มองเห็นระบบต่อได้เลย', 'info'); openAppEditor(created, onDone); }
      }
    } catch (err) { toastError(err); }
  }));
}

async function drawAppPerms(el, appId) {
  el.innerHTML = `<h3 style="margin:8px 0 10px">ผู้ที่มองเห็นระบบนี้</h3><div data-rows>${loadingState(2)}</div><div data-picker></div>
    <button class="btn btn-sm btn-primary" data-add>${icon('plus')} เพิ่ม</button>`;
  const rowsEl = $('[data-rows]', el);
  const picker = await principalPicker($('[data-picker]', el));
  async function draw() {
    const [rows, maps] = await Promise.all([supabase.from('application_permissions').select('*').eq('application_id', appId).then(must), nameMaps()]);
    rowsEl.innerHTML = rows.length ? `<ul class="list" style="border:1px solid var(--line);border-radius:10px;margin-bottom:14px">${rows.map((r) => `
      <li style="display:flex;align-items:center;gap:10px;padding:8px 14px"><span class="chip">${esc(PRINCIPAL_LABEL[r.principal_type])}</span><span style="flex:1">${esc(principalName(r, maps))}</span>
      <button class="btn btn-sm btn-ghost" data-rm="${esc(r.id)}" aria-label="นำออก">${icon('x')}</button></li>`).join('')}</ul>`
      : '<p class="muted">ยังไม่ได้กำหนด — ขณะนี้มีเพียงผู้ดูแลลิงก์ระบบที่มองเห็น</p>';
  }
  rowsEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    try { must(await supabase.from('application_permissions').delete().eq('id', b.dataset.rm)); draw(); } catch (err) { toastError(err); }
  });
  $('[data-add]', el).addEventListener('click', async () => {
    const p = picker.get(); if (!p) return;
    try { must(await supabase.from('application_permissions').insert({ application_id: appId, ...principalColumns(p.type, p.id) })); draw(); }
    catch (err) { toastError(err); }
  });
  draw().catch((e) => { rowsEl.innerHTML = errorState(e, false); });
}
