-- =============================================================================
-- Company Intranet Portal — 0005 Storage buckets & policies
-- Both buckets are PRIVATE. Files are reachable only through short-lived
-- signed URLs, which Storage issues only when the SELECT policy below passes.
--   documents/<document_id>/v<version>-<timestamp>-<safe_name>
--   news/<news_id>/<kind>-<timestamp>-<safe_name>
-- File type & size are enforced server-side by the bucket configuration.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('documents', 'documents', false, 52428800,  -- 50 MB
   array[
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'image/jpeg', 'image/png', 'text/plain', 'text/csv', 'application/zip'
   ]),
  ('news', 'news', false, 20971520,           -- 20 MB
   array[
     'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation'
   ])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------- documents bucket
create policy "documents: read with document right" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and private.can_read_document_object(name));

create policy "documents: upload with upload right" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents'
              and private.can_doc(private.path_uuid(name), 'upload')
              and name !~ '\.\.');

-- No UPDATE policy: versions are immutable (always upload a new object).
create policy "documents: delete by document admins" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and private.has_permission('documents.manage_all'));

-- ---------------------------------------------------------------- news bucket
create policy "news: read when news visible" on storage.objects
  for select to authenticated
  using (bucket_id = 'news' and private.can_view_news(private.path_uuid(name)));

create policy "news: upload by editors" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'news' and private.can_edit_news(private.path_uuid(name)) and name !~ '\.\.');

create policy "news: delete by editors" on storage.objects
  for delete to authenticated
  using (bucket_id = 'news' and private.can_edit_news(private.path_uuid(name)));
