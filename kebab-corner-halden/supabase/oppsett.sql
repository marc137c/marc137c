-- Oppsett for menyen og eiersiden (admin.html). Lim inn hele filen i Supabase > SQL Editor og trykk Run.
-- Filen kan kjøres flere ganger uten å miste menyen, historikken eller eierkoden.
-- Tabellene kan bare nås gjennom funksjonene under. Alle kan lese menyen,
-- men bare den med eierkoden kan lagre, se tidligere versjoner, hente dem tilbake og bytte koden.

create extension if not exists pgcrypto with schema extensions;

-- Innholdet på siden: 'meny' (samme form som window.MENY_DATA i meny.js) og 'innstillinger' (åpningstider og tilbud, til senere).
-- Versjonen øker med 1 for hver lagring, så to som lagrer samtidig ikke skriver over hverandre.
create table if not exists public.site_content (
  key text primary key check (key in ('meny', 'innstillinger')),
  data jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.site_content enable row level security;
revoke all on public.site_content from anon, authenticated;

-- Tidligere versjoner, så eieren kan angre. De 30 siste per nøkkel blir tatt vare på.
create table if not exists public.site_content_history (
  id bigint generated always as identity primary key,
  key text not null,
  version int not null,
  data jsonb not null,
  saved_at timestamptz not null default now()
);
create index if not exists site_content_history_key_idx on public.site_content_history (key, version desc);
alter table public.site_content_history enable row level security;
revoke all on public.site_content_history from anon, authenticated;

-- Eierkoden, bare som bcrypt-hash
create table if not exists public.owner_keys (
  id int primary key default 1 check (id = 1),
  hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.owner_keys enable row level security;
revoke all on public.owner_keys from anon, authenticated;

-- Feil forsøk på eierkoden. Tabellen heter kitchen_fails fordi den ble laget for kjøkkenkoden.
-- Navnet er beholdt så databasen som allerede kjører, og funksjonene under, virker som før.
create table if not exists public.kitchen_fails (at timestamptz not null default now());
alter table public.kitchen_fails enable row level security;
revoke all on public.kitchen_fails from anon, authenticated;

-- Den gamle nettbestillingen og kjøkkenskjermen er tatt bort. Finnes de i databasen, blir de stengt,
-- men bestillingene og kjøkkenkoden (orders og kitchen_keys) blir liggende.
drop function if exists public.kc_ping();
drop function if exists public.kc_t2(text);
drop function if exists public.kc_t3(text);
drop function if exists public.kc_t4(text);
drop function if exists public.kc_t5(text);
drop function if exists public.kitchen_change_code(text, text);
do $$
begin
  if to_regprocedure('public.place_order(text, text, jsonb, text, text, text)') is not null then
    revoke execute on function public.place_order(text, text, jsonb, text, text, text) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.order_status(uuid, uuid)') is not null then
    revoke execute on function public.order_status(uuid, uuid) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.kitchen_login(text)') is not null then
    revoke execute on function public.kitchen_login(text) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.kitchen_orders(text)') is not null then
    revoke execute on function public.kitchen_orders(text) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.kitchen_set_status(text, uuid, text)') is not null then
    revoke execute on function public.kitchen_set_status(text, uuid, text) from public, anon, authenticated;
  end if;
  if to_regclass('public.orders') is not null then revoke all on public.orders from anon, authenticated; end if;
  if to_regclass('public.kitchen_keys') is not null then revoke all on public.kitchen_keys from anon, authenticated; end if;
end $$;

-- Funksjonene er delt i små hjelpefunksjoner uten DECLARE. Supabase-verktøyet som satte opp
-- databasen, stoppet lengre funksjonskropper, og slik kan filen kjøres både der og i SQL-editoren.

-- Feil forsøk: logg dem, stopp etter 20 feil på 10 minutter, og rydd bort de som er eldre enn ett døgn
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

-- Eierkoden: riktig kode, ellers blir forsøket logget og telt
create or replace function public.kc_owner_a(p text) returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.owner_keys k where k.id = 1 and k.hash = extensions.crypt(p, k.hash))
$$;
create or replace function public._owner_ok(p_code text) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.kc_c();
  if p_code is not null and public.kc_owner_a(p_code) then return true; end if;
  perform public.kc_b(); perform public.kc_d();
  return false;
end $$;

-- Alle kan lese menyen og innstillingene (nettsiden henter dem herfra)
create or replace function public.get_site_content()
returns table (key text, data jsonb, version int, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.key, c.data, c.version, c.updated_at from public.site_content c
$$;

-- Eieren logger inn. Feil kode gir false (ikke feilmelding), så forsøket blir lagret og telt.
create or replace function public.owner_login(p_code text) returns boolean language plpgsql security definer set search_path = '' as $$
begin return public._owner_ok(p_code); end $$;

-- Sjekk av menyen før den lagres: 1–40 kategorier, hver rett med navn, 1–6 priser mellom 0 og 20 000 og kort tekst
create or replace function public.kc_menu_ok(p jsonb) returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and jsonb_typeof(p->'meny') = 'array'
    and jsonb_array_length(p->'meny') between 1 and 40 and octet_length(p::text) < 300000
    and not exists (select 1 from jsonb_array_elements(p->'meny') c(v) where jsonb_typeof(c.v) <> 'object'
      or jsonb_typeof(c.v->'kategori') is distinct from 'string' or char_length(c.v->>'kategori') not between 1 and 60
      or jsonb_typeof(c.v->'retter') is distinct from 'array'
      or (c.v->'storrelser' is not null and jsonb_typeof(c.v->'storrelser') <> 'array'))
    and not exists (select 1 from jsonb_array_elements(p->'meny') c(v), jsonb_array_elements(c.v->'retter') r(v)
      where jsonb_typeof(r.v) <> 'object' or jsonb_typeof(r.v->'navn') is distinct from 'string'
      or char_length(r.v->>'navn') not between 1 and 80 or jsonb_typeof(r.v->'pris') is distinct from 'array'
      or jsonb_array_length(r.v->'pris') not between 1 and 6 or char_length(coalesce(r.v->>'tekst', '')) > 400)
    and not exists (select 1 from jsonb_array_elements(p->'meny') c(v), jsonb_array_elements(c.v->'retter') r(v), jsonb_array_elements(r.v->'pris') x(v)
      where jsonb_typeof(x.v) <> 'number' or (x.v #>> '{}')::numeric not between 0 and 20000)
$$;

-- Sjekk av innstillingene: åpningstider for sju dager ("HH:MM"-par eller null), en merknad og et tilbud
create or replace function public.kc_settings_ok(p jsonb) returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and octet_length(p::text) < 20000
    and (p->'tider' is null or jsonb_typeof(p->'tider') = 'null'
      or (jsonb_typeof(p->'tider') = 'array' and jsonb_array_length(p->'tider') = 7
        and not exists (select 1 from jsonb_array_elements(p->'tider') d(v) where not (jsonb_typeof(d.v) = 'null'
          or (jsonb_typeof(d.v) = 'array' and jsonb_array_length(d.v) = 2
            and coalesce(d.v->>0, '') ~ '^[0-2][0-9]:[0-5][0-9]$' and coalesce(d.v->>1, '') ~ '^[0-2][0-9]:[0-5][0-9]$')))))
    and (p->'tiderMerknad' is null or (jsonb_typeof(p->'tiderMerknad') = 'string' and char_length(p->>'tiderMerknad') <= 300))
    and (p->'tilbud' is null or jsonb_typeof(p->'tilbud') = 'null'
      or (jsonb_typeof(p->'tilbud') = 'object' and char_length(coalesce(p->'tilbud'->>'tittel', '')) between 1 and 80
        and char_length(coalesce(p->'tilbud'->>'merknad', '')) <= 160))
$$;

create or replace function public.kc_content_valid(p_key text, p_data jsonb) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case when p_key = 'meny' then public.kc_menu_ok(p_data)
    when p_key = 'innstillinger' then public.kc_settings_ok(p_data) else false end, false)
$$;

-- Lagring: legg den gjeldende versjonen i historikken, behold de 30 siste, og skriv den nye med versjon + 1
create or replace function public.kc_hist_push(p_key text) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.site_content_history (key, version, data)
    select c.key, c.version, c.data from public.site_content c where c.key = p_key;
end $$;
create or replace function public.kc_hist_trim(p_key text) returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.site_content_history h where h.key = p_key and h.id not in
    (select h2.id from public.site_content_history h2 where h2.key = p_key order by h2.id desc limit 30);
end $$;
create or replace function public.kc_content_upsert(p_key text, p_data jsonb) returns int language sql security definer set search_path = '' as $$
  insert into public.site_content as c (key, data, version, updated_at) values (p_key, p_data, 1, now())
    on conflict (key) do update set data = excluded.data, version = c.version + 1, updated_at = now()
    returning c.version
$$;
create or replace function public.kc_content_write(p_key text, p_data jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.kc_hist_push(p_key);
  perform public.kc_hist_trim(p_key);
  return jsonb_build_object('ok', true, 'version', public.kc_content_upsert(p_key, p_data));
end $$;
create or replace function public.kc_version(p_key text) returns int language sql stable security definer set search_path = '' as $$
  select coalesce((select c.version from public.site_content c where c.key = p_key), 0)
$$;
create or replace function public.kc_hist_data(p_key text, p_version int) returns jsonb language sql stable security definer set search_path = '' as $$
  select h.data from public.site_content_history h where h.key = p_key and h.version = p_version order by h.id desc limit 1
$$;

-- Eieren publiserer. p_version er versjonen eieren endret fra (0 når menyen ikke finnes i databasen ennå).
-- Har noen andre publisert i mellomtiden, svarer den 'konflikt' i stedet for å skrive over.
create or replace function public.owner_save(p_code text, p_key text, p_data jsonb, p_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public._owner_ok(p_code) then return jsonb_build_object('ok', false, 'feil', 'kode'); end if;
  if not public.kc_content_valid(p_key, p_data) then return jsonb_build_object('ok', false, 'feil', 'ugyldig'); end if;
  perform pg_advisory_xact_lock(hashtext('kc-content'));
  if public.kc_version(p_key) <> coalesce(p_version, 0) then
    return jsonb_build_object('ok', false, 'feil', 'konflikt', 'version', public.kc_version(p_key));
  end if;
  return public.kc_content_write(p_key, p_data);
end $$;

-- Tidligere versjoner, nyeste først. Feil kode gir tom liste.
create or replace function public.owner_history(p_code text, p_key text)
returns table (version int, saved_at timestamptz, data jsonb) language plpgsql security definer set search_path = '' as $$
begin
  if not public._owner_ok(p_code) then return; end if;
  return query select h.version, h.saved_at, h.data from public.site_content_history h
    where h.key = p_key order by h.id desc limit 30;
end $$;

-- Hent tilbake en tidligere versjon. Den blir lagret som en ny versjon, så også dette kan angres.
create or replace function public.owner_restore(p_code text, p_key text, p_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public._owner_ok(p_code) then return jsonb_build_object('ok', false, 'feil', 'kode'); end if;
  if public.kc_hist_data(p_key, p_version) is null then return jsonb_build_object('ok', false, 'feil', 'finnes_ikke'); end if;
  perform pg_advisory_xact_lock(hashtext('kc-content'));
  return public.kc_content_write(p_key, public.kc_hist_data(p_key, p_version));
end $$;

-- Eieren bytter koden på admin.html. Den nye koden må ha minst 10 tegn, og bare hashen blir lagret.
create or replace function public.kc_owner_set(p text) returns void language plpgsql security definer set search_path = '' as $$
begin update public.owner_keys set hash = extensions.crypt(p, extensions.gen_salt('bf')), updated_at = now() where id = 1; end $$;
create or replace function public.owner_change_code(p_code text, p_which text, p_new text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public._owner_ok(p_code) then return jsonb_build_object('ok', false, 'feil', 'kode'); end if;
  if char_length(coalesce(p_new, '')) < 10 then return jsonb_build_object('ok', false, 'feil', 'kort'); end if;
  if p_which is distinct from 'eier' then return jsonb_build_object('ok', false, 'feil', 'ugyldig'); end if;
  perform public.kc_owner_set(p_new);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.kc_b(), public.kc_c(), public.kc_d(), public.kc_owner_a(text), public._owner_ok(text),
  public.kc_menu_ok(jsonb), public.kc_settings_ok(jsonb), public.kc_content_valid(text, jsonb),
  public.kc_hist_push(text), public.kc_hist_trim(text), public.kc_content_upsert(text, jsonb),
  public.kc_content_write(text, jsonb), public.kc_version(text), public.kc_hist_data(text, int),
  public.kc_owner_set(text) from public, anon, authenticated;
revoke all on function public.get_site_content(), public.owner_login(text), public.owner_save(text, text, jsonb, int),
  public.owner_history(text, text), public.owner_restore(text, text, int), public.owner_change_code(text, text, text) from public;
grant execute on function public.get_site_content(), public.owner_login(text), public.owner_save(text, text, jsonb, int),
  public.owner_history(text, text), public.owner_restore(text, text, int), public.owner_change_code(text, text, text) to anon, authenticated;

-- Til slutt: sett eierkoden første gang. Bytt ut teksten mellom de enkle anførselstegnene med en lang kode
-- (minst 10 tegn) og kjør bare denne linjen. Senere kan eieren bytte koden selv på admin.html.
-- insert into public.owner_keys (hash) values (extensions.crypt('BYTT-TIL-EN-LANG-KODE', extensions.gen_salt('bf')))
--   on conflict (id) do update set hash = excluded.hash, updated_at = now();

-- Menyen legges inn i databasen første gang eieren publiserer fra admin.html. Til da viser nettsiden meny.js.
