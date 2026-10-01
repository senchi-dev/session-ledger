-- Session Ledger: database setup. Paste the whole file into Supabase → SQL Editor → Run. Safe to run twice.
-- Every row belongs to one signed-in user; row-level security stops any other account reading or writing it.

create table if not exists public.ledger_trades (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.ledger_images (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  id         text not null,
  trade_id   text,
  label      text,
  created    bigint,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.ledger_settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb,
  updated_at timestamptz not null default now()
);

-- updated_at is always the server clock, so devices can ask for "everything changed since my last sync".
create or replace function public.ledger_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['ledger_trades', 'ledger_images', 'ledger_settings'] loop
    execute format('drop trigger if exists ledger_touch on public.%I', t);
    execute format('create trigger ledger_touch before insert or update on public.%I for each row execute function public.ledger_touch()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists ledger_owner on public.%I', t);
    execute format('create policy ledger_owner on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create index if not exists %I on public.%I (user_id, updated_at)', t || '_since', t);
  end loop;
end $$;

-- Screenshots: a private bucket, one folder per user.
insert into storage.buckets (id, name, public) values ('ledger-shots', 'ledger-shots', false)
on conflict (id) do nothing;

drop policy if exists ledger_shots_owner on storage.objects;
create policy ledger_shots_owner on storage.objects for all to authenticated
  using (bucket_id = 'ledger-shots' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'ledger-shots' and (storage.foldername(name))[1] = (select auth.uid())::text);
