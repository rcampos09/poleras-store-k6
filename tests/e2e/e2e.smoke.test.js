// tests/e2e/e2e.smoke.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-24 — Smoke Test E2E — Happy Path Black Friday
// Objetivo: validar que el journey completo funciona antes de correr el load test.
// 1 VU · 2 iteraciones · ~30s total
// ─────────────────────────────────────────────────────────────────────────────

import http                    from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray }         from 'k6/data';
import { Rate }                from 'k6/metrics';
import { htmlReport }          from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }         from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { jsonHeaders }   from '../../lib/http.js';
import { register, login } from '../../lib/auth.js';
import { newSessionId }  from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
export const options = {
  vus:        1,
  iterations: 2,
  thresholds: {
    'http_req_duration{service:auth}':     ['p(95)<450'],
    'http_req_duration{service:products}': ['p(95)<300'],
    'http_req_duration{service:cart}':     ['p(95)<300'],
    'http_req_duration{service:orders}':   ['p(95)<500'],
    'http_req_duration{service:payments}': ['p(95)<800'],
    'http_req_failed':                     ['rate<0.005'],
    'checks':                              ['rate>0.95'],
    'e2e_purchase_success':                ['rate>0.95'],
  },
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
const slugs = new SharedArray('slugs', () =>
  JSON.parse(open('../../data/products.json')).slugs
);

const variantIds = new SharedArray('variants', () =>
  JSON.parse(open('../../data/variants.json')).variant_ids
);

const purchaseSuccess = new Rate('e2e_purchase_success');

const USERS_URL    = __ENV.USERS_URL    || 'http://localhost:3001';
const PRODUCTS_URL = __ENV.PRODUCTS_URL || 'http://localhost:3002';
const CART_URL     = __ENV.CART_URL     || 'http://localhost:3003';
const ORDERS_URL   = __ENV.ORDERS_URL   || 'http://localhost:3004';
const PAYMENTS_URL = __ENV.PAYMENTS_URL || 'http://localhost:3005';

const ADDRESS = { street: 'Av. Providencia 1234', city: 'Santiago', region: 'RM', zip: '7500000' };
const CARD_OK = '4111 1111 1111 1234';

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
export function setup() {
  const runId    = Date.now();
  const count    = 3;
  const password = 'Perf1234!';
  const users    = [];

  console.log(`[DEV-24 smoke] Registrando ${count} usuarios (runId: ${runId})...`);

  for (let i = 1; i <= count; i++) {
    const email = `perf_e2e_smoke_${i}_${runId}@loadtest.cl`;
    const { token } = register({ email, password, firstname: 'E2E', lastname: `Smoke${i}` });
    users.push({ email, password, token });
  }

  const ok = users.filter((u) => u.token).length;
  console.log(`[DEV-24 smoke] ${ok}/${count} usuarios listos.`);
  return { users };
}

// ─── Block 4: Default — Journey completo por VU ──────────────────────────────
export default function (data) {
  const userSeed  = data.users[(__VU - 1) % data.users.length];
  const sessionId = newSessionId();
  let journeyOk   = false;

  group('Happy Path — Compra Completa', () => {

    // ── Paso 1: Login ──────────────────────────────────────────────────
    let token;
    group('1. Login', () => {
      const { res, token: t } = login(userSeed, sessionId);
      token = t;
      check(res, {
        '[smoke] 1. login: status 200':     (r) => r.status === 200,
        '[smoke] 1. login: token recibido': (r) => {
          try { return typeof r.json().data.token === 'string'; }
          catch (_) { return false; }
        },
      });
    });

    if (!token) return;

    const authHeader = { 'Authorization': `Bearer ${token}`, 'X-Session-ID': sessionId };

    sleep(0.5);

    // ── Paso 2: Explorar catálogo ──────────────────────────────────────
    let slug;
    group('2. Catálogo de productos', () => {
      const res = http.get(
        `${PRODUCTS_URL}/api/products?limit=12`,
        { headers: jsonHeaders({ 'X-Session-ID': sessionId }), tags: { service: 'products' } }
      );
      check(res, {
        '[smoke] 2. catálogo: status 200':      (r) => r.status === 200,
        '[smoke] 2. catálogo: tiene productos': (r) => {
          try { return r.json().data.length > 0; }
          catch (_) { return false; }
        },
      });
      try {
        const products = res.json().data;
        slug = products[Math.floor(Math.random() * products.length)].slug;
      } catch (_) {
        slug = slugs[Math.floor(Math.random() * slugs.length)];
      }
    });

    sleep(0.5);

    // ── Paso 3: Detalle de producto ────────────────────────────────────
    let variantId;
    group('3. Detalle de producto', () => {
      const res = http.get(
        `${PRODUCTS_URL}/api/products/${slug}`,
        { headers: jsonHeaders({ 'X-Session-ID': sessionId }), tags: { service: 'products' } }
      );
      check(res, {
        '[smoke] 3. detalle: status 200':      (r) => r.status === 200,
        '[smoke] 3. detalle: tiene variantes': (r) => {
          try { return r.json().data.variants.length > 0; }
          catch (_) { return false; }
        },
      });
      try {
        const variants = res.json().data.variants.filter((v) => v.stock > 0);
        variantId = variants.length > 0
          ? variants[Math.floor(Math.random() * variants.length)].id
          : variantIds[Math.floor(Math.random() * variantIds.length)];
      } catch (_) {
        variantId = variantIds[Math.floor(Math.random() * variantIds.length)];
      }
    });

    sleep(0.5);

    // ── Paso 4: Agregar al carrito ─────────────────────────────────────
    group('4. Agregar al carrito', () => {
      const res = http.post(
        `${CART_URL}/api/cart/items`,
        JSON.stringify({ variant_id: variantId, quantity: 1 }),
        { headers: jsonHeaders(authHeader), tags: { service: 'cart' } }
      );
      check(res, {
        '[smoke] 4. carrito: item agregado': (r) => r.status === 201,
      });
    });

    sleep(0.5);

    // ── Paso 5: Revisar carrito ────────────────────────────────────────
    group('5. Revisar carrito', () => {
      const res = http.get(
        `${CART_URL}/api/cart`,
        { headers: jsonHeaders(authHeader), tags: { service: 'cart' } }
      );
      check(res, {
        '[smoke] 5. carrito: status 200':  (r) => r.status === 200,
        '[smoke] 5. carrito: tiene items': (r) => {
          try { return r.json().data.items.length > 0; }
          catch (_) { return false; }
        },
      });
    });

    sleep(0.5);

    // ── Paso 6: Crear pedido ───────────────────────────────────────────
    let orderId;
    group('6. Crear pedido', () => {
      const res = http.post(
        `${ORDERS_URL}/api/orders`,
        JSON.stringify({ shipping_address: ADDRESS }),
        { headers: jsonHeaders(authHeader), tags: { service: 'orders' } }
      );
      check(res, {
        '[smoke] 6. pedido: status 201':   (r) => r.status === 201,
        '[smoke] 6. pedido: pending':      (r) => {
          try { return r.json().data.status === 'pending'; }
          catch (_) { return false; }
        },
      });
      try { orderId = res.json().data.id; } catch (_) { orderId = null; }
    });

    sleep(0.5);

    // ── Paso 7: Procesar pago ──────────────────────────────────────────
    if (orderId) {
      group('7. Procesar pago', () => {
        const res = http.post(
          `${PAYMENTS_URL}/api/payments/process`,
          JSON.stringify({ order_id: orderId, payment_method: 'credit_card', card_number: CARD_OK }),
          { headers: jsonHeaders(authHeader), tags: { service: 'payments' } }
        );

        const payOk = check(res, {
          '[smoke] 7. pago: status 201':           (r) => r.status === 201,
          '[smoke] 7. pago: aprobado o rechazado': (r) => {
            try {
              const s = r.json().data.status;
              return s === 'approved' || s === 'rejected';
            } catch (_) { return false; }
          },
        });

        journeyOk = payOk;
        purchaseSuccess.add(payOk ? 1 : 0);
      });
    }
  });
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/2026-06-05_smoke_e2e/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
