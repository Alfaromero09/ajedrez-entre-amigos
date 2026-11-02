-- Ajedrez entre Amigos · Ajustes de cuenta: nombre, foto, avatar y darse de baja
-- Pégalo completo en Supabase > SQL Editor y presiona "Run".

alter table public.perfiles add column if not exists foto_url text;

-- ---------- Cambiar nombre y avatar ----------
create or replace function public.actualizar_perfil(p_nombre text, p_avatar text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nombre text := trim(coalesce(p_nombre, ''));
begin
  if auth.uid() is null then raise exception 'Necesitas iniciar sesión'; end if;
  if char_length(v_nombre) not between 2 and 20 then
    raise exception 'El nombre debe tener entre 2 y 20 caracteres';
  end if;
  if p_avatar not in ('rey', 'dama') then raise exception 'Avatar no válido'; end if;
  if exists (select 1 from perfiles where lower(nombre) = lower(v_nombre) and id <> auth.uid()) then
    raise exception 'Ese nombre ya está en uso';
  end if;
  update perfiles set nombre = v_nombre, avatar = p_avatar where id = auth.uid();
end;
$$;

-- ---------- Foto de perfil ----------
-- Solo se acepta una foto guardada en la carpeta propia del usuario
create or replace function public.poner_foto(p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Necesitas iniciar sesión'; end if;
  if p_url is not null and p_url not like '%/storage/v1/object/public/fotos/' || auth.uid()::text || '/%' then
    raise exception 'Foto no válida';
  end if;
  update perfiles set foto_url = p_url where id = auth.uid();
end;
$$;

-- Carpeta pública de fotos (máximo 1 MB por imagen)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 1048576,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- Cada quien solo puede escribir en su propia carpeta: fotos/<su id>/...
drop policy if exists "fotos: ver la propia" on storage.objects;
create policy "fotos: ver la propia" on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "fotos: subir la propia" on storage.objects;
create policy "fotos: subir la propia" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "fotos: cambiar la propia" on storage.objects;
create policy "fotos: cambiar la propia" on storage.objects for update to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "fotos: borrar la propia" on storage.objects;
create policy "fotos: borrar la propia" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Darse de baja ----------
-- Borra la cuenta del usuario que la pide. Sus partidas como blancas, sus mensajes y su perfil se van con ella.
create or replace function public.eliminar_cuenta()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then raise exception 'Necesitas iniciar sesión'; end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.actualizar_perfil(text, text) from public, anon;
revoke all on function public.poner_foto(text)              from public, anon;
revoke all on function public.eliminar_cuenta()             from public, anon;
grant execute on function public.actualizar_perfil(text, text) to authenticated;
grant execute on function public.poner_foto(text)              to authenticated;
grant execute on function public.eliminar_cuenta()             to authenticated;

notify pgrst, 'reload schema';
