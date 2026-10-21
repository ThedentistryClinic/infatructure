// Data-access helpers and session state. Every query below is subject to
// Row Level Security in the database; the UI only hides what RLS already blocks.
import { supabase, config } from './supabase.js';

export const state = {
  session: null,
  ctx: null,          // { profile, department, roles, permissions, is_manager }
  settings: {},       // key -> value (only those visible to this user)
  lookups: {},        // cached departments / roles / groups / categories / people
};

/** Throw on Supabase error, return data otherwise. */
export function must({ data, error, count }) {
  if (error) throw error;
  return count !== undefined && count !== null ? { data, count } : data;
}

export const can = (perm) => !!state.ctx?.permissions?.includes(perm);
export const hasRole = (code) => !!state.ctx?.roles?.some((r) => r.code === code);
export const me = () => state.ctx?.profile;
export const isAdminArea = () =>
  ['users.view', 'departments.manage', 'groups.manage', 'doc_categories.manage', 'apps.manage', 'news.manage',
    'news.create', 'audit.view', 'storage.view', 'settings.manage', 'documents.manage_all', 'roles.manage']
    .some(can);

export function setting(key, fallback = null) {
  const v = state.settings[key];
  return v === undefined || v === null ? fallback : v;
}

export async function loadSettings() {
  const rows = must(await supabase.from('system_settings').select('key, value, visibility'));
  state.settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return state.settings;
}

export async function loadContext() {
  state.ctx = must(await supabase.rpc('my_context'));
  state.lookups = {};
  return state.ctx;
}

// ---------------------------------------------------------------- lookups
async function cached(key, loader) {
  if (!state.lookups[key]) state.lookups[key] = loader();
  try { return await state.lookups[key]; } catch (e) { delete state.lookups[key]; throw e; }
}
export const invalidate = (...keys) => keys.forEach((k) => delete state.lookups[k]);

export const getDepartments = () => cached('departments', async () =>
  must(await supabase.from('departments').select('id, code, name, name_en, is_active, manager_id, parent_id, sort_order, description')
    .order('sort_order').order('name')));
export const getRoles = () => cached('roles', async () =>
  must(await supabase.from('roles').select('id, code, name, name_en, description, level, is_system').order('level', { ascending: false })));
export const getGroups = () => cached('groups', async () =>
  must(await supabase.from('groups').select('id, name, description, is_active').order('name')));
export const getCategories = () => cached('categories', async () =>
  must(await supabase.from('document_categories').select('id, name, name_en, description, parent_id, sort_order, is_active').order('sort_order').order('name')));
export const getPeople = () => cached('people', async () =>
  must(await supabase.from('profiles').select('id, full_name, email, department_id, position, is_active')
    .eq('is_active', true).order('full_name').limit(5000)));

export async function nameMaps() {
  const [departments, roles, groups, people] = await Promise.all([getDepartments(), getRoles(), getGroups(), getPeople()]);
  const m = (list, f) => Object.fromEntries(list.map((x) => [x.id, f(x)]));
  return {
    department: m(departments, (d) => d.name), role: m(roles, (r) => r.name),
    group: m(groups, (g) => g.name), user: m(people, (p) => p.full_name || p.email),
  };
}

// ---------------------------------------------------------------- storage
/** Create a short-lived signed URL. Storage only issues it if the RLS policy allows. */
export async function signedUrl(bucket, path, downloadName = null) {
  const ttl = Number(setting('storage.signed_url_ttl_seconds', 120)) || 120;
  const { data, error } = await supabase.storage.from(bucket)
    .createSignedUrl(path, ttl, downloadName ? { download: downloadName } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

/** Inline news images are stored as <img data-path="<news_id>/img-…">. */
export function newsImagePaths(html) {
  return Array.from(String(html || '').matchAll(/data-path="([^"]+)"/g), (m) => m[1]);
}
/** Give inline news images short-lived signed URLs (only works if the reader may view the news). */
export async function hydrateNewsImages(root) {
  const imgs = root ? Array.from(root.querySelectorAll('img[data-path]')) : [];
  if (!imgs.length) return;
  const ttl = Math.max(600, Number(setting('storage.signed_url_ttl_seconds', 120)) || 0);
  const paths = [...new Set(imgs.map((i) => i.dataset.path))];
  const { data, error } = await supabase.storage.from('news').createSignedUrls(paths, ttl);
  if (error) { console.warn(error); return; }
  const map = Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
  imgs.forEach((i) => { if (map[i.dataset.path]) i.src = map[i.dataset.path]; else i.alt = 'ไม่สามารถแสดงรูปภาพ'; });
}

export function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------------------------------------------------------------- favorites
export async function getFavoriteIds(type) {
  const rows = must(await supabase.from('favorites').select('item_id').eq('item_type', type));
  return new Set(rows.map((r) => r.item_id));
}
export async function setFavorite(type, id, on) {
  if (on) {
    must(await supabase.from('favorites').upsert({ user_id: me().id, item_type: type, item_id: id }, { ignoreDuplicates: true }));
  } else {
    must(await supabase.from('favorites').delete().eq('item_type', type).eq('item_id', id));
  }
}

export async function logEvent(action, entityType, entityId, details = {}) {
  try { await supabase.rpc('log_event', { p_action: action, p_entity_type: entityType, p_entity_id: entityId, p_details: details }); }
  catch { /* audit for reads is best effort; access itself is enforced by RLS */ }
}

/** Call the admin-users Edge Function with the user's JWT. */
export async function adminUsers(body) {
  const { data, error } = await supabase.functions.invoke(config.ADMIN_USERS_FUNCTION, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const DOC_ACCESS = {
  public: { label: 'พนักงานทุกคน', chip: 'chip-ok', hint: 'พนักงานทุกคนที่เข้าสู่ระบบเปิดดูและดาวน์โหลดได้' },
  department: { label: 'เฉพาะแผนก', chip: '', hint: 'เฉพาะสมาชิกของแผนกที่รับผิดชอบ (และผู้ที่ได้รับสิทธิ์เพิ่มเติม)' },
  specific: { label: 'ผู้ใช้/กลุ่มที่ระบุ', chip: 'chip-warn', hint: 'เฉพาะผู้ใช้ กลุ่ม แผนก หรือบทบาทที่กำหนดในหน้าสิทธิ์' },
  restricted: { label: 'จำกัดสิทธิ์', chip: 'chip-danger', hint: 'เฉพาะผู้ที่ได้รับสิทธิ์เป็นรายบุคคลเท่านั้น ผู้จัดการแผนกและ IT ไม่เห็นอัตโนมัติ' },
};
export const DOC_STATUS = {
  draft: { label: 'ฉบับร่าง', chip: '' }, pending: { label: 'รออนุมัติ', chip: 'chip-warn' },
  published: { label: 'เผยแพร่แล้ว', chip: 'chip-ok' }, rejected: { label: 'ไม่อนุมัติ', chip: 'chip-danger' },
};
export const NEWS_CATEGORY = {
  company: 'ประกาศบริษัท', hr: 'ข่าว HR', it: 'ประกาศ IT', maintenance: 'แจ้งปิดปรับปรุงระบบ',
  policy: 'อัปเดตนโยบาย', event: 'กิจกรรม & อีเวนต์', urgent: 'ประกาศด่วน',
};
export const NEWS_PRIORITY = { normal: 'ปกติ', important: 'สำคัญ', urgent: 'ด่วน' };
export const PRINCIPAL_LABEL = { user: 'ผู้ใช้', group: 'กลุ่ม', department: 'แผนก', role: 'บทบาท' };
