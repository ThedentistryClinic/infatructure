// Dashboard: welcome, quick access, announcements, recent documents,
// frequently used systems, upcoming events. Every list is RLS-filtered.
import { supabase } from '../supabase.js';
import { state, must, can, me } from '../api.js';
import { icon } from '../icons.js';
import { esc, $, fmtDate, fmtRelative, fileIcon, emptyState, errorState, loadingState } from '../ui.js';
import { openApplication, appIcon } from './applications.js';
import { newsBadges } from './news.js';

export async function render(view, _p, _q, { setTitle }) {
  setTitle('หน้าแรก');
  const p = me();
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? 'สวัสดีตอนเช้า' : hour < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น';
  view.innerHTML = `
    <section class="welcome">
      <img class="welcome-mark" src="assets/mark-white.png" alt="" aria-hidden="true">
      <div class="date-block" aria-label="วันนี้">
        <div class="d">${now.getDate()}</div>
        <div class="m">${esc(now.toLocaleDateString('th-TH', { weekday: 'long' }))}<br>${esc(now.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' }))}</div>
      </div>
      <div>
        <h1>${esc(greet)}, ${esc((p.full_name || '').split(' ')[0] || p.email)}</h1>
        <p>${esc([p.position, state.ctx.department?.name].filter(Boolean).join(' · ') || 'ยินดีต้อนรับสู่พอร์ทัลของบริษัท')}</p>
        <div class="alerts" data-alerts></div>
      </div>
    </section>
    <div class="dash-grid">
      <div class="dash-col">
        <section class="panel"><div class="panel-head"><h2>เข้าระบบด่วน</h2><a href="#/applications" class="btn btn-sm btn-ghost">ระบบทั้งหมด</a></div>
          <div class="panel-body" data-quick>${loadingState(2)}</div></section>
        <section class="panel"><div class="panel-head"><h2>ประกาศและข่าวสาร</h2><a href="#/news" class="btn btn-sm btn-ghost">ดูทั้งหมด</a></div>
          <div class="panel-body flush" data-news>${loadingState(4)}</div></section>
        <section class="panel"><div class="panel-head"><h2>เอกสารที่เพิ่มล่าสุด</h2><a href="#/documents?view=recent" class="btn btn-sm btn-ghost">ดูทั้งหมด</a></div>
          <div class="panel-body flush" data-docs>${loadingState(4)}</div></section>
      </div>
      <div class="dash-col">
        <section class="panel" data-approvals-panel hidden><div class="panel-head"><h2>รออนุมัติ</h2></div>
          <div class="panel-body flush" data-approvals></div></section>
        <section class="panel"><div class="panel-head"><h2>ระบบที่ใช้บ่อย</h2></div>
          <div class="panel-body flush" data-frequent>${loadingState(3)}</div></section>
        <section class="panel"><div class="panel-head"><h2>กิจกรรมและวันสำคัญ</h2></div>
          <div class="panel-body flush" data-events>${loadingState(3)}</div></section>
      </div>
    </div>`;

  const nowIso = now.toISOString();
  const section = (sel, loader) => {
    const el = $(sel, view);
    const run = async () => {
      try { await loader(el); } catch (e) {
        el.innerHTML = errorState(e);
        $('[data-retry]', el)?.addEventListener('click', run);
      }
    };
    return run();
  };

  await Promise.all([
    // Quick access: apps flagged as quick access (RLS shows only permitted apps)
    section('[data-quick]', async (el) => {
      const apps = must(await supabase.from('applications').select('id, name, url, icon, color, open_in_new_tab, is_active')
        .eq('is_quick_access', true).eq('is_active', true).order('sort_order').limit(8));
      if (!apps.length) { el.innerHTML = emptyState('ยังไม่มีระบบในเมนูด่วน', can('apps.manage') ? 'เลือก "แสดงในเมนูด่วน" ที่หน้าจัดการลิงก์ระบบ' : '', '', 'grid', true); return; }
      el.innerHTML = `<div class="quick-grid">${apps.map((a) => `
        <button class="quick" data-app="${esc(a.id)}">${appIcon(a)}<b>${esc(a.name)}</b></button>`).join('')}</div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-app]'); if (b) openApplication(apps.find((a) => a.id === b.dataset.app));
      });
    }),

    // Announcements: pinned first, then latest; excludes expired
    section('[data-news]', async (el) => {
      const rows = must(await supabase.from('news')
        .select('id, title, summary, category, priority, is_pinned, publish_at, created_at, track_reads')
        .eq('status', 'published').lte('publish_at', nowIso)
        .or(`expire_at.is.null,expire_at.gt.${nowIso}`)
        .order('is_pinned', { ascending: false }).order('publish_at', { ascending: false }).limit(6));
      if (!rows.length) { el.innerHTML = emptyState('ยังไม่มีประกาศ', '', '', 'news', true); return; }
      const reads = new Set(must(await supabase.from('news_reads').select('news_id').eq('user_id', p.id)
        .in('news_id', rows.map((r) => r.id))).map((r) => r.news_id));
      el.innerHTML = `<ul class="list">${rows.map((n) => `<li><a class="row-link" href="#/news/${esc(n.id)}">
          <span class="${n.track_reads && !reads.has(n.id) ? 'unread-dot' : 'read-dot'}" title="${reads.has(n.id) ? 'อ่านแล้ว' : 'ยังไม่อ่าน'}"></span>
          <span style="flex:1;min-width:0"><span class="badges" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:2px">${newsBadges(n)}</span>
          <span class="row-title">${esc(n.title)}</span>
          ${n.summary ? `<span class="cell-sub" style="display:block">${esc(n.summary)}</span>` : ''}</span>
          <span class="cell-sub" style="white-space:nowrap">${esc(fmtRelative(n.publish_at))}</span></a></li>`).join('')}</ul>`;
    }),

    // Recently added documents (only those the user may view)
    section('[data-docs]', async (el) => {
      const docs = must(await supabase.from('documents')
        .select('id, title, doc_number, file_name, created_at, departments(name)')
        .is('deleted_at', null).eq('status', 'published').gt('current_version', 0)
        .order('created_at', { ascending: false }).limit(6));
      if (!docs.length) { el.innerHTML = emptyState('ยังไม่มีเอกสาร', '', '', 'files', true); return; }
      el.innerHTML = `<ul class="list">${docs.map((d) => `<li><a class="row-link" href="#/documents/${esc(d.id)}">
          ${fileIcon(d.file_name)}<span style="flex:1;min-width:0"><span class="row-title">${esc(d.title)}</span>
          <span class="cell-sub" style="display:block">${esc([d.doc_number, d.departments?.name].filter(Boolean).join(' · '))}</span></span>
          <span class="cell-sub">${esc(fmtDate(d.created_at))}</span></a></li>`).join('')}</ul>`;
    }),

    // Frequently used systems (from this user's own usage)
    section('[data-frequent]', async (el) => {
      const rows = must(await supabase.from('application_usage')
        .select('open_count, last_opened_at, applications(id, name, url, icon, color, open_in_new_tab, is_active)')
        .order('open_count', { ascending: false }).limit(6)).filter((r) => r.applications);
      if (!rows.length) { el.innerHTML = emptyState('ยังไม่มีประวัติการใช้งาน', 'ระบบที่คุณเปิดบ่อยจะแสดงที่นี่', '', 'clock', true); return; }
      el.innerHTML = `<ul class="list">${rows.map((r) => `<li><a href="#" class="row-link" data-app="${esc(r.applications.id)}">
          ${appIcon(r.applications)}<span style="flex:1"><span class="row-title">${esc(r.applications.name)}</span>
          <span class="cell-sub" style="display:block">เปิดล่าสุด ${esc(fmtRelative(r.last_opened_at))}</span></span></a></li>`).join('')}</ul>`;
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-app]'); if (!a) return; e.preventDefault();
        openApplication(rows.find((r) => r.applications.id === a.dataset.app).applications);
      });
    }),

    // Upcoming events (news with an event date) — visible items only
    section('[data-events]', async (el) => {
      const ev = must(await supabase.from('news').select('id, title, event_start_at, event_location')
        .eq('status', 'published').lte('publish_at', nowIso).gte('event_start_at', nowIso)
        .order('event_start_at').limit(5));
      if (!ev.length) { el.innerHTML = emptyState('ไม่มีกิจกรรมที่กำลังจะมาถึง', '', '', 'calendar', true); return; }
      el.innerHTML = `<ul class="list">${ev.map((e) => {
        const d = new Date(e.event_start_at);
        return `<li><a class="row-link event" href="#/news/${esc(e.id)}">
          <span class="event-date"><div class="em">${esc(d.toLocaleDateString('th-TH', { month: 'short' }))}</div><div class="ed">${d.getDate()}</div></span>
          <span><span class="row-title">${esc(e.title)}</span><span class="cell-sub" style="display:block">${esc(d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }))} น.${e.event_location ? ' · ' + esc(e.event_location) : ''}</span></span></a></li>`;
      }).join('')}</ul>`;
    }),

    // Alerts in the welcome band + approvals
    (async () => {
      const alerts = [];
      try {
        const exp = must(await supabase.rpc('my_expiring_documents', { p_days: null }));
        if (exp.length) alerts.push(`<a href="#/documents?view=expiring">${icon('clock')} เอกสารใกล้หมดอายุ ${exp.length} รายการ</a>`);
      } catch { /* non-critical */ }
      try {
        const pend = must(await supabase.from('documents').select('id, title, created_at, profiles!documents_created_by_fkey(full_name)')
          .eq('status', 'pending').is('deleted_at', null).neq('created_by', p.id).order('created_at').limit(5));
        if (pend.length) {
          $('[data-approvals-panel]', view).hidden = false;
          $('[data-approvals]', view).innerHTML = `<ul class="list">${pend.map((d) => `<li><a class="row-link" href="#/documents/${esc(d.id)}">
            <span style="flex:1"><span class="row-title">${esc(d.title)}</span><span class="cell-sub" style="display:block">โดย ${esc(d.profiles?.full_name || '-')} · ${esc(fmtRelative(d.created_at))}</span></span>
            <span class="chip chip-warn">รออนุมัติ</span></a></li>`).join('')}</ul>`;
          alerts.push(`<a href="#/documents?view=pending">${icon('check')} เอกสารรออนุมัติ ${pend.length} รายการ</a>`);
        }
      } catch { /* non-critical */ }
      $('[data-alerts]', view).innerHTML = alerts.join('');
    })(),
  ]);
}
