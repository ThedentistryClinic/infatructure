-- =============================================================================
-- RBAC / RLS test suite — runs inside ONE transaction and ROLLS BACK.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rbac_rls_tests.sql
-- Use against a local / development database only (supabase start → db url).
-- Each test impersonates a user by setting request.jwt.claims + role
-- `authenticated`, exactly like PostgREST does, so RLS is really evaluated.
-- =============================================================================
\set QUIET on
begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.results (n serial primary key, label text, ok boolean, detail text);
grant select, insert on t.results to authenticated, anon;
grant usage on sequence t.results_n_seq to authenticated, anon;
create table t.ids (k text primary key, id uuid not null);
grant select on t.ids to authenticated, anon;

create function t.id(p_k text) returns uuid language sql stable as $$ select id from t.ids where k = p_k $$;
create function t.ok(p_label text, p_cond boolean, p_detail text default null) returns void
  language sql as $$ insert into t.results (label, ok, detail) values (p_label, coalesce(p_cond, false), p_detail) $$;
create function t.login(p_k text) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', t.id(p_k), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create function t.anon() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end $$;
create function t.admin() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;
-- number of rows a query returns under the current identity
create function t.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute format('select count(*) from (%s) s', p_sql) into n; return n; end $$;
-- number of rows a DML statement affected
create function t.affected(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute p_sql; get diagnostics n = row_count; return n; end $$;
create function t.expect_error(p_label text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  perform t.ok(p_label, false, 'expected an error, statement succeeded');
exception when others then
  perform t.ok(p_label, true, sqlerrm);
end $$;
create function t.expect_ok(p_label text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  perform t.ok(p_label, true);
exception when others then
  perform t.ok(p_label, false, sqlerrm);
end $$;
-- scalar result of a query, or the error text (never aborts the suite)
create function t.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERROR: ' || sqlerrm; end $$;
grant execute on all functions in schema t to authenticated, anon;

-- ----------------------------------------------------------------- fixtures
insert into t.ids values
  ('super', gen_random_uuid()), ('itadm', gen_random_uuid()), ('mgrS', gen_random_uuid()),
  ('empS', gen_random_uuid()), ('empS2', gen_random_uuid()), ('empH', gen_random_uuid()),
  ('inactive', gen_random_uuid()), ('selfsignup', gen_random_uuid()),
  ('SALES', gen_random_uuid()), ('HR', gen_random_uuid()), ('IT', gen_random_uuid()), ('G', gen_random_uuid()),
  ('d_pub', gen_random_uuid()), ('d_dept', gen_random_uuid()), ('d_spec', gen_random_uuid()),
  ('d_restr', gen_random_uuid()), ('d_restrHR', gen_random_uuid()), ('d_pending', gen_random_uuid()),
  ('d_deleted', gen_random_uuid()), ('d_hr', gen_random_uuid()),
  ('n_all', gen_random_uuid()), ('n_hr', gen_random_uuid()), ('n_draft', gen_random_uuid()), ('n_future', gen_random_uuid()),
  ('a_all', gen_random_uuid()), ('a_mgr', gen_random_uuid()), ('a_hr', gen_random_uuid());

insert into public.departments (id, code, name) values
  (t.id('SALES'), 'SALES', 'ฝ่ายขาย'), (t.id('HR'), 'HR', 'ฝ่ายบุคคล'), (t.id('IT'), 'IT', 'ฝ่ายไอที');

insert into auth.users (id, email, raw_app_meta_data)
select t.id(k), k || '@test.local', jsonb_build_object('provisioned', true, 'department_id', t.id(dept))
from (values ('super','IT'), ('itadm','IT'), ('mgrS','SALES'), ('empS','SALES'), ('empS2','SALES'),
             ('empH','HR'), ('inactive','SALES')) v(k, dept);
-- a user who registered by themselves (no "provisioned" flag)
insert into auth.users (id, email) values (t.id('selfsignup'), 'selfsignup@test.local');

update public.profiles set is_active = false where id = t.id('inactive');
insert into public.user_roles (user_id, role_id)
select t.id(k), r.id from (values ('super','super_admin'), ('itadm','it_admin'), ('mgrS','dept_manager')) v(k, rc)
join public.roles r on r.code = v.rc;

insert into public.groups (id, name) values (t.id('G'), 'Project X');
insert into public.group_members (group_id, user_id) values (t.id('G'), t.id('empH'));

insert into public.documents (id, title, department_id, access_level, status, current_version, owner_id, created_by, file_path, deleted_at) values
  (t.id('d_pub'),     'Public doc',          t.id('SALES'), 'public',     'published', 1, t.id('mgrS'), t.id('mgrS'), t.id('d_pub')     || '/v1-a.pdf', null),
  (t.id('d_dept'),    'Sales dept doc',      t.id('SALES'), 'department', 'published', 1, t.id('mgrS'), t.id('mgrS'), t.id('d_dept')    || '/v1-a.pdf', null),
  (t.id('d_spec'),    'Specific doc',        t.id('SALES'), 'specific',   'published', 1, t.id('mgrS'), t.id('mgrS'), t.id('d_spec')    || '/v1-a.pdf', null),
  (t.id('d_restr'),   'Restricted salary',   t.id('SALES'), 'restricted', 'published', 1, t.id('super'), t.id('super'), t.id('d_restr') || '/v1-a.pdf', null),
  (t.id('d_restrHR'), 'HR restricted',       t.id('HR'),    'restricted', 'published', 1, t.id('empH'), t.id('empH'), t.id('d_restrHR') || '/v1-a.docx', null),
  (t.id('d_pending'), 'Pending doc',         t.id('SALES'), 'department', 'pending',   1, t.id('empS2'), t.id('empS2'), t.id('d_pending') || '/v1-a.pdf', null),
  (t.id('d_deleted'), 'Deleted doc',         t.id('SALES'), 'public',     'published', 1, t.id('mgrS'), t.id('mgrS'), t.id('d_deleted') || '/v1-a.pdf', now()),
  (t.id('d_hr'),      'HR dept doc',         t.id('HR'),    'department', 'published', 1, t.id('empH'), t.id('empH'), t.id('d_hr') || '/v1-a.pdf', null);

insert into public.document_permissions (document_id, principal_type, group_id, can_view) values
  (t.id('d_spec'), 'group', t.id('G'), true);
insert into public.document_permissions (document_id, principal_type, user_id, can_view, can_download) values
  (t.id('d_restr'), 'user', t.id('empS2'), true, true);
-- department grant on a Restricted document must be IGNORED
insert into public.document_permissions (document_id, principal_type, department_id, can_view, can_download) values
  (t.id('d_restr'), 'department', t.id('SALES'), true, true);

insert into storage.objects (bucket_id, name, metadata)
select 'documents', d.file_path, '{"size": 1000, "mimetype": "application/pdf"}'::jsonb from public.documents d;

insert into public.news (id, title, status, publish_at, audience, created_by) values
  (t.id('n_all'),    'All staff news', 'published', now() - interval '1 day', 'all',      t.id('super')),
  (t.id('n_hr'),     'HR only news',   'published', now() - interval '1 day', 'targeted', t.id('super')),
  (t.id('n_draft'),  'Draft news',     'draft',     null,                     'all',      t.id('super')),
  (t.id('n_future'), 'Future news',    'published', now() + interval '2 days','all',      t.id('super'));
insert into public.news_targets (news_id, principal_type, department_id) values (t.id('n_hr'), 'department', t.id('HR'));

insert into public.applications (id, name, url, visibility) values
  (t.id('a_all'), 'PR System', 'https://pr.example.com', 'all'),
  (t.id('a_mgr'), 'Manager Report', 'https://report.example.com', 'restricted'),
  (t.id('a_hr'),  'HR System', 'https://hr.example.com', 'restricted');
insert into public.application_permissions (application_id, principal_type, role_id)
select t.id('a_mgr'), 'role', id from public.roles where code = 'dept_manager';
insert into public.application_permissions (application_id, principal_type, department_id)
values (t.id('a_hr'), 'department', t.id('HR'));

-- ======================================================== ANON (not logged in)
select t.anon();
select t.expect_error('ANON: cannot read documents table', 'select * from public.documents');
select t.expect_error('ANON: cannot read profiles', 'select * from public.profiles');
select t.expect_error('ANON: cannot call my_context()', 'select public.my_context()');
select t.ok('ANON: sees only public settings',
  t.cnt('select 1 from public.system_settings where visibility <> ''public''') = 0
  and t.cnt('select 1 from public.system_settings') > 0);

-- ================================================================ EMPLOYEE empS
select t.login('empS');
select t.ok('EMP: sees public doc',              t.cnt(format('select 1 from documents where id=%L', t.id('d_pub'))) = 1);
select t.ok('EMP: sees own-department doc',      t.cnt(format('select 1 from documents where id=%L', t.id('d_dept'))) = 1);
select t.ok('EMP: no other-department doc',      t.cnt(format('select 1 from documents where id=%L', t.id('d_hr'))) = 0);
select t.ok('EMP: no specific doc (not granted)',t.cnt(format('select 1 from documents where id=%L', t.id('d_spec'))) = 0);
select t.ok('EMP: no restricted doc (dept grant ignored)', t.cnt(format('select 1 from documents where id=%L', t.id('d_restr'))) = 0);
select t.ok('EMP: no pending doc of colleague',  t.cnt(format('select 1 from documents where id=%L', t.id('d_pending'))) = 0);
select t.ok('EMP: no soft-deleted doc',          t.cnt(format('select 1 from documents where id=%L', t.id('d_deleted'))) = 0);
select t.ok('EMP: total visible docs = 2',       t.cnt('select 1 from documents') = 2);
select t.ok('EMP: search does not leak restricted titles', t.cnt('select 1 from documents where search_text like ''%salary%''') = 0);
select t.ok('EMP: no versions of restricted doc',t.cnt(format('select 1 from document_versions where document_id=%L', t.id('d_restr'))) = 0);
select t.ok('EMP: rights on restricted = null',  public.my_document_rights(t.id('d_restr')) is null);
select t.ok('EMP: rights on public = view+download only',
  public.my_document_rights(t.id('d_pub')) = '{"view":true,"download":true,"upload":false,"edit":false,"delete":false,"share":false,"approve":false}'::jsonb);
select t.ok('EMP: can read file of public doc',  t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_pub') || '/%')) = 1);
select t.ok('EMP: cannot read file of restricted doc (direct URL/ID)', t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_restr') || '/%')) = 0);
select t.ok('EMP: cannot read file of other dept', t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_hr') || '/%')) = 0);
select t.ok('EMP: update public doc affects 0 rows', t.affected(format('update documents set title=''hacked'' where id=%L', t.id('d_pub'))) = 0);
select t.expect_error('EMP: cannot create documents (no upload permission)',
  format('insert into documents (title, department_id) values (''x'', %L)', t.id('SALES')));
select t.expect_error('EMP: cannot soft-delete',  format('select public.soft_delete_document(%L)', t.id('d_pub')));
select t.expect_error('EMP: cannot share a doc',  format('insert into document_permissions (document_id, principal_type, user_id) values (%L, ''user'', %L)', t.id('d_dept'), t.id('empS')));
select t.expect_error('EMP: cannot upload file into restricted doc folder',
  format('insert into storage.objects (bucket_id, name) values (''documents'', %L)', t.id('d_restr') || '/evil.pdf'));
select t.expect_error('EMP: cannot attach another doc''s file as version',
  format('select public.add_document_version(%L, %L, ''x.pdf'')', t.id('d_pub'), t.id('d_restr') || '/v1-a.pdf'));
select t.expect_error('EMP: cannot give self super_admin role',
  format('insert into user_roles (user_id, role_id) select %L, id from roles where code=''super_admin''', t.id('empS')));
select t.expect_error('EMP: cannot grant self permission',
  format('insert into user_permissions (user_id, permission_code) values (%L, ''documents.manage_all'')', t.id('empS')));
select t.expect_error('EMP: cannot change own department', format('update profiles set department_id=%L where id=%L', t.id('HR'), t.id('empS')));
select t.expect_error('EMP: cannot activate/deactivate self', format('update profiles set is_active=false where id=%L', t.id('empS')));
select t.expect_ok('EMP: can update own phone',   format('update profiles set phone=''0812345678'' where id=%L', t.id('empS')));
select t.ok('EMP: cannot edit other profile (0 rows)', t.affected(format('update profiles set phone=''x'' where id=%L', t.id('empS2'))) = 0);
select t.ok('EMP: cannot read audit logs',        t.cnt('select 1 from audit_logs') = 0);
select t.ok('EMP: cannot change settings (0 rows)', t.affected('update system_settings set value=''true'' where key=''auth.allow_self_signup''') = 0);
select t.ok('EMP: no admin-only settings',       t.cnt('select 1 from system_settings where visibility=''admin''') = 0);
select t.expect_error('EMP: storage_stats denied', 'select * from public.storage_stats()');
select t.ok('EMP: sees all-staff news',          t.cnt(format('select 1 from news where id=%L', t.id('n_all'))) = 1);
select t.ok('EMP: no HR-targeted news',          t.cnt(format('select 1 from news where id=%L', t.id('n_hr'))) = 0);
select t.ok('EMP: no draft news',                t.cnt(format('select 1 from news where id=%L', t.id('n_draft'))) = 0);
select t.ok('EMP: no scheduled (future) news',   t.cnt(format('select 1 from news where id=%L', t.id('n_future'))) = 0);
select t.expect_error('EMP: cannot create news', format('insert into news (title, department_id) values (''x'', %L)', t.id('SALES')));
select t.expect_error('EMP: cannot mark invisible news read', format('select public.mark_news_read(%L)', t.id('n_hr')));
select t.expect_ok('EMP: can mark visible news read', format('select public.mark_news_read(%L)', t.id('n_all')));
select t.ok('EMP: apps visible = only "all" app', t.cnt('select 1 from applications') = 1
  and t.cnt(format('select 1 from applications where id=%L', t.id('a_all'))) = 1);
select t.expect_error('EMP: cannot track hidden app', format('select public.track_application_open(%L)', t.id('a_mgr')));
select t.expect_error('EMP: cannot add apps', 'insert into applications (name, url) values (''x'',''https://x.com'')');
select t.expect_ok('EMP: can favorite for self', format('insert into favorites (user_id, item_type, item_id) values (%L, ''document'', %L)', t.id('empS'), t.id('d_pub')));
select t.expect_error('EMP: cannot favorite for others', format('insert into favorites (user_id, item_type, item_id) values (%L, ''document'', %L)', t.id('empS2'), t.id('d_pub')));
select t.ok('EMP: cannot publish invisible pending doc (0 rows)', t.affected(format('update documents set status=''published'' where id=%L', t.id('d_pending'))) = 0);

-- ===================================================== EMPLOYEE empS2 (granted)
select t.login('empS2');
select t.ok('EMP2: sees restricted doc via individual grant', t.cnt(format('select 1 from documents where id=%L', t.id('d_restr'))) = 1);
select t.ok('EMP2: can read restricted file', t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_restr') || '/%')) = 1);
select t.ok('EMP2: cannot edit restricted doc', (public.my_document_rights(t.id('d_restr')) ->> 'edit')::boolean = false);
select t.ok('EMP2: sees own pending doc', t.cnt(format('select 1 from documents where id=%L', t.id('d_pending'))) = 1);

-- ================================================================ EMPLOYEE empH
select t.login('empH');
select t.ok('EMP-HR: sees specific doc via group', t.cnt(format('select 1 from documents where id=%L', t.id('d_spec'))) = 1);
select t.ok('EMP-HR: specific via group gives view not download',
  (public.my_document_rights(t.id('d_spec')) ->> 'download')::boolean = false);
select t.ok('EMP-HR: owner sees own restricted doc', t.cnt(format('select 1 from documents where id=%L', t.id('d_restrHR'))) = 1);
select t.ok('EMP-HR: no Sales department doc', t.cnt(format('select 1 from documents where id=%L', t.id('d_dept'))) = 0);
select t.ok('EMP-HR: sees HR-targeted news', t.cnt(format('select 1 from news where id=%L', t.id('n_hr'))) = 1);
select t.ok('EMP-HR: sees HR app', t.cnt(format('select 1 from applications where id=%L', t.id('a_hr'))) = 1);
select t.ok('EMP-HR: .docx restricted file readable only with download right (owner)',
  t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_restrHR') || '/%')) = 1);

-- ============================================================= DEPT MANAGER mgrS
select t.login('mgrS');
select t.ok('MGR: sees dept doc', t.cnt(format('select 1 from documents where id=%L', t.id('d_dept'))) = 1);
select t.ok('MGR: sees pending doc of own dept', t.cnt(format('select 1 from documents where id=%L', t.id('d_pending'))) = 1);
select t.ok('MGR: does NOT see restricted doc of own dept', t.cnt(format('select 1 from documents where id=%L', t.id('d_restr'))) = 0);
select t.ok('MGR: does NOT see other dept doc', t.cnt(format('select 1 from documents where id=%L', t.id('d_hr'))) = 0);
select t.ok('MGR: can edit dept doc', t.affected(format('update documents set description=''updated'' where id=%L', t.id('d_dept'))) = 1);
select t.ok('MGR: cannot edit other dept doc', t.affected(format('update documents set description=''x'' where id=%L', t.id('d_hr'))) = 0);
select t.expect_error('MGR: cannot change status/file columns directly (RPC only)', format('update documents set status=''rejected'', file_path=''x'' where id=%L', t.id('d_dept')));
select t.expect_error('MGR: cannot un-delete by direct update', format('update documents set deleted_at=now() where id=%L', t.id('d_dept')));
select t.expect_error('MGR: cannot move doc to other department', format('update documents set department_id=%L where id=%L', t.id('HR'), t.id('d_dept')));
select t.expect_ok('MGR: approve pending doc', format('select public.review_document(%L, true, ''ok'')', t.id('d_pending')));
select t.expect_error('MGR: cannot create doc for other department', format('insert into documents (title, department_id) values (''x'', %L)', t.id('HR')));
select t.ok('MGR: sees manager-only app', t.cnt(format('select 1 from applications where id=%L', t.id('a_mgr'))) = 1);
select t.ok('MGR: cannot read audit logs', t.cnt('select 1 from audit_logs') = 0);
select t.expect_ok('MGR: soft delete dept doc', format('select public.soft_delete_document(%L)', t.id('d_dept')));
select t.ok('MGR: still sees deleted doc (trash)', t.cnt(format('select 1 from documents where id=%L and deleted_at is not null', t.id('d_dept'))) = 1);
select t.ok('MGR: hard delete affects 0 rows', t.affected(format('delete from documents where id=%L', t.id('d_dept'))) = 0);
select t.expect_ok('MGR: restore doc', format('select public.restore_document(%L)', t.id('d_dept')));
select t.expect_error('MGR: cannot pin news / create news without permission',
  format('insert into news (title, department_id) values (''x'', %L)', t.id('SALES')));

-- Upload flow (document + storage object + version)
select t.expect_ok('MGR: INSERT ... RETURNING works (as used by the web app)',
  format('insert into documents (title, department_id) values (''tmp'', %L) returning id', t.id('SALES')));
select t.expect_ok('MGR: create document in own dept',
  format('insert into documents (id, title, department_id, access_level) values (%L, ''New SOP'', %L, ''department'')',
         '11111111-1111-1111-1111-111111111111', t.id('SALES')));
select t.expect_ok('MGR: upload object into own doc folder',
  'insert into storage.objects (bucket_id, name, metadata) values (''documents'', ''11111111-1111-1111-1111-111111111111/v1-sop.pdf'', ''{"size": 2048, "mimetype": "application/pdf"}'')');
select t.ok('MGR: add_document_version returns 1',
  t.val($q$select public.add_document_version('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111/v1-sop.pdf', 'sop.pdf')$q$) = '1');
select t.ok('MGR: new doc published with size from storage',
  t.cnt('select 1 from documents where id=''11111111-1111-1111-1111-111111111111'' and status=''published'' and file_size=2048') = 1);

select t.login('empS');
select t.ok('EMP: sees newly published dept doc', t.cnt('select 1 from documents where id=''11111111-1111-1111-1111-111111111111''') = 1);
select t.ok('EMP: sees approved doc', t.cnt(format('select 1 from documents where id=%L', t.id('d_pending'))) = 1);

-- ================================================================ IT ADMIN itadm
select t.login('itadm');
select t.ok('IT: no automatic access to restricted docs', t.cnt(format('select 1 from documents where id in (%L,%L)', t.id('d_restr'), t.id('d_restrHR'))) = 0);
select t.ok('IT: no access to other dept docs', t.cnt(format('select 1 from documents where id=%L', t.id('d_hr'))) = 0);
select t.ok('IT: cannot read restricted file', t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_restr') || '/%')) = 0);
select t.ok('IT: can read audit logs', t.cnt('select 1 from audit_logs') > 0);
select t.ok('IT: storage_stats allowed', t.cnt('select * from public.storage_stats()') >= 1);
select t.expect_ok('IT: can assign dept_manager to employee',
  format('insert into user_roles (user_id, role_id) select %L, id from roles where code=''dept_manager''', t.id('empS2')));
select t.expect_error('IT: cannot assign super_admin',
  format('insert into user_roles (user_id, role_id) select %L, id from roles where code=''super_admin''', t.id('empS')));
select t.expect_error('IT: cannot assign it_admin (same level)',
  format('insert into user_roles (user_id, role_id) select %L, id from roles where code=''it_admin''', t.id('empS')));
select t.expect_error('IT: cannot assign roles to self',
  format('insert into user_roles (user_id, role_id) select %L, id from roles where code=''dept_manager''', t.id('itadm')));
select t.ok('IT: cannot remove super admin role (0 rows)',
  t.affected(format('delete from user_roles where user_id=%L', t.id('super'))) = 0);
select t.ok('IT: cannot deactivate super admin (0 rows)', t.affected(format('update profiles set is_active=false where id=%L', t.id('super'))) = 0);
select t.ok('IT: can deactivate employee', t.affected(format('update profiles set is_active=false where id=%L', t.id('empS2'))) = 1);
select t.expect_error('IT: cannot edit role->permission matrix',
  'insert into role_permissions (role_id, permission_code) select id, ''documents.manage_all'' from roles where code=''it_admin''');
select t.expect_error('IT: cannot grant individual permissions',
  format('insert into user_permissions (user_id, permission_code) values (%L, ''audit.view'')', t.id('empS')));
select t.ok('IT: cannot change settings (0 rows)', t.affected('update system_settings set value=''true'' where key=''auth.allow_self_signup''') = 0);
select t.expect_error('IT: audit logs are read-only', 'delete from audit_logs');

-- ============================================================ INACTIVE account
select t.login('empS2');   -- deactivated above by IT
select t.ok('INACTIVE: sees no documents', t.cnt('select 1 from documents') = 0);
select t.ok('INACTIVE: sees no news', t.cnt('select 1 from news') = 0);
select t.ok('INACTIVE: sees no apps', t.cnt('select 1 from applications') = 0);
select t.ok('INACTIVE: cannot read restricted file any more', t.cnt(format('select 1 from storage.objects where name like %L', t.id('d_restr') || '/%')) = 0);
select t.ok('INACTIVE: has no effective permissions', (public.my_context() -> 'permissions') = '[]'::jsonb);
select t.login('selfsignup');
select t.ok('SELF-SIGNUP: account inactive by default', (public.my_context() -> 'profile' ->> 'is_active')::boolean = false);
select t.ok('SELF-SIGNUP: sees no documents', t.cnt('select 1 from documents') = 0);

-- ============================================================== SUPER ADMIN
select t.login('super');
select t.ok('SUPER: sees every document incl. restricted & deleted', t.cnt('select 1 from documents') = 10);
select t.expect_ok('SUPER: grant individual permission news.create to empS',
  format('insert into user_permissions (user_id, permission_code) values (%L, ''news.create'')', t.id('empS')));
select t.expect_ok('SUPER: grant individual permission documents.upload to empS',
  format('insert into user_permissions (user_id, permission_code) values (%L, ''documents.upload'')', t.id('empS')));
select t.expect_ok('SUPER: enable approval workflow', 'update system_settings set value=''true'' where key=''documents.approval_required''');
select t.expect_error('SUPER: cannot remove the last super admin',
  format('delete from user_roles where user_id=%L', t.id('super')));
select t.ok('SUPER: hard delete of trashed doc', t.affected(format('delete from documents where id=%L', t.id('d_deleted'))) = 1);
select t.ok('SUPER: audit log recorded permission changes', t.cnt('select 1 from audit_logs where action=''user_permissions.insert''') = 2);
select t.ok('SUPER: audit log recorded role assignment', t.cnt('select 1 from audit_logs where action=''user_roles.insert''') >= 1);
select t.ok('SUPER: audit log recorded soft delete', t.cnt('select 1 from audit_logs where action=''document.soft_delete''') = 1);

-- ============================================== individual permissions in action
select t.login('empS');
select t.expect_ok('EMP+news.create: create department news',
  format('insert into news (id, title, department_id, status, publish_at) values (''22222222-2222-2222-2222-222222222222'', ''Sales update'', %L, ''published'', now())', t.id('SALES')));
select t.expect_error('EMP+news.create: cannot pin', 'update news set is_pinned=true where id=''22222222-2222-2222-2222-222222222222''');
select t.expect_error('EMP+news.create: cannot post for other dept',
  format('insert into news (title, department_id) values (''x'', %L)', t.id('HR')));
select t.ok('EMP+news.create: cannot edit others'' news', t.affected(format('update news set title=''x'' where id=%L', t.id('n_all'))) = 0);
select t.expect_ok('EMP+upload: create doc', format('insert into documents (id, title, department_id) values (''33333333-3333-3333-3333-333333333333'', ''Draft by emp'', %L)', t.id('SALES')));
select t.expect_ok('EMP+upload: upload object',
  'insert into storage.objects (bucket_id, name, metadata) values (''documents'', ''33333333-3333-3333-3333-333333333333/v1-x.pdf'', ''{"size": 10, "mimetype": "application/pdf"}'')');
select t.ok('EMP+upload: version 1 created',
  t.val($q$select public.add_document_version('33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333/v1-x.pdf', 'x.pdf')$q$) = '1');
select t.ok('EMP+upload: requires approval -> pending',
  t.cnt('select 1 from documents where id=''33333333-3333-3333-3333-333333333333'' and status=''pending''') = 1);
select t.expect_error('EMP+upload: cannot approve own doc', 'select public.review_document(''33333333-3333-3333-3333-333333333333'', true)');
select t.login('empH');
select t.ok('EMP-HR: cannot see pending doc of Sales', t.cnt('select 1 from documents where id=''33333333-3333-3333-3333-333333333333''') = 0);
select t.login('mgrS');
select t.expect_ok('MGR: approves employee upload', 'select public.review_document(''33333333-3333-3333-3333-333333333333'', true)');

-- ================================================================== results
select t.admin();
\set QUIET off
\pset pager off
select n, case when ok then 'PASS' else 'FAIL' end as result, label,
       case when ok then '' else coalesce(detail, '') end as detail
from t.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed, count(*) as total from t.results;
do $$
begin
  if exists (select 1 from t.results where not ok) then
    raise warning 'RBAC/RLS TESTS FAILED';
  else
    raise notice 'ALL RBAC/RLS TESTS PASSED';
  end if;
end $$;
rollback;
