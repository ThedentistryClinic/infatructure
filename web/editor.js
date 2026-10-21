// Lightweight rich-text editor (no external dependency).
// Supports headings, bold/italic/underline, lists, quote, link and inline images.
// Inline images are kept as local blob: URLs until the news item is saved; the
// caller uploads them (see pendingImages) and stores only data-path in the HTML.
import { icon } from './icons.js';
import { esc, toast, sanitizeHtml, fileExt } from './ui.js';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const MAX_IMAGE_MB = 5;

const TOOLS = [
  ['formatBlock:H2', 'หัวข้อใหญ่', '<b>H2</b>'], ['formatBlock:H3', 'หัวข้อย่อย', '<b>H3</b>'], ['formatBlock:P', 'ย่อหน้าปกติ', '¶'],
  '|',
  ['bold', 'ตัวหนา (Ctrl+B)', '<b>B</b>'], ['italic', 'ตัวเอียง (Ctrl+I)', '<i>I</i>'], ['underline', 'ขีดเส้นใต้ (Ctrl+U)', '<u>U</u>'],
  '|',
  ['insertUnorderedList', 'รายการแบบจุด', icon('list')], ['insertOrderedList', 'รายการแบบตัวเลข', '<b>1.</b>'],
  ['formatBlock:BLOCKQUOTE', 'ข้อความอ้างอิง', '“'],
  '|',
  ['link', 'แทรกลิงก์', icon('link')], ['image', 'แทรกรูปภาพ', icon('image')],
  '|',
  ['removeFormat', 'ล้างรูปแบบ', icon('x')],
];

export function createEditor(container, { html = '', placeholder = 'พิมพ์รายละเอียด…' } = {}) {
  container.innerHTML = `
    <div class="rte">
      <div class="rte-toolbar" role="toolbar" aria-label="จัดรูปแบบข้อความ">
        ${TOOLS.map((t) => (t === '|' ? '<span class="rte-sep"></span>'
          : `<button type="button" class="rte-btn" data-cmd="${esc(t[0])}" title="${esc(t[1])}" aria-label="${esc(t[1])}">${t[2]}</button>`)).join('')}
        <input type="file" accept="${IMAGE_EXT.map((x) => '.' + x).join(',')}" multiple hidden data-rte-file>
      </div>
      <div class="rte-content article-body" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="${esc(placeholder)}"></div>
      <div class="rte-hint">ลากรูปมาวาง หรือวางรูปจากคลิปบอร์ดได้ · รูปละไม่เกิน ${MAX_IMAGE_MB} MB</div>
    </div>`;
  const root = container.querySelector('.rte-content');
  const fileInput = container.querySelector('[data-rte-file]');
  const pending = new Map();          // blob URL -> File
  root.innerHTML = sanitizeHtml(html);
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }

  let savedRange = null;
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && root.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreRange = () => {
    root.focus();
    if (savedRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
  };
  root.addEventListener('keyup', saveRange);
  root.addEventListener('mouseup', saveRange);
  root.addEventListener('input', saveRange);

  function insertImages(files) {
    for (const f of files) {
      if (!IMAGE_EXT.includes(fileExt(f.name || `x.${(f.type || '').split('/')[1]}`))) { toast(`ไม่รองรับไฟล์ ${f.name || ''} (ใช้ JPG, PNG, WEBP, GIF)`, 'error'); continue; }
      if (f.size > MAX_IMAGE_MB * 1024 * 1024) { toast(`รูป ${f.name} ใหญ่เกิน ${MAX_IMAGE_MB} MB`, 'error'); continue; }
      const url = URL.createObjectURL(f);
      pending.set(url, f);
      restoreRange();
      document.execCommand('insertHTML', false, `<p><img src="${url}" alt=""></p><p><br></p>`);
      saveRange();
    }
  }

  container.querySelector('.rte-toolbar').addEventListener('mousedown', (e) => {
    if (e.target.closest('.rte-btn')) e.preventDefault();   // keep the text selection
  });
  container.querySelector('.rte-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('.rte-btn'); if (!b) return;
    const [cmd, arg] = b.dataset.cmd.split(':');
    restoreRange();
    if (cmd === 'image') { fileInput.click(); return; }
    if (cmd === 'link') {
      const url = (window.prompt('ใส่ลิงก์ (https://…)', 'https://') || '').trim();
      if (!url) return;
      if (!/^(https?:|mailto:)/i.test(url)) { toast('ลิงก์ต้องขึ้นต้นด้วย https:// หรือ mailto:', 'error'); return; }
      document.execCommand('createLink', false, url);
    } else if (cmd === 'formatBlock') {
      document.execCommand('formatBlock', false, arg);
    } else {
      document.execCommand(cmd, false, null);
    }
    saveRange();
  });
  fileInput.addEventListener('change', () => { insertImages(Array.from(fileInput.files)); fileInput.value = ''; });

  // Paste: images become inline images; HTML is sanitised; otherwise default.
  root.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); saveRange(); insertImages(files); return; }
    const htmlData = e.clipboardData?.getData('text/html');
    if (htmlData) {
      e.preventDefault();
      const clean = sanitizeHtml(htmlData).replace(/<img[^>]*>/gi, '');   // remote/clipboard images are not allowed
      document.execCommand('insertHTML', false, clean);
    }
  });
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) savedRange = pos;
    insertImages(files);
  });

  return {
    root,
    pending,
    getHtml: () => root.innerHTML,
    isEmpty: () => !root.textContent.trim() && !root.querySelector('img'),
  };
}
