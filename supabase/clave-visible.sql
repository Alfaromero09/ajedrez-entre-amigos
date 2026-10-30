-- Ajedrez entre Amigos · Clave del club visible para miembros
-- Pégalo en Supabase > SQL Editor y presiona "Run".
-- La clave en sí NO va en este archivo: se guarda aparte con una línea que se corre solo en Supabase.

-- Columna para la clave legible (la tabla club no se puede leer directo: RLS sin políticas)
alter table public.club add column if not exists codigo text;

-- Solo miembros con cuenta (sesión iniciada, no anónimos) pueden leerla
create or replace function public.clave_del_club()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    return null;
  end if;
  return (select codigo from club where id = 1);
end;
$$;

revoke all on function public.clave_del_club() from public, anon;
grant execute on function public.clave_del_club() to authenticated;

notify pgrst, 'reload schema';
