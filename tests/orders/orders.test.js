// tests/orders/orders.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-22 — Script de creación de pedido (cross-service)
// Servicio principal: orders-service :3004
// SLA (DEV-13): P95 < 500ms · Error rate < 0.5%
// Cadena interna: orders → cart-service → products-service (3 saltos)
// Flujo: agregar item a carrito → crear pedido → verificar estado pending
// ─────────────────────────────────────────────────────────────────────────────

import http                    from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray }         from 'k6/data';
import { htmlReport }          from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }         from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { ordersLoadOptions, THRESHOLDS } from '../../config/options.js';
import { jsonHeaders }                   from '../../lib/http.js';
import { register }                      from '../../lib/auth.js';
import { newSessionId }                  from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
export const options = {
  ...ordersLoadOptions,
  thresholds: {
    ...THRESHOLDS.orders,
    'http_req_failed': [
      { threshold: 'rate<0.005', abortOnFail: true, delayAbortEval: '90s' },
    ],
  },
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
const variantIds = new SharedArray('variants', () =>
  JSON.parse(open('../../data/variants.json')).variant_ids
);

const ORDERS_URL = __ENV.BASE_URL      || 'http://localhost:3004';
const CART_URL   = __ENV.CART_URL      || 'http://localhost:3003';

// Direcciones de envío rotativas para simular diversidad de datos
const ADDRESSES = [
  { street: 'Av. Providencia 1234',   city: 'Santiago',   region: 'RM',          zip: '7500000' },
  { street: 'Calle Los Leones 567',   city: 'Providencia', region: 'RM',         zip: '7510000' },
  { street: 'Av. Apoquindo 3000',     city: 'Las Condes',  region: 'RM',         zip: '7550000' },
  { street: 'Pasaje Las Flores 89',   city: 'Valparaíso',  region: 'Valparaíso', zip: '2340000' },
  { street: 'Calle Larga 456',        city: 'Concepción',  region: 'Biobío',     zip: '4030000' },
];

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
export function setup() {
  const runId    = Date.now();
  const count    = 55;
  const password = 'Perf1234!';
  const users    = [];

  console.log(`[DEV-22] Registrando ${count} usuarios (runId: ${runId})...`);

  for (let i = 1; i <= count; i++) {
    const email = `perf_orders_${i}_${runId}@loadtest.cl`;
    const { token } = register({ email, password, firstname: 'VU', lastname: `Order${i}` });
    users.push({ email, token });
  }

  const ok = users.filter((u) => u.token).length;
  console.log(`[DEV-22] ${ok}/${count} usuarios listos. Target: ${ORDERS_URL}/api/orders`);
  console.log(`[DEV-22] SLA: P95 < 500ms · Error rate < 0.5% (DEV-13) — cross-service chain`);
  return { users };
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function (data) {
  const user      = data.users[(__VU - 1) % data.users.length];
  const token     = user.token;
  const sessionId = newSessionId();
  const variantId = variantIds[Math.floor(Math.random() * variantIds.length)];
  const address   = ADDRESSES[Math.floor(Math.random() * ADDRESSES.length)];

  const authHeader = { 'Authorization': `Bearer ${token}`, 'X-Session-ID': sessionId };

  group('Crear Pedido', () => {

    // ── Prerequisito: item en carrito ────────────────────────────────────
    // orders-service valida el carrito vía cart-service antes de crear el pedido.
    group('POST /api/cart/items (prereq)', () => {
      http.post(
        `${CART_URL}/api/cart/items`,
        JSON.stringify({ variant_id: variantId, quantity: 1 }),
        { headers: jsonHeaders(authHeader), tags: { service: 'cart' } }
      );
    });

    sleep(Math.random() * 1 + 0.5);

    // ── Paso principal: crear pedido (cross-service) ──────────────────────
    // Cadena interna: orders → cart-service → products-service → DB
    group('POST /api/orders', () => {
      const res = http.post(
        `${ORDERS_URL}/api/orders`,
        JSON.stringify({ shipping_address: address }),
        { headers: jsonHeaders(authHeader), tags: { service: 'orders', endpoint: 'POST /api/orders' } }
      );

      check(res, {
        '[orders] crear pedido: status 201':           (r) => r.status === 201,
        '[orders] crear pedido: tiene order_id':       (r) => {
          try { return r.json().data.id !== undefined; }
          catch (_) { return false; }
        },
        '[orders] crear pedido: status pending':       (r) => {
          try { return r.json().data.status === 'pending'; }
          catch (_) { return false; }
        },
        '[orders] crear pedido: tiene order_number':   (r) => {
          try {
            const num = r.json().data.order_number;
            return typeof num === 'string' && num.startsWith('POL-');
          } catch (_) { return false; }
        },
        '[orders] crear pedido: tiempo < 500ms':       (r) => r.timings.duration < 500,
      });
    });

    sleep(Math.random() * 2 + 1);
  });
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/2026-06-05_load_orders/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
