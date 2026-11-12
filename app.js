import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { Chess } from "https://esm.sh/chess.js@1.4.0";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { piezaSVG, iconoSVG } from "./piezas.js";
import { TABLEROS, PIEZAS, DEFS_3D, pieza as dibujoPieza } from "./estilos.js";
import { APERTURAS, LECCIONES, TEMAS, CONTEXTO } from "./lecciones.js";

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
const fotos = {};       // id -> foto de perfil (si la subió)

// ---------- Utilidades ----------
function avisar(texto) {
  const el = $("aviso");
  el.textContent = texto;
  el.classList.remove("oculto");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.add("oculto"), 4500);
}

// ---------- Recordar sesión y usuario en este dispositivo ----------
const LS = (() => { try { const k = "__p"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return localStorage; } catch { return null; } })();
const SS = (() => { try { return sessionStorage; } catch { return null; } })();
const recordarSesion = () => (LS ? LS.getItem("ajedrez-recordar") !== "no" : false);
// La sesión vive en localStorage si eligió "Recordarme"; si no, solo mientras la pestaña esté abierta
const almacenSesion = {
  getItem: (k) => (recordarSesion() ? LS : SS)?.getItem(k) ?? null,
  setItem: (k, v) => (recordarSesion() ? LS : SS)?.setItem(k, v),
  removeItem: (k) => { LS?.removeItem(k); SS?.removeItem(k); },
};
const recordado = () => { try { return JSON.parse(LS?.getItem("ajedrez-usuario") || "null"); } catch { return null; } };
function guardarRecordado(correo, nombre) {
  if (!LS) return;
  if (recordarSesion()) LS.setItem("ajedrez-usuario", JSON.stringify({ correo, nombre }));
  else LS.removeItem("ajedrez-usuario");
}
// Botón con ruedita mientras espera, para evitar doble clic
async function conCarga(boton, tarea) {
  if (!boton || boton.classList.contains("cargando")) return;
  boton.classList.add("cargando");
  boton.disabled = true;
  try { return await tarea(); } finally { boton.classList.remove("cargando"); boton.disabled = false; }
}

// Llegó desde el enlace del correo de confirmación (se lee antes de que Supabase limpie la URL)
const vieneDeRecuperar = /type=recovery/.test(location.hash);
const enlaceCaducado = /error_code=otp_expired|error=access_denied/.test(location.hash);
const vieneDeConfirmar = !vieneDeRecuperar && (/type=(signup|email|invite)/.test(location.hash) || new URLSearchParams(location.search).has("code"));
// Teléfonos y tabletas: pantalla táctil sin mouse
const esMovil = matchMedia("(hover: none) and (pointer: coarse)").matches;

function mostrar(vista) {
  if (vista !== "partida") document.body.classList.remove("sin-reloj", "vs-maquina", "plan-aparte");
  $("ir-inicio")?.classList.toggle("oculto", vista !== "partida");
  if (vista === "acceso" && typeof prepararAcceso === "function") prepararAcceso();
  for (const v of ["acceso", "inicio", "partida"]) $(v).classList.toggle("oculto", v !== vista);
  if (vista !== "partida" && document.body.classList.contains("enfoque")) ponerEnfoque(false);
  if (vista === "inicio") {
    cerrarVideo();
    if (canal) { sb.removeChannel(canal); canal = null; }
    partida = null;
    cargarClub();
  }
  presenciaEstado(vista === "partida" ? "partida" : "club");
}

// Foto de perfil si existe; si no, el ícono de Rey o Dama
const cara = (id, respaldo) => fotos[id]
  ? `<img src="${String(fotos[id]).replace(/"/g, "%22")}" alt="" loading="lazy">`
  : iconoSVG(respaldo || avatares[id] || "rey");
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
  const { data } = await sb.from("perfiles").select("id, nombre, avatar, foto_url").in("id", faltan);
  (data || []).forEach((p) => { nombres[p.id] = p.nombre; avatares[p.id] = p.avatar; if (p.foto_url) fotos[p.id] = p.foto_url; else delete fotos[p.id]; });
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

$("form-entrar").addEventListener("submit", (e) => {
  e.preventDefault();
  const boton = e.target.querySelector("button[type=submit]");
  conCarga(boton, async () => {
    const correo = $("e-correo").value.trim();
    LS?.setItem("ajedrez-recordar", $("recordarme").checked ? "si" : "no");
    $("entrar-ayuda").classList.add("oculto");
    const { data, error } = await sb.auth.signInWithPassword({ email: correo, password: $("e-clave").value });
    if (error) {
      if (/not confirmed/i.test(error.message)) {
        mostrarAyuda($("entrar-ayuda"), `Tu correo <strong>${esc(correo)}</strong> todavía no está confirmado. Abre el enlace que te mandamos (revisa spam).`, correo, true);
        return;
      }
      if (/rate|too many/i.test(error.message)) return avisar("Demasiados intentos. Espera un minuto y vuelve a probar.");
      $("e-clave").select();
      return avisar("Correo o contraseña incorrectos.");
    }
    // Le pide al navegador guardar la contraseña (en celular se rellena con Face ID o huella)
    try {
      if (window.PasswordCredential && $("recordarme").checked) {
        await navigator.credentials.store(new PasswordCredential({ id: correo, password: $("e-clave").value, name: data.user.user_metadata?.nombre || correo }));
      }
    } catch {}
    entrar(data.user);
  });
});

// Aviso con botón para reenviar el correo de confirmación
function mostrarAyuda(caja, html, correo, alerta) {
  caja.className = `listo${alerta ? " alerta" : ""}`;
  caja.innerHTML = `<span>${html}</span><button type="button" class="btn-fila fantasma" data-reenviar="${esc(correo)}">Reenviar correo de confirmación</button>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-reenviar]");
  if (!b) return;
  conCarga(b, async () => {
    const { error } = await sb.auth.resend({ type: "signup", email: b.dataset.reenviar, options: { emailRedirectTo: location.origin + "/" } });
    avisar(error ? (/rate|seconds/i.test(error.message) ? "Espera un minuto antes de pedir otro correo." : "No se pudo reenviar. Intenta más tarde.") : "Listo, te reenviamos el correo. Revisa también spam.");
  });
});

// Si ya entró antes en este dispositivo: correo listo y saludo
function prepararAcceso() {
  const r = recordado();
  $("recordarme").checked = recordarSesion();
  $("acceso").querySelector(".acceso-grid").classList.toggle("conocido", !!r);
  $("otra-cuenta").classList.toggle("oculto", !r);
  $("entrar-hola").classList.toggle("oculto", !r);
  if (r) {
    $("e-correo").value = r.correo || "";
    $("entrar-titulo").textContent = `¡Hola de nuevo${r.nombre ? `, ${r.nombre}` : ""}!`;
    $("entrar-hola").textContent = "Escribe tu contraseña o deja que tu navegador la rellene.";
    setTimeout(() => $("e-clave").focus(), 50);
  } else {
    $("entrar-titulo").textContent = "Ya soy del club";
  }
}
$("otra-cuenta").addEventListener("click", () => {
  LS?.removeItem("ajedrez-usuario");
  $("e-correo").value = "";
  $("e-clave").value = "";
  prepararAcceso();
  $("e-correo").focus();
});

// Aviso de Bloq Mayús activado en cualquier contraseña
document.addEventListener("keyup", (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "password" && !input.closest(".clave")) return;
  const caja = input.closest(".campo");
  if (!caja || typeof e.getModifierState !== "function") return;
  let nota = caja.querySelector(".nota.mayus");
  const activo = e.getModifierState("CapsLock");
  if (activo && !nota) { nota = document.createElement("span"); nota.className = "nota mayus"; nota.textContent = "Bloq Mayús está activado."; caja.appendChild(nota); }
  if (!activo && nota) nota.remove();
});

// Revisa si el nombre está libre mientras escribe
let tNombre = null;
$("r-nombre").addEventListener("input", () => {
  clearTimeout(tNombre);
  const nota = $("nota-nombre");
  const n = $("r-nombre").value.trim();
  nota.className = "nota"; nota.textContent = "";
  if (n.length < 2) return;
  tNombre = setTimeout(async () => {
    if (!sb) return;
    const { data } = await sb.rpc("nombre_disponible", { n });
    if ($("r-nombre").value.trim() !== n) return;
    nota.classList.add(data === false ? "mal" : "bien");
    nota.textContent = data === false ? "Ese nombre ya lo usa alguien del club." : "¡Disponible!";
  }, 400);
});

$("form-registro").addEventListener("submit", (e) => {
  e.preventDefault();
  conCarga(e.target.querySelector("button[type=submit]"), () => registrar(e));
});
async function registrar(e) {
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
    const correo = $("r-correo").value.trim();
    e.target.reset();
    revisarClaves();
    $("nota-nombre").textContent = "";
    $("e-correo").value = correo;
    LS?.setItem("ajedrez-usuario", JSON.stringify({ correo, nombre }));
    mostrarAyuda($("registro-listo"), `¡Listo, ${esc(nombre)}! Te mandamos un correo a <strong>${esc(correo)}</strong>. Ábrelo para confirmar tu cuenta y luego entra con tu contraseña.`, correo, false);
    $("registro-listo").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  entrar(data.user);
}

$("salir").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.href = "./";
});

async function entrar(usuario) {
  yo = usuario.id;
  await Promise.all([cargarNombres([yo]), calibrarReloj()]);
  nombres[yo] = nombres[yo] || usuario.user_metadata?.nombre || "Jugador";
  $("mi-nombre").textContent = nombres[yo];
  guardarRecordado(usuario.email, nombres[yo]);
  $("mi-icono").innerHTML = cara(yo, usuario.user_metadata?.avatar);
  $("cabecera-usuario").classList.remove("oculto");
  marcarConexion();
  setInterval(marcarConexion, 4 * 60000);
  cargarMiembros();
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
  LS?.setItem("ajedrez-minutos", String(minutosElegidos));
});
// Recuerda el último tiempo que eligió
(() => {
  const m = Number(LS?.getItem("ajedrez-minutos"));
  const btn = m && $("tiempos").querySelector(`button[data-min="${m}"]`);
  if (!btn) return;
  minutosElegidos = m;
  $("tiempos").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
})();

// Al regresar a la pestaña (o al volver el internet) se pone al día solo
async function ponerseAlDia() {
  if (!yo || !sb) return;
  if (partida?.local && !$("partida").classList.contains("oculto")) {
    if (!pensandoMaquina && !ocupadoEntrenador && await bajarMaquina()) abrirLocal(false);
    return;
  }
  if (partida && !$("partida").classList.contains("oculto")) {
    const fresca = await recargar(partida.id);
    if (fresca && fresca.version >= partida.version) { partida = fresca; dibujar(); }
  } else if (!$("inicio").classList.contains("oculto")) {
    cargarClub();
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) ponerseAlDia(); });
window.addEventListener("offline", () => avisar("Sin conexión a internet. Tu partida se sincroniza al volver."));
window.addEventListener("online", () => { avisar("Conexión recuperada."); ponerseAlDia(); });

// Crea una mesa (opcionalmente apartada para un rival) y, si ese rival está conectado, le llama
async function crearMesa(minutos, rival) {
  const { data, error } = await sb.rpc("crear_partida", rival ? { p_minutos: minutos, p_rival: rival } : { p_minutos: minutos });
  if (error) { avisar("No se pudo crear la partida. Intenta de nuevo."); return null; }
  await irAPartida(data);
  if (rival && enLinea[rival] && !enLinea[rival].jugando) llamar(rival);
  return data;
}
$("crear").addEventListener("click", () => {
  if ($("rival").value === MAQUINA) return abrirVsMaquina();
  crearMesa(minutosElegidos, $("rival").value || null);
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
const ficha = (id, extra = "") => `<span class="ficha ${extra}">${cara(id)}</span>`;

function hace(fecha) {
  const min = Math.max(0, Math.round((ahoraServidor() - new Date(fecha).getTime()) / 60000));
  if (min < 1) return "Abrió hace un momento";
  if (min < 60) return `Abrió hace ${min} min`;
  const h = Math.round(min / 60);
  return `Abrió hace ${h} ${h === 1 ? "hora" : "horas"}`;
}

function irAPartida(id) {
  history.pushState(null, "", `?p=${id}`);
  return abrirPartida(id);
}

async function cargarClub() {
  if (!yo) return;
  await bajarMaquina().catch(() => false);
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const hace7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const [salasR, vivoR, mesaR, claveR, mioR, recientesR, canceladasR] = await Promise.all([
    sb.from("partidas").select("id, blancas, minutos, creada, reservada_para").eq("estado", "esperando").gte("creada", desde).order("creada", { ascending: false }).limit(30),
    sb.from("partidas").select("id, blancas, negras, minutos, jugadas, actualizada, fen, reloj_blancas, reloj_negras, ultimo_tick, estado, pausa_por, pausa_motivo, pausa_desde, pausa_hasta, motivo").in("estado", ["jugando", "pausada"]).order("actualizada", { ascending: false }).limit(20),
    sb.rpc("mesa_del_club"),
    sb.rpc("clave_del_club"),
    sb.from("partidas").select("id, blancas, negras, resultado, motivo, minutos, actualizada").eq("estado", "terminada").not("negras", "is", null).not("resultado", "is", null).or(`blancas.eq.${yo},negras.eq.${yo}`).order("actualizada", { ascending: false }).limit(50),
    sb.from("partidas").select("id, blancas, negras, resultado, motivo, actualizada").eq("estado", "terminada").not("negras", "is", null).not("resultado", "is", null).order("actualizada", { ascending: false }).limit(6),
    sb.from("partidas").select("id, blancas, negras, minutos, actualizada, motivo, pausa_por, pausa_motivo, estado").eq("estado", "terminada").eq("motivo", "cancelada")
      .gte("actualizada", hace7).or(`blancas.eq.${yo},negras.eq.${yo}`).order("actualizada", { ascending: false }).limit(5),
  ]);
  // Las mesas apartadas solo las ven quien la creó y para quien se apartó
  const salas = (salasR.data || []).filter((x) => !x.reservada_para || x.reservada_para === yo || x.blancas === yo);
  // Fuera las que ya se quedaron sin tiempo aunque nadie lo haya reclamado
  const vivo = (vivoR.data || []).filter((x) => {
    if (x.estado === "pausada") return true;
    if (!x.ultimo_tick) return false;
    const resta = (x.fen.split(" ")[1] === "w" ? x.reloj_blancas : x.reloj_negras) - (ahoraServidor() - new Date(x.ultimo_tick).getTime());
    return resta > 0;
  });
  const mesa = mesaR.data || [];
  mesa.forEach((m) => { nombres[m.id] = m.nombre; avatares[m.id] = m.avatar; });
  pintarRivales(mesa);
  cargarMiembros();
  const recientes = recientesR.data || [];
  await cargarNombres([...salasR.data || [], ...vivo, ...recientes, ...(canceladasR.data || [])].flatMap((x) => [x.blancas, x.negras]));
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
  pintarResultados(recientes.slice(0, 3));
  pintarMisPartidas(vivo.filter((x) => x.blancas === yo || x.negras === yo), canceladasR.data || []);
  pintarClave(claveR.data);
  pintarUltimo((mioR.data || [])[0]);
}

const CORONA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="#2A1C0C"/></svg>';
const MANOS = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#FFF4EC" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/><path d="M5 8h14" opacity="0.5"/><path d="M5 16h14" opacity="0.5"/></svg>';
const COPA = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="#2A1C0C"><path d="M7 3h10v3h3a3 3 0 0 1-3 4.6A5 5 0 0 1 13 14v3h3v3H8v-3h3v-3a5 5 0 0 1-4-3.4A3 3 0 0 1 4 6h3zm-1 5a1 1 0 0 0 1 .9V6H6zm11 .9a1 1 0 0 0 1-.9V6h-1z"/></svg>';
const porQue = (m) => ({ "jaque mate": "por jaque mate", tiempo: "por tiempo", abandono: "por abandono", tablas: "en tablas", acuerdo: "de común acuerdo" })[m] || "";

function hacePoco(fecha) {
  const min = Math.max(0, Math.round((ahoraServidor() - new Date(fecha).getTime()) / 60000));
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} ${h === 1 ? "hora" : "horas"}`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
}

function pintarResultados(lista) {
  if (!lista.length) {
    $("resultados").innerHTML = '<p class="vacio-club">Aquí aparecerán las victorias del club.</p>';
    return;
  }
  $("resultados").innerHTML = lista.map((x) => {
    const n = (id) => esc(id === yo ? "Tú" : nombres[id] || "Jugador");
    if (x.resultado === "½-½") {
      return `<div class="resultado"><span class="corona tablas">${MANOS}</span><div><strong>${n(x.blancas)} y ${n(x.negras)} hicieron tablas</strong><small>${hacePoco(x.actualizada)}</small></div></div>`;
    }
    const g = x.resultado === "1-0" ? x.blancas : x.negras;
    const p = x.resultado === "1-0" ? x.negras : x.blancas;
    const frase = g === yo ? `<b>Tú</b> le ganaste a ${n(p)}` : p === yo ? `<b>${n(g)}</b> te ganó` : `<b>${n(g)}</b> le ganó a ${n(p)}`;
    return `<div class="resultado"><span class="corona">${CORONA}</span><div><strong>${frase}</strong><small>${porQue(x.motivo)} · ${hacePoco(x.actualizada)}</small></div></div>`;
  }).join("");
}

function pintarUltimo(x) {
  const caja = $("ultimo");
  const reciente = x && ahoraServidor() - new Date(x.actualizada).getTime() < 6 * 3600 * 1000;
  if (!reciente || x.resultado === "½-½") return caja.classList.add("oculto");
  const yoBlancas = x.blancas === yo;
  const gane = (yoBlancas && x.resultado === "1-0") || (!yoBlancas && x.resultado === "0-1");
  const rival = esc(nombres[yoBlancas ? x.negras : x.blancas] || "tu rival");
  caja.classList.toggle("perdi", !gane);
  caja.innerHTML = gane
    ? `<span class="sello-copa">${COPA}</span><span><strong>Ganaste a ${rival}</strong> <span class="gris">${porQue(x.motivo)}, ${hacePoco(x.actualizada)}</span></span>`
    : `<span class="sello-copa">${CORONA.replace("#2A1C0C", "#F3EADA")}</span><span><strong>${rival} te ganó</strong> <span class="gris">${porQue(x.motivo)}</span></span>` +
      `<button class="btn-fila dorado" data-revancha="${x.minutos || 10}" data-rival="${yoBlancas ? x.negras : x.blancas}">Revancha</button>`;
  caja.classList.remove("oculto");
}

function pintarSalas(salas) {
  if (!salas.length) {
    $("salas").innerHTML = '<p class="vacio-club">Nadie espera rival. Crea una partida arriba.</p>';
    return;
  }
  $("salas").innerHTML = salas.map((x) => {
    const mia = x.blancas === yo;
    const botones = mia
      ? `<button class="btn-fila fantasma" data-abrir="${x.id}">Abrir</button><button class="btn-fila fantasma" data-cancelar="${x.id}" aria-label="Cerrar tu sala">Cerrar</button>`
      : `<button class="btn-fila dorado" data-unirse="${x.id}">Unirse</button>`;
    const titulo = mia
      ? (x.reservada_para ? `Tu sala para ${nombres[x.reservada_para] || "tu rival"}` : "Tu sala")
      : (nombres[x.blancas] || "Jugador");
    const sub = !mia && x.reservada_para === yo ? '<span class="etiqueta-apartada">Te apartó esta mesa</span>' : hace(x.creada);
    return `<div class="fila">${ficha(x.blancas)}<div><strong>${esc(titulo)}</strong><small>${sub}</small></div>` +
      `<span class="reloj-chip">${ICONO_RELOJ}${textoTiempo(x.minutos)}</span>${botones}</div>`;
  }).join("");
}

function pintarVivo(vivo) {
  if (!vivo.length) {
    $("en-vivo").innerHTML = '<p class="vacio-club">Nadie está jugando ahorita.</p>';
    return;
  }
  $("en-vivo").innerHTML = vivo.map((x) => {
    const mia = x.blancas === yo || x.negras === yo;
    const n = Math.ceil((x.jugadas?.length || 0) / 2);
    const meta = x.estado === "pausada"
      ? `<span class="estado-chip pausada">PAUSA</span> ${esc(x.pausa_motivo || "")}`
      : `${textoTiempo(x.minutos)}, ${n ? `jugada ${n}` : "recién empieza"}`;
    const nb = x.blancas === yo ? "Tú" : nombres[x.blancas] || "Jugador";
    const nn = x.negras === yo ? "Tú" : nombres[x.negras] || "Jugador";
    return `<div class="fila"><span class="parejas">${ficha(x.blancas, "clara")}${ficha(x.negras, "oscura")}</span>` +
      `<div><strong>${esc(nb)} vs ${esc(nn)}</strong><small>${meta}</small></div>` +
      (mia ? `<button class="btn-fila dorado" data-abrir="${x.id}">Volver</button>`
           : `<button class="btn-fila fantasma" data-abrir="${x.id}">${ICONO_OJO}Mirar</button>`) + `</div>`;
  }).join("");
}

function pintarCuentaMesas() {
  const e = ultimasSalas.filter((x) => x.blancas !== yo).length;
  const v = ultimasVivo.length;
  $("cuenta-mesas").textContent = `${e} esperando rival, ${v} en vivo`;
}

let mesaCompleta = false;
let ultimaMesa = [];
$("ver-tabla").addEventListener("click", () => { mesaCompleta = !mesaCompleta; pintarMesa(ultimaMesa); });
function pintarMesa(mesa) {
  ultimaMesa = mesa;
  const todas = mesa.filter((m) => m.pj > 0 || m.id === yo);
  $("ver-tabla").classList.toggle("oculto", todas.length <= 5);
  $("ver-tabla").textContent = mesaCompleta ? "Ver solo el top 5" : "Ver tabla completa";
  const filas = todas;
  if (!filas.length) {
    $("mesa").innerHTML = '<p class="vacio-club">Todavía no se termina ninguna partida. La primera victoria abre la tabla.</p>';
    return;
  }
  let pos = 0, previo = null;
  const conPos = filas.map((m, i) => {
    if (m.pts !== previo) { pos = i + 1; previo = m.pts; }
    return { ...m, pos };
  });
  const visibles = mesaCompleta ? conPos : conPos.filter((m, i) => i < 5 || m.id === yo);
  $("mesa").innerHTML = visibles.map((m) => {
    const yoSoy = m.id === yo;
    return `<div class="mesa-fila${yoSoy ? " yo" : ""}">
      <span class="pos">${m.pos}</span>
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
  if (ultimasVivo.some((x) => x.estado !== "pausada" && (x.blancas === id || x.negras === id))) return "Jugando";
  if (ultimasVivo.some((x) => x.estado === "pausada" && (x.blancas === id || x.negras === id))) return "Con una partida en pausa";
  if (ultimasSalas.some((x) => x.blancas === id)) return "Esperando rival";
  return "En el club";
}

function pintarEnLinea() {
  const conectados = Object.keys(enLinea).sort((a, b) => (a === yo ? -1 : b === yo ? 1 : (enLinea[a].jugando - enLinea[b].jugando) || (enLinea[a].nombre || "").localeCompare(enLinea[b].nombre || "")));
  const fuera = desconectados();
  const total = Math.max(miembros.length, conectados.length + fuera.length);
  $("cuenta-linea").textContent = `${conectados.length} de ${total} ${total === 1 ? "conectado" : "conectados"}`;
  const filasOn = conectados.map((id) => {
    const u = enLinea[id];
    const lado = id === yo ? "" : u.jugando
      ? '<span class="ocupado">Ocupado</span>'
      : `<button class="btn-fila verde" data-retar="${id}" aria-label="Invitar a ${esc(u.nombre)} a jugar">${ICONO_TEL}Jugar</button>`;
    return `<div class="fila">${ficha(id, "punto-verde")}<div><strong>${esc(id === yo ? `${u.nombre} (tú)` : u.nombre)}</strong><small>${u.jugando ? "Jugando" : estadoDe(id)}</small></div>${lado}</div>`;
  });
  const soloYo = conectados.length <= 1;
  $("en-linea").innerHTML =
    `<h3 class="subtitulo"><span class="punto verde"></span>Conectados (${conectados.length})</h3>` + filaMaquina("fila") +
    (filasOn.join("") || "") +
    (soloYo ? '<p class="vacio-club">Nadie más está conectado ahorita.</p>' : "") +
    (fuera.length ? `<h3 class="subtitulo separado"><span class="punto gris"></span>Desconectados (${fuera.length})</h3>` +
      fuera.map((m) => `<div class="fila apagada">${ficha(m.id)}<div><strong>${esc(m.nombre)}</strong><small>${vistoHace(m.ultima_vez)}</small></div>` +
        `<button class="btn-fila fantasma" data-retar="${m.id}" aria-label="Apartarle una mesa a ${esc(m.nombre)}">Apartar mesa</button></div>`).join("") : "");
}

function pintarResumen() {
  const esperando = [...new Set(ultimasSalas.filter((x) => x.blancas !== yo).map((x) => nombres[x.blancas] || "Alguien"))];
  const vivos = ultimasVivo.length;
  let a;
  if (!esperando.length) a = "Nadie está esperando rival.";
  else if (esperando.length === 1) a = `${esperando[0]} está esperando rival.`;
  else if (esperando.length === 2) a = `${esperando[0]} y ${esperando[1]} están esperando rival.`;
  else a = `${esperando.length} jugadores están esperando rival.`;
  const b = vivos === 0 ? " Crea una partida o llama a alguien conectado." : vivos === 1 ? " Hay una partida en vivo por si quieres mirar." : ` Hay ${vivos} partidas en vivo por si quieres mirar.`;
  $("resumen").textContent = a + b;
  pintarCuentaMesas();
}

$("inicio").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.maquina) return abrirVsMaquina();
  if (b.dataset.abrir) return irAPartida(b.dataset.abrir);
  if (b.dataset.retar) {
    b.disabled = true;
    const ok = await crearMesa(minutosElegidos, b.dataset.retar);
    if (!ok) b.disabled = false;
    return;
  }
  if (b.dataset.revancha) {
    return crearMesa(Number(b.dataset.revancha), b.dataset.rival || null);
  }
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
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "mensajes_privados", filter: `para=eq.${yo}` }, ({ new: m }) => recibirPrivado(m))
    .on("broadcast", { event: "llamada" }, ({ payload }) => recibirLlamada(payload))
    .on("broadcast", { event: "respuesta" }, ({ payload }) => recibirRespuesta(payload))
    .on("broadcast", { event: "colgar" }, ({ payload }) => { if (llamadaEntrante && llamadaEntrante.id === payload.id) cerrarLlamada(); })
    .on("presence", { event: "sync" }, () => {
      const estado = canalClub.presenceState();
      enLinea = {};
      for (const [id, metas] of Object.entries(estado)) {
        const m = metas[0] || {};
        enLinea[id] = { nombre: m.nombre || nombres[id] || "Jugador", jugando: metas.some((x) => x.jugando) };
        if (m.avatar) avatares[id] = m.avatar;
      }
      if (!$("inicio").classList.contains("oculto")) { pintarEnLinea(); pintarRivales(ultimaMesa); }
      if (partida && partida.estado === "esperando" && miColor() === "w") pintarLlamables();
      if (!$("partida").classList.contains("oculto")) pintarLineaPartida();
    })
    .subscribe((estado) => {
      if (estado === "SUBSCRIBED") presenciaEstado("club");
    });
}

let presenciaDonde = "club";
let presenciaJugando = null;
function presenciaEstado(donde) {
  presenciaDonde = donde;
  if (!canalClub || !yo) return;
  presenciaJugando = estoyJugando();
  canalClub.track({ nombre: nombres[yo] || "Jugador", avatar: avatares[yo] || "rey", donde, jugando: presenciaJugando }).catch(() => {});
}
const estoyJugando = () => !!(partida && !partida.local && partida.estado === "jugando" && miColor());
function actualizarPresencia() {
  if (estoyJugando() !== presenciaJugando) presenciaEstado(presenciaDonde);
}
setInterval(() => { if (yo && !$("inicio").classList.contains("oculto")) { pintarSalas(ultimasSalas); } }, 60000);

// ---------- Miembros del club y última conexión ----------
let miembros = [];
async function cargarMiembros() {
  const { data } = await sb.from("perfiles").select("id, nombre, avatar, ultima_vez, foto_url").order("nombre");
  miembros = data || [];
  miembros.forEach((m) => { nombres[m.id] = m.nombre; avatares[m.id] = m.avatar; if (m.foto_url) fotos[m.id] = m.foto_url; else delete fotos[m.id]; });
  if (!$("inicio").classList.contains("oculto")) pintarEnLinea();
  if (partida && partida.estado === "esperando" && miColor() === "w") pintarLlamables();
}
function desconectados() {
  return miembros.filter((m) => m.id !== yo && !enLinea[m.id])
    .sort((a, b) => new Date(b.ultima_vez || 0) - new Date(a.ultima_vez || 0));
}
function vistoHace(fecha) {
  if (!fecha) return "Sin conexión reciente";
  const min = Math.max(0, Math.round((ahoraServidor() - new Date(fecha).getTime()) / 60000));
  if (min < 5) return "Se fue hace un momento";
  if (min < 60) return `Visto hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Visto hace ${h} ${h === 1 ? "hora" : "horas"}`;
  const d = Math.round(h / 24);
  return d === 1 ? "Visto ayer" : `Visto hace ${d} días`;
}
function marcarConexion() { sb.rpc("marcar_conexion").then(() => {}, () => {}); }

// ---------- Elegir rival ----------
function pintarRivales(mesa) {
  const sel = $("rival");
  const antes = sel.value;
  const otros = mesa.filter((m) => m.id !== yo).sort((a, b) => a.nombre.localeCompare(b.nombre));
  sel.innerHTML = '<option value="">Cualquiera del club</option><option value="maquina">🤖 Máquina (práctica)</option>' +
    otros.map((m) => `<option value="${m.id}">${esc(m.nombre)}${enLinea[m.id] ? " · conectado" : ""}</option>`).join("");
  if (antes === MAQUINA || otros.some((m) => m.id === antes)) sel.value = antes;
}

// ---------- Mis partidas: en juego, en pausa y canceladas ----------
function pintarMisPartidas(activas, canceladas) {
  const jug = activas.filter((x) => x.estado === "jugando");
  const pau = activas.filter((x) => x.estado === "pausada");
  const partes = [];
  if (jug.length) partes.push(`${jug.length} playing`);
  if (pau.length) partes.push(`${pau.length} en pausa`);
  if (canceladas.length) partes.push(`${canceladas.length} ${canceladas.length === 1 ? "cancelada" : "canceladas"}`);
  $("cuenta-mias").textContent = partes.join(" · ");
  const vs = (x) => esc(nombres[x.blancas === yo ? x.negras : x.blancas] || "Jugador");
  const rival = (x) => (x.blancas === yo ? x.negras : x.blancas);
  const filas = [
    ...jug.map((x) => `<div class="fila">${ficha(rival(x), "chica")}<div><strong>vs ${vs(x)}</strong><small>${textoTiempo(x.minutos)} · ${Math.ceil((x.jugadas?.length || 0) / 2) ? `jugada ${Math.ceil((x.jugadas?.length || 0) / 2)}` : "recién empieza"}</small></div><span class="estado-chip jugando">PLAYING</span><button class="btn-fila dorado" data-abrir="${x.id}">Abrir</button></div>`),
    ...pau.map((x) => {
      const quien = x.pausa_por === yo ? "Tú" : (nombres[x.pausa_por] || "Rival");
      return `<div class="fila">${ficha(rival(x), "chica")}<div><strong>vs ${vs(x)}</strong><small>${esc(quien)}: ${esc(x.pausa_motivo || "En pausa")}</small></div><span class="estado-chip pausada">PAUSA</span><button class="btn-fila fantasma" data-abrir="${x.id}">Abrir</button></div>`;
    }),
    ...canceladas.map((x) => {
      const quien = x.pausa_por === yo ? "Cancelaste" : `Canceló ${nombres[x.pausa_por] || "tu rival"}`;
      return `<div class="fila apagada">${ficha(rival(x), "chica")}<div><strong>vs ${vs(x)}</strong><small>${esc(quien)}${x.pausa_motivo && x.pausa_motivo !== "Cancelada" ? `: ${esc(x.pausa_motivo)}` : ""} · ${hacePoco(x.actualizada)}</small></div><span class="estado-chip cancelada">CANCELADA</span></div>`;
    }),
  ];
  const local = partidaLocalGuardada();
  if (local && local.estado === "jugando") {
    filas.unshift(`<div class="fila maquina">${ficha(MAQUINA, "chica robot")}<div><strong>vs Máquina</strong><small>Nivel ${NIVELES[local.nivel]?.nombre || ""} · práctica</small></div><span class="estado-chip jugando">PLAYING</span><button class="btn-fila dorado" data-abrir="${MAQUINA}">Abrir</button></div>`);
  }
  $("mis-partidas").innerHTML = filas.join("") || '<p class="vacio-club">No tienes partidas en curso, en pausa ni canceladas recientes.</p>';
}

// ---------- Invitar al club ----------
let claveClub = null;
function pintarClave(clave) {
  claveClub = clave || null;
  $("invita-clave").classList.toggle("oculto", !claveClub);
  $("clave-club").textContent = claveClub || "";
}
function textoInvitacion() {
  return `¡Te invito a jugar ajedrez conmigo en línea! Entra a https://ajedrezentreamigos.mx` +
    (claveClub ? ` y regístrate con la clave del club: ${claveClub}` : " y pídeme la clave del club para registrarte.");
}
async function copiarInvitacion() {
  try {
    await navigator.clipboard.writeText(textoInvitacion());
    avisar("Invitación copiada. Pégala en WhatsApp o donde quieras.");
  } catch {
    avisar(textoInvitacion());
  }
}
$("copiar-invitacion").addEventListener("click", copiarInvitacion);
$("compartir").addEventListener("click", async () => {
  if (navigator.share) {
    try { return await navigator.share({ title: "Ajedrez entre Amigos", text: textoInvitacion() }); }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  copiarInvitacion();
});

// ---------- Llamar a jugar (sin copiar links) ----------
const ICONO_TEL = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';
const ESPERA_LLAMADA = 30000;
const llamando = {};          // para -> { id, partida, timer }
let llamadaEntrante = null;   // { id, de, nombre, partida, minutos }
let cuentaLlamada = null;

function enviar(evento, payload) {
  if (!canalClub) return;
  canalClub.send({ type: "broadcast", event: evento, payload }).catch?.(() => {});
}

function pintarLlamables() {
  const apartada = partida && partida.reservada_para;
  const otros = Object.keys(enLinea).filter((id) => id !== yo && (!apartada || id === apartada));
  otros.sort((a, b) => (enLinea[a].jugando - enLinea[b].jugando) || enLinea[a].nombre.localeCompare(enLinea[b].nombre));
  const fuera = desconectados().filter((m) => !apartada || m.id === apartada);
  const filasOn = otros.map((id) => {
    const u = enLinea[id];
    const sonando = !!llamando[id];
    const boton = u.jugando
      ? `<span class="ocupado">Ocupado</span>`
      : sonando
        ? `<button class="llamar-btn sonando" data-colgar="${id}" aria-label="Cancelar llamada">${ICONO_TEL}Llamando…</button>`
        : `<button class="llamar-btn" data-llamar="${id}">${ICONO_TEL}Llamar</button>`;
    return `<div class="llamable">${ficha(id, "punto-verde")}<div><strong>${esc(u.nombre)}</strong><small>${u.jugando ? "En otra partida" : sonando ? "Sonando…" : "Conectado"}</small></div>${boton}</div>`;
  });
  const filasOff = fuera.map((m) =>
    `<div class="llamable apagada">${ficha(m.id)}<div><strong>${esc(m.nombre)}</strong><small>${vistoHace(m.ultima_vez)}</small></div><span class="desconectado">Desconectado</span></div>`);
  $("llamables").innerHTML =
    `<h3 class="subtitulo"><span class="punto verde"></span>Conectados (${otros.length})</h3>` +
    (filasOn.join("") || `<p class="vacio">${apartada ? `${esc(nombres[apartada] || "Tu rival")} todavía no se conecta; cuando entre, verá tu mesa en su inicio.` : "Nadie más está conectado ahorita. Usa el link de abajo."}</p>`) +
    (filasOff.length ? `<h3 class="subtitulo separado"><span class="punto gris"></span>Desconectados (${filasOff.length})</h3>${filasOff.join("")}` : "");
}

$("llamables").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.llamar) llamar(b.dataset.llamar);
  if (b.dataset.colgar) colgar(b.dataset.colgar, true);
});

function llamar(para) {
  if (!partida || partida.estado !== "esperando" || miColor() !== "w" || llamando[para]) return;
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  enviar("llamada", { id, de: yo, para, nombre: nombres[yo] || "Jugador", avatar: avatares[yo] || "rey", foto: fotos[yo] || null, partida: partida.id, minutos: partida.minutos || 10 });
  timbreRepetido("llamando");
  llamando[para] = {
    id,
    timer: setTimeout(() => {
      colgar(para, false);
      avisar(`${enLinea[para]?.nombre || "Tu amigo"} no contestó. Prueba de nuevo o mándale el link.`);
    }, ESPERA_LLAMADA),
  };
  pintarLlamables();
}

function colgar(para) {
  const l = llamando[para];
  if (!l) return;
  if (Object.keys(llamando).length <= 1 && !llamadaEntrante) callar();
  clearTimeout(l.timer);
  delete llamando[para];
  enviar("colgar", { id: l.id });
  if (partida && partida.estado === "esperando") pintarLlamables();
}
function colgarTodas() { Object.keys(llamando).forEach((p) => colgar(p, true)); }

function recibirRespuesta(r) {
  if (r.para !== yo) return;
  const l = llamando[r.de];
  if (!l || l.id !== r.id) return;
  clearTimeout(l.timer);
  delete llamando[r.de];
  if (!Object.keys(llamando).length) callar();
  sonido(r.respuesta === "si" ? "aceptada" : "rechazada");
  const n = enLinea[r.de]?.nombre || nombres[r.de] || "Tu amigo";
  if (r.respuesta === "si") avisar(`¡${n} aceptó! Ya viene a la mesa.`);
  else if (r.respuesta === "ocupado") avisar(`${n} está en otra partida. Inténtalo al rato.`);
  else avisar(`${n} no puede ahora.`);
  if (partida && partida.estado === "esperando") pintarLlamables();
}

function responder(respuesta) {
  if (!llamadaEntrante) return;
  enviar("respuesta", { id: llamadaEntrante.id, de: yo, para: llamadaEntrante.de, respuesta });
}

function recibirLlamada(l) {
  if (l.para !== yo) return;
  if (estoyJugando() || llamadaEntrante) {
    return enviar("respuesta", { id: l.id, de: yo, para: l.de, respuesta: "ocupado" });
  }
  llamadaEntrante = l;
  if (l.avatar) avatares[l.de] = l.avatar;
  nombres[l.de] = nombres[l.de] || l.nombre;
  if (l.foto && /^https:\/\/[^"']+\/storage\/v1\/object\/public\/fotos\//.test(l.foto)) fotos[l.de] = l.foto;
  $("llamada-ficha").innerHTML = cara(l.de, l.avatar);
  $("llamada-titulo").textContent = `${l.nombre} te invita a jugar`;
  $("llamada-texto").textContent = `Partida de ${textoTiempo(l.minutos)}. Tú llevas las negras.`;
  $("llamada").classList.remove("oculto");
  $("llamada-si").focus({ preventScroll: true });
  let quedan = ESPERA_LLAMADA / 1000;
  $("llamada-cuenta").textContent = `Se cuelga sola en ${quedan} s`;
  clearInterval(cuentaLlamada);
  cuentaLlamada = setInterval(() => {
    quedan--;
    $("llamada-cuenta").textContent = `Se cuelga sola en ${quedan} s`;
    if (quedan <= 0) { responder("no"); cerrarLlamada(); }
  }, 1000);
  sonar();
  if (document.hidden) {
    document.title = `📞 ${l.nombre} te invita a jugar`;
    avisoSistema(`📞 ${l.nombre} te invita a jugar`, `Partida de ${textoTiempo(l.minutos)}. Toca para contestar.`);
  }
}

function cerrarLlamada() {
  llamadaEntrante = null;
  clearInterval(cuentaLlamada);
  callar();
  $("llamada").classList.add("oculto");
  document.title = "Ajedrez entre Amigos";
}

$("llamada-no").addEventListener("click", () => { responder("no"); cerrarLlamada(); });
$("llamada-si").addEventListener("click", async () => {
  const l = llamadaEntrante;
  if (!l) return;
  $("llamada-si").disabled = true;
  const { error } = await sb.rpc("unirse_partida", { p: l.partida });
  $("llamada-si").disabled = false;
  if (error) {
    cerrarLlamada();
    return avisar("Esa mesa ya no está disponible.");
  }
  responder("si");
  cerrarLlamada();
  irAPartida(l.partida);
});

window.addEventListener("beforeunload", colgarTodas);

// ---------- Sonidos del club (hechos con el navegador, sin archivos) ----------
const AUDIO = { ctx: null, master: null, volumen: 0.6, mudo: false };
try {
  const g = JSON.parse(localStorage.getItem("ajedrez-sonido") || "null");
  if (g) { AUDIO.volumen = Math.min(1, Math.max(0, Number(g.volumen) || 0)); AUDIO.mudo = !!g.mudo; }
} catch {}
function audio() {
  if (!AUDIO.ctx) {
    try {
      AUDIO.ctx = new (window.AudioContext || window.webkitAudioContext)();
      AUDIO.master = AUDIO.ctx.createGain();
      AUDIO.master.connect(AUDIO.ctx.destination);
      aplicarVolumen();
    } catch { return null; }
  }
  if (AUDIO.ctx.state === "suspended") AUDIO.ctx.resume().catch(() => {});
  return AUDIO.ctx;
}
function aplicarVolumen() {
  if (AUDIO.master) AUDIO.master.gain.setTargetAtTime(AUDIO.mudo ? 0 : AUDIO.volumen * AUDIO.volumen, AUDIO.ctx.currentTime, 0.02);
  try { localStorage.setItem("ajedrez-sonido", JSON.stringify({ volumen: AUDIO.volumen, mudo: AUDIO.mudo })); } catch {}
  pintarBocina();
}
// Los navegadores (sobre todo en celular) solo dejan sonar después de tocar la página.
// En cada toque reactivamos el audio por si el teléfono lo suspendió al bloquear la pantalla.
let audioDesbloqueado = false;
function desbloquearAudio() {
  const ctx = audio();
  if (!ctx) return;
  // iPhone: que los sonidos se escuchen aunque el switch de silencio esté puesto
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
  if (!audioDesbloqueado) {
    audioDesbloqueado = true;
    try {
      // Un sonido mudo de un instante "abre" el audio en Safari de iPhone
      const b = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
      src.buffer = b; src.connect(ctx.destination); src.start(0);
      const silencio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=");
      silencio.setAttribute("playsinline", ""); silencio.play().catch(() => {});
    } catch {}
  }
}
["pointerdown", "touchend", "keydown", "click"].forEach((ev) => document.addEventListener(ev, desbloquearAudio, { capture: true, passive: true }));
document.addEventListener("visibilitychange", () => { if (!document.hidden && AUDIO.ctx?.state === "suspended") AUDIO.ctx.resume().catch(() => {}); });

// Una nota suave: frecuencia, inicio, duración, volumen, forma de onda
function nota(f, inicio = 0, dur = 0.16, vol = 0.5, tipo = "sine") {
  const ctx = audio();
  if (!ctx || AUDIO.mudo) return;
  const t = ctx.currentTime + inicio, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = tipo; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol * 0.25, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(AUDIO.master);
  o.start(t); o.stop(t + dur + 0.02);
}
const SONIDOS = {
  turno:     () => nota(660, 0, 0.14, 0.45, "triangle"),
  mensaje:   () => { nota(880, 0, 0.09, 0.35); nota(1175, 0.08, 0.12, 0.3); },
  pausa:     () => { nota(784, 0, 0.18, 0.45); nota(587, 0.16, 0.26, 0.4); },
  reanudar:  () => { nota(587, 0, 0.14, 0.45); nota(784, 0.12, 0.14, 0.45); nota(988, 0.24, 0.22, 0.4); },
  cancelada: () => { nota(392, 0, 0.22, 0.45, "triangle"); nota(262, 0.18, 0.34, 0.4, "triangle"); },
  tablas:    () => { nota(659, 0, 0.2, 0.4); nota(659, 0.22, 0.2, 0.35); },
  tiempo:    () => { nota(988, 0, 0.08, 0.4, "square"); nota(988, 0.16, 0.08, 0.35, "square"); },
  victoria:  () => [523, 659, 784, 1047].forEach((f, i) => nota(f, i * 0.11, i === 3 ? 0.5 : 0.16, 0.5, "triangle")),
  derrota:   () => [523, 440, 349].forEach((f, i) => nota(f, i * 0.16, i === 2 ? 0.45 : 0.18, 0.4, "triangle")),
  aceptada:  () => { nota(784, 0, 0.12, 0.45); nota(1047, 0.1, 0.22, 0.45); },
  rechazada: () => nota(330, 0, 0.3, 0.4, "triangle"),
  prueba:    () => { nota(659, 0, 0.14, 0.5); nota(880, 0.12, 0.2, 0.5); },
};
function sonido(nombre) { try { SONIDOS[nombre]?.(); } catch {} }

// Timbres que se repiten: entrante (como teléfono discreto) y llamando (tono de espera)
let timbre = null;
function timbreRepetido(tipo) {
  callar();
  const trino = (inicio) => [0, 0.06, 0.12, 0.18, 0.24, 0.30, 0.36, 0.42].forEach((d, i) => nota(i % 2 ? 1175 : 1480, inicio + d, 0.055, 0.42));
  const toque = tipo === "entrante"
    ? () => { trino(0); trino(0.6); try { navigator.vibrate?.([180, 80, 180]); } catch {} }
    : () => { nota(440, 0, 0.55, 0.3); nota(480, 0, 0.55, 0.22); };
  toque();
  timbre = setInterval(toque, tipo === "entrante" ? 1700 : 2000);
}
function sonar() { timbreRepetido("entrante"); }
function callar() { if (timbre) { clearInterval(timbre); timbre = null; } try { navigator.vibrate?.(0); } catch {} }
function tic() { sonido("turno"); }

// ---------- Bocina flotante: siempre visible ----------
function pintarBocina() {
  const b = $("bocina");
  if (!b) return;
  const apagada = AUDIO.mudo || AUDIO.volumen === 0;
  b.classList.toggle("apagada", apagada);
  b.setAttribute("aria-label", apagada ? "Sonidos apagados. Abrir controles de volumen" : "Sonidos encendidos. Abrir controles de volumen");
  $("bocina-ondas").style.display = apagada ? "none" : "";
  $("bocina-x").style.display = apagada ? "" : "none";
  $("volumen").value = Math.round(AUDIO.volumen * 100);
  $("volumen-valor").textContent = `${Math.round(AUDIO.volumen * 100)}%`;
  $("silenciar").textContent = AUDIO.mudo ? "Activar sonidos" : "Silenciar";
}
$("bocina").addEventListener("click", () => {
  const abrir = $("bocina-panel").classList.contains("oculto");
  $("bocina-panel").classList.toggle("oculto", !abrir);
  $("bocina").setAttribute("aria-expanded", String(abrir));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".bocina-caja")) { $("bocina-panel").classList.add("oculto"); $("bocina").setAttribute("aria-expanded", "false"); }
});
$("volumen").addEventListener("input", (e) => {
  AUDIO.volumen = Number(e.target.value) / 100;
  if (AUDIO.volumen > 0) AUDIO.mudo = false;
  audio(); aplicarVolumen();
});
$("volumen").addEventListener("change", () => sonido("prueba"));
$("silenciar").addEventListener("click", () => { AUDIO.mudo = !AUDIO.mudo; audio(); aplicarVolumen(); if (!AUDIO.mudo) sonido("prueba"); });
$("probar-sonido").addEventListener("click", () => { audio(); sonido("prueba"); });
pintarBocina();

// Aviso del sistema (notificación) cuando la página está en segundo plano
function avisoSistema(titulo, cuerpo) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(titulo, { body: cuerpo, tag: "ajedrez-llamada", renotify: true, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}
function pintarPermisoAvisos() {
  const b = $("permiso-avisos");
  if (!b) return;
  const soporta = "Notification" in window;
  b.classList.toggle("oculto", !soporta || Notification.permission === "granted");
  b.disabled = soporta && Notification.permission === "denied";
  b.textContent = b.disabled ? "Avisos bloqueados en el navegador" : "Activar avisos de llamadas";
}
$("permiso-avisos").addEventListener("click", async () => {
  try { await Notification.requestPermission(); } catch {}
  pintarPermisoAvisos();
  if (Notification.permission === "granted") avisar("Listo: te avisaremos de llamadas aunque estés en otra pestaña.");
});
pintarPermisoAvisos();

// ---------- Jugar contra la Máquina (Stockfish en el navegador, GPL-3.0) ----------
const MAQUINA = "maquina";
nombres[MAQUINA] = "Máquina";
avatares[MAQUINA] = "rey";
fotos[MAQUINA] = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='#2E3B2A'/>" +
  "<line x1='20' y1='6' x2='20' y2='11' stroke='#E3C77E' stroke-width='2'/><circle cx='20' cy='5' r='2.3' fill='#E3C77E'/>" +
  "<rect x='9' y='11' width='22' height='17' rx='5' fill='#F2E6CF'/><circle cx='15.5' cy='19' r='2.6' fill='#2A1C0C'/>" +
  "<circle cx='24.5' cy='19' r='2.6' fill='#2A1C0C'/><rect x='15' y='24' width='10' height='2' rx='1' fill='#2A1C0C'/>" +
  "<rect x='12' y='29' width='16' height='6' rx='2' fill='#CDA54E'/></svg>");
const NIVELES = {
  facil:   { nombre: "1 (Fácil)",   habilidad: 0,  profundidad: 1,  ms: 150,  azar: 0.35 },
  medio:   { nombre: "2 (Medio)",   habilidad: 6,  profundidad: 5,  ms: 450,  azar: 0.05 },
  dificil: { nombre: "3 (Difícil)", habilidad: 13, profundidad: 10, ms: 1000, azar: 0 },
  maestro: { nombre: "4 (Maestro)", habilidad: 20, profundidad: 18, ms: 1800, azar: 0 },
};
const filaMaquina = (clase) => `<div class="${clase} maquina">${ficha(MAQUINA, "punto-verde robot")}<div><strong>Máquina</strong><small>Siempre disponible</small></div>` +
  (clase === "fila" ? '<button class="btn-fila verde" data-maquina="1">Jugar</button>' : '<span class="izq-acciones"><button type="button" class="izq-jugar" data-maquina="1">Jugar</button></span>') + "</div>";

let motor = null, motorListo = null, pensandoMaquina = false;
// Arranca Stockfish: primero desde tu sitio (/motor) y, si no está, desde una copia pública (jsDelivr)
const MOTOR_CDN = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/";
function crearMotor(origen) {
  return new Promise((listo, falla) => {
    let w;
    try {
      if (origen === "local") w = new Worker("/motor/stockfish.js");
      else {
        const codigo = `self.Module = { locateFile: (f) => "${MOTOR_CDN}" + f }; importScripts("${MOTOR_CDN}stockfish.js");`;
        w = new Worker(URL.createObjectURL(new Blob([codigo], { type: "application/javascript" })));
      }
    } catch (e) { return falla(e); }
    const t = setTimeout(() => { w.terminate(); falla(new Error("sin respuesta")); }, origen === "local" ? 7000 : 15000);
    const escuchar = (e) => {
      if (String(e.data).startsWith("uciok")) { clearTimeout(t); w.removeEventListener("message", escuchar); listo(w); }
    };
    w.addEventListener("message", escuchar);
    w.onerror = () => { clearTimeout(t); w.terminate(); falla(new Error("no cargó")); };
    w.postMessage("uci");
  });
}
let origenMotor = null;
function iniciarMotor() {
  if (motorListo) return motorListo;
  motorListo = crearMotor("local").then((w) => { origenMotor = "tu sitio"; return w; })
    .catch(() => crearMotor("cdn").then((w) => { origenMotor = "copia pública"; return w; }))
    .then((w) => { motor = w; })
    .catch((e) => { motorListo = null; throw e; });
  return motorListo;
}
// Un solo motor, una tarea a la vez (jugar o analizar)
let colaMotor = Promise.resolve();
function enCola(tarea) { const p = colaMotor.then(tarea, tarea); colaMotor = p.catch(() => {}); return p; }
// Si el motor no responde a tiempo, se le pide parar y se sigue sin él
function conLimite(promesa, ms) {
  let t;
  return Promise.race([promesa, new Promise((_, falla) => { t = setTimeout(() => { motor?.postMessage("stop"); falla(new Error("motor lento")); }, ms); })]).finally(() => clearTimeout(t));
}
async function jugadaMotor(fen, nivel) {
  const n = NIVELES[nivel] || NIVELES.medio;
  // En fácil, a veces juega una jugada cualquiera para ser más humano
  if (Math.random() < n.azar) {
    const opciones = new Chess(fen).moves({ verbose: true });
    const m = opciones[Math.floor(Math.random() * opciones.length)];
    return m ? m.from + m.to + (m.promotion || "") : null;
  }
  await conLimite(iniciarMotor(), 15000);
  return enCola(() => conLimite(new Promise((listo) => {
    const escuchar = (e) => {
      const t = String(e.data);
      if (t.startsWith("bestmove")) { motor.removeEventListener("message", escuchar); listo(t.split(" ")[1]); }
    };
    motor.addEventListener("message", escuchar);
    motor.postMessage("setoption name MultiPV value 1");
    motor.postMessage(`setoption name Skill Level value ${n.habilidad}`);
    motor.postMessage(`position fen ${fen}`);
    motor.postMessage(`go depth ${n.profundidad} movetime ${n.ms}`);
  }), n.ms + 6000));
}

// Análisis a toda fuerza: las mejores líneas con su evaluación (desde el lado que mueve)
async function analizar(fen, lineas = 3, ms = 700) {
  try { await conLimite(iniciarMotor(), 15000); } catch (e) { motorFallo = true; throw e; }
  return enCola(() => conLimite(new Promise((listo) => {
    const res = {};
    const escuchar = (e) => {
      const t = String(e.data);
      if (t.startsWith("info") && t.includes(" pv ") && t.includes(" score ")) {
        const k = Number((t.match(/ multipv (\d+)/) || [0, 1])[1]);
        const cp = t.match(/ score cp (-?\d+)/), mate = t.match(/ score mate (-?\d+)/);
        const pv = t.split(" pv ")[1].trim().split(" ");
        res[k] = { uci: pv[0], pv, cp: cp ? Number(cp[1]) : null, mate: mate ? Number(mate[1]) : null };
      } else if (t.startsWith("bestmove")) {
        motor.removeEventListener("message", escuchar);
        listo(Object.keys(res).sort((a, b) => a - b).map((k) => ({ ...res[k], valor: valorDe(res[k]) })));
      }
    };
    motor.addEventListener("message", escuchar);
    motor.postMessage("setoption name Skill Level value 20");
    motor.postMessage(`setoption name MultiPV value ${lineas}`);
    motor.postMessage(`position fen ${fen}`);
    motor.postMessage(`go depth 14 movetime ${ms}`);
  }), ms + 6000));
}
const valorDe = (l) => (l.mate != null ? (l.mate > 0 ? 10000 - l.mate * 10 : -10000 - l.mate * 10) : l.cp ?? 0);

const configLocal = () => { try { return JSON.parse(LS?.getItem("ajedrez-maquina-config") || "null") || { nivel: "medio", color: "w", min: 0 }; } catch { return { nivel: "medio", color: "w", min: 0 }; } };
const partidaLocalGuardada = () => { try { return JSON.parse(LS?.getItem("ajedrez-maquina") || "null"); } catch { return null; } };
const guardarLocal = () => {
  try {
    LS?.setItem("ajedrez-maquina", JSON.stringify({ ...partida, optimista: false }));
    LS?.setItem("ajedrez-maquina-t", new Date().toISOString());
  } catch {}
  subirMaquina();
};

// ---------- Sincronizar con la nube: la misma partida en tu celular y en tu laptop ----------
let tSubida = null;
function marcarCambioLocal() { try { LS?.setItem("ajedrez-maquina-t", new Date().toISOString()); } catch {} subirMaquina(); }
function subirMaquina() {
  clearTimeout(tSubida);
  tSubida = setTimeout(async () => {
    if (!yo || !sb) return;
    const t = LS?.getItem("ajedrez-maquina-t") || new Date().toISOString();
    try {
      await sb.from("maquina_estado").upsert({
        usuario: yo, partida: partidaLocalGuardada(), record: recordLocal(), config: configLocal(), actualizada: t,
      });
    } catch {}
  }, 1200);
}
// Trae de la nube lo más reciente (si otro dispositivo jugó después)
async function bajarMaquina() {
  if (!yo || !sb) return false;
  let data, error;
  try { ({ data, error } = await sb.from("maquina_estado").select("partida, record, config, actualizada").eq("usuario", yo).maybeSingle()); }
  catch { return false; }
  if (error || !data) return false;
  const local = LS?.getItem("ajedrez-maquina-t");
  if (local && new Date(local) >= new Date(data.actualizada)) return false;
  try {
    if (data.partida) LS?.setItem("ajedrez-maquina", JSON.stringify(data.partida)); else LS?.removeItem("ajedrez-maquina");
    if (data.record) LS?.setItem("ajedrez-maquina-record", JSON.stringify(data.record));
    if (data.config) LS?.setItem("ajedrez-maquina-config", JSON.stringify(data.config));
    LS?.setItem("ajedrez-maquina-t", data.actualizada);
  } catch {}
  return true;
}
const recordLocal = () => { try { return JSON.parse(LS?.getItem("ajedrez-maquina-record") || "{}"); } catch { return {}; } };

function pintarLeccionesModal(elegida) {
  $("vsm-lecciones").innerHTML = LECCIONES.map((l) =>
    `<button type="button" data-leccion="${l.id}" aria-pressed="${l.id === elegida}"><b>${esc(l.nombre)}</b><small>Juegas con ${l.color === "w" ? "blancas" : "negras"} · ${esc(l.nivel)}</small></button>`).join("");
}
function modoModal(modo) {
  $("vsm-modo").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.modo === modo)));
  $("vsm-lecciones").classList.toggle("oculto", modo !== "leccion");
  $("vsm-grupo-color").classList.toggle("oculto", modo === "leccion");
  if (modo === "leccion") $("vsm-entrenador").checked = true;
}
$("vsm-modo").addEventListener("click", (e) => { const b = e.target.closest("button[data-modo]"); if (b) modoModal(b.dataset.modo); });
$("vsm-lecciones").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-leccion]");
  if (!b) return;
  $("vsm-lecciones").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
});
// Prueba de verdad que el motor responde (pide una jugada a la posición inicial)
let estadoMotor = null;   // null = sin probar, true = listo, false = falla
async function probarMotor() {
  if (estadoMotor !== null) return estadoMotor;
  try {
    await conLimite(iniciarMotor(), 15000);
    const r = await enCola(() => conLimite(new Promise((listo) => {
      const escuchar = (e) => { const t = String(e.data); if (t.startsWith("bestmove")) { motor.removeEventListener("message", escuchar); listo(t.split(" ")[1]); } };
      motor.addEventListener("message", escuchar);
      motor.postMessage("position startpos");
      motor.postMessage("go depth 6");
    }), 8000));
    estadoMotor = !!r && r !== "(none)";
  } catch { estadoMotor = false; }
  if (!estadoMotor) { motorFallo = true; setTimeout(() => { estadoMotor = null; }, 30000); }
  return estadoMotor;
}
function pintarEstadoMotor() {
  const el = $("vsm-motor");
  if (estadoMotor === null) { el.className = "vsm-motor"; el.textContent = "Revisando el motor…"; return; }
  el.className = `vsm-motor ${estadoMotor ? "ok" : "mal"}`;
  el.innerHTML = estadoMotor
    ? `✅ Motor Stockfish listo${origenMotor === "copia pública" ? " (cargado desde la copia pública; para que cargue desde tu sitio, sube la carpeta «motor» a GitHub)" : ""}: los niveles 1 a 4 juegan a su fuerza real.`
    : "⚠️ <strong>El motor Stockfish no cargó</strong> ni desde tu sitio ni desde la copia pública. La Máquina jugaría en modo sencillo (muy débil). Revisa tu conexión y que la carpeta <strong>motor</strong> esté en GitHub.";
}
function abrirVsMaquina() {
  const c = configLocal();
  pintarEstadoMotor();
  probarMotor().then(pintarEstadoMotor);
  pintarLeccionesModal(c.leccion || LECCIONES[0].id);
  modoModal(c.modo || "libre");
  $("vsm-entrenador").checked = c.didactico !== false;
  const marcar = (caja, attr, valor) => $(caja).querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(valor))));
  marcar("vsm-nivel", "nivel", c.nivel); marcar("vsm-color", "color", c.color); marcar("vsm-tiempo", "min", c.min);
  pintarRecord(c.nivel);
  const guardada = partidaLocalGuardada();
  $("vsm-empezar").textContent = guardada && guardada.estado === "jugando" ? "Empezar una nueva (la anterior se descarta)" : "Empezar partida";
  $("vs-maquina").classList.remove("oculto");
  iniciarMotor().catch(() => {});
}
function pintarRecord(nivel) {
  const r = recordLocal()[nivel] || { g: 0, p: 0, t: 0 };
  $("vsm-record").textContent = r.g + r.p + r.t ? `Tu récord en el nivel ${NIVELES[nivel].nombre}: ${r.g} ganadas · ${r.p} perdidas · ${r.t} tablas` : `Aún no juegas en el nivel ${NIVELES[nivel].nombre}.`;
}
["vsm-nivel", "vsm-color", "vsm-tiempo"].forEach((id) => $(id).addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  if (b.dataset.nivel) pintarRecord(b.dataset.nivel);
}));
$("vsm-cerrar").addEventListener("click", () => $("vs-maquina").classList.add("oculto"));
$("vs-maquina").addEventListener("click", (e) => { if (e.target.id === "vs-maquina") $("vs-maquina").classList.add("oculto"); });
$("vsm-empezar").addEventListener("click", () => {
  const elegido = (id, attr) => $(id).querySelector('button[aria-pressed="true"]')?.dataset[attr];
  const modo = elegido("vsm-modo", "modo") || "libre";
  const leccion = modo === "leccion" ? (elegido("vsm-lecciones", "leccion") || LECCIONES[0].id) : null;
  const cfg = { nivel: elegido("vsm-nivel", "nivel") || "medio", color: elegido("vsm-color", "color") || "w", min: Number(elegido("vsm-tiempo", "min") || 0),
    modo, leccion, didactico: modo === "leccion" || $("vsm-entrenador").checked };
  LS?.setItem("ajedrez-maquina-config", JSON.stringify(cfg));
  marcarCambioLocal();
  $("vs-maquina").classList.add("oculto");
  empezarLocal(cfg);
});

function empezarLocal(cfg) {
  const leccion = cfg.leccion ? LECCIONES.find((l) => l.id === cfg.leccion) : null;
  const color = leccion ? leccion.color : cfg.color === "azar" ? (Math.random() < 0.5 ? "w" : "b") : cfg.color;
  const ms = cfg.min ? cfg.min * 60000 : 24 * 3600000;
  partida = {
    id: MAQUINA, local: true, nivel: cfg.nivel, minutos: cfg.min || 0,
    blancas: color === "w" ? yo : MAQUINA, negras: color === "w" ? MAQUINA : yo,
    estado: "jugando", fen: new Chess().fen(), jugadas: [], resultado: null, motivo: null,
    reloj_blancas: ms, reloj_negras: ms, ultimo_tick: new Date(ahoraServidor()).toISOString(),
    version: 1, actualizada: new Date().toISOString(),
    didactico: !!cfg.didactico, leccion: leccion ? leccion.id : null, ayudas: 0,
    tema: cfg.tema || (leccion && TEMAS.some((t) => t.id === leccion.id) ? leccion.id : null),
  };
  flechas = []; analisisTurno = null; ultimaApertura = null; pistasVisibles = false; vistaIndice = null;
  $("ent-pistas").setAttribute("aria-pressed", "false");
  $("ent-pistas").textContent = "💡 Ver mejores jugadas";
  guardarLocal();
  avisosTiempo.delete(MAQUINA);
  motor?.postMessage("ucinewgame");
  history.pushState(null, "", `?p=${MAQUINA}`);
  abrirLocal(true);
  cerrarContexto();
  if (leccion) setTimeout(() => abrirContexto({ nombre: leccion.nombre, temaId: TEMAS.some((t) => t.id === leccion.id) ? leccion.id : null }), 50);
  if (leccion) tarjeta("", `<span class="ent-paso">LECCIÓN · ${esc(leccion.nivel.toUpperCase())}</span><span class="ent-veredicto">${esc(leccion.nombre)}</span><p>${esc(leccion.intro)}</p><p>Tú mueves tus piezas: la <strong style="color:#9DC3E6">flecha azul</strong> te dice qué jugada toca y por qué, pero puedes jugar lo que quieras. La Máquina responde con la línea de la lección.</p>`);
  else if (partida.didactico) tarjeta("", `<span class="ent-veredicto">🎓 Entrenador listo</span><p>Juega con calma: después de cada jugada te digo si fue buena o no, con flechas. Si te equivocas, puedes <strong>deshacer</strong>.</p>`);
}

async function abrirLocal(recien) {
  mostrar("partida");
  if (!recien) await bajarMaquina();
  const g = recien ? partida : partidaLocalGuardada();
  if (!g || (g.blancas !== yo && g.negras !== yo)) {
    avisar("No tienes una partida contra la Máquina. Empieza una nueva.");
    history.replaceState(null, "", "./");
    mostrar("inicio");
    return abrirVsMaquina();
  }
  // Al volver a abrirla, el reloj continúa desde donde se quedó
  if (!recien && g.estado === "jugando") g.ultimo_tick = new Date(ahoraServidor()).toISOString();
  partida = g;
  cerrarVideo();
  if (canal) { sb.removeChannel(canal); canal = null; }
  probarMotor().then(() => { if (partida?.local) dibujar(); });
  document.body.classList.toggle("sin-reloj", !partida.minutos);
  document.body.classList.add("vs-maquina");
  elegida = null; movimientos = [];
  cargarChat(MAQUINA);
  pintarMesaPartida();
  pintarLineaPartida();
  dibujar();
  if (!recien && partida.didactico) { flechas = []; tarjeta("", `<span class="ent-veredicto">🎓 Seguimos</span><p>Retomamos tu partida. ${partida.estado === "jugando" ? "Te toca pensar tu jugada." : ""}</p>`); pintarApertura(); entrenadorTuTurno(); }
  turnoMaquina();
}

function ajustarVistaLocal(color, turno) {
  pintarEntrenador();
  // Marca junto al nombre de la Máquina: si juega con Stockfish o en modo sencillo
  const lado = partida.blancas === MAQUINA ? (miColor() === "b" ? "arriba" : "abajo") : (miColor() === "w" ? "arriba" : "abajo");
  const nombre = $(lado)?.querySelector(".lado strong");
  if (nombre && estadoMotor !== null && !nombre.querySelector(".motor-chip"))
    nombre.insertAdjacentHTML("beforeend", estadoMotor && !motorFallo
      ? `<span class="motor-chip ok" title="Juega con Stockfish">STOCKFISH · NIVEL ${partida.nivel === "facil" ? 1 : partida.nivel === "medio" ? 2 : partida.nivel === "dificil" ? 3 : 4}</span>`
      : `<span class="motor-chip mal" title="El motor no cargó; juega en modo sencillo">MODO SENCILLO</span>`);
  $("chat").classList.add("oculto");
  $("control-estado").classList.add("oculto");
  $("aviso-pausa").classList.add("oculto");
  $("ofrecer-tablas").classList.add("oculto");
  $("oferta-tablas").classList.add("oculto");
  if (partida.estado === "jugando") {
    const nivel = NIVELES[partida.nivel]?.nombre || "";
    $("estado").innerHTML = turno === color
      ? `Tu turno contra la Máquina · nivel ${esc(nivel)}.`
      : `La Máquina está pensando<span class="pensando" aria-hidden="true"><i></i><i></i><i></i></span>`;
  }
  $("nueva").classList.add("oculto");
  if (ocupadoEntrenador && partida.leccion && enviando) $("estado").textContent = "Mira la lección: las jugadas se hacen solas.";
  if (vistaIndice !== null) $("estado").textContent = "Estás repasando la partida. Toca ⏭ para volver y seguir jugando.";
}

let guiaJugada = null;
function moverLocal(desde, hacia, promocion) {
  const fenAntes = partida.fen;
  guiaJugada = guiaActual;
  vistaIndice = null;
  const nueva = aplicarLocal(desde, hacia, promocion);
  if (!nueva) return;
  const miJugada = partida.blancas === yo ? new Chess(fenAntes).turn() === "w" : new Chess(fenAntes).turn() === "b";
  partida = { ...nueva, optimista: false, version: partida.version + 1, actualizada: new Date().toISOString() };
  elegida = null; movimientos = [];
  guardarLocal();
  dibujar();
  if (partida.didactico) {
    entrenadorDespuesDeJugada(fenAntes, desde + hacia + (promocion || ""), miJugada);
    if (miJugada) return;   // el entrenador analiza y después juega la Máquina
  }
  if (partida.estado === "terminada") return contarLocal();
  turnoMaquina();
}

async function turnoMaquina() {
  if (!partida?.local || partida.estado !== "jugando" || pensandoMaquina || ocupadoEntrenador) return;
  const colorMaquina = partida.blancas === MAQUINA ? "w" : "b";
  if (new Chess(partida.fen).turn() !== colorMaquina) return;
  pensandoMaquina = true;
  const fenAntes = partida.fen, inicio = Date.now();
  let uci = null;
  const t = temaActivo();
  if (t) {
    const jug = partida.jugadas.map((j) => limpiaSan(j.san)), linea = t.linea.split(" ");
    if (jug.length < linea.length && jug.every((x, i) => linea[i] === x)) {
      const m = movLegal(fenAntes, linea[jug.length]);
      if (m) uci = m.from + m.to + (m.promotion || "");
    }
  }
  if (!uci) try { uci = await jugadaMotor(fenAntes, partida.nivel); } catch { motorFallo = true; }
  // Si el motor no responde, la Máquina juega con un método sencillo para que la partida nunca se detenga
  if (!uci || uci === "(none)") {
    uci = jugadaSencilla(fenAntes);
    if (motorFallo && !avisoMotor) { avisoMotor = true; estadoMotor = false; avisar("⚠️ El motor Stockfish no respondió: la Máquina juega en MODO SENCILLO (muy débil). Revisa que la carpeta «motor» esté en GitHub."); }
  }
  // Una pausa breve para que se sienta natural
  const espera = 500 - (Date.now() - inicio);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  pensandoMaquina = false;
  if (!uci || uci === "(none)" || !partida?.local || partida.fen !== fenAntes || partida.estado !== "jugando") return;
  moverLocal(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
}

// ======================= ENTRENADOR =======================
let motorFallo = false, avisoMotor = false;
// Jugada de respaldo sin motor: captura lo más valioso sin dejar piezas colgadas
function jugadaSencilla(fen) {
  const c = new Chess(fen);
  let mejor = null, mejorValor = -Infinity;
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    let v = Math.random() * 15;
    if (c.isCheckmate()) v = 1e6;
    else {
      if (m.captured) v += VALOR_PIEZA[m.captured] * 100;
      if (m.promotion) v += 800;
      if (c.inCheck()) v += 25;
      try { if (c.attackers(m.to, c.turn()).length && !c.attackers(m.to, m.color).length) v -= VALOR_PIEZA[m.piece] * 100; } catch {}
    }
    c.undo();
    if (v > mejorValor) { mejorValor = v; mejor = m; }
  }
  return mejor ? mejor.from + mejor.to + (mejor.promotion || "") : null;
}
// Mejores jugadas sin motor (respaldo): ordena por capturas, jaques, desarrollo y seguridad
function jugadasHeuristicas(fen, n = 3) {
  const c = new Chess(fen);
  const lista = [];
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    let v = 0;
    if (c.isCheckmate()) v = 1e6;
    else {
      if (m.captured) v += VALOR_PIEZA[m.captured] * 100;
      if (m.promotion) v += 800;
      if (c.inCheck()) v += 40;
      try { if (c.attackers(m.to, c.turn()).length && !c.attackers(m.to, m.color).length) v -= VALOR_PIEZA[m.piece] * 100; } catch {}
      const atras = (m.color === "w" && m.from[1] === "1") || (m.color === "b" && m.from[1] === "8");
      if ((m.piece === "n" || m.piece === "b") && atras) v += 30;
      if (m.flags.includes("k") || m.flags.includes("q")) v += 45;
      if (["d4", "e4", "d5", "e5"].includes(m.to)) v += 20;
    }
    c.undo();
    lista.push({ uci: m.from + m.to + (m.promotion || ""), valor: v, heuristica: true });
  }
  return lista.sort((a, b) => b.valor - a.valor).slice(0, n);
}
// Piezas atacadas y sin defensa de un color
function piezasColgadas(fen, color) {
  const c = new Chess(fen), rival = color === "w" ? "b" : "w";
  try {
    return c.board().flat().filter((p) => p && p.color === color && p.type !== "k" && p.type !== "p" &&
      c.attackers(p.square, rival).length && !c.attackers(p.square, color).length).map((p) => ({ sq: p.square, tipo: p.type }));
  } catch { return []; }
}
const ESPN = { N: "C", B: "A", R: "T", Q: "D", K: "R" };
const sanEs = (san) => String(san || "").replace(/^[NBRQK]/, (l) => ESPN[l]).replace(/=([NBRQ])/, (m, l) => "=" + ESPN[l]);
const limpiaSan = (san) => String(san).replace(/[+#]/g, "");
let flechas = [];
let pistasVisibles = false;
let analisisTurno = null;      // { fen, lineas }
let ultimaApertura = null;
let ocupadoEntrenador = false;

function uciASan(fen, uci) {
  try { const c = new Chess(fen); const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); return m; } catch { return null; }
}
function textoEval(valor) {
  if (Math.abs(valor) >= 9000) return valor > 0 ? "tienes mate a la vista" : "te pueden dar mate";
  const p = valor / 100;
  if (Math.abs(p) < 0.3) return "posición pareja";
  return p > 0 ? `vas mejor por ${p.toFixed(1)} peones` : `vas peor por ${Math.abs(p).toFixed(1)} peones`;
}
// Explica en palabras qué hace una jugada
function porQueJugada(fen, uci) {
  const c = new Chess(fen);
  let m; try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); } catch { return ""; }
  const ideas = [];
  const nombre = { p: "peón", n: "caballo", b: "alfil", r: "torre", q: "dama", k: "rey" };
  if (c.isCheckmate()) return "¡da jaque mate!";
  if (m.flags.includes("k") || m.flags.includes("q")) ideas.push("pone a salvo al rey con el enroque");
  if (m.captured) ideas.push(`captura ${m.captured === "p" ? "un peón" : "el " + nombre[m.captured]}`);
  if (c.inCheck()) ideas.push("da jaque");
  if (m.promotion) ideas.push("corona un peón");
  const fila = m.from[1];
  const atras = (m.color === "w" && fila === "1") || (m.color === "b" && fila === "8");
  if (!m.captured && (m.piece === "n" || m.piece === "b") && atras) ideas.push(`desarrolla el ${nombre[m.piece]}`);
  if (m.piece === "p" && ["d4", "e4", "d5", "e5", "c4", "c5"].includes(m.to)) ideas.push("lucha por el centro");
  if (!ideas.length) ideas.push("mejora la posición de tus piezas");
  return ideas.join(" y ");
}
// Qué tipo de apertura es, en palabras
function tipoApertura(nombre) {
  if (/Gambito|Contragambito/.test(nombre)) return { tipo: "Gambito", explica: "sacrificas un peón para ganar tiempo, centro o iniciativa" };
  if (/^Ataque/.test(nombre)) return { tipo: "Ataque", explica: "un plan agresivo para atacar desde el principio" };
  if (/^Sistema/.test(nombre)) return { tipo: "Sistema", explica: "un esquema que se juega casi igual contra todo" };
  if (/^(Defensa|Siciliana|Francesa|Caro-Kann)/.test(nombre)) return { tipo: "Defensa", explica: "la respuesta de las negras para pelear por el centro" };
  if (/trampa|Mate/i.test(nombre)) return { tipo: "Trampa", explica: "una celada que funciona si el rival se descuida" };
  return { tipo: "Apertura", explica: "el plan inicial de las blancas para tomar la iniciativa" };
}
// Clasifica una jugada: ataque, defensa, desarrollo, centro, enroque, captura…
const VALOR_PIEZA = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NOMBRE_PIEZA = { p: "peón", n: "caballo", b: "alfil", r: "torre", q: "dama", k: "rey" };
function tiposJugada(fen, uci) {
  const antes = new Chess(fen);
  const yoC = antes.turn(), rival = yoC === "w" ? "b" : "w";
  const enPeligro = (c, color) => c.board().flat().filter((p) => p && p.color === color && p.type !== "k" &&
    c.attackers(p.square, color === "w" ? "b" : "w").length && !c.attackers(p.square, color).length).map((p) => p.square);
  let peligroAntes = []; try { peligroAntes = enPeligro(antes, yoC); } catch {}
  const c = new Chess(fen);
  let m; try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); } catch { return []; }
  const t = [];
  if (m.flags.includes("k") || m.flags.includes("q")) t.push({ i: "🏰", tipo: "Enroque", texto: "pone a salvo al rey" });
  if (m.captured) t.push({ i: "⚔️", tipo: "Captura", texto: `gana ${m.captured === "p" ? "un peón" : "un " + NOMBRE_PIEZA[m.captured]}` });
  if (c.inCheck()) t.push({ i: "👑", tipo: "Ataque al rey", texto: "da jaque" });
  // ¿Qué ataca la pieza que se movió?
  try {
    const blancos = c.board().flat().filter((p) => p && p.color === rival && p.type !== "k" && c.attackers(p.square, yoC).includes(m.to))
      .sort((a, b) => VALOR_PIEZA[b.type] - VALOR_PIEZA[a.type]);
    const b = blancos[0];
    if (b && !c.inCheck() && (VALOR_PIEZA[b.type] > VALOR_PIEZA[m.piece] || !c.attackers(b.square, rival).length))
      t.push({ i: "🎯", tipo: "Ataque", texto: `amenaza el ${NOMBRE_PIEZA[b.type]} de ${b.square}` });
  } catch {}
  // ¿Protege algo que estaba en peligro?
  try {
    const salvadas = peligroAntes.filter((sq) => sq === m.from || (c.get(sq) && c.attackers(sq, yoC).length));
    if (salvadas.length) {
      const sq = salvadas[0], p = sq === m.from ? m.piece : c.get(sq).type;
      t.push({ i: "🛡️", tipo: "Defensa", texto: sq === m.from ? `pone a salvo el ${NOMBRE_PIEZA[p]} que estaba atacado` : `protege el ${NOMBRE_PIEZA[p]} de ${sq}` });
    }
  } catch {}
  const atras = (m.color === "w" && m.from[1] === "1") || (m.color === "b" && m.from[1] === "8");
  if (!m.captured && (m.piece === "n" || m.piece === "b") && atras) t.push({ i: "♞", tipo: "Desarrollo", texto: `saca el ${NOMBRE_PIEZA[m.piece]} a jugar` });
  if (m.piece === "p" && ["d4", "e4", "d5", "e5", "c4", "c5", "f4", "f5"].includes(m.to)) t.push({ i: "⬛", tipo: "Centro", texto: "pelea por el centro" });
  if (!t.length) t.push({ i: "↗️", tipo: "Maniobra", texto: "reacomoda una pieza" });
  return t;
}
const chipsTipo = (fen, uci) => `<div class="ent-tipos">${tiposJugada(fen, uci).map((x) => `<span title="${esc(x.texto)}">${x.i} ${esc(x.tipo)}</span>`).join("")}</div>`;
function apertura(jugadas) {
  const sec = jugadas.map((j) => limpiaSan(j.san)).join(" ");
  let mejor = null;
  for (const [nombre, movs, idea] of APERTURAS) {
    if ((sec + " ").startsWith(movs + " ") || sec === movs) { if (!mejor || movs.length > mejor.movs.length) mejor = { nombre, movs, idea, ...tipoApertura(nombre) }; }
  }
  return mejor;
}
// Consejos clásicos de apertura según lo que acabas de jugar
function consejoPrincipio(fenAntes, m, jugadas) {
  const n = Math.ceil(jugadas.length / 2);
  if (n > 12) return "";
  if (m.piece === "q" && n <= 5 && !m.captured) return "Consejo: sacar la dama tan pronto la expone a ataques; primero desarrolla caballos y alfiles.";
  const mias = jugadas.filter((_, i) => (i % 2 === 0) === (m.color === "w"));
  const misPiezas = mias.slice(0, -1).map((j) => j.hacia);
  if (n <= 8 && m.piece !== "p" && misPiezas.includes(m.from) && !m.captured) return "Consejo: en la apertura evita mover la misma pieza dos veces; desarrolla las demás.";
  if (n >= 9 && !m.flags.includes("k") && !m.flags.includes("q")) {
    const c = new Chess(partida.fen);
    const rey = c.board().flat().find((x) => x && x.type === "k" && x.color === m.color);
    if (rey && ["e1", "e8", "d1", "d8"].includes(rey.square)) return "Consejo: tu rey sigue en el centro; enrocar pronto lo protege.";
  }
  return "";
}

function tarjeta(clase, html, tipo = "") {
  const t = $("ent-tarjeta");
  t.className = `ent-tarjeta ${clase || ""}`;
  t.dataset.tipo = tipo;
  t.innerHTML = html;
}
// ---------- Contexto: qué es, para qué sirve y algo de historia ----------
const CLAVES_CONTEXTO = [
  [/Dragón/, "dragon"], [/Siciliana/, "siciliana"], [/Evans/, "evans"], [/Gambito de Rey/, "gambito-rey"], [/Budapest/, "budapest"],
  [/Gambito de Dama/, "gambito-dama"], [/Eslava/, "eslava"], [/Londres/, "londres"], [/Española/, "espanola"],
  [/Italiana|Giuoco|dos caballos/i, "italiana"], [/Francesa/, "francesa"], [/Caro-Kann/, "caro-kann"], [/Escandinava/, "escandinava"],
  [/India de Rey/, "india-rey"],
];
let contextoAbierto = null;
function abrirContexto({ nombre, tipo, explica, idea, temaId }) {
  const id = temaId || (CLAVES_CONTEXTO.find(([r]) => r.test(nombre)) || [])[1];
  const ctx = id ? CONTEXTO[id] : null;
  const tema = id ? TEMAS.find((t) => t.id === id) : null;
  const linea = tema ? tema.linea.split(" ").map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : "") + sanEs(m)).join(" ") : "";
  const t = tipo || (tema ? tipoApertura(tema.nombre).tipo : "");
  const exp = explica || (tema ? tipoApertura(tema.nombre).explica : "");
  $("ent-contexto").innerHTML = `<div class="ctx-cabeza"><h3>${esc(nombre)}</h3><button type="button" id="ctx-cerrar" aria-label="Cerrar">×</button></div>` +
    (t ? `<span class="ctx-tipo">${esc(t.toUpperCase())}</span><p>Un <strong>${esc(t.toLowerCase())}</strong> es ${esc(exp)}.</p>` : "") +
    (idea ? `<h4>La idea</h4><p>${esc(idea)}</p>` : "") +
    (ctx ? `<h4>Para qué sirve</h4><p>${esc(ctx.paraQue)}</p><h4>Un poco de historia</h4><p>${esc(ctx.historia)}</p>` : "") +
    (linea ? `<h4>Línea principal</h4><p class="ctx-linea">${esc(linea)}</p>` : "");
  $("ent-contexto").classList.remove("oculto");
  $("ent-apertura").setAttribute("aria-expanded", "true");
  contextoAbierto = nombre;
}
function cerrarContexto() {
  $("ent-contexto").classList.add("oculto");
  $("ent-apertura").setAttribute("aria-expanded", "false");
  contextoAbierto = null;
}
$("ent-apertura").addEventListener("click", () => {
  if (contextoAbierto) return cerrarContexto();
  const a = apertura(partida.jugadas);
  if (a) abrirContexto(a);
});
document.addEventListener("click", (e) => {
  if (e.target.id === "ctx-cerrar") cerrarContexto();
  const v = e.target.closest("[data-ver-contexto]");
  if (v) { const t = TEMAS.find((x) => x.id === v.dataset.verContexto); if (t) abrirContexto({ nombre: t.nombre, temaId: t.id, idea: (APERTURAS.find(([n]) => n === t.nombre) || [])[2] }); }
});
function pintarApertura() {
  const a = apertura(partida.jugadas);
  const chip = $("ent-apertura");
  chip.classList.toggle("oculto", !a);
  if (!a) return null;
  chip.textContent = `📖 ${a.nombre} · ${a.tipo}`;
  chip.title = `${a.tipo}: ${a.explica}`;
  const nueva = a.nombre !== ultimaApertura;
  ultimaApertura = a.nombre;
  if (nueva && contextoAbierto && !TEMAS.some((t) => t.nombre === contextoAbierto)) abrirContexto(a);
  return nueva ? a : null;
}

// Antes de tu jugada: analiza para poder calificarla y mostrar pistas
async function entrenadorTuTurno() {
  if (!partida?.didactico || partida.estado !== "jugando") return;
  const fen = partida.fen;
  let lineas = await analizar(fen, 3, 700).catch(() => null);
  if (partida.fen !== fen) return null;
  if (!lineas || !lineas.length) lineas = jugadasHeuristicas(fen, 3);
  analisisTurno = { fen, lineas };
  if (pistasVisibles) mostrarPistas();
  pintarPlan();
  pintarNotas();
  return lineas;
}
function mostrarPistas() {
  if (partida.estado !== "jugando" || new Chess(partida.fen).turn() !== miColor()) return;
  if (!analisisTurno || analisisTurno.fen !== partida.fen) {
    if (!motorFallo) return;
    analisisTurno = { fen: partida.fen, lineas: jugadasHeuristicas(partida.fen, 3) };
  }
  const [a, ...resto] = analisisTurno.lineas;
  flechas = flechas.filter((f) => f.color === "naranja");
  if (a) flechas.push({ de: a.uci.slice(0, 2), a: a.uci.slice(2, 4), color: "verde" });
  resto.slice(0, 2).forEach((l) => flechas.push({ de: l.uci.slice(0, 2), a: l.uci.slice(2, 4), color: "amarillo" }));
  pintarFlechas();
  const m = a && uciASan(partida.fen, a.uci);
  if (m) tarjeta("mejor", `<span class="ent-veredicto">💡 Sugerencia</span><p>La flecha <strong style="color:#8FD88A">verde</strong> es la mejor: <strong>${esc(sanEs(m.san))}</strong>, porque ${esc(porQueJugada(partida.fen, a.uci))}. Las <strong style="color:#EBD46A">amarillas</strong> también son buenas.</p>`);
}

async function entrenadorDespuesDeJugada(fenAntes, uci, miJugada) {
  if (!partida?.didactico) return;
  const m = uciASan(fenAntes, uci);
  const nueva = pintarApertura();
  if (!miJugada) {
    // Jugó la Máquina: explica y busca amenazas
    flechas = [];
    const extra = nueva ? `<p>📖 <strong>${esc(nueva.nombre)}</strong> <em class="ent-tipo">${esc(nueva.tipo)}: ${esc(nueva.explica)}</em>. ${esc(nueva.idea)}</p>` : "";
    const narra = textoLeccion(partida.jugadas.length - 1, m?.san);
    const linea = `<p class="ent-respuesta">🤖 La Máquina respondió <strong>${esc(sanEs(m?.san))}</strong>: ${esc(narra || porQueJugada(fenAntes, uci))}.</p>${chipsTipo(fenAntes, uci)}${extra}`;
    // Tu veredicto se queda a la vista; la respuesta de la Máquina se agrega abajo
    if ($("ent-tarjeta").dataset.tipo === "veredicto") $("ent-tarjeta").insertAdjacentHTML("beforeend", linea);
    else tarjeta("", linea);
    pintarFlechas();
    const lineas = await entrenadorTuTurno();
    buscarAmenaza(lineas?.[0]?.valor ?? 0);
    return;
  }
  const guiaPrevia = guiaJugada;
  ocupadoEntrenador = true;
  $("ent-deshacer").disabled = true;
  tarjeta("", `<span class="ent-veredicto">Analizando tu jugada<span class="analizando"><i></i><i></i><i></i></span></span>`);
  $("ent-amenaza").classList.add("oculto");
  try {
    let antes = analisisTurno && analisisTurno.fen === fenAntes ? analisisTurno.lineas : await analizar(fenAntes, 3, 700);
    const despues = partida.estado === "terminada" ? null : await analizar(partida.fen, 1, 600);
    const mejor = antes[0];
    const valorAntes = mejor ? mejor.valor : 0;
    const valorDespues = partida.estado === "terminada"
      ? (partida.resultado === "½-½" ? 0 : 10000)
      : -(despues?.[0]?.valor ?? 0);
    const perdida = Math.max(0, valorAntes - valorDespues);
    const fueLaMejor = mejor && mejor.uci.slice(0, 4) === uci.slice(0, 4);
    const enLista = antes.some((l) => l.uci.slice(0, 4) === uci.slice(0, 4));
    let clase, titulo;
    const segunda = antes[1];
    const empate = segunda && Math.abs(mejor.valor - segunda.valor) < 30;   // varias jugadas casi iguales
    if (fueLaMejor) { clase = "mejor"; titulo = "✅ ¡La mejor jugada!"; }
    else if (perdida <= 30) { clase = "mejor"; titulo = "✅ Excelente (prácticamente igual que la mejor)"; }
    else if (perdida <= 70 || enLista && perdida <= 100) { clase = "buena"; titulo = "👍 Buena jugada"; }
    else if (perdida <= 160) { clase = "imprecision"; titulo = "🟡 Imprecisión"; }
    else if (perdida <= 350) { clase = "error"; titulo = "🟠 Error"; }
    else { clase = "grave"; titulo = "🔴 Error grave"; }
    flechas = [];
    const sanMejor = mejor && uciASan(fenAntes, mejor.uci);
    let html = `<span class="ent-veredicto">${titulo}</span>`;
    html += `<p>Jugaste <strong>${esc(sanEs(m?.san))}</strong>: ${esc(porQueJugada(fenAntes, uci))}.</p>${chipsTipo(fenAntes, uci)}`;
    if (empate && perdida <= 30) html += `<p>Aquí había varias jugadas casi igual de buenas: en esta posición importa más el <strong>plan</strong> que la jugada exacta.</p>`;
    const colgadas = piezasColgadas(partida.fen, miColor());
    if (colgadas.length && partida.estado === "jugando") html += `<p>⚠️ Ojo: tu ${NOMBRE_PIEZA[colgadas[0].tipo]} de ${colgadas[0].sq} quedó <strong>sin defensa</strong> y está atacado.</p>`;
    if (!fueLaMejor && perdida > 30 && sanMejor) {
      html += `<p>${clase === "buena" ? "También estaba" : "Mejor era"} <strong style="color:#8FD88A">${esc(sanEs(sanMejor.san))}</strong> (flecha verde): ${esc(porQueJugada(fenAntes, mejor.uci))}.${perdida > 70 ? ` Te costó unos ${(perdida / 100).toFixed(1)} peones de ventaja.` : ""}</p>`;
      flechas.push({ de: mejor.uci.slice(0, 2), a: mejor.uci.slice(2, 4), color: "verde" });
      if (clase !== "buena") flechas.push({ de: uci.slice(0, 2), a: uci.slice(2, 4), color: "rojo" });
    }
    const narraMia = textoLeccion(partida.jugadas.length - 1, m?.san);
    if (narraMia) html += `<p>📚 ${esc(narraMia)}</p>`;
    if (guiaPrevia?.m && !guiaPrevia.fin) {
      const siguio = guiaPrevia.m.from + guiaPrevia.m.to === uci.slice(0, 4);
      html += siguio
        ? `<p>🎯 <strong>¡Seguiste el plan de ${esc(temaActivo()?.nombre || "tu tema")}!</strong></p>`
        : `<p>🎯 Te saliste del plan (era <strong>${esc(sanEs(guiaPrevia.m.san))}</strong>). No pasa nada: te sigo guiando desde aquí.</p>`;
    }
    const consejo = m ? consejoPrincipio(fenAntes, m, partida.jugadas) : "";
    if (consejo) html += `<p>${esc(consejo)}</p>`;
    if (nueva) html += `<p>📖 <strong>${esc(nueva.nombre)}</strong> <em class="ent-tipo">${esc(nueva.tipo)}: ${esc(nueva.explica)}</em>. ${esc(nueva.idea)}</p>`;
    const ventaja = Math.max(-1000, Math.min(1000, valorDespues));
    html += `<div class="ent-barra" title="Balance de la posición"><i style="width:${50 + ventaja / 20}%"></i></div><span class="ent-eval">${textoEval(valorDespues)}</span>`;
    tarjeta(clase, html, "veredicto");
    pintarFlechas();
    if (["error", "grave"].includes(clase)) sonido("tiempo");
  } catch (e) {
    console.warn("Entrenador:", e);
    tarjeta("", motorFallo
      ? "<p>El motor de análisis no está respondiendo, así que no puedo calificar jugadas por ahora. La partida sigue; revisa que la carpeta «motor» esté subida a GitHub.</p>"
      : "<p>No pude analizar esta jugada. Sigue jugando; en la siguiente lo intento de nuevo.</p>");
  }
  ocupadoEntrenador = false;
  $("ent-deshacer").disabled = false;
  if (partida.estado === "terminada") return contarLocal();
  // Un momento para leer, y luego responde la Máquina
  setTimeout(() => turnoMaquina(), 900);
}

// ¿Qué amenaza la Máquina si fuera su turno otra vez?
async function buscarAmenaza(miValor = 0) {
  const colgadas = piezasColgadas(partida.fen, miColor());
  if (colgadas.length) {
    $("ent-amenaza").innerHTML = `⚠️ <strong>Pieza en peligro:</strong> tu ${NOMBRE_PIEZA[colgadas[0].tipo]} de ${colgadas[0].sq} está atacado y nadie lo defiende. Muévelo o protégelo.`;
    $("ent-amenaza").classList.remove("oculto");
    return;
  }
  const fen = partida.fen;
  const partes = fen.split(" ");
  partes[1] = partes[1] === "w" ? "b" : "w";
  partes[3] = "-";
  const fenRival = partes.join(" ");
  let c; try { c = new Chess(fenRival); } catch { return; }
  if (new Chess(fen).inCheck()) {
    $("ent-amenaza").innerHTML = "⚠️ <strong>¡Estás en jaque!</strong> Primero protege a tu rey.";
    return $("ent-amenaza").classList.remove("oculto");
  }
  const lineas = await analizar(fenRival, 1, 400).catch(() => null);
  if (!lineas || partida.fen !== fen) return;
  const l = lineas[0];
  const m = l && uciASan(fenRival, l.uci);
  // Solo es amenaza si, de poder jugar dos veces seguidas, la Máquina ganaría algo de verdad
  const ganancia = l ? l.valor + miValor : 0;
  const peligro = m && (m.san.includes("#") || (m.captured && m.captured !== "p" && ganancia >= 120) || ganancia >= 350);
  $("ent-amenaza").classList.toggle("oculto", !peligro);
  if (!peligro) return;
  const nombre = { p: "un peón", n: "tu caballo", b: "tu alfil", r: "tu torre", q: "tu dama", k: "" };
  $("ent-amenaza").innerHTML = `⚠️ <strong>Cuidado:</strong> la Máquina amenaza <strong>${esc(sanEs(m.san))}</strong> (flecha naranja)${m.captured ? `, que captura ${nombre[m.captured]}` : m.san.includes("#") ? ", ¡mate!" : m.san.includes("+") ? ", con jaque" : ""}.`;
  flechas = flechas.filter((f) => f.color !== "naranja");
  flechas.push({ de: l.uci.slice(0, 2), a: l.uci.slice(2, 4), color: "naranja" });
  pintarFlechas();
}

// ---------- Practicar un tema: te guía jugada a jugada, aunque te salgas de la línea ----------
let guiaActual = null;
const temaActivo = () => (partida?.tema ? TEMAS.find((t) => t.id === partida.tema) : null);
function movLegal(fen, san) { try { return new Chess(fen).move(san); } catch { return null; } }
function guiaTema() {
  const t = temaActivo();
  if (!t || partida.estado !== "jugando" || t.color !== miColor()) return null;
  if (new Chess(partida.fen).turn() !== miColor()) return null;
  const jug = partida.jugadas.map((j) => limpiaSan(j.san));
  const linea = t.linea.split(" ");
  const enLinea = jug.length < linea.length && jug.every((m, i) => linea[i] === m);
  const textoDe = (san) => (t.plan.find(([p]) => limpiaSan(p) === limpiaSan(san)) || [, ""])[1];
  if (enLinea) {
    const san = linea[jug.length];
    const m = movLegal(partida.fen, san);
    if (m) return { san, m, enLinea: true, texto: textoDe(san) };
  }
  const mias = jug.filter((_, i) => (i % 2 === 0) === (t.color === "w"));
  for (const [san, texto] of t.plan) {
    if (mias.includes(limpiaSan(san))) continue;
    const m = movLegal(partida.fen, san);
    if (m) return { san, m, enLinea: false, texto };
  }
  return { fin: true };
}
// Qué tan bien encaja cada tema con la partida real
function puntajeTema(t) {
  if (t.color !== miColor()) return -1;
  const jug = partida.jugadas.map((j) => limpiaSan(j.san)), linea = t.linea.split(" ");
  let pref = 0; while (pref < jug.length && pref < linea.length && jug[pref] === linea[pref]) pref++;
  const mias = jug.filter((_, i) => (i % 2 === 0) === (t.color === "w"));
  const hechos = t.plan.filter(([san]) => mias.includes(limpiaSan(san))).length;
  const legales = t.plan.filter(([san]) => !mias.includes(limpiaSan(san)) && movLegal(partida.fen, san)).length;
  return hechos * 2 + pref + legales * 0.5;
}
function temasSugeridos() {
  if (new Chess(partida.fen).turn() !== miColor()) return [];
  return TEMAS.filter((t) => t.color === miColor()).map((t) => ({ t, p: puntajeTema(t) })).filter((x) => x.p >= 2).sort((a, b) => b.p - a.p);
}
// Notas de estructura de peones, al estilo de un entrenador
function notasEstructura(fen, color) {
  const c = new Chess(fen), rival = color === "w" ? "b" : "w";
  const peones = { w: [], b: [] };
  c.board().flat().forEach((p) => { if (p && p.type === "p") peones[p.color].push(p.square); });
  const col = (sq) => "abcdefgh".indexOf(sq[0]), fila = (sq) => Number(sq[1]);
  const notas = [];
  const analiza = (quien, esMio) => {
    const otro = quien === "w" ? "b" : "w";
    const porColumna = {};
    peones[quien].forEach((sq) => { porColumna[sq[0]] = (porColumna[sq[0]] || 0) + 1; });
    const doblados = Object.keys(porColumna).filter((k) => porColumna[k] > 1);
    const aislados = peones[quien].filter((sq) => !peones[quien].some((o) => Math.abs(col(o) - col(sq)) === 1));
    const pasados = peones[quien].filter((sq) => !peones[otro].some((o) => Math.abs(col(o) - col(sq)) <= 1 &&
      (quien === "w" ? fila(o) > fila(sq) : fila(o) < fila(sq))));
    if (esMio) {
      if (pasados.length) notas.push(`Tienes un <strong>peón pasado</strong> en ${pasados[0]}: nadie puede frenarlo con peones; empújalo con apoyo de tus piezas.`);
      if (aislados.length) notas.push(`Tu peón de ${aislados[0]} está <strong>aislado</strong>: no tiene peones vecinos que lo cuiden; protégelo con piezas o cámbialo.`);
      if (doblados.length) notas.push(`Tienes <strong>peones doblados</strong> en la columna ${doblados[0]}: son más lentos y difíciles de defender.`);
    } else {
      if (pasados.length) notas.push(`La Máquina tiene un <strong>peón pasado</strong> en ${pasados[0]}: bloquéalo con una pieza (idealmente un caballo) justo enfrente.`);
      if (aislados.length) notas.push(`El peón rival de ${aislados[0]} está <strong>aislado</strong>: es un buen blanco; ataca la casilla de enfrente.`);
    }
  };
  analiza(color, true);
  analiza(rival, false);
  // Alfil malo: tus peones del centro fijos en el color de tu alfil
  const alfiles = c.board().flat().filter((p) => p && p.color === color && p.type === "b");
  if (alfiles.length === 1) {
    const claro = (sq) => (col(sq) + fila(sq)) % 2 === 1;
    const colorAlfil = claro(alfiles[0].square);
    const mismos = peones[color].filter((sq) => "cdef".includes(sq[0]) && claro(sq) === colorAlfil).length;
    if (mismos >= 3) notas.push(`Tu alfil de ${alfiles[0].square} es un <strong>alfil malo</strong>: muchos de tus peones centrales están en su mismo color. Busca cambiarlo o sacarlo por fuera de la cadena.`);
  }
  // Columnas abiertas para tus torres
  const abiertas = "abcdefgh".split("").filter((f) => !peones.w.some((s) => s[0] === f) && !peones.b.some((s) => s[0] === f));
  if (abiertas.length && Math.ceil(partida.jugadas.length / 2) >= 8) notas.push(`La columna <strong>${abiertas[0]}</strong> está abierta: es la carretera ideal para una torre.`);
  return notas.slice(0, 3);
}
function textoFase(valor) {
  if (valor == null) return "";
  if (valor >= 150) return `<div class="fase ataque">⚔️ <strong>Fase de ataque:</strong> tienes ventaja. Acerca piezas al rey rival, abre líneas y busca cambiar piezas solo si te conviene simplificar.</div>`;
  if (valor <= -150) return `<div class="fase defensa">🛡️ <strong>Fase de defensa:</strong> estás peor. Protege a tu rey, cambia piezas activas del rival y no abras el juego; busca complicar o bloquear.</div>`;
  return `<div class="fase equilibrio">⚖️ <strong>Posición equilibrada:</strong> mejora tus piezas peor colocadas, controla el centro y busca un plan claro antes de atacar.</div>`;
}
function pintarPlan() {
  const caja = $("ent-plan");
  if (!partida?.didactico || vistaIndice !== null) { caja.innerHTML = ""; ubicarPlan(); return; }
  const t = temaActivo();
  const miTurno = partida.estado === "jugando" && new Chess(partida.fen).turn() === miColor();
  let html = "";
  // 1) Lo más importante arriba: si conviene cambiar de plan
  if (miTurno) {
    const sug = temasSugeridos();
    const actual = t ? puntajeTema(t) : 0;
    const atorado = t && (!guiaActual || guiaActual.fin);
    const mejores = sug.filter((x) => x.t.id !== t?.id && (atorado || x.p > actual + 1.5)).slice(0, 3);
    if (mejores.length) {
      html += `<div class="cambio-plan"><p>${t ? "🔄 La partida tomó otro rumbo: tu posición ahora encaja mejor con" : "💡 Planes que encajan con tu posición:"}</p><div class="chips">` +
        mejores.map((x) => `<button type="button" data-cambiar-tema="${x.t.id}">${esc(x.t.nombre)} · ${esc(x.t.tipo || "")}</button>`).join("") + "</div></div>";
    }
  }
  // 2) La fase: atacar, defender o mejorar piezas
  if (miTurno && analisisTurno?.fen === partida.fen) html += textoFase(analisisTurno.lineas[0]?.valor);
  // 3) El plan del tema, con la siguiente jugada en verde (compacto si ya lo terminaste)
  if (t && t.color === miColor()) {
    const mias = partida.jugadas.map((j) => limpiaSan(j.san)).filter((_, i) => (i % 2 === 0) === (t.color === "w"));
    const hechos = t.plan.filter(([san]) => mias.includes(limpiaSan(san))).length;
    if (hechos === t.plan.length) {
      html += `<div class="plan-caja"><span class="plan-titulo"><span>Plan · ${esc(t.nombre)}</span><span>${esc(t.tipo || "")}</span></span><span class="plan-resumen">✅ Completaste las ${t.plan.length} jugadas del plan.</span></div>`;
    } else {
      html += `<div class="plan-caja"><span class="plan-titulo"><span>Plan · ${esc(t.nombre)} (${hechos}/${t.plan.length})</span><span>${esc(t.tipo || "")}</span></span><ol class="plan-lista">` +
        t.plan.map(([san, texto]) => {
          const hecho = mias.includes(limpiaSan(san));
          const sig = guiaActual && !guiaActual.fin && limpiaSan(guiaActual.san) === limpiaSan(san);
          const imposible = !hecho && miTurno && !sig && !movLegal(partida.fen, san);
          const marca = hecho ? "✅" : sig ? "👉" : imposible ? "·" : "○";
          return `<li class="${hecho ? "hecho" : sig ? "siguiente" : imposible ? "imposible" : ""}"><span>${marca}</span><b>${esc(sanEs(san))}</b><span>${esc(texto)}</span></li>`;
        }).join("") + "</ol></div>";
    }
  }
  // 4) La estructura de peones
  const notas = Math.ceil(partida.jugadas.length / 2) >= 4 ? notasEstructura(partida.fen, miColor()) : [];
  if (notas.length) html += `<div class="plan-caja"><span class="plan-titulo">🧱 Estructura de peones</span><ul class="estructura">${notas.map((n) => `<li>${n}</li>`).join("")}</ul></div>`;
  // Durante el turno de la Máquina se conserva lo último para que nada salte en la pantalla
  if (!miTurno && partida.estado === "jugando" && caja.innerHTML.trim()) { ubicarPlan(); return; }
  caja.innerHTML = html || `<p class="plan-espera">Aquí verás el plan, la fase de la partida y las sugerencias de cambio de plan.</p>`;
  ubicarPlan();
}
// En pantalla completa y pantallas anchas, el plan va en su propia columna junto al tablero
const pantallaPlan = matchMedia("(min-width: 1200px)");
function ubicarPlan() {
  const plan = $("ent-plan");
  const aparte = document.body.classList.contains("enfoque") && pantallaPlan.matches && !!partida?.local && !!partida?.didactico;
  document.body.classList.toggle("plan-aparte", aparte);
  if (aparte) { if (plan.parentElement !== $("lateral-plan")) $("lateral-plan").appendChild(plan); }
  else if (plan.parentElement !== $("entrenador")) $("rep-jugar").after(plan);
}
pantallaPlan.addEventListener?.("change", ubicarPlan);
$("ent-plan").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cambiar-tema]");
  if (!b) return;
  partida.tema = b.dataset.cambiarTema;
  guardarLocal();
  pintarTema(); pintarPlan(); pintarFlechas();
  avisar(`🔄 Cambiamos de plan: ${temaActivo().nombre}`);
});
function pintarTema() {
  const caja = $("ent-tema");
  const t = temaActivo();
  caja.classList.toggle("oculto", !t);
  guiaActual = null;
  if (!t) return;
  const cabeza = `<div class="ent-tema-cabeza"><span>🎯 PRACTICANDO: ${esc(t.nombre.toUpperCase())}${t.tipo ? ` · ${esc(t.tipo.toUpperCase())}` : ""}</span><span><button type="button" class="ver-ctx" data-ver-contexto="${t.id}">📜 ¿Qué es?</button> · <button type="button" id="tema-quitar">Quitar</button></span></div>`;
  if (t.color !== miColor()) {
    caja.innerHTML = cabeza + `<p>Este tema se juega con <strong>${t.color === "w" ? "blancas" : "negras"}</strong> y en esta partida llevas ${miColor() === "w" ? "blancas" : "negras"}.</p><button type="button" class="btn-fila dorado" id="tema-nueva">Empezar partida con este tema</button>`;
    return;
  }
  if (partida.estado !== "jugando") { caja.innerHTML = cabeza + "<p>La partida terminó. Empieza otra para seguir practicando.</p>"; return; }
  if (vistaIndice !== null) { caja.innerHTML = cabeza + "<p>Estás repasando. Vuelve a la posición actual para seguir con el plan.</p>"; return; }
  const g = guiaTema();
  if (!g) { caja.innerHTML = cabeza + "<p>Espera la jugada de la Máquina…</p>"; return; }
  if (g.fin) {
    const mias = partida.jugadas.map((j) => limpiaSan(j.san)).filter((_, i) => (i % 2 === 0) === (t.color === "w"));
    const completo = t.plan.every(([san]) => mias.includes(limpiaSan(san)));
    caja.innerHTML = cabeza + (completo
      ? "<p>✅ Completaste el plan de este tema. ¡Ahora juega libre con lo aprendido!</p>"
      : "<p>La partida se alejó de este plan y ya no se puede seguir aquí. Abajo te propongo planes que encajan mejor con tu posición.</p>");
    return;
  }
  guiaActual = g;
  caja.innerHTML = cabeza + `<p>${g.enLinea ? "Siguiendo la teoría, tu siguiente jugada es" : "Para volver al plan, tu siguiente jugada debería ser"} <strong>${esc(sanEs(g.m.san))}</strong> (flecha azul): ${esc(g.texto)}.</p>`;
}
document.addEventListener("click", (e) => {
  if (e.target.id === "tema-quitar") { partida.tema = null; guardarLocal(); pintarTema(); pintarFlechas(); }
  if (e.target.id === "tema-nueva") { const t = temaActivo(); empezarLocal({ ...configLocal(), color: t.color, didactico: true, leccion: null, tema: t.id }); }
});
function pintarListaTemas() {
  const grupos = [...new Set(TEMAS.map((t) => t.grupo))];
  $("ent-lista-temas").innerHTML = grupos.map((g) => `<h3>${esc(g)}</h3><div class="temas-grid">` +
    TEMAS.filter((t) => t.grupo === g).map((t) => `<button type="button" data-tema="${t.id}" aria-pressed="${partida?.tema === t.id}"><b>${esc(t.nombre)}</b><small>${esc(t.tipo || "")} · con ${t.color === "w" ? "blancas" : "negras"}</small></button>`).join("") + "</div>").join("");
}
$("ent-temas").addEventListener("click", () => {
  const abrir = $("ent-lista-temas").classList.contains("oculto");
  if (abrir) pintarListaTemas();
  $("ent-lista-temas").classList.toggle("oculto", !abrir);
  $("ent-temas").setAttribute("aria-expanded", String(abrir));
});
$("ent-lista-temas").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tema]");
  if (!b) return;
  partida.tema = b.dataset.tema;
  guardarLocal();
  $("ent-lista-temas").classList.add("oculto");
  $("ent-temas").setAttribute("aria-expanded", "false");
  pintarTema();
  pintarFlechas();
  avisar(`🎯 Practicando: ${temaActivo().nombre}`);
  abrirContexto({ nombre: temaActivo().nombre, temaId: temaActivo().id });
});

// ---------- Repasar jugadas (adelante y atrás) ----------
let vistaIndice = null;   // null = posición actual
function juegoEn(n) { const c = new Chess(); partida.jugadas.slice(0, n).forEach((j) => c.move(j.san)); return c; }
function irA(n) {
  if (!partida?.local) return;
  const total = partida.jugadas.length;
  vistaIndice = n == null || n >= total ? null : Math.max(0, n);
  elegida = null; movimientos = [];
  dibujar();
}
function pintarRepaso() {
  const total = partida.jugadas.length, n = vistaIndice ?? total;
  $("rep-pos").textContent = vistaIndice === null ? `En vivo · ${Math.ceil(total / 2)} jugadas` : `Repasando ${n} de ${total}`;
  document.querySelector(".ent-repaso").classList.toggle("activo", vistaIndice !== null);
  document.querySelector(".escena").classList.toggle("repaso", vistaIndice !== null);
  $("rep-inicio").disabled = $("rep-atras").disabled = n === 0;
  $("rep-adelante").disabled = $("rep-fin").disabled = vistaIndice === null;
  $("rep-jugar").classList.toggle("oculto", vistaIndice === null);
  if (vistaIndice !== null) $("estado").textContent = "Estás repasando la partida. Toca ⏭ para volver y seguir jugando.";
}
$("rep-inicio").addEventListener("click", () => irA(0));
$("rep-atras").addEventListener("click", () => irA((vistaIndice ?? partida.jugadas.length) - 1));
$("rep-adelante").addEventListener("click", () => irA((vistaIndice ?? partida.jugadas.length) + 1));
$("rep-fin").addEventListener("click", () => irA(null));
// Jugar desde aquí: la partida continúa desde la posición que estás repasando
$("rep-jugar").addEventListener("click", () => {
  if (vistaIndice === null || pensandoMaquina || ocupadoEntrenador) return;
  const nuevas = partida.jugadas.slice(0, vistaIndice);
  const c = juegoEn(vistaIndice);
  partida = { ...partida, fen: c.fen(), jugadas: nuevas, estado: "jugando", resultado: null, motivo: null, version: partida.version + 1,
    ultimo_tick: new Date(ahoraServidor()).toISOString(), ayudas: (partida.ayudas || 0) + 1 };
  vistaIndice = null; flechas = []; analisisTurno = null;
  guardarLocal();
  cerrarFinal?.();
  dibujar();
  tarjeta("", `<span class="ent-veredicto">▶ Seguimos desde aquí</span><p>La partida continúa desde la jugada ${Math.ceil(nuevas.length / 2) || 1}. ${c.turn() === miColor() ? "Te toca mover." : "Ahora mueve la Máquina."}</p>`);
  if (c.turn() === miColor()) entrenadorTuTurno(); else turnoMaquina();
});
$("jugadas").addEventListener("click", (e) => { const s = e.target.closest("[data-ir]"); if (s && partida?.local) irA(Number(s.dataset.ir)); });
document.addEventListener("keydown", (e) => {
  if (!partida?.local || $("partida").classList.contains("oculto") || e.target.closest("input, textarea")) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); irA((vistaIndice ?? partida.jugadas.length) - 1); }
  if (e.key === "ArrowRight") { e.preventDefault(); irA((vistaIndice ?? partida.jugadas.length) + 1); }
});

// ---------- NOTAS: qué logra cada jugada candidata ----------
function columnaAbierta(c, col, color) {
  const peones = c.board().flat().filter((p) => p && p.type === "p" && p.square[0] === col);
  if (!peones.length) return "abierta";
  if (!peones.some((p) => p.color === color)) return "semiabierta";
  return "";
}
function notaDeJugada(fen, uci) {
  const c = new Chess(fen);
  let m; try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); } catch { return null; }
  const nombre = NOMBRE_PIEZA[m.piece];
  const tipos = tiposJugada(fen, uci);
  const partes = tipos.filter((t) => t.tipo !== "Maniobra").map((t) => t.texto);
  if (m.piece === "r" && !m.captured) {
    const col = columnaAbierta(new Chess(c.fen()), m.to[0], m.color);
    if (col) partes.push(`la torre toma una columna ${col}: más fuerza ofensiva`);
  }
  if (m.piece === "q" && Math.ceil(partida.jugadas.length / 2) < 6 && !m.captured) partes.push("aunque sacar la dama tan pronto la expone");
  const ofensiva = tipos.some((t) => ["Ataque", "Ataque al rey", "Captura"].includes(t.tipo));
  const defensiva = tipos.some((t) => t.tipo === "Defensa" || t.tipo === "Enroque");
  return {
    texto: `Si mueves ${m.piece === "p" ? "el peón" : `${nombre === "dama" || nombre === "torre" ? "la" : "el"} ${nombre}`} a <strong>${m.to}</strong> (${esc(sanEs(m.san))}): ${esc(partes.join(", ") || "mejoras su posición")}.`,
    estilo: ofensiva ? "ofensiva" : defensiva ? "defensiva" : "neutra",
  };
}
function pintarNotas() {
  const caja = $("ent-notas");
  const miTurno = partida?.didactico && partida.estado === "jugando" && vistaIndice === null && new Chess(partida.fen).turn() === miColor();
  if (!miTurno || !analisisTurno || analisisTurno.fen !== partida.fen) { caja.classList.add("oculto"); return; }
  const colores = ["verde", "amarillo", "amarillo"];
  const items = analisisTurno.lineas.slice(0, 3).map((l, i) => ({ n: notaDeJugada(partida.fen, l.uci), color: colores[i] })).filter((x) => x.n);
  // También la jugada del plan, si hay
  if (guiaActual?.m && !items.some((x) => x.n.texto.includes(`(${sanEs(guiaActual.m.san)})`))) {
    const n = notaDeJugada(partida.fen, guiaActual.m.from + guiaActual.m.to);
    if (n) items.push({ n, color: "azul" });
  }
  if (!items.length) { caja.classList.add("oculto"); return; }
  caja.innerHTML = `<h3>📝 Notas para esta jugada</h3><ul>` +
    items.map((x) => `<li><i style="background:${COLOR_FLECHA[x.color]}"></i><span>${x.n.texto}${x.n.estilo === "ofensiva" ? " ⚔️" : x.n.estilo === "defensiva" ? " 🛡️" : ""}</span></li>`).join("") +
    `</ul>`;
  caja.classList.remove("oculto");
}

// ---------- Pregúntale al entrenador ----------
async function responderPregunta(pregunta) {
  if (!partida?.local || partida.estado !== "jugando") return avisar("Pregúntame durante una partida en juego.");
  if (vistaIndice !== null) irA(null);
  const botones = document.querySelectorAll("[data-pregunta]");
  botones.forEach((b) => (b.disabled = true));
  const fen = partida.fen;
  const miTurno = new Chess(fen).turn() === miColor();
  tarjeta("respuesta", `<span class="ent-veredicto">🙋 Pensando tu pregunta<span class="analizando"><i></i><i></i><i></i></span></span>`, "respuesta");
  try {
    if (pregunta === "amenaza") {
      flechas = [];
      await buscarAmenaza(analisisTurno?.fen === fen ? analisisTurno.lineas[0]?.valor ?? 0 : 0);
      const hay = !$("ent-amenaza").classList.contains("oculto");
      tarjeta("respuesta", `<span class="ent-veredicto">🙋 ¿Qué me amenaza?</span><p>${hay ? "Mira el aviso naranja y la flecha naranja en el tablero: eso es lo que la Máquina quiere hacer." : "Ahora mismo no veo amenazas serias contra ti. Buen momento para mejorar tus piezas o atacar."}</p>`, "respuesta");
      return;
    }
    if (!miTurno) return tarjeta("respuesta", "<p>Espera a que sea tu turno y vuelve a preguntarme.</p>", "respuesta");
    const lineas = (await analizar(fen, 5, pregunta === "mate" || pregunta === "tactica" ? 1500 : 900).catch(() => null)) || jugadasHeuristicas(fen, 5);
    if (partida.fen !== fen) return;
    analisisTurno = { fen, lineas: lineas.slice(0, 3) };
    const san = (l) => esc(sanEs(uciASan(fen, l.uci)?.san || l.uci));
    const flecha = (l, color) => ({ de: l.uci.slice(0, 2), a: l.uci.slice(2, 4), color });
    flechas = [];
    let html = "";
    if (pregunta === "mate") {
      const mate = lineas.find((l) => l.mate > 0);
      if (mate) {
        flechas.push(flecha(mate, "morado"));
        // La secuencia de mate: tus jugadas en morado, las del rival en naranja
        const pasos = mate.pv.slice(0, Math.min(mate.pv.length, mate.mate * 2 - 1));
        let c = new Chess(fen); const sans = [];
        pasos.forEach((u, i) => { try { const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); sans.push(sanEs(m.san)); if (i > 0 && i < 4) flechas.push({ de: u.slice(0, 2), a: u.slice(2, 4), color: i % 2 ? "naranja" : "morado" }); } catch {} });
        html = `<span class="ent-veredicto">🙋 ¿Puedo dar mate?</span><p><strong style="color:#D6B4FA">¡Sí! Hay mate en ${mate.mate}.</strong> Empieza con <strong>${san(mate)}</strong> (flecha morada).</p><p>La secuencia: ${esc(sans.join(" · "))}.</p>`;
      } else {
        flechas.push(flecha(lineas[0], "verde"));
        html = `<span class="ent-veredicto">🙋 ¿Puedo dar mate?</span><p>Por ahora <strong>no hay mate forzado</strong>. La mejor jugada es <strong>${san(lineas[0])}</strong> (flecha verde): ${esc(porQueJugada(fen, lineas[0].uci))}. Para preparar un ataque al rey, acerca más piezas a su enroque.</p>`;
      }
    } else if (pregunta === "tactica") {
      const [a, b] = lineas;
      const salto = b ? a.valor - b.valor : 0;
      const m = uciASan(fen, a.uci);
      if (a.mate > 0 || salto >= 150 || m?.captured) {
        flechas.push(flecha(a, "morado"));
        html = `<span class="ent-veredicto">🙋 ¿Hay una táctica?</span><p><strong style="color:#D6B4FA">Sí.</strong> Busca <strong>${san(a)}</strong> (flecha morada): ${esc(porQueJugada(fen, a.uci))}.${salto >= 150 ? ` Es mucho mejor que las demás opciones (unos ${(salto / 100).toFixed(1)} peones).` : ""}</p>${chipsTipo(fen, a.uci)}`;
      } else {
        lineas.slice(0, 2).forEach((l, i) => flechas.push(flecha(l, i ? "amarillo" : "verde")));
        html = `<span class="ent-veredicto">🙋 ¿Hay una táctica?</span><p>No veo una táctica clara: las mejores jugadas valen casi lo mismo. Aquí gana quien tenga <strong>mejor plan</strong>. Te marco las dos mejores ideas.</p>`;
      }
    } else if (pregunta === "ataque" || pregunta === "defensa") {
      const buscados = pregunta === "ataque" ? ["Ataque", "Ataque al rey", "Captura"] : ["Defensa", "Enroque"];
      const elegidas = lineas.filter((l) => tiposJugada(fen, l.uci).some((t) => buscados.includes(t.tipo))).slice(0, 2);
      const usar = elegidas.length ? elegidas : lineas.slice(0, 1);
      usar.forEach((l, i) => flechas.push(flecha(l, i ? "amarillo" : "verde")));
      html = `<span class="ent-veredicto">🙋 ${pregunta === "ataque" ? "¿Cómo ataco?" : "¿Cómo me defiendo?"}</span>` +
        (elegidas.length ? "" : `<p>No hay una jugada claramente ${pregunta === "ataque" ? "ofensiva" : "defensiva"} entre las buenas; lo más sano es esto:</p>`) +
        usar.map((l) => `<p><strong>${san(l)}</strong>: ${esc(porQueJugada(fen, l.uci))}.</p>${chipsTipo(fen, l.uci)}`).join("") +
        (pregunta === "ataque" ? "<p>Idea general: lleva piezas hacia el rey rival, abre líneas con peones y busca columnas abiertas para tus torres.</p>" : "<p>Idea general: protege las piezas sueltas, mantén peones frente a tu rey y cambia las piezas más activas del rival.</p>");
    } else {
      // Una guía nueva desde la posición actual
      lineas.slice(0, 3).forEach((l, i) => flechas.push(flecha(l, i ? "amarillo" : "verde")));
      const sug = temasSugeridos().slice(0, 1)[0];
      html = `<span class="ent-veredicto">🙋 Tu guía desde aquí</span>` + textoFase(lineas[0].valor) +
        `<p>Mi recomendación: <strong>${san(lineas[0])}</strong> (verde), ${esc(porQueJugada(fen, lineas[0].uci))}. Alternativas en amarillo.</p>` +
        (sug ? `<p>Plan que mejor encaja con tu posición: <button type="button" class="enlace-boton" data-cambiar-tema="${sug.t.id}">${esc(sug.t.nombre)}</button>.</p>` : "");
    }
    tarjeta("respuesta", html, "respuesta");
    pintarFlechas();
    pintarNotas();
  } catch (e) {
    console.warn("Pregunta:", e);
    tarjeta("respuesta", "<p>No pude responder ahora. Intenta de nuevo en un momento.</p>", "respuesta");
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pregunta]");
  if (b) responderPregunta(b.dataset.pregunta);
  const c = e.target.closest(".ent-tarjeta [data-cambiar-tema]");
  if (c && partida?.local) { partida.tema = c.dataset.cambiarTema; guardarLocal(); pintarEntrenador(); avisar(`🔄 Cambiamos de plan: ${temaActivo().nombre}`); }
});

// Dibuja las flechas sobre el tablero (respetan la vista de cada jugador)
const COLOR_FLECHA = { verde: "#5FBF5A", amarillo: "#E2C33C", rojo: "#D9443A", naranja: "#F0963C", azul: "#6FA8DC", morado: "#B47CF0" };
function pintarFlechas() {
  const tab = $("tablero");
  tab.querySelector(".flechas")?.remove();
  const todas = vistaIndice !== null ? [] : [...flechas, ...(guiaActual?.m ? [{ de: guiaActual.m.from, a: guiaActual.m.to, color: "azul" }] : [])];
  if (!partida?.local || !todas.length) return;
  const volteado = miColor() === "b";
  const xy = (sq) => {
    const f = "abcdefgh".indexOf(sq[0]), r = Number(sq[1]);
    return [(volteado ? 7 - f : f) + 0.5, (volteado ? r - 1 : 8 - r) + 0.5];
  };
  const svg = todas.filter((fl) => fl.de !== fl.a).map((fl, i) => {
    const [x1, y1] = xy(fl.de), [x2, y2] = xy(fl.a);
    const ang = Math.atan2(y2 - y1, x2 - x1), L = Math.hypot(x2 - x1, y2 - y1);
    const fin = L - 0.32;
    const c = COLOR_FLECHA[fl.color];
    return `<g transform="translate(${x1} ${y1}) rotate(${(ang * 180) / Math.PI})" opacity="${fl.color === "amarillo" ? 0.75 : 0.88}">
      <line x1="0.18" y1="0" x2="${fin}" y2="0" stroke="${c}" stroke-width="${fl.color === "amarillo" ? 0.13 : 0.17}" stroke-linecap="round"/>
      <polygon points="${L - 0.08},0 ${fin - 0.06},-0.27 ${fin - 0.06},0.27" fill="${c}"/></g>`;
  }).join("");
  tab.insertAdjacentHTML("beforeend", `<svg class="flechas" viewBox="0 0 8 8" aria-hidden="true">${svg}</svg>`);
}

$("ent-pistas").addEventListener("click", () => {
  pistasVisibles = !pistasVisibles;
  $("ent-pistas").setAttribute("aria-pressed", String(pistasVisibles));
  $("ent-pistas").textContent = pistasVisibles ? "💡 Ocultar sugerencias" : "💡 Ver mejores jugadas";
  if (pistasVisibles) { if (analisisTurno?.fen === partida.fen) mostrarPistas(); else entrenadorTuTurno(); }
  else { flechas = flechas.filter((f) => f.color === "naranja"); pintarFlechas(); }
});

// Deshacer: regresa a antes de tu última jugada
$("ent-deshacer").addEventListener("click", () => {
  if (!partida?.local || ocupadoEntrenador || pensandoMaquina) return;
  const jug = partida.jugadas.slice();
  const miColorAhora = miColor();
  const reponer = (lista) => { const c = new Chess(); lista.forEach((j) => c.move(j.san)); return c; };
  let quitar = 0;
  // Quita hasta que vuelva a ser tu turno, sin pasar del inicio de la lección
  const minimo = 0;
  do { quitar++; } while (jug.length - quitar > minimo && reponer(jug.slice(0, jug.length - quitar)).turn() !== miColorAhora);
  if (jug.length - quitar < minimo) return avisar("Ya estás al inicio de la lección.");
  const nuevas = jug.slice(0, jug.length - quitar);
  const c = reponer(nuevas);
  if (c.turn() !== miColorAhora) return avisar("No hay jugadas tuyas para deshacer.");
  partida = { ...partida, fen: c.fen(), jugadas: nuevas, estado: "jugando", resultado: null, motivo: null, version: partida.version + 1, ultimo_tick: new Date(ahoraServidor()).toISOString(), ayudas: (partida.ayudas || 0) + 1 };
  flechas = []; analisisTurno = null; vistaIndice = null;
  guardarLocal();
  cerrarFinal?.();
  dibujar();
  tarjeta("", `<span class="ent-veredicto">↶ Jugada deshecha</span><p>Piénsalo de nuevo. Puedes tocar «Ver mejores jugadas» si quieres una pista.</p>`);
  $("ent-amenaza").classList.add("oculto");
  entrenadorTuTurno();
});

// ---------- Lecciones guiadas: la apertura se juega sola, paso a paso, con explicación ----------
async function reproducirLeccion(leccion) {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  ocupadoEntrenador = true;
  enviando = true;   // nadie mueve mientras se reproduce la lección
  $("ent-deshacer").disabled = true;
  tarjeta("", `<span class="ent-paso">LECCIÓN · ${esc(leccion.nivel.toUpperCase())}</span><span class="ent-veredicto">${esc(leccion.nombre)}</span><p>${esc(leccion.intro)}</p>`);
  await espera(2200);
  for (let i = 0; i < leccion.pasos.length; i++) {
    if (!partida?.local || partida.leccion !== leccion.id) return;
    const [san, texto] = leccion.pasos[i];
    const c = new Chess(partida.fen);
    const m = c.move(san);
    flechas = [{ de: m.from, a: m.to, color: "azul" }];
    pintarFlechas();
    tarjeta("", `<span class="ent-paso">PASO ${i + 1} DE ${leccion.pasos.length}</span><span class="ent-veredicto">${Math.floor(i / 2) + 1}.${i % 2 ? ".." : ""} ${esc(sanEs(m.san))}</span><p>${esc(texto)}</p>`);
    await espera(1300);
    const nueva = aplicarLocal(m.from, m.to, m.promotion);
    partida = { ...nueva, optimista: false, version: partida.version + 1, ultimo_tick: new Date(ahoraServidor()).toISOString() };
    guardarLocal();
    sonido("turno");
    dibujar();
    pintarApertura();
    await espera(1500);
  }
  ocupadoEntrenador = false;
  enviando = false;
  $("ent-deshacer").disabled = false;
  dibujar();
  const sug = uciDeSan(partida.fen, leccion.sugerencia);
  flechas = sug ? [{ de: sug.slice(0, 2), a: sug.slice(2, 4), color: "verde" }] : [];
  pintarFlechas();
  const a = apertura(partida.jugadas);
  tarjeta("mejor", `<span class="ent-veredicto">🎯 ¡Ahora tú!</span><p>${esc(leccion.cierre)}</p>${a ? `<p>📖 <strong>${esc(a.nombre)}</strong>: ${esc(a.idea)}</p>` : ""}<p>Desde aquí la partida sigue contra la Máquina y yo te voy comentando.</p>`);
  entrenadorTuTurno();
}
// Texto de la lección para la jugada número i (si coincide con la lección)
function textoLeccion(i, san) {
  const l = partida?.leccion ? LECCIONES.find((x) => x.id === partida.leccion) : null;
  if (!l || !l.pasos[i] || limpiaSan(l.pasos[i][0]) !== limpiaSan(san || "")) return "";
  const enCamino = partida.jugadas.slice(0, i + 1).every((j, k) => l.pasos[k] && limpiaSan(l.pasos[k][0]) === limpiaSan(j.san));
  if (!enCamino) return "";
  return l.pasos[i][1] + (i === l.pasos.length - 1 ? ` — ${l.cierre}` : "");
}
function uciDeSan(fen, san) { try { const m = new Chess(fen).move(san); return m.from + m.to; } catch { return null; } }

function pintarEntrenador() {
  const ver = !!(partida?.local && partida.didactico);
  $("entrenador").classList.toggle("oculto", !ver);
  if (!ver) return;
  pintarTema();
  pintarPlan();
  pintarRepaso();
  pintarNotas();
  pintarFlechas();
}

function terminarLocal(resultado, motivo) {
  if (!partida?.local || partida.estado !== "jugando") return;
  const r = restantes();
  partida = { ...partida, estado: "terminada", resultado, motivo, reloj_blancas: r.w, reloj_negras: r.b, version: partida.version + 1, actualizada: new Date().toISOString() };
  guardarLocal();
  dibujar();
  contarLocal();
}
function contarLocal() {
  if (partida.didactico) return;   // las partidas con entrenador son de práctica
  const rec = recordLocal();
  const n = rec[partida.nivel] || { g: 0, p: 0, t: 0 };
  if (partida.resultado === "½-½") n.t++;
  else if ((partida.resultado === "1-0") === (partida.blancas === yo)) n.g++;
  else n.p++;
  rec[partida.nivel] = n;
  try { LS?.setItem("ajedrez-maquina-record", JSON.stringify(rec)); } catch {}
  marcarCambioLocal();
}

// ---------- Partida ----------
async function recargar(id) {
  const { data } = await sb.from("partidas").select("*").eq("id", id).single();
  return data;
}

async function abrirPartida(id) {
  if (id === MAQUINA) return abrirLocal();
  document.body.classList.remove("sin-reloj", "vs-maquina");
  $("entrenador").classList.add("oculto");
  mostrar("partida");
  const data = await recargar(id);
  if (!data) {
    avisar("No encontramos esa partida.");
    history.replaceState(null, "", "./");
    return mostrar("inicio");
  }
  partida = data;
  await cargarNombres([partida.blancas, partida.negras, partida.reservada_para]);
  cargarChat(id);
  pintarMesaPartida();
  pintarLineaPartida();
  dibujar();

  cerrarVideo();
  if (canal) sb.removeChannel(canal);
  canal = sb
    .channel(`partida-${id}`)
    .on("broadcast", { event: "jugada" }, ({ payload }) => aplicarRemota(payload))
    .on("broadcast", { event: "rtc" }, ({ payload }) => recibirRtc(payload))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "mensajes", filter: `partida=eq.${id}` }, ({ new: m }) => agregarMensaje(m, true))
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
        canalListo = true;
        revisarVideo();
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
    avisar("Link copiado. Mándaselo por WhatsApp o por donde quieras.");
  } catch {
    avisar(location.href);
  }
});

$("rendirse").addEventListener("click", async () => {
  if (!confirm("¿Seguro que quieres rendirte?")) return;
  if (partida.local) return terminarLocal(miColor() === "w" ? "0-1" : "1-0", "abandono");
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
  if (motivo === "cancelada") {
    const quien = partida.pausa_por === yo ? "Cancelaste" : `${nombres[partida.pausa_por] || "Tu rival"} canceló`;
    return `${quien} la partida${partida.pausa_motivo && partida.pausa_motivo !== "Cancelada" ? `: «${partida.pausa_motivo}»` : ""}. No cuenta en la mesa.`;
  }
  if (resultado === "½-½") return "La partida terminó en tablas.";
  const ganador = resultado === "1-0" ? partida.blancas : partida.negras;
  const quien = ganador === yo ? "Ganaste" : `Ganó ${nombres[ganador] || "tu rival"}`;
  const porque = motivo === "tiempo" ? "por tiempo" : motivo === "abandono" ? "por abandono" : "por jaque mate";
  return `${quien} ${porque}.`;
}

// ---------- Reloj ----------
const avisosTiempo = new Set();
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
  if (partida.estado === "pausada") pintarCuentaPausa();
  const r = restantes();
  const turno = partida.fen.split(" ")[1];
  for (const c of ["w", "b"]) {
    const el = $(`reloj-${c}`);
    if (!el) continue;
    el.textContent = formato(r[c]);
    el.classList.toggle("activo", partida.estado === "jugando" && turno === c);
    const total = (partida.minutos || 10) * 60000;
    const umbral = Math.min(30000, total * 0.15);
    el.classList.toggle("poco", partida.estado === "jugando" && r[c] < umbral);
    el.classList.toggle("critico", partida.estado === "jugando" && r[c] < 10000);
    const barra = $(`barra-${c}`);
    if (barra) barra.style.transform = `scaleX(${Math.min(1, r[c] / total)})`;
    // Aviso único cuando a mí me queda poco
    if (c === miColor() && partida.estado === "jugando" && r[c] < umbral && r[c] > 0 && !avisosTiempo.has(partida.id)) {
      avisosTiempo.add(partida.id);
      avisar(`¡Ojo! Te quedan ${Math.ceil(r[c] / 1000)} segundos.`);
      sonido("tiempo");
    }
  }
  const color = miColor();
  if (partida.local) {
    if (partida.estado === "jugando" && r[turno] <= 0) terminarLocal(turno === "w" ? "0-1" : "1-0", "tiempo");
    return;
  }
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

// ---------- Material y HUD ----------
const VALOR = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const INICIAL = { p: 8, n: 2, b: 2, r: 2, q: 1 };
function contarMaterial(juego) {
  const hay = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  const material = { w: 0, b: 0 };
  for (const fila of juego.board()) for (const c of fila) {
    if (!c || c.type === "k") continue;
    hay[c.color][c.type]++;
    material[c.color] += VALOR[c.type];
  }
  // capturas[c] = piezas del rival que "c" se comió
  const capturas = { w: [], b: [] };
  for (const t of ["q", "r", "b", "n", "p"]) {
    for (let i = 0; i < Math.max(0, INICIAL[t] - hay.b[t]); i++) capturas.w.push(t);
    for (let i = 0; i < Math.max(0, INICIAL[t] - hay.w[t]); i++) capturas.b.push(t);
  }
  return { capturas, material };
}

function pintarHud(juego, color, turno, material) {
  const chips = [];
  const n = Math.floor(partida.jugadas.length / 2) + 1;
  if (partida.estado === "jugando") {
    chips.push(`<span>Jugada ${n}</span>`);
    if (juego.inCheck()) chips.push(`<span class="alerta">¡Jaque!</span>`);
    const dif = material.w - material.b;
    chips.push(`<span>${dif === 0 ? "Material parejo" : `${dif > 0 ? "Blancas" : "Negras"} +${Math.abs(dif)}`}</span>`);
  } else if (partida.estado === "terminada" && partida.jugadas.length) {
    chips.push(`<span>${partida.jugadas.length} jugadas en total</span>`);
  }
  $("hud").innerHTML = chips.join("");
}

// ---------- Celebración de fin de partida ----------
const estadoVisto = {};
const celebradas = new Set();
const MOTIVO = { "jaque mate": "por jaque mate", tiempo: "por tiempo", abandono: "por abandono", tablas: "", acuerdo: "" };

function revisarFinal() {
  const antes = estadoVisto[partida.id];
  estadoVisto[partida.id] = partida.estado;
  if (partida.estado !== "terminada" || !partida.resultado || !partida.negras || celebradas.has(partida.id)) return;
  const reciente = ahoraServidor() - new Date(partida.actualizada).getTime() < 3 * 60000;
  if (antes === "jugando" || (antes === undefined && reciente)) {
    celebradas.add(partida.id);
    celebrar();
  }
}

function medallaSVG(colorRey, apagada) {
  const a = apagada ? "#9B7A5C" : "#F3D98E", b = apagada ? "#5C3B24" : "#B8862F", c = apagada ? "#3A281C" : "#7A5520";
  const puntos = Array.from({ length: 24 }, (_, i) => {
    const ang = (i / 24) * Math.PI * 2;
    return `<circle cx="${60 + Math.cos(ang) * 50}" cy="${60 + Math.sin(ang) * 50}" r="2.2" fill="${a}" opacity="0.9"/>`;
  }).join("");
  return `<svg viewBox="0 0 120 120"><defs><radialGradient id="mg" cx="40%" cy="32%" r="75%"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient></defs>` +
    `<circle cx="60" cy="60" r="58" fill="url(#mg)"/><circle cx="60" cy="60" r="44" fill="none" stroke="${c}" stroke-opacity="0.55" stroke-width="2"/>${puntos}` +
    `<g transform="translate(36 28) scale(1.2)">${piezaSVG("k", colorRey).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g></svg>`;
}

function celebrar() {
  const color = miColor();
  const tablas = partida.resultado === "½-½";
  const gana = partida.resultado === "1-0" ? "w" : "b";
  const ganador = gana === "w" ? partida.blancas : partida.negras;
  const perdedor = gana === "w" ? partida.negras : partida.blancas;
  const yoGane = !tablas && color === gana;
  const yoPerdi = !tablas && color && color !== gana;
  const motivo = MOTIVO[partida.motivo] ?? "";
  const final = $("final");
  final.classList.toggle("derrota", yoPerdi || tablas);

  let titulo, texto, a, b, colorRey;
  if (tablas) {
    titulo = "Tablas"; colorRey = "w";
    texto = `Nadie cedió. <strong>${esc(nombres[partida.blancas] || "Blancas")}</strong> y <strong>${esc(nombres[partida.negras] || "Negras")}</strong> quedan a mano.`;
    a = "Mano a mano"; b = "½";
  } else if (yoGane) {
    titulo = "¡Victoria!"; colorRey = gana;
    texto = `Le ganaste a <strong>${esc(nombres[perdedor] || "tu rival")}</strong> ${motivo}.`;
    a = partida.motivo === "jaque mate" ? "¡Jaque mate!" : partida.motivo === "tiempo" ? "¡Al filo del reloj!" : "¡Se rindió!";
    b = "+1<br>punto";
  } else if (yoPerdi) {
    titulo = "Derrota"; colorRey = gana;
    texto = `<strong>${esc(nombres[ganador] || "Tu rival")}</strong> se llevó esta ${motivo}. La revancha está a un clic.`;
    a = "Bien jugado"; b = "Otra<br>vez";
  } else {
    titulo = `¡Ganó ${esc(nombres[ganador] || "")}!`; colorRey = gana;
    texto = `Venció a <strong>${esc(nombres[perdedor] || "su rival")}</strong> ${motivo}.`;
    a = partida.motivo === "jaque mate" ? "¡Jaque mate!" : "¡Victoria!"; b = "+1<br>punto";
  }
  $("final-titulo").innerHTML = titulo;
  $("final-texto").innerHTML = texto;
  $("final-medalla").innerHTML = medallaSVG(colorRey, yoPerdi);
  $("sticker-a").textContent = a;
  $("sticker-b").innerHTML = b;
  $("sticker-c").innerHTML = piezaSVG(yoPerdi ? "p" : tablas ? "n" : "q", colorRey);
  const jug = Math.ceil(partida.jugadas.length / 2);
  const r = restantes();
  const datos = [`${jug} ${jug === 1 ? "jugada" : "jugadas"}`, `Partida de ${textoTiempo(partida.minutos || 10)}`];
  if (color && !tablas) datos.push(`Te sobró ${formato(r[color])}`);
  $("final-datos").innerHTML = datos.map((d) => `<span>${d}</span>`).join("");
  $("final-revancha").classList.toggle("oculto", !color);
  // reiniciar animaciones
  final.classList.add("oculto"); void final.offsetWidth; final.classList.remove("oculto");
  $("final-revancha").focus({ preventScroll: true });
  if (!yoPerdi) lanzarConfeti(tablas ? 70 : 180);
  sonido(yoPerdi ? "derrota" : tablas ? "tablas" : "victoria");
}

$("final-tablero").addEventListener("click", cerrarFinal);
$("final").addEventListener("click", (e) => { if (e.target.id === "final") cerrarFinal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("final").classList.contains("oculto")) cerrarFinal(); });
function cerrarFinal() { $("final").classList.add("oculto"); confeti = []; }
$("final-revancha").addEventListener("click", async () => {
  if (partida.local) { cerrarFinal(); return empezarLocal(configLocal()); }
  const rival = partida.blancas === yo ? partida.negras : partida.blancas;
  cerrarFinal();
  const ok = await crearMesa(partida.minutos || 10, rival);
  if (ok) avisar(`Mesa nueva apartada para ${nombres[rival] || "tu rival"}.`);
});

let confeti = [];
function lanzarConfeti(cuantas) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const lienzo = $("confeti");
  const ctx = lienzo.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  lienzo.width = innerWidth * dpr; lienzo.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colores = ["#CDA54E", "#E3C77E", "#F3EADA", "#C9603F", "#8A5E3C", "#FFF4DE"];
  confeti = Array.from({ length: cuantas }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 160, y: innerHeight * 0.42,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 5,
    w: 6 + Math.random() * 7, h: 4 + Math.random() * 5, giro: Math.random() * 6, vg: (Math.random() - 0.5) * 0.35,
    color: colores[(Math.random() * colores.length) | 0], vida: 0,
  }));
  const paso = () => {
    if (!confeti.length) return ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const c of confeti) {
      c.vy += 0.32; c.vx *= 0.985; c.x += c.vx; c.y += c.vy; c.giro += c.vg; c.vida++;
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.giro); ctx.scale(1, Math.cos(c.vida * 0.12));
      ctx.fillStyle = c.color; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); ctx.restore();
    }
    confeti = confeti.filter((c) => c.y < innerHeight + 40);
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// ---------- Dibujo ----------
function dibujar() {
  const enRepaso = !!(partida.local && vistaIndice !== null);
  const juego = enRepaso ? juegoEn(vistaIndice) : new Chess(partida.fen);
  const color = miColor();
  const volteado = color === "b";
  const turno = juego.turn();
  const ultima = enRepaso ? partida.jugadas[vistaIndice - 1] : partida.jugadas.at(-1);

  const estado = $("estado");
  const jugando = partida.estado === "jugando";
  $("invitar").classList.toggle("oculto", !(partida.estado === "esperando" && color === "w"));
  if (partida.estado === "esperando" && color === "w") pintarLlamables();
  else colgarTodas();
  actualizarPresencia();
  $("unirse").classList.toggle("oculto", !(partida.estado === "esperando" && color !== "w" && (!partida.reservada_para || partida.reservada_para === yo)));
  $("acciones-juego").classList.toggle("oculto", !(jugando && color));
  pintarTablas(color);
  // Quien solo mira la partida no ve el chat de los jugadores (ni la cámara)
  $("chat").classList.toggle("oculto", !color);
  $("form-chat").classList.toggle("oculto", !color);
  textoChatVacio();
  avisarTurno(color, turno);
  pintarControlEstado(color);
  $("nueva").classList.toggle("oculto", partida.estado !== "terminada" && !!color);
  if (partida.estado === "esperando") {
    estado.textContent = color === "w"
      ? (partida.reservada_para
          ? `Mesa apartada para ${nombres[partida.reservada_para] || "tu rival"}. Llámale si está conectado o mándale el link.`
          : "Esperando rival. Llama a alguien que esté conectado o mándale el link.")
      : `${nombres[partida.blancas] || "Alguien"} te espera en esta mesa.`;
  } else if (partida.estado === "terminada") {
    estado.textContent = textoFinal();
  } else if (partida.estado === "pausada") {
    estado.textContent = "Partida en pausa. Los relojes están detenidos.";
  } else {
    const jaque = juego.inCheck() ? "Jaque. " : "";
    if (!color) estado.textContent = `${jaque}Mueven las ${turno === "w" ? "blancas" : "negras"}.`;
    else estado.textContent = `${jaque}${turno === color ? "Tu turno." : `Turno de ${nombreDe(turno === "w" ? partida.blancas : partida.negras)}.`}`;
  }

  const { capturas, material } = contarMaterial(juego);
  const tira = (c) => {
    const id = c === "w" ? partida.blancas : partida.negras;
    const nombre = id ? nombreDe(id) : "Lugar libre";
    const icono = id ? `<span class="avatar">${cara(id)}</span>` : "";
    const capt = capturas[c].map((t) => piezaSVG(t, c === "w" ? "b" : "w")).join("");
    const ventaja = material[c] > material[c === "w" ? "b" : "w"] ? `<span class="ventaja">+${material[c] - material[c === "w" ? "b" : "w"]}</span>` : "";
    return `<div>${icono}<div class="lado"><strong>${esc(nombre)}</strong><small>${c === "w" ? "Blancas" : "Negras"}</small>` +
      `<span class="capturas" aria-label="Piezas capturadas">${capt}${ventaja}</span></div></div>` +
      `<span class="reloj-caja"><span class="reloj" id="reloj-${c}">--:--</span><span class="reloj-barra"><i id="barra-${c}"></i></span></span>`;
  };
  $("arriba").innerHTML = tira(volteado ? "w" : "b");
  $("abajo").innerHTML = tira(volteado ? "b" : "w");

  const tablero = $("tablero");
  tablero.innerHTML = "";
  const puedoMover = jugando && color === turno && !enviando && !partida.optimista && !enRepaso;
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
      if (pieza && pieza.type === "k") {
        if (jugando && juego.inCheck() && pieza.color === turno) btn.classList.add("jaque");
        if (partida.estado === "terminada" && partida.resultado && partida.resultado !== "½-½") {
          const gana = partida.resultado === "1-0" ? "w" : "b";
          btn.classList.add(pieza.color === gana ? "rey-ganador" : "rey-vencido");
        }
      }
      if (puedoMover && ((pieza && pieza.color === color) || destinos().includes(casilla))) btn.classList.add("jugable");
      btn.setAttribute("aria-label", casilla + (pieza ? "" : ", vacía"));
      if (pieza) {
        const div = document.createElement("div");
        const d = dibujoPieza(estiloPiezas, pieza.type, pieza.color);
        div.className = d.clase;
        div.innerHTML = d.html;
        if (d.posicion) div.style.backgroundPosition = d.posicion;
        btn.appendChild(div);
      }
      btn.addEventListener("click", () => tocar(casilla, juego, puedoMover, color));
      tablero.appendChild(btn);
    }
  }
  aplicarAngulo();
  actualizarRelojes();
  pintarHud(juego, color, turno, material);
  estado.classList.toggle("cierre", partida.estado === "terminada");
  revisarFinal();
  revisarVideo();
  if (partida.local) ajustarVistaLocal(color, turno);
  if (mesaPartidaDe && mesaPartidaDe !== `${partida.id}:${partida.estado}`) pintarMesaPartida();

  // Coordenadas por fuera del tablero (letras abajo, números a la izquierda), según tu lado
  const coords = document.createElement("div");
  coords.className = "coords";
  coords.setAttribute("aria-hidden", "true");
  let htmlC = "";
  for (let i = 0; i < 8; i++) {
    const letra = COLUMNAS[volteado ? 7 - i : i];
    const numero = volteado ? i + 1 : 8 - i;
    htmlC += `<span class="crd-l" style="left:${(i + 0.5) * 12.5}%">${letra}</span><span class="crd-n" style="top:${(i + 0.5) * 12.5}%">${numero}</span>`;
  }
  coords.innerHTML = htmlC;
  tablero.appendChild(coords);

  const lista = $("jugadas");
  lista.innerHTML = "";
  if (!partida.jugadas.length) lista.innerHTML = '<li class="vacio">Todavía no hay jugadas.</li>';
  for (let i = 0; i < partida.jugadas.length; i += 2) {
    const li = document.createElement("li");
    const b = partida.jugadas[i + 1];
    const marca = (k) => (partida.local && vistaIndice === k ? ' class="vista"' : "");
    li.innerHTML = `<span>${i / 2 + 1}.</span><span data-ir="${i + 1}"${marca(i + 1)}>${partida.jugadas[i].san}</span><span${b ? ` data-ir="${i + 2}"${marca(i + 2)}` : ""}>${b ? b.san : ""}</span>`;
    lista.appendChild(li);
  }
  lista.classList.toggle("navegable", !!partida.local);
}

function tocar(casilla, juego, puedoMover, color) {
  // Si estabas repasando, tocar el tablero te regresa a la partida para seguir jugando
  if (partida?.local && vistaIndice !== null) {
    irA(null);
    return avisar("Volviste a la posición actual: ya puedes mover. Para jugar desde una posición anterior usa «Jugar desde aquí».");
  }
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
  if (partida.local) return moverLocal(desde, hacia, promocion);
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

// ---------- Vista personal: tablero y piezas (solo en esta pestaña, sin memoria) ----------
let estiloTablero = "nogal";
let estiloPiezas = "ilustradas";
document.body.insertAdjacentHTML("beforeend", DEFS_3D);
function pintarSelectores() {
  $("elegir-tablero").innerHTML = Object.entries(TABLEROS).map(([k, t]) =>
    `<button type="button" data-tablero="${k}" aria-pressed="${k === estiloTablero}">${t.nombre}</button>`).join("");
  $("elegir-piezas").innerHTML = Object.entries(PIEZAS).map(([k, n]) =>
    `<button type="button" data-piezas="${k}" aria-pressed="${k === estiloPiezas}">${n}</button>`).join("");
}
function aplicarTablero() {
  const t = TABLEROS[estiloTablero];
  const m = $("marco");
  m.style.setProperty("--casilla-clara", t.clara);
  m.style.setProperty("--casilla-oscura", t.oscura);
  m.style.setProperty("--marca-clara", t.marcaClara);
  m.style.setProperty("--marca-oscura", t.marcaOscura);
  m.style.background = t.marco;
}
$("elegir-tablero").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tablero]");
  if (!b) return;
  estiloTablero = b.dataset.tablero;
  pintarSelectores();
  aplicarTablero();
});
$("elegir-piezas").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-piezas]");
  if (!b) return;
  estiloPiezas = b.dataset.piezas;
  pintarSelectores();
  if (partida) dibujar();
});
pintarSelectores();
aplicarTablero();

// ---------- Ofrecer tablas ----------
function pintarTablas(color) {
  const vigente = partida.estado === "jugando" && partida.tablas_ofrece && partida.tablas_version === partida.version;
  const mia = vigente && partida.tablas_ofrece === yo;
  const deRival = vigente && color && partida.tablas_ofrece !== yo;
  $("oferta-tablas").classList.toggle("oculto", !deRival);
  if (deRival) $("oferta-texto").innerHTML = `<strong>${esc(nombres[partida.tablas_ofrece] || "Tu rival")}</strong> te ofrece tablas. Si aceptas, la partida termina empatada.`;
  const btn = $("ofrecer-tablas");
  btn.disabled = !!mia || !!deRival;
  btn.textContent = mia ? "Tablas ofrecidas…" : "Ofrecer tablas";
}
$("ofrecer-tablas").addEventListener("click", async () => {
  const { error } = await sb.rpc("ofrecer_tablas", { p: partida.id });
  if (error) return avisar("No se pudo ofrecer tablas. Intenta de nuevo.");
  avisar("Ofreciste tablas. Si tu rival mueve, la oferta se cancela.");
});
async function responderTablas(acepta) {
  const { error } = await sb.rpc("responder_tablas", { p: partida.id, acepta });
  if (error) avisar("Esa oferta ya no está vigente.");
}
$("tablas-si").addEventListener("click", () => responderTablas(true));
$("tablas-no").addEventListener("click", () => responderTablas(false));

// ---------- Chat de la partida ----------
let chatDe = null;
const vistos = new Set();
async function cargarChat(id) {
  chatDe = id;
  vistos.clear();
  $("mensajes").innerHTML = "";
  if (partida?.local) return;
  if (!miColor()) return;
  const { data } = await sb.from("mensajes").select("*").eq("partida", id).order("id", { ascending: true }).limit(200);
  if (chatDe !== id) return;
  (data || []).forEach((m) => agregarMensaje(m, false));
  if (!(data || []).length) $("mensajes").innerHTML = '<p class="vacio" id="chat-vacio"></p>';
  textoChatVacio();
}
function agregarMensaje(m, nuevo) {
  if (!m || m.partida !== chatDe || vistos.has(m.id)) return;
  vistos.add(m.id);
  $("chat-vacio")?.remove();
  const mio = m.autor === yo;
  const caja = $("mensajes");
  const el = document.createElement("div");
  el.className = `burbuja ${mio ? "mia" : "suya"}`;
  el.innerHTML = (mio ? "" : `<small>${esc(nombres[m.autor] || "Jugador")}</small>`) + esc(m.texto);
  caja.appendChild(el);
  caja.scrollTop = caja.scrollHeight;
  if (nuevo && !mio) {
    sonido("mensaje");
    if (document.hidden) avisoPestana(`💬 ${nombres[m.autor] || "Tu rival"} te escribió`);
  }
}
$("form-chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chat-texto");
  const texto = input.value.trim();
  if (!texto || !partida) return;
  input.value = "";
  const { data, error } = await sb.from("mensajes").insert({ partida: partida.id, texto }).select().single();
  if (error) { input.value = texto; return avisar("No se pudo enviar el mensaje."); }
  agregarMensaje(data, false);
});

function textoChatVacio() {
  const el = $("chat-vacio");
  if (!el || !partida) return;
  const c = miColor();
  const rival = c === "w" ? partida.negras : c === "b" ? partida.blancas : null;
  el.textContent = !c ? "Todavía no hay mensajes."
    : rival ? `Saluda a ${nombres[rival] || "tu rival"}.`
    : partida.reservada_para ? `Cuando llegue ${nombres[partida.reservada_para] || "tu rival"}, aquí podrán platicar.`
    : "Cuando llegue tu rival, aquí podrán platicar.";
}

// ---------- Avisos ----------
let jugadasVistas = { id: null, n: 0 };
function avisarTurno(color, turno) {
  const n = partida.jugadas.length;
  const cambio = jugadasVistas.id === partida.id && n > jugadasVistas.n;
  jugadasVistas = { id: partida.id, n };
  if (!cambio || !color || partida.estado !== "jugando" || turno !== color) return;
  sonido("turno");
  if (document.hidden) avisoPestana("♟ Te toca mover");
}
function avisoPestana(texto) { document.title = texto; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Ajedrez entre Amigos"; });

// ---------- Mesa del club junto al tablero (solo informativa) ----------
let mesaPartidaDe = null;
async function pintarMesaPartida() {
  if (!partida) return;
  const id = partida.id;
  const a = partida.blancas, b = partida.local ? null : partida.negras;
  const [mesaR, caraR] = await Promise.all([
    sb.rpc("mesa_del_club"),
    b ? sb.from("partidas").select("blancas, negras, resultado").eq("estado", "terminada").not("resultado", "is", null)
          .or(`and(blancas.eq.${a},negras.eq.${b}),and(blancas.eq.${b},negras.eq.${a})`)
      : Promise.resolve({ data: [] }),
  ]);
  if (!partida || partida.id !== id) return;
  mesaPartidaDe = `${id}:${partida.estado}`;
  const filas = (mesaR.data || []).filter((m) => m.pj > 0 || m.id === a || m.id === b);
  let pos = 0, previo = null;
  const conPos = filas.map((m, i) => { if (m.pts !== previo) { pos = i + 1; previo = m.pts; } return { ...m, pos }; });
  const visibles = conPos.filter((m, i) => i < 8 || m.id === a || m.id === b);
  const sobran = conPos.length - visibles.length;
  $("mesa-partida").innerHTML = visibles.map((m) =>
    `<li class="${m.id === a || m.id === b ? "juega" : ""}"><span class="pos">${m.pos}</span><span class="nom">${esc(m.id === yo ? "Tú" : m.nombre)}</span><span class="pts">${m.pts}</span></li>`).join("") +
    (sobran > 0 ? `<li class="mas">y ${sobran} más</li>` : "") ||
    '<li class="mas">Aún no hay partidas terminadas.</li>';
  const cara = caraR.data || [];
  const caja = $("cara-a-cara");
  if (!b || !cara.length) { caja.classList.add("oculto"); return; }
  let ga = 0, gb = 0;
  for (const x of cara) {
    if (x.resultado === "½-½") continue;
    const gano = x.resultado === "1-0" ? x.blancas : x.negras;
    if (gano === a) ga++; else if (gano === b) gb++;
  }
  const t = cara.length - ga - gb;
  const na = a === yo ? "Tú" : nombres[a] || "Blancas", nb = b === yo ? "Tú" : nombres[b] || "Negras";
  caja.innerHTML = `<span>Cara a cara</span><strong>${ga} – ${gb}</strong><span>${esc(na)} vs ${esc(nb)}${t ? ` · ${t} ${t === 1 ? "tablas" : "tablas"}` : ""}</span>`;
  caja.classList.remove("oculto");
}

// ---------- Cámara y micrófono (WebRTC entre los dos jugadores) ----------
// Señalización por el canal de la partida; el video viaja directo entre navegadores.
const ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
let canalListo = false;
let pc = null;            // conexión con el rival
let videoDe = null;       // id de la partida con video activo
let pendientesIce = [];
let iceAdelantados = [];  // candidatos que llegan antes que su oferta
let sesionRtc = 0;       // identifica cada negociación para ignorar mensajes viejos
let ultimaOferta = 0;
let local = { video: null, audio: null };
let enviadores = { video: null, audio: null };
let flujoRival = null;

function rivalDe() {
  const c = miColor();
  return c === "w" ? partida.negras : c === "b" ? partida.blancas : null;
}
function enviarRtc(datos) {
  if (canal && canalListo) canal.send({ type: "broadcast", event: "rtc", payload: { ...datos, de: yo, partida: partida.id } }).catch?.(() => {});
}

// Muestra el panel y arranca la señalización cuando ya hay dos jugadores
function revisarVideo() {
  if (!partida) return;
  if (partida.local) { $("video").classList.add("oculto"); return; }
  const rival = rivalDe();
  const hay = !!rival && partida.estado !== "esperando";
  $("video").classList.toggle("oculto", !hay);
  if (!hay || !canalListo) return;
  if (videoDe !== partida.id) {
    videoDe = partida.id;
    $("rival-nombre").textContent = nombres[rival] || "Rival";
    $("rival-ficha").innerHTML = cara(rival);
    $("rival-estado").textContent = "Cámara apagada";
    pintarMedios({ cam: false, mic: false });
    enviarRtc({ tipo: "hola" });
  }
}

function nuevaConexion() {
  if (pc) pc.close();
  pendientesIce = [];
  pc = new RTCPeerConnection({ iceServers: ICE });
  // Un canal de audio y uno de video desde el inicio: encender o apagar no requiere renegociar
  enviadores.audio = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
  enviadores.video = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
  if (local.audio) enviadores.audio.replaceTrack(local.audio);
  if (local.video) enviadores.video.replaceTrack(local.video);
  flujoRival = new MediaStream();
  $("video-rival").srcObject = flujoRival;
  pc.ontrack = (e) => {
    flujoRival.addTrack(e.track);
    e.track.onunmute = () => { if (rivalCam) $("rival-apagado").classList.add("oculto"); };
    const v = $("video-rival");
    v.muted = false;
    // Si el navegador bloquea el sonido automático, se muestra el video en silencio y un botón para activarlo
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); $("activar-sonido").classList.remove("oculto"); });
  };
  pc.onicecandidate = (e) => { if (e.candidate) enviarRtc({ tipo: "ice", sesion: sesionRtc, candidato: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === "connected" && rivalCam) $("rival-estado").textContent = "Cámara encendida";
    if (pc && pc.connectionState === "failed") $("video-nota").textContent = "No se pudo conectar el video directo entre ustedes (puede ser la red). El juego sigue normal.";
  };
  return pc;
}

async function ofrecer() {
  // Evita ofertas repetidas cuando llegan dos saludos casi juntos
  if (Date.now() - ultimaOferta < 1500) return;
  ultimaOferta = Date.now();
  sesionRtc = Date.now();
  nuevaConexion();
  const oferta = await pc.createOffer();
  await pc.setLocalDescription(oferta);
  enviarRtc({ tipo: "oferta", sesion: sesionRtc, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
}

async function recibirRtc(m) {
  if (!partida || m.partida !== partida.id || m.de === yo || m.de !== rivalDe()) return;
  try {
    if (m.tipo === "hola") {
      // Las blancas siempre inician; las negras contestan el saludo para que las blancas se enteren
      if (miColor() === "w") await ofrecer();
      else if (!m.eco) enviarRtc({ tipo: "hola", eco: true });
      enviarRtc({ tipo: "medios", cam: !!local.video, mic: !!local.audio });
    } else if (m.tipo === "oferta" && miColor() === "b") {
      sesionRtc = m.sesion;
      nuevaConexion();
      pendientesIce = iceAdelantados.filter((x) => x.sesion === m.sesion).map((x) => x.candidato);
      iceAdelantados = [];
      await pc.setRemoteDescription(m.sdp);
      for (const c of pendientesIce) await pc.addIceCandidate(c).catch(() => {});
      pendientesIce = [];
      const resp = await pc.createAnswer();
      await pc.setLocalDescription(resp);
      enviarRtc({ tipo: "respuesta", sesion: sesionRtc, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } else if (m.tipo === "respuesta" && pc && miColor() === "w" && m.sesion === sesionRtc && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(m.sdp);
      for (const c of pendientesIce) await pc.addIceCandidate(c).catch(() => {});
      pendientesIce = [];
    } else if (m.tipo === "ice") {
      if (m.sesion !== sesionRtc) {
        if (m.sesion > sesionRtc) iceAdelantados.push(m);
        return;
      }
      if (pc && pc.remoteDescription) await pc.addIceCandidate(m.candidato).catch(() => {});
      else pendientesIce.push(m.candidato);
    } else if (m.tipo === "medios") {
      pintarMedios(m);
    }
  } catch (e) {
    console.warn("Video:", e);
  }
}

let rivalCam = false;
function pintarMedios(m) {
  rivalCam = !!m.cam;
  const v = $("video-rival");
  const llegando = rivalCam && v.srcObject && v.srcObject.getVideoTracks().some((t) => !t.muted);
  $("rival-apagado").classList.toggle("oculto", !!llegando);
  if (rivalCam && !llegando) $("rival-estado").textContent = "Conectando cámara…";
  $("rival-mic-off").classList.toggle("oculto", !!m.mic || !m.cam && !m.mic);
  if (!rivalCam) $("rival-estado").textContent = m.mic ? "Solo micrófono" : "Cámara apagada";
}

async function alternar(tipo) {
  const boton = tipo === "video" ? $("btn-camara") : $("btn-mic");
  if (local[tipo]) {
    local[tipo].stop();
    local[tipo] = null;
    if (enviadores[tipo]) await enviadores[tipo].replaceTrack(null).catch(() => {});
  } else {
    try {
      const flujo = await navigator.mediaDevices.getUserMedia(tipo === "video"
        ? { video: { width: { ideal: 640 }, height: { ideal: 480 } } }
        : { audio: { echoCancellation: true, noiseSuppression: true } });
      local[tipo] = tipo === "video" ? flujo.getVideoTracks()[0] : flujo.getAudioTracks()[0];
      if (enviadores[tipo]) await enviadores[tipo].replaceTrack(local[tipo]).catch(() => {});
    } catch {
      return avisar(tipo === "video" ? "No se pudo usar la cámara. Revisa el permiso del navegador." : "No se pudo usar el micrófono. Revisa el permiso del navegador.");
    }
  }
  boton.setAttribute("aria-pressed", String(!!local[tipo]));
  if (tipo === "video") {
    $("video-yo").srcObject = local.video ? new MediaStream([local.video]) : null;
    $("yo-apagado").classList.toggle("oculto", !!local.video);
  }
  enviarRtc({ tipo: "medios", cam: !!local.video, mic: !!local.audio });
}
$("video-rival").addEventListener("playing", () => { if (rivalCam) $("rival-apagado").classList.add("oculto"); });
$("btn-camara").addEventListener("click", () => alternar("video"));
$("btn-mic").addEventListener("click", () => alternar("audio"));
$("activar-sonido").addEventListener("click", () => {
  const v = $("video-rival");
  v.muted = false;
  v.play().then(() => $("activar-sonido").classList.add("oculto"), () => {});
});

function cerrarVideo() {
  for (const t of ["video", "audio"]) { if (local[t]) { local[t].stop(); local[t] = null; } }
  if (pc) { pc.close(); pc = null; }
  videoDe = null;
  canalListo = false;
  pendientesIce = [];
  $("btn-camara").setAttribute("aria-pressed", "false");
  $("btn-mic").setAttribute("aria-pressed", "false");
  $("video-yo").srcObject = null;
  $("video-rival").srcObject = null;
  $("yo-apagado").classList.remove("oculto");
  $("video").classList.add("oculto");
}
window.addEventListener("beforeunload", () => { for (const t of ["video", "audio"]) local[t]?.stop(); });

// ---------- Mover tu cámara dentro del recuadro (cada quien la acomoda a su gusto) ----------
let esquinaYo = "tr";
const MARGEN_YO = 8;
function posicionEsquina(esq) {
  const marco = $("caja-yo").parentElement, caja = $("caja-yo");
  const ancho = marco.clientWidth - caja.offsetWidth - MARGEN_YO, alto = marco.clientHeight - caja.offsetHeight - MARGEN_YO;
  return { x: esq.includes("l") ? MARGEN_YO : ancho, y: esq.includes("t") ? MARGEN_YO : alto };
}
function colocarYo() {
  const { x, y } = posicionEsquina(esquinaYo);
  $("caja-yo").style.transform = `translate(${x}px, ${y}px)`;
}
new ResizeObserver(colocarYo).observe($("caja-yo").parentElement);
$("mover-yo").addEventListener("click", (e) => {
  e.stopPropagation();
  esquinaYo = { tr: "br", br: "bl", bl: "tl", tl: "tr" }[esquinaYo];
  colocarYo();
});
(() => {
  const caja = $("caja-yo");
  let arrastre = null;
  caja.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#mover-yo")) return;
    const actual = posicionEsquina(esquinaYo);
    arrastre = { id: e.pointerId, x0: e.clientX - actual.x, y0: e.clientY - actual.y };
    caja.setPointerCapture(e.pointerId);
    caja.classList.add("arrastrando");
  });
  caja.addEventListener("pointermove", (e) => {
    if (!arrastre || e.pointerId !== arrastre.id) return;
    const marco = caja.parentElement;
    const x = Math.min(Math.max(0, e.clientX - arrastre.x0), marco.clientWidth - caja.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - arrastre.y0), marco.clientHeight - caja.offsetHeight);
    caja.style.transform = `translate(${x}px, ${y}px)`;
    arrastre.x = x; arrastre.y = y;
  });
  const soltar = () => {
    if (!arrastre) return;
    const marco = caja.parentElement;
    if (arrastre.x !== undefined) {
      // Se acomoda en la esquina más cercana
      const izq = arrastre.x + caja.offsetWidth / 2 < marco.clientWidth / 2;
      const arriba = arrastre.y + caja.offsetHeight / 2 < marco.clientHeight / 2;
      esquinaYo = (arriba ? "t" : "b") + (izq ? "l" : "r");
    }
    arrastre = null;
    caja.classList.remove("arrastrando");
    colocarYo();
  };
  caja.addEventListener("pointerup", soltar);
  caja.addEventListener("pointercancel", soltar);
})();

// ---------- Pausar, reanudar y cancelar ----------
function puedoReanudar() {
  if (partida.estado !== "pausada" || !miColor()) return false;
  if (partida.pausa_por === yo) return true;
  return !!partida.pausa_hasta && ahoraServidor() >= new Date(partida.pausa_hasta).getTime();
}
function faltaPausa() {
  if (!partida.pausa_hasta) return null;
  return Math.max(0, new Date(partida.pausa_hasta).getTime() - ahoraServidor());
}
const mmss = (ms) => { const t = Math.ceil(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

let estadoSonido = { id: null, estado: null, tablas: null };
function sonidosDeEstado(color) {
  const cancelada = partida.estado === "terminada" && partida.motivo === "cancelada";
  const ahora = cancelada ? "cancelada" : partida.estado;
  const oferta = partida.estado === "jugando" && partida.tablas_ofrece && partida.tablas_version === partida.version && partida.tablas_ofrece !== yo ? partida.tablas_version : null;
  if (estadoSonido.id === partida.id && color) {
    if (ahora !== estadoSonido.estado) {
      if (ahora === "pausada") sonido("pausa");
      else if (ahora === "jugando" && estadoSonido.estado === "pausada") sonido("reanudar");
      else if (ahora === "cancelada") sonido("cancelada");
    }
    if (oferta && oferta !== estadoSonido.tablas) sonido("tablas");
  }
  estadoSonido = { id: partida.id, estado: ahora, tablas: oferta };
}
function pintarControlEstado(color) {
  sonidosDeEstado(color);
  const caja = $("control-estado");
  const cancelada = partida.estado === "terminada" && partida.motivo === "cancelada";
  const visible = !!color && (partida.estado === "jugando" || partida.estado === "pausada" || cancelada);
  caja.classList.toggle("oculto", !visible);
  const pill = $("pill-estado");
  const tipo = cancelada ? "cancelada" : partida.estado === "pausada" ? "pausada" : "jugando";
  pill.className = `pill-estado ${tipo}`;
  // El estado activo siempre a la vista, en grande: PLAYING, el motivo de la pausa o CANCELADA
  $("pill-texto").textContent = tipo === "pausada"
    ? (partida.pausa_motivo || "PAUSA").toUpperCase()
    : { jugando: "PLAYING", cancelada: "CANCELADA" }[tipo];
  pill.disabled = true;
  $("menu-estado").classList.toggle("oculto", !(partida.estado === "jugando" || partida.estado === "pausada"));
  $("menu-pausar").classList.toggle("oculto", partida.estado !== "jugando");
  $("menu-reanudar").classList.toggle("oculto", partida.estado !== "pausada");
  $("reanudar").disabled = !puedoReanudar();
  $("reanudar-nota").textContent = partida.estado !== "pausada" ? "" : puedoReanudar() ? "" :
    `${nombres[partida.pausa_por] || "Tu rival"} la pausó. Podrás reanudarla ${partida.pausa_hasta ? "cuando se cumpla el tiempo" : "cuando regrese"}.`;
  // Aviso sobre el tablero
  const aviso = $("aviso-pausa");
  const enPausa = partida.estado === "pausada";
  aviso.classList.toggle("oculto", !enPausa);
  document.querySelector(".escena").classList.toggle("pausada", enPausa);
  if (enPausa) {
    const quien = partida.pausa_por === yo ? "Pausaste" : `${esc(nombres[partida.pausa_por] || "Tu rival")} pausó`;
    aviso.innerHTML = `<span>⏸ <strong>${quien}</strong>: ${esc(partida.pausa_motivo || "En pausa")} <span class="cuenta" id="cuenta-pausa"></span></span>` +
      (puedoReanudar() ? '<button type="button" class="btn-fila verde" data-reanudar="1">Reanudar</button>' : "");
    pintarCuentaPausa();
  }
}
function pintarCuentaPausa() {
  const el = $("cuenta-pausa");
  if (!el) return;
  const falta = faltaPausa();
  const desde = partida.pausa_desde ? Math.max(0, ahoraServidor() - new Date(partida.pausa_desde).getTime()) : 0;
  el.textContent = falta === null ? `· hace ${mmss(desde)}` : falta > 0 ? `· regresa en ${mmss(falta)}` : "· ya se cumplió el tiempo";
  // Cuando se cumple el tiempo, al rival se le habilita reanudar
  if (falta === 0 && $("reanudar").disabled && puedoReanudar()) dibujar();
}
function cerrarMenuEstado() {}
async function pausar(motivo, minutos) {
  const { error } = await sb.rpc("pausar_partida", { p: partida.id, p_motivo: motivo, p_minutos: minutos || null });
  if (error) return avisar("No se pudo pausar. Intenta de nuevo.");
  cerrarMenuEstado();
  avisar("Partida en pausa. Los relojes se detuvieron.");
}
$("menu-pausar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-motivo]");
  if (b) pausar(b.dataset.motivo, Number(b.dataset.pausa) || null);
});
$("pausa-otro-btn").addEventListener("click", () => {
  pausar($("pausa-otro").value.trim() || "En pausa", null);
  $("pausa-otro").value = "";
});
async function reanudar() {
  const { error } = await sb.rpc("reanudar_partida", { p: partida.id });
  if (error) return avisar(/tiempo/.test(error.message) ? "Todavía no se cumple el tiempo de la pausa." : "No se pudo reanudar.");
  cerrarMenuEstado();
}
$("reanudar").addEventListener("click", reanudar);
$("aviso-pausa").addEventListener("click", (e) => { if (e.target.closest("[data-reanudar]")) reanudar(); });
$("cancelar-juego").addEventListener("click", async () => {
  if (!confirm("¿Cancelar la partida? No contará en la mesa del club.")) return;
  const { error } = await sb.rpc("cancelar_juego", { p: partida.id, p_motivo: $("cancelar-motivo").value.trim() || null });
  if (error) return avisar("No se pudo cancelar la partida.");
  $("cancelar-motivo").value = "";
  cerrarMenuEstado();
});

// ---------- Dónde va el chat ----------
// En pantallas muy anchas tiene su propia columna; si no, va justo debajo de la cámara
const pantallaAncha = matchMedia("(min-width: 1700px)");
function ubicarChat() {
  const chat = $("chat");
  const enfoque = document.body.classList.contains("enfoque");
  if (pantallaAncha.matches && !enfoque) {
    if (chat.parentElement !== $("lateral-chat")) $("lateral-chat").appendChild(chat);
  } else {
    const despues = $("video");
    if (chat.previousElementSibling !== despues) despues.after(chat);
  }
  $("mensajes").scrollTop = $("mensajes").scrollHeight;
}
pantallaAncha.addEventListener?.("change", ubicarChat);
ubicarChat();

// ---------- Regresar al inicio desde una partida ----------
function irAlInicio() {
  if (document.body.classList.contains("enfoque")) ponerEnfoque(false);
  history.pushState(null, "", location.pathname);
  mostrar("inicio");
}
function pedirSalida() {
  if (partida?.local) return irAlInicio();
  const enJuego = partida && miColor() && partida.estado === "jugando";
  if (!enJuego) return irAlInicio();
  const rival = nombres[partida.blancas === yo ? partida.negras : partida.blancas] || "tu rival";
  $("salida-texto").textContent = `Tu partida contra ${rival} sigue en juego y los relojes siguen corriendo mientras no estés.`;
  $("salida").classList.remove("oculto");
}
$("ir-inicio").addEventListener("click", pedirSalida);
// El logo también regresa al inicio, con la misma pregunta si hay partida en juego
document.querySelector("header > a").addEventListener("click", (e) => {
  if (!yo || $("partida").classList.contains("oculto")) return;
  e.preventDefault();
  pedirSalida();
});
$("ir-inicio-2").addEventListener("click", pedirSalida);
$("salida").addEventListener("click", async (e) => {
  if (e.target.id === "salida") return $("salida").classList.add("oculto");
  const b = e.target.closest("[data-salida]");
  if (!b) return;
  const opcion = b.dataset.salida;
  if (opcion === "quedarme") return $("salida").classList.add("oculto");
  if (opcion === "pausar") {
    const { error } = await sb.rpc("pausar_partida", { p: partida.id, p_motivo: "Regreso más tarde", p_minutos: null });
    if (error) return avisar("No se pudo pausar. Intenta de nuevo.");
  }
  if (opcion === "cancelar") {
    const { error } = await sb.rpc("cancelar_juego", { p: partida.id, p_motivo: null });
    if (error) return avisar("No se pudo cancelar la partida.");
  }
  $("salida").classList.add("oculto");
  irAlInicio();
  if (opcion === "pausar") avisar("Partida en pausa. La encuentras en «Mis partidas».");
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("salida").classList.contains("oculto")) $("salida").classList.add("oculto"); });

// ---------- Quién está en línea, junto al tablero ----------
function pintarLineaPartida() {
  const otros = Object.keys(enLinea).filter((id) => id !== yo)
    .sort((a, b) => (enLinea[a].jugando - enLinea[b].jugando) || (enLinea[a].nombre || "").localeCompare(enLinea[b].nombre || ""));
  $("izq-cuenta").textContent = `${otros.length + 1} conectados`;
  if (!otros.length) { $("izq-conectados").innerHTML = (partida?.local ? "" : filaMaquina("izq-fila")) + '<p class="izq-vacio">Nadie más está conectado ahorita.</p>'; return; }
  const rivalActual = partida ? (partida.blancas === yo ? partida.negras : partida.blancas) : null;
  $("izq-conectados").innerHTML = (partida?.local ? "" : filaMaquina("izq-fila")) + otros.map((id) => {
    const u = enLinea[id];
    const lado = id === rivalActual ? '<span class="izq-ocupado" style="color:#A9CB9A">CONTIGO</span>'
      : u.jugando ? '<span class="izq-ocupado">OCUPADO</span>'
      : `<button type="button" class="izq-jugar" data-retar-izq="${id}" aria-label="Retar a ${esc(u.nombre)}">Jugar</button>`;
    const globo = sinLeer[id] ? `<span class="globo">${sinLeer[id]}</span>` : "";
    const msj = `<button type="button" class="izq-msj" data-privado="${id}" aria-label="Mensaje privado a ${esc(u.nombre)}">${ICONO_MSJ}${globo}</button>`;
    return `<div class="izq-fila${chatCon === id ? " activa" : ""}">${ficha(id, "punto-verde")}<div><strong>${esc(u.nombre)}</strong><small>${id === rivalActual ? "En esta partida" : u.jugando ? "Jugando" : estadoDe(id)}</small></div><span class="izq-acciones">${msj}${lado}</span></div>`;
  }).join("");
}
$("izq-conectados").addEventListener("click", async (e) => {
  if (e.target.closest("[data-maquina]")) return abrirVsMaquina();
  const p = e.target.closest("[data-privado]");
  if (p) return abrirPrivado(p.dataset.privado);
  const b = e.target.closest("[data-retar-izq]");
  if (!b) return;
  const id = b.dataset.retarIzq;
  // Si estoy en una partida en juego, primero la pauso para que mi reloj no corra
  if (partida && miColor() && partida.estado === "jugando") {
    if (!confirm(`Tu partida actual sigue en juego. ¿La pausamos y retas a ${enLinea[id]?.nombre || "este jugador"}?`)) return;
    const { error } = await sb.rpc("pausar_partida", { p: partida.id, p_motivo: "Jugando otra partida", p_minutos: null });
    if (error) return avisar("No se pudo pausar tu partida actual.");
  }
  b.disabled = true;
  const ok = await crearMesa(minutosElegidos, id);
  if (!ok) b.disabled = false;
});

// ---------- Mensajes privados: solo entre dos jugadores ----------
let chatCon = null;                 // con quién está abierta la conversación
const sinLeer = {};                 // id -> mensajes nuevos sin leer
const vistosPriv = new Set();
const ICONO_MSJ = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>';

async function abrirPrivado(id) {
  chatCon = id;
  delete sinLeer[id];
  await cargarNombres([id]);
  $("privado").classList.remove("oculto");
  $("privado-titulo").textContent = `Con ${nombres[id] || "jugador"}`;
  $("club-mensajes").innerHTML = '<p class="club-vacio">Cargando…</p>';
  vistosPriv.clear();
  const { data } = await sb.from("mensajes_privados").select("*")
    .or(`and(de.eq.${yo},para.eq.${id}),and(de.eq.${id},para.eq.${yo})`)
    .order("id", { ascending: false }).limit(40);
  if (chatCon !== id) return;
  $("club-mensajes").innerHTML = "";
  (data || []).reverse().forEach((m) => pintarPrivado(m));
  if (!(data || []).length) $("club-mensajes").innerHTML = `<p class="club-vacio" id="club-vacio">Solo ${esc(nombres[id] || "esta persona")} y tú ven estos mensajes.</p>`;
  pintarLineaPartida();
  $("club-texto").focus();
}
function pintarPrivado(m) {
  if (vistosPriv.has(m.id)) return;
  vistosPriv.add(m.id);
  $("club-vacio")?.remove();
  const mio = m.de === yo;
  const el = document.createElement("div");
  el.className = `club-msj${mio ? " mio" : ""}`;
  const hora = new Date(m.creado).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<b>${esc(mio ? "Tú" : nombres[m.de] || "Jugador")}</b>${esc(m.texto)}<time>${hora}</time>`;
  $("club-mensajes").appendChild(el);
  $("club-mensajes").scrollTop = $("club-mensajes").scrollHeight;
}
async function recibirPrivado(m) {
  if (!m || m.para !== yo) return;
  if (!nombres[m.de]) await cargarNombres([m.de]);
  sonido("mensaje");
  if (document.hidden) avisoPestana(`💬 ${nombres[m.de] || "Alguien"} te escribió`);
  // Si no hay conversación abierta, se abre con quien escribió
  if (!chatCon) return abrirPrivado(m.de);
  if (chatCon === m.de) return pintarPrivado(m);
  sinLeer[m.de] = (sinLeer[m.de] || 0) + 1;
  avisar(`💬 ${nombres[m.de] || "Alguien"} te mandó un mensaje privado.`);
  pintarLineaPartida();
}
$("privado-cerrar").addEventListener("click", () => {
  chatCon = null;
  $("privado").classList.add("oculto");
  pintarLineaPartida();
});
$("form-club").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("club-texto");
  const texto = input.value.trim();
  if (!texto || !chatCon) return;
  input.value = "";
  const { data, error } = await sb.from("mensajes_privados").insert({ para: chatCon, texto }).select().single();
  if (error) { input.value = texto; return avisar("No se pudo enviar el mensaje."); }
  pintarPrivado(data);
});

// ---------- Tablero a pantalla completa ----------
function ponerEnfoque(activar) {
  document.body.classList.toggle("enfoque", activar);
  ubicarChat();
  ubicarPlan();
  const b = $("maximizar");
  b.setAttribute("aria-pressed", String(activar));
  b.setAttribute("aria-label", activar ? "Salir de pantalla completa" : "Agrandar el tablero a pantalla completa");
  b.title = activar ? "Salir (Esc)" : "Pantalla completa";
  try {
    if (activar && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!activar && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch {}
}
$("maximizar").addEventListener("click", () => ponerEnfoque(!document.body.classList.contains("enfoque")));
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("enfoque")) ponerEnfoque(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("enfoque")) ponerEnfoque(false); });

// ---------- Vista personal (solo en este navegador) ----------
function aplicarAngulo() {
  const a = Number($("angulo").value);
  $("angulo-valor").textContent = `${a}°`;
  $("marco").style.transform = `rotateX(${a}deg)`;
  document.querySelectorAll(".pieza").forEach((p) => (p.style.transform = `rotateX(${-a}deg)`));
}
$("angulo").addEventListener("input", aplicarAngulo);

// ---------- Ajustes de cuenta ----------
let fotoNueva = undefined;   // Blob nuevo, null para quitarla, undefined si no cambia
let correoActual = "";
function abrirAjustes() {
  $("aj-nombre").value = nombres[yo] || "";
  document.querySelectorAll('input[name="aj-avatar"]').forEach((r) => (r.checked = r.value === (avatares[yo] || "rey")));
  fotoNueva = undefined;
  $("foto-vista").innerHTML = cara(yo);
  $("baja-confirmar").classList.add("oculto");
  $("baja-texto").value = "";
  $("baja-2").disabled = true;
  $("form-cambiar-clave").reset();
  $("ajustes").classList.remove("oculto");
  $("aj-nombre").focus();
  sb.auth.getUser().then(({ data }) => { correoActual = data.user?.email || ""; });
  sb.rpc("es_admin").then(({ data }) => $("torre-link").classList.toggle("oculto", data !== true), () => {});
}
function cerrarAjustes() { $("ajustes").classList.add("oculto"); }
$("mi-cuenta").addEventListener("click", abrirAjustes);
$("ajustes-cerrar").addEventListener("click", cerrarAjustes);
$("ajustes").addEventListener("click", (e) => { if (e.target.id === "ajustes") cerrarAjustes(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("ajustes").classList.contains("oculto")) cerrarAjustes(); });

// Recorta al centro en cuadro de 320 px y la guarda como JPG ligero
async function prepararFoto(archivo) {
  const img = await createImageBitmap(archivo);
  const lado = Math.min(img.width, img.height);
  const lienzo = document.createElement("canvas");
  lienzo.width = lienzo.height = 320;
  lienzo.getContext("2d").drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, 320, 320);
  return new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", 0.85));
}
$("foto-archivo").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  e.target.value = "";
  if (!archivo) return;
  if (!archivo.type.startsWith("image/")) return avisar("Elige una imagen (JPG, PNG o similar).");
  try {
    fotoNueva = await prepararFoto(archivo);
    $("foto-vista").innerHTML = `<img src="${URL.createObjectURL(fotoNueva)}" alt="">`;
  } catch {
    avisar("No se pudo leer esa imagen. Prueba con otra.");
  }
});
$("foto-quitar").addEventListener("click", () => {
  fotoNueva = null;
  const av = document.querySelector('input[name="aj-avatar"]:checked')?.value || "rey";
  $("foto-vista").innerHTML = iconoSVG(av);
});
document.querySelectorAll('input[name="aj-avatar"]').forEach((r) => r.addEventListener("change", () => {
  if (fotoNueva === null || (!fotos[yo] && !fotoNueva)) $("foto-vista").innerHTML = iconoSVG(r.value);
}));

function refrescarMiCara() {
  $("mi-nombre").textContent = nombres[yo];
  $("mi-icono").innerHTML = cara(yo);
  if (!$("inicio").classList.contains("oculto")) cargarClub();
  else if (partida) dibujar();
  if (canalClub) presenciaEstado(presenciaDonde);
}

$("form-perfil").addEventListener("submit", async (e) => {
  e.preventDefault();
  const boton = e.target.querySelector("button[type=submit]");
  boton.disabled = true;
  try {
    const nombre = $("aj-nombre").value.trim();
    const avatar = document.querySelector('input[name="aj-avatar"]:checked')?.value || "rey";
    const { error } = await sb.rpc("actualizar_perfil", { p_nombre: nombre, p_avatar: avatar });
    if (error) return avisar(/uso/.test(error.message) ? "Ese nombre ya lo tiene alguien del club." : /caracteres/.test(error.message) ? "El nombre debe tener entre 2 y 20 caracteres." : "No se pudo guardar. Intenta de nuevo.");
    nombres[yo] = nombre;
    avatares[yo] = avatar;
    if (fotoNueva) {
      const ruta = `${yo}/foto.jpg`;
      const subida = await sb.storage.from("fotos").upload(ruta, fotoNueva, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
      if (subida.error) return avisar("Se guardó tu nombre, pero la foto no se pudo subir. Intenta con otra imagen.");
      const url = `${sb.storage.from("fotos").getPublicUrl(ruta).data.publicUrl}?v=${Date.now()}`;
      const r = await sb.rpc("poner_foto", { p_url: url });
      if (r.error) return avisar("La foto no se pudo guardar.");
      fotos[yo] = url;
    } else if (fotoNueva === null && fotos[yo]) {
      await sb.storage.from("fotos").remove([`${yo}/foto.jpg`]);
      await sb.rpc("poner_foto", { p_url: null });
      delete fotos[yo];
    }
    fotoNueva = undefined;
    refrescarMiCara();
    avisar("Cambios guardados.");
    cerrarAjustes();
  } finally {
    boton.disabled = false;
  }
});

$("form-cambiar-clave").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("aj-nueva").value !== $("aj-nueva2").value) return avisar("Las dos contraseñas nuevas no coinciden.");
  const boton = e.target.querySelector("button[type=submit]");
  boton.disabled = true;
  try {
    // Primero confirmamos que la contraseña actual es correcta
    const prueba = await sb.auth.signInWithPassword({ email: correoActual, password: $("aj-actual").value });
    if (prueba.error) return avisar("La contraseña actual no es correcta.");
    const { error } = await sb.auth.updateUser({ password: $("aj-nueva").value });
    if (error) return avisar(/different|same/i.test(error.message) ? "La nueva debe ser distinta a la actual." : "No se pudo cambiar. Intenta de nuevo.");
    e.target.reset();
    avisar("Contraseña cambiada.");
  } finally {
    boton.disabled = false;
  }
});

$("baja-1").addEventListener("click", () => { $("baja-confirmar").classList.remove("oculto"); $("baja-texto").focus(); });
$("baja-texto").addEventListener("input", (e) => { $("baja-2").disabled = e.target.value.trim().toUpperCase() !== "BAJA"; });
$("baja-2").addEventListener("click", async () => {
  $("baja-2").disabled = true;
  if (fotos[yo]) await sb.storage.from("fotos").remove([`${yo}/foto.jpg`]).catch(() => {});
  const { error } = await sb.rpc("eliminar_cuenta");
  if (error) { $("baja-2").disabled = false; return avisar("No se pudo eliminar la cuenta. Intenta de nuevo."); }
  await sb.auth.signOut().catch(() => {});
  alert("Tu cuenta fue eliminada. ¡Gracias por jugar en el club!");
  location.href = "./";
});

// ---------- Recuperar contraseña ----------
function verFormulario(cual) {
  $("form-registro").classList.toggle("oculto", cual === "nueva");
  $("form-entrar").classList.toggle("oculto", cual !== "entrar");
  $("form-recuperar").classList.toggle("oculto", cual !== "recuperar");
  $("form-nueva-clave").classList.toggle("oculto", cual !== "nueva");
}
$("olvide").addEventListener("click", () => {
  $("rc-correo").value = $("e-correo").value;
  verFormulario("recuperar");
  $("rc-correo").focus();
});
$("volver-entrar").addEventListener("click", () => verFormulario("entrar"));
$("form-recuperar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const boton = e.target.querySelector("button[type=submit]");
  boton.disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail($("rc-correo").value.trim(), { redirectTo: `${location.origin}/` });
  boton.disabled = false;
  if (error) {
    return avisar(/rate|seconds/i.test(error.message)
      ? "Espera un minuto antes de pedir otro enlace."
      : "No se pudo enviar el correo. Revisa la dirección e intenta de nuevo.");
  }
  // Por seguridad no decimos si el correo existe o no
  avisar("Si ese correo es del club, te llegará un enlace en unos minutos. Revisa también spam.");
  verFormulario("entrar");
});
function mostrarNuevaClave() {
  mostrar("acceso");
  verFormulario("nueva");
  history.replaceState(null, "", location.pathname);
  $("nc-clave").focus();
}
function revisarNuevaClave() {
  const a = $("nc-clave").value, b = $("nc-clave2").value, nota = $("nota-nueva");
  nota.className = "nota"; nota.textContent = "";
  if (!b) return true;
  const ok = a === b;
  nota.classList.add(ok ? "bien" : "mal");
  nota.textContent = ok ? "Las contraseñas coinciden." : "Las contraseñas no coinciden.";
  return ok;
}
$("nc-clave").addEventListener("input", revisarNuevaClave);
$("nc-clave2").addEventListener("input", revisarNuevaClave);
$("form-nueva-clave").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("nc-clave").value !== $("nc-clave2").value) { revisarNuevaClave(); return avisar("Las dos contraseñas no coinciden."); }
  const boton = e.target.querySelector("button[type=submit]");
  boton.disabled = true;
  const { data, error } = await sb.auth.updateUser({ password: $("nc-clave").value });
  boton.disabled = false;
  if (error) {
    return avisar(/different|same/i.test(error.message)
      ? "La contraseña nueva debe ser distinta a la anterior."
      : "No se pudo guardar. Pide un enlace nuevo e intenta otra vez.");
  }
  e.target.reset();
  verFormulario("entrar");
  avisar("¡Listo! Tu contraseña quedó guardada.");
  entrar(data.user);
});

// ---------- Arranque ----------
async function arrancar() {
  if (SUPABASE_URL.includes("TU-PROYECTO") || SUPABASE_KEY.includes("TU-CLAVE")) {
    mostrar("acceso");
    return avisar("Falta llenar config.js con los datos de Supabase.");
  }
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { storage: almacenSesion, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  sb.auth.onAuthStateChange((evento) => { if (evento === "PASSWORD_RECOVERY") mostrarNuevaClave(); });
  const { data } = await sb.auth.getSession();
  const usuario = data.session?.user;
  if (vieneDeRecuperar && usuario) return mostrarNuevaClave();
  if (enlaceCaducado) {
    history.replaceState(null, "", location.pathname);
    setTimeout(() => avisar("Ese enlace ya caducó o ya se usó. Pide uno nuevo desde «¿Olvidaste tu contraseña?»."), 300);
  }
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
