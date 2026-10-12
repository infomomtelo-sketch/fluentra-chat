-- OwnSite multi-page builds. Run once in the nwlhs project (SQL editor).
-- Own table (ownsite_ prefix); only the Edge Function (service role) writes.

create table if not exists public.ownsite_builds (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  idea       text not null,
  plan       jsonb not null,
  files      jsonb not null default '{}'::jsonb,   -- { "index.html": "<html>…" }
  estimate   integer not null,                      -- tokens quoted to the user
  reserved   integer not null,                      -- most the user can be charged (125% of estimate)
  charged    integer not null default 0,            -- tokens actually taken from their allowance
  actual     integer not null default 0,            -- tokens the AI really used (we absorb the difference)
  status     text not null default 'planned',       -- planned | building | done
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ownsite_builds_user_idx on public.ownsite_builds (user_id, created_at desc);

alter table public.ownsite_builds enable row level security;

drop policy if exists ownsite_builds_select_own on public.ownsite_builds;
create policy ownsite_builds_select_own on public.ownsite_builds
  for select to authenticated using (user_id = auth.uid());
-- No insert/update policies: only the Edge Function (service role) writes.
