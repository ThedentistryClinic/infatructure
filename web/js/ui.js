// Shared UI helpers: escaping, toasts, modals, states, formatting.
import { icon } from './icons.js';

/** Escape any value for safe insertion into HTML text or attribute context. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[c]));
}

/** Sanitize rich-text HTML (news). DOMPurify is loaded in index.html. */
export function sanitizeHtml(html) {
  if (!window.DOMPurify) return esc(html);
  return window.DOMPurify.sanitize(html || '', {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  });
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------------------------------------ errors
export function errMsg(err) {
  if (!err) return 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
  const m = String(err.message || err.error_description || err.error || err);
  if (/Invalid login credentials/i.test(m)) return 'อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง';
  if (/Email not confirmed/i.test(m)) return 'ยังไม่ได้ยืนยันอีเมล กรุณาตรวจสอบกล่องจดหมาย';
  if (/User is banned/i.test(m)) return 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ';
  if (/row-level security|permission denied|42501/i.test(m) || err.code === '42501') return 'คุณไม่มีสิทธิ์ทำรายการนี้';
  if (/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(m)) {
    const f = /([\w-]+\.js)/.exec(m);
    return `โหลดไฟล์ของหน้าเว็บไม่สำเร็จ${f ? ` (${f[1]})` : ''} — ไฟล์อาจยังไม่ได้อัปโหลดหรืออยู่ผิดโฟลเดอร์ ลองกด Ctrl+F5`;
  }
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง';
  if (/JWT expired|invalid JWT|session/i.test(m)) return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
  if (/mime type|not supported/i.test(m)) return 'ไม่รองรับประเภทไฟล์นี้';
  if (/exceeded the maximum allowed size|Payload too large|413/i.test(m)) return 'ไฟล์มีขนาดใหญ่เกินกำหนด';
  if (/duplicate key|23505/i.test(m)) return 'ข้อมูลนี้มีอยู่แล้วในระบบ';
  if (/violates foreign key|23503/i.test(m)) return 'ไม่สามารถลบได้ เนื่องจากยังมีข้อมูลอื่นอ้างอิงอยู่';
  if (/violates check constraint|23514/i.test(m)) return 'ข้อมูลไม่ถูกต้องตามรูปแบบที่กำหนด';
  return m;
}

// ------------------------------------------------------------------ toasts
export function toast(message, type = 'info', ms = 4200) {
  let host = $('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info')}<div>${esc(message)}</div>`;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
export const toastError = (e) => toast(errMsg(e), 'error', 6000);

// ------------------------------------------------------------------ modals
let modalStack = 0;
/**
 * Open a modal. `body` is an HTML string (caller escapes) or a Node.
 * Returns { el, body, close, onClose }.
 */
export function modal({ title, body = '', footer = '', size = '' }) {
  const prevFocus = document.activeElement;
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="mt-${++modalStack}">
      <div class="modal-head"><h2 id="mt-${modalStack}">${esc(title)}</h2>
        <button class="btn btn-ghost btn-icon" data-close aria-label="ปิด">${icon('x')}</button></div>
      <div class="modal-body"></div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  const bodyEl = $('.modal-body', back);
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  document.body.appendChild(back);
  document.body.style.overflow = 'hidden';
  const listeners = [];
  const close = () => {
    back.remove();
    if (!$('.modal-backdrop')) document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    listeners.forEach((f) => f());
    prevFocus?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape' && back === $$('.modal-backdrop').at(-1)) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  $$('[data-close]', back).forEach((b) => b.addEventListener('click', close));
  setTimeout(() => ($('input:not([type=hidden]),select,textarea', bodyEl) || $('[data-close]', back))?.focus(), 30);
  return { el: back, body: bodyEl, close, onClose: (f) => listeners.push(f) };
}

export function confirmDialog({ title = 'ยืนยัน', message, confirmText = 'ยืนยัน', danger = false, input = null }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p>${esc(message)}</p>${input ? `<div class="field"><label for="cd-in">${esc(input)}</label><textarea id="cd-in" class="input"></textarea></div>` : ''}`,
      footer: `<button class="btn" data-close>ยกเลิก</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
    });
    let done = false;
    $('[data-ok]', m.el).addEventListener('click', () => {
      done = true;
      const v = input ? $('#cd-in', m.el).value.trim() : true;
      m.close(); resolve(v);
    });
    m.onClose(() => { if (!done) resolve(false); });
  });
}

/** Run an async action with a loading state on a button. */
export async function withLoading(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('is-loading'); btn.disabled = true;
  try { return await fn(); } finally { btn.classList.remove('is-loading'); btn.disabled = false; }
}

// ------------------------------------------------------------------ states
export const loadingState = (rows = 4) =>
  `<div aria-busy="true" aria-label="กำลังโหลด" style="padding:16px 20px">${
    Array.from({ length: rows }, (_, i) => `<div class="skeleton sk-line" style="width:${90 - i * 12}%"></div>`).join('')}</div>`;
export const emptyState = (title, text = '', action = '', ic = 'folder', compact = false) =>
  `<div class="state ${compact ? 'compact' : ''}">${icon(ic)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
export const errorState = (err, retry = true) =>
  `<div class="state" role="alert">${icon('alert')}<h3>โหลดข้อมูลไม่สำเร็จ</h3><p>${esc(errMsg(err))}</p>${
    retry ? '<button class="btn" data-retry>ลองอีกครั้ง</button>' : ''}</div>`;

// ------------------------------------------------------------------ format
const TH = 'th-TH';
export function fmtDate(v, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!v) return '-';
  const d = new Date(v);
  return isNaN(d) ? '-' : d.toLocaleDateString(TH, opts);
}
export function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  return isNaN(d) ? '-' : d.toLocaleString(TH, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtRelative(v) {
  if (!v) return '';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  if (diff < 60) return 'เมื่อสักครู่';
  if (diff < 3600) return `${Math.floor(diff / 60)} นาทีที่แล้ว`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ชั่วโมงที่แล้ว`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} วันที่แล้ว`;
  return fmtDate(v);
}
export function fmtSize(n) {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = Number(n);
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}
/** value for <input type="datetime-local"> from ISO */
export function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export function fileExt(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
export function fileIcon(name) {
  const ext = fileExt(name);
  return `<span class="file-ic ${esc(ext)}" aria-hidden="true">${esc((ext || 'file').toUpperCase().slice(0, 4))}</span>`;
}
/** ASCII-safe object key fragment (Storage keys must not contain arbitrary Unicode). */
export function safeKey(name) {
  const ext = fileExt(name);
  const base = (name || 'file').replace(/\.[^.]+$/, '').normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  return ext ? `${base}.${ext}` : base;
}
export function initials(name) {
  const s = String(name || '?').trim().split(/\s+/);
  return esc(((s[0]?.[0] || '') + (s[1]?.[0] || '')).toUpperCase() || '?');
}
export function setTitle(t, appName) { document.title = t ? `${t} — ${appName}` : appName; }

export function opts(list, selected, { value = 'id', label = 'name', empty = null } = {}) {
  const sel = Array.isArray(selected) ? selected.map(String) : [String(selected ?? '')];
  return (empty !== null ? `<option value="">${esc(empty)}</option>` : '') +
    list.map((o) => `<option value="${esc(o[value])}" ${sel.includes(String(o[value])) ? 'selected' : ''}>${esc(typeof label === 'function' ? label(o) : o[label])}</option>`).join('');
}

/** Read a <form> into an object (trimmed strings, checkboxes -> boolean). */
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'file') o[el.name] = el.files;
    else if (el.multiple) o[el.name] = Array.from(el.selectedOptions).map((x) => x.value);
    else o[el.name] = typeof el.value === 'string' ? el.value.trim() : el.value;
  }
  return o;
}

export function pager(page, size, total) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (page - 1) * size + 1 : 0; const to = Math.min(page * size, total);
  return `<div class="pager"><span>แสดง ${from}–${to} จาก ${total.toLocaleString(TH)} รายการ</span>
    <span style="display:flex;gap:6px">
      <button class="btn btn-sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>ก่อนหน้า</button>
      <button class="btn btn-sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>ถัดไป</button>
    </span></div>`;
}

/** Safe localStorage access (may throw in private mode). */
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/** Escape a user search term for PostgREST ilike patterns. */
export const likePattern = (q) => `%${String(q).toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
