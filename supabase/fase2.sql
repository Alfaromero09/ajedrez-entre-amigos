-- Ajedrez entre Amigos · Fase 2: cuentas con invitación, nombres y reloj
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".
-- El código del club NO va en este archivo: se guarda aparte (ver LEEME).

-- ---------- Perfiles ----------
create table if not exists public.perfiles (
  id     uuid primary key references auth.users(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 2 and 20),
  creado timestamptz not null default now()
);
create unique index if not exists perfiles_nombre_unico on public.perfiles (lower(nombre));
alter table public.perfiles enable row level security;
revoke all on public.perfiles from anon, authenticated;
grant select on public.perfiles to authenticated;
grant select, insert, update, delete on public.perfiles to service_role;
drop policy if exists "ver perfiles" on public.perfiles;
create policy "ver perfiles" on public.perfiles for select to authenticated using (true);

-- ---------- Código del club (guardado como huella, nunca en texto) ----------
create table if not exists public.club (
  id          integer primary key default 1 check (id = 1),
  codigo_hash text not null
);
alter table public.club enable row level security;
revoke all on public.club from anon, authenticated;

-- ---------- Validación al registrarse ----------
create or replace function public.validar_registro()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta   jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_nombre text  := trim(coalesce(v_meta->>'nombre', ''));
  v_codigo text  := lower(trim(coalesce(v_meta->>'codigo', '')));
begin
  if coalesce(new.is_anonymous, false) then
    raise exception 'El registro es solo con invitación';
  end if;
  if not exists (
    select 1 from club
     where id = 1 and codigo_hash = encode(extensions.digest(v_codigo, 'sha256'), 'hex')
  ) then
    raise exception 'Código de invitación incorrecto';
  end if;
  if char_length(v_nombre) not between 2 and 20 then
    raise exception 'El nombre debe tener entre 2 y 20 caracteres';
  end if;
  if exists (select 1 from perfiles p where lower(p.nombre) = lower(v_nombre)) then
    raise exception 'Ese nombre ya está en uso';
  end if;
  new.raw_user_meta_data := (v_meta - 'codigo') || jsonb_build_object('nombre', v_nombre);
  return new;
end;
$$;

create or replace function public.crear_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into perfiles (id, nombre) values (new.id, new.raw_user_meta_data->>'nombre');
  return new;
end;
$$;

drop trigger if exists antes_de_registrar on auth.users;
create trigger antes_de_registrar
  before insert on auth.users
  for each row execute function public.validar_registro();

drop trigger if exists despues_de_registrar on auth.users;
create trigger despues_de_registrar
  after insert on auth.users
  for each row execute function public.crear_perfil();

create or replace function public.nombre_disponible(n text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (select 1 from perfiles where lower(nombre) = lower(trim(n)));
$$;

-- ---------- Reloj en las partidas ----------
alter table public.partidas
  add column if not exists minutos       integer not null default 10,
  add column if not exists reloj_blancas bigint  not null default 600000,
  add column if not exists reloj_negras  bigint  not null default 600000,
  add column if not exists ultimo_tick   timestamptz,
  add column if not exists motivo        text;

drop function if exists public.crear_partida();
create or replace function public.crear_partida(p_minutos integer default 10)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  nueva uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'Necesitas una cuenta para crear una partida';
  end if;
  if p_minutos not in (3, 5, 10, 15, 30, 60, 120) then
    raise exception 'Tiempo no válido';
  end if;
  insert into partidas (blancas, minutos, reloj_blancas, reloj_negras)
  values (auth.uid(), p_minutos, p_minutos * 60000, p_minutos * 60000)
  returning id into nueva;
  return nueva;
end;
$$;

create or replace function public.unirse_partida(p uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception 'Necesitas una cuenta para unirte';
  end if;
  update partidas
     set negras = auth.uid(),
         estado = 'jugando',
         ultimo_tick = now(),
         version = version + 1,
         actualizada = now()
   where id = p
     and negras is null
     and blancas <> auth.uid()
     and estado = 'esperando';
  if not found then
    raise exception 'Esta partida ya no está disponible';
  end if;
end;
$$;

create or replace function public.hora_servidor()
returns timestamptz
language sql
stable
as $$ select now(); $$;

-- Cualquiera de los dos jugadores puede pedir que se cierre la partida si el reloj llegó a cero.
create or replace function public.reclamar_tiempo(p uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r partidas%rowtype;
  gastado bigint;
begin
  select * into r from partidas where id = p for update;
  if not found or r.estado <> 'jugando' or r.ultimo_tick is null then return; end if;
  if auth.uid() is distinct from r.blancas and auth.uid() is distinct from r.negras then
    raise exception 'Solo los jugadores pueden reclamar el tiempo';
  end if;
  gastado := (extract(epoch from (now() - r.ultimo_tick)) * 1000)::bigint;
  if split_part(r.fen, ' ', 2) = 'w' and r.reloj_blancas - gastado <= 0 then
    update partidas set estado = 'terminada', resultado = '0-1', motivo = 'tiempo', reloj_blancas = 0,
           version = version + 1, actualizada = now() where id = p;
  elsif split_part(r.fen, ' ', 2) = 'b' and r.reloj_negras - gastado <= 0 then
    update partidas set estado = 'terminada', resultado = '1-0', motivo = 'tiempo', reloj_negras = 0,
           version = version + 1, actualizada = now() where id = p;
  end if;
end;
$$;

create or replace function public.rendirse(p uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update partidas
     set estado = 'terminada',
         resultado = case when blancas = auth.uid() then '0-1' else '1-0' end,
         motivo = 'abandono',
         version = version + 1,
         actualizada = now()
   where id = p
     and estado = 'jugando'
     and (blancas = auth.uid() or negras = auth.uid());
end;
$$;

-- ---------- Permisos de las funciones ----------
revoke all on function public.crear_partida(integer)   from public, anon;
revoke all on function public.unirse_partida(uuid)     from public, anon;
revoke all on function public.reclamar_tiempo(uuid)    from public, anon;
revoke all on function public.rendirse(uuid)           from public, anon;
revoke all on function public.hora_servidor()          from public, anon;
revoke all on function public.validar_registro()       from public, anon, authenticated;
revoke all on function public.crear_perfil()           from public, anon, authenticated;
grant execute on function public.crear_partida(integer) to authenticated;
grant execute on function public.unirse_partida(uuid)   to authenticated;
grant execute on function public.reclamar_tiempo(uuid)  to authenticated;
grant execute on function public.rendirse(uuid)         to authenticated;
grant execute on function public.hora_servidor()        to authenticated;
grant execute on function public.nombre_disponible(text) to anon, authenticated;
grant usage on schema public to anon, authenticated;

notify pgrst, 'reload schema';
