-- Ajedrez entre Amigos · Limpieza de partidas de prueba
-- Quita las partidas de la fase 1 jugadas con usuarios anónimos (sin cuenta del club).
-- Pégalo en Supabase > SQL Editor y presiona "Run".
delete from public.partidas
 where blancas not in (select id from public.perfiles)
    or (negras is not null and negras not in (select id from public.perfiles));
