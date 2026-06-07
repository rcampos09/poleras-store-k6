// tests/cart/cart.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-21 — Script de gestión de carrito
// Servicio: cart-service :3003
// SLA (DEV-13): P95 < 300ms · Error rate < 1%
// Flujo: agregar item al carrito → consultar carrito
// Requiere: JWT válido de users-api :3001
// ─────────────────────────────────────────────────────────────────────────────

import http                    from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray }         from 'k6/data';
import { htmlReport }          from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }         from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { cartLoadOptions, THRESHOLDS } from '../../config/options.js';
import { jsonHeaders }                 from '../../lib/http.js';
import { register }                    from '../../lib/auth.js';
import { newSessionId }                from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
export const options = {
  ...cartLoadOptions,
  thresholds: {
    ...THRESHOLDS.cart,
    'http_req_failed': [
      { threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '90s' },
    ],
  },
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
const variantIds = new SharedArray('variants', () =>
  JSON.parse(open('../../data/variants.json')).variant_ids
);

const CART_URL = __ENV.BASE_URL || 'http://localhost:3003';

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
// Registra usuarios únicos por ejecución y obtiene sus JWT.
// Los tokens se usan directamente en default() — sin re-login por iteración.
export function setup() {
  const runId    = Date.now();
  const count    = 55;
  const password = 'Perf1234!';
  const users    = [];

  console.log(`[DEV-21] Registrando ${count} usuarios (runId: ${runId})...`);

  for (let i = 1; i <= count; i++) {
    const email = `perf_cart_${i}_${runId}@loadtest.cl`;
    const { token } = register({ email, password, firstname: 'VU', lastname: `Cart${i}` });
    users.push({ email, token });
  }

  const ok = users.filter((u) => u.token).length;
  console.log(`[DEV-21] ${ok}/${count} usuarios listos. Target: ${CART_URL}/api/cart`);
  console.log(`[DEV-21] SLA: P95 < 300ms · Error rate < 1% (DEV-13)`);
  return { users };
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function (data) {
  const user      = data.users[(__VU - 1) % data.users.length];
  const token     = user.token;
  const sessionId = newSessionId();
  const variantId = variantIds[Math.floor(Math.random() * variantIds.length)];

  const authHeader = { 'Authorization': `Bearer ${token}`, 'X-Session-ID': sessionId };

  group('Gestión de Carrito', () => {

    // ── Paso 1: Agregar item al carrito ──────────────────────────────────
    group('POST /api/cart/items', () => {
      const res = http.post(
        `${CART_URL}/api/cart/items`,
        JSON.stringify({ variant_id: variantId, quantity: 1 }),
        { headers: jsonHeaders(authHeader), tags: { service: 'cart', endpoint: 'POST /api/cart/items' } }
      );

      check(res, {
        '[cart] agregar item: status 201':      (r) => r.status === 201,
        '[cart] agregar item: respuesta OK':    (r) => {
          try { return r.json().status === 'OK'; }
          catch (_) { return false; }
        },
        '[cart] agregar item: tiene total':     (r) => {
          try { return r.json().data.total !== undefined; }
          catch (_) { return false; }
        },
        '[cart] agregar item: tiempo < 300ms':  (r) => r.timings.duration < 300,
      });
    });

    sleep(Math.random() * 1 + 0.5);  // think time: usuario ve el carrito actualizado

    // ── Paso 2: Consultar carrito ────────────────────────────────────────
    group('GET /api/cart', () => {
      const res = http.get(
        `${CART_URL}/api/cart`,
        { headers: jsonHeaders(authHeader), tags: { service: 'cart', endpoint: 'GET /api/cart' } }
      );

      check(res, {
        '[cart] consultar: status 200':         (r) => r.status === 200,
        '[cart] consultar: tiene items':        (r) => {
          try { return Array.isArray(r.json().data.items) && r.json().data.items.length > 0; }
          catch (_) { return false; }
        },
        '[cart] consultar: tiene subtotal':     (r) => {
          try { return r.json().data.subtotal !== undefined; }
          catch (_) { return false; }
        },
        '[cart] consultar: tiene total':        (r) => {
          try { return r.json().data.total !== undefined; }
          catch (_) { return false; }
        },
        '[cart] consultar: tiempo < 300ms':     (r) => r.timings.duration < 300,
      });
    });

    sleep(Math.random() * 2 + 1);
  });
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/2026-06-05_load_cart/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
