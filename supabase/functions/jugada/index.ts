// Ajedrez entre Amigos · Edge Function "jugada"
// El servidor es el árbitro: revisa que sea tu turno y que la jugada sea legal.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { Chess } from "npm:chess.js@1.4.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function responder(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return responder({ error: "Método no permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const servicio = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const auth = req.headers.get("Authorization") ?? "";
  const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: sesion, error: errSesion } = await comoUsuario.auth.getUser();
  if (errSesion || !sesion?.user) return responder({ error: "Sesión no válida" }, 401);
  const yo = sesion.user.id;

  let datos: { partida?: string; desde?: string; hacia?: string; promocion?: string };
  try {
    datos = await req.json();
  } catch {
    return responder({ error: "Datos incompletos" }, 400);
  }
  const { partida, desde, hacia } = datos;
  const promocion = ["q", "r", "b", "n"].includes(datos.promocion ?? "") ? datos.promocion : "q";
  const casilla = /^[a-h][1-8]$/;
  if (!partida || !desde || !hacia || !casilla.test(desde) || !casilla.test(hacia)) {
    return responder({ error: "Datos incompletos" }, 400);
  }

  const db = createClient(url, servicio);
  const { data: p, error: errLeer } = await db.from("partidas").select("*").eq("id", partida).single();
  if (errLeer || !p) return responder({ error: "No encontramos esa partida" }, 404);
  if (p.estado !== "jugando") return responder({ error: "La partida no está en juego" }, 409);

  const juego = new Chess(p.fen);
  const leToca = juego.turn() === "w" ? p.blancas : p.negras;
  if (leToca !== yo) return responder({ error: "No es tu turno" }, 403);

  let mov;
  try {
    mov = juego.move({ from: desde, to: hacia, promotion: promocion });
  } catch {
    return responder({ error: "Jugada no válida" }, 422);
  }

  let estado = "jugando";
  let resultado: string | null = null;
  if (juego.isCheckmate()) {
    estado = "terminada";
    resultado = juego.turn() === "w" ? "0-1" : "1-0";
  } else if (juego.isDraw() || juego.isStalemate()) {
    estado = "terminada";
    resultado = "½-½";
  }

  const jugadas = [...(p.jugadas ?? []), { desde: mov.from, hacia: mov.to, san: mov.san }];
  const { data: nueva, error: errGuardar } = await db
    .from("partidas")
    .update({
      fen: juego.fen(),
      jugadas,
      estado,
      resultado,
      version: p.version + 1,
      actualizada: new Date().toISOString(),
    })
    .eq("id", partida)
    .eq("version", p.version)
    .select()
    .single();

  if (errGuardar || !nueva) return responder({ error: "Alguien movió al mismo tiempo, intenta de nuevo" }, 409);
  return responder({ partida: nueva });
});
