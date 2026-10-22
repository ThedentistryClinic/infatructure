// Activities: photo albums of company events.
// Photos are resized in the browser (full 1920px + thumbnail 560px, JPEG) and
// stored in the private `activities` bucket; viewers get short-lived signed URLs.
import { supabase } from '../supabase.js';
import { must, can, getDepartments } from '../api.js';
import { icon } from '../icons.js';
import {
  esc, $, toast, toastError, withLoading, loadingState, emptyState, errorState, confirmDialog,
  fmtDate, opts, formData, debounce, likePattern, pager,
} from '../ui.js';

const BUCKET = 'activities';
const PAGE = 12;
const FULL_PX = 1920;
const THUMB_PX = 560;
const MAX_INPUT_MB = 25;
const canManage = () => can('activities.manage');

// ------------------------------------------------------------------ helpers
export async function signActivityImages(root) {
  const imgs = Array.from(root.querySelectorAll('img[data-act]'));
  if (!imgs.length) return;
  const paths = [...new Set(imgs.map((i) => i.dataset.act))];
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  const map = Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
  imgs.forEach((i) => { if (map[i.dataset.act]) i.src = map[i.dataset.act]; });
}

function coverImg(a, cls = '') {
  const thumb = a.cover?.thumb_path;
  return thumb
    ? `<img class="${cls}" data-act="${esc(thumb)}" alt="" loading="lazy" width="400" height="300">`
    : `<img class="${cls} act-cover-mark" src="assets/mark-white.png" alt="" width="150" height="65">`;
}

const ACT_COLUMNS = 'id, title, description, activity_date, location, status, photo_count, created_at, cover:activity_photos!activities_cover_fk(thumb_path)';

/** Album cards (used on the list page and on the dashboard). */
export function activityCards(rows, { compact = false } = {}) {
  return `<div class="act-grid ${compact ? 'compact' : ''}">${rows.map((a) => `
    <a class="act-card" href="#/activities/${esc(a.id)}">
      <span class="act-cover">${coverImg(a)}
        <span class="act-count">${icon('image')} ${a.photo_count}</span>
        ${a.status === 'draft' ? '<span class="chip act-draft">ฉบับร่าง</span>' : ''}</span>
      <span class="act-body">
        <span class="act-title">${esc(a.title)}</span>
        <span class="act-meta">${icon('calendar')} ${esc(fmtDate(a.activity_date || a.created_at))}${a.location && !compact ? ` · ${esc(a.location)}` : ''}</span>
      </span>
    </a>`).join('')}</div>`;
}

export async function latestActivities(limit = 4) {
  return must(await supabase.from('activities').select(ACT_COLUMNS).eq('status', 'published')
    .order('activity_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(limit));
}

/** Resize an image file to a JPEG blob no larger than maxPx on the long side. */
async function resizeImage(file, maxPx, quality) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`เปิดไฟล์ ${file.name} ไม่ได้ (รองรับ JPG, PNG, WEBP)`); }
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale); const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error(`แปลงรูป ${file.name} ไม่สำเร็จ`);
  return { blob, width: w, height: h };
}

async function uploadPhoto(activityId, file, order) {
  const full = await resizeImage(file, FULL_PX, 0.86);
  const thumb = await resizeImage(file, THUMB_PX, 0.8);
  const key = `${activityId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const up1 = await supabase.storage.from(BUCKET).upload(`${key}-full.jpg`, full.blob, { contentType: 'image/jpeg', upsert: false });
  if (up1.error) throw up1.error;
  const up2 = await supabase.storage.from(BUCKET).upload(`${key}-thumb.jpg`, thumb.blob, { contentType: 'image/jpeg', upsert: false });
  if (up2.error) { await supabase.storage.from(BUCKET).remove([`${key}-full.jpg`]); throw up2.error; }
  must(await supabase.from('activity_photos').insert({
    activity_id: activityId, file_path: `${key}-full.jpg`, thumb_path: `${key}-thumb.jpg`,
    width: full.width, height: full.height, sort_order: order,
  }));
}

// ================================================================ list page
export async function render(view, _p, query, { setTitle }) {
  setTitle('กิจกรรม');
  const st = { q: query.q || '', page: 1 };
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>กิจกรรม (Activity)</h1><p>ภาพบรรยากาศกิจกรรมต่าง ๆ ของบริษัท</p></div>
      ${canManage() ? `<a class="btn btn-primary" href="#/activities/new">${icon('plus')} สร้างอัลบั้ม</a>` : ''}</div>
    <div class="toolbar"><input class="input search-input" type="search" data-q placeholder="ค้นหากิจกรรม" value="${esc(st.q)}" aria-label="ค้นหากิจกรรม"></div>
    <div data-list>${loadingState(6)}</div>`;
  const listEl = $('[data-list]', view);
  async function load() {
    listEl.innerHTML = loadingState(6);
    try {
      let q = supabase.from('activities').select(ACT_COLUMNS, { count: 'exact' });
      if (st.q) q = q.or(`title.ilike.${likePattern(st.q).replace(/[,()"]/g, ' ')},location.ilike.${likePattern(st.q).replace(/[,()"]/g, ' ')}`);
      const { data, count } = must(await q.order('activity_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }).range((st.page - 1) * PAGE, st.page * PAGE - 1));
      if (!data.length) {
        listEl.innerHTML = `<div class="panel">${emptyState(st.q ? 'ไม่พบกิจกรรมที่ค้นหา' : 'ยังไม่มีกิจกรรม',
          canManage() && !st.q ? 'สร้างอัลบั้มแรกแล้วอัปโหลดรูปกิจกรรมได้เลย' : '',
          canManage() && !st.q ? `<a class="btn btn-primary" href="#/activities/new">${icon('plus')} สร้างอัลบั้ม</a>` : '', 'image')}</div>`;
        return;
      }
      listEl.innerHTML = `${activityCards(data)}<div class="panel" style="margin-top:16px">${pager(st.page, PAGE, count || 0)}</div>`;
      signActivityImages(listEl);
    } catch (e) { listEl.innerHTML = `<div class="panel">${errorState(e)}</div>`; $('[data-retry]', listEl)?.addEventListener('click', load); }
  }
  listEl.addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) { st.page = Number(b.dataset.page); load(); } });
  $('[data-q]', view).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }, 350));
  await load();
}

// ============================================================== detail page
export async function renderDetail(view, { id }, _q, { setTitle }) {
  view.innerHTML = `<div class="panel">${loadingState(6)}</div>`;
  const { data: a, error } = await supabase.from('activities').select('*, departments(name), author:profiles!activities_created_by_fkey(full_name)').eq('id', id).maybeSingle();
  if (error && error.code !== '22P02') throw error;
  if (!a) {
    setTitle('ไม่พบกิจกรรม');
    view.innerHTML = `<div class="panel">${emptyState('ไม่พบกิจกรรม', '', '<a class="btn" href="#/activities">กลับไปหน้ากิจกรรม</a>', 'image')}</div>`;
    return;
  }
  setTitle(a.title);
  const photos = must(await supabase.from('activity_photos').select('id, file_path, thumb_path, caption, width, height')
    .eq('activity_id', id).order('sort_order').order('created_at'));
  view.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/activities" class="muted">กิจกรรม</a>
      <h1 style="margin-top:4px">${esc(a.title)}</h1>
      <div class="article-meta" style="margin:8px 0 0">
        <span>${icon('calendar')} ${esc(fmtDate(a.activity_date || a.created_at, { day: 'numeric', month: 'long', year: 'numeric' }))}</span>
        ${a.location ? `<span>${esc(a.location)}</span>` : ''}
        <span>${photos.length} รูป</span>
        ${a.status === 'draft' ? '<span class="chip chip-warn">ฉบับร่าง — ยังไม่แสดงให้พนักงานเห็น</span>' : ''}
      </div></div>
      ${canManage() ? `<a class="btn" href="#/activities/${esc(id)}/edit">${icon('edit')} แก้ไข / เพิ่มรูป</a>
        <button class="btn btn-danger" data-del>${icon('trash')} ลบอัลบั้ม</button>` : ''}
    </div>
    ${a.description ? `<p class="act-desc">${esc(a.description)}</p>` : ''}
    ${photos.length ? `<div class="act-photos">${photos.map((p, i) => `
      <button class="act-photo" data-idx="${i}" aria-label="ดูรูปที่ ${i + 1}">
        <img data-act="${esc(p.thumb_path)}" alt="${esc(p.caption || '')}" loading="lazy" width="400" height="300"></button>`).join('')}</div>`
      : `<div class="panel">${emptyState('ยังไม่มีรูปในอัลบั้มนี้', canManage() ? 'กด "แก้ไข / เพิ่มรูป" เพื่ออัปโหลด' : '', '', 'image')}</div>`}`;
  signActivityImages(view);
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-idx]'); if (b) openLightbox(photos, Number(b.dataset.idx));
  });
  $('[data-del]', view)?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'ลบอัลบั้ม', message: `ลบ "${a.title}" และรูปทั้งหมด ${photos.length} รูป? ไม่สามารถกู้คืนได้`, confirmText: 'ลบอัลบั้ม', danger: true })) return;
    try {
      const paths = photos.flatMap((p) => [p.file_path, p.thumb_path]);
      if (paths.length) { const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths); if (rmErr) throw rmErr; }
      must(await supabase.from('activities').delete().eq('id', id));
      toast('ลบอัลบั้มแล้ว', 'success'); location.hash = '#/activities';
    } catch (err) { toastError(err); }
  });
}

function openLightbox(photos, start) {
  let idx = start;
  const box = document.createElement('div');
  box.className = 'lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'ดูรูปกิจกรรม');
  box.innerHTML = `
    <button class="lb-btn lb-close" data-close aria-label="ปิด">${icon('x')}</button>
    <button class="lb-btn lb-prev" data-prev aria-label="รูปก่อนหน้า">${icon('down')}</button>
    <figure class="lb-figure"><div class="lb-stage"><div class="spinner"></div><img alt=""></div><figcaption></figcaption></figure>
    <button class="lb-btn lb-next" data-next aria-label="รูปถัดไป">${icon('down')}</button>`;
  document.body.appendChild(box); document.body.style.overflow = 'hidden';
  const img = $('img', box); const cap = $('figcaption', box); const spin = $('.spinner', box);
  async function show() {
    const p = photos[idx];
    img.style.opacity = 0; spin.hidden = false;
    cap.textContent = `${idx + 1} / ${photos.length}${p.caption ? ` — ${p.caption}` : ''}`;
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p.file_path, 600);
    if (photos[idx] !== p) return;
    img.onload = () => { spin.hidden = true; img.style.opacity = 1; };
    img.src = data?.signedUrl || '';
    $('[data-prev]', box).hidden = idx === 0; $('[data-next]', box).hidden = idx === photos.length - 1;
  }
  const close = () => { box.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  const go = (d) => { const n = idx + d; if (n >= 0 && n < photos.length) { idx = n; show(); } };
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === box) close();
    else if (e.target.closest('[data-prev]')) go(-1);
    else if (e.target.closest('[data-next]')) go(1);
  });
  let sx = null;
  box.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); sx = null; });
  show(); $('[data-close]', box).focus();
}

// ============================================================== editor page
export async function renderEditor(view, { id }, _q, { setTitle }) {
  if (!canManage()) { view.innerHTML = `<div class="panel">${emptyState('คุณไม่มีสิทธิ์จัดการกิจกรรม', 'ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์ "จัดการกิจกรรม"', '', 'lock')}</div>`; return; }
  let a = { status: 'published', activity_date: new Date().toISOString().slice(0, 10) };
  let photos = [];
  if (id) {
    const { data, error } = await supabase.from('activities').select('*').eq('id', id).maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!data) { view.innerHTML = `<div class="panel">${emptyState('ไม่พบกิจกรรม', '', '', 'image')}</div>`; return; }
    a = data;
    photos = must(await supabase.from('activity_photos').select('id, file_path, thumb_path, caption, sort_order').eq('activity_id', id).order('sort_order').order('created_at'));
  }
  setTitle(id ? 'แก้ไขกิจกรรม' : 'สร้างอัลบั้มกิจกรรม');
  const departments = await getDepartments();
  const queue = [];   // { file, url }

  view.innerHTML = `
    <div class="page-head"><div class="grow"><a href="${id ? `#/activities/${esc(id)}` : '#/activities'}" class="muted">${id ? 'กลับไปที่อัลบั้ม' : 'กิจกรรม'}</a>
      <h1 style="margin-top:4px">${id ? 'แก้ไขกิจกรรม' : 'สร้างอัลบั้มกิจกรรม'}</h1></div></div>
    <div class="detail-grid">
      <div style="display:flex;flex-direction:column;gap:18px;min-width:0">
        <section class="panel"><div class="panel-body"><form data-f novalidate>
          <div class="field"><label for="a-title">ชื่อกิจกรรม *</label><input id="a-title" name="title" class="input" maxlength="200" value="${esc(a.title || '')}"></div>
          <div class="grid-2">
            <div class="field"><label for="a-date">วันที่จัดกิจกรรม</label><input id="a-date" name="activity_date" type="date" class="input" value="${esc(a.activity_date || '')}"></div>
            <div class="field"><label for="a-loc">สถานที่</label><input id="a-loc" name="location" class="input" maxlength="200" value="${esc(a.location || '')}"></div>
          </div>
          <div class="field"><label for="a-desc">รายละเอียด</label><textarea id="a-desc" name="description" class="input" maxlength="3000">${esc(a.description || '')}</textarea></div>
        </form></div></section>
        <section class="panel"><div class="panel-head"><h2>รูปภาพ</h2><span class="muted" data-count></span></div><div class="panel-body">
          <label class="act-drop" data-drop>
            ${icon('upload')}<b>เลือกรูป หรือลากรูปมาวางที่นี่</b>
            <span class="muted">เลือกได้หลายรูปพร้อมกัน · JPG, PNG, WEBP · ระบบย่อขนาดให้อัตโนมัติ</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-file>
          </label>
          <div class="act-edit-grid" data-grid></div>
        </div></section>
      </div>
      <aside style="display:flex;flex-direction:column;gap:18px">
        <section class="panel"><div class="panel-body">
          <div class="field"><label for="a-status">สถานะ</label><select id="a-status" class="select" form="" data-status>
            <option value="published" ${a.status === 'published' ? 'selected' : ''}>เผยแพร่ (พนักงานทุกคนเห็น)</option>
            <option value="draft" ${a.status === 'draft' ? 'selected' : ''}>ฉบับร่าง (ยังไม่แสดง)</option></select></div>
          <div class="field"><label for="a-dept">แผนกผู้จัด</label><select id="a-dept" class="select" data-dept>${opts(departments, a.department_id, { empty: '— ทั้งบริษัท —' })}</select></div>
        </div></section>
        <div class="btn-stack"><button class="btn btn-primary" data-save>${icon('check')} บันทึก</button>
          <span class="muted" data-progress></span></div>
      </aside>
    </div>`;

  const grid = $('[data-grid]', view);
  function draw() {
    $('[data-count]', view).textContent = `${photos.length + queue.length} รูป`;
    grid.innerHTML = photos.map((p) => `
      <figure class="act-edit-item" data-id="${esc(p.id)}">
        <img data-act="${esc(p.thumb_path)}" alt="" width="200" height="150">
        ${a.cover_photo_id === p.id ? '<span class="chip chip-navy act-cover-chip">ภาพปก</span>' : ''}
        <div class="act-edit-actions">
          ${a.cover_photo_id === p.id ? '' : `<button type="button" class="btn btn-sm" data-cover title="ตั้งเป็นภาพปก">${icon('star')}</button>`}
          <button type="button" class="btn btn-sm btn-danger" data-rm title="ลบรูป">${icon('trash')}</button></div>
        <input class="input act-caption" data-caption placeholder="คำบรรยายภาพ" value="${esc(p.caption || '')}" maxlength="200">
      </figure>`).join('') + queue.map((q, i) => `
      <figure class="act-edit-item pending" data-q="${i}">
        <img src="${esc(q.url)}" alt="" width="200" height="150"><span class="chip act-cover-chip">รออัปโหลด</span>
        <div class="act-edit-actions"><button type="button" class="btn btn-sm" data-unq title="นำออก">${icon('x')}</button></div>
      </figure>`).join('');
    signActivityImages(grid);
  }
  function addFiles(files) {
    for (const f of files) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast(`ไม่รองรับไฟล์ ${f.name} (ใช้ JPG, PNG, WEBP)`, 'error'); continue; }
      if (f.size > MAX_INPUT_MB * 1024 * 1024) { toast(`รูป ${f.name} ใหญ่เกิน ${MAX_INPUT_MB} MB`, 'error'); continue; }
      queue.push({ file: f, url: URL.createObjectURL(f) });
    }
    draw();
  }
  const fileInput = $('[data-file]', view); const drop = $('[data-drop]', view);
  fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(Array.from(e.dataTransfer.files)); });

  grid.addEventListener('click', async (e) => {
    const unq = e.target.closest('[data-unq]');
    if (unq) { const i = Number(unq.closest('[data-q]').dataset.q); URL.revokeObjectURL(queue[i].url); queue.splice(i, 1); draw(); return; }
    const item = e.target.closest('[data-id]'); if (!item) return;
    const p = photos.find((x) => x.id === item.dataset.id);
    if (e.target.closest('[data-cover]')) {
      try { must(await supabase.from('activities').update({ cover_photo_id: p.id }).eq('id', id)); a.cover_photo_id = p.id; draw(); toast('ตั้งเป็นภาพปกแล้ว', 'success'); }
      catch (err) { toastError(err); }
    }
    if (e.target.closest('[data-rm]')) {
      if (!await confirmDialog({ title: 'ลบรูป', message: 'ลบรูปนี้ออกจากอัลบั้ม?', confirmText: 'ลบรูป', danger: true })) return;
      try {
        must(await supabase.from('activity_photos').delete().eq('id', p.id));
        await supabase.storage.from(BUCKET).remove([p.file_path, p.thumb_path]);
        photos = photos.filter((x) => x.id !== p.id);
        const fresh = must(await supabase.from('activities').select('cover_photo_id').eq('id', id).single()); a.cover_photo_id = fresh.cover_photo_id;
        draw(); toast('ลบรูปแล้ว', 'success');
      } catch (err) { toastError(err); }
    }
  });
  grid.addEventListener('change', async (e) => {
    const c = e.target.closest('[data-caption]'); if (!c) return;
    try { must(await supabase.from('activity_photos').update({ caption: c.value.trim() || null }).eq('id', c.closest('[data-id]').dataset.id)); toast('บันทึกคำบรรยายแล้ว', 'success'); }
    catch (err) { toastError(err); }
  });

  $('[data-save]', view).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const f = formData($('[data-f]', view));
    if (!f.title) { toast('กรุณาระบุชื่อกิจกรรม', 'error'); $('#a-title', view).focus(); return; }
    const row = { title: f.title, description: f.description || null, activity_date: f.activity_date || null, location: f.location || null,
      status: $('[data-status]', view).value, department_id: $('[data-dept]', view).value || null };
    const progress = $('[data-progress]', view);
    try {
      let actId = id;
      if (id) must(await supabase.from('activities').update(row).eq('id', id));
      else actId = must(await supabase.from('activities').insert(row).select('id').single()).id;
      let order = photos.length ? Math.max(...photos.map((p) => p.sort_order || 0)) + 1 : 0;
      let failed = 0;
      for (let i = 0; i < queue.length; i++) {
        progress.textContent = `กำลังอัปโหลดรูป ${i + 1} / ${queue.length}…`;
        try { await uploadPhoto(actId, queue[i].file, order++); }
        catch (err) { failed++; console.error(err); toast(`อัปโหลด ${queue[i].file.name} ไม่สำเร็จ`, 'error'); }
      }
      progress.textContent = '';
      toast(failed ? `บันทึกแล้ว (อัปโหลดไม่สำเร็จ ${failed} รูป)` : 'บันทึกกิจกรรมแล้ว', failed ? 'error' : 'success');
      location.hash = `#/activities/${actId}`;
    } catch (err) { progress.textContent = ''; toastError(err); }
  }));
  draw();
}
