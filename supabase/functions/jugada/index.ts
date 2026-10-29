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
  const token = auth.replace(/^Bearer\s+/i, "");
  const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: auth } } });

  // Verifica la sesión localmente (más rápido); si no se puede, pregunta al servidor de Auth.
  let yo: string | undefined;
  try {
    const { data } = await comoUsuario.auth.getClaims(token);
    yo = data?.claims?.sub;
  } catch { /* sigue con el método completo */ }
  if (!yo) {
    const { data } = await comoUsuario.auth.getUser(token);
    yo = data?.user?.id;
  }
  if (!yo) return responder({ error: "Sesión no válida" }, 401);

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

  // Reloj: descuenta el tiempo que pensó quien mueve.
  const ahora = Date.now();
  const campo = juego.turn() === "w" ? "reloj_blancas" : "reloj_negras";
  const gastado = p.ultimo_tick ? ahora - new Date(p.ultimo_tick).getTime() : 0;
  const restante = Number(p[campo]) - gastado;
  if (restante <= 0) {
    const { data: fin } = await db
      .from("partidas")
      .update({
        estado: "terminada",
        resultado: juego.turn() === "w" ? "0-1" : "1-0",
        motivo: "tiempo",
        [campo]: 0,
        version: p.version + 1,
        actualizada: new Date(ahora).toISOString(),
      })
      .eq("id", partida)
      .eq("version", p.version)
      .select()
      .single();
    return responder({ error: "Se te acabó el tiempo", partida: fin }, 409);
  }

  let mov;
  try {
    mov = juego.move({ from: desde, to: hacia, promotion: promocion });
  } catch {
    return responder({ error: "Jugada no válida" }, 422);
  }

  let estado = "jugando";
  let resultado: string | null = null;
  let motivo: string | null = null;
  if (juego.isCheckmate()) {
    estado = "terminada";
    resultado = juego.turn() === "w" ? "0-1" : "1-0";
    motivo = "jaque mate";
  } else if (juego.isDraw() || juego.isStalemate()) {
    estado = "terminada";
    resultado = "½-½";
    motivo = "tablas";
  }

  const jugadas = [...(p.jugadas ?? []), { desde: mov.from, hacia: mov.to, san: mov.san }];
  const { data: nueva, error: errGuardar } = await db
    .from("partidas")
    .update({
      fen: juego.fen(),
      jugadas,
      estado,
      resultado,
      motivo,
      [campo]: restante,
      ultimo_tick: new Date(ahora).toISOString(),
      version: p.version + 1,
      actualizada: new Date(ahora).toISOString(),
    })
    .eq("id", partida)
    .eq("version", p.version)
    .select()
    .single();

  if (errGuardar || !nueva) return responder({ error: "Alguien movió al mismo tiempo, intenta de nuevo" }, 409);
  return responder({ partida: nueva });
});
