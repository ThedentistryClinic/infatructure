// Document Management: list (table/card), detail, upload, versions, preview,
// download, permissions, favorites, approval, soft delete & restore.
import { supabase } from '../supabase.js';
import {
  must, can, me, setting, getCategories, getDepartments, getPeople, nameMaps,
  signedUrl, triggerDownload, getFavoriteIds, setFavorite, logEvent, DOC_ACCESS, DOC_STATUS, PRINCIPAL_LABEL,
} from '../api.js';
import { principalPicker, principalColumns, principalName } from '../components.js';
import { icon } from '../icons.js';
import {
  esc, errMsg, $, $$, modal, confirmDialog, toast, toastError, withLoading, loadingState, emptyState, errorState,
  fmtDate, fmtDateTime, fmtSize, fileExt, fileIcon, safeKey, opts, formData, pager, store, likePattern, debounce,
} from '../ui.js';

const PAGE = 20;
const SELECT_LIST = `id, title, doc_number, doc_type, tags, access_level, status, file_name, file_size, current_version,
  expires_at, created_at, updated_at, deleted_at, department_id, category_id, owner_id,
  departments(name), document_categories(name), updater:profiles!documents_updated_by_fkey(full_name)`;

const MIME_BY_EXT = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};
const PREVIEWABLE = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const VIEWS = [
  ['all', 'ทั้งหมด'], ['recent', 'เพิ่มล่าสุด'], ['updated', 'อัปเดตล่าสุด'], ['mine', 'ของฉัน'],
  ['pending', 'รออนุมัติ'], ['expiring', 'ใกล้หมดอายุ'], ['trash', 'ถังขยะ'],
];

export function accessChip(level) {
  const a = DOC_ACCESS[level] || DOC_ACCESS.department;
  return `<span class="chip ${a.chip}" title="${esc(a.hint)}">${level === 'restricted' ? icon('lock') : ''}${esc(a.label)}</span>`;
}
const statusChip = (s) => (s === 'published' ? '' : `<span class="chip ${DOC_STATUS[s]?.chip || ''}">${esc(DOC_STATUS[s]?.label || s)}</span>`);
function expiryChip(d) {
  if (!d.expires_at) return '';
  const days = Math.round((new Date(d.expires_at) - new Date(today())) / 86400000);
  if (days < 0) return '<span class="chip chip-danger">หมดอายุแล้ว</span>';
  if (days <= Number(setting('documents.expiry_warning_days', 30))) return `<span class="chip chip-warn">หมดอายุใน ${days} วัน</span>`;
  return '';
}

// =============================================================== list page
export async function render(view, _params, query, { setTitle }) {
  setTitle('เอกสาร');
  const st = {
    view: VIEWS.some(([k]) => k === query.view) ? query.view : 'all',
    q: query.q || '', category: query.category || '', department: query.department || '', type: '', tag: '',
    layout: store.get('docs.layout', window.matchMedia('(max-width: 640px)').matches ? 'card' : 'table'), page: 1,
  };
  const [categories, departments] = await Promise.all([getCategories(), getDepartments()]);
  const types = setting('documents.types', []);
  let favs = await getFavoriteIds('document');

  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>ศูนย์รวมเอกสาร</h1><p>เอกสาร นโยบาย และแบบฟอร์มที่คุณมีสิทธิ์เข้าถึง</p></div>
      ${can('documents.upload') ? `<button class="btn btn-primary" data-upload>${icon('upload')} อัปโหลดเอกสาร</button>` : ''}</div>
    <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" data-view="${k}" aria-selected="${st.view === k}">${l}</button>`).join('')}</div>
    <div class="toolbar">
      <input class="input search-input" type="search" data-q placeholder="ค้นหาชื่อ เลขที่เอกสาร รายละเอียด หรือ Tag" value="${esc(st.q)}" aria-label="ค้นหาเอกสาร">
      <select class="select" data-category aria-label="หมวดหมู่">${opts(categories.filter((c) => c.is_active), st.category, { empty: 'ทุกหมวดหมู่' })}</select>
      <select class="select" data-department aria-label="แผนก">${opts(departments, st.department, { empty: 'ทุกแผนก' })}</select>
      <select class="select" data-type aria-label="ประเภท">${opts(types.map((t) => ({ id: t, name: t })), st.type, { empty: 'ทุกประเภท' })}</select>
      <input class="input" data-tag placeholder="Tag" style="max-width:130px" aria-label="Tag">
      <div class="seg" role="group" aria-label="รูปแบบการแสดงผล">
        <button data-layout="table" aria-pressed="${st.layout === 'table'}">${icon('list')} ตาราง</button>
        <button data-layout="card" aria-pressed="${st.layout === 'card'}">${icon('cards')} การ์ด</button></div>
    </div>
    <div data-results></div>`;

  const results = $('[data-results]', view);

  async function load() {
    results.innerHTML = `<div class="panel">${loadingState(6)}</div>`;
    try {
      let q = supabase.from('documents').select(SELECT_LIST, { count: 'exact' });
      if (st.view === 'trash') q = q.not('deleted_at', 'is', null);
      else q = q.is('deleted_at', null).gt('current_version', 0);
      if (st.view === 'pending') q = q.eq('status', 'pending');
      if (st.view === 'mine') q = q.or(`owner_id.eq.${me().id},created_by.eq.${me().id}`);
      if (st.view === 'expiring') q = q.not('expires_at', 'is', null).lte('expires_at', addDays(Number(setting('documents.expiry_warning_days', 30))));
      if (st.q) q = q.ilike('search_text', likePattern(st.q));
      if (st.category) q = q.eq('category_id', st.category);
      if (st.department) q = q.eq('department_id', st.department);
      if (st.type) q = q.eq('doc_type', st.type);
      if (st.tag) q = q.contains('tags', [st.tag]);
      const order = st.view === 'updated' ? 'updated_at' : st.view === 'expiring' ? 'expires_at' : st.view === 'trash' ? 'deleted_at' : 'created_at';
      q = q.order(order, { ascending: st.view === 'expiring' }).range((st.page - 1) * PAGE, st.page * PAGE - 1);
      const { data, count } = must(await q);
      drawResults(data, count || 0);
    } catch (e) {
      results.innerHTML = `<div class="panel">${errorState(e)}</div>`;
      $('[data-retry]', results)?.addEventListener('click', load);
    }
  }

  function drawResults(rows, total) {
    if (!rows.length) {
      const filtered = st.q || st.category || st.department || st.type || st.tag;
      results.innerHTML = `<div class="panel">${emptyState(
        st.view === 'trash' ? 'ถังขยะว่าง' : filtered ? 'ไม่พบเอกสารที่ตรงกับเงื่อนไข' : 'ยังไม่มีเอกสารในมุมมองนี้',
        filtered ? 'ลองเปลี่ยนคำค้นหรือล้างตัวกรอง' : '',
        can('documents.upload') && !filtered && st.view === 'all' ? `<button class="btn btn-primary" data-upload>${icon('upload')} อัปโหลดเอกสารแรก</button>` : '',
        'files')}</div>`;
      $('[data-upload]', results)?.addEventListener('click', () => openUploadModal(load));
      return;
    }
    const favBtn = (d) => `<button class="btn btn-ghost btn-sm btn-icon fav-btn-inline" data-fav="${esc(d.id)}" aria-pressed="${favs.has(d.id)}" aria-label="รายการโปรด" title="รายการโปรด">${icon('star')}</button>`;
    if (st.layout === 'card') {
      results.innerHTML = `<div class="card-grid">${rows.map((d) => `
        <article class="doc-card" data-open="${esc(d.id)}" tabindex="0">
          <div class="top">${fileIcon(d.file_name)}<div style="flex:1;min-width:0"><div class="row-title">${esc(d.title)}</div>
            <div class="cell-sub">${esc(d.doc_number || '')}</div></div>${favBtn(d)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${accessChip(d.access_level)}${statusChip(d.status)}${expiryChip(d)}
            ${d.document_categories ? `<span class="chip">${esc(d.document_categories.name)}</span>` : ''}</div>
          <div class="meta"><span>${esc(d.departments?.name || '-')}</span><span>อัปเดต ${esc(fmtDate(d.updated_at))}</span></div>
        </article>`).join('')}</div><div class="panel" style="margin-top:14px">${pager(st.page, PAGE, total)}</div>`;
    } else {
      results.innerHTML = `<div class="panel"><div class="table-wrap"><table class="table responsive">
        <thead><tr><th>เอกสาร</th><th>หมวดหมู่ / แผนก</th><th>สิทธิ์</th><th>อัปเดตล่าสุด</th><th>ขนาด</th><th></th></tr></thead>
        <tbody>${rows.map((d) => `<tr class="clickable" data-open="${esc(d.id)}">
          <td data-label="เอกสาร"><div style="display:flex;gap:12px;align-items:center">${fileIcon(d.file_name)}<div>
            <div class="cell-title">${esc(d.title)}</div>
            <div class="cell-sub">${esc([d.doc_number, d.doc_type, d.current_version ? 'v' + d.current_version : ''].filter(Boolean).join(' · '))}</div></div></div></td>
          <td data-label="หมวดหมู่ / แผนก"><div>${esc(d.document_categories?.name || '-')}</div><div class="cell-sub">${esc(d.departments?.name || '-')}</div></td>
          <td data-label="สิทธิ์"><div style="display:flex;gap:4px;flex-wrap:wrap">${accessChip(d.access_level)}${statusChip(d.status)}${expiryChip(d)}</div></td>
          <td data-label="อัปเดตล่าสุด"><div>${esc(fmtDate(d.updated_at))}</div><div class="cell-sub">${esc(d.updater?.full_name || '')}</div></td>
          <td data-label="ขนาด">${esc(fmtSize(d.file_size))}</td>
          <td class="actions">${favBtn(d)}</td></tr>`).join('')}</tbody></table></div>${pager(st.page, PAGE, total)}</div>`;
    }
  }

  results.addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      const on = fav.getAttribute('aria-pressed') !== 'true';
      try { await setFavorite('document', fav.dataset.fav, on); fav.setAttribute('aria-pressed', String(on)); on ? favs.add(fav.dataset.fav) : favs.delete(fav.dataset.fav); toast(on ? 'เพิ่มในรายการโปรดแล้ว' : 'นำออกจากรายการโปรดแล้ว', 'success'); }
      catch (err) { toastError(err); }
      return;
    }
    const pg = e.target.closest('[data-page]');
    if (pg) { st.page = Number(pg.dataset.page); load(); return; }
    const row = e.target.closest('[data-open]');
    if (row) location.hash = `#/documents/${row.dataset.open}`;
  });
  results.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-open]')) location.hash = `#/documents/${e.target.dataset.open}`; });

  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => {
    st.view = b.dataset.view; st.page = 1;
    $$('[data-view]', view).forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    load();
  }));
  $$('[data-layout]', view).forEach((b) => b.addEventListener('click', () => {
    st.layout = b.dataset.layout; store.set('docs.layout', st.layout);
    $$('[data-layout]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  }));
  const refilter = () => { st.page = 1; load(); };
  $('[data-q]', view).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); refilter(); }, 350));
  $('[data-tag]', view).addEventListener('input', debounce((e) => { st.tag = e.target.value.trim(); refilter(); }, 350));
  $('[data-category]', view).addEventListener('change', (e) => { st.category = e.target.value; refilter(); });
  $('[data-department]', view).addEventListener('change', (e) => { st.department = e.target.value; refilter(); });
  $('[data-type]', view).addEventListener('change', (e) => { st.type = e.target.value; refilter(); });
  $('[data-upload]', view)?.addEventListener('click', () => openUploadModal(load));
  await load();
}

// ============================================================ detail page
export async function renderDetail(view, { id }, _q, { setTitle }) {
  view.innerHTML = `<div class="panel">${loadingState(8)}</div>`;
  const { data: doc, error } = await supabase.from('documents').select(`*, departments(name), document_categories(name),
      owner:profiles!documents_owner_id_fkey(full_name, email), creator:profiles!documents_created_by_fkey(full_name),
      updater:profiles!documents_updated_by_fkey(full_name), reviewer:profiles!documents_reviewed_by_fkey(full_name)`)
    .eq('id', id).maybeSingle();
  if (error && error.code !== '22P02') throw error;
  if (!doc) {
    // Same message whether the document does not exist or is not permitted.
    setTitle('ไม่พบเอกสาร');
    view.innerHTML = `<div class="panel">${emptyState('ไม่พบเอกสาร หรือคุณไม่มีสิทธิ์เข้าถึง', 'หากคิดว่าควรเข้าถึงได้ กรุณาติดต่อเจ้าของเอกสารหรือผู้จัดการแผนก', '<a class="btn" href="#/documents">กลับไปหน้าเอกสาร</a>', 'lock')}</div>`;
    return;
  }
  setTitle(doc.title);
  const [rights, versions, favs] = await Promise.all([
    supabase.rpc('my_document_rights', { p_document_id: id }).then(must),
    supabase.from('document_versions').select('id, version_no, file_name, file_path, file_size, change_note, created_at, profiles!document_versions_created_by_fkey(full_name)')
      .eq('document_id', id).order('version_no', { ascending: false }).then(must),
    getFavoriteIds('document'),
  ]);
  const r = rights || {};
  const ext = fileExt(doc.file_name);
  const deleted = !!doc.deleted_at;
  const reload = () => { const fresh = document.createElement('div'); view.replaceWith(fresh); return renderDetail(fresh, { id }, _q, { setTitle }); };

  const notices = [];
  if (deleted) notices.push(`<div class="notice notice-danger">${icon('trash')}<div>เอกสารนี้อยู่ในถังขยะตั้งแต่ ${esc(fmtDateTime(doc.deleted_at))}</div></div>`);
  if (doc.status === 'pending') notices.push(`<div class="notice notice-warn">${icon('clock')}<div>เอกสารรออนุมัติ ยังไม่แสดงให้ผู้ใช้อื่นเห็น</div></div>`);
  if (doc.status === 'rejected') notices.push(`<div class="notice notice-danger">${icon('alert')}<div>ไม่อนุมัติ${doc.review_note ? `: ${esc(doc.review_note)}` : ''} — อัปโหลดเวอร์ชันใหม่เพื่อส่งอนุมัติอีกครั้ง</div></div>`);
  const exp = expiryChip(doc);
  if (exp && !deleted) notices.push(`<div class="notice notice-warn">${icon('clock')}<div>เอกสารนี้${doc.expires_at < today() ? 'หมดอายุแล้ว' : 'ใกล้หมดอายุ'} (${esc(fmtDate(doc.expires_at))})${r.edit ? ' กรุณาทบทวนหรืออัปโหลดฉบับใหม่' : ''}</div></div>`);
  if (doc.status === 'draft' && !doc.current_version) notices.push(`<div class="notice notice-info">${icon('info')}<div>ยังไม่มีไฟล์ในเอกสารนี้</div></div>`);

  view.innerHTML = `
    <div class="page-head"><div class="grow">
      <a href="#/documents" class="muted">เอกสาร</a>
      <h1 style="margin-top:4px">${esc(doc.title)}</h1>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${accessChip(doc.access_level)}${statusChip(doc.status)}
        ${doc.current_version ? `<span class="chip">เวอร์ชัน ${doc.current_version}</span>` : ''}${(doc.tags || []).map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>
    </div>
    <button class="btn" data-fav aria-pressed="${favs.has(id)}">${icon('star')} ${favs.has(id) ? 'อยู่ในรายการโปรด' : 'เพิ่มในรายการโปรด'}</button></div>
    ${notices.join('')}
    <div class="detail-grid">
      <div style="display:flex;flex-direction:column;gap:22px;min-width:0">
        <section class="panel"><div class="panel-head"><h2>รายละเอียด</h2></div><div class="panel-body">
          ${doc.description ? `<p style="white-space:pre-wrap">${esc(doc.description)}</p>` : '<p class="muted">ไม่มีคำอธิบาย</p>'}
          <dl class="meta-list" style="margin-top:14px">
            <dt>เลขที่เอกสาร</dt><dd>${esc(doc.doc_number || '-')}</dd>
            <dt>ประเภท</dt><dd>${esc(doc.doc_type || '-')}</dd>
            <dt>หมวดหมู่</dt><dd>${esc(doc.document_categories?.name || '-')}</dd>
            <dt>แผนก</dt><dd>${esc(doc.departments?.name || '-')}</dd>
            <dt>เจ้าของเอกสาร</dt><dd>${esc(doc.owner?.full_name || '-')}</dd>
            <dt>ไฟล์</dt><dd>${esc(doc.file_name || '-')} ${doc.file_size ? `<span class="muted">(${esc(fmtSize(doc.file_size))})</span>` : ''}</dd>
            <dt>วันที่อัปโหลด</dt><dd>${esc(fmtDateTime(doc.created_at))} โดย ${esc(doc.creator?.full_name || '-')}</dd>
            <dt>แก้ไขล่าสุด</dt><dd>${esc(fmtDateTime(doc.updated_at))} โดย ${esc(doc.updater?.full_name || '-')}</dd>
            <dt>วันที่มีผล</dt><dd>${esc(fmtDate(doc.effective_date))}</dd>
            <dt>วันหมดอายุ</dt><dd>${esc(fmtDate(doc.expires_at))}</dd>
            ${doc.reviewed_at ? `<dt>ผู้พิจารณา</dt><dd>${esc(doc.reviewer?.full_name || '-')} (${esc(fmtDateTime(doc.reviewed_at))})</dd>` : ''}
          </dl></div></section>
        <section class="panel"><div class="panel-head"><h2>ประวัติเวอร์ชัน</h2>
          ${r.upload && !deleted ? `<button class="btn btn-sm" data-newver>${icon('upload')} อัปโหลดเวอร์ชันใหม่</button>` : ''}</div>
          <div class="panel-body flush">${versions.length ? `<div class="table-wrap"><table class="table responsive">
            <thead><tr><th>เวอร์ชัน</th><th>ไฟล์</th><th>หมายเหตุ</th><th>โดย / วันที่</th><th></th></tr></thead><tbody>
            ${versions.map((v) => `<tr><td data-label="เวอร์ชัน"><b>v${v.version_no}</b>${v.version_no === doc.current_version ? ' <span class="chip chip-navy">ปัจจุบัน</span>' : ''}</td>
              <td data-label="ไฟล์">${esc(v.file_name)}<div class="cell-sub">${esc(fmtSize(v.file_size))}</div></td>
              <td data-label="หมายเหตุ">${esc(v.change_note || '-')}</td>
              <td data-label="โดย / วันที่">${esc(v.profiles?.full_name || '-')}<div class="cell-sub">${esc(fmtDateTime(v.created_at))}</div></td>
              <td class="actions">${r.download ? `<button class="btn btn-sm" data-dlver="${esc(v.id)}">${icon('download')} ดาวน์โหลด</button>` : ''}</td></tr>`).join('')}
            </tbody></table></div>` : emptyState('ยังไม่มีเวอร์ชัน', '', '', 'history', true)}</div></section>
      </div>
      <aside class="panel"><div class="panel-head"><h3>การดำเนินการ</h3></div><div class="panel-body"><div class="btn-stack">
        ${doc.current_version && PREVIEWABLE.includes(ext) ? `<button class="btn btn-accent" data-preview>${icon('eye')} ดูตัวอย่าง</button>` : ''}
        ${doc.current_version && r.download ? `<button class="btn ${PREVIEWABLE.includes(ext) ? '' : 'btn-accent'}" data-download>${icon('download')} ดาวน์โหลด</button>` : ''}
        ${doc.current_version && !r.download ? '<p class="muted">คุณมีสิทธิ์ดูอย่างเดียว ไม่สามารถดาวน์โหลดได้</p>' : ''}
        ${r.approve && doc.created_by !== me().id ? `<button class="btn btn-primary" data-approve>${icon('check')} อนุมัติ</button><button class="btn btn-danger" data-reject>ไม่อนุมัติ</button>` : ''}
        ${r.edit && !deleted ? `<button class="btn" data-edit>${icon('edit')} แก้ไขข้อมูลเอกสาร</button>` : ''}
        ${r.share && !deleted ? `<button class="btn" data-perms>${icon('key')} จัดการสิทธิ์การเข้าถึง</button>` : ''}
        ${r.delete && !deleted ? `<button class="btn btn-danger" data-delete>${icon('trash')} ย้ายไปถังขยะ</button>` : ''}
        ${r.delete && deleted ? `<button class="btn btn-primary" data-restore>${icon('restore')} กู้คืนเอกสาร</button>` : ''}
        ${deleted && can('documents.manage_all') ? `<button class="btn btn-danger" data-purge>${icon('trash')} ลบถาวร</button>` : ''}
      </div>
      <p class="muted" style="margin-top:16px">${esc(DOC_ACCESS[doc.access_level]?.hint || '')}</p></div></aside>
    </div>`;

  const on = (sel, fn) => $(sel, view)?.addEventListener('click', (e) => fn(e.currentTarget));
  on('[data-fav]', async (b) => {
    const now = b.getAttribute('aria-pressed') !== 'true';
    try { await setFavorite('document', id, now); b.setAttribute('aria-pressed', String(now)); b.innerHTML = `${icon('star')} ${now ? 'อยู่ในรายการโปรด' : 'เพิ่มในรายการโปรด'}`; }
    catch (e) { toastError(e); }
  });
  on('[data-preview]', (b) => withLoading(b, () => previewDocument(doc, r)));
  on('[data-download]', (b) => withLoading(b, () => downloadFile(doc.id, doc.file_path, doc.file_name)));
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dlver]'); if (!b) return;
    const v = versions.find((x) => x.id === b.dataset.dlver);
    withLoading(b, () => downloadFile(doc.id, v.file_path, v.file_name, v.version_no));
  });
  on('[data-newver]', () => openVersionModal(doc, reload));
  on('[data-edit]', () => openEditModal(doc, r, reload));
  on('[data-perms]', () => openPermissionsModal(doc));
  on('[data-delete]', async () => {
    const reason = await confirmDialog({ title: 'ย้ายเอกสารไปถังขยะ', message: `ย้าย "${doc.title}" ไปถังขยะ? ผู้มีสิทธิ์ลบสามารถกู้คืนได้ภายหลัง`, confirmText: 'ย้ายไปถังขยะ', danger: true, input: 'เหตุผล (ไม่บังคับ)' });
    if (reason === false) return;
    try { must(await supabase.rpc('soft_delete_document', { p_document_id: id, p_reason: reason || null })); toast('ย้ายไปถังขยะแล้ว', 'success'); reload(); }
    catch (e) { toastError(e); }
  });
  on('[data-restore]', async (b) => withLoading(b, async () => {
    try { must(await supabase.rpc('restore_document', { p_document_id: id })); toast('กู้คืนเอกสารแล้ว', 'success'); reload(); }
    catch (e) { toastError(e); }
  }));
  on('[data-purge]', async () => {
    if (!await confirmDialog({ title: 'ลบถาวร', message: 'ลบเอกสารนี้และไฟล์ทุกเวอร์ชันออกจากระบบอย่างถาวร ไม่สามารถกู้คืนได้', confirmText: 'ลบถาวร', danger: true })) return;
    try {
      const paths = versions.map((v) => v.file_path);
      if (paths.length) { const { error: rmErr } = await supabase.storage.from('documents').remove(paths); if (rmErr) throw rmErr; }
      must(await supabase.from('documents').delete().eq('id', id));
      toast('ลบถาวรแล้ว', 'success'); location.hash = '#/documents?view=trash';
    }
    catch (e) { toastError(e); }
  });
  const review = async (approve) => {
    const note = await confirmDialog({ title: approve ? 'อนุมัติเอกสาร' : 'ไม่อนุมัติเอกสาร', message: approve ? 'เอกสารจะเผยแพร่ตามสิทธิ์ที่กำหนดทันที' : 'ผู้อัปโหลดจะเห็นเหตุผลและอัปโหลดฉบับแก้ไขได้', confirmText: approve ? 'อนุมัติ' : 'ไม่อนุมัติ', danger: !approve, input: 'หมายเหตุ' });
    if (note === false) return;
    try { must(await supabase.rpc('review_document', { p_document_id: id, p_approve: approve, p_note: note || null })); toast(approve ? 'อนุมัติแล้ว' : 'บันทึกการไม่อนุมัติแล้ว', 'success'); reload(); }
    catch (e) { toastError(e); }
  };
  on('[data-approve]', () => review(true));
  on('[data-reject]', () => review(false));
}

// ================================================================ actions
async function downloadFile(docId, path, name, version = null) {
  try {
    const url = await signedUrl('documents', path, name || true);
    await logEvent('document.download', 'documents', docId, { file: name, version }); // before navigation starts
    triggerDownload(url);
  } catch (e) { toastError(e); }
}

async function previewDocument(doc, rights) {
  let url;
  try { url = await signedUrl('documents', doc.file_path); } catch (e) { toastError(e); return; }
  await logEvent('document.preview', 'documents', doc.id, { file: doc.file_name });
  const ext = fileExt(doc.file_name);
  const body = ext === 'pdf'
    ? `<iframe class="preview-frame" src="${esc(url)}#toolbar=${rights.download ? 1 : 0}" title="${esc(doc.title)}"></iframe>`
    : `<img class="preview-img" src="${esc(url)}" alt="${esc(doc.title)}">`;
  const m = modal({
    title: doc.title, size: 'xl', body,
    footer: `<span class="muted" style="margin-right:auto">ลิงก์ตัวอย่างมีอายุจำกัดและใช้ได้เฉพาะผู้มีสิทธิ์</span>
      ${rights.download ? `<button class="btn" data-dl>${icon('download')} ดาวน์โหลด</button>` : ''}<button class="btn btn-primary" data-close>ปิด</button>`,
  });
  $('[data-dl]', m.el)?.addEventListener('click', () => downloadFile(doc.id, doc.file_path, doc.file_name));
}

function validateFile(file) {
  if (!file) return 'กรุณาเลือกไฟล์';
  const allowed = setting('documents.allowed_extensions', Object.keys(MIME_BY_EXT));
  const ext = fileExt(file.name);
  if (!allowed.includes(ext)) return `ไม่รองรับไฟล์ .${ext || '?'} (รองรับ: ${allowed.join(', ')})`;
  const maxMb = Number(setting('documents.max_file_mb', 50));
  if (file.size > maxMb * 1024 * 1024) return `ไฟล์ใหญ่เกิน ${maxMb} MB`;
  if (file.size === 0) return 'ไฟล์ว่างเปล่า';
  return null;
}

async function uploadVersion(docId, file, note, versionHint) {
  const path = `${docId}/v${versionHint}-${Date.now()}-${safeKey(file.name)}`;
  const contentType = MIME_BY_EXT[fileExt(file.name)] || file.type || 'application/octet-stream';
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file, { contentType, upsert: false, cacheControl: '0' });
  if (upErr) throw upErr;
  return must(await supabase.rpc('add_document_version', {
    p_document_id: docId, p_file_path: path, p_file_name: file.name, p_change_note: note || null,
  }));
}

async function docFormHtml(doc, { canShare, isNew }) {
  const [categories, departments, people] = await Promise.all([getCategories(), getDepartments(), canShare ? getPeople() : []]);
  const anyDept = can('documents.upload_any_department');
  const myDept = me().department_id;
  const deptVal = doc.department_id ?? myDept;
  const deptOptions = anyDept ? departments.filter((d) => d.is_active || d.id === deptVal) : departments.filter((d) => d.id === deptVal || d.id === myDept);
  const types = setting('documents.types', []);
  const accessOpts = Object.entries(DOC_ACCESS).map(([k, v]) => `<option value="${k}" ${k === (doc.access_level || 'department') ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  return `
    <div class="field"><label for="f-title">ชื่อเอกสาร *</label><input id="f-title" name="title" class="input" required maxlength="300" value="${esc(doc.title || '')}"></div>
    <div class="grid-2">
      <div class="field"><label for="f-no">เลขที่เอกสาร</label><input id="f-no" name="doc_number" class="input" maxlength="80" value="${esc(doc.doc_number || '')}"></div>
      <div class="field"><label for="f-type">ประเภทเอกสาร</label><select id="f-type" name="doc_type" class="select">${opts(types.map((t) => ({ id: t, name: t })), doc.doc_type, { empty: '— เลือก —' })}</select></div>
      <div class="field"><label for="f-cat">หมวดหมู่</label><select id="f-cat" name="category_id" class="select">${opts(categories.filter((c) => c.is_active || c.id === doc.category_id), doc.category_id, { empty: '— เลือก —' })}</select></div>
      <div class="field"><label for="f-dept">แผนกที่รับผิดชอบ *</label><select id="f-dept" name="department_id" class="select" ${!anyDept && !isNew ? 'disabled' : ''}>${opts(deptOptions, deptVal, { empty: deptOptions.length ? null : '— ไม่มีแผนก —' })}</select>
        ${!myDept && !anyDept ? '<span class="hint" style="color:var(--urgent)">บัญชีของคุณยังไม่ได้กำหนดแผนก กรุณาติดต่อผู้ดูแลระบบ</span>' : ''}</div>
    </div>
    <div class="field"><label for="f-desc">รายละเอียด</label><textarea id="f-desc" name="description" class="input" maxlength="4000">${esc(doc.description || '')}</textarea></div>
    <div class="field"><label for="f-tags">Tag</label><input id="f-tags" name="tags" class="input" placeholder="คั่นด้วยเครื่องหมายจุลภาค เช่น hr, สวัสดิการ" value="${esc((doc.tags || []).join(', '))}"></div>
    <div class="grid-2">
      <div class="field"><label for="f-eff">วันที่มีผล</label><input id="f-eff" name="effective_date" type="date" class="input" value="${esc(doc.effective_date || '')}"></div>
      <div class="field"><label for="f-exp">วันหมดอายุ</label><input id="f-exp" name="expires_at" type="date" class="input" value="${esc(doc.expires_at || '')}"></div>
    </div>
    ${canShare ? `<div class="grid-2">
      <div class="field"><label for="f-access">ระดับสิทธิ์การเข้าถึง *</label><select id="f-access" name="access_level" class="select">${accessOpts}</select>
        <span class="hint" data-access-hint>${esc(DOC_ACCESS[doc.access_level || 'department'].hint)}</span></div>
      ${isNew ? '' : `<div class="field"><label for="f-owner">เจ้าของเอกสาร</label><select id="f-owner" name="owner_id" class="select">${opts(people, doc.owner_id, { label: (p) => p.full_name || p.email })}</select></div>`}
    </div>` : ''}`;
}

function readDocForm(form) {
  const f = formData(form);
  const out = {
    title: f.title, doc_number: f.doc_number || null, doc_type: f.doc_type || null, category_id: f.category_id || null,
    description: f.description || null, effective_date: f.effective_date || null, expires_at: f.expires_at || null,
    tags: (f.tags || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 20),
  };
  if ('department_id' in f) out.department_id = f.department_id || null;
  if ('access_level' in f) out.access_level = f.access_level;
  if ('owner_id' in f && f.owner_id) out.owner_id = f.owner_id;
  return out;
}
function bindAccessHint(root) {
  const sel = $('[name=access_level]', root); const hint = $('[data-access-hint]', root);
  sel?.addEventListener('change', () => { hint.textContent = DOC_ACCESS[sel.value].hint; });
}

export async function openUploadModal(onDone) {
  const m = modal({
    title: 'อัปโหลดเอกสาร', size: 'lg',
    body: `<form data-f novalidate>${await docFormHtml({}, { canShare: true, isNew: true })}
      <div class="field"><label for="f-file">ไฟล์ *</label><input id="f-file" name="file" type="file" class="input"
        accept="${esc(setting('documents.allowed_extensions', []).map((x) => '.' + x).join(','))}">
        <span class="hint">รองรับ ${esc(setting('documents.allowed_extensions', []).join(', '))} · ไม่เกิน ${esc(setting('documents.max_file_mb', 50))} MB</span></div>
      <div data-err></div></form>`,
    footer: `<button class="btn" data-close>ยกเลิก</button><button class="btn btn-primary" data-save>${icon('upload')} อัปโหลด</button>`,
  });
  bindAccessHint(m.el);
  $('[data-save]', m.el).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const form = $('[data-f]', m.el); const errEl = $('[data-err]', m.el);
    const data = readDocForm(form); const file = $('#f-file', m.el).files[0];
    const problem = !data.title ? 'กรุณาระบุชื่อเอกสาร' : !data.department_id ? 'กรุณาเลือกแผนก' : validateFile(file);
    if (problem) { errEl.innerHTML = `<div class="notice notice-danger">${icon('alert')}<div>${esc(problem)}</div></div>`; return; }
    let created = null;
    try {
      created = must(await supabase.from('documents').insert(data).select('id, title, access_level').single());
      await uploadVersion(created.id, file, 'ฉบับแรก', 1);
      m.close();
      toast('อัปโหลดเอกสารแล้ว', 'success');
      if (['specific', 'restricted'].includes(created.access_level)) {
        toast('กำหนดผู้มีสิทธิ์เข้าถึงเอกสารนี้ต่อได้เลย', 'info');
        location.hash = `#/documents/${created.id}`;
        setTimeout(() => openPermissionsModal(created), 600);
      } else onDone?.();
    } catch (err) {
      if (created) await supabase.rpc('discard_document_draft', { p_document_id: created.id });
      errEl.innerHTML = `<div class="notice notice-danger">${icon('alert')}<div>อัปโหลดไม่สำเร็จ: ${esc(errMsg(err))}</div></div>`;
    }
  }));
}

function openVersionModal(doc, onDone) {
  const m = modal({
    title: `อัปโหลดเวอร์ชันใหม่ — ${doc.title}`,
    body: `<div class="field"><label for="v-file">ไฟล์ *</label><input id="v-file" type="file" class="input"></div>
      <div class="field"><label for="v-note">สิ่งที่เปลี่ยนแปลง</label><textarea id="v-note" class="input" maxlength="1000"></textarea></div><div data-err></div>`,
    footer: `<button class="btn" data-close>ยกเลิก</button><button class="btn btn-primary" data-save>${icon('upload')} อัปโหลดเวอร์ชันใหม่</button>`,
  });
  $('[data-save]', m.el).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const file = $('#v-file', m.el).files[0]; const problem = validateFile(file);
    if (problem) { $('[data-err]', m.el).innerHTML = `<div class="notice notice-danger">${icon('alert')}<div>${esc(problem)}</div></div>`; return; }
    try { const v = await uploadVersion(doc.id, file, $('#v-note', m.el).value.trim(), doc.current_version + 1); m.close(); toast(`อัปโหลดเวอร์ชัน ${v} แล้ว`, 'success'); onDone(); }
    catch (err) { toastError(err); }
  }));
}

async function openEditModal(doc, rights, onDone) {
  const m = modal({
    title: 'แก้ไขข้อมูลเอกสาร', size: 'lg',
    body: `<form data-f novalidate>${await docFormHtml(doc, { canShare: rights.share, isNew: false })}</form>`,
    footer: `<button class="btn" data-close>ยกเลิก</button><button class="btn btn-primary" data-save>บันทึกการแก้ไข</button>`,
  });
  bindAccessHint(m.el);
  $('[data-save]', m.el).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const data = readDocForm($('[data-f]', m.el));
    if (!data.title) { toast('กรุณาระบุชื่อเอกสาร', 'error'); return; }
    if (data.department_id === doc.department_id) delete data.department_id;
    try {
      const rows = must(await supabase.from('documents').update(data).eq('id', doc.id).select('id'));
      if (!rows.length) throw new Error('คุณไม่มีสิทธิ์แก้ไขเอกสารนี้');
      m.close(); toast('บันทึกการแก้ไขแล้ว', 'success'); onDone();
    } catch (err) { toastError(err); }
  }));
}

/** Permission editor for one document (also used by Admin → Document Access Control). */
export async function openPermissionsModal(doc) {
  const restricted = doc.access_level === 'restricted';
  const m = modal({
    title: `สิทธิ์การเข้าถึง — ${doc.title}`, size: 'lg',
    body: `<div class="notice notice-info">${icon('info')}<div><b>${esc(DOC_ACCESS[doc.access_level].label)}</b>: ${esc(DOC_ACCESS[doc.access_level].hint)}
        ${restricted ? '<br>เอกสารระดับนี้ให้สิทธิ์ได้เฉพาะรายบุคคลเท่านั้น' : ''}</div></div>
      <div data-list>${loadingState(3)}</div>
      <h3 style="margin:20px 0 10px">เพิ่มสิทธิ์</h3>
      <div data-picker></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
        ${['view', 'download', 'upload', 'edit', 'delete'].map((f) => `<label class="check"><input type="checkbox" data-flag="${f}" ${f === 'view' ? 'checked' : ''}> ${FLAG_LABEL[f]}</label>`).join('')}
      </div>
      <button class="btn btn-primary" data-add>${icon('plus')} เพิ่มสิทธิ์</button>`,
    footer: '<button class="btn btn-primary" data-close>เสร็จสิ้น</button>',
  });
  const picker = await principalPicker($('[data-picker]', m.el), restricted ? ['user'] : ['user', 'group', 'department', 'role']);
  const listEl = $('[data-list]', m.el);

  async function draw() {
    try {
      const [rows, maps] = await Promise.all([
        supabase.from('document_permissions').select('*').eq('document_id', doc.id).order('created_at').then(must), nameMaps(),
      ]);
      if (!rows.length) { listEl.innerHTML = emptyState('ยังไม่มีสิทธิ์เพิ่มเติม', restricted ? 'ตอนนี้มีเพียงเจ้าของเอกสารที่เข้าถึงได้' : '', '', 'key', true); return; }
      listEl.innerHTML = `<div class="table-wrap"><table class="table responsive"><thead><tr><th>ผู้ได้รับสิทธิ์</th>
        ${['view', 'download', 'upload', 'edit', 'delete'].map((f) => `<th>${FLAG_LABEL[f]}</th>`).join('')}<th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr data-row="${esc(r.id)}"><td data-label="ผู้ได้รับสิทธิ์"><span class="chip">${esc(PRINCIPAL_LABEL[r.principal_type])}</span> ${esc(principalName(r, maps))}
          ${restricted && r.principal_type !== 'user' ? '<div class="cell-sub" style="color:var(--urgent)">ไม่มีผลกับเอกสารจำกัดสิทธิ์</div>' : ''}</td>
          ${['view', 'download', 'upload', 'edit', 'delete'].map((f) => `<td data-label="${FLAG_LABEL[f]}"><input type="checkbox" aria-label="${FLAG_LABEL[f]}" data-toggle="${f}" ${r['can_' + f] ? 'checked' : ''}></td>`).join('')}
          <td class="actions"><button class="btn btn-sm btn-danger" data-remove aria-label="ลบสิทธิ์">${icon('trash')}</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } catch (e) { listEl.innerHTML = errorState(e, false); }
  }
  listEl.addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-toggle]'); if (!cb) return;
    const id = cb.closest('[data-row]').dataset.row;
    try { must(await supabase.from('document_permissions').update({ ['can_' + cb.dataset.toggle]: cb.checked }).eq('id', id)); toast('อัปเดตสิทธิ์แล้ว', 'success'); }
    catch (err) { cb.checked = !cb.checked; toastError(err); }
  });
  listEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]'); if (!b) return;
    try { must(await supabase.from('document_permissions').delete().eq('id', b.closest('[data-row]').dataset.row)); toast('ลบสิทธิ์แล้ว', 'success'); draw(); }
    catch (err) { toastError(err); }
  });
  $('[data-add]', m.el).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    const p = picker.get(); if (!p) { toast('กรุณาเลือกผู้ได้รับสิทธิ์', 'error'); return; }
    const flags = Object.fromEntries($$('[data-flag]', m.el).map((c) => ['can_' + c.dataset.flag, c.checked]));
    if (!Object.values(flags).some(Boolean)) { toast('กรุณาเลือกสิทธิ์อย่างน้อย 1 รายการ', 'error'); return; }
    try { must(await supabase.from('document_permissions').insert({ document_id: doc.id, ...principalColumns(p.type, p.id), ...flags })); toast('เพิ่มสิทธิ์แล้ว', 'success'); draw(); }
    catch (err) { toastError(err); }
  }));
  draw();
}
const FLAG_LABEL = { view: 'ดู', download: 'ดาวน์โหลด', upload: 'อัปโหลดเวอร์ชัน', edit: 'แก้ไข', delete: 'ลบ' };
