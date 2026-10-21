// Minimal i18n layer. Thai is the default; English strings can be filled in
// over time. Pages call t('key') for shared labels (navigation, common actions).
import { store } from './ui.js';

const dict = {
  th: {
    'nav.dashboard': 'หน้าแรก', 'nav.documents': 'เอกสาร', 'nav.applications': 'ระบบงาน',
    'nav.news': 'ข่าวสาร', 'nav.favorites': 'รายการโปรด', 'nav.admin': 'จัดการระบบ',
    'nav.profile': 'โปรไฟล์ของฉัน', 'nav.logout': 'ออกจากระบบ',
    'search.placeholder': 'ค้นหาเอกสาร ข่าวสาร หรือระบบงาน',
    'common.save': 'บันทึก', 'common.cancel': 'ยกเลิก', 'common.delete': 'ลบ', 'common.edit': 'แก้ไข',
    'common.add': 'เพิ่ม', 'common.search': 'ค้นหา', 'common.all': 'ทั้งหมด',
  },
  en: {
    'nav.dashboard': 'Dashboard', 'nav.documents': 'Documents', 'nav.applications': 'Applications',
    'nav.news': 'News', 'nav.favorites': 'Favorites', 'nav.admin': 'Admin Panel',
    'nav.profile': 'My profile', 'nav.logout': 'Log out',
    'search.placeholder': 'Search documents, news or systems',
    'common.save': 'Save', 'common.cancel': 'Cancel', 'common.delete': 'Delete', 'common.edit': 'Edit',
    'common.add': 'Add', 'common.search': 'Search', 'common.all': 'All',
  },
};

let lang = store.get('lang', 'th');
export const getLang = () => lang;
export function setLang(l) { if (dict[l]) { lang = l; store.set('lang', l); document.documentElement.lang = l; } }
export const t = (k) => dict[lang]?.[k] ?? dict.th[k] ?? k;
