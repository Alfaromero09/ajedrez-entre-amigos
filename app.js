import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { Chess } from "https://esm.sh/chess.js@1.4.0";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { piezaSVG, iconoSVG } from "./piezas.js";
import { TABLEROS, PIEZAS, DEFS_3D, pieza as dibujoPieza } from "./estilos.js";

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
  if (vista !== "partida" && document.body.classList.contains("enfoque")) ponerEnfoque(false);
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
});

// Crea una mesa (opcionalmente apartada para un rival) y, si ese rival está conectado, le llama
async function crearMesa(minutos, rival) {
  const { data, error } = await sb.rpc("crear_partida", rival ? { p_minutos: minutos, p_rival: rival } : { p_minutos: minutos });
  if (error) { avisar("No se pudo crear la partida. Intenta de nuevo."); return null; }
  await irAPartida(data);
  if (rival && enLinea[rival] && !enLinea[rival].jugando) llamar(rival);
  return data;
}
$("crear").addEventListener("click", () => crearMesa(minutosElegidos, $("rival").value || null));

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

function irAPartida(id) {
  history.pushState(null, "", `?p=${id}`);
  return abrirPartida(id);
}

async function cargarClub() {
  if (!yo) return;
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [salasR, vivoR, mesaR, claveR, mioR, recientesR] = await Promise.all([
    sb.from("partidas").select("id, blancas, minutos, creada, reservada_para").eq("estado", "esperando").gte("creada", desde).order("creada", { ascending: false }).limit(30),
    sb.from("partidas").select("id, blancas, negras, minutos, jugadas, actualizada, fen, reloj_blancas, reloj_negras, ultimo_tick").eq("estado", "jugando").order("actualizada", { ascending: false }).limit(20),
    sb.rpc("mesa_del_club"),
    sb.rpc("clave_del_club"),
    sb.from("partidas").select("id, blancas, negras, resultado, motivo, minutos, actualizada").eq("estado", "terminada").not("negras", "is", null).not("resultado", "is", null).or(`blancas.eq.${yo},negras.eq.${yo}`).order("actualizada", { ascending: false }).limit(50),
    sb.from("partidas").select("id, blancas, negras, resultado, motivo, actualizada").eq("estado", "terminada").not("negras", "is", null).not("resultado", "is", null).order("actualizada", { ascending: false }).limit(6),
  ]);
  // Las mesas apartadas solo las ven quien la creó y para quien se apartó
  const salas = (salasR.data || []).filter((x) => !x.reservada_para || x.reservada_para === yo || x.blancas === yo);
  // Fuera las que ya se quedaron sin tiempo aunque nadie lo haya reclamado
  const vivo = (vivoR.data || []).filter((x) => {
    if (!x.ultimo_tick) return false;
    const resta = (x.fen.split(" ")[1] === "w" ? x.reloj_blancas : x.reloj_negras) - (ahoraServidor() - new Date(x.ultimo_tick).getTime());
    return resta > 0;
  });
  const mesa = mesaR.data || [];
  mesa.forEach((m) => { nombres[m.id] = m.nombre; avatares[m.id] = m.avatar; });
  pintarRivales(mesa);
  cargarMiembros();
  const recientes = recientesR.data || [];
  await cargarNombres([...salasR.data || [], ...vivo, ...recientes].flatMap((x) => [x.blancas, x.negras]));
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
    const meta = `${textoTiempo(x.minutos)}, ${n ? `jugada ${n}` : "recién empieza"}`;
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
  if (ultimasVivo.some((x) => x.blancas === id || x.negras === id)) return "Jugando";
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
    `<h3 class="subtitulo"><span class="punto verde"></span>Conectados (${conectados.length})</h3>` +
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
const estoyJugando = () => !!(partida && partida.estado === "jugando" && miColor());
function actualizarPresencia() {
  if (estoyJugando() !== presenciaJugando) presenciaEstado(presenciaDonde);
}
setInterval(() => { if (yo && !$("inicio").classList.contains("oculto")) { pintarSalas(ultimasSalas); } }, 60000);

// ---------- Miembros del club y última conexión ----------
let miembros = [];
async function cargarMiembros() {
  const { data } = await sb.from("perfiles").select("id, nombre, avatar, ultima_vez").order("nombre");
  miembros = data || [];
  miembros.forEach((m) => { nombres[m.id] = m.nombre; avatares[m.id] = m.avatar; });
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
  sel.innerHTML = '<option value="">Cualquiera del club</option>' +
    otros.map((m) => `<option value="${m.id}">${esc(m.nombre)}${enLinea[m.id] ? " · conectado" : ""}</option>`).join("");
  if (otros.some((m) => m.id === antes)) sel.value = antes;
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
let timbre = null;

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
  enviar("llamada", { id, de: yo, para, nombre: nombres[yo] || "Jugador", avatar: avatares[yo] || "rey", partida: partida.id, minutos: partida.minutos || 10 });
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
  $("llamada-ficha").innerHTML = iconoSVG(l.avatar || "rey");
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
  if (document.hidden) document.title = `📞 ${l.nombre} te invita a jugar`;
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

// Timbre suave hecho con el navegador (sin archivos de audio)
function sonar() {
  callar();
  let ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  const tono = () => {
    const t = ctx.currentTime;
    [[659, 0], [880, 0.18], [659, 0.6], [880, 0.78]].forEach(([f, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(0.12, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t + d); o.stop(t + d + 0.18);
    });
  };
  tono();
  timbre = { ctx, intervalo: setInterval(tono, 2600) };
}
function callar() {
  if (!timbre) return;
  clearInterval(timbre.intervalo);
  timbre.ctx.close().catch(() => {});
  timbre = null;
}
window.addEventListener("beforeunload", colgarTodas);

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
  await cargarNombres([partida.blancas, partida.negras, partida.reservada_para]);
  cargarChat(id);
  dibujar();

  if (canal) sb.removeChannel(canal);
  canal = sb
    .channel(`partida-${id}`)
    .on("broadcast", { event: "jugada" }, ({ payload }) => aplicarRemota(payload))
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
    }
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
}

$("final-tablero").addEventListener("click", cerrarFinal);
$("final").addEventListener("click", (e) => { if (e.target.id === "final") cerrarFinal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("final").classList.contains("oculto")) cerrarFinal(); });
function cerrarFinal() { $("final").classList.add("oculto"); confeti = []; }
$("final-revancha").addEventListener("click", async () => {
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
  const juego = new Chess(partida.fen);
  const color = miColor();
  const volteado = color === "b";
  const turno = juego.turn();
  const ultima = partida.jugadas.at(-1);

  const estado = $("estado");
  const jugando = partida.estado === "jugando";
  $("invitar").classList.toggle("oculto", !(partida.estado === "esperando" && color === "w"));
  if (partida.estado === "esperando" && color === "w") pintarLlamables();
  else colgarTodas();
  actualizarPresencia();
  $("unirse").classList.toggle("oculto", !(partida.estado === "esperando" && color !== "w" && (!partida.reservada_para || partida.reservada_para === yo)));
  $("acciones-juego").classList.toggle("oculto", !(jugando && color));
  pintarTablas(color);
  $("form-chat").classList.toggle("oculto", !color);
  textoChatVacio();
  avisarTurno(color, turno);
  $("nueva").classList.toggle("oculto", partida.estado !== "terminada" && !!color);
  if (partida.estado === "esperando") {
    estado.textContent = color === "w"
      ? (partida.reservada_para
          ? `Mesa apartada para ${nombres[partida.reservada_para] || "tu rival"}. Llámale si está conectado o mándale el link.`
          : "Esperando rival. Llama a alguien que esté conectado o mándale el link.")
      : `${nombres[partida.blancas] || "Alguien"} te espera en esta mesa.`;
  } else if (partida.estado === "terminada") {
    estado.textContent = textoFinal();
  } else {
    const jaque = juego.inCheck() ? "Jaque. " : "";
    if (!color) estado.textContent = `${jaque}Mueven las ${turno === "w" ? "blancas" : "negras"}.`;
    else estado.textContent = `${jaque}${turno === color ? "Tu turno." : `Turno de ${nombreDe(turno === "w" ? partida.blancas : partida.negras)}.`}`;
  }

  const { capturas, material } = contarMaterial(juego);
  const tira = (c) => {
    const id = c === "w" ? partida.blancas : partida.negras;
    const nombre = id ? nombreDe(id) : "Lugar libre";
    const icono = id ? `<span class="avatar">${iconoSVG(avatares[id])}</span>` : "";
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
    tic(520);
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
  tic(660);
  if (document.hidden) avisoPestana("♟ Te toca mover");
}
function avisoPestana(texto) { document.title = texto; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Ajedrez entre Amigos"; });
let audioTic = null;
function tic(frecuencia) {
  try {
    audioTic = audioTic || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioTic.currentTime, o = audioTic.createOscillator(), g = audioTic.createGain();
    o.type = "triangle"; o.frequency.value = frecuencia;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(audioTic.destination); o.start(t); o.stop(t + 0.16);
  } catch {}
}

// ---------- Tablero a pantalla completa ----------
function ponerEnfoque(activar) {
  document.body.classList.toggle("enfoque", activar);
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
