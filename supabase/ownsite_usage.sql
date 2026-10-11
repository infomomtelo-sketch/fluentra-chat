-- OwnSite usage metering. Run once in the nwlhs project (SQL editor).
-- Uses its own table + function (ownsite_ prefix) so it never touches Title22 tables.
-- Pro status is read from the existing profiles.ownsite_pro boolean.

create table if not exists public.ownsite_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  period      date not null,                 -- first day of the month
  tokens_used bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, period)
);

alter table public.ownsite_usage enable row level security;

drop policy if exists ownsite_usage_select_own on public.ownsite_usage;
create policy ownsite_usage_select_own on public.ownsite_usage
  for select to authenticated using (user_id = auth.uid());
-- No insert/update policies: only the Edge Function (service role) writes.

create or replace function public.ownsite_add_usage(p_user uuid, p_tokens bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  p date := date_trunc('month', now())::date;
  total bigint;
begin
  insert into public.ownsite_usage (user_id, period, tokens_used)
  values (p_user, p, greatest(p_tokens, 0))
  on conflict (user_id, period)
  do update set tokens_used = public.ownsite_usage.tokens_used + greatest(p_tokens, 0),
                updated_at = now()
  returning tokens_used into total;
  return total;
end;
$$;

revoke all on function public.ownsite_add_usage(uuid, bigint) from public, anon, authenticated;
grant execute on function public.ownsite_add_usage(uuid, bigint) to service_role;
