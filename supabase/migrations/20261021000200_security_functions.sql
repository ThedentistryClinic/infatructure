-- =============================================================================
-- Company Intranet Portal — 0002 Security helper functions, guards, audit
-- All helpers are SECURITY DEFINER with an empty search_path and live in the
-- `private` schema, which is not exposed through the Data API.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity helpers
-- -----------------------------------------------------------------------------
create or replace function private.is_active_user()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active);
$$;

create or replace function private.user_department()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.department_id from public.profiles p where p.id = auth.uid() and p.is_active;
$$;

create or replace function private.has_role(p_code text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_active_user() and exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.code = p_code
  );
$$;

create or replace function private.is_super_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_role('super_admin');
$$;

-- Highest role level of a user (0 when no role)
create or replace function private.user_level(p_user uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce(max(r.level), 0)
  from public.user_roles ur join public.roles r on r.id = ur.role_id
  where ur.user_id = p_user;
$$;

create or replace function private.my_level()
returns integer
language sql stable security definer set search_path = ''
as $$
  select case when private.is_active_user() then private.user_level(auth.uid()) else 0 end;
$$;

-- Permission = from any assigned role OR individually granted (not expired).
-- Super Admin implicitly has every permission.
create or replace function private.has_permission(p_code text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_active_user() and (
       private.is_super_admin()
    or exists (
         select 1 from public.user_roles ur
         join public.role_permissions rp on rp.role_id = ur.role_id
         where ur.user_id = auth.uid() and rp.permission_code = p_code)
    or exists (
         select 1 from public.user_permissions up
         where up.user_id = auth.uid() and up.permission_code = p_code
           and (up.expires_at is null or up.expires_at > now()))
  );
$$;

create or replace function private.in_group(p_group uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.group_members gm
    join public.groups g on g.id = gm.group_id
    where gm.group_id = p_group and gm.user_id = auth.uid() and g.is_active
  );
$$;

-- Department manager of p_dept: has the dept_manager role and belongs to that
-- department, or is recorded as departments.manager_id.
create or replace function private.is_dept_manager(p_dept uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_dept is not null and private.is_active_user() and (
       (private.has_role('dept_manager') and private.user_department() = p_dept)
    or exists (select 1 from public.departments d where d.id = p_dept and d.manager_id = auth.uid())
  );
$$;

-- Does the current user match a principal (user/group/department/role)?
create or replace function private.principal_match(
  p_type text, p_user uuid, p_group uuid, p_dept uuid, p_role uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_type
    when 'user'       then p_user = auth.uid()
    when 'group'      then private.in_group(p_group)
    when 'department' then p_dept = private.user_department()
    when 'role'       then exists (select 1 from public.user_roles ur
                                   where ur.user_id = auth.uid() and ur.role_id = p_role)
    else false
  end;
$$;

create or replace function private.get_setting(p_key text, p_default jsonb default null)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((select s.value from public.system_settings s where s.key = p_key), p_default);
$$;

-- -----------------------------------------------------------------------------
-- Document access — the single source of truth for document authorisation.
-- p_action: view | download | upload | edit | delete | share
-- -----------------------------------------------------------------------------
create or replace function private.can_doc(p_doc uuid, p_action text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  d   record;
  uid uuid := auth.uid();
begin
  if uid is null or p_doc is null or not private.is_active_user() then
    return false;
  end if;
  if p_action not in ('view', 'download', 'upload', 'edit', 'delete', 'share') then
    return false;
  end if;

  select x.id, x.owner_id, x.created_by, x.department_id, x.access_level, x.status, x.deleted_at
    into d from public.documents x where x.id = p_doc;
  if not found then
    return false;
  end if;

  -- 1. Global document administrators (Super Admin by default)
  if private.has_permission('documents.manage_all') then
    return true;
  end if;

  -- 2. Owner / uploader: full control
  if d.owner_id = uid or d.created_by = uid then
    return true;
  end if;

  -- 3. Manager of the responsible department (never for Restricted documents)
  if d.access_level <> 'restricted' and private.is_dept_manager(d.department_id) then
    return true;
  end if;

  -- 4. Soft-deleted: only users holding an explicit delete grant may see it (to restore)
  if d.deleted_at is not null then
    return p_action in ('view', 'delete') and exists (
      select 1 from public.document_permissions p
      where p.document_id = d.id and p.can_delete
        and (case when d.access_level = 'restricted'
                  then p.principal_type = 'user' and p.user_id = uid
                  else private.principal_match(p.principal_type, p.user_id, p.group_id, p.department_id, p.role_id) end));
  end if;

  -- 5. Pending documents: visible to approvers of the same department
  if d.status = 'pending' and p_action in ('view', 'download')
     and d.access_level <> 'restricted'
     and private.has_permission('documents.approve')
     and d.department_id = private.user_department() then
    return true;
  end if;

  if d.status <> 'published' then
    return false;
  end if;

  -- 6. Explicit grants. Restricted documents accept ONLY individual user grants.
  if p_action <> 'share' and exists (
    select 1 from public.document_permissions p
    where p.document_id = d.id
      and (case when d.access_level = 'restricted'
                then p.principal_type = 'user' and p.user_id = uid
                else private.principal_match(p.principal_type, p.user_id, p.group_id, p.department_id, p.role_id) end)
      and (case p_action
             when 'view'     then p.can_view or p.can_download or p.can_edit or p.can_upload or p.can_delete
             when 'download' then p.can_download
             when 'upload'   then p.can_upload
             when 'edit'     then p.can_edit
             when 'delete'   then p.can_delete
             else false end)
  ) then
    return true;
  end if;

  -- 7. Baseline by access level (view/download only)
  if p_action in ('view', 'download') then
    if d.access_level = 'public' then
      return true;
    end if;
    if d.access_level = 'department' and d.department_id is not null
       and d.department_id = private.user_department() then
      return true;
    end if;
  end if;

  return false;
end;
$$;

-- Storage helper: first folder segment of an object path as uuid (null if not)
create or replace function private.path_uuid(p_name text)
returns uuid
language plpgsql immutable set search_path = ''
as $$
declare seg text := split_part(p_name, '/', 1);
begin
  if seg ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return seg::uuid;
  end if;
  return null;
end;
$$;

-- Reading a document object: download right, or view right for previewable
-- formats (PDF / images). See README "View vs Download" limitation note.
create or replace function private.can_read_document_object(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_doc(private.path_uuid(p_name), 'download')
      or (lower(p_name) ~ '\.(pdf|png|jpe?g|gif|webp)$'
          and private.can_doc(private.path_uuid(p_name), 'view'));
$$;

-- -----------------------------------------------------------------------------
-- News / application access
-- -----------------------------------------------------------------------------
create or replace function private.can_view_news(p_news uuid)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare n record;
begin
  if auth.uid() is null or p_news is null or not private.is_active_user() then
    return false;
  end if;
  select x.id, x.created_by, x.status, x.publish_at, x.expire_at, x.audience
    into n from public.news x where x.id = p_news;
  if not found then return false; end if;

  if private.has_permission('news.manage') or n.created_by = auth.uid() then
    return true;
  end if;
  if n.status <> 'published' or (n.publish_at is not null and n.publish_at > now()) then
    return false;
  end if;
  if n.expire_at is not null and n.expire_at <= now()
     and not coalesce((private.get_setting('news.archive_visible', 'true'::jsonb))::boolean, true) then
    return false;
  end if;
  if n.audience = 'all' then
    return true;
  end if;
  return exists (
    select 1 from public.news_targets t
    where t.news_id = n.id
      and private.principal_match(t.principal_type, t.user_id, t.group_id, t.department_id, t.role_id));
end;
$$;

create or replace function private.can_edit_news(p_news uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_permission('news.manage')
      or (private.has_permission('news.create')
          and exists (select 1 from public.news n where n.id = p_news and n.created_by = auth.uid()));
$$;

create or replace function private.can_view_app(p_app uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_active_user() and (
       private.has_permission('apps.manage')
    or exists (
         select 1 from public.applications a
         where a.id = p_app
           and (a.visibility = 'all'
                or exists (select 1 from public.application_permissions ap
                           where ap.application_id = a.id
                             and private.principal_match(ap.principal_type, ap.user_id, ap.group_id,
                                                         ap.department_id, ap.role_id))))
  );
$$;

-- -----------------------------------------------------------------------------
-- User / role administration rules
-- -----------------------------------------------------------------------------
-- Manage another user: needs users.manage and a strictly higher role level.
-- Super Admin may manage everyone (including other super admins).
create or replace function private.can_manage_user(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_permission('users.manage') and (
       private.is_super_admin()
    or (p_user <> auth.uid() and private.user_level(p_user) < private.my_level())
  );
$$;

-- Assign / revoke a role: roles.assign, never to yourself (unless Super Admin),
-- and only roles below your own level on users below your own level.
create or replace function private.can_assign_role(p_user uuid, p_role uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_permission('roles.assign') and (
       private.is_super_admin()
    or (p_user <> auth.uid()
        and private.user_level(p_user) < private.my_level()
        and coalesce((select r.level from public.roles r where r.id = p_role), 1000) < private.my_level())
  );
$$;

-- -----------------------------------------------------------------------------
-- Audit logging
-- -----------------------------------------------------------------------------
create or replace function private.write_audit(
  p_action text, p_entity_type text, p_entity_id text, p_summary text, p_details jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, summary, details)
  values (auth.uid(),
          (select p.email from public.profiles p where p.id = auth.uid()),
          p_action, p_entity_type, p_entity_id, p_summary, coalesce(p_details, '{}'::jsonb));
end;
$$;

-- Generic row audit trigger. Stores only changed columns on UPDATE.
create or replace function private.audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_changes jsonb := '{}'::jsonb;
  v_id text;
  k text;
  ignore_keys text[] := array['updated_at', 'updated_by', 'search_text', 'last_login_at'];
begin
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id',
                   concat_ws(':', coalesce(v_new, v_old) ->> 'user_id', coalesce(v_new, v_old) ->> 'role_id',
                             coalesce(v_new, v_old) ->> 'group_id', coalesce(v_new, v_old) ->> 'permission_code',
                             coalesce(v_new, v_old) ->> 'key'));
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if not (k = any (ignore_keys)) and (v_new -> k) is distinct from (v_old -> k) then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return new;   -- nothing meaningful changed
    end if;
    perform private.write_audit(lower(tg_table_name) || '.update', tg_table_name, v_id, null,
                                jsonb_build_object('changes', v_changes));
  elsif tg_op = 'INSERT' then
    perform private.write_audit(lower(tg_table_name) || '.insert', tg_table_name, v_id, null,
                                jsonb_build_object('new', v_new - ignore_keys));
  else
    perform private.write_audit(lower(tg_table_name) || '.delete', tg_table_name, v_id, null,
                                jsonb_build_object('old', v_old - ignore_keys));
  end if;
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','departments','roles','role_permissions','user_roles','user_permissions',
                           'groups','group_members','document_categories','documents','document_permissions',
                           'applications','application_permissions','news','news_targets','system_settings']
  loop
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function private.audit_row()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Column guards: API users (role authenticated) cannot touch protected columns.
-- SECURITY DEFINER RPCs run as the function owner and are therefore allowed.
-- -----------------------------------------------------------------------------
create or replace function private.guard_profiles()
returns trigger
-- SECURITY INVOKER on purpose: current_user must be the API caller
language plpgsql security invoker set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.id <> old.id or lower(new.email) <> lower(old.email) then
    raise exception 'ไม่สามารถแก้ไขรหัสผู้ใช้หรืออีเมลได้จากหน้านี้' using errcode = '42501';
  end if;
  if not private.can_manage_user(old.id) then
    -- self-service: only personal contact fields
    if new.department_id is distinct from old.department_id
       or new.is_active is distinct from old.is_active
       or new.employee_code is distinct from old.employee_code
       or new.username is distinct from old.username
       or new.position is distinct from old.position
       or new.full_name is distinct from old.full_name then
      raise exception 'ไม่มีสิทธิ์แก้ไขข้อมูลส่วนนี้' using errcode = '42501';
    end if;
  end if;
  if old.id = auth.uid() and new.is_active is distinct from old.is_active then
    raise exception 'ไม่สามารถเปลี่ยนสถานะบัญชีของตนเองได้' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_profiles before update on public.profiles
  for each row execute function private.guard_profiles();

create or replace function private.guard_documents()
returns trigger
-- SECURITY INVOKER on purpose: current_user must be the API caller
language plpgsql security invoker set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- lifecycle columns are managed by RPCs only
    new.status := 'draft';
    new.current_version := 0;
    new.file_path := null; new.file_name := null; new.file_size := null; new.mime_type := null;
    new.deleted_at := null; new.deleted_by := null;
    new.reviewed_by := null; new.reviewed_at := null; new.review_note := null;
    new.owner_id := coalesce(new.owner_id, auth.uid());
    return new;
  end if;
  if new.status is distinct from old.status
     or new.current_version is distinct from old.current_version
     or new.file_path is distinct from old.file_path
     or new.file_name is distinct from old.file_name
     or new.file_size is distinct from old.file_size
     or new.mime_type is distinct from old.mime_type
     or new.deleted_at is distinct from old.deleted_at
     or new.deleted_by is distinct from old.deleted_by
     or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at then
    raise exception 'ไม่สามารถแก้ไขสถานะ/ไฟล์ของเอกสารโดยตรงได้' using errcode = '42501';
  end if;
  if old.deleted_at is not null then
    raise exception 'เอกสารอยู่ในถังขยะ กรุณากู้คืนก่อนแก้ไข' using errcode = '42501';
  end if;
  -- Ownership, department and access level changes require the share right
  if (new.owner_id is distinct from old.owner_id
      or new.department_id is distinct from old.department_id
      or new.access_level is distinct from old.access_level)
     and not private.can_doc(old.id, 'share') then
    raise exception 'ไม่มีสิทธิ์เปลี่ยนเจ้าของ แผนก หรือระดับสิทธิ์ของเอกสาร' using errcode = '42501';
  end if;
  if new.department_id is distinct from old.department_id
     and not private.has_permission('documents.upload_any_department')
     and new.department_id is distinct from private.user_department() then
    raise exception 'ย้ายเอกสารได้เฉพาะแผนกของตนเอง' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_documents before insert or update on public.documents
  for each row execute function private.guard_documents();

create or replace function private.guard_news()
returns trigger
-- SECURITY INVOKER on purpose: current_user must be the API caller
language plpgsql security invoker set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if not private.has_permission('news.manage') then
    if new.is_pinned and (tg_op = 'INSERT' or not old.is_pinned) then
      raise exception 'เฉพาะผู้ดูแลข่าวเท่านั้นที่ปักหมุดข่าวได้' using errcode = '42501';
    end if;
    if new.department_id is distinct from private.user_department() then
      raise exception 'สร้าง/แก้ไขข่าวได้เฉพาะของแผนกตนเอง' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_news before insert or update on public.news
  for each row execute function private.guard_news();

-- News revision history
create or replace function private.news_revision()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (new.title, new.summary, new.content_html, new.category, new.priority, new.status)
     is distinct from (old.title, old.summary, old.content_html, old.category, old.priority, old.status) then
    insert into public.news_revisions (news_id, revision_no, title, summary, content_html, category, priority, status, changed_by)
    values (old.id,
            coalesce((select max(r.revision_no) from public.news_revisions r where r.news_id = old.id), 0) + 1,
            old.title, old.summary, old.content_html, old.category, old.priority, old.status, auth.uid());
  end if;
  return new;
end;
$$;
create trigger news_revision before update on public.news
  for each row execute function private.news_revision();

-- Roles: system roles cannot be deleted or renamed (code)
create or replace function private.guard_roles()
returns trigger
-- SECURITY INVOKER on purpose: current_user must be the API caller
language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'ไม่สามารถลบบทบาทของระบบได้' using errcode = '42501'; end if;
    return old;
  end if;
  if old.is_system and (new.code <> old.code or new.is_system <> old.is_system) then
    raise exception 'ไม่สามารถแก้ไขรหัสบทบาทของระบบได้' using errcode = '42501';
  end if;
  if current_user in ('authenticated', 'anon') and not private.is_super_admin()
     and new.level >= private.my_level() then
    raise exception 'ไม่สามารถตั้งระดับบทบาทเท่ากับหรือสูงกว่าตนเอง' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_roles before update or delete on public.roles
  for each row execute function private.guard_roles();

-- Never allow removing the last active Super Admin
create or replace function private.guard_last_super_admin()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.roles r where r.id = old.role_id and r.code = 'super_admin')
     and not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                     join public.profiles p on p.id = ur.user_id
                     where r.code = 'super_admin' and p.is_active and ur.user_id <> old.user_id) then
    raise exception 'ต้องมี Super Admin ที่ใช้งานอยู่อย่างน้อย 1 คน' using errcode = '42501';
  end if;
  return old;
end;
$$;
create trigger guard_last_super_admin before delete on public.user_roles
  for each row execute function private.guard_last_super_admin();

-- -----------------------------------------------------------------------------
-- New auth user -> profile + Employee role
-- Self-registered or SSO users stay INACTIVE unless provisioned by an admin
-- (app_metadata.provisioned = true) or the matching setting is enabled.
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_provisioned boolean := coalesce((new.raw_app_meta_data ->> 'provisioned')::boolean, false);
  v_provider text := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  v_active boolean;
  v_dept uuid;
begin
  v_active := v_provisioned
    or (v_provider = 'email' and coalesce((private.get_setting('auth.allow_self_signup', 'false'::jsonb))::boolean, false))
    or (v_provider <> 'email' and coalesce((private.get_setting('auth.sso_auto_activate', 'false'::jsonb))::boolean, false));

  begin
    v_dept := nullif(new.raw_app_meta_data ->> 'department_id', '')::uuid;
  exception when others then
    v_dept := null;
  end;
  if v_dept is not null and not exists (select 1 from public.departments d where d.id = v_dept) then
    v_dept := null;
  end if;

  insert into public.profiles (id, email, full_name, department_id, is_active, created_by)
  values (new.id, new.email,
          coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''),
                   split_part(new.email, '@', 1)),
          v_dept, v_active,
          nullif(new.raw_app_meta_data ->> 'provisioned_by', '')::uuid)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role_id)
  select new.id, r.id from public.roles r where r.code = 'employee'
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- One-time bootstrap: promote the first Super Admin. Run from the SQL editor
-- (postgres role). Refuses if an active Super Admin already exists.
create or replace function private.bootstrap_super_admin(p_email text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
             join public.profiles p on p.id = ur.user_id where r.code = 'super_admin' and p.is_active) then
    raise exception 'Super Admin already exists — use the Admin Panel instead';
  end if;
  select id into v_id from public.profiles where lower(email) = lower(p_email);
  if v_id is null then
    raise exception 'No profile for %. Create the user in Supabase Auth first.', p_email;
  end if;
  update public.profiles set is_active = true where id = v_id;
  insert into public.user_roles (user_id, role_id)
  select v_id, r.id from public.roles r where r.code = 'super_admin' on conflict do nothing;
  perform private.write_audit('system.bootstrap_super_admin', 'profiles', v_id::text, p_email, '{}'::jsonb);
  return 'OK: ' || p_email || ' is now Super Admin';
end;
$$;
revoke all on function private.bootstrap_super_admin(text) from public;
