-- =====================================================================
-- NEXUS — Supabase database setup (run once, in the SQL Editor)
-- Project: "Nexus - Invoice Alert"
--
-- BEFORE running this: create Siddharth's login in
--   Authentication → Users → Add user → Create new user
--   (email siddharth.gupta@univariety.com, a strong password, tick "Auto Confirm User").
-- This script is safe to run again: it only creates what is missing.
-- =====================================================================

-- ---------- 1. People who can sign in (one row per login) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique check (email = lower(email) and email like '%@univariety.com'),
  name        text not null check (length(trim(name)) > 0),
  role        text not null check (role in ('super','admin','member')),
  active      boolean not null default true,
  must_change boolean not null default false,       -- must choose own password at next sign-in
  created_at  timestamptz not null default now()
);
-- only one super admin, ever
create unique index if not exists profiles_one_super on public.profiles ((role)) where role = 'super';

-- ---------- 2. All NEXUS data (statuses, emails sent, history, people, reminders, Order Book) ----------
-- One row per item, e.g. path 'status/GIM-202701', 'sent/s1ab2', 'team/Shiney', 'templates'.
-- value = null means "removed" (kept so other open screens notice the removal).
create table if not exists public.nexus_kv (
  path        text primary key check (length(path) between 1 and 300),
  value       jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create index if not exists nexus_kv_updated on public.nexus_kv (updated_at);

-- stamp every change with the server time and the signed-in user's email (cannot be faked by the browser)
create or replace function public.nexus_kv_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := coalesce(auth.jwt() ->> 'email', 'system');
  return new;
end $$;
drop trigger if exists nexus_kv_stamp on public.nexus_kv;
create trigger nexus_kv_stamp before insert or update on public.nexus_kv
  for each row execute function public.nexus_kv_stamp();

-- ---------- 3. Helper: the signed-in person's role (null if not an active NEXUS user) ----------
create or replace function public.nexus_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- which data a Member may change (mirrors the dashboard: statuses, dates, sending, replies,
-- feedback, history, and the email / client alert switches). Everything else is Admin-only;
-- the base Order Book row is Super-admin-only.
create or replace function public.nexus_can_write(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.nexus_role() is null then false
    when p = 'base' then public.nexus_role() = 'super'
    when public.nexus_role() in ('super','admin') then true
    else (p like 'status/%' or p like 'dates/%' or p like 'sent/%' or p like 'history/%'
          or p like 'replies/%' or p like 'feedback/%' or p like 'entOn/%'
          or p in ('master','testMode','changesSinceBackup','lastBackup'))
  end
$$;

-- user clears their own "must change password" flag after choosing a new password
create or replace function public.nexus_clear_must_change() returns void
language sql security definer set search_path = public as $$
  update public.profiles set must_change = false where id = auth.uid()
$$;

-- ---------- 4. Row-level security (the real lock: nothing is readable without an active NEXUS login) ----------
alter table public.profiles enable row level security;
alter table public.nexus_kv enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.nexus_role() is not null or id = auth.uid());
-- no insert/update/delete policies on profiles: only the nexus-admin server function (service role) changes them

drop policy if exists kv_read on public.nexus_kv;
create policy kv_read on public.nexus_kv for select to authenticated
  using (public.nexus_role() is not null);
drop policy if exists kv_insert on public.nexus_kv;
create policy kv_insert on public.nexus_kv for insert to authenticated
  with check (public.nexus_can_write(path));
drop policy if exists kv_update on public.nexus_kv;
create policy kv_update on public.nexus_kv for update to authenticated
  using (public.nexus_can_write(path)) with check (public.nexus_can_write(path));
-- no delete policy: rows are never deleted from the browser (removals are stored as value = null)

revoke all on public.profiles from anon;
revoke all on public.nexus_kv from anon;
revoke execute on function public.nexus_clear_must_change() from anon;
grant select on public.profiles to authenticated;
grant select, insert, update on public.nexus_kv to authenticated;
grant execute on function public.nexus_role(), public.nexus_can_write(text), public.nexus_clear_must_change() to authenticated;

-- ---------- 5. Make Siddharth the super admin ----------
insert into public.profiles (id, email, name, role, active, must_change)
select id, lower(email), 'Siddharth', 'super', true, false
from auth.users where lower(email) = 'siddharth.gupta@univariety.com'
on conflict (id) do update set role = 'super', active = true;

-- check: this should return one row with role = super
select email, name, role, active from public.profiles;
