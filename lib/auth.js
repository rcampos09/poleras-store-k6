// lib/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Helpers de autenticación — register y login por-VU con JWT individual.
// Siempre apunta a users-api vía USERS_URL (nunca sobreescrito por BASE_URL).
// Estructura real de respuesta: { status, code, data: { token } }
// ─────────────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { USERS_URL, jsonHeaders } from './http.js';

/**
 * Registra un nuevo usuario y retorna su JWT.
 * Útil en setup() para crear usuarios de prueba únicos por ejecución.
 *
 * @param {{ email, password, firstname?, lastname? }} user
 * @param {string} [sessionId]
 * @returns {{ res: Response, token: string|null }}
 */
export function register(user, sessionId) {
  const res = http.post(
    `${USERS_URL}/api/auth/register`,
    JSON.stringify({
      firstname: user.firstname || 'VU',
      lastname:  user.lastname  || 'Test',
      email:     user.email,
      password:  user.password,
    }),
    {
      headers: jsonHeaders({ 'X-Session-ID': sessionId || 'setup' }),
      tags:    { service: 'auth' },
    }
  );
  const token = res.status === 201 ? res.json().data.token : null;
  return { res, token };
}

/**
 * Realiza POST /api/auth/login y retorna JWT.
 * Cada VU llama login() con sus propias credenciales — nunca compartir tokens.
 *
 * @param {{ email, password }} user
 * @param {string} sessionId — X-Session-ID para trazas en Loki/Tempo
 * @returns {{ res: Response, token: string|null }}
 */
export function login(user, sessionId) {
  const res = http.post(
    `${USERS_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    {
      headers: jsonHeaders({ 'X-Session-ID': sessionId }),
      tags:    { service: 'auth' },
    }
  );
  const token = res.status === 200 ? res.json().data.token : null;
  return { res, token };
}
