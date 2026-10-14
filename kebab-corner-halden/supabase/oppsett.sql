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

-- Sjekker kjøkkenkoden. Etter 20 feil på 10 minutter stoppes alle forsøk en stund.
create or replace function public._kitchen_ok(p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare h text;
begin
  if (select count(*) from public.kitchen_fails where at > now() - interval '10 minutes') >= 20 then
    raise exception 'for mange forsøk, vent litt' using errcode = 'P0001';
  end if;
  select hash into h from public.kitchen_keys where id = 1;
  if h is not null and p_code is not null and extensions.crypt(p_code, h) = h then
    return true;
  end if;
  insert into public.kitchen_fails default values;
  delete from public.kitchen_fails where at < now() - interval '1 day';
  return false;
end $$;

-- Kunden sender en bestilling. Svarer med id, hemmelig token og hentenummer.
create or replace function public.place_order(p_name text, p_pickup text, p_items jsonb, p_phone text default null, p_note text default null, p_lang text default 'no')
returns table (id uuid, token uuid, number int) language plpgsql security definer set search_path = '' as $$
declare
  v_total int := 0; it jsonb; v_num int; v_day date := (now() at time zone 'Europe/Oslo')::date;
  v_items jsonb := '[]'::jsonb;
begin
  if (select count(*) from public.orders o where o.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'for mange bestillinger akkurat nå' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'ugyldig bestilling' using errcode = 'P0001';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(it->'navn') is distinct from 'string' or char_length(it->>'navn') not between 1 and 80
       or jsonb_typeof(it->'antall') is distinct from 'number' or (it->>'antall')::numeric not between 1 and 20
       or jsonb_typeof(it->'pris') is distinct from 'number' or (it->>'pris')::numeric not between 0 and 5000
       or char_length(coalesce(it->>'storrelse', '')) > 30
       or char_length(coalesce(it->>'onske', '')) > 120 then
      raise exception 'ugyldig rett i bestillingen' using errcode = 'P0001';
    end if;
    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'navn', it->>'navn', 'storrelse', nullif(it->>'storrelse', ''), 'antall', (it->>'antall')::int,
      'pris', (it->>'pris')::int, 'onske', nullif(trim(it->>'onske'), ''))));
    v_total := v_total + (it->>'antall')::int * (it->>'pris')::int;
  end loop;

  perform pg_advisory_xact_lock(hashtext('kc-order-number'));
  select coalesce(max(o.number), 0) + 1 into v_num from public.orders o
    where (o.created_at at time zone 'Europe/Oslo')::date = v_day;

  delete from public.orders o where o.created_at < now() - interval '30 days';  -- personopplysninger slettes etter 30 dager

  return query insert into public.orders as o (number, name, phone, pickup, items, total, note, lang)
    values (v_num, trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), p_pickup, v_items, v_total,
            nullif(trim(coalesce(p_note, '')), ''), case when p_lang = 'en' then 'en' else 'no' end)
    returning o.id, o.token, o.number;
end $$;

-- Kunden ser status på sin egen bestilling (krever id og hemmelig token)
create or replace function public.order_status(p_id uuid, p_token uuid)
returns table (number int, status text, status_at timestamptz, pickup text, total int, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.number, o.status, o.status_at, o.pickup, o.total, o.created_at
  from public.orders o where o.id = p_id and o.token = p_token;
$$;

-- Kjøkkenet: sjekk koden
create or replace function public.kitchen_login(p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  return public._kitchen_ok(p_code);
end $$;

-- Kjøkkenet: bestillinger fra de siste 20 timene
create or replace function public.kitchen_orders(p_code text)
returns table (id uuid, number int, created_at timestamptz, name text, phone text, pickup text, items jsonb,
               total int, note text, lang text, status text, status_at timestamptz, payment text)
language plpgsql security definer set search_path = '' as $$
begin
  if not public._kitchen_ok(p_code) then
    raise exception 'feil kjøkkenkode' using errcode = '28000';
  end if;
  return query select o.id, o.number, o.created_at, o.name, o.phone, o.pickup, o.items, o.total, o.note, o.lang,
                      o.status, o.status_at, o.payment
    from public.orders o
    where o.created_at > now() - interval '20 hours'
    order by o.created_at;
end $$;

-- Kjøkkenet: endre status (ny, lager, klar, hentet, avvist)
create or replace function public.kitchen_set_status(p_code text, p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public._kitchen_ok(p_code) then
    raise exception 'feil kjøkkenkode' using errcode = '28000';
  end if;
  if p_status not in ('ny', 'lager', 'klar', 'hentet', 'avvist') then
    raise exception 'ugyldig status' using errcode = 'P0001';
  end if;
  update public.orders set status = p_status, status_at = now() where orders.id = p_id;
end $$;

-- Kjøkkenet: bytt kode. Første gang (ingen kode lagret) settes koden uten å oppgi den gamle.
create or replace function public.kitchen_change_code(p_code text, p_new text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if char_length(coalesce(p_new, '')) < 10 then
    raise exception 'den nye koden må ha minst 10 tegn' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.kitchen_keys) then
    raise exception 'ingen kjøkkenkode er satt ennå' using errcode = 'P0001';
  end if;
  if not public._kitchen_ok(p_code) then
    raise exception 'feil kjøkkenkode' using errcode = '28000';
  end if;
  update public.kitchen_keys set hash = extensions.crypt(p_new, extensions.gen_salt('bf')), updated_at = now() where id = 1;
end $$;

revoke all on function public._kitchen_ok(text) from public, anon, authenticated;
revoke all on function public.place_order(text, text, jsonb, text, text, text) from public;
revoke all on function public.order_status(uuid, uuid) from public;
revoke all on function public.kitchen_login(text) from public;
revoke all on function public.kitchen_orders(text) from public;
revoke all on function public.kitchen_set_status(text, uuid, text) from public;
revoke all on function public.kitchen_change_code(text, text) from public;
grant execute on function public.place_order(text, text, jsonb, text, text, text) to anon, authenticated;
grant execute on function public.order_status(uuid, uuid) to anon, authenticated;
grant execute on function public.kitchen_login(text) to anon, authenticated;
grant execute on function public.kitchen_orders(text) to anon, authenticated;
grant execute on function public.kitchen_set_status(text, uuid, text) to anon, authenticated;
grant execute on function public.kitchen_change_code(text, text) to anon, authenticated;

-- Til slutt: sett kjøkkenkoden. Bytt ut teksten mellom de enkle anførselstegnene med en lang kode
-- (minst 10 tegn) og kjør bare denne linjen. Koden skrives inn én gang på kjøkkenskjermen.
-- insert into public.kitchen_keys (hash) values (extensions.crypt('BYTT-TIL-EN-LANG-KODE', extensions.gen_salt('bf')))
--   on conflict (id) do update set hash = excluded.hash, updated_at = now();
