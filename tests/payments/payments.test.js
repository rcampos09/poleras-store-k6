// tests/payments/payments.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-23 — Script de procesamiento de pagos
// Servicio: payments-service :3005
// SLA (DEV-13): P95 < 800ms · Error rate < 0.1% — SLO más estricto
// Distribución: 80% aprobado / 20% rechazado (según ticket DEV-23)
// Flujo: item en carrito → crear pedido → procesar pago
// ─────────────────────────────────────────────────────────────────────────────

import http                    from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray }         from 'k6/data';
import { htmlReport }          from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }         from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { paymentsLoadOptions, THRESHOLDS } from '../../config/options.js';
import { jsonHeaders }                     from '../../lib/http.js';
import { register }                        from '../../lib/auth.js';
import { newSessionId }                    from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
export const options = {
  ...paymentsLoadOptions,
  thresholds: {
    ...THRESHOLDS.payments,
    'http_req_failed': [
      { threshold: 'rate<0.001', abortOnFail: true, delayAbortEval: '90s' },
    ],
  },
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
const variantIds = new SharedArray('variants', () =>
  JSON.parse(open('../../data/variants.json')).variant_ids
);

const PAYMENTS_URL = __ENV.BASE_URL   || 'http://localhost:3005';
const CART_URL     = __ENV.CART_URL   || 'http://localhost:3003';
const ORDERS_URL   = __ENV.ORDERS_URL || 'http://localhost:3004';

// Tarjetas de crédito de prueba
// 80% aprobado (cualquier número que no termine en 0000)
const CARD_APPROVED = '4111 1111 1111 1234';
// 20% rechazado
const CARD_REJECTED = '4111 1111 1111 0000';

const ADDRESS = { street: 'Av. Providencia 1234', city: 'Santiago', region: 'RM', zip: '7500000' };

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
export function setup() {
  const runId    = Date.now();
  const count    = 55;
  const password = 'Perf1234!';
  const users    = [];

  console.log(`[DEV-23] Registrando ${count} usuarios (runId: ${runId})...`);

  for (let i = 1; i <= count; i++) {
    const email = `perf_pay_${i}_${runId}@loadtest.cl`;
    const { token } = register({ email, password, firstname: 'VU', lastname: `Pay${i}` });
    users.push({ email, token });
  }

  const ok = users.filter((u) => u.token).length;
  console.log(`[DEV-23] ${ok}/${count} usuarios listos. Target: ${PAYMENTS_URL}/api/payments/process`);
  console.log(`[DEV-23] SLA: P95 < 800ms · Error rate < 0.1% (DEV-13) — SLO más estricto`);
  return { users };
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function (data) {
  const user      = data.users[(__VU - 1) % data.users.length];
  const token     = user.token;
  const sessionId = newSessionId();
  const variantId = variantIds[Math.floor(Math.random() * variantIds.length)];

  const authHeader = { 'Authorization': `Bearer ${token}`, 'X-Session-ID': sessionId };

  // Distribución 80/20 según DEV-23
  const useApprovedCard = Math.random() < 0.8;
  const cardNumber      = useApprovedCard ? CARD_APPROVED : CARD_REJECTED;

  group('Procesar Pago', () => {

    // ── Prerequisito 1: item en carrito ──────────────────────────────────
    group('POST /api/cart/items (prereq)', () => {
      http.post(
        `${CART_URL}/api/cart/items`,
        JSON.stringify({ variant_id: variantId, quantity: 1 }),
        { headers: jsonHeaders(authHeader), tags: { service: 'cart' } }
      );
    });

    sleep(Math.random() * 0.5 + 0.5);

    // ── Prerequisito 2: crear pedido ─────────────────────────────────────
    let orderId;
    group('POST /api/orders (prereq)', () => {
      const res = http.post(
        `${ORDERS_URL}/api/orders`,
        JSON.stringify({ shipping_address: ADDRESS }),
        { headers: jsonHeaders(authHeader), tags: { service: 'orders' } }
      );
      try { orderId = res.json().data.id; } catch (_) { orderId = null; }
    });

    sleep(Math.random() * 0.5 + 0.5);

    // ── Paso principal: procesar pago ────────────────────────────────────
    if (orderId) {
      group('POST /api/payments/process', () => {
        const res = http.post(
          `${PAYMENTS_URL}/api/payments/process`,
          JSON.stringify({ order_id: orderId, payment_method: 'credit_card', card_number: cardNumber }),
          { headers: jsonHeaders(authHeader), tags: { service: 'payments', endpoint: 'POST /api/payments/process' } }
        );

        check(res, {
          '[payments] pago: status 201':                (r) => r.status === 201,
          '[payments] pago: status approved o rejected': (r) => {
            try {
              const s = r.json().data.status;
              return s === 'approved' || s === 'rejected';
            } catch (_) { return false; }
          },
          '[payments] aprobado tiene transaction_id':   (r) => {
            try {
              const d = r.json().data;
              if (d.status === 'approved') return typeof d.transaction_id === 'string';
              return true;  // rechazado no tiene transaction_id, es válido
            } catch (_) { return false; }
          },
          '[payments] rechazado tiene reason':          (r) => {
            try {
              const d = r.json().data;
              if (d.status === 'rejected') return typeof d.reason === 'string';
              return true;  // aprobado no tiene reason, es válido
            } catch (_) { return false; }
          },
          '[payments] pago: tiempo < 800ms':            (r) => r.timings.duration < 800,
        });
      });
    }

    sleep(Math.random() * 2 + 1);
  });
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/2026-06-05_load_payments/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
