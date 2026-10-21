-- =============================================================================
-- Company Intranet Portal — 0006 Reference data (required in every environment)
-- Roles, permission catalogue, default role → permission mapping, settings.
-- This is system configuration, NOT demo data. Demo data: supabase/seed/.
-- =============================================================================

insert into public.roles (code, name, name_en, description, level, is_system) values
  ('super_admin',  'ผู้ดูแลระบบสูงสุด', 'Super Admin',        'จัดการทุกส่วนของระบบ',                       100, true),
  ('it_admin',     'ผู้ดูแลระบบไอที',   'IT Admin',           'จัดการผู้ใช้และสิทธิ์ตามขอบเขต ดูแลระบบ',          80, true),
  ('dept_manager', 'ผู้จัดการแผนก',     'Department Manager', 'จัดการเอกสารของแผนกและอนุมัติเอกสาร',            50, true),
  ('employee',     'พนักงาน',          'Employee',           'ดูข่าวสาร เอกสาร และระบบที่ได้รับอนุญาต',          10, true)
on conflict (code) do nothing;

insert into public.permissions (code, name, description, category) values
  ('users.view',                          'ดูรายชื่อผู้ใช้และบทบาท',         'ดูข้อมูลผู้ใช้ บทบาท และกลุ่มในหน้า Admin',                 'users'),
  ('users.manage',                        'จัดการผู้ใช้',                  'เพิ่มผู้ใช้ ปิด/เปิดบัญชี กำหนดแผนก (ผู้ใช้ระดับต่ำกว่า)',      'users'),
  ('roles.assign',                        'กำหนดบทบาทให้ผู้ใช้',            'มอบ/ถอนบทบาทที่ต่ำกว่าระดับของตนเอง',                      'users'),
  ('roles.manage',                        'จัดการบทบาท',                  'สร้าง/แก้ไขบทบาท',                                     'users'),
  ('departments.manage',                  'จัดการแผนก',                   'เพิ่ม แก้ไข ลบแผนก',                                    'organization'),
  ('groups.manage',                       'จัดการกลุ่มผู้ใช้',               'เพิ่ม แก้ไข ลบกลุ่ม และสมาชิก',                           'organization'),
  ('doc_categories.manage',               'จัดการหมวดหมู่เอกสาร',           'เพิ่ม แก้ไข ลบหมวดหมู่เอกสาร',                             'documents'),
  ('documents.upload',                    'อัปโหลดเอกสาร',                'สร้างเอกสารใหม่ของแผนกตนเอง',                            'documents'),
  ('documents.upload_any_department',     'อัปโหลดเอกสารทุกแผนก',          'สร้าง/ย้ายเอกสารไปแผนกใดก็ได้',                          'documents'),
  ('documents.approve',                   'อนุมัติเอกสาร',                 'อนุมัติเอกสารที่รออนุมัติในแผนกของตน',                     'documents'),
  ('documents.manage_all',                'จัดการเอกสารทั้งหมด',            'เข้าถึงและจัดการเอกสารทุกฉบับ รวมถึงเอกสาร Restricted',      'documents'),
  ('apps.manage',                         'จัดการลิงก์ระบบ',               'เพิ่ม แก้ไข ลบ เรียงลำดับ และกำหนดสิทธิ์ลิงก์ระบบ',           'applications'),
  ('news.create',                         'สร้างข่าวของแผนก',              'สร้าง/แก้ไขข่าวของแผนกตนเอง (ที่ตนสร้าง)',                 'news'),
  ('news.manage',                         'จัดการข่าวทั้งหมด',              'สร้าง แก้ไข ลบ ปักหมุดข่าวทุกข่าว',                        'news'),
  ('audit.view',                          'ดูประวัติการใช้งาน',             'ดู Audit Logs',                                       'system'),
  ('storage.view',                        'ดูการใช้พื้นที่จัดเก็บ',           'ดูสถิติ File Storage',                                 'system'),
  ('settings.manage',                     'ตั้งค่าระบบ',                   'แก้ไข System Settings',                               'system')
on conflict (code) do nothing;

-- Default mapping. Super Admin implicitly has all permissions (see has_permission).
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
join (values
  ('it_admin', 'users.view'), ('it_admin', 'users.manage'), ('it_admin', 'roles.assign'),
  ('it_admin', 'groups.manage'), ('it_admin', 'doc_categories.manage'),
  ('it_admin', 'audit.view'), ('it_admin', 'storage.view'), ('it_admin', 'documents.upload'),
  ('dept_manager', 'documents.upload'), ('dept_manager', 'documents.approve')
) as m(role_code, perm) on m.role_code = r.code
join public.permissions p on p.code = m.perm
on conflict do nothing;

insert into public.system_settings (key, value, description, visibility) values
  ('company.name',                  '"Company Intranet Portal"', 'ชื่อที่แสดงบนหน้า Login และ Header',              'public'),
  ('company.logo_url',              '""',                         'URL โลโก้ (ไฟล์สาธารณะ เช่น /assets/logo.svg)',    'public'),
  ('auth.login_email_domain',       '""',                         'โดเมนที่เติมให้อัตโนมัติเมื่อกรอก Username (เช่น company.co.th)', 'public'),
  ('auth.allow_self_signup',        'false',                      'อนุญาตให้สมัครสมาชิกเอง (ต้องเปิดใน Supabase Auth ด้วย)', 'public'),
  ('auth.microsoft_enabled',        'false',                      'แสดงปุ่มเข้าสู่ระบบด้วย Microsoft 365 (Entra ID)',  'public'),
  ('auth.sso_auto_activate',        'false',                      'เปิดใช้งานบัญชี SSO ใหม่อัตโนมัติ',                 'admin'),
  ('documents.approval_required',   'false',                      'เอกสารที่อัปโหลดโดยผู้ที่ไม่ใช่ผู้จัดการแผนกต้องรออนุมัติ', 'authenticated'),
  ('documents.expiry_warning_days', '30',                         'แจ้งเตือนเอกสารที่จะหมดอายุภายใน (วัน)',              'authenticated'),
  ('documents.max_file_mb',         '50',                         'ขนาดไฟล์สูงสุด (MB) ตรวจฝั่งเว็บ — ต้องไม่เกินค่าของ Bucket', 'authenticated'),
  ('documents.allowed_extensions',  '["pdf","doc","docx","xls","xlsx","ppt","pptx","jpg","jpeg","png","txt","csv","zip"]',
                                    'นามสกุลไฟล์ที่อนุญาต (ต้องสอดคล้องกับ allowed_mime_types ของ Bucket)', 'authenticated'),
  ('documents.types',               '["นโยบาย","ระเบียบปฏิบัติ","คู่มือ","แบบฟอร์ม","ประกาศ","รายงาน","สัญญา","อื่น ๆ"]',
                                    'ประเภทเอกสาร',                                      'authenticated'),
  ('storage.signed_url_ttl_seconds','120',                        'อายุ Signed URL (วินาที)',                          'authenticated'),
  ('news.archive_visible',          'true',                       'ข่าวที่เลยวันสิ้นสุดแสดงผลยังค้นหาย้อนหลังได้',         'authenticated'),
  ('news.new_badge_days',           '3',                          'แสดงป้าย New สำหรับข่าวภายในกี่วัน',                 'authenticated'),
  ('apps.categories',               '["IT","HR","Finance","Operations","Management","Other"]', 'หมวดหมู่ลิงก์ระบบ', 'authenticated'),
  ('system.environment',            '"production"',               'development | staging | production (ป้องกันการรัน demo seed)', 'admin')
on conflict (key) do nothing;
