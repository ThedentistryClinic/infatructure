// Global search across documents, news and applications (RLS-filtered).
import { supabase } from '../supabase.js';
import { must } from '../api.js';
import { esc, $, loadingState, emptyState, errorState, fileIcon, fmtDate, likePattern } from '../ui.js';
import { appIcon, openApplication } from './applications.js';
import { newsBadges } from './news.js';

export async function render(view, _p, query, { setTitle }) {
  const q = (query.q || '').trim().slice(0, 100);
  setTitle(`ค้นหา: ${q}`);
  const input = document.getElementById('gq'); if (input) input.value = q;
  view.innerHTML = `<div class="page-head"><div class="grow"><h1>ผลการค้นหา</h1><p>คำค้น “${esc(q)}”</p></div></div><div data-body>${loadingState(6)}</div>`;
  const body = $('[data-body]', view);
  if (q.length < 2) { body.innerHTML = `<div class="panel">${emptyState('พิมพ์อย่างน้อย 2 ตัวอักษร', '', '', 'search')}</div>`; return; }
  try {
    const pat = likePattern(q);
    const nowIso = new Date().toISOString();
    const [docs, news, apps] = await Promise.all([
      supabase.from('documents').select('id, title, doc_number, file_name, updated_at, departments(name)')
        .is('deleted_at', null).gt('current_version', 0).ilike('search_text', pat).order('updated_at', { ascending: false }).limit(20).then(must),
      supabase.from('news').select('id, title, summary, category, priority, is_pinned, publish_at')
        .eq('status', 'published').lte('publish_at', nowIso).ilike('search_text', pat).order('publish_at', { ascending: false }).limit(20).then(must),
      supabase.from('applications').select('id, name, description, url, icon, color, open_in_new_tab, is_active')
        .or(`name.ilike.${pat.replace(/[,()"]/g, ' ')},description.ilike.${pat.replace(/[,()"]/g, ' ')}`).limit(20).then(must),
    ]);
    if (!docs.length && !news.length && !apps.length) {
      body.innerHTML = `<div class="panel">${emptyState('ไม่พบผลลัพธ์', 'ลองใช้คำที่สั้นลง หรือค้นหาด้วยเลขที่เอกสาร', '', 'search')}</div>`;
      return;
    }
    const sec = (title, n, inner) => (n ? `<section class="panel"><div class="panel-head"><h2>${title}</h2><span class="chip">${n}</span></div><ul class="list">${inner}</ul></section>` : '');
    body.innerHTML = `<div style="display:flex;flex-direction:column;gap:22px">
      ${sec('ระบบงาน', apps.length, apps.map((a) => `<li><a href="#" class="row-link" data-app="${esc(a.id)}">${appIcon(a, 36)}<span><span class="row-title">${esc(a.name)}</span><span class="cell-sub" style="display:block">${esc(a.description || '')}</span></span></a></li>`).join(''))}
      ${sec('เอกสาร', docs.length, docs.map((d) => `<li><a class="row-link" href="#/documents/${esc(d.id)}">${fileIcon(d.file_name)}<span><span class="row-title">${esc(d.title)}</span><span class="cell-sub" style="display:block">${esc([d.doc_number, d.departments?.name, fmtDate(d.updated_at)].filter(Boolean).join(' · '))}</span></span></a></li>`).join(''))}
      ${sec('ข่าวสาร', news.length, news.map((n) => `<li><a class="row-link" href="#/news/${esc(n.id)}"><span><span style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:2px">${newsBadges(n)}</span><span class="row-title">${esc(n.title)}</span><span class="cell-sub" style="display:block">${esc(n.summary || '')}</span></span></a></li>`).join(''))}
    </div>`;
    body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-app]'); if (!a) return; e.preventDefault();
      openApplication(apps.find((x) => x.id === a.dataset.app));
    });
  } catch (e) { body.innerHTML = `<div class="panel">${errorState(e, false)}</div>`; }
}
