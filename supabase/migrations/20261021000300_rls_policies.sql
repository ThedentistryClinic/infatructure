-- =============================================================================
-- Company Intranet Portal — 0003 Grants & Row Level Security
-- Every table has RLS enabled. Policies are separate per command.
-- anon (not logged in) gets nothing except public system settings.
-- =============================================================================

-- Helper schema usable from policies evaluated as `authenticated`
grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;
revoke execute on function private.bootstrap_super_admin(text) from authenticated;
revoke execute on function private.write_audit(text, text, text, text, jsonb) from authenticated;
revoke execute on function private.handle_new_user() from authenticated;

-- Table privileges: least privilege. RLS still filters every row.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.system_settings to anon;

grant select, update                 on public.profiles                to authenticated;
grant select, insert, update, delete on public.departments             to authenticated;
grant select, insert, update, delete on public.roles                   to authenticated;
grant select                         on public.permissions             to authenticated;
grant select, insert, delete         on public.role_permissions        to authenticated;
grant select, insert, delete         on public.user_roles              to authenticated;
grant select, insert, update, delete on public.user_permissions        to authenticated;
grant select, insert, update, delete on public.groups                  to authenticated;
grant select, insert, delete         on public.group_members           to authenticated;
grant select, insert, update, delete on public.document_categories     to authenticated;
grant select, insert, update, delete on public.documents               to authenticated;
grant select                         on public.document_versions       to authenticated;
grant select, insert, update, delete on public.document_permissions    to authenticated;
grant select, insert, update, delete on public.applications            to authenticated;
grant select, insert, update, delete on public.application_permissions to authenticated;
grant select                         on public.application_usage       to authenticated;
grant select, insert, update, delete on public.news                    to authenticated;
grant select, insert, delete         on public.news_attachments        to authenticated;
grant select, insert, delete         on public.news_targets            to authenticated;
grant select, insert                 on public.news_reads              to authenticated;
grant select                         on public.news_revisions          to authenticated;
grant select, insert, delete         on public.favorites               to authenticated;
grant select                         on public.audit_logs              to authenticated;
grant select, insert, update, delete on public.system_settings         to authenticated;

-- Enable RLS everywhere
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ----------------------------------------------------------------- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_active_user()));
create policy profiles_update on public.profiles for update to authenticated
  using ((id = (select auth.uid()) and (select private.is_active_user())) or private.can_manage_user(id))
  with check ((id = (select auth.uid()) and (select private.is_active_user())) or private.can_manage_user(id));
-- INSERT: only via auth trigger. DELETE: only via Auth admin (cascade).

-- -------------------------------------------------------------- departments
create policy departments_select on public.departments for select to authenticated
  using ((select private.is_active_user()));
create policy departments_insert on public.departments for insert to authenticated
  with check ((select private.has_permission('departments.manage')));
create policy departments_update on public.departments for update to authenticated
  using ((select private.has_permission('departments.manage')))
  with check ((select private.has_permission('departments.manage')));
create policy departments_delete on public.departments for delete to authenticated
  using ((select private.has_permission('departments.manage')));

-- -------------------------------------------------------------------- roles
create policy roles_select on public.roles for select to authenticated
  using ((select private.is_active_user()));
create policy roles_insert on public.roles for insert to authenticated
  with check ((select private.has_permission('roles.manage')) and
              ((select private.is_super_admin()) or level < (select private.my_level())));
create policy roles_update on public.roles for update to authenticated
  using ((select private.has_permission('roles.manage')))
  with check ((select private.has_permission('roles.manage')));
create policy roles_delete on public.roles for delete to authenticated
  using ((select private.has_permission('roles.manage')) and not is_system);

-- -------------------------------------------------------------- permissions
create policy permissions_select on public.permissions for select to authenticated
  using ((select private.is_active_user()));

-- --------------------------------------------------------- role_permissions
create policy role_permissions_select on public.role_permissions for select to authenticated
  using ((select private.is_active_user()));
create policy role_permissions_insert on public.role_permissions for insert to authenticated
  with check ((select private.is_super_admin()));
create policy role_permissions_delete on public.role_permissions for delete to authenticated
  using ((select private.is_super_admin()));

-- --------------------------------------------------------------- user_roles
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_permission('users.view')));
create policy user_roles_insert on public.user_roles for insert to authenticated
  with check (private.can_assign_role(user_id, role_id));
create policy user_roles_delete on public.user_roles for delete to authenticated
  using (private.can_assign_role(user_id, role_id));

-- --------------------------------------------------------- user_permissions
-- Individual permission grants are Super Admin only (they can bypass scopes).
create policy user_permissions_select on public.user_permissions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_permission('users.view')));
create policy user_permissions_insert on public.user_permissions for insert to authenticated
  with check ((select private.is_super_admin()));
create policy user_permissions_update on public.user_permissions for update to authenticated
  using ((select private.is_super_admin())) with check ((select private.is_super_admin()));
create policy user_permissions_delete on public.user_permissions for delete to authenticated
  using ((select private.is_super_admin()));

-- ------------------------------------------------------------------- groups
create policy groups_select on public.groups for select to authenticated
  using ((select private.is_active_user()));
create policy groups_insert on public.groups for insert to authenticated
  with check ((select private.has_permission('groups.manage')));
create policy groups_update on public.groups for update to authenticated
  using ((select private.has_permission('groups.manage')))
  with check ((select private.has_permission('groups.manage')));
create policy groups_delete on public.groups for delete to authenticated
  using ((select private.has_permission('groups.manage')));

create policy group_members_select on public.group_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_permission('groups.manage'))
         or (select private.has_permission('users.view')));
create policy group_members_insert on public.group_members for insert to authenticated
  with check ((select private.has_permission('groups.manage')));
create policy group_members_delete on public.group_members for delete to authenticated
  using ((select private.has_permission('groups.manage')));

-- ------------------------------------------------------ document_categories
create policy doc_categories_select on public.document_categories for select to authenticated
  using ((select private.is_active_user()));
create policy doc_categories_insert on public.document_categories for insert to authenticated
  with check ((select private.has_permission('doc_categories.manage')));
create policy doc_categories_update on public.document_categories for update to authenticated
  using ((select private.has_permission('doc_categories.manage')))
  with check ((select private.has_permission('doc_categories.manage')));
create policy doc_categories_delete on public.document_categories for delete to authenticated
  using ((select private.has_permission('doc_categories.manage')));

-- ---------------------------------------------------------------- documents
-- SELECT hides title AND metadata of anything the user may not view.
-- The direct owner/creator check is required for INSERT ... RETURNING: the
-- helper cannot see a row inserted by the same statement.
create policy documents_select on public.documents for select to authenticated
  using (((owner_id = (select auth.uid()) or created_by = (select auth.uid())) and (select private.is_active_user()))
         or private.can_doc(id, 'view'));
create policy documents_insert on public.documents for insert to authenticated
  with check (
    (select private.has_permission('documents.upload'))
    and (department_id = (select private.user_department())
         or (select private.has_permission('documents.upload_any_department')))
  );
create policy documents_update on public.documents for update to authenticated
  using (private.can_doc(id, 'edit'))
  with check (private.can_doc(id, 'edit'));
-- Hard delete: only global document admins, only items already in the trash.
create policy documents_delete on public.documents for delete to authenticated
  using ((select private.has_permission('documents.manage_all')) and deleted_at is not null);

create policy document_versions_select on public.document_versions for select to authenticated
  using (private.can_doc(document_id, 'view'));

create policy document_permissions_select on public.document_permissions for select to authenticated
  using (private.can_doc(document_id, 'share') or user_id = (select auth.uid()));
create policy document_permissions_insert on public.document_permissions for insert to authenticated
  with check (private.can_doc(document_id, 'share'));
create policy document_permissions_update on public.document_permissions for update to authenticated
  using (private.can_doc(document_id, 'share'))
  with check (private.can_doc(document_id, 'share'));
create policy document_permissions_delete on public.document_permissions for delete to authenticated
  using (private.can_doc(document_id, 'share'));

-- ------------------------------------------------------------- applications
create policy applications_select on public.applications for select to authenticated
  using (private.can_view_app(id));
create policy applications_insert on public.applications for insert to authenticated
  with check ((select private.has_permission('apps.manage')));
create policy applications_update on public.applications for update to authenticated
  using ((select private.has_permission('apps.manage')))
  with check ((select private.has_permission('apps.manage')));
create policy applications_delete on public.applications for delete to authenticated
  using ((select private.has_permission('apps.manage')));

create policy app_permissions_select on public.application_permissions for select to authenticated
  using ((select private.has_permission('apps.manage')));
create policy app_permissions_insert on public.application_permissions for insert to authenticated
  with check ((select private.has_permission('apps.manage')));
create policy app_permissions_update on public.application_permissions for update to authenticated
  using ((select private.has_permission('apps.manage')))
  with check ((select private.has_permission('apps.manage')));
create policy app_permissions_delete on public.application_permissions for delete to authenticated
  using ((select private.has_permission('apps.manage')));

create policy app_usage_select on public.application_usage for select to authenticated
  using (user_id = (select auth.uid()));

-- --------------------------------------------------------------------- news
create policy news_select on public.news for select to authenticated
  using ((created_by = (select auth.uid()) and (select private.is_active_user()))
         or private.can_view_news(id));
create policy news_insert on public.news for insert to authenticated
  with check ((select private.has_permission('news.manage'))
              or ((select private.has_permission('news.create'))
                  and department_id = (select private.user_department())));
create policy news_update on public.news for update to authenticated
  using (private.can_edit_news(id))
  with check (private.can_edit_news(id));
create policy news_delete on public.news for delete to authenticated
  using (private.can_edit_news(id));

create policy news_attachments_select on public.news_attachments for select to authenticated
  using (private.can_view_news(news_id));
create policy news_attachments_insert on public.news_attachments for insert to authenticated
  with check (private.can_edit_news(news_id));
create policy news_attachments_delete on public.news_attachments for delete to authenticated
  using (private.can_edit_news(news_id));

create policy news_targets_select on public.news_targets for select to authenticated
  using (private.can_edit_news(news_id));
create policy news_targets_insert on public.news_targets for insert to authenticated
  with check (private.can_edit_news(news_id));
create policy news_targets_delete on public.news_targets for delete to authenticated
  using (private.can_edit_news(news_id));

create policy news_reads_select on public.news_reads for select to authenticated
  using (user_id = (select auth.uid()) or private.can_edit_news(news_id));
create policy news_reads_insert on public.news_reads for insert to authenticated
  with check (user_id = (select auth.uid()) and private.can_view_news(news_id));

create policy news_revisions_select on public.news_revisions for select to authenticated
  using (private.can_edit_news(news_id));

-- ---------------------------------------------------------------- favorites
create policy favorites_select on public.favorites for select to authenticated
  using (user_id = (select auth.uid()));
create policy favorites_insert on public.favorites for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_active_user()));
create policy favorites_delete on public.favorites for delete to authenticated
  using (user_id = (select auth.uid()));

-- --------------------------------------------------------------- audit_logs
-- Read-only for auditors; rows are written only by SECURITY DEFINER code.
create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((select private.has_permission('audit.view')));

-- ---------------------------------------------------------- system_settings
create policy settings_select_anon on public.system_settings for select to anon
  using (visibility = 'public');
create policy settings_select on public.system_settings for select to authenticated
  using (visibility = 'public'
         or (visibility = 'authenticated' and (select private.is_active_user()))
         or (select private.has_permission('settings.manage')));
create policy settings_insert on public.system_settings for insert to authenticated
  with check ((select private.has_permission('settings.manage')));
create policy settings_update on public.system_settings for update to authenticated
  using ((select private.has_permission('settings.manage')))
  with check ((select private.has_permission('settings.manage')));
create policy settings_delete on public.system_settings for delete to authenticated
  using ((select private.has_permission('settings.manage')));
