// Torre de control: administración del club (solo para administradores)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { SUPABASE_URL, SUPABASE_KEY } from "/config.js";
import { iconoSVG } from "/piezas.js";

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Misma forma de guardar la sesión que el club, para no tener que entrar dos veces
const LS = (() => { try { localStorage.setItem("__p", "1"); localStorage.removeItem("__p"); return localStorage; } catch { return null; } })();
const SS = (() => { try { return sessionStorage; } catch { return null; } })();
const recordar = () => (LS ? LS.getItem("ajedrez-recordar") !== "no" : false);
const almacen = {
  getItem: (k) => (recordar() ? LS : SS)?.getItem(k) ?? null,
  setItem: (k, v) => (recordar() ? LS : SS)?.setItem(k, v),
  removeItem: (k) => { LS?.removeItem(k); SS?.removeItem(k); },
};
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storage: almacen, persistSession: true, autoRefreshToken: true } });

let yo = null;
let usuarios = [];

function avisar(texto) {
  const el = $("aviso");
  el.textContent = texto;
  el.classList.remove("oculto");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.add("oculto"), 4500);
}
function ver(cual) {
  for (const id of ["acceso", "sin-permiso", "panel"]) $(id).classList.toggle("oculto", id !== cual);
  $("cabeza-der").classList.toggle("oculto", cual === "acceso");
}
const fecha = (f) => f ? new Date(f).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—";
function hace(f) {
  if (!f) return "Nunca";
  const min = Math.round((Date.now() - new Date(f).getTime()) / 60000);
  if (min < 5) return "Ahora";
  if (min < 60) return `Hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Hace ${h} h`;
  return `Hace ${Math.round(h / 24)} d`;
}

// ---------- Confirmación escrita ----------
function confirmar({ titulo, texto, palabra, boton = "Confirmar" }) {
  return new Promise((listo) => {
    $("modal-titulo").textContent = titulo;
    $("modal-texto").innerHTML = texto;
    $("modal-label").innerHTML = `Para confirmar, escribe <code>${esc(palabra)}</code>`;
    $("modal-input").value = "";
    $("modal-si").textContent = boton;
    $("modal-si").disabled = true;
    $("modal").classList.remove("oculto");
    $("modal-input").focus();
    const revisar = () => { $("modal-si").disabled = $("modal-input").value.trim().toLowerCase() !== palabra.toLowerCase(); };
    const cerrar = (ok) => {
      $("modal").classList.add("oculto");
      $("modal-input").removeEventListener("input", revisar);
      $("modal-si").onclick = null; $("modal-no").onclick = null;
      listo(ok);
    };
    $("modal-input").addEventListener("input", revisar);
    $("modal-si").onclick = () => cerrar(true);
    $("modal-no").onclick = () => cerrar(false);
  });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").classList.contains("oculto")) $("modal-no").click(); });

// ---------- Datos ----------
async function cargar() {
  const [u, clave] = await Promise.all([sb.rpc("admin_usuarios"), sb.rpc("clave_del_club")]);
  if (u.error) { avisar("No se pudieron cargar los usuarios."); return; }
  usuarios = u.data || [];
  $("clave-actual").textContent = clave.data || "—";
  pintarCifras();
  pintarUsuarios();
}

function pintarCifras() {
  const total = usuarios.length;
  const confirmados = usuarios.filter((x) => x.confirmado).length;
  const admins = usuarios.filter((x) => x.es_admin).length;
  const activos = usuarios.filter((x) => x.ultima_vez && Date.now() - new Date(x.ultima_vez).getTime() < 7 * 864e5).length;
  $("cifras").innerHTML = [
    [total, "Usuarios"], [confirmados, "Con correo confirmado"], [activos, "Activos esta semana"], [admins, admins === 1 ? "Administrador" : "Administradores"],
  ].map(([n, t]) => `<div class="cifra"><strong>${n}</strong><span>${t}</span></div>`).join("");
}

function pintarUsuarios() {
  const q = $("buscar").value.trim().toLowerCase();
  const lista = usuarios.filter((x) => !q || (x.nombre || "").toLowerCase().includes(q) || (x.email || "").toLowerCase().includes(q));
  if (!lista.length) { $("usuarios").innerHTML = `<tr><td colspan="9" class="vacio">${q ? "Nadie coincide con esa búsqueda." : "No hay usuarios."}</td></tr>`; return; }
  $("usuarios").innerHTML = lista.map((x) => {
    const cara = x.foto_url ? `<img src="${esc(x.foto_url)}" alt="">` : iconoSVG(x.avatar || "rey");
    const chips = [
      x.id === yo ? '<span class="chip tu">TÚ</span>' : "",
      x.es_admin ? '<span class="chip admin">ADMIN</span>' : "",
      !x.confirmado ? '<span class="chip pendiente">SIN CONFIRMAR</span>' : "",
      !x.nombre ? '<span class="chip sinperfil">SIN PERFIL</span>' : "",
    ].join("");
    const reinicio = x.marcador_desde ? `<br><small class="fecha">Marcador desde ${fecha(x.marcador_desde)}</small>` : "";
    return `<tr>
      <td><div class="quien"><span class="cara">${cara}</span><div><strong>${esc(x.nombre || "(sin nombre)")}</strong><small>${esc(x.email || "sin correo")}</small><div class="chips">${chips}</div></div></div></td>
      <td class="fecha">${fecha(x.creado)}</td>
      <td class="fecha">${hace(x.ultima_vez)}</td>
      <td class="num">${x.pj}${reinicio}</td><td class="num">${x.g}</td><td class="num">${x.p}</td><td class="num">${x.t}</td>
      <td class="num">${x.partidas_total}</td>
      <td><div class="acciones-fila">
        <button class="btn chico" data-accion="marcador" data-id="${x.id}" ${x.nombre ? "" : "disabled"}>Reiniciar marcador</button>
        <button class="btn chico" data-accion="partidas" data-id="${x.id}" ${x.partidas_total ? "" : "disabled"}>Borrar partidas</button>
        <button class="btn chico" data-accion="admin" data-id="${x.id}">${x.es_admin ? "Quitar admin" : "Hacer admin"}</button>
        <button class="btn chico rojo" data-accion="eliminar" data-id="${x.id}">Eliminar</button>
      </div></td>
    </tr>`;
  }).join("");
}
$("buscar").addEventListener("input", pintarUsuarios);

// ---------- Acciones ----------
$("usuarios").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-accion]");
  if (!b) return;
  const x = usuarios.find((u) => u.id === b.dataset.id);
  if (!x) return;
  const quien = esc(x.nombre || x.email);
  const palabra = x.nombre || x.email || "BORRAR";

  if (b.dataset.accion === "marcador") {
    if (!await confirmar({ titulo: "Reiniciar marcador", texto: `<strong>${quien}</strong> empezará de cero en la mesa del club. Sus partidas no se borran; solo dejan de contar para su marcador.`, palabra: "REINICIAR", boton: "Reiniciar" })) return;
    const { error } = await sb.rpc("admin_reiniciar_marcador", { p_usuario: x.id });
    avisar(error ? "No se pudo reiniciar." : `Marcador de ${x.nombre} reiniciado.`);
  }
  if (b.dataset.accion === "partidas") {
    if (!await confirmar({ titulo: "Borrar partidas", texto: `Se borrarán para siempre las <strong>${x.partidas_total}</strong> partidas de <strong>${quien}</strong>, también para sus rivales en esas partidas.`, palabra, boton: "Borrar partidas" })) return;
    const { data, error } = await sb.rpc("admin_borrar_partidas", { p_usuario: x.id });
    avisar(error ? "No se pudieron borrar." : `Se borraron ${data} partidas.`);
  }
  if (b.dataset.accion === "admin") {
    const si = !x.es_admin;
    const { error } = await sb.rpc("admin_poner_admin", { p_usuario: x.id, p_si: si });
    if (error) avisar(/al menos/.test(error.message) ? "Debe quedar al menos un administrador." : "No se pudo cambiar.");
    else avisar(si ? `${x.nombre || x.email} ahora es administrador.` : `${x.nombre || x.email} ya no es administrador.`);
    if (!error && !si && x.id === yo) return location.reload();
  }
  if (b.dataset.accion === "eliminar") {
    const propia = x.id === yo;
    if (!await confirmar({
      titulo: propia ? "Eliminar tu propia cuenta" : "Eliminar usuario",
      texto: `Se borrará la cuenta de <strong>${quien}</strong> (${esc(x.email || "sin correo")}), su perfil, foto, mensajes y las partidas que creó.${propia ? " <strong>Es la cuenta con la que estás ahora; se cerrará tu sesión.</strong>" : ""}`,
      palabra: x.email || palabra, boton: "Eliminar para siempre",
    })) return;
    if (x.foto_url) await sb.storage.from("fotos").remove([`${x.id}/foto.jpg`]).catch(() => {});
    const { error } = await sb.rpc("admin_eliminar_usuario", { p_usuario: x.id });
    if (error) { avisar(/único/.test(error.message) ? "No puedes borrar al único administrador. Primero haz admin a otra cuenta." : "No se pudo eliminar."); return; }
    avisar("Usuario eliminado.");
    if (propia) { await sb.auth.signOut().catch(() => {}); location.href = "/"; return; }
  }
  cargar();
});

$("reiniciar-todo").addEventListener("click", async () => {
  if (!await confirmar({ titulo: "Reiniciar la mesa de todos", texto: "Todos los jugadores empezarán de cero en la tabla de posiciones. Las partidas no se borran.", palabra: "REINICIAR", boton: "Reiniciar todo" })) return;
  const { error } = await sb.rpc("admin_reiniciar_marcador", { p_usuario: null });
  avisar(error ? "No se pudo reiniciar." : "La mesa del club empieza de cero.");
  cargar();
});

$("cambiar-clave").addEventListener("click", async () => {
  const nueva = $("nueva-clave").value.trim();
  if (nueva.length < 3) return avisar("La clave debe tener al menos 3 caracteres.");
  if (!await confirmar({ titulo: "Cambiar la clave del club", texto: `La nueva clave será <strong>${esc(nueva)}</strong>. Avísale a quien vayas a invitar.`, palabra: nueva, boton: "Cambiar clave" })) return;
  const { error } = await sb.rpc("admin_cambiar_clave", { p_clave: nueva });
  avisar(error ? "No se pudo cambiar la clave." : "Clave del club actualizada.");
  $("nueva-clave").value = "";
  cargar();
});

// ---------- Acceso ----------
$("form-acceso").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $("a-correo").value.trim(), password: $("a-clave").value });
  if (error) return avisar("Correo o contraseña incorrectos.");
  arrancar();
});
$("salir").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/"; });

async function arrancar() {
  const { data } = await sb.auth.getSession();
  const usuario = data.session?.user;
  if (!usuario || usuario.is_anonymous) return ver("acceso");
  yo = usuario.id;
  $("admin-nombre").textContent = usuario.user_metadata?.nombre || usuario.email;
  const { data: esAdmin } = await sb.rpc("es_admin");
  if (!esAdmin) return ver("sin-permiso");
  ver("panel");
  cargar();
}
arrancar();
