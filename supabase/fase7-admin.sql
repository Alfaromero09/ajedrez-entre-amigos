-- Ajedrez entre Amigos · Fase 7: Torre de control (administración)
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".
-- Después corre aparte la línea que te convierte en administrador (no va en GitHub).

-- ---------- Quién es administrador ----------
create table if not exists public.admins (
  id     uuid primary key references auth.users(id) on delete cascade,
  creado timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins where id = auth.uid());
$$;

-- ---------- Marcador reiniciable ----------
-- Las partidas anteriores a esta fecha no cuentan para ese jugador en la mesa del club
alter table public.perfiles add column if not exists marcador_desde timestamptz;

create or replace function public.mesa_del_club()
returns table (id uuid, nombre text, avatar text, pj integer, g integer, p integer, t integer, pts integer)
language sql
stable
security definer
set search_path = public
as $$
  with lados as (
    select blancas as jugador, actualizada,
           case resultado when '1-0' then 'g' when '0-1' then 'p' else 't' end as r
      from partidas
     where estado = 'terminada' and negras is not null and resultado is not null
    union all
    select negras, actualizada,
           case resultado when '0-1' then 'g' when '1-0' then 'p' else 't' end
      from partidas
     where estado = 'terminada' and negras is not null and resultado is not null
  )
  select pf.id, pf.nombre, pf.avatar,
         count(l.r)::int                          as pj,
         count(*) filter (where l.r = 'g')::int   as g,
         count(*) filter (where l.r = 'p')::int   as p,
         count(*) filter (where l.r = 't')::int   as t,
         count(*) filter (where l.r = 'g')::int   as pts
    from perfiles pf
    left join lados l
      on l.jugador = pf.id
     and l.actualizada > coalesce(pf.marcador_desde, '-infinity'::timestamptz)
   group by pf.id, pf.nombre, pf.avatar
   order by pts desc, pj desc, lower(pf.nombre);
$$;

-- ---------- Lista de usuarios para la Torre de control ----------
create or replace function public.admin_usuarios()
returns table (
  id uuid, nombre text, avatar text, foto_url text, email text, creado timestamptz,
  confirmado boolean, ultima_vez timestamptz, es_admin boolean, marcador_desde timestamptz,
  pj integer, g integer, p integer, t integer, partidas_total integer
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.es_admin() then raise exception 'Solo administradores'; end if;
  return query
  select u.id, pf.nombre, pf.avatar, pf.foto_url, u.email::text, u.created_at,
         (u.email_confirmed_at is not null), pf.ultima_vez,
         exists (select 1 from public.admins a where a.id = u.id),
         pf.marcador_desde,
         coalesce(m.pj, 0), coalesce(m.g, 0), coalesce(m.p, 0), coalesce(m.t, 0),
         (select count(*)::int from public.partidas x where x.blancas = u.id or x.negras = u.id)
    from auth.users u
    left join public.perfiles pf on pf.id = u.id
    left join public.mesa_del_club() m on m.id = u.id
   order by lower(coalesce(pf.nombre, u.email));
end;
$$;

-- ---------- Acciones ----------
create or replace function public.admin_reiniciar_marcador(p_usuario uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.es_admin() then raise exception 'Solo administradores'; end if;
  if p_usuario is null then
    update perfiles set marcador_desde = now();
  else
    update perfiles set marcador_desde = now() where id = p_usuario;
  end if;
end;
$$;

create or replace function public.admin_borrar_partidas(p_usuario uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if not public.es_admin() then raise exception 'Solo administradores'; end if;
  delete from partidas where blancas = p_usuario or negras = p_usuario;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.admin_eliminar_usuario(p_usuario uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.es_admin() then raise exception 'Solo administradores'; end if;
  if exists (select 1 from admins where id = p_usuario) and (select count(*) from admins) <= 1 then
    raise exception 'No puedes borrar al único administrador';
  end if;
  delete from auth.users where id = p_usuario;
end;
$$;

create or replace function public.admin_poner_admin(p_usuario uuid, p_si boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.es_admin() then raise exception 'Solo administradores'; end if;
  if p_si then
    insert into admins (id) values (p_usuario) on conflict do nothing;
  else
    if (select count(*) from admins) <= 1 then raise exception 'Debe quedar al menos un administrador'; end if;
    delete from admins where id = p_usuario;
  end if;
end;
$$;

-- Cambia la clave del club (se guarda la huella para el registro y la versión legible para la invitación)
create or replace function public.admin_cambiar_clave(p_clave text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v text := trim(coalesce(p_clave, ''));
begin
  if not public.es_admin() then raise exception 'Solo administradores'; end if;
  if char_length(v) < 3 then raise exception 'La clave debe tener al menos 3 caracteres'; end if;
  insert into club (id, codigo_hash, codigo)
  values (1, encode(extensions.digest(lower(v), 'sha256'), 'hex'), v)
  on conflict (id) do update set codigo_hash = excluded.codigo_hash, codigo = excluded.codigo;
end;
$$;

-- Los administradores pueden borrar cualquier foto de perfil
drop policy if exists "fotos: admin borra" on storage.objects;
create policy "fotos: admin borra" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and public.es_admin());

revoke all on function public.es_admin()                       from public, anon;
revoke all on function public.admin_usuarios()                 from public, anon;
revoke all on function public.admin_reiniciar_marcador(uuid)   from public, anon;
revoke all on function public.admin_borrar_partidas(uuid)      from public, anon;
revoke all on function public.admin_eliminar_usuario(uuid)     from public, anon;
revoke all on function public.admin_poner_admin(uuid, boolean) from public, anon;
revoke all on function public.admin_cambiar_clave(text)        from public, anon;
grant execute on function public.es_admin()                       to authenticated;
grant execute on function public.admin_usuarios()                 to authenticated;
grant execute on function public.admin_reiniciar_marcador(uuid)   to authenticated;
grant execute on function public.admin_borrar_partidas(uuid)      to authenticated;
grant execute on function public.admin_eliminar_usuario(uuid)     to authenticated;
grant execute on function public.admin_poner_admin(uuid, boolean) to authenticated;
grant execute on function public.admin_cambiar_clave(text)        to authenticated;

notify pgrst, 'reload schema';
