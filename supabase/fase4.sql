-- Ajedrez entre Amigos · Fase 4: chat de la partida y ofrecer tablas
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

-- ---------- Chat ----------
create table if not exists public.mensajes (
  id      bigint generated always as identity primary key,
  partida uuid not null references public.partidas(id) on delete cascade,
  autor   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  texto   text not null check (char_length(trim(texto)) between 1 and 300),
  creado  timestamptz not null default now()
);
create index if not exists mensajes_partida_idx on public.mensajes (partida, id);

alter table public.mensajes enable row level security;
revoke all on public.mensajes from anon, authenticated;
grant select, insert on public.mensajes to authenticated;
grant select, insert, update, delete on public.mensajes to service_role;

-- Cualquiera del club puede leer (también quien está mirando la partida)
drop policy if exists "leer mensajes" on public.mensajes;
create policy "leer mensajes" on public.mensajes
  for select to authenticated using (true);

-- Solo los dos jugadores escriben, y siempre a su nombre
drop policy if exists "escribir mensajes" on public.mensajes;
create policy "escribir mensajes" on public.mensajes
  for insert to authenticated
  with check (
    autor = auth.uid()
    and not coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
    and exists (
      select 1 from public.partidas p
       where p.id = partida and (p.blancas = auth.uid() or p.negras = auth.uid())
    )
  );

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mensajes'
  ) then
    alter publication supabase_realtime add table public.mensajes;
  end if;
end;
$$;

-- ---------- Ofrecer tablas ----------
-- La oferta vale solo mientras nadie mueva: se guarda la versión de la partida en que se hizo.
alter table public.partidas
  add column if not exists tablas_ofrece  uuid,
  add column if not exists tablas_version integer;

create or replace function public.ofrecer_tablas(p uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update partidas
     set tablas_ofrece = auth.uid(),
         tablas_version = version + 1,
         version = version + 1,
         actualizada = now()
   where id = p
     and estado = 'jugando'
     and (blancas = auth.uid() or negras = auth.uid())
     and not coalesce(tablas_ofrece = auth.uid() and tablas_version = version, false);
end;
$$;

create or replace function public.responder_tablas(p uuid, acepta boolean)
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
  if not found or r.estado <> 'jugando' then return; end if;
  if auth.uid() is distinct from r.blancas and auth.uid() is distinct from r.negras then
    raise exception 'Solo los jugadores pueden responder';
  end if;
  if r.tablas_ofrece is null or r.tablas_ofrece = auth.uid() or r.tablas_version is distinct from r.version then
    raise exception 'Esa oferta de tablas ya no está vigente';
  end if;

  if not acepta then
    update partidas set tablas_ofrece = null, tablas_version = null,
           version = version + 1, actualizada = now()
     where id = p;
    return;
  end if;

  -- Congela los relojes al momento del acuerdo
  gastado := case when r.ultimo_tick is null then 0
                  else (extract(epoch from (now() - r.ultimo_tick)) * 1000)::bigint end;
  update partidas
     set estado = 'terminada',
         resultado = '½-½',
         motivo = 'acuerdo',
         reloj_blancas = case when split_part(r.fen, ' ', 2) = 'w' then greatest(0, r.reloj_blancas - gastado) else r.reloj_blancas end,
         reloj_negras  = case when split_part(r.fen, ' ', 2) = 'b' then greatest(0, r.reloj_negras - gastado) else r.reloj_negras end,
         tablas_ofrece = null,
         tablas_version = null,
         version = version + 1,
         actualizada = now()
   where id = p;
end;
$$;

revoke all on function public.ofrecer_tablas(uuid)            from public, anon;
revoke all on function public.responder_tablas(uuid, boolean) from public, anon;
grant execute on function public.ofrecer_tablas(uuid)            to authenticated;
grant execute on function public.responder_tablas(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
