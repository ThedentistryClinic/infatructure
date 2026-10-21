-- =============================================================================
-- DEMO SEED — for development / demo environments ONLY.
-- Refuses to run unless system_settings 'system.environment' is not 'production'.
--   update system_settings set value = '"development"' where key = 'system.environment';
-- Users are NOT created here: create them in the Admin Panel (or Supabase Auth)
-- so passwords never live in SQL files.
-- =============================================================================
begin;  -- single transaction: the guard below aborts everything

do $$
begin
  if coalesce((select value #>> '{}' from public.system_settings where key = 'system.environment'), 'production') = 'production' then
    raise exception 'Demo seed blocked: system.environment is "production". Set it to "development" on a NON-production project first.';
  end if;
end $$;

insert into public.departments (code, name, name_en, sort_order) values
  ('MGT',  'ฝ่ายบริหาร',      'Management',   10),
  ('HR',   'ฝ่ายทรัพยากรบุคคล', 'Human Resources', 20),
  ('IT',   'ฝ่ายเทคโนโลยีสารสนเทศ', 'Information Technology', 30),
  ('FIN',  'ฝ่ายการเงินและบัญชี', 'Finance & Accounting', 40),
  ('SALES','ฝ่ายขาย',         'Sales',        50),
  ('OPS',  'ฝ่ายปฏิบัติการ',    'Operations',   60)
on conflict (code) do nothing;

insert into public.document_categories (name, name_en, sort_order) values
  ('นโยบายบริษัท', 'Company Policy', 10),
  ('ระเบียบและขั้นตอนการทำงาน', 'Procedures', 20),
  ('แบบฟอร์ม', 'Forms', 30),
  ('คู่มือการใช้งาน', 'Manuals', 40),
  ('ประกาศ / คำสั่ง', 'Announcements', 50);

insert into public.applications (name, description, url, icon, color, category, is_quick_access, sort_order) values
  ('PR System',        'ระบบขอซื้อ (Purchase Request)',       'https://pr.example.com',        'cart',      '#1E3A8A', 'Finance',    true,  10),
  ('Promotion System', 'ระบบจัดการโปรโมชัน',                  'https://promotion.example.com', 'tag',       '#7C3AED', 'Operations', true,  20),
  ('Repair System',    'ระบบแจ้งซ่อม',                        'https://repair.example.com',    'wrench',    '#EA580C', 'IT',         true,  30),
  ('Microsoft 365',    'Outlook, Teams, OneDrive',            'https://www.office.com',        'mail',      '#2563EB', 'IT',         true,  40),
  ('SharePoint',       'พื้นที่ทำงานร่วมกัน',                   'https://www.office.com/launch/sharepoint', 'folder', '#0F766E', 'IT', false, 50),
  ('HR System',        'ลางาน สลิปเงินเดือน ข้อมูลพนักงาน',      'https://hr.example.com',        'users',     '#059669', 'HR',         false, 60),
  ('Inventory System', 'ระบบคลังสินค้า',                       'https://inventory.example.com', 'box',       '#B45309', 'Operations', false, 70),
  ('ERP / Accounting', 'ระบบบัญชีและ ERP',                     'https://erp.example.com',       'chart',     '#0E7490', 'Finance',    false, 80);

insert into public.news (title, summary, content_html, category, priority, is_pinned, status, publish_at) values
  ('[DEMO] ยินดีต้อนรับสู่ Intranet Portal', 'ศูนย์กลางข้อมูล ข่าวสาร เอกสาร และระบบงานของบริษัท',
   '<p>นี่คือข่าวตัวอย่างสำหรับสภาพแวดล้อม Demo เท่านั้น</p>', 'company', 'important', true, 'published', now()),
  ('[DEMO] ปิดปรับปรุงระบบอีเมลวันเสาร์นี้', 'ระบบอีเมลจะไม่สามารถใช้งานได้ช่วง 22:00–02:00 น.',
   '<p>ข่าวตัวอย่างประเภท Maintenance Notice</p>', 'maintenance', 'urgent', false, 'published', now()),
  ('[DEMO] กิจกรรมวันครอบครัวประจำปี', 'ขอเชิญพนักงานทุกท่านร่วมกิจกรรม',
   '<p>ข่าวตัวอย่างประเภท Event</p>', 'event', 'normal', false, 'published', now());
update public.news set event_start_at = now() + interval '14 days', event_location = 'ห้องประชุมใหญ่'
 where title = '[DEMO] กิจกรรมวันครอบครัวประจำปี';

commit;
