// lib/http.js
// ─────────────────────────────────────────────────────────────────────────────
// BASE_URL y helpers de headers compartidos por todos los scripts k6.
// Usar __ENV.BASE_URL para cambiar el target sin modificar el script:
//   k6 run --env BASE_URL=http://localhost:3002 tests/products/products.test.js
// ─────────────────────────────────────────────────────────────────────────────

export const BASE_URL  = __ENV.BASE_URL  || 'http://localhost:3001';
// USERS_URL apunta siempre a users-api — no depende de BASE_URL
export const USERS_URL = __ENV.USERS_URL || 'http://localhost:3001';

/**
 * Construye headers con Content-Type/Accept JSON + cualquier header extra.
 * @param {Object} extra - Headers adicionales (p.ej. Authorization, X-Session-ID)
 * @returns {Object} Headers listos para pasar a http.post/get/etc.
 */
export function jsonHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    ...extra,
  };
}
