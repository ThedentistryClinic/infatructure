// Reusable widgets: principal (user/group/department/role) picker.
import { getDepartments, getGroups, getPeople, getRoles, PRINCIPAL_LABEL } from './api.js';
import { esc, $, debounce } from './ui.js';

const COL = { user: 'user_id', group: 'group_id', department: 'department_id', role: 'role_id' };

/** Columns for inserting a principal row into *_permissions / news_targets. */
export function principalColumns(type, id) {
  return { principal_type: type, user_id: null, group_id: null, department_id: null, role_id: null, [COL[type]]: id };
}
export const principalId = (row) => row[COL[row.principal_type]];
export function principalName(row, maps) {
  return maps[row.principal_type]?.[principalId(row)] || '(ไม่พบข้อมูล)';
}

async function optionsFor(type) {
  if (type === 'user') return (await getPeople()).map((p) => ({ id: p.id, label: `${p.full_name || p.email} — ${p.email}` }));
  if (type === 'group') return (await getGroups()).filter((g) => g.is_active).map((g) => ({ id: g.id, label: g.name }));
  if (type === 'department') return (await getDepartments()).filter((d) => d.is_active).map((d) => ({ id: d.id, label: `${d.name} (${d.code})` }));
  if (type === 'role') return (await getRoles()).map((r) => ({ id: r.id, label: r.name }));
  return [];
}

/**
 * Render a picker into `el`. Returns { get(): {type, id} | null, reset() }.
 */
export async function principalPicker(el, allowTypes = ['user', 'group', 'department', 'role']) {
  el.innerHTML = `
    <div class="grid-3" style="align-items:end">
      <div class="field"><label>ประเภท</label>
        <select class="select" data-ptype>${allowTypes.map((t) => `<option value="${t}">${esc(PRINCIPAL_LABEL[t])}</option>`).join('')}</select></div>
      <div class="field"><label>ค้นหา</label><input class="input" data-pfilter placeholder="พิมพ์ชื่อเพื่อกรอง"></div>
      <div class="field"><label>เลือก</label><select class="select" data-pid></select></div>
    </div>`;
  const typeSel = $('[data-ptype]', el); const filter = $('[data-pfilter]', el); const idSel = $('[data-pid]', el);
  let all = [];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const list = all.filter((o) => !q || o.label.toLowerCase().includes(q)).slice(0, 300);
    idSel.innerHTML = list.length ? list.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')
      : '<option value="">ไม่พบรายการ</option>';
  };
  const load = async () => { idSel.innerHTML = '<option>กำลังโหลด…</option>'; all = await optionsFor(typeSel.value); draw(); };
  typeSel.addEventListener('change', () => { filter.value = ''; load(); });
  filter.addEventListener('input', debounce(draw, 150));
  await load();
  return {
    get: () => (idSel.value ? { type: typeSel.value, id: idSel.value } : null),
    reset: () => { filter.value = ''; draw(); },
  };
}
