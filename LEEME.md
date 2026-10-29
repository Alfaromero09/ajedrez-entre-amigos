# Ajedrez entre Amigos · Fase 1

Tablero en tiempo real entre dos navegadores. El servidor valida cada jugada, así que nadie puede hacer trampa desde su navegador. Cada jugador ajusta el ángulo del tablero solo para sí mismo.

## 1. Supabase

1. Entra a tu proyecto en supabase.com (o crea uno nuevo).
2. **Authentication › Sign In / Providers**: activa **Anonymous sign-ins**. Por ahora cada visitante entra con una sesión temporal; las cuentas con código de invitación llegan en la fase 2.
3. **SQL Editor**: pega todo el contenido de `supabase/schema.sql` y presiona **Run**.
4. **Edge Functions › Deploy a new function › Via Editor**: ponle de nombre `jugada`, pega el contenido de `supabase/functions/jugada/index.ts` y despliégala. Deja activada la verificación de JWT.
5. **Project Settings › API Keys**: copia la **Project URL** y la clave pública (**anon** o **publishable**).

## 2. Configuración

Abre `config.js` y reemplaza `TU-PROYECTO` y `TU-CLAVE-PUBLICA` con esos dos datos. Nunca pongas ahí la clave `service_role` ni la `secret`.

## 3. GitHub

1. Crea un repositorio nuevo llamado `ajedrez-entre-amigos`.
2. **Add file › Upload files** y arrastra todos los archivos y carpetas de este paquete.
3. Guarda con **Commit changes**.

## 4. Netlify

1. **Add new site › Import an existing project › GitHub** y elige el repositorio.
2. Deja vacío el comando de build y pon `.` como carpeta de publicación.
3. Despliega. Cada vez que cambies algo en GitHub, Netlify lo publica solo.

## 5. Probar

Abre la página en un navegador normal y en otro en modo incógnito. En el primero presiona **Crear partida**, copia el link y ábrelo en el segundo para unirte con las negras.

## 6. Dominio

En Netlify: **Domain management › Add a domain**. Netlify te dará los datos de DNS para ponerlos en Akky.

## Fase 2: cuentas, nombres y reloj

1. **SQL Editor**: pega `supabase/fase2.sql` y presiona **Run**.
2. **SQL Editor**: guarda el código del club con la instrucción que te pasó Claude en el chat. Ese código nunca se sube a GitHub.
3. **Authentication › Sign In / Providers**: apaga **Allow anonymous sign-ins** y deja encendido **Allow new users to sign up**. Para un club entre amigos conviene apagar también **Confirm email**.
4. **Edge Functions › jugada › Code**: reemplaza el código por el de `supabase/functions/jugada/index.ts` y presiona **Deploy**.
5. **GitHub**: sube `app.js`, `index.html` y la carpeta `supabase` actualizados.

## Pendiente para las siguientes fases

- Dashboard con salas abiertas, partidas en vivo y tabla de posiciones.
- Cámara, chat, avisos y ofrecer tablas.
- Selector de tableros y piezas (Mármol, Clásico, Ártico, 3D, RhosGFX, Render).
