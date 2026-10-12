-- OwnSite token credits (replaces the $19 plan). Run once in the nwlhs project (SQL editor).
-- Free monthly tokens live in ownsite_usage (existing). Bought tokens live here and never expire.
-- Only the Edge Functions (service role) write; users can read their own rows.

create table if not exists public.ownsite_credits (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  tokens      bigint not null default 0 check (tokens >= 0),
  ever_bought boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.ownsite_purchases (
  session_id   text primary key,                 -- Stripe Checkout Session id (makes the webhook idempotent)
  user_id      uuid not null references auth.users(id) on delete cascade,
  tokens       bigint not null,
  amount_cents integer not null,
  created_at   timestamptz not null default now()
);

alter table public.ownsite_credits   enable row level security;
alter table public.ownsite_purchases enable row level security;

drop policy if exists ownsite_credits_select_own on public.ownsite_credits;
create policy ownsite_credits_select_own on public.ownsite_credits
  for select to authenticated using (user_id = auth.uid());

drop policy if exists ownsite_purchases_select_own on public.ownsite_purchases;
create policy ownsite_purchases_select_own on public.ownsite_purchases
  for select to authenticated using (user_id = auth.uid());

-- Add bought tokens once per Stripe session. Returns the new credit balance.
create or replace function public.ownsite_add_credits(p_user uuid, p_tokens bigint, p_session text, p_amount integer)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
  bal bigint;
begin
  insert into public.ownsite_purchases (session_id, user_id, tokens, amount_cents)
  values (p_session, p_user, p_tokens, p_amount)
  on conflict (session_id) do nothing;
  get diagnostics inserted = row_count;

  if inserted = 1 then
    insert into public.ownsite_credits (user_id, tokens, ever_bought)
    values (p_user, greatest(p_tokens, 0), true)
    on conflict (user_id)
    do update set tokens = public.ownsite_credits.tokens + greatest(p_tokens, 0),
                  ever_bought = true, updated_at = now();
  end if;

  select tokens into bal from public.ownsite_credits where user_id = p_user;
  return coalesce(bal, 0);
end;
$$;

-- Take tokens: free monthly tokens first, then bought credits. Never goes below zero
-- (anything beyond what the user has is absorbed by us). Returns the new balances.
create or replace function public.ownsite_charge(p_user uuid, p_tokens bigint, p_free_limit bigint)
returns table(out_used bigint, out_credits bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  per date := date_trunc('month', now())::date;
  u bigint; c bigint; want bigint; free_left bigint; from_free bigint; from_credit bigint;
begin
  want := greatest(p_tokens, 0);
  insert into public.ownsite_usage (user_id, period, tokens_used) values (p_user, per, 0)
    on conflict (user_id, period) do nothing;
  insert into public.ownsite_credits (user_id) values (p_user) on conflict (user_id) do nothing;

  select tokens_used into u from public.ownsite_usage where user_id = p_user and period = per for update;
  select tokens into c from public.ownsite_credits where user_id = p_user for update;

  free_left   := greatest(p_free_limit - u, 0);
  from_free   := least(want, free_left);
  from_credit := least(want - from_free, c);

  update public.ownsite_usage set tokens_used = u + from_free, updated_at = now()
    where user_id = p_user and period = per;
  update public.ownsite_credits set tokens = c - from_credit, updated_at = now() where user_id = p_user;

  out_used := u + from_free;
  out_credits := c - from_credit;
  return next;
end;
$$;

revoke all on function public.ownsite_add_credits(uuid, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.ownsite_charge(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ownsite_add_credits(uuid, bigint, text, integer) to service_role;
grant execute on function public.ownsite_charge(uuid, bigint, bigint) to service_role;
