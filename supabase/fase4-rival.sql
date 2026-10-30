-- Ajedrez entre Amigos · Elegir rival al crear la partida
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

-- Una mesa puede quedar apartada para un jugador del club
alter table public.partidas
  add column if not exists reservada_para uuid references auth.users(id) on delete set null;

drop function if exists public.crear_partida(integer);
create or replace function public.crear_partida(p_minutos integer default 10, p_rival uuid default null)
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
  if p_rival is not null and (p_rival = auth.uid() or not exists (select 1 from perfiles where id = p_rival)) then
    raise exception 'Ese rival no es del club';
  end if;
  insert into partidas (blancas, minutos, reloj_blancas, reloj_negras, reservada_para)
  values (auth.uid(), p_minutos, p_minutos * 60000, p_minutos * 60000, p_rival)
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
     and estado = 'esperando'
     and (reservada_para is null or reservada_para = auth.uid());
  if not found then
    raise exception 'Esta partida ya no está disponible';
  end if;
end;
$$;

revoke all on function public.crear_partida(integer, uuid) from public, anon;
revoke all on function public.unirse_partida(uuid)         from public, anon;
grant execute on function public.crear_partida(integer, uuid) to authenticated;
grant execute on function public.unirse_partida(uuid)         to authenticated;

notify pgrst, 'reload schema';
