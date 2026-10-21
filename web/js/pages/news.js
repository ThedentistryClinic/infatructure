// Company News & Announcements: list, detail (read tracking), editor, admin tab.
import { supabase } from '../supabase.js';
import {
  must, can, me, setting, getDepartments, nameMaps, signedUrl, triggerDownload, logEvent, hydrateNewsImages, newsImagePaths,
  getFavoriteIds, setFavorite, NEWS_CATEGORY, NEWS_PRIORITY, PRINCIPAL_LABEL,
} from '../api.js';
import { principalPicker, principalColumns, principalId } from '../components.js';
import { icon } from '../icons.js';
import { createEditor } from '../editor.js';
import {
  esc, $, modal, confirmDialog, toast, toastError, withLoading, loadingState, emptyState, errorState, sanitizeHtml,
  fmtDate, fmtDateTime, fmtRelative, fmtSize, fileExt, fileIcon, safeKey, opts, formData, pager, likePattern, debounce,
  toLocalInput, fromLocalInput,
} from '../ui.js';

const PAGE = 15;
const NEWS_MAX_MB = 20;
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const ATTACH_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', ...IMAGE_EXT];

export function newsBadges(n) {
  const out = [];
  if (n.is_pinned) out.push(`<span class="pinned-mark" title="ปักหมุด">${icon('pin')}</span>`);
  if (n.priority === 'urgent' || n.category === 'urgent') out.push('<span class="chip chip-urgent">ด่วน</span>');
  else if (n.priority === 'important') out.push('<span class="chip chip-important">สำคัญ</span>');
  const days = Number(setting('news.new_badge_days', 3));
  if (n.publish_at && Date.now() - new Date(n.publish_at).getTime() < days * 86400000) out.push('<span class="chip chip-new">ใหม่</span>');
  out.push(`<span class="chip">${esc(NEWS_CATEGORY[n.category] || n.category)}</span>`);
  return out.join('');
}

const canAuthor = () => can('news.manage') || can('news.create');
const canEditItem = (n) => can('news.manage') || (can('news.create') && n.created_by === me().id);

function lifecycle(n) {
  const now = Date.now();
  if (n.status === 'draft') return ['ฉบับร่าง', ''];
  if (n.status === 'archived') return ['เก็บถาวร', ''];
  if (n.publish_at && new Date(n.publish_at).getTime() > now) return [`ตั้งเวลา ${fmtDateTime(n.publish_at)}`, 'chip-warn'];
  if (n.expire_at && new Date(n.expire_at).getTime() <= now) return ['สิ้นสุดการแสดงผล', ''];
  return ['เผยแพร่อยู่', 'chip-ok'];
}

// ================================================================ list
export async function render(view, _p, query, { setTitle }) {
  setTitle('ข่าวสาร');
  const st = { q: query.q || '', category: query.category || '', archive: false, page: 1 };
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>ข่าวสารและประกาศ</h1><p>ข่าวที่ส่งถึงคุณ เรียงจากข่าวปักหมุดและล่าสุด</p></div>
      ${canAuthor() ? `<a class="btn btn-primary" href="#/news/new">${icon('plus')} สร้างข่าว</a>` : ''}</div>
    <div class="toolbar">
      <input class="input search-input" type="search" data-q placeholder="ค้นหาข่าว" value="${esc(st.q)}" aria-label="ค้นหาข่าว">
      <select class="select" data-cat aria-label="ประเภทข่าว">${opts(Object.entries(NEWS_CATEGORY).map(([id, name]) => ({ id, name })), st.category, { empty: 'ทุกประเภท' })}</select>
      <label class="check"><input type="checkbox" data-archive> รวมข่าวที่สิ้นสุดการแสดงผลแล้ว</label>
    </div>
    <div class="panel" data-list>${loadingState(6)}</div>`;
  const listEl = $('[data-list]', view);

  async function load() {
    listEl.innerHTML = loadingState(6);
    try {
      const nowIso = new Date().toISOString();
      let q = supabase.from('news').select('id, title, summary, category, priority, is_pinned, publish_at, expire_at, track_reads, created_by, author:profiles!news_created_by_fkey(full_name)', { count: 'exact' })
        .eq('status', 'published').lte('publish_at', nowIso);
      if (!st.archive) q = q.or(`expire_at.is.null,expire_at.gt.${nowIso}`);
      if (st.category) q = q.eq('category', st.category);
      if (st.q) q = q.ilike('search_text', likePattern(st.q));
      const { data, count } = must(await q.order('is_pinned', { ascending: false }).order('publish_at', { ascending: false })
        .range((st.page - 1) * PAGE, st.page * PAGE - 1));
      if (!data.length) { listEl.innerHTML = emptyState(st.q || st.category ? 'ไม่พบข่าวที่ค้นหา' : 'ยังไม่มีข่าวสาร', '', '', 'news'); return; }
      const ids = data.map((n) => n.id);
      const [reads, counts] = await Promise.all([
        supabase.from('news_reads').select('news_id').eq('user_id', me().id).in('news_id', ids).then(must),
        supabase.rpc('news_read_count', { p_news_ids: ids }).then(must),
      ]);
      const readSet = new Set(reads.map((r) => r.news_id));
      const countMap = Object.fromEntries(counts.map((c) => [c.news_id, c.read_count]));
      listEl.innerHTML = `<ul class="list">${data.map((n) => `<li><a class="row-link" href="#/news/${esc(n.id)}">
        <span class="${n.track_reads && !readSet.has(n.id) ? 'unread-dot' : 'read-dot'}" title="${readSet.has(n.id) ? 'อ่านแล้ว' : 'ยังไม่อ่าน'}"></span>
        <span style="flex:1;min-width:0"><span style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">${newsBadges(n)}</span>
          <span class="row-title" style="font-size:16px">${esc(n.title)}</span>
          ${n.summary ? `<span class="cell-sub" style="display:block;margin-top:2px">${esc(n.summary)}</span>` : ''}
          <span class="cell-sub" style="display:block;margin-top:4px">${esc(n.author?.full_name || 'ผู้ดูแลระบบ')} · ${esc(fmtDate(n.publish_at))}${n.track_reads ? ` · อ่านแล้ว ${countMap[n.id] || 0} คน` : ''}</span></span></a></li>`).join('')}</ul>
        ${pager(st.page, PAGE, count || 0)}`;
    } catch (e) { listEl.innerHTML = errorState(e); $('[data-retry]', listEl)?.addEventListener('click', load); }
  }
  listEl.addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) { st.page = Number(b.dataset.page); load(); } });
  $('[data-q]', view).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }, 350));
  $('[data-cat]', view).addEventListener('change', (e) => { st.category = e.target.value; st.page = 1; load(); });
  $('[data-archive]', view).addEventListener('change', (e) => { st.archive = e.target.checked; st.page = 1; load(); });
  await load();
}

// ================================================================ detail
export async function renderDetail(view, { id }, _q, { setTitle }) {
  view.innerHTML = `<div class="panel">${loadingState(8)}</div>`;
  const { data: n, error } = await supabase.from('news')
    .select('*, author:profiles!news_created_by_fkey(full_name), editor:profiles!news_updated_by_fkey(full_name), departments(name)')
    .eq('id', id).maybeSingle();
  if (error && error.code !== '22P02') throw error;
  if (!n) {
    setTitle('ไม่พบข่าว');
    view.innerHTML = `<div class="panel">${emptyState('ไม่พบข่าว หรือข่าวนี้ไม่ได้ส่งถึงคุณ', '', '<a class="btn" href="#/news">กลับไปหน้าข่าวสาร</a>', 'news')}</div>`;
    return;
  }
  setTitle(n.title);
  const editable = canEditItem(n);
  const [attachments, favs] = await Promise.all([
    supabase.from('news_attachments').select('*').eq('news_id', id).order('created_at').then(must),
    getFavoriteIds('news'),
  ]);
  const [state] = lifecycle(n);
  view.innerHTML = `
    <article class="article">
      <a href="#/news" class="muted">ข่าวสาร</a>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 8px">${newsBadges(n)}${editable ? `<span class="chip">${esc(state)}</span>` : ''}</div>
      <h1>${esc(n.title)}</h1>
      <div class="article-meta">
        <span>เผยแพร่โดย ${esc(n.author?.full_name || 'ผู้ดูแลระบบ')}${n.departments ? ` (${esc(n.departments.name)})` : ''}</span>
        <span>${esc(fmtDateTime(n.publish_at || n.created_at))}</span>
        ${n.updated_at && n.publish_at && new Date(n.updated_at) > new Date(n.publish_at) ? `<span>แก้ไขล่าสุด ${esc(fmtDateTime(n.updated_at))}</span>` : ''}
        ${n.track_reads ? '<span data-readcount></span>' : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px">
        <button class="btn btn-sm" data-fav aria-pressed="${favs.has(id)}">${icon('star')} ${favs.has(id) ? 'อยู่ในรายการโปรด' : 'บันทึกเป็นรายการโปรด'}</button>
        ${editable ? `<a class="btn btn-sm" href="#/news/${esc(id)}/edit">${icon('edit')} แก้ไข</a>
          ${n.track_reads ? `<button class="btn btn-sm" data-readers>${icon('users')} ผู้อ่าน</button>` : ''}
          <button class="btn btn-sm" data-history>${icon('history')} ประวัติการแก้ไข</button>
          <button class="btn btn-sm btn-danger" data-del>${icon('trash')} ลบ</button>` : ''}
      </div>
      ${n.event_start_at ? `<div class="notice notice-info">${icon('calendar')}<div><b>${esc(fmtDateTime(n.event_start_at))}</b>${n.event_end_at ? ` – ${esc(fmtDateTime(n.event_end_at))}` : ''}${n.event_location ? `<br>สถานที่: ${esc(n.event_location)}` : ''}</div></div>` : ''}
      <div data-cover></div>
      ${n.summary ? `<p style="font-size:17px;color:var(--ink-2)">${esc(n.summary)}</p>` : ''}
      <div class="article-body">${sanitizeHtml(n.content_html)}</div>
      ${attachments.length ? `<section class="panel" style="margin-top:28px"><div class="panel-head"><h3>ไฟล์แนบ</h3></div><ul class="list">
        ${attachments.map((a) => `<li style="display:flex;gap:12px;align-items:center">${fileIcon(a.file_name)}<span style="flex:1;min-width:0"><span class="row-title">${esc(a.file_name)}</span><span class="cell-sub" style="display:block">${esc(fmtSize(a.file_size))}</span></span>
          <button class="btn btn-sm" data-att="${esc(a.id)}">${icon('download')} ดาวน์โหลด</button></li>`).join('')}</ul></section>` : ''}
    </article>`;

  hydrateNewsImages($('.article-body', view));
  if (n.cover_image_path) {
    signedUrl('news', n.cover_image_path).then((u) => { $('[data-cover]', view).innerHTML = `<img class="news-cover" src="${esc(u)}" alt="">`; }).catch(() => {});
  }
  if (n.status === 'published') {
    supabase.rpc('mark_news_read', { p_news_id: id }).then(async () => {
      const el = $('[data-readcount]', view);
      if (!el) return;
      const c = must(await supabase.rpc('news_read_count', { p_news_ids: [id] }));
      el.textContent = `อ่านแล้ว ${c[0]?.read_count || 0} คน`;
    });
  }
  view.addEventListener('click', async (e) => {
    const att = e.target.closest('[data-att]');
    if (att) {
      const a = attachments.find((x) => x.id === att.dataset.att);
      withLoading(att, async () => {
        try { const url = await signedUrl('news', a.file_path, a.file_name); await logEvent('news.attachment_download', 'news', id, { file: a.file_name }); triggerDownload(url); }
        catch (err) { toastError(err); }
      });
    }
  });
  $('[data-fav]', view).addEventListener('click', async (e) => {
    const b = e.currentTarget; const on = b.getAttribute('aria-pressed') !== 'true';
    try { await setFavorite('news', id, on); b.setAttribute('aria-pressed', String(on)); b.innerHTML = `${icon('star')} ${on ? 'อยู่ในรายการโปรด' : 'บันทึกเป็นรายการโปรด'}`; }
    catch (err) { toastError(err); }
  });
  $('[data-del]', view)?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'ลบข่าว', message: `ลบ "${n.title}"? ไฟล์แนบและประวัติการอ่านจะถูกลบด้วย`, confirmText: 'ลบข่าว', danger: true })) return;
    try { await deleteNews(n, attachments); toast('ลบข่าวแล้ว', 'success'); location.hash = '#/news'; } catch (err) { toastError(err); }
  });
  $('[data-readers]', view)?.addEventListener('click', () => showReaders(n));
  $('[data-history]', view)?.addEventListener('click', () => showHistory(n));
}

async function deleteNews(n, attachments = null) {
  const atts = attachments || must(await supabase.from('news_attachments').select('file_path').eq('news_id', n.id));
  const paths = [...atts.map((a) => a.file_path), n.cover_image_path, ...newsImagePaths(n.content_html)].filter(Boolean);
  if (paths.length) await supabase.storage.from('news').remove(paths);   // best effort
  const rows = must(await supabase.from('news').delete().eq('id', n.id).select('id'));
  if (!rows.length) throw new Error('คุณไม่มีสิทธิ์ลบข่าวนี้');
}

async function showReaders(n) {
  const m = modal({ title: `ผู้อ่าน — ${n.title}`, body: loadingState(4), size: 'lg' });
  try {
    const rows = must(await supabase.from('news_reads').select('read_at, profiles(full_name, email, departments(name))').eq('news_id', n.id).order('read_at', { ascending: false }));
    m.body.innerHTML = rows.length ? `<p class="muted">อ่านแล้ว ${rows.length} คน</p><div class="table-wrap"><table class="table responsive"><thead><tr><th>ชื่อ</th><th>แผนก</th><th>เวลาที่อ่าน</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td data-label="ชื่อ">${esc(r.profiles?.full_name || '-')}<div class="cell-sub">${esc(r.profiles?.email || '')}</div></td><td data-label="แผนก">${esc(r.profiles?.departments?.name || '-')}</td><td data-label="เวลาที่อ่าน">${esc(fmtDateTime(r.read_at))}</td></tr>`).join('')}
      </tbody></table></div>` : emptyState('ยังไม่มีผู้อ่าน', '', '', 'users', true);
  } catch (e) { m.body.innerHTML = errorState(e, false); }
}

async function showHistory(n) {
  const m = modal({ title: `ประวัติการแก้ไข — ${n.title}`, body: loadingState(4), size: 'lg' });
  try {
    const rows = must(await supabase.from('news_revisions').select('id, revision_no, title, status, changed_at, content_html, profiles(full_name)').eq('news_id', n.id).order('revision_no', { ascending: false }));
    m.body.innerHTML = rows.length ? `<ul class="list">${rows.map((r) => `<li><details><summary><b>ฉบับที่ ${r.revision_no}</b> · ${esc(r.title)} <span class="muted">— บันทึกก่อนการแก้ไขโดย ${esc(r.profiles?.full_name || '-')} ${esc(fmtDateTime(r.changed_at))}</span></summary>
      <div class="article-body" style="margin-top:10px;font-size:14px;border-left:3px solid var(--line);padding-left:12px">${sanitizeHtml(r.content_html)}</div></details></li>`).join('')}</ul>`
      : emptyState('ยังไม่มีการแก้ไข', '', '', 'history', true);
    m.body.querySelectorAll('.article-body').forEach((el) => hydrateNewsImages(el));
  } catch (e) { m.body.innerHTML = errorState(e, false); }
}

// ================================================================ editor
export async function renderEditor(view, { id }, _q, { setTitle }) {
  if (!canAuthor()) { view.innerHTML = `<div class="panel">${emptyState('คุณไม่มีสิทธิ์สร้างหรือแก้ไขข่าว', '', '', 'lock')}</div>`; return; }
  let n = { category: 'company', priority: 'normal', audience: 'all', track_reads: true, status: 'draft', department_id: me().department_id };
  let targets = []; let attachments = [];
  if (id) {
    const { data, error } = await supabase.from('news').select('*').eq('id', id).maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!data || !canEditItem(data)) { view.innerHTML = `<div class="panel">${emptyState('ไม่พบข่าว หรือคุณไม่มีสิทธิ์แก้ไข', '', '', 'lock')}</div>`; return; }
    n = data;
    [targets, attachments] = await Promise.all([
      supabase.from('news_targets').select('*').eq('news_id', id).then(must),
      supabase.from('news_attachments').select('*').eq('news_id', id).order('created_at').then(must),
    ]);
  }
  setTitle(id ? 'แก้ไขข่าว' : 'สร้างข่าว');
  const manage = can('news.manage');
  const departments = await getDepartments();
  const maps = await nameMaps();
  let pendingTargets = targets.map((t) => ({ type: t.principal_type, id: principalId(t) }));

  view.innerHTML = `
    <div class="page-head"><div class="grow"><a href="${id ? `#/news/${esc(id)}` : '#/news'}" class="muted">${id ? 'กลับไปที่ข่าว' : 'ข่าวสาร'}</a>
      <h1 style="margin-top:4px">${id ? 'แก้ไขข่าว' : 'สร้างข่าว'}</h1></div></div>
    <form data-f novalidate class="detail-grid">
      <div class="panel"><div class="panel-body">
        <div class="field"><label for="n-title">หัวข้อข่าว *</label><input id="n-title" name="title" class="input" maxlength="250" value="${esc(n.title || '')}"></div>
        <div class="field"><label for="n-sum">สรุปสั้น</label><input id="n-sum" name="summary" class="input" maxlength="400" value="${esc(n.summary || '')}">
          <span class="hint">แสดงในรายการข่าวและหน้าแรก</span></div>
        <div class="field"><label>รายละเอียด</label><div id="n-editor"></div></div>
        <div class="field"><label for="n-cover">รูปภาพหน้าปก</label><input id="n-cover" type="file" class="input" accept="image/*">
          ${n.cover_image_path ? '<label class="check" style="margin-top:6px"><input type="checkbox" data-rmcover> นำรูปหน้าปกเดิมออก</label>' : ''}</div>
        <div class="field"><label for="n-att">ไฟล์แนบ</label><input id="n-att" type="file" class="input" multiple accept="${ATTACH_EXT.map((x) => '.' + x).join(',')}">
          <span class="hint">PDF, Word, Excel, PowerPoint หรือรูปภาพ ไม่เกิน ${NEWS_MAX_MB} MB ต่อไฟล์</span></div>
        <ul class="list" data-atts>${attachments.map((a) => `<li style="display:flex;gap:10px;align-items:center;padding:8px 0">${fileIcon(a.file_name)}<span style="flex:1">${esc(a.file_name)}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-rmatt="${esc(a.id)}">${icon('x')} นำออก</button></li>`).join('')}</ul>
      </div></div>
      <aside style="display:flex;flex-direction:column;gap:18px">
        <section class="panel"><div class="panel-body">
          <div class="field"><label for="n-cat">ประเภทข่าว</label><select id="n-cat" name="category" class="select">${opts(Object.entries(NEWS_CATEGORY).map(([k, v]) => ({ id: k, name: v })), n.category)}</select></div>
          <div class="field"><label for="n-pri">ระดับความสำคัญ</label><select id="n-pri" name="priority" class="select">${opts(Object.entries(NEWS_PRIORITY).map(([k, v]) => ({ id: k, name: v })), n.priority)}</select></div>
          <div class="field"><label for="n-dept">แผนกผู้ประกาศ</label><select id="n-dept" name="department_id" class="select" ${manage ? '' : 'disabled'}>${opts(departments, n.department_id, { empty: manage ? '— ทั้งบริษัท —' : null })}</select></div>
          ${manage ? `<label class="check" style="margin-bottom:10px"><input type="checkbox" name="is_pinned" ${n.is_pinned ? 'checked' : ''}> ปักหมุดบนหน้าแรก</label>` : ''}
          <label class="check"><input type="checkbox" name="track_reads" ${n.track_reads ? 'checked' : ''}> ติดตามการอ่าน (แสดงจำนวนผู้อ่าน)</label>
        </div></section>
        <section class="panel"><div class="panel-body">
          <div class="field"><label for="n-pub">วันเวลาเผยแพร่</label><input id="n-pub" name="publish_at" type="datetime-local" class="input" value="${esc(toLocalInput(n.publish_at))}">
            <span class="hint">เว้นว่างเพื่อเผยแพร่ทันที กำหนดเวลาในอนาคตเพื่อตั้งเวลาเผยแพร่</span></div>
          <div class="field"><label for="n-exp">วันสิ้นสุดการแสดงผล</label><input id="n-exp" name="expire_at" type="datetime-local" class="input" value="${esc(toLocalInput(n.expire_at))}"></div>
          <details ${n.event_start_at || n.category === 'event' ? 'open' : ''}><summary class="muted" style="cursor:pointer;margin-bottom:10px">วันที่กิจกรรม (แสดงใน Upcoming Events)</summary>
            <div class="field"><label for="n-es">เริ่ม</label><input id="n-es" name="event_start_at" type="datetime-local" class="input" value="${esc(toLocalInput(n.event_start_at))}"></div>
            <div class="field"><label for="n-ee">สิ้นสุด</label><input id="n-ee" name="event_end_at" type="datetime-local" class="input" value="${esc(toLocalInput(n.event_end_at))}"></div>
            <div class="field"><label for="n-el">สถานที่</label><input id="n-el" name="event_location" class="input" value="${esc(n.event_location || '')}"></div></details>
        </div></section>
        <section class="panel"><div class="panel-body">
          <div class="field"><label for="n-aud">ผู้รับข่าว</label><select id="n-aud" name="audience" class="select">
            <option value="all" ${n.audience === 'all' ? 'selected' : ''}>พนักงานทุกคน</option>
            <option value="targeted" ${n.audience === 'targeted' ? 'selected' : ''}>เฉพาะแผนก บทบาท กลุ่ม หรือบุคคล</option></select></div>
          <div data-targets ${n.audience === 'targeted' ? '' : 'hidden'}><ul class="list" data-tlist style="margin-bottom:10px"></ul><div data-picker></div>
            <button type="button" class="btn btn-sm" data-addt>${icon('plus')} เพิ่มผู้รับ</button></div>
        </div></section>
        <div class="btn-stack">
          <button type="button" class="btn btn-primary" data-publish>${icon('check')} เผยแพร่ / ตั้งเวลาเผยแพร่</button>
          <button type="button" class="btn" data-draft>บันทึกฉบับร่าง</button>
          ${id && n.status !== 'archived' ? '<button type="button" class="btn btn-ghost" data-archive>เก็บถาวร (ซ่อนจากทุกคน)</button>' : ''}
        </div>
      </aside>
    </form>`;

  // Rich text editor with inline images. Images live in the private `news`
  // bucket; the saved HTML keeps only data-path, signed URLs are added on view.
  const editor = createEditor($('#n-editor', view), { html: n.content_html || '', placeholder: 'พิมพ์รายละเอียดข่าว…' });
  hydrateNewsImages(editor.root);
  const oldImagePaths = newsImagePaths(n.content_html);

  async function prepareContent(newsId) {
    const box = document.createElement('div');
    box.innerHTML = editor.getHtml();
    let i = 0;
    for (const img of Array.from(box.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || '';
      if (img.dataset.path) { img.removeAttribute('src'); continue; }
      let file = editor.pending.get(src);
      if (!file && src.startsWith('data:image/')) file = await (await fetch(src)).blob();
      if (!file) { img.remove(); continue; }                       // external images are not allowed
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const path = `${newsId}/img-${Date.now()}-${i++}.${ext}`;
      const up = await supabase.storage.from('news').upload(path, file, { contentType: file.type || 'image/png', upsert: false });
      if (up.error) throw up.error;
      img.removeAttribute('src');
      img.setAttribute('data-path', path);
      img.setAttribute('alt', img.getAttribute('alt') || '');
    }
    return sanitizeHtml(box.innerHTML);
  }

  const form = $('[data-f]', view);
  const tlist = $('[data-tlist]', view);
  const drawTargets = () => {
    tlist.innerHTML = pendingTargets.length ? pendingTargets.map((t, i) => `<li style="display:flex;gap:8px;align-items:center;padding:6px 0">
      <span class="chip">${esc(PRINCIPAL_LABEL[t.type])}</span><span style="flex:1">${esc(maps[t.type]?.[t.id] || '-')}</span>
      <button type="button" class="btn btn-sm btn-ghost" data-rmt="${i}" aria-label="นำออก">${icon('x')}</button></li>`).join('')
      : '<li class="muted" style="padding:6px 0">ยังไม่ได้เลือกผู้รับ</li>';
  };
  drawTargets();
  const picker = await principalPicker($('[data-picker]', view));
  $('[data-addt]', view).addEventListener('click', () => {
    const p = picker.get(); if (!p) return;
    if (!pendingTargets.some((t) => t.type === p.type && t.id === p.id)) pendingTargets.push(p);
    drawTargets();
  });
  tlist.addEventListener('click', (e) => { const b = e.target.closest('[data-rmt]'); if (b) { pendingTargets.splice(Number(b.dataset.rmt), 1); drawTargets(); } });
  $('[name=audience]', view).addEventListener('change', (e) => { $('[data-targets]', view).hidden = e.target.value !== 'targeted'; });

  const removedAtt = new Set();
  $('[data-atts]', view).addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmatt]'); if (!b) return;
    removedAtt.add(b.dataset.rmatt); b.closest('li').remove();
  });

  async function save(status, btn) {
    const f = formData(form);
    if (!f.title) { toast('กรุณาระบุหัวข้อข่าว', 'error'); $('#n-title', view).focus(); return; }
    const row = {
      title: f.title, summary: f.summary || null, category: f.category, priority: f.priority,
      track_reads: f.track_reads, audience: f.audience, status,
      publish_at: fromLocalInput(f.publish_at), expire_at: fromLocalInput(f.expire_at),
      event_start_at: fromLocalInput(f.event_start_at), event_end_at: fromLocalInput(f.event_end_at), event_location: f.event_location || null,
    };
    if (manage) { row.department_id = f.department_id || null; row.is_pinned = f.is_pinned; }
    else if (!id) row.department_id = me().department_id;
    if (status === 'published' && !row.publish_at) row.publish_at = new Date().toISOString();
    if (row.expire_at && row.publish_at && row.expire_at <= row.publish_at) { toast('วันสิ้นสุดการแสดงผลต้องอยู่หลังวันเผยแพร่', 'error'); return; }
    if (row.audience === 'targeted' && !pendingTargets.length) { toast('กรุณาเลือกผู้รับข่าวอย่างน้อย 1 รายการ', 'error'); return; }
    const files = Array.from($('#n-att', view).files || []);
    const cover = $('#n-cover', view).files?.[0];
    for (const fl of [...files, cover].filter(Boolean)) {
      if (fl.size > NEWS_MAX_MB * 1024 * 1024) { toast(`ไฟล์ ${fl.name} ใหญ่เกิน ${NEWS_MAX_MB} MB`, 'error'); return; }
      if (!ATTACH_EXT.includes(fileExt(fl.name))) { toast(`ไม่รองรับไฟล์ ${fl.name}`, 'error'); return; }
    }
    if (cover && !IMAGE_EXT.includes(fileExt(cover.name))) { toast('รูปหน้าปกต้องเป็นไฟล์รูปภาพ', 'error'); return; }

    await withLoading(btn, async () => {
      try {
        let newsId = id;
        if (id) {
          row.content_html = await prepareContent(id);
          must(await supabase.from('news').update(row).eq('id', id));
        } else {
          // insert first: inline images are stored under the news id
          newsId = must(await supabase.from('news').insert({ ...row, content_html: '' }).select('id').single()).id;
          row.content_html = await prepareContent(newsId);
          must(await supabase.from('news').update({ content_html: row.content_html }).eq('id', newsId));
        }
        const removedImages = oldImagePaths.filter((p) => !newsImagePaths(row.content_html).includes(p));
        if (removedImages.length) await supabase.storage.from('news').remove(removedImages);

        // Targets: replace the whole set
        if (id) must(await supabase.from('news_targets').delete().eq('news_id', newsId));
        if (row.audience === 'targeted' && pendingTargets.length) {
          must(await supabase.from('news_targets').insert(pendingTargets.map((t) => ({ news_id: newsId, ...principalColumns(t.type, t.id) }))));
        }
        // Cover image
        if (cover) {
          const path = `${newsId}/cover-${Date.now()}-${safeKey(cover.name)}`;
          const up = await supabase.storage.from('news').upload(path, cover, { contentType: cover.type, upsert: false });
          if (up.error) throw up.error;
          if (n.cover_image_path) await supabase.storage.from('news').remove([n.cover_image_path]);
          must(await supabase.from('news').update({ cover_image_path: path }).eq('id', newsId));
        } else if ($('[data-rmcover]', view)?.checked) {
          await supabase.storage.from('news').remove([n.cover_image_path]);
          must(await supabase.from('news').update({ cover_image_path: null }).eq('id', newsId));
        }
        // Attachments
        for (const attId of removedAtt) {
          const a = attachments.find((x) => x.id === attId);
          must(await supabase.from('news_attachments').delete().eq('id', attId));
          if (a) await supabase.storage.from('news').remove([a.file_path]);
        }
        for (const fl of files) {
          const path = `${newsId}/att-${Date.now()}-${safeKey(fl.name)}`;
          const up = await supabase.storage.from('news').upload(path, fl, { contentType: fl.type || 'application/octet-stream', upsert: false });
          if (up.error) throw up.error;
          must(await supabase.from('news_attachments').insert({ news_id: newsId, file_path: path, file_name: fl.name, file_size: fl.size, mime_type: fl.type || null }));
        }
        const scheduled = status === 'published' && new Date(row.publish_at) > new Date();
        toast(status === 'draft' ? 'บันทึกฉบับร่างแล้ว' : status === 'archived' ? 'เก็บถาวรแล้ว' : scheduled ? 'ตั้งเวลาเผยแพร่แล้ว' : 'เผยแพร่ข่าวแล้ว', 'success');
        location.hash = `#/news/${newsId}`;
      } catch (err) { toastError(err); }
    });
  }
  $('[data-publish]', view).addEventListener('click', (e) => save('published', e.currentTarget));
  $('[data-draft]', view).addEventListener('click', (e) => save('draft', e.currentTarget));
  $('[data-archive]', view)?.addEventListener('click', (e) => save('archived', e.currentTarget));
}

// ================================================================ admin tab
export async function renderAdmin(el) {
  el.innerHTML = `<div class="toolbar"><input class="input search-input" type="search" data-q placeholder="ค้นหาข่าว" aria-label="ค้นหาข่าว">
    <select class="select" data-status aria-label="สถานะ"><option value="">ทุกสถานะ</option><option value="draft">ฉบับร่าง</option><option value="published">เผยแพร่ / ตั้งเวลา</option><option value="archived">เก็บถาวร</option></select>
    <a class="btn btn-primary" href="#/news/new">${icon('plus')} สร้างข่าว</a></div><div class="panel" data-list>${loadingState(5)}</div>`;
  const listEl = $('[data-list]', el); const st = { q: '', status: '', page: 1 };
  async function load() {
    try {
      let q = supabase.from('news').select('id, title, category, priority, status, is_pinned, publish_at, expire_at, created_by, updated_at, author:profiles!news_created_by_fkey(full_name)', { count: 'exact' });
      if (!can('news.manage')) q = q.eq('created_by', me().id);
      if (st.status) q = q.eq('status', st.status);
      if (st.q) q = q.ilike('search_text', likePattern(st.q));
      const { data, count } = must(await q.order('updated_at', { ascending: false }).range((st.page - 1) * 20, st.page * 20 - 1));
      if (!data.length) { listEl.innerHTML = emptyState('ไม่พบข่าว', '', '', 'news'); return; }
      listEl.innerHTML = `<div class="table-wrap"><table class="table responsive"><thead><tr><th>หัวข้อ</th><th>ประเภท</th><th>สถานะ</th><th>ผู้สร้าง</th><th>แก้ไขล่าสุด</th><th></th></tr></thead><tbody>
        ${data.map((n) => { const [label, chip] = lifecycle(n); return `<tr data-id="${esc(n.id)}">
          <td data-label="หัวข้อ"><a href="#/news/${esc(n.id)}" class="cell-title">${n.is_pinned ? `<span class="pinned-mark">${icon('pin')}</span> ` : ''}${esc(n.title)}</a></td>
          <td data-label="ประเภท">${esc(NEWS_CATEGORY[n.category])}</td><td data-label="สถานะ"><span class="chip ${chip}">${esc(label)}</span></td>
          <td data-label="ผู้สร้าง">${esc(n.author?.full_name || '-')}</td><td data-label="แก้ไขล่าสุด">${esc(fmtRelative(n.updated_at))}</td>
          <td class="actions">${canEditItem(n) ? `<a class="btn btn-sm" href="#/news/${esc(n.id)}/edit">${icon('edit')} แก้ไข</a> <button class="btn btn-sm btn-danger" data-del aria-label="ลบ">${icon('trash')}</button>` : ''}</td></tr>`; }).join('')}
        </tbody></table></div>${pager(st.page, 20, count || 0)}`;
      listEl.onclick = async (e) => {
        const pg = e.target.closest('[data-page]'); if (pg) { st.page = Number(pg.dataset.page); load(); return; }
        const del = e.target.closest('[data-del]'); if (!del) return;
        const n = data.find((x) => x.id === del.closest('[data-id]').dataset.id);
        if (!await confirmDialog({ title: 'ลบข่าว', message: `ลบ "${n.title}"?`, confirmText: 'ลบข่าว', danger: true })) return;
        try { const full = must(await supabase.from('news').select('id, cover_image_path, content_html').eq('id', n.id).single()); await deleteNews(full); toast('ลบข่าวแล้ว', 'success'); load(); } catch (err) { toastError(err); }
      };
    } catch (e) { listEl.innerHTML = errorState(e); $('[data-retry]', listEl)?.addEventListener('click', load); }
  }
  $('[data-q]', el).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }, 350));
  $('[data-status]', el).addEventListener('change', (e) => { st.status = e.target.value; st.page = 1; load(); });
  load();
}
