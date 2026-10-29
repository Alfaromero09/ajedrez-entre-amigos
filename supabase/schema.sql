-- Ajedrez entre Amigos · Fase 1
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

create table if not exists public.partidas (
  id          uuid primary key default gen_random_uuid(),
  blancas     uuid not null references auth.users(id) on delete cascade,
  negras      uuid references auth.users(id) on delete set null,
  fen         text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  jugadas     jsonb not null default '[]'::jsonb,
  estado      text not null default 'esperando'
              check (estado in ('esperando', 'jugando', 'terminada')),
  resultado   text,
  version     integer not null default 0,
  creada      timestamptz not null default now(),
  actualizada timestamptz not null default now()
);

alter table public.partidas enable row level security;

-- Permisos explícitos (el proyecto no expone tablas automáticamente).
revoke all on public.partidas from anon, authenticated;
grant select on public.partidas to authenticated;
grant select, insert, update, delete on public.partidas to service_role;

-- Cualquier usuario con sesión puede ver partidas (para unirse por link o mirar).
drop policy if exists "ver partidas" on public.partidas;
create policy "ver partidas" on public.partidas
  for select to authenticated using (true);

-- No hay políticas de insert/update/delete: nadie puede escribir directo.
-- Todo cambio pasa por las funciones de abajo o por la Edge Function "jugada".

create or replace function public.crear_partida()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  nueva uuid;
begin
  if auth.uid() is null then
    raise exception 'Necesitas una sesión para crear una partida';
  end if;
  insert into partidas (blancas) values (auth.uid()) returning id into nueva;
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
  if auth.uid() is null then
    raise exception 'Necesitas una sesión para unirte';
  end if;
  update partidas
     set negras = auth.uid(),
         estado = 'jugando',
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

revoke all on function public.crear_partida() from public, anon;
revoke all on function public.unirse_partida(uuid) from public, anon;
grant execute on function public.crear_partida() to authenticated;
grant execute on function public.unirse_partida(uuid) to authenticated;

-- Avisos en tiempo real cuando cambia una partida.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'partidas'
  ) then
    alter publication supabase_realtime add table public.partidas;
  end if;
end;
$$;
