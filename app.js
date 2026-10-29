import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { Chess } from "https://esm.sh/chess.js@1.4.0";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { piezaSVG } from "./piezas.js";

const $ = (id) => document.getElementById(id);
const COLUMNAS = "abcdefgh";

let sb;
let yo = null;
let partida = null;
let canal = null;
let elegida = null;
let destinos = [];
let enviando = false;

function avisar(texto) {
  const el = $("aviso");
  el.textContent = texto;
  el.classList.remove("oculto");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.add("oculto"), 4000);
}

async function iniciarSesion() {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: nueva, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return nueva.user.id;
}

function idDeLaUrl() {
  return new URLSearchParams(location.search).get("p");
}

// ---------- Inicio ----------
function mostrarInicio() {
  $("inicio").classList.remove("oculto");
  $("partida").classList.add("oculto");
}

$("crear").addEventListener("click", async () => {
  const { data, error } = await sb.rpc("crear_partida");
  if (error) return avisar("No se pudo crear la partida. Intenta de nuevo.");
  history.pushState(null, "", `?p=${data}`);
  abrirPartida(data);
});

// ---------- Partida ----------
async function abrirPartida(id) {
  $("inicio").classList.add("oculto");
  $("partida").classList.remove("oculto");

  const { data, error } = await sb.from("partidas").select("*").eq("id", id).single();
  if (error || !data) {
    avisar("No encontramos esa partida.");
    history.replaceState(null, "", "./");
    return mostrarInicio();
  }
  partida = data;
  dibujar();

  if (canal) sb.removeChannel(canal);
  canal = sb
    .channel(`partida-${id}`)
    .on("broadcast", { event: "jugada" }, ({ payload }) => aplicarRemota(payload))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "partidas", filter: `id=eq.${id}` }, (cambio) => {
      if (cambio.new.version > partida.version || (cambio.new.version === partida.version && !partida.optimista)) {
        partida = cambio.new;
        elegida = null;
        destinos = [];
        dibujar();
      }
    })
    .subscribe(async (estado) => {
      if (estado === "SUBSCRIBED") {
        const { data: fresca } = await sb.from("partidas").select("*").eq("id", id).single();
        if (fresca && fresca.version > partida.version) {
          partida = fresca;
          dibujar();
        }
      }
    });
}

$("unirse").addEventListener("click", async () => {
  const { error } = await sb.rpc("unirse_partida", { p: partida.id });
  if (error) return avisar("Esta partida ya no está disponible.");
  const { data } = await sb.from("partidas").select("*").eq("id", partida.id).single();
  if (data) {
    partida = data;
    dibujar();
  }
});

$("copiar").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    avisar("Link copiado. Mándaselo a tu amigo.");
  } catch {
    avisar(location.href);
  }
});

function miColor() {
  if (!partida) return null;
  if (partida.blancas === yo) return "w";
  if (partida.negras === yo) return "b";
  return null;
}

function textoResultado(r) {
  if (r === "1-0") return "Ganan las blancas por jaque mate.";
  if (r === "0-1") return "Ganan las negras por jaque mate.";
  return "La partida terminó en tablas.";
}

function dibujar() {
  const juego = new Chess(partida.fen);
  const color = miColor();
  const volteado = color === "b";
  const turno = juego.turn();
  const ultima = partida.jugadas.at(-1);

  // Estado y botones
  const estado = $("estado");
  $("copiar").classList.toggle("oculto", !(partida.estado === "esperando" && color === "w"));
  $("unirse").classList.toggle("oculto", !(partida.estado === "esperando" && color !== "w"));
  if (partida.estado === "esperando") {
    estado.textContent = color === "w"
      ? "Esperando rival. Copia el link y compártelo."
      : "Esta mesa está esperando rival.";
  } else if (partida.estado === "terminada") {
    estado.textContent = textoResultado(partida.resultado);
  } else {
    const jaque = juego.inCheck() ? "Jaque. " : "";
    if (!color) estado.textContent = `${jaque}Mueven las ${turno === "w" ? "blancas" : "negras"}.`;
    else estado.textContent = `${jaque}${turno === color ? "Tu turno." : "Turno de tu rival."}`;
  }

  // Jugadores
  const tira = (c) => {
    const esYo = c === color;
    const activo = partida.estado === "jugando" && turno === c;
    const nombre = c === "w" ? "Blancas" : "Negras";
    const ocupado = c === "w" || partida.negras;
    return `<div><strong>${esYo ? "Tú" : ocupado ? "Rival" : "Lugar libre"}</strong><small>${nombre}</small></div>` +
      `<span class="turno${activo ? " activo" : ""}">${activo ? "Su turno" : "Espera"}</span>`;
  };
  $("arriba").innerHTML = tira(volteado ? "w" : "b");
  $("abajo").innerHTML = tira(volteado ? "b" : "w");

  // Tablero
  const tablero = $("tablero");
  tablero.innerHTML = "";
  const puedoMover = partida.estado === "jugando" && color === turno && !enviando && !partida.optimista;
  for (let fila = 0; fila < 8; fila++) {
    for (let col = 0; col < 8; col++) {
      const f = volteado ? 7 - col : col;
      const rango = volteado ? fila + 1 : 8 - fila;
      const casilla = COLUMNAS[f] + rango;
      const pieza = juego.get(casilla);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "casilla " + ((f + rango) % 2 === 1 ? "oscura" : "clara");
      if (ultima && (ultima.desde === casilla || ultima.hacia === casilla)) btn.classList.add("ultima");
      if (elegida === casilla) btn.classList.add("elegida");
      if (destinos.includes(casilla)) btn.classList.add("destino");
      if (pieza) btn.classList.add("ocupada");
      if (puedoMover && ((pieza && pieza.color === color) || destinos.includes(casilla))) btn.classList.add("jugable");
      btn.setAttribute("aria-label", casilla + (pieza ? "" : ", vacía"));
      if (pieza) {
        const div = document.createElement("div");
        div.className = "pieza";
        div.innerHTML = piezaSVG(pieza.type, pieza.color);
        btn.appendChild(div);
      }
      btn.addEventListener("click", () => tocar(casilla, juego, puedoMover, color));
      tablero.appendChild(btn);
    }
  }
  aplicarAngulo();

  // Jugadas
  const lista = $("jugadas");
  lista.innerHTML = "";
  if (!partida.jugadas.length) {
    lista.innerHTML = '<li class="vacio">Todavía no hay jugadas.</li>';
  }
  for (let i = 0; i < partida.jugadas.length; i += 2) {
    const li = document.createElement("li");
    const b = partida.jugadas[i + 1];
    li.innerHTML = `<span>${i / 2 + 1}.</span><span>${partida.jugadas[i].san}</span><span>${b ? b.san : ""}</span>`;
    lista.appendChild(li);
  }
}

function tocar(casilla, juego, puedoMover, color) {
  if (!puedoMover) return;
  if (elegida && destinos.includes(casilla)) return mover(elegida, casilla);
  const pieza = juego.get(casilla);
  if (pieza && pieza.color === color && casilla !== elegida) {
    elegida = casilla;
    destinos = juego.moves({ square: casilla, verbose: true }).map((m) => m.to);
  } else {
    elegida = null;
    destinos = [];
  }
  dibujar();
}

// Aplica una jugada localmente sin esperar al servidor.
function aplicarLocal(desde, hacia) {
  const juego = new Chess(partida.fen);
  let mov;
  try {
    mov = juego.move({ from: desde, to: hacia, promotion: "q" });
  } catch {
    return null;
  }
  const estado = juego.isGameOver() ? "terminada" : partida.estado;
  let resultado = partida.resultado;
  if (juego.isCheckmate()) resultado = juego.turn() === "w" ? "0-1" : "1-0";
  else if (juego.isGameOver()) resultado = "½-½";
  return {
    ...partida,
    fen: juego.fen(),
    jugadas: [...partida.jugadas, { desde: mov.from, hacia: mov.to, san: mov.san }],
    estado,
    resultado,
    optimista: true,
  };
}

// Jugada que llega al instante desde el navegador del rival.
function aplicarRemota(datos) {
  if (!partida || partida.optimista || datos.version !== partida.version) return;
  const nueva = aplicarLocal(datos.desde, datos.hacia);
  if (!nueva) return;
  partida = nueva;
  elegida = null;
  destinos = [];
  dibujar();
}

async function mover(desde, hacia) {
  const previa = partida;
  const nueva = aplicarLocal(desde, hacia);
  if (!nueva) return;
  partida = nueva;
  elegida = null;
  destinos = [];
  enviando = true;
  dibujar();

  if (canal) canal.send({ type: "broadcast", event: "jugada", payload: { version: previa.version, desde, hacia } });

  const { data, error } = await sb.functions.invoke("jugada", {
    body: { partida: previa.id, desde, hacia, promocion: "q" },
  });
  enviando = false;
  if (error) {
    let mensaje = "No se pudo enviar la jugada.";
    try {
      const cuerpo = await error.context.json();
      if (cuerpo?.error) mensaje = cuerpo.error;
    } catch { /* sin detalle */ }
    avisar(mensaje);
    const { data: fresca } = await sb.from("partidas").select("*").eq("id", previa.id).single();
    partida = fresca || previa;
  } else if (data?.partida && data.partida.version > previa.version) {
    if (partida.optimista || data.partida.version >= partida.version) partida = data.partida;
  }
  dibujar();
}

// ---------- Vista personal (solo en este navegador) ----------
function aplicarAngulo() {
  const a = Number($("angulo").value);
  $("angulo-valor").textContent = `${a}°`;
  $("marco").style.transform = `rotateX(${a}deg)`;
  document.querySelectorAll(".pieza").forEach((p) => (p.style.transform = `rotateX(${-a}deg)`));
}
$("angulo").addEventListener("input", aplicarAngulo);

// ---------- Arranque ----------
async function arrancar() {
  if (SUPABASE_URL.includes("TU-PROYECTO") || SUPABASE_KEY.includes("TU-CLAVE")) {
    mostrarInicio();
    $("crear").disabled = true;
    return avisar("Falta llenar config.js con los datos de Supabase.");
  }
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  try {
    yo = await iniciarSesion();
  } catch {
    mostrarInicio();
    return avisar("No se pudo iniciar sesión. Revisa que el acceso anónimo esté activado en Supabase.");
  }
  const id = idDeLaUrl();
  if (id) abrirPartida(id);
  else mostrarInicio();
}

window.addEventListener("popstate", () => {
  const id = idDeLaUrl();
  if (id) abrirPartida(id);
  else mostrarInicio();
});

arrancar();
