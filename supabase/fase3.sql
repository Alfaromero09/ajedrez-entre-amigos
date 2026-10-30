-- Ajedrez entre Amigos · Fase 3: salas abiertas, partidas en vivo y La mesa del club
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

-- Búsquedas rápidas del dashboard
create index if not exists partidas_estado_idx on public.partidas (estado, actualizada desc);
create index if not exists partidas_blancas_idx on public.partidas (blancas);
create index if not exists partidas_negras_idx on public.partidas (negras);

-- ---------- La mesa del club ----------
-- 1 punto por victoria, 0 por derrota. Las tablas se cuentan pero no suman.
-- Solo cuentan partidas terminadas con dos jugadores y con resultado.
create or replace function public.mesa_del_club()
returns table (
  id      uuid,
  nombre  text,
  avatar  text,
  pj      integer,
  g       integer,
  p       integer,
  t       integer,
  pts     integer
)
language sql
stable
security definer
set search_path = public
as $$
  with lados as (
    select blancas as jugador,
           case resultado when '1-0' then 'g' when '0-1' then 'p' else 't' end as r
      from partidas
     where estado = 'terminada' and negras is not null and resultado is not null
    union all
    select negras,
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
    left join lados l on l.jugador = pf.id
   group by pf.id, pf.nombre, pf.avatar
   order by pts desc, pj desc, lower(pf.nombre);
$$;

-- ---------- Cerrar una sala que nadie tomó ----------
-- Solo quien la creó y solo mientras sigue esperando rival. No cuenta en la mesa.
create or replace function public.cancelar_partida(p uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update partidas
     set estado = 'terminada',
         motivo = 'cancelada',
         version = version + 1,
         actualizada = now()
   where id = p
     and blancas = auth.uid()
     and estado = 'esperando'
     and negras is null;
  if not found then
    raise exception 'Esa sala ya no se puede cerrar';
  end if;
end;
$$;

-- ---------- Permisos ----------
revoke all on function public.mesa_del_club()        from public, anon;
revoke all on function public.cancelar_partida(uuid) from public, anon;
grant execute on function public.mesa_del_club()        to authenticated;
grant execute on function public.cancelar_partida(uuid) to authenticated;

notify pgrst, 'reload schema';
