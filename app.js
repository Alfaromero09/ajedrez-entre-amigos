import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { Chess } from "https://esm.sh/chess.js@1.4.0";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { piezaSVG, iconoSVG } from "./piezas.js";

const $ = (id) => document.getElementById(id);
const COLUMNAS = "abcdefgh";

let sb;
let yo = null;
let partida = null;
let canal = null;
let elegida = null;
let movimientos = [];
let enviando = false;
let desfase = 0;
let reclamando = false;
let minutosElegidos = 10;
const nombres = {};
const avatares = {};

// ---------- Utilidades ----------
function avisar(texto) {
  const el = $("aviso");
  el.textContent = texto;
  el.classList.remove("oculto");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.add("oculto"), 4500);
}

// Llegó desde el enlace del correo de confirmación (se lee antes de que Supabase limpie la URL)
const vieneDeConfirmar = /type=(signup|email|invite)/.test(location.hash) || new URLSearchParams(location.search).has("code");
// Teléfonos y tabletas: pantalla táctil sin mouse
const esMovil = matchMedia("(hover: none) and (pointer: coarse)").matches;

function mostrar(vista) {
  for (const v of ["acceso", "inicio", "partida"]) $(v).classList.toggle("oculto", v !== vista);
  if (vista === "inicio") {
    if (canal) { sb.removeChannel(canal); canal = null; }
    partida = null;
    cargarClub();
  }
  presenciaEstado(vista === "partida" ? "partida" : "club");
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ahoraServidor = () => Date.now() + desfase;
const idDeLaUrl = () => new URLSearchParams(location.search).get("p");
const destinos = () => movimientos.map((m) => m.to);

async function calibrarReloj() {
  const t0 = Date.now();
  const { data } = await sb.rpc("hora_servidor");
  const t1 = Date.now();
  if (data) desfase = new Date(data).getTime() - (t0 + t1) / 2;
}

async function cargarNombres(ids) {
  const faltan = ids.filter((id) => id && !nombres[id]);
  if (!faltan.length) return false;
  const { data } = await sb.from("perfiles").select("id, nombre, avatar").in("id", faltan);
  (data || []).forEach((p) => (nombres[p.id] = p.nombre, avatares[p.id] = p.avatar));
  return true;
}
const nombreDe = (id) => (id === yo ? "Tú" : nombres[id] || "Jugador");

// ---------- Acceso ----------
$("icono-rey").innerHTML = iconoSVG("rey");
$("icono-dama").innerHTML = iconoSVG("dama");

// ---------- Contraseñas: ojito y confirmación ----------
const OJO_ABIERTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const OJO_CERRADO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1"/><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
document.querySelectorAll(".ojo").forEach((b) => {
  b.innerHTML = OJO_ABIERTO;
  b.addEventListener("click", () => {
    const input = b.previousElementSibling;
    const ver = input.type === "password";
    input.type = ver ? "text" : "password";
    b.innerHTML = ver ? OJO_CERRADO : OJO_ABIERTO;
    b.setAttribute("aria-pressed", String(ver));
    b.setAttribute("aria-label", ver ? "Ocultar contraseña" : "Mostrar contraseña");
    input.focus();
  });
});
function revisarClaves() {
  const a = $("r-clave").value, b = $("r-clave2").value, nota = $("nota-clave");
  $("r-clave2").classList.remove("coincide", "no-coincide");
  nota.className = "nota"; nota.textContent = "";
  if (!b) return true;
  const ok = a === b;
  $("r-clave2").classList.add(ok ? "coincide" : "no-coincide");
  nota.classList.add(ok ? "bien" : "mal");
  nota.textContent = ok ? "Las contraseñas coinciden." : "Las contraseñas no coinciden.";
  return ok;
}
$("r-clave").addEventListener("input", revisarClaves);
$("r-clave2").addEventListener("input", revisarClaves);

$("form-entrar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { data, error } = await sb.auth.signInWithPassword({
    email: $("e-correo").value.trim(),
    password: $("e-clave").value,
  });
  if (error) {
    if (/not confirmed/i.test(error.message)) return avisar("Primero confirma tu correo con el enlace que te mandamos.");
    return avisar("Correo o contraseña incorrectos.");
  }
  entrar(data.user);
});

$("form-registro").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombre = $("r-nombre").value.trim();
  if (nombre.length < 2) return avisar("El nombre debe tener al menos 2 letras.");
  if ($("r-clave").value !== $("r-clave2").value) { revisarClaves(); $("r-clave2").focus(); return avisar("Las dos contraseñas no coinciden."); }
  const { data: libre } = await sb.rpc("nombre_disponible", { n: nombre });
  if (libre === false) return avisar("Ese nombre ya lo usa alguien del club. Prueba otro.");
  const { data, error } = await sb.auth.signUp({
    email: $("r-correo").value.trim(),
    password: $("r-clave").value,
    options: {
      emailRedirectTo: location.origin + location.pathname + location.search,
      data: {
        nombre,
        avatar: document.querySelector('input[name="avatar"]:checked')?.value || "rey",
        codigo: $("r-codigo").value.trim(),
      },
    },
  });
  if (error) {
    if (/database error/i.test(error.message)) return avisar("El código de invitación no es correcto.");
    if (/already registered/i.test(error.message)) return avisar("Ese correo ya tiene cuenta. Entra con tu contraseña.");
    if (/password/i.test(error.message)) return avisar("La contraseña debe tener al menos 6 caracteres.");
    return avisar("No se pudo crear la cuenta. Intenta de nuevo.");
  }
  if (!data.session) {
    e.target.reset();
    revisarClaves();
    return avisar("Listo. Te mandamos un correo: abre el enlace para confirmar tu cuenta y luego entra.");
  }
  entrar(data.user);
});

$("salir").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.href = "./";
});

async function entrar(usuario) {
  yo = usuario.id;
  await Promise.all([cargarNombres([yo]), calibrarReloj()]);
  nombres[yo] = nombres[yo] || usuario.user_metadata?.nombre || "Jugador";
  $("mi-nombre").textContent = nombres[yo];
  $("mi-icono").innerHTML = iconoSVG(avatares[yo] || usuario.user_metadata?.avatar);
  $("cabecera-usuario").classList.remove("oculto");
  escucharClub();
  const id = idDeLaUrl();
  if (id) abrirPartida(id);
  else mostrar("inicio");
  $("bienvenida").classList.toggle("oculto", !vieneDeConfirmar);
  if ((avatares[yo] || usuario.user_metadata?.avatar) === "dama") $("bienvenida-titulo").textContent = "¡Bienvenida al club!";
  $("sugerencia-escritorio").classList.toggle("oculto", !esMovil);
}

// ---------- Inicio ----------
$("tiempos").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-min]");
  if (!btn) return;
  minutosElegidos = Number(btn.dataset.min);
  $("tiempos").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
});

$("crear").addEventListener("click", async () => {
  const { data, error } = await sb.rpc("crear_partida", { p_minutos: minutosElegidos });
  if (error) return avisar("No se pudo crear la partida. Intenta de nuevo.");
  irAPartida(data);
});

// ---------- Dashboard del club ----------
const ICONO_RELOJ = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
const ICONO_OJO = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0"/><path d="M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6"/></svg>';
let canalClub = null;
let enLinea = {};
let ultimasSalas = [];
let ultimasVivo = [];
let pendienteClub = null;

const textoTiempo = (min) => (min >= 60 ? `${min / 60} ${min === 60 ? "hora" : "horas"}` : `${min} min`);
const ficha = (id, extra = "") => `<span class="ficha ${extra}">${iconoSVG(avatares[id] || "rey")}</span>`;

function hace(fecha) {
  const min = Math.max(0, Math.round((ahoraServidor() - new Date(fecha).getTime()) / 60000));
  if (min < 1) return "Abrió hace un momento";
  if (min < 60) return `Abrió hace ${min} min`;
  const h = Math.round(min / 60);
  return `Abrió hace ${h} ${h === 1 ? "hora" : "horas"}`;
}

function saludar() {
  const h = new Date().getHours();
  const parte = h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
  $("saludo").textContent = `${parte}, ${nombres[yo] || "jugador"}`;
}

function irAPartida(id) {
  history.pushState(null, "", `?p=${id}`);
  abrirPartida(id);
}

async function cargarClub() {
  if (!yo) return;
  saludar();
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [salasR, vivoR, mesaR, mioR] = await Promise.all([
    sb.from("partidas").select("id, blancas, minutos, creada").eq("estado", "esperando").gte("creada", desde).order("creada", { ascending: false }).limit(30),
    sb.from("partidas").select("id, blancas, negras, minutos, jugadas, actualizada, fen, reloj_blancas, reloj_negras, ultimo_tick").eq("estado", "jugando").order("actualizada", { ascending: false }).limit(20),
    sb.rpc("mesa_del_club"),
    sb.from("partidas").select("blancas, negras, resultado").eq("estado", "terminada").not("negras", "is", null).not("resultado", "is", null).or(`blancas.eq.${yo},negras.eq.${yo}`).order("actualizada", { ascending: false }).limit(50),
  ]);
  const salas = salasR.data || [];
  // Fuera las que ya se quedaron sin tiempo aunque nadie lo haya reclamado
  const vivo = (vivoR.data || []).filter((x) => {
    if (!x.ultimo_tick) return false;
    const resta = (x.fen.split(" ")[1] === "w" ? x.reloj_blancas : x.reloj_negras) - (ahoraServidor() - new Date(x.ultimo_tick).getTime());
    return resta > 0;
  });
  const mesa = mesaR.data || [];
  mesa.forEach((m) => { nombres[m.id] = m.nombre; avatares[m.id] = m.avatar; });
  await cargarNombres([...salasR.data || [], ...vivo].flatMap((x) => [x.blancas, x.negras]));
  // Solo partidas de jugadores con cuenta del club (las pruebas anónimas de la fase 1 no tienen nombre)
  const conCuenta = (id) => !!nombres[id];
  ultimasSalas = salas.filter((x) => conCuenta(x.blancas));
  ultimasVivo = vivo.filter((x) => conCuenta(x.blancas) && conCuenta(x.negras));
  if ($("inicio").classList.contains("oculto")) return;
  pintarSalas(ultimasSalas);
  pintarVivo(ultimasVivo);
  pintarMesa(mesa);
  pintarNumeros(mesa.find((m) => m.id === yo), mioR.data || []);
  pintarResumen();
  pintarEnLinea();
}

function pintarSalas(salas) {
  const ajenas = salas.filter((x) => x.blancas !== yo).length;
  $("cuenta-salas").textContent = ajenas ? `${ajenas} ${ajenas === 1 ? "esperando rival" : "esperando rival"}` : "";
  if (!salas.length) {
    $("salas").innerHTML = '<p class="vacio-club">No hay salas abiertas. Crea una partida y aparecerá aquí para que cualquiera del club se una.</p>';
    return;
  }
  $("salas").innerHTML = salas.map((x) => {
    const mia = x.blancas === yo;
    const botones = mia
      ? `<button class="secundario" data-abrir="${x.id}">Abrir</button><button class="secundario" data-cancelar="${x.id}">Cerrar sala</button>`
      : `<button class="primario" data-unirse="${x.id}">Unirse</button>`;
    return `<div class="fila-sala">
      <div class="quien">${ficha(x.blancas)}<div><strong>${esc(mia ? "Tu sala" : nombres[x.blancas] || "Jugador")}</strong><small>${hace(x.creada)}</small></div></div>
      <span class="reloj-chip">${ICONO_RELOJ}${textoTiempo(x.minutos)}</span>
      <div class="acciones">${botones}</div>
    </div>`;
  }).join("");
}

function pintarVivo(vivo) {
  if (!vivo.length) {
    $("en-vivo").innerHTML = '<p class="vacio-club">Ahorita nadie está jugando. Cuando empiece una partida, aquí podrás mirarla.</p>';
    return;
  }
  $("en-vivo").innerHTML = vivo.map((x) => {
    const mia = x.blancas === yo || x.negras === yo;
    const n = Math.ceil((x.jugadas?.length || 0) / 2);
    const meta = `${textoTiempo(x.minutos)} · ${n ? `jugada ${n}` : "recién empieza"}`;
    const nb = x.blancas === yo ? "Tú" : nombres[x.blancas] || "Jugador";
    const nn = x.negras === yo ? "Tú" : nombres[x.negras] || "Jugador";
    return `<div class="carta-vivo${mia ? " mia" : ""}">
      <div class="duelo"><span class="parejas">${ficha(x.blancas, "clara")}${ficha(x.negras, "oscura")}</span><strong>${esc(nb)} vs ${esc(nn)}</strong></div>
      <div class="pie-vivo"><span>${meta}</span>${mia
        ? `<button class="primario mirar" data-abrir="${x.id}">Volver a mi partida</button>`
        : `<button class="secundario mirar" data-abrir="${x.id}">${ICONO_OJO}Mirar</button>`}</div>
    </div>`;
  }).join("");
}

function pintarMesa(mesa) {
  const filas = mesa.filter((m) => m.pj > 0 || m.id === yo);
  if (!filas.length) {
    $("mesa").innerHTML = '<p class="vacio-club">Todavía no se termina ninguna partida. La primera victoria abre la tabla.</p>';
    return;
  }
  let pos = 0, previo = null;
  $("mesa").innerHTML = filas.map((m, i) => {
    if (m.pts !== previo) { pos = i + 1; previo = m.pts; }
    const yoSoy = m.id === yo;
    return `<div class="mesa-fila${yoSoy ? " yo" : ""}">
      <span class="pos">${pos}</span>
      <span class="nom">${ficha(m.id, "chica")}<b>${esc(m.nombre)}</b>${yoSoy ? '<span class="etiqueta-tu">Tú</span>' : ""}</span>
      <span>${m.pj}</span><span>${m.g}</span><span>${m.p}</span><span>${m.t}</span><span class="pts">${m.pts}</span>
    </div>`;
  }).join("");
}

function pintarNumeros(m, mias) {
  const d = m || { pj: 0, g: 0, p: 0, t: 0 };
  $("n-pj").textContent = d.pj;
  $("n-g").textContent = d.g;
  $("n-p").textContent = d.p;
  $("n-t").textContent = d.t;
  const pct = d.pj ? Math.round((d.g / d.pj) * 100) : 0;
  $("n-pct").textContent = `${pct}%`;
  $("n-barra").style.width = `${pct}%`;
  let racha = 0;
  for (const x of mias) {
    const gane = (x.blancas === yo && x.resultado === "1-0") || (x.negras === yo && x.resultado === "0-1");
    if (!gane) break;
    racha++;
  }
  $("n-racha").textContent = !d.pj
    ? "Juega tu primera partida para estrenar tus números."
    : racha >= 2 ? `Llevas ${racha} victorias seguidas.`
    : racha === 1 ? "Ganaste tu última partida."
    : "La siguiente es la buena.";
}

function estadoDe(id) {
  if (ultimasVivo.some((x) => x.blancas === id || x.negras === id)) return "Jugando";
  if (ultimasSalas.some((x) => x.blancas === id)) return "Esperando rival";
  return "En el club";
}

function pintarEnLinea() {
  const ids = Object.keys(enLinea);
  if (!ids.length) {
    $("en-linea").innerHTML = '<p class="vacio-club">Solo estás tú por ahora.</p>';
    return;
  }
  ids.sort((a, b) => (a === yo ? -1 : b === yo ? 1 : (enLinea[a].nombre || "").localeCompare(enLinea[b].nombre || "")));
  $("en-linea").innerHTML = ids.map((id) => {
    const u = enLinea[id];
    return `<div class="persona">${ficha(id, "chica punto")}<div><strong>${esc(id === yo ? `${u.nombre} (tú)` : u.nombre)}</strong><small>${estadoDe(id)}</small></div></div>`;
  }).join("");
}

function pintarResumen() {
  const esperando = [...new Set(ultimasSalas.filter((x) => x.blancas !== yo).map((x) => nombres[x.blancas] || "Alguien"))];
  const vivos = ultimasVivo.length;
  let a;
  if (!esperando.length) a = "Nadie está esperando rival.";
  else if (esperando.length === 1) a = `${esperando[0]} está esperando rival.`;
  else if (esperando.length === 2) a = `${esperando[0]} y ${esperando[1]} están esperando rival.`;
  else a = `${esperando.length} jugadores están esperando rival.`;
  const b = vivos === 0 ? " Crea una partida y comparte el link." : vivos === 1 ? " Hay una partida en vivo por si quieres mirar." : ` Hay ${vivos} partidas en vivo por si quieres mirar.`;
  $("resumen").textContent = a + b;
}

$("inicio").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.abrir) return irAPartida(b.dataset.abrir);
  if (b.dataset.unirse) {
    b.disabled = true;
    const { error } = await sb.rpc("unirse_partida", { p: b.dataset.unirse });
    if (error) { b.disabled = false; cargarClub(); return avisar("Alguien más tomó esa sala. Elige otra."); }
    return irAPartida(b.dataset.unirse);
  }
  if (b.dataset.cancelar) {
    b.disabled = true;
    const { error } = await sb.rpc("cancelar_partida", { p: b.dataset.cancelar });
    if (error) avisar("Esa sala ya no se puede cerrar.");
    cargarClub();
  }
});

function refrescarClub() {
  clearTimeout(pendienteClub);
  pendienteClub = setTimeout(() => { if (!$("inicio").classList.contains("oculto")) cargarClub(); }, 400);
}

function escucharClub() {
  if (canalClub) return;
  canalClub = sb.channel("club", { config: { presence: { key: yo } } })
    .on("postgres_changes", { event: "*", schema: "public", table: "partidas" }, refrescarClub)
    .on("presence", { event: "sync" }, () => {
      const estado = canalClub.presenceState();
      enLinea = {};
      for (const [id, metas] of Object.entries(estado)) {
        const m = metas[0] || {};
        enLinea[id] = { nombre: m.nombre || nombres[id] || "Jugador" };
        if (m.avatar) avatares[id] = m.avatar;
      }
      if (!$("inicio").classList.contains("oculto")) pintarEnLinea();
    })
    .subscribe((estado) => {
      if (estado === "SUBSCRIBED") presenciaEstado("club");
    });
}

function presenciaEstado(donde) {
  if (!canalClub || !yo) return;
  canalClub.track({ nombre: nombres[yo] || "Jugador", avatar: avatares[yo] || "rey", donde }).catch(() => {});
}
setInterval(() => { if (yo && !$("inicio").classList.contains("oculto")) { pintarSalas(ultimasSalas); } }, 60000);

// ---------- Partida ----------
async function recargar(id) {
  const { data } = await sb.from("partidas").select("*").eq("id", id).single();
  return data;
}

async function abrirPartida(id) {
  mostrar("partida");
  const data = await recargar(id);
  if (!data) {
    avisar("No encontramos esa partida.");
    history.replaceState(null, "", "./");
    return mostrar("inicio");
  }
  partida = data;
  await cargarNombres([partida.blancas, partida.negras]);
  dibujar();

  if (canal) sb.removeChannel(canal);
  canal = sb
    .channel(`partida-${id}`)
    .on("broadcast", { event: "jugada" }, ({ payload }) => aplicarRemota(payload))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "partidas", filter: `id=eq.${id}` }, async (cambio) => {
      if (cambio.new.version > partida.version || (cambio.new.version === partida.version && !partida.optimista)) {
        partida = cambio.new;
        elegida = null;
        movimientos = [];
        if (await cargarNombres([partida.blancas, partida.negras])) dibujar();
        dibujar();
      }
    })
    .subscribe(async (estado) => {
      if (estado === "SUBSCRIBED") {
        const fresca = await recargar(id);
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
  const data = await recargar(partida.id);
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

$("rendirse").addEventListener("click", async () => {
  if (!confirm("¿Seguro que quieres rendirte?")) return;
  const { error } = await sb.rpc("rendirse", { p: partida.id });
  if (error) avisar("No se pudo completar. Intenta de nuevo.");
});

function miColor() {
  if (!partida) return null;
  if (partida.blancas === yo) return "w";
  if (partida.negras === yo) return "b";
  return null;
}

function textoFinal() {
  const { resultado, motivo } = partida;
  if (resultado === "½-½") return "La partida terminó en tablas.";
  const ganador = resultado === "1-0" ? partida.blancas : partida.negras;
  const quien = ganador === yo ? "Ganaste" : `Ganó ${nombres[ganador] || "tu rival"}`;
  const porque = motivo === "tiempo" ? "por tiempo" : motivo === "abandono" ? "por abandono" : "por jaque mate";
  return `${quien} ${porque}.`;
}

// ---------- Reloj ----------
function restantes() {
  let w = Number(partida.reloj_blancas);
  let b = Number(partida.reloj_negras);
  if (partida.estado === "jugando" && partida.ultimo_tick) {
    const gastado = ahoraServidor() - new Date(partida.ultimo_tick).getTime();
    if (partida.fen.split(" ")[1] === "w") w -= gastado;
    else b -= gastado;
  }
  return { w: Math.max(0, w), b: Math.max(0, b) };
}

function formato(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const seg = String(s % 60).padStart(2, "0");
  return h ? `${h}:${m}:${seg}` : `${m}:${seg}`;
}

function actualizarRelojes() {
  if (!partida) return;
  const r = restantes();
  const turno = partida.fen.split(" ")[1];
  for (const c of ["w", "b"]) {
    const el = $(`reloj-${c}`);
    if (!el) continue;
    el.textContent = formato(r[c]);
    el.classList.toggle("activo", partida.estado === "jugando" && turno === c);
    el.classList.toggle("poco", r[c] < 20000);
  }
  const color = miColor();
  if (partida.estado === "jugando" && color && r[turno] <= 0 && !reclamando) {
    reclamando = true;
    sb.rpc("reclamar_tiempo", { p: partida.id }).then(async () => {
      const fresca = await recargar(partida.id);
      if (fresca && fresca.version > partida.version) {
        partida = fresca;
        dibujar();
      }
      setTimeout(() => (reclamando = false), 1500);
    });
  }
}
setInterval(actualizarRelojes, 250);

// ---------- Dibujo ----------
function dibujar() {
  const juego = new Chess(partida.fen);
  const color = miColor();
  const volteado = color === "b";
  const turno = juego.turn();
  const ultima = partida.jugadas.at(-1);

  const estado = $("estado");
  const jugando = partida.estado === "jugando";
  $("copiar").classList.toggle("oculto", !(partida.estado === "esperando" && color === "w"));
  $("unirse").classList.toggle("oculto", !(partida.estado === "esperando" && color !== "w"));
  $("rendirse").classList.toggle("oculto", !(jugando && color));
  $("nueva").classList.toggle("oculto", partida.estado !== "terminada" && !!color);
  if (partida.estado === "esperando") {
    estado.textContent = color === "w"
      ? "Esperando rival. Copia el link y compártelo."
      : `${nombres[partida.blancas] || "Alguien"} te espera en esta mesa.`;
  } else if (partida.estado === "terminada") {
    estado.textContent = textoFinal();
  } else {
    const jaque = juego.inCheck() ? "Jaque. " : "";
    if (!color) estado.textContent = `${jaque}Mueven las ${turno === "w" ? "blancas" : "negras"}.`;
    else estado.textContent = `${jaque}${turno === color ? "Tu turno." : `Turno de ${nombreDe(turno === "w" ? partida.blancas : partida.negras)}.`}`;
  }

  const tira = (c) => {
    const id = c === "w" ? partida.blancas : partida.negras;
    const nombre = id ? nombreDe(id) : "Lugar libre";
    const icono = id ? `<span class="avatar">${iconoSVG(avatares[id])}</span>` : "";
    return `<div>${icono}<div><strong>${esc(nombre)}</strong><small>${c === "w" ? "Blancas" : "Negras"}</small></div></div>` +
      `<span class="reloj" id="reloj-${c}">--:--</span>`;
  };
  $("arriba").innerHTML = tira(volteado ? "w" : "b");
  $("abajo").innerHTML = tira(volteado ? "b" : "w");

  const tablero = $("tablero");
  tablero.innerHTML = "";
  const puedoMover = jugando && color === turno && !enviando && !partida.optimista;
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
      if (destinos().includes(casilla)) btn.classList.add("destino");
      if (pieza) btn.classList.add("ocupada");
      if (puedoMover && ((pieza && pieza.color === color) || destinos().includes(casilla))) btn.classList.add("jugable");
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
  actualizarRelojes();

  const lista = $("jugadas");
  lista.innerHTML = "";
  if (!partida.jugadas.length) lista.innerHTML = '<li class="vacio">Todavía no hay jugadas.</li>';
  for (let i = 0; i < partida.jugadas.length; i += 2) {
    const li = document.createElement("li");
    const b = partida.jugadas[i + 1];
    li.innerHTML = `<span>${i / 2 + 1}.</span><span>${partida.jugadas[i].san}</span><span>${b ? b.san : ""}</span>`;
    lista.appendChild(li);
  }
}

function tocar(casilla, juego, puedoMover, color) {
  if (!puedoMover) return;
  if (elegida && destinos().includes(casilla)) {
    const desde = elegida;
    const corona = movimientos.some((m) => m.to === casilla && m.promotion);
    if (corona) return pedirCoronacion(color, (pieza) => mover(desde, casilla, pieza));
    return mover(desde, casilla, "q");
  }
  const pieza = juego.get(casilla);
  if (pieza && pieza.color === color && casilla !== elegida) {
    elegida = casilla;
    movimientos = juego.moves({ square: casilla, verbose: true });
  } else {
    elegida = null;
    movimientos = [];
  }
  dibujar();
}

function pedirCoronacion(color, elegir) {
  const caja = $("opciones-coronar");
  caja.innerHTML = "";
  const etiquetas = { q: "Dama", r: "Torre", b: "Alfil", n: "Caballo" };
  for (const t of ["q", "r", "b", "n"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", etiquetas[t]);
    btn.innerHTML = piezaSVG(t, color);
    btn.addEventListener("click", () => {
      $("coronar").classList.add("oculto");
      elegir(t);
    });
    caja.appendChild(btn);
  }
  $("coronar").classList.remove("oculto");
  caja.querySelector("button").focus();
}
$("coronar-cancelar").addEventListener("click", () => $("coronar").classList.add("oculto"));

// Aplica una jugada localmente sin esperar al servidor.
function aplicarLocal(desde, hacia, promocion) {
  const juego = new Chess(partida.fen);
  const turno = juego.turn();
  let mov;
  try {
    mov = juego.move({ from: desde, to: hacia, promotion: promocion || "q" });
  } catch {
    return null;
  }
  const ahora = ahoraServidor();
  const r = restantes();
  let resultado = partida.resultado;
  let motivo = partida.motivo;
  if (juego.isCheckmate()) {
    resultado = turno === "w" ? "1-0" : "0-1";
    motivo = "jaque mate";
  } else if (juego.isGameOver()) {
    resultado = "½-½";
    motivo = "tablas";
  }
  return {
    ...partida,
    fen: juego.fen(),
    jugadas: [...partida.jugadas, { desde: mov.from, hacia: mov.to, san: mov.san }],
    estado: juego.isGameOver() ? "terminada" : partida.estado,
    resultado,
    motivo,
    reloj_blancas: r.w,
    reloj_negras: r.b,
    ultimo_tick: new Date(ahora).toISOString(),
    optimista: true,
  };
}

// Jugada que llega al instante desde el navegador del rival.
function aplicarRemota(datos) {
  if (!partida || partida.optimista || datos.version !== partida.version) return;
  const nueva = aplicarLocal(datos.desde, datos.hacia, datos.promocion);
  if (!nueva) return;
  partida = nueva;
  elegida = null;
  movimientos = [];
  dibujar();
}

async function mover(desde, hacia, promocion) {
  const previa = partida;
  const nueva = aplicarLocal(desde, hacia, promocion);
  if (!nueva) return;
  partida = nueva;
  elegida = null;
  movimientos = [];
  enviando = true;
  dibujar();

  if (canal) canal.send({ type: "broadcast", event: "jugada", payload: { version: previa.version, desde, hacia, promocion } });

  const { data, error } = await sb.functions.invoke("jugada", {
    body: { partida: previa.id, desde, hacia, promocion },
  });
  enviando = false;
  if (error) {
    let mensaje = "No se pudo enviar la jugada.";
    try {
      const cuerpo = await error.context.json();
      if (cuerpo?.error) mensaje = cuerpo.error;
    } catch { /* sin detalle */ }
    avisar(mensaje);
    partida = (await recargar(previa.id)) || previa;
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
    mostrar("acceso");
    return avisar("Falta llenar config.js con los datos de Supabase.");
  }
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data } = await sb.auth.getSession();
  const usuario = data.session?.user;
  if (usuario && !usuario.is_anonymous) return entrar(usuario);
  if (usuario) await sb.auth.signOut();
  mostrar("acceso");
}

window.addEventListener("popstate", () => {
  if (!yo) return;
  const id = idDeLaUrl();
  if (id) abrirPartida(id);
  else mostrar("inicio");
});

arrancar();
