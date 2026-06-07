// lib/session.js
// ─────────────────────────────────────────────────────────────────────────────
// Genera X-Session-ID único por VU/iteración para correlación de trazas
// en Loki y Tempo. Sin dependencias externas — usa globals de k6.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera un ID de sesión único por VU e iteración.
 * Formato: sess-<vu>-<iter>-<timestamp>-<random4hex>
 * Ejemplo: sess-3-7-1748900123456-a3f1
 *
 * @returns {string} ID de sesión para usar como header X-Session-ID
 */
export function newSessionId() {
  const rand = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
  return `sess-${__VU}-${__ITER}-${Date.now()}-${rand}`;
}
