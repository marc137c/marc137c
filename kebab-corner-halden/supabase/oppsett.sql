-- Oppsett for bestilling og kjøkkenskjerm. Lim inn hele filen i Supabase > SQL Editor og trykk Run.
-- Filen kan kjøres flere ganger uten å miste bestillinger.
-- Tabellene kan bare nås gjennom funksjonene under. Kunden ser bare sin egen bestilling,
-- og bare den med kjøkkenkoden ser listen og kan endre status.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  token uuid not null default gen_random_uuid(),     -- hemmelig nøkkel kunden bruker for å se sin egen bestilling
  number int not null,                                 -- hentenummer, starter på 1 hver dag (norsk tid)
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 40),
  phone text check (phone is null or char_length(phone) <= 20),
  pickup text not null check (pickup = 'asap' or pickup ~ '^[0-2][0-9]:[0-5][0-9]$'),
  items jsonb not null,
  total int not null check (total between 0 and 100000),
  note text check (note is null or char_length(note) <= 300),
  lang text not null default 'no' check (lang in ('no', 'en')),
  status text not null default 'ny' check (status in ('ny', 'lager', 'klar', 'hentet', 'avvist')),
  status_at timestamptz not null default now(),
  payment text not null default 'ved_henting' check (payment in ('ved_henting', 'betalt', 'refundert'))  -- klar for nettbetaling senere
);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
alter table public.orders enable row level security;
revoke all on public.orders from anon, authenticated;

create table if not exists public.kitchen_keys (
  id int primary key default 1 check (id = 1),
  hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.kitchen_keys enable row level security;
revoke all on public.kitchen_keys from anon, authenticated;

create table if not exists public.kitchen_fails (at timestamptz not null default now());
alter table public.kitchen_fails enable row level security;
revoke all on public.kitchen_fails from anon, authenticated;

-- Testfunksjoner fra oppsettet
drop function if exists public.kc_ping();
drop function if exists public.kc_t2(text);
drop function if exists public.kc_t3(text);
drop function if exists public.kc_t4(text);
drop function if exists public.kc_t5(text);
drop function if exists public.kitchen_change_code(text, text);
drop function if exists public.kitchen_set_status(text, uuid, text);  -- returnerte void i første utgave

-- Funksjonene er delt i små hjelpefunksjoner uten DECLARE. Supabase-verktøyet som satte opp
-- databasen, stoppet lengre funksjonskropper, og slik kan filen kjøres både der og i SQL-editoren.

-- Kjøkkenkoden: riktig kode, logg feil forsøk, og stopp etter 20 feil på 10 minutter
create or replace function public.kc_a(p text) returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.kitchen_keys k where k.id = 1 and k.hash = extensions.crypt(p, k.hash))
$$;
create or replace function public.kc_b() returns void language plpgsql security definer set search_path = '' as $$
begin insert into public.kitchen_fails default values; end $$;
create or replace function public.kc_c() returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.kitchen_fails where at > now() - interval '10 minutes') >= 20 then
    raise exception 'vent litt' using errcode = 'P0001';
  end if;
end $$;
create or replace function public.kc_d() returns void language plpgsql security definer set search_path = '' as $$
begin delete from public.kitchen_fails where at < now() - interval '1 day'; end $$;
create or replace function public._kitchen_ok(p_code text) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.kc_c();
  if p_code is not null and public.kc_a(p_code) then return true; end if;
  perform public.kc_b(); perform public.kc_d();
  return false;
end $$;

-- Bestillingen: sjekk rettene, rydd dem, regn ut sum og neste hentenummer
create or replace function public.kc_items_ok(p_items jsonb) returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) between 1 and 50
    and not exists (select 1 from jsonb_array_elements(p_items) it(v) where
      jsonb_typeof(it.v->'navn') is distinct from 'string' or char_length(it.v->>'navn') not between 1 and 80
      or jsonb_typeof(it.v->'antall') is distinct from 'number' or jsonb_typeof(it.v->'pris') is distinct from 'number'
      or char_length(coalesce(it.v->>'storrelse', '')) > 30 or char_length(coalesce(it.v->>'onske', '')) > 120)
    and not exists (select 1 from jsonb_array_elements(p_items) it(v) where
      (it.v->>'antall')::numeric not between 1 and 20 or (it.v->>'pris')::numeric not between 0 and 5000
      or (it.v->>'antall')::numeric <> floor((it.v->>'antall')::numeric) or (it.v->>'pris')::numeric <> floor((it.v->>'pris')::numeric))
$$;
create or replace function public.kc_items_clean(p_items jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('navn', it.v->>'navn', 'storrelse', nullif(it.v->>'storrelse', ''),
    'antall', (it.v->>'antall')::int, 'pris', (it.v->>'pris')::int, 'onske', nullif(trim(it.v->>'onske'), ''))) order by it.n)
  from jsonb_array_elements(p_items) with ordinality it(v, n)
$$;
create or replace function public.kc_items_total(p_items jsonb) returns int language sql immutable set search_path = '' as $$
  select coalesce(sum((it.v->>'antall')::int * (it.v->>'pris')::int), 0)::int from jsonb_array_elements(p_items) it(v)
$$;
create or replace function public.kc_next_number() returns int language sql stable set search_path = '' as $$
  select coalesce(max(o.number), 0) + 1 from public.orders o
  where (o.created_at at time zone 'Europe/Oslo')::date = (now() at time zone 'Europe/Oslo')::date
$$;
create or replace function public.kc_cleanup() returns void language plpgsql security definer set search_path = '' as $$
begin delete from public.orders o where o.created_at < now() - interval '30 days'; end $$;  -- personopplysninger slettes etter 30 dager
create or replace function public.kc_rate_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.orders o where o.created_at > now() - interval '1 minute') < 30
$$;

-- Kunden sender en bestilling. Svarer med id, hemmelig token og hentenummer.
create or replace function public.place_order(p_name text, p_pickup text, p_items jsonb, p_phone text default null, p_note text default null, p_lang text default 'no')
returns table (id uuid, token uuid, number int) language plpgsql security definer set search_path = '' as $$
begin
  if not public.kc_rate_ok() then raise exception 'for mange bestillinger akkurat naa' using errcode = 'P0001'; end if;
  if not coalesce(public.kc_items_ok(p_items), false) then raise exception 'ugyldig bestilling' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('kc-order-number'));
  perform public.kc_cleanup();
  return query insert into public.orders as o (number, name, phone, pickup, items, total, note, lang)
    values (public.kc_next_number(), trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), p_pickup,
            public.kc_items_clean(p_items), public.kc_items_total(p_items), nullif(trim(coalesce(p_note, '')), ''),
            case when p_lang = 'en' then 'en' else 'no' end)
    returning o.id, o.token, o.number;
end $$;

-- Kunden ser status på sin egen bestilling (krever id og hemmelig token)
create or replace function public.order_status(p_id uuid, p_token uuid)
returns table (number int, status text, status_at timestamptz, pickup text, total int, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.number, o.status, o.status_at, o.pickup, o.total, o.created_at from public.orders o where o.id = p_id and o.token = p_token
$$;

-- Kjøkkenet. Feil kode gir false eller tom liste (ikke feilmelding), så forsøket blir lagret og telt.
create or replace function public.kitchen_login(p_code text) returns boolean language plpgsql security definer set search_path = '' as $$
begin return public._kitchen_ok(p_code); end $$;

create or replace function public.kitchen_orders(p_code text)
returns table (id uuid, number int, created_at timestamptz, name text, phone text, pickup text, items jsonb,
               total int, note text, lang text, status text, status_at timestamptz, payment text)
language plpgsql security definer set search_path = '' as $$
begin
  if not public._kitchen_ok(p_code) then return; end if;
  return query select o.id, o.number, o.created_at, o.name, o.phone, o.pickup, o.items, o.total, o.note, o.lang,
                      o.status, o.status_at, o.payment
    from public.orders o where o.created_at > now() - interval '20 hours' order by o.created_at;
end $$;

create or replace function public.kitchen_set_status(p_code text, p_id uuid, p_status text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('ny', 'lager', 'klar', 'hentet', 'avvist') then raise exception 'ugyldig status' using errcode = 'P0001'; end if;
  if not public._kitchen_ok(p_code) then return false; end if;
  update public.orders o set status = p_status, status_at = now() where o.id = p_id;
  return found;
end $$;

revoke all on function public._kitchen_ok(text), public.kc_a(text), public.kc_b(), public.kc_c(), public.kc_d(),
  public.kc_items_ok(jsonb), public.kc_items_clean(jsonb), public.kc_items_total(jsonb), public.kc_next_number(),
  public.kc_cleanup(), public.kc_rate_ok() from public, anon, authenticated;
revoke all on function public.place_order(text, text, jsonb, text, text, text), public.order_status(uuid, uuid),
  public.kitchen_login(text), public.kitchen_orders(text), public.kitchen_set_status(text, uuid, text) from public;
grant execute on function public.place_order(text, text, jsonb, text, text, text), public.order_status(uuid, uuid),
  public.kitchen_login(text), public.kitchen_orders(text), public.kitchen_set_status(text, uuid, text) to anon, authenticated;

-- Til slutt: sett kjøkkenkoden. Bytt ut teksten mellom de enkle anførselstegnene med en lang kode
-- (minst 10 tegn) og kjør bare denne linjen. Koden skrives inn én gang på kjøkkenskjermen.
-- insert into public.kitchen_keys (hash) values (extensions.crypt('BYTT-TIL-EN-LANG-KODE', extensions.gen_salt('bf')))
--   on conflict (id) do update set hash = excluded.hash, updated_at = now();
