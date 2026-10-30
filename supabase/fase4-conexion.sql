-- Ajedrez entre Amigos · Última conexión de cada jugador
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

alter table public.perfiles add column if not exists ultima_vez timestamptz;

-- Cada jugador marca solo su propia conexión
create or replace function public.marcar_conexion()
returns void
language sql
security definer
set search_path = public
as $$
  update perfiles set ultima_vez = now() where id = auth.uid();
$$;

revoke all on function public.marcar_conexion() from public, anon;
grant execute on function public.marcar_conexion() to authenticated;

notify pgrst, 'reload schema';
