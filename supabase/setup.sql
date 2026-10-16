-- Supabase > SQL Editor에서 한 번 실행합니다.
create table if not exists public.showcase_projects (
  id uuid primary key,
  body jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.showcase_projects enable row level security;
-- 브라우저에서 직접 읽거나 쓰는 정책은 만들지 않습니다.
-- 서버의 service_role 키만 사용합니다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-plans', 'project-plans', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];
