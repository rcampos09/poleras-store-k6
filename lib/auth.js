// lib/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Helper de autenticación — login por-VU con JWT individual.
// ANTI-PATRÓN evitado: NO se llama desde setup() para compartir 1 token entre
// todos los VUs. Cada VU llama login() con sus propias credenciales.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { BASE_URL, jsonHeaders } from './http.js';

/**
 * Realiza POST /api/auth/login y retorna la respuesta y el token JWT.
 * Usa el tag { service: 'auth' } para que los thresholds de DEV-13 apliquen.
 *
 * @param {{ email: string, password: string }} user - Credenciales del usuario
 * @param {string} sessionId - X-Session-ID generado por lib/session.js
 * @returns {{ res: Response, token: string|null }}
 */
export function login(user, sessionId) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    {
      headers: jsonHeaders({ 'X-Session-ID': sessionId }),
      tags:    { service: 'auth' },
    }
  );

  const token = res.status === 200 ? res.json('token') : null;
  return { res, token };
}
