// tests/auth/auth.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-19 — Script de autenticación — POST /api/auth/login
// Servicio: users-api :3001
// SLA (DEV-13): P95 < 450ms · Error rate < 0.5%
// Nota: usuarios se registran en setup() con email único por ejecución
// ─────────────────────────────────────────────────────────────────────────────

import http                        from 'k6/http';
import { check, sleep }            from 'k6';
import { htmlReport }              from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }             from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { authLoadOptions, THRESHOLDS } from '../../config/options.js';
import { USERS_URL, jsonHeaders }      from '../../lib/http.js';
import { register, login }             from '../../lib/auth.js';
import { newSessionId }                from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
export const options = {
  ...authLoadOptions,
  thresholds: THRESHOLDS.auth,
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
// Sin SharedArray estático — usuarios se crean dinámicamente en setup()
// para garantizar que existen en la DB antes de testear login.
const BASE_URL = USERS_URL;

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
// Registra 55 usuarios únicos por ejecución (cubre el target de 50 VUs).
// Email con timestamp para evitar conflictos entre ejecuciones sucesivas.
export function setup() {
  const runId   = Date.now();
  const count   = 55;
  const users   = [];
  const password = 'Perf1234!';

  console.log(`[DEV-19] Registrando ${count} usuarios de prueba (runId: ${runId})...`);

  for (let i = 1; i <= count; i++) {
    const email = `perf_auth_${i}_${runId}@loadtest.cl`;
    const { token } = register({ email, password, firstname: 'VU', lastname: `Auth${i}` });
    users.push({ email, password, token });
  }

  const ok = users.filter((u) => u.token).length;
  console.log(`[DEV-19] ${ok}/${count} usuarios registrados. Target: ${BASE_URL}/api/auth/login`);
  return { users };
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function (data) {
  const user      = data.users[(__VU - 1) % data.users.length];
  const sessionId = newSessionId();

  // ── Escenario 1: Login exitoso ───────────────────────────────────────────
  const { res: loginRes } = login(user, sessionId);

  check(loginRes, {
    '[auth] login: status 200':               (r) => r.status === 200,
    '[auth] login: respuesta tiene token':    (r) => {
      try { return typeof r.json().data.token === 'string'; }
      catch (_) { return false; }
    },
    '[auth] login: token tiene 3 partes (JWT)': (r) => {
      try { return r.json().data.token.split('.').length === 3; }
      catch (_) { return false; }
    },
    '[auth] login: token exp ≈ 24h': (r) => {
      try {
        const payload = JSON.parse(atob(r.json().data.token.split('.')[1]));
        const diffHrs = (payload.exp - payload.iat) / 3600;
        return diffHrs >= 23 && diffHrs <= 25;
      } catch (_) { return false; }
    },
    '[auth] login: tiempo < 450ms': (r) => r.timings.duration < 450,
  });

  sleep(Math.random() * 1 + 0.5);

  // ── Escenario 2: Login fallido → 401 ────────────────────────────────────
  const failRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: 'ContrasenaInvalida!' }),
    { headers: jsonHeaders({ 'X-Session-ID': newSessionId() }), tags: { service: 'auth' } }
  );

  check(failRes, {
    '[auth] login fallido: status 401': (r) => r.status === 401,
  });

  sleep(Math.random() * 2 + 1);
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/2026-06-05_load_auth/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
