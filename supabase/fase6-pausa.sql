-- Ajedrez entre Amigos · Fase 6: pausar, reanudar y cancelar partidas
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

-- Nuevo estado "pausada"
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.partidas'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%estado%'
  loop
    execute format('alter table public.partidas drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.partidas
  add constraint partidas_estado_check check (estado in ('esperando', 'jugando', 'pausada', 'terminada'));

alter table public.partidas
  add column if not exists pausa_por    uuid,
  add column if not exists pausa_motivo text,
  add column if not exists pausa_desde  timestamptz,
  add column if not exists pausa_hasta  timestamptz;

-- Descuenta del reloj de quien tiene el turno el tiempo que corrió hasta ahora
create or replace function public._congelar_reloj(r public.partidas)
returns table (rb bigint, rn bigint)
language sql
stable
as $$
  select
    case when r.ultimo_tick is not null and split_part(r.fen, ' ', 2) = 'w'
         then greatest(0, r.reloj_blancas - (extract(epoch from (now() - r.ultimo_tick)) * 1000)::bigint)
         else r.reloj_blancas end,
    case when r.ultimo_tick is not null and split_part(r.fen, ' ', 2) = 'b'
         then greatest(0, r.reloj_negras - (extract(epoch from (now() - r.ultimo_tick)) * 1000)::bigint)
         else r.reloj_negras end;
$$;

-- ---------- Pausar ----------
create or replace function public.pausar_partida(p uuid, p_motivo text, p_minutos integer default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r partidas%rowtype;
  c record;
begin
  select * into r from partidas where id = p for update;
  if not found or r.estado <> 'jugando' then raise exception 'Solo se puede pausar una partida en juego'; end if;
  if auth.uid() is distinct from r.blancas and auth.uid() is distinct from r.negras then
    raise exception 'Solo los jugadores pueden pausar';
  end if;
  select * into c from _congelar_reloj(r);
  update partidas
     set estado = 'pausada',
         reloj_blancas = c.rb,
         reloj_negras = c.rn,
         ultimo_tick = null,
         pausa_por = auth.uid(),
         pausa_motivo = left(coalesce(nullif(trim(p_motivo), ''), 'En pausa'), 80),
         pausa_desde = now(),
         pausa_hasta = case when p_minutos between 1 and 600 then now() + make_interval(mins => p_minutos) end,
         tablas_ofrece = null,
         tablas_version = null,
         version = version + 1,
         actualizada = now()
   where id = p;
end;
$$;

-- ---------- Reanudar ----------
-- Quien pausó puede reanudar cuando quiera; el rival también, una vez que pasó el tiempo prometido.
create or replace function public.reanudar_partida(p uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r partidas%rowtype;
begin
  select * into r from partidas where id = p for update;
  if not found or r.estado <> 'pausada' then raise exception 'La partida no está en pausa'; end if;
  if auth.uid() is distinct from r.blancas and auth.uid() is distinct from r.negras then
    raise exception 'Solo los jugadores pueden reanudar';
  end if;
  if auth.uid() is distinct from r.pausa_por and (r.pausa_hasta is null or now() < r.pausa_hasta) then
    raise exception 'Todavía no se cumple el tiempo de la pausa';
  end if;
  update partidas
     set estado = 'jugando',
         ultimo_tick = now(),
         pausa_por = null, pausa_motivo = null, pausa_desde = null, pausa_hasta = null,
         version = version + 1,
         actualizada = now()
   where id = p;
end;
$$;

-- ---------- Cancelar una partida en juego o en pausa (no cuenta en la mesa) ----------
create or replace function public.cancelar_juego(p uuid, p_motivo text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r partidas%rowtype;
  c record;
begin
  select * into r from partidas where id = p for update;
  if not found or r.estado not in ('jugando', 'pausada') then raise exception 'Esa partida ya no se puede cancelar'; end if;
  if auth.uid() is distinct from r.blancas and auth.uid() is distinct from r.negras then
    raise exception 'Solo los jugadores pueden cancelar';
  end if;
  select * into c from _congelar_reloj(r);
  update partidas
     set estado = 'terminada',
         resultado = null,
         motivo = 'cancelada',
         reloj_blancas = c.rb,
         reloj_negras = c.rn,
         pausa_por = auth.uid(),
         pausa_motivo = left(coalesce(nullif(trim(p_motivo), ''), 'Cancelada'), 80),
         pausa_desde = now(),
         pausa_hasta = null,
         tablas_ofrece = null,
         tablas_version = null,
         version = version + 1,
         actualizada = now()
   where id = p;
end;
$$;

revoke all on function public._congelar_reloj(public.partidas)         from public, anon, authenticated;
revoke all on function public.pausar_partida(uuid, text, integer)      from public, anon;
revoke all on function public.reanudar_partida(uuid)                   from public, anon;
revoke all on function public.cancelar_juego(uuid, text)               from public, anon;
grant execute on function public.pausar_partida(uuid, text, integer)   to authenticated;
grant execute on function public.reanudar_partida(uuid)                to authenticated;
grant execute on function public.cancelar_juego(uuid, text)            to authenticated;

notify pgrst, 'reload schema';
