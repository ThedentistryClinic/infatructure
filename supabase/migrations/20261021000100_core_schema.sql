-- =============================================================================
-- Company Intranet Portal — 0001 Core schema
-- Tables, constraints, indexes, timestamp triggers.
-- RLS policies live in 0003, helper functions in 0002, storage in 0004.
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- Private schema: NOT exposed through the Supabase Data API (PostgREST).
-- Holds security helper functions used by RLS policies.
create schema if not exists private;
revoke all on schema private from public;

-- -----------------------------------------------------------------------------
-- Generic timestamp / actor trigger
-- -----------------------------------------------------------------------------
create or replace function private.set_row_meta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.updated_at := now();
    -- created_by cannot be spoofed by API users: always the caller when known
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    new.updated_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Organisation
-- -----------------------------------------------------------------------------
create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  name        text not null,
  name_en     text,
  description text,
  parent_id   uuid references public.departments(id) on delete set null,
  manager_id  uuid,                    -- FK added after profiles
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid,
  constraint departments_code_key unique (code),
  constraint departments_code_chk check (code ~ '^[A-Z0-9_-]{2,20}$')
);

create table public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text not null,
  username           text,
  full_name          text not null default '',
  full_name_en       text,
  employee_code      text,
  department_id      uuid references public.departments(id) on delete set null,
  position           text,
  phone              text,
  avatar_path        text,
  is_active          boolean not null default false,
  preferred_language text not null default 'th' check (preferred_language in ('th', 'en')),
  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  updated_by         uuid
);
create unique index profiles_email_key on public.profiles (lower(email));
create unique index profiles_username_key on public.profiles (lower(username)) where username is not null;
create unique index profiles_employee_code_key on public.profiles (employee_code) where employee_code is not null;
create index profiles_department_idx on public.profiles (department_id);

alter table public.departments
  add constraint departments_manager_fk foreign key (manager_id)
  references public.profiles(id) on delete set null;
create index departments_manager_idx on public.departments (manager_id);

-- -----------------------------------------------------------------------------
-- RBAC: roles, permissions, assignments, groups
-- -----------------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z_]{2,40}$'),
  name        text not null,
  name_en     text,
  description text,
  level       integer not null check (level between 0 and 100),
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);

create table public.permissions (
  code        text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
  name        text not null,
  description text,
  category    text not null,
  created_at  timestamptz not null default now()
);

create table public.role_permissions (
  role_id         uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  primary key (role_id, permission_code)
);

create table public.user_roles (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role_id    uuid not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (user_id, role_id)
);
create index user_roles_role_idx on public.user_roles (role_id);

-- Individual extra permissions (beyond role/department)
create table public.user_permissions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  expires_at      timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  constraint user_permissions_uniq unique (user_id, permission_code)
);

create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);
create unique index groups_name_key on public.groups (lower(name));

create table public.group_members (
  group_id   uuid not null references public.groups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

-- -----------------------------------------------------------------------------
-- Documents
-- -----------------------------------------------------------------------------
create table public.document_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  name_en     text,
  description text,
  parent_id   uuid references public.document_categories(id) on delete set null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid,
  updated_by  uuid
);

create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  doc_number      text,
  title           text not null check (length(trim(title)) > 0),
  description     text,
  category_id     uuid references public.document_categories(id) on delete set null,
  department_id   uuid references public.departments(id) on delete set null,
  doc_type        text,
  tags            text[] not null default '{}',
  owner_id        uuid references public.profiles(id) on delete set null,
  access_level    text not null default 'department'
                  check (access_level in ('public', 'department', 'specific', 'restricted')),
  status          text not null default 'draft'
                  check (status in ('draft', 'pending', 'published', 'rejected')),
  review_note     text,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz,
  current_version integer not null default 0,
  file_path       text,
  file_name       text,
  file_size       bigint,
  mime_type       text,
  effective_date  date,
  expires_at      date,
  search_text     text,
  deleted_at      timestamptz,
  deleted_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles(id) on delete set null,
  updated_by      uuid references public.profiles(id) on delete set null
);
-- NOTE: doc_number is intentionally NOT unique: a unique-violation error would
-- reveal that a restricted document with that number exists.
create index documents_doc_number_idx on public.documents (doc_number);
create index documents_category_idx on public.documents (category_id);
create index documents_department_idx on public.documents (department_id);
create index documents_owner_idx on public.documents (owner_id);
create index documents_created_by_idx on public.documents (created_by);
create index documents_created_at_idx on public.documents (created_at desc);
create index documents_updated_at_idx on public.documents (updated_at desc);
create index documents_expires_idx on public.documents (expires_at) where deleted_at is null;
create index documents_tags_idx on public.documents using gin (tags);
create index documents_search_idx on public.documents using gin (search_text extensions.gin_trgm_ops);

create table public.document_versions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_no  integer not null check (version_no > 0),
  file_path   text not null,
  file_name   text not null,
  file_size   bigint,
  mime_type   text,
  change_note text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null,
  constraint document_versions_uniq unique (document_id, version_no)
);

-- One row = one principal (user / group / department / role) with action flags.
create table public.document_permissions (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references public.documents(id) on delete cascade,
  principal_type text not null check (principal_type in ('user', 'group', 'department', 'role')),
  user_id        uuid references public.profiles(id) on delete cascade,
  group_id       uuid references public.groups(id) on delete cascade,
  department_id  uuid references public.departments(id) on delete cascade,
  role_id        uuid references public.roles(id) on delete cascade,
  can_view       boolean not null default true,
  can_download   boolean not null default false,
  can_upload     boolean not null default false,
  can_edit       boolean not null default false,
  can_delete     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid,
  constraint document_permissions_principal_chk check (
       (principal_type = 'user'       and user_id is not null and group_id is null and department_id is null and role_id is null)
    or (principal_type = 'group'      and group_id is not null and user_id is null and department_id is null and role_id is null)
    or (principal_type = 'department' and department_id is not null and user_id is null and group_id is null and role_id is null)
    or (principal_type = 'role'       and role_id is not null and user_id is null and group_id is null and department_id is null)
  )
);
create unique index document_permissions_uniq on public.document_permissions
  (document_id, principal_type, coalesce(user_id, group_id, department_id, role_id));
create index document_permissions_user_idx on public.document_permissions (user_id);
create index document_permissions_group_idx on public.document_permissions (group_id);

-- -----------------------------------------------------------------------------
-- Application portal
-- -----------------------------------------------------------------------------
create table public.applications (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  description     text,
  url             text not null check (url ~* '^https?://'),
  icon            text not null default 'grid',
  color           text not null default '#1E3A8A' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  category        text not null default 'Other',
  open_in_new_tab boolean not null default true,
  is_quick_access boolean not null default false,
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  visibility      text not null default 'all' check (visibility in ('all', 'restricted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid
);
create index applications_sort_idx on public.applications (category, sort_order);

create table public.application_permissions (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  principal_type text not null check (principal_type in ('user', 'group', 'department', 'role')),
  user_id        uuid references public.profiles(id) on delete cascade,
  group_id       uuid references public.groups(id) on delete cascade,
  department_id  uuid references public.departments(id) on delete cascade,
  role_id        uuid references public.roles(id) on delete cascade,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  constraint application_permissions_principal_chk check (
       (principal_type = 'user'       and user_id is not null and group_id is null and department_id is null and role_id is null)
    or (principal_type = 'group'      and group_id is not null and user_id is null and department_id is null and role_id is null)
    or (principal_type = 'department' and department_id is not null and user_id is null and group_id is null and role_id is null)
    or (principal_type = 'role'       and role_id is not null and user_id is null and group_id is null and department_id is null)
  )
);
create unique index application_permissions_uniq on public.application_permissions
  (application_id, principal_type, coalesce(user_id, group_id, department_id, role_id));

create table public.application_usage (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  open_count     integer not null default 0,
  last_opened_at timestamptz not null default now(),
  primary key (user_id, application_id)
);

-- -----------------------------------------------------------------------------
-- News & announcements
-- -----------------------------------------------------------------------------
create table public.news (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (length(trim(title)) > 0),
  summary          text,
  content_html     text not null default '',
  category         text not null default 'company'
                   check (category in ('company', 'hr', 'it', 'maintenance', 'policy', 'event', 'urgent')),
  priority         text not null default 'normal' check (priority in ('normal', 'important', 'urgent')),
  cover_image_path text,
  department_id    uuid references public.departments(id) on delete set null,
  is_pinned        boolean not null default false,
  status           text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  publish_at       timestamptz,
  expire_at        timestamptz,
  event_start_at   timestamptz,
  event_end_at     timestamptz,
  event_location   text,
  audience         text not null default 'all' check (audience in ('all', 'targeted')),
  track_reads      boolean not null default true,
  search_text      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id) on delete set null,
  updated_by       uuid references public.profiles(id) on delete set null,
  constraint news_expire_chk check (expire_at is null or publish_at is null or expire_at > publish_at)
);
create index news_publish_idx on public.news (status, publish_at desc);
create index news_pinned_idx on public.news (is_pinned) where is_pinned;
create index news_event_idx on public.news (event_start_at) where event_start_at is not null;
create index news_search_idx on public.news using gin (search_text extensions.gin_trgm_ops);

create table public.news_attachments (
  id         uuid primary key default gen_random_uuid(),
  news_id    uuid not null references public.news(id) on delete cascade,
  file_path  text not null,
  file_name  text not null,
  file_size  bigint,
  mime_type  text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index news_attachments_news_idx on public.news_attachments (news_id);

create table public.news_targets (
  id             uuid primary key default gen_random_uuid(),
  news_id        uuid not null references public.news(id) on delete cascade,
  principal_type text not null check (principal_type in ('user', 'group', 'department', 'role')),
  user_id        uuid references public.profiles(id) on delete cascade,
  group_id       uuid references public.groups(id) on delete cascade,
  department_id  uuid references public.departments(id) on delete cascade,
  role_id        uuid references public.roles(id) on delete cascade,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  constraint news_targets_principal_chk check (
       (principal_type = 'user'       and user_id is not null and group_id is null and department_id is null and role_id is null)
    or (principal_type = 'group'      and group_id is not null and user_id is null and department_id is null and role_id is null)
    or (principal_type = 'department' and department_id is not null and user_id is null and group_id is null and role_id is null)
    or (principal_type = 'role'       and role_id is not null and user_id is null and group_id is null and department_id is null)
  )
);
create unique index news_targets_uniq on public.news_targets
  (news_id, principal_type, coalesce(user_id, group_id, department_id, role_id));

create table public.news_reads (
  news_id uuid not null references public.news(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (news_id, user_id)
);
create index news_reads_user_idx on public.news_reads (user_id);

create table public.news_revisions (
  id           uuid primary key default gen_random_uuid(),
  news_id      uuid not null references public.news(id) on delete cascade,
  revision_no  integer not null,
  title        text not null,
  summary      text,
  content_html text,
  category     text,
  priority     text,
  status       text,
  changed_by   uuid references public.profiles(id) on delete set null,
  changed_at   timestamptz not null default now(),
  constraint news_revisions_uniq unique (news_id, revision_no)
);

-- -----------------------------------------------------------------------------
-- Favorites, audit, settings
-- -----------------------------------------------------------------------------
create table public.favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  item_type  text not null check (item_type in ('document', 'application', 'news')),
  item_id    uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, item_type, item_id)
);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  summary     text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_action_idx on public.audit_logs (action);

create table public.system_settings (
  key         text primary key check (key ~ '^[a-z0-9_.]+$'),
  value       jsonb not null,
  description text,
  visibility  text not null default 'admin' check (visibility in ('public', 'authenticated', 'admin')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- -----------------------------------------------------------------------------
-- Timestamp triggers
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['departments','profiles','roles','groups','document_categories',
                           'documents','document_permissions','applications','news']
  loop
    execute format('create trigger set_row_meta before insert or update on public.%I
                    for each row execute function private.set_row_meta()', t);
  end loop;
end $$;

-- created_by-only tables
create or replace function private.set_created_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['role_permissions','user_roles','user_permissions','group_members',
                           'document_versions','application_permissions','news_attachments','news_targets']
  loop
    execute format('create trigger set_created_by before insert on public.%I
                    for each row execute function private.set_created_by()', t);
  end loop;
end $$;

create or replace function private.set_settings_meta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
create trigger set_settings_meta before insert or update on public.system_settings
  for each row execute function private.set_settings_meta();

-- Search text maintenance (trigram search on title/number/description/tags)
create or replace function private.documents_search_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_text := lower(concat_ws(' ', new.title, new.doc_number, new.description,
                                     new.doc_type, array_to_string(new.tags, ' ')));
  return new;
end;
$$;
create trigger documents_search_text before insert or update on public.documents
  for each row execute function private.documents_search_text();

create or replace function private.news_search_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'published' and new.publish_at is null then
    new.publish_at := now();
  end if;
  new.search_text := lower(concat_ws(' ', new.title, new.summary,
                    regexp_replace(coalesce(new.content_html, ''), '<[^>]*>', ' ', 'g')));
  return new;
end;
$$;
create trigger news_search_text before insert or update on public.news
  for each row execute function private.news_search_text();
