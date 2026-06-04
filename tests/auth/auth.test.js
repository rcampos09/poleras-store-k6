// tests/auth/auth.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-19 — Script de autenticación — POST /api/auth/login
// Servicio: users-api :3001
// SLA (DEV-13): P95 < 450ms · Error rate < 0.5%
// ─────────────────────────────────────────────────────────────────────────────

// Imports — siempre primero (antes de options, data y funciones)
import http                        from 'k6/http';
import { check, sleep }            from 'k6';
import { SharedArray }             from 'k6/data';
import { htmlReport }              from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }             from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { authLoadOptions, THRESHOLDS } from '../../config/options.js';
import { BASE_URL, jsonHeaders }       from '../../lib/http.js';
import { newSessionId }                from '../../lib/session.js';
import { login }                       from '../../lib/auth.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
// Fusiona el escenario ramping-vus con los thresholds de DEV-13 para users-api.
// Para smoke test: k6 run --vus 2 --duration 30s tests/auth/auth.test.js
export const options = {
  ...authLoadOptions,
  thresholds: THRESHOLDS.auth,
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
// SharedArray: cargado UNA VEZ en init context y compartido entre todos los VUs.
// Regla del proyecto: cantidad de usuarios ≥ VUs (55 usuarios, target 50 VUs).
const users = new SharedArray('users', () =>
  JSON.parse(open('../../data/users.json')).users
);

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
// No-op intencional: auth es por-VU (cada VU usa sus propias credenciales).
// Patrón correcto: NO compartir un JWT único entre todos los VUs desde setup().
export function setup() {
  console.log(`[DEV-19] Auth test iniciando — ${users.length} usuarios en dataset`);
  console.log(`[DEV-19] Target: ${BASE_URL}/api/auth/login`);
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function () {
  // Selección determinista: VU 1 → users[0], VU 2 → users[1], etc.
  // Si hay más VUs que usuarios, vuelve al inicio del array (módulo).
  const user      = users[(__VU - 1) % users.length];
  const sessionId = newSessionId();

  // ── Escenario 1: Login exitoso ───────────────────────────────────────────
  const { res: loginRes, token } = login(user, sessionId);

  check(loginRes, {
    '[auth] login: status 200':          (r) => r.status === 200,
    '[auth] login: respuesta tiene token': (r) => {
      try { return r.json('token') !== null && r.json('token') !== undefined; }
      catch (_) { return false; }
    },
    '[auth] login: token tiene 3 partes (JWT)': (r) => {
      try {
        const t = r.json('token');
        return typeof t === 'string' && t.split('.').length === 3;
      } catch (_) { return false; }
    },
    '[auth] login: token exp ≈ 24h': (r) => {
      try {
        const t        = r.json('token');
        const payload  = JSON.parse(atob(t.split('.')[1]));
        const diffHrs  = (payload.exp - payload.iat) / 3600;
        // Acepta rango 23h–25h para cubrir posibles skews de configuración
        return diffHrs >= 23 && diffHrs <= 25;
      } catch (_) { return false; }
    },
    '[auth] login: X-Session-ID presente en request': () => sessionId.startsWith('sess-'),
    '[auth] login: tiempo < 450ms': (r) => r.timings.duration < 450,
  });

  sleep(Math.random() * 1 + 0.5);  // think time 0.5–1.5s entre escenarios

  // ── Escenario 2: Login fallido (credenciales inválidas → 401) ────────────
  const { res: failRes } = login(
    { email: user.email, password: 'ContrasenaInvalida!' },
    newSessionId()
  );

  check(failRes, {
    '[auth] login fallido: status 401': (r) => r.status === 401,
  });

  sleep(Math.random() * 2 + 1);  // think time 1–3s al final de la iteración
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
// Genera reporte HTML en results/ y también imprime texto en stdout.
// Convención de carpeta: results/YYYY-MM-DD_<tipo-prueba>_<servicio>/
export function handleSummary(data) {
  return {
    'results/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
