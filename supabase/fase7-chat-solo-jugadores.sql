-- Ajedrez entre Amigos · El chat de cada partida solo lo leen sus dos jugadores
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

drop policy if exists "leer mensajes" on public.mensajes;
create policy "leer mensajes" on public.mensajes
  for select to authenticated
  using (
    exists (
      select 1 from public.partidas p
       where p.id = partida and (p.blancas = auth.uid() or p.negras = auth.uid())
    )
  );

notify pgrst, 'reload schema';
