// Piezas "Ilustradas" estilo madera tallada (diseño propio).
const base = '<path d="M10 42 h20 l1 3 h-22z"/><path d="M8 45 h24 v3 h-24z"/>';
const cuerpo = '<path d="M15 25 C15 32 12 38 11 42 h18 C28 38 25 32 25 25z"/>';

const formas = {
  p: '<circle cx="20" cy="15" r="6"/><path d="M15 22 h10 l-1 3 h-8z"/><path d="M16 25 C16 33 12 38 11 42 h18 C28 38 24 33 24 25z"/>',
  r: '<path d="M11 8 h4 v4 h3 v-4 h4 v4 h3 v-4 h4 v10 h-18z"/><path d="M13 18 h14 l1 24 h-16z"/>',
  b: '<circle cx="20" cy="3.5" r="2"/><path d="M20 5 C26 10 27 16 24 21 h-8 C13 16 14 10 20 5z"/><path d="M22.5 9 l-4 6" fill="none"/><path d="M14 21 h12 v3 h-12z"/><path d="M16 24 C16 32 13 38 11 42 h18 C27 38 24 32 24 24z"/>',
  n: '<path d="M12 42 C13 34 16 30 15 26 C12 26 9 24 10 21 C12 17 16 14 18 9 L20 4 L22 8 C28 10 31 18 30 28 C29 34 28 38 28 42 Z"/><path d="M23 9 C27 14 28 22 27 30" fill="none"/>',
  q: '<circle cx="11" cy="9" r="1.6"/><circle cx="17" cy="8" r="1.6"/><circle cx="23" cy="8" r="1.6"/><circle cx="29" cy="9" r="1.6"/><path d="M11 10 l3 8 l3-9 l3 9 l3-9 l3 9 l3-8 l-2 12 h-14z"/><path d="M14 22 h12 l-1 3 h-10z"/>' + cuerpo,
  k: '<path d="M19 2 h2 v3 h3 v2 h-3 v3 h-2 v-3 h-3 v-2 h3z"/><path d="M13 12 C15 10 25 10 27 12 l-2 10 h-10z"/><path d="M14 22 h12 v3 h-12z"/>' + cuerpo,
};

const nombres = { p: "peón", r: "torre", b: "alfil", n: "caballo", q: "dama", k: "rey" };

export function piezaSVG(tipo, color) {
  const blanca = color === "w";
  const relleno = blanca ? "#F2E6CF" : "#2E1E14";
  const borde = blanca ? "#6B4A2E" : "#0F0905";
  const brillo = blanca ? "#FFF9EE" : "#6A4A32";
  const ojo = tipo === "n" ? `<circle cx="19" cy="14" r="1.2" fill="${borde}"/>` : "";
  return `<svg viewBox="0 0 40 50" role="img" aria-label="${nombres[tipo]} ${blanca ? "blanco" : "negro"}">` +
    `<g fill="${relleno}" stroke="${borde}" stroke-width="1.2" stroke-linejoin="round">${formas[tipo]}${base}</g>` +
    `${ojo}<ellipse cx="17" cy="34" rx="1.3" ry="5" fill="${brillo}" opacity="0.6"/></svg>`;
}

// Ícono de jugador: cabeza de Rey o de Dama.
export function iconoSVG(avatar) {
  const tipo = avatar === "dama" ? "q" : "k";
  return `<svg viewBox="8 0 24 26" role="img" aria-label="${avatar === "dama" ? "Dama" : "Rey"}">` +
    `<g fill="#F2E6CF" stroke="#6B4A2E" stroke-width="1.2" stroke-linejoin="round">${formas[tipo]}</g></svg>`;
}
