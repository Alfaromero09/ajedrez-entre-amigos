-- Ajedrez entre Amigos · Chat del club (para avisos rápidos entre los conectados)
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

create table if not exists public.mensajes_club (
  id     bigint generated always as identity primary key,
  autor  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  texto  text not null check (char_length(trim(texto)) between 1 and 200),
  creado timestamptz not null default now()
);
create index if not exists mensajes_club_creado_idx on public.mensajes_club (creado desc);

alter table public.mensajes_club enable row level security;
revoke all on public.mensajes_club from anon, authenticated;
grant select, insert on public.mensajes_club to authenticated;

drop policy if exists "leer chat club" on public.mensajes_club;
create policy "leer chat club" on public.mensajes_club for select to authenticated using (true);

drop policy if exists "escribir chat club" on public.mensajes_club;
create policy "escribir chat club" on public.mensajes_club for insert to authenticated
  with check (autor = auth.uid() and not coalesce((auth.jwt()->>'is_anonymous')::boolean, false));

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mensajes_club') then
    alter publication supabase_realtime add table public.mensajes_club;
  end if;
end;
$$;

notify pgrst, 'reload schema';
