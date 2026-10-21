# Test Cases — สิทธิ์ผู้ใช้แต่ละ Role

มีการทดสอบ 2 ชุด

1. **ชุดอัตโนมัติระดับฐานข้อมูล** `supabase/tests/rbac_rls_tests.sql` — 127 กรณี
   จำลองผู้ใช้แต่ละ Role ด้วย JWT claims + role `authenticated` (เหมือน PostgREST) แล้วตรวจ RLS, trigger, RPC และ Storage policy จริง
   รันใน transaction เดียวแล้ว ROLLBACK ไม่ทิ้งข้อมูล
2. **ชุดทดสอบผ่านหน้าเว็บ (UI)** — รายการตรวจด้านล่าง ใช้ทดสอบหลัง deploy บน project Development/Staging ด้วยผู้ใช้ Demo

## วิธีรันชุดฐานข้อมูล

```bash
supabase start                 # หรือใช้ connection string ของ project Development
supabase db reset              # ลง migrations ทั้งหมด
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
     -v ON_ERROR_STOP=1 -f supabase/tests/rbac_rls_tests.sql
# ผลลัพธ์บรรทัดสุดท้าย: ALL RBAC/RLS TESTS PASSED
```

> ห้ามรันกับ Production — สคริปต์สร้างผู้ใช้ทดสอบใน `auth.users` ชั่วคราว (แม้จะ rollback ก็ตาม)

## ข้อมูลทดสอบในชุดฐานข้อมูล

| ผู้ใช้ | Role | แผนก | หมายเหตุ |
|---|---|---|---|
| super | Super Admin | IT | |
| itadm | IT Admin | IT | |
| mgrS | Department Manager | SALES | |
| empS | Employee | SALES | ภายหลังได้สิทธิ์รายบุคคล news.create, documents.upload |
| empS2 | Employee | SALES | ได้สิทธิ์รายบุคคลในเอกสาร Restricted, ถูก IT ปิดบัญชีระหว่างทดสอบ |
| empH | Employee | HR | สมาชิกกลุ่ม Project X |
| selfsignup | – | – | สมัครเอง (ไม่มี provisioned) |

| เอกสาร | ระดับ | แผนก | สิทธิ์เพิ่มเติม |
|---|---|---|---|
| d_pub | Public | SALES | – |
| d_dept | Department | SALES | – |
| d_spec | Specific | SALES | กลุ่ม Project X: view |
| d_restr | Restricted | SALES | empS2: view+download, **แผนก SALES: view+download (ต้องไม่มีผล)** |
| d_restrHR | Restricted | HR | เจ้าของ empH |
| d_pending | Department | SALES | สถานะรออนุมัติ |
| d_deleted | Public | SALES | อยู่ในถังขยะ |
| d_hr | Department | HR | – |

## กรณีทดสอบ (ชุดฐานข้อมูล)

### ไม่ได้เข้าสู่ระบบ (anon)
- อ่าน documents / profiles ไม่ได้, เรียก `my_context()` ไม่ได้
- อ่าน system_settings ได้เฉพาะ visibility = public

### Employee
- เห็นเอกสาร Public และ Department ของแผนกตนเอง (รวม 2 รายการ) เท่านั้น
- ไม่เห็น: เอกสารแผนกอื่น, Specific ที่ไม่ได้รับสิทธิ์, Restricted (แม้มีสิทธิ์ระดับแผนก), เอกสารรออนุมัติของคนอื่น, ถังขยะ
- ค้นหาด้วยคำในชื่อเอกสารลับแล้วไม่พบ (ไม่รั่วชื่อ/เมตาดาต้า), อ่าน document_versions ของเอกสารลับไม่ได้
- `my_document_rights` ของเอกสาร Public = view+download เท่านั้น, ของ Restricted = null
- อ่านไฟล์ใน Storage ได้เฉพาะเอกสารที่มีสิทธิ์ — เปลี่ยน path/ID ไปเอกสารลับแล้วไม่ได้
- แก้ไข/สร้าง/ลบเอกสาร, แชร์สิทธิ์, อัปโหลดไฟล์ลง folder เอกสารลับ, ผูกไฟล์ของเอกสารอื่นเป็นเวอร์ชัน → ถูกปฏิเสธ
- มอบ role super_admin หรือ permission ให้ตนเอง → ถูกปฏิเสธ
- เปลี่ยนแผนก/สถานะบัญชีของตนเอง → ถูกปฏิเสธ; แก้เบอร์โทรตนเอง → ได้; แก้โปรไฟล์คนอื่น → 0 แถว
- อ่าน audit_logs, การตั้งค่าระดับ admin, `storage_stats` → ไม่ได้
- ข่าว: เห็นข่าวทุกคน; ไม่เห็นข่าวที่ส่งเฉพาะ HR, ฉบับร่าง, ข่าวตั้งเวลาในอนาคต; mark read ข่าวที่มองไม่เห็นไม่ได้
- ระบบงาน: เห็นเฉพาะระบบที่เปิดให้ทุกคน; บันทึกการเปิดระบบที่ซ่อนไม่ได้; เพิ่มระบบไม่ได้
- รายการโปรด: เพิ่มของตนเองได้, เพิ่มแทนผู้อื่นไม่ได้

### Employee ที่ได้รับสิทธิ์รายบุคคล / กลุ่ม
- empS2 เห็นและดาวน์โหลดเอกสาร Restricted ที่ได้รับสิทธิ์ แต่แก้ไขไม่ได้
- empH เห็นเอกสาร Specific ผ่านกลุ่ม (view แต่ไม่มี download), เห็นข่าวและระบบเฉพาะ HR
- empS + `news.create`: สร้างข่าวแผนกตนเองได้, ปักหมุดไม่ได้, โพสต์ในนามแผนกอื่นไม่ได้, แก้ข่าวคนอื่นไม่ได้
- empS + `documents.upload` + เปิด approval: เอกสารที่อัปโหลดเป็น "รออนุมัติ", อนุมัติเอกสารตนเองไม่ได้, พนักงานแผนกอื่นมองไม่เห็นจนกว่าจะอนุมัติ

### Department Manager
- เห็นและแก้เอกสารของแผนกตนเอง รวมเอกสารรออนุมัติ; ไม่เห็น Restricted ของแผนกตนเอง; ไม่เห็นเอกสารแผนกอื่น
- แก้คอลัมน์สถานะ/ไฟล์/ถังขยะโดยตรงไม่ได้ (ต้องผ่าน RPC), ย้ายเอกสารไปแผนกอื่นไม่ได้
- อนุมัติเอกสาร, ย้ายไปถังขยะ, กู้คืนได้; ลบถาวรไม่ได้; สร้างเอกสารให้แผนกอื่นไม่ได้
- INSERT … RETURNING (แบบที่หน้าเว็บใช้) ทำงานได้; flow อัปโหลด: สร้างเอกสาร → อัปไฟล์ → `add_document_version` → published และขนาดไฟล์มาจาก Storage

### IT Admin
- ไม่เห็นเอกสาร Restricted และเอกสารแผนกอื่นโดยอัตโนมัติ, อ่านไฟล์เอกสารลับไม่ได้
- อ่าน audit_logs และ storage_stats ได้; ลบ audit_logs ไม่ได้
- มอบ Dept Manager ให้พนักงานได้; มอบ Super Admin / IT Admin ไม่ได้; มอบ role ให้ตนเองไม่ได้
- ถอน role ของ Super Admin / ปิดบัญชี Super Admin ไม่ได้; ปิดบัญชีพนักงานได้
- แก้ role-permission matrix, มอบ user_permissions, แก้ system_settings ไม่ได้

### บัญชีถูกปิด / สมัครเอง
- บัญชีที่ถูกปิด: ไม่เห็นเอกสาร ข่าว ระบบ และไฟล์ใด ๆ, permissions ว่าง
- บัญชีที่สมัครเอง (ไม่ได้ provisioned) เป็น inactive โดยค่าเริ่มต้นและไม่เห็นข้อมูล

### Super Admin
- เห็นเอกสารทั้งหมด รวม Restricted และถังขยะ; ลบถาวรเอกสารในถังขยะได้
- มอบสิทธิ์รายบุคคลได้, เปิด workflow อนุมัติได้
- ถอน Super Admin คนสุดท้ายไม่ได้
- Audit log บันทึกการให้สิทธิ์, การมอบ role, การลบเอกสาร

## รายการตรวจผ่านหน้าเว็บ (UI)

ผลการทดสอบอัตโนมัติด้วย Chromium บน stack ทดสอบในเครื่อง: **75/75 ผ่าน** (ดู README หัวข้อ "สิ่งที่ทดสอบแล้ว")

| # | ผู้ใช้ | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|---|
| 1 | – | เปิดเว็บโดยไม่ login / เปิดลิงก์ลึก | ไปหน้า Login พร้อม `next=` |
| 2 | – | รหัสผ่านผิด | ข้อความ "…ไม่ถูกต้อง" เป็นภาษาไทย |
| 3 | Super Admin | Dashboard | ทักทาย, เมนูด่วน, ข่าวปักหมุด, กิจกรรม, เมนู Admin |
| 4 | Super Admin | อัปโหลด PDF ระดับ Public + วันหมดอายุ | สำเร็จ, แสดงในตาราง, มีป้ายใกล้หมดอายุ |
| 5 | Super Admin | อัปโหลดไฟล์ .exe | ถูกปฏิเสธก่อนส่ง |
| 6 | Super Admin | Preview / Download / อัปโหลดเวอร์ชัน 2 | Signed URL, ชื่อไฟล์ถูกต้อง, ประวัติเวอร์ชันครบ |
| 7 | Super Admin | อัปโหลดเอกสาร Restricted แล้วให้สิทธิ์รายบุคคล | หน้าต่างสิทธิ์เปิดอัตโนมัติ, เลือกได้เฉพาะ "ผู้ใช้" |
| 8 | Super Admin | ถังขยะ → กู้คืน → ลบ → ลบถาวร | ไฟล์ใน Storage ถูกลบด้วย |
| 9 | Super Admin | มุมมองการ์ด, ค้นหาเลขที่เอกสาร | ได้ผลลัพธ์ถูกต้อง |
| 10 | Super Admin | เพิ่มระบบเฉพาะแผนก HR, เลื่อนลำดับ | บันทึกได้, ลำดับเปลี่ยน |
| 11 | Super Admin | สร้างข่าวเฉพาะ HR ที่มี `<script>` / `onerror` | เผยแพร่ได้, HTML ถูก sanitize |
| 12 | Super Admin | ข่าวด่วนพร้อมไฟล์แนบ, ฉบับร่าง | ดาวน์โหลดไฟล์แนบได้ |
| 13 | Super Admin | เปิดทุกแท็บ Admin | ไม่มี error state, Audit มีเหตุการณ์เอกสาร/สิทธิ์ |
| 14 | Super Admin | เพิ่มผู้ใช้ (Edge Function), ปิดบัญชี | สำเร็จ |
| 15 | Super Admin | แก้ชื่อบริษัทใน Settings, Logout | ชื่อใหม่แสดงบนหน้า Login |
| 16 | Employee | Dashboard | ไม่มีเมนู Admin, ไม่เห็นข่าว HR, เห็นเอกสาร Restricted ที่ได้รับสิทธิ์ |
| 17 | Employee | เปิด URL เอกสาร/ข่าวของ HR โดยตรง | "ไม่พบ… หรือไม่มีสิทธิ์" ไม่แสดงชื่อเอกสาร |
| 18 | Employee | เปิด `#/admin/users` | ข้อความไม่มีสิทธิ์ |
| 19 | Employee | ค้นหา "HR" | ไม่พบเอกสาร/ข่าวที่ไม่มีสิทธิ์ |
| 20 | Employee | เปิดระบบ PR | เปิดแท็บใหม่, ขึ้นใน "ระบบที่ใช้บ่อย" |
| 21 | Employee | อ่านข่าว, แก้เบอร์โทร | จำนวนผู้อ่านเพิ่ม, บันทึกได้ |
| 22 | HR Employee | Dashboard / ระบบงาน / เอกสารลับฝ่ายขาย | เห็นข่าวและระบบ HR, เปิดเอกสารลับไม่ได้ |
| 23 | Dept Manager | เปิดเอกสาร Restricted ของแผนกตนเอง / อัปโหลด | เปิดไม่ได้ / เลือกได้เฉพาะแผนกตนเอง |
| 24 | IT Admin | เปิดเอกสาร Restricted / แก้ Super Admin / ติ๊ก role Super Admin | ทุกกรณีถูกปฏิเสธ |
| 25 | Employee (มือถือ 390px) | Dashboard, เมนู, เอกสาร | ไม่มี scroll แนวนอน, เมนูเลื่อนออก, เอกสารแสดงเป็นการ์ด |
