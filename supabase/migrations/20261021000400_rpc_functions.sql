-- =============================================================================
-- Company Intranet Portal — 0004 RPC functions (exposed via supabase.rpc)
-- Each function re-checks authorisation itself. Execute is granted only to
-- `authenticated`; anon cannot call any of them.
-- =============================================================================

-- Current user's profile, roles, effective permissions
create or replace function public.my_context()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;
  select jsonb_build_object(
    'profile', to_jsonb(p) - 'search_text',
    'department', (select to_jsonb(d) from public.departments d where d.id = p.department_id),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name, 'level', r.level) order by r.level desc)
                       from public.user_roles ur join public.roles r on r.id = ur.role_id
                       where ur.user_id = p.id), '[]'::jsonb),
    'permissions', case when p.is_active then
        case when private.is_super_admin()
             then (select coalesce(jsonb_agg(code order by code), '[]'::jsonb) from public.permissions)
             else coalesce((select jsonb_agg(distinct c order by c) from (
                    select rp.permission_code c from public.user_roles ur
                    join public.role_permissions rp on rp.role_id = ur.role_id where ur.user_id = p.id
                    union
                    select up.permission_code from public.user_permissions up
                    where up.user_id = p.id and (up.expires_at is null or up.expires_at > now())) s), '[]'::jsonb)
        end
      else '[]'::jsonb end,
    'is_manager', private.has_role('dept_manager') or exists (select 1 from public.departments d where d.manager_id = p.id)
  ) into v
  from public.profiles p where p.id = auth.uid();
  return v;
end;
$$;

create or replace function public.touch_last_login()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then return; end if;
  update public.profiles set last_login_at = now() where id = auth.uid();
  perform private.write_audit('auth.login', 'profiles', auth.uid()::text, null, '{}'::jsonb);
end;
$$;

-- Whitelisted client-side events (actor is always the caller)
create or replace function public.log_event(p_action text, p_entity_type text, p_entity_id text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_action not in ('auth.logout', 'document.preview', 'document.download', 'news.attachment_download') then
    raise exception 'event not allowed' using errcode = '22023';
  end if;
  if p_action in ('document.preview', 'document.download')
     and not private.can_doc(nullif(p_entity_id, '')::uuid, case when p_action = 'document.download' then 'download' else 'view' end) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  perform private.write_audit(p_action, p_entity_type, p_entity_id, null,
                              coalesce(p_details, '{}'::jsonb) - 'actor_id');
end;
$$;

-- Rights of the caller on one document (for showing buttons; DB still enforces)
create or replace function public.my_document_rights(p_document_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.can_doc(p_document_id, 'view') then jsonb_build_object(
    'view',     true,
    'download', private.can_doc(p_document_id, 'download'),
    'upload',   private.can_doc(p_document_id, 'upload'),
    'edit',     private.can_doc(p_document_id, 'edit'),
    'delete',   private.can_doc(p_document_id, 'delete'),
    'share',    private.can_doc(p_document_id, 'share'),
    'approve',  exists (select 1 from public.documents d where d.id = p_document_id and d.status = 'pending'
                        and d.access_level <> 'restricted'
                        and (private.has_permission('documents.manage_all') or private.is_dept_manager(d.department_id)
                             or (private.has_permission('documents.approve') and d.department_id = private.user_department())))
  ) else null end;
$$;

-- Register an uploaded file as a new version. The object must already exist in
-- the private bucket under "<document_id>/..."; size & mime come from Storage.
create or replace function public.add_document_version(
  p_document_id uuid, p_file_path text, p_file_name text, p_change_note text default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_doc  public.documents;
  v_obj  record;
  v_next integer;
  v_status text;
  v_needs_approval boolean;
begin
  if not private.can_doc(p_document_id, 'upload') then
    raise exception 'ไม่มีสิทธิ์อัปโหลดไฟล์ให้เอกสารนี้' using errcode = '42501';
  end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if v_doc.deleted_at is not null then
    raise exception 'เอกสารอยู่ในถังขยะ' using errcode = '42501';
  end if;
  if p_file_path is null or split_part(p_file_path, '/', 1) <> p_document_id::text then
    raise exception 'ตำแหน่งไฟล์ไม่ถูกต้อง' using errcode = '22023';
  end if;
  select o.name, o.metadata into v_obj from storage.objects o
   where o.bucket_id = 'documents' and o.name = p_file_path;
  if not found then
    raise exception 'ไม่พบไฟล์ที่อัปโหลด' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.document_versions v where v.file_path = p_file_path) then
    raise exception 'ไฟล์นี้ถูกใช้แล้ว' using errcode = '23505';
  end if;

  v_next := v_doc.current_version + 1;
  insert into public.document_versions (document_id, version_no, file_path, file_name, file_size, mime_type, change_note, created_by)
  values (p_document_id, v_next, p_file_path, left(p_file_name, 255),
          nullif(v_obj.metadata ->> 'size', '')::bigint, v_obj.metadata ->> 'mimetype',
          p_change_note, auth.uid());

  v_status := v_doc.status;
  if v_doc.status in ('draft', 'rejected') then
    v_needs_approval := coalesce((private.get_setting('documents.approval_required', 'false'::jsonb))::boolean, false)
      and not (private.has_permission('documents.manage_all') or private.is_dept_manager(v_doc.department_id));
    v_status := case when v_needs_approval then 'pending' else 'published' end;
  end if;

  update public.documents set
    current_version = v_next, file_path = p_file_path, file_name = left(p_file_name, 255),
    file_size = nullif(v_obj.metadata ->> 'size', '')::bigint, mime_type = v_obj.metadata ->> 'mimetype',
    status = v_status, updated_at = now(), updated_by = auth.uid()
  where id = p_document_id;

  perform private.write_audit('document.version_added', 'documents', p_document_id::text, v_doc.title,
                              jsonb_build_object('version', v_next, 'file_name', p_file_name, 'status', v_status));
  return v_next;
end;
$$;

-- Remove a document row whose first upload failed (creator only, no versions)
create or replace function public.discard_document_draft(p_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.documents
   where id = p_document_id and created_by = auth.uid() and current_version = 0 and status = 'draft';
end;
$$;

create or replace function public.soft_delete_document(p_document_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_title text;
begin
  if not private.can_doc(p_document_id, 'delete') then
    raise exception 'ไม่มีสิทธิ์ลบเอกสารนี้' using errcode = '42501';
  end if;
  update public.documents set deleted_at = now(), deleted_by = auth.uid()
   where id = p_document_id and deleted_at is null
   returning title into v_title;
  perform private.write_audit('document.soft_delete', 'documents', p_document_id::text, v_title,
                              jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.restore_document(p_document_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_title text;
begin
  if not private.can_doc(p_document_id, 'delete') then
    raise exception 'ไม่มีสิทธิ์กู้คืนเอกสารนี้' using errcode = '42501';
  end if;
  update public.documents set deleted_at = null, deleted_by = null
   where id = p_document_id and deleted_at is not null
   returning title into v_title;
  perform private.write_audit('document.restore', 'documents', p_document_id::text, v_title, '{}'::jsonb);
end;
$$;

create or replace function public.review_document(p_document_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.documents;
begin
  select * into d from public.documents where id = p_document_id;
  if not found or d.status <> 'pending' or d.deleted_at is not null then
    raise exception 'ไม่พบเอกสารที่รออนุมัติ' using errcode = 'P0002';
  end if;
  if not (private.has_permission('documents.manage_all')
          or (d.access_level <> 'restricted' and private.is_dept_manager(d.department_id))
          or (d.access_level <> 'restricted' and private.has_permission('documents.approve')
              and d.department_id = private.user_department())) then
    raise exception 'ไม่มีสิทธิ์อนุมัติเอกสารนี้' using errcode = '42501';
  end if;
  if d.created_by = auth.uid() and not private.is_super_admin() then
    raise exception 'ไม่สามารถอนุมัติเอกสารของตนเองได้' using errcode = '42501';
  end if;
  update public.documents set
    status = case when p_approve then 'published' else 'rejected' end,
    review_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_document_id;
  perform private.write_audit(case when p_approve then 'document.approve' else 'document.reject' end,
                              'documents', p_document_id::text, d.title, jsonb_build_object('note', p_note));
end;
$$;

-- Documents the caller is responsible for that expire soon (or already expired)
create or replace function public.my_expiring_documents(p_days integer default null)
returns table (id uuid, title text, doc_number text, expires_at date, days_left integer)
language sql stable security definer set search_path = ''
as $$
  select d.id, d.title, d.doc_number, d.expires_at, (d.expires_at - current_date)::integer
  from public.documents d
  where d.deleted_at is null and d.expires_at is not null
    and d.expires_at <= current_date + coalesce(p_days,
          coalesce((private.get_setting('documents.expiry_warning_days', '30'::jsonb))::integer, 30))
    and private.can_doc(d.id, 'edit')
  order by d.expires_at
  limit 50;
$$;

create or replace function public.track_application_open(p_application_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_view_app(p_application_id) then
    raise exception 'ไม่มีสิทธิ์เข้าถึงระบบนี้' using errcode = '42501';
  end if;
  insert into public.application_usage (user_id, application_id, open_count, last_opened_at)
  values (auth.uid(), p_application_id, 1, now())
  on conflict (user_id, application_id)
  do update set open_count = public.application_usage.open_count + 1, last_opened_at = now();
end;
$$;

-- Re-order applications: ids in the desired order get sort_order 10, 20, ...
create or replace function public.reorder_applications(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_permission('apps.manage') then
    raise exception 'ไม่มีสิทธิ์จัดการระบบ' using errcode = '42501';
  end if;
  update public.applications a set sort_order = s.ord * 10
  from unnest(p_ids) with ordinality as s(id, ord)
  where a.id = s.id;
end;
$$;

create or replace function public.mark_news_read(p_news_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_view_news(p_news_id) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.news n where n.id = p_news_id and n.track_reads) then
    insert into public.news_reads (news_id, user_id) values (p_news_id, auth.uid())
    on conflict do nothing;
  end if;
end;
$$;

-- Read counter: visible to anyone who can see the news item
create or replace function public.news_read_count(p_news_ids uuid[])
returns table (news_id uuid, read_count bigint)
language sql stable security definer set search_path = ''
as $$
  select r.news_id, count(*)
  from public.news_reads r
  where r.news_id = any (p_news_ids) and private.can_view_news(r.news_id)
  group by r.news_id;
$$;

create or replace function public.storage_stats()
returns table (bucket_id text, object_count bigint, total_bytes numeric)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.has_permission('storage.view') then
    raise exception 'ไม่มีสิทธิ์ดูข้อมูลพื้นที่จัดเก็บ' using errcode = '42501';
  end if;
  return query
    select o.bucket_id, count(*), coalesce(sum((o.metadata ->> 'size')::numeric), 0)
    from storage.objects o
    where o.bucket_id in ('documents', 'news')
    group by o.bucket_id;
end;
$$;

-- Used by the admin-users Edge Function to authorise the caller
create or replace function public.can_manage_user(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_manage_user(p_user_id);
$$;

-- ---------------------------------------------------------------- privileges
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('my_context','touch_last_login','log_event','my_document_rights','add_document_version',
                        'discard_document_draft','soft_delete_document','restore_document','review_document',
                        'my_expiring_documents','track_application_open','reorder_applications','mark_news_read',
                        'news_read_count','storage_stats','can_manage_user')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
