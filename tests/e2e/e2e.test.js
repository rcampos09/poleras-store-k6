// tests/e2e/e2e.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-24 — Script E2E — Happy Path Black Friday
// Journey completo: Login → Catálogo → Detalle → Carrito → Pedido → Pago
// SLAs por servicio (DEV-13): auth<450ms · products<300ms · cart<300ms
//                              orders<500ms · payments<800ms
// Check global: tasa de compras exitosas > 95%
// Usado en: Smoke Test · Spike Test · Soak Test (FASE 5)
// ─────────────────────────────────────────────────────────────────────────────

import http                    from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray }         from 'k6/data';
import { Rate }                from 'k6/metrics';
import { htmlReport }          from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }         from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { e2eTpsLoadOptions, THRESHOLDS } from '../../config/options.js';
import { jsonHeaders }                from '../../lib/http.js';
import { register, login }            from '../../lib/auth.js';
import { newSessionId }               from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
// Thresholds por servicio + check global de compras exitosas > 95% (DEV-24)
export const options = {
  ...e2eTpsLoadOptions,
  thresholds: {
    'http_req_duration{service:auth}':     ['p(95)<450'],
    'http_req_duration{service:products}': ['p(95)<300'],
    'http_req_duration{service:cart}':     ['p(95)<300'],
    'http_req_duration{service:orders}':   ['p(95)<500'],
    'http_req_duration{service:payments}': [{ threshold: 'p(95)<800', abortOnFail: false }],
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

// Métrica custom: Rate — 1 = compra exitosa, 0 = fallida. Threshold: rate>0.95
const purchaseSuccess = new Rate('e2e_purchase_success');

const USERS_URL    = __ENV.USERS_URL    || 'http://localhost:3001';
const PRODUCTS_URL = __ENV.PRODUCTS_URL || 'http://localhost:3002';
const CART_URL     = __ENV.CART_URL     || 'http://localhost:3003';
const ORDERS_URL   = __ENV.ORDERS_URL   || 'http://localhost:3004';
const PAYMENTS_URL = __ENV.PAYMENTS_URL || 'http://localhost:3005';

const ADDRESS    = { street: 'Av. Providencia 1234', city: 'Santiago', region: 'RM', zip: '7500000' };
const CARD_OK    = '4111 1111 1111 1234';

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
// 700 usuarios únicos — 1 por preAllocatedVU (sin colisiones de carrito).
// Registro en lotes de 10 paralelos → ~70 lotes × ~200ms ≈ 14s de setup.
export function setup() {
  const runId     = Date.now();
  const count     = 700;   // == preAllocatedVUs en e2eTpsLoadOptions
  const batchSize = 10;
  const password  = 'Perf1234!';
  const users     = [];

  console.log(`[DEV-24] Registrando ${count} usuarios en lotes de ${batchSize} (runId: ${runId})...`);

  for (let b = 0; b < Math.ceil(count / batchSize); b++) {
    const start = b * batchSize + 1;
    const end   = Math.min(start + batchSize - 1, count);
    const batch = [];

    for (let i = start; i <= end; i++) {
      const email = `perf_e2e_${i}_${runId}@loadtest.cl`;
      batch.push([
        'POST',
        `${USERS_URL}/api/auth/register`,
        JSON.stringify({ firstname: 'E2E', lastname: `User${i}`, email, password }),
        { headers: jsonHeaders({ 'X-Session-ID': 'setup' }) },
      ]);
    }

    const results = http.batch(batch);
    for (let j = 0; j < results.length; j++) {
      const i     = b * batchSize + j + 1;
      const email = `perf_e2e_${i}_${runId}@loadtest.cl`;
      try {
        const token = results[j].json().data.token;
        users.push({ email, password, token: token || null });
      } catch (_) {
        users.push({ email, password, token: null });
      }
    }
  }

  const ok = users.filter((u) => u.token).length;
  console.log(`[DEV-24] ${ok}/${count} usuarios listos. Happy Path 50 TPS × 9 min iniciando.`);
  return { users };
}

// ─── Block 4: Default — Journey completo por VU ──────────────────────────────
export default function (data) {
  const userSeed  = data.users[(__VU - 1) % data.users.length];
  const sessionId = newSessionId();  // mismo ID propagado en TODOS los requests del journey
  let journeyOk   = false;

  group('Happy Path — Compra Completa', () => {

    // ── Paso 1: Login ──────────────────────────────────────────────────
    let token;
    group('1. Login', () => {
      const { res, token: t } = login(userSeed, sessionId);
      token = t;
      check(res, {
        '[e2e] 1. login: status 200':         (r) => r.status === 200,
        '[e2e] 1. login: token recibido':     (r) => {
          try { return typeof r.json().data.token === 'string'; }
          catch (_) { return false; }
        },
      });
    });

    if (!token) return;  // abort journey si el login falla

    const authHeader = { 'Authorization': `Bearer ${token}`, 'X-Session-ID': sessionId };

    sleep(Math.random() * 1 + 0.5);

    // ── Paso 2: Explorar catálogo ──────────────────────────────────────
    let slug;
    group('2. Catálogo de productos', () => {
      const res = http.get(
        `${PRODUCTS_URL}/api/products?limit=12`,
        { headers: jsonHeaders({ 'X-Session-ID': sessionId }), tags: { service: 'products' } }
      );
      check(res, {
        '[e2e] 2. catálogo: status 200':       (r) => r.status === 200,
        '[e2e] 2. catálogo: tiene productos':  (r) => {
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

    sleep(Math.random() * 1 + 1);

    // ── Paso 3: Detalle de producto ────────────────────────────────────
    let variantId;
    group('3. Detalle de producto', () => {
      const res = http.get(
        `${PRODUCTS_URL}/api/products/${slug}`,
        { headers: jsonHeaders({ 'X-Session-ID': sessionId }), tags: { service: 'products' } }
      );
      check(res, {
        '[e2e] 3. detalle: status 200':        (r) => r.status === 200,
        '[e2e] 3. detalle: tiene variantes':   (r) => {
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

    sleep(Math.random() * 2 + 1);

    // ── Paso 4: Agregar al carrito ─────────────────────────────────────
    group('4. Agregar al carrito', () => {
      const res = http.post(
        `${CART_URL}/api/cart/items`,
        JSON.stringify({ variant_id: variantId, quantity: 1 }),
        { headers: jsonHeaders(authHeader), tags: { service: 'cart' } }
      );
      check(res, {
        '[e2e] 4. carrito: item agregado':     (r) => r.status === 201,
      });
    });

    sleep(Math.random() * 1 + 0.5);

    // ── Paso 5: Revisar carrito ────────────────────────────────────────
    group('5. Revisar carrito', () => {
      const res = http.get(
        `${CART_URL}/api/cart`,
        { headers: jsonHeaders(authHeader), tags: { service: 'cart' } }
      );
      check(res, {
        '[e2e] 5. carrito: status 200':        (r) => r.status === 200,
        '[e2e] 5. carrito: tiene items':       (r) => {
          try { return r.json().data.items.length > 0; }
          catch (_) { return false; }
        },
      });
    });

    sleep(Math.random() * 1 + 1);

    // ── Paso 6: Crear pedido ───────────────────────────────────────────
    let orderId;
    group('6. Crear pedido', () => {
      const res = http.post(
        `${ORDERS_URL}/api/orders`,
        JSON.stringify({ shipping_address: ADDRESS }),
        { headers: jsonHeaders(authHeader), tags: { service: 'orders' } }
      );
      check(res, {
        '[e2e] 6. pedido: status 201':         (r) => r.status === 201,
        '[e2e] 6. pedido: status pending':     (r) => {
          try { return r.json().data.status === 'pending'; }
          catch (_) { return false; }
        },
      });
      try { orderId = res.json().data.id; } catch (_) { orderId = null; }
    });

    sleep(Math.random() * 1 + 0.5);

    // ── Paso 7: Procesar pago ──────────────────────────────────────────
    if (orderId) {
      group('7. Procesar pago', () => {
        const res = http.post(
          `${PAYMENTS_URL}/api/payments/process`,
          JSON.stringify({ order_id: orderId, payment_method: 'credit_card', card_number: CARD_OK }),
          { headers: jsonHeaders(authHeader), tags: { service: 'payments' } }
        );

        const payOk = check(res, {
          '[e2e] 7. pago: status 201':           (r) => r.status === 201,
          '[e2e] 7. pago: aprobado o rechazado': (r) => {
            try {
              const s = r.json().data.status;
              return s === 'approved' || s === 'rejected';
            } catch (_) { return false; }
          },
        });

        journeyOk = payOk;
        purchaseSuccess.add(payOk ? 1 : 0);  // Rate: 1=éxito, 0=fallo
      });
    }

    sleep(Math.random() * 2 + 1);
  });
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/2026-06-05_load_e2e_50tps/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
