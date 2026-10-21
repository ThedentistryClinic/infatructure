// Favorites: documents, applications and news the user starred.
// Items are re-fetched through RLS, so lost access means the item disappears.
import { supabase } from '../supabase.js';
import { must, setFavorite } from '../api.js';
import { icon } from '../icons.js';
import { esc, $, toastError, loadingState, emptyState, errorState, fileIcon, fmtDate } from '../ui.js';
import { appIcon, openApplication } from './applications.js';

export async function render(view, _p, _q, { setTitle }) {
  setTitle('รายการโปรด');
  view.innerHTML = `<div class="page-head"><div class="grow"><h1>รายการโปรด</h1><p>เอกสาร ระบบงาน และข่าวที่คุณบันทึกไว้</p></div></div><div data-body>${loadingState(6)}</div>`;
  const body = $('[data-body]', view);
  try {
    const favs = must(await supabase.from('favorites').select('item_type, item_id, created_at').order('created_at', { ascending: false }));
    const ids = (t) => favs.filter((f) => f.item_type === t).map((f) => f.item_id);
    const [docs, apps, news] = await Promise.all([
      ids('document').length ? supabase.from('documents').select('id, title, doc_number, file_name, updated_at, deleted_at').in('id', ids('document')).is('deleted_at', null).then(must) : [],
      ids('application').length ? supabase.from('applications').select('id, name, description, url, icon, color, open_in_new_tab, is_active').in('id', ids('application')).then(must) : [],
      ids('news').length ? supabase.from('news').select('id, title, publish_at').in('id', ids('news')).then(must) : [],
    ]);
    if (!docs.length && !apps.length && !news.length) {
      body.innerHTML = `<div class="panel">${emptyState('ยังไม่มีรายการโปรด', 'กดไอคอนดาวที่เอกสาร ระบบงาน หรือข่าว เพื่อเก็บไว้เปิดได้เร็วขึ้น', '<a class="btn" href="#/documents">ไปที่เอกสาร</a>', 'star')}</div>`;
      return;
    }
    const unfav = (type, id) => `<button class="btn btn-sm btn-ghost" data-unfav="${type}:${esc(id)}" aria-label="นำออกจากรายการโปรด">${icon('x')}</button>`;
    body.innerHTML = `<div style="display:flex;flex-direction:column;gap:22px">
      ${apps.length ? `<section class="panel"><div class="panel-head"><h2>ระบบงาน</h2></div><ul class="list">${apps.map((a) => `<li style="display:flex;gap:12px;align-items:center">
        ${appIcon(a, 36)}<span style="flex:1"><span class="row-title">${esc(a.name)}</span><span class="cell-sub" style="display:block">${esc(a.description || '')}</span></span>
        <button class="btn btn-sm btn-primary" data-open="${esc(a.id)}" ${a.is_active ? '' : 'disabled'}>เปิดระบบ</button>${unfav('application', a.id)}</li>`).join('')}</ul></section>` : ''}
      ${docs.length ? `<section class="panel"><div class="panel-head"><h2>เอกสาร</h2></div><ul class="list">${docs.map((d) => `<li style="display:flex;gap:12px;align-items:center">
        <a class="row-link" style="flex:1" href="#/documents/${esc(d.id)}">${fileIcon(d.file_name)}<span><span class="row-title">${esc(d.title)}</span>
        <span class="cell-sub" style="display:block">${esc(d.doc_number || '')} อัปเดต ${esc(fmtDate(d.updated_at))}</span></span></a>${unfav('document', d.id)}</li>`).join('')}</ul></section>` : ''}
      ${news.length ? `<section class="panel"><div class="panel-head"><h2>ข่าวสาร</h2></div><ul class="list">${news.map((n) => `<li style="display:flex;gap:12px;align-items:center">
        <a class="row-link" style="flex:1" href="#/news/${esc(n.id)}"><span><span class="row-title">${esc(n.title)}</span><span class="cell-sub" style="display:block">${esc(fmtDate(n.publish_at))}</span></span></a>${unfav('news', n.id)}</li>`).join('')}</ul></section>` : ''}
    </div>`;
    body.addEventListener('click', async (e) => {
      const o = e.target.closest('[data-open]'); if (o) { openApplication(apps.find((a) => a.id === o.dataset.open)); return; }
      const u = e.target.closest('[data-unfav]'); if (!u) return;
      const [type, id] = u.dataset.unfav.split(':');
      try { await setFavorite(type, id, false); u.closest('li').remove(); } catch (err) { toastError(err); }
    });
  } catch (e) { body.innerHTML = `<div class="panel">${errorState(e, false)}</div>`; }
}
