-- Ajedrez entre Amigos · Mensajes privados entre dos jugadores
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

-- Si ya habías creado el chat general del club, se quita
drop table if exists public.mensajes_club;

create table if not exists public.mensajes_privados (
  id     bigint generated always as identity primary key,
  de     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  para   uuid not null references auth.users(id) on delete cascade,
  texto  text not null check (char_length(trim(texto)) between 1 and 300),
  creado timestamptz not null default now(),
  check (de <> para)
);
create index if not exists mp_de_para_idx on public.mensajes_privados (de, para, id);
create index if not exists mp_para_idx on public.mensajes_privados (para, id);

alter table public.mensajes_privados enable row level security;
revoke all on public.mensajes_privados from anon, authenticated;
grant select, insert on public.mensajes_privados to authenticated;

-- Cada quien solo ve las conversaciones donde participa
drop policy if exists "ver mis privados" on public.mensajes_privados;
create policy "ver mis privados" on public.mensajes_privados for select to authenticated
  using (de = auth.uid() or para = auth.uid());

drop policy if exists "mandar privados" on public.mensajes_privados;
create policy "mandar privados" on public.mensajes_privados for insert to authenticated
  with check (
    de = auth.uid()
    and not coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
    and exists (select 1 from public.perfiles where id = para)
  );

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mensajes_privados') then
    alter publication supabase_realtime add table public.mensajes_privados;
  end if;
end;
$$;

notify pgrst, 'reload schema';
