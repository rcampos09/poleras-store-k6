// config/options.js
// ─────────────────────────────────────────────────────────────────────────────
// SLAs aprobados por el equipo de Arquitectura — Ticket DEV-13 (2026-03-30)
// NUNCA modificar estos valores sin aprobación. Fuente de verdad: DEV-13.
// ─────────────────────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  // users-api :3001 — P95 actualizado 200ms → 450ms por latencia base de bcrypt (~170ms)
  auth: {
    'http_req_duration{service:auth}': ['p(95)<450'],
    'http_req_failed':                 ['rate<0.005'],  // < 0.5%
    'checks':                          ['rate>0.99'],
  },

  // products-service :3002
  products: {
    'http_req_duration{service:products}': ['p(95)<300'],
    'http_req_failed':                     ['rate<0.005'],
    'checks':                              ['rate>0.99'],
  },

  // cart-service :3003
  cart: {
    'http_req_duration{service:cart}': ['p(95)<300'],
    'http_req_failed':                 ['rate<0.01'],   // < 1%
    'checks':                          ['rate>0.99'],
  },

  // orders-service :3004
  orders: {
    'http_req_duration{service:orders}': ['p(95)<500'],
    'http_req_failed':                   ['rate<0.005'],
    'checks':                            ['rate>0.99'],
  },

  // payments-service :3005
  payments: {
    'http_req_duration{service:payments}': ['p(95)<800'],
    'http_req_failed':                     ['rate<0.001'],  // < 0.1%
    'checks':                              ['rate>0.99'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Escenario de carga — ramping-vus (closed model, default para FASE 5)
// Equivalente a: ramp-up 2m → hold 5m a 50 VUs → ramp-down 2m
// Sobreescribible en smoke con: k6 run --vus 2 --duration 30s
// ─────────────────────────────────────────────────────────────────────────────

// Escenario base compartido — ramp-up 2m → hold 5m a 50 VUs → ramp-down 2m
// Todos los scripts de servicio individual usan este perfil en FASE 5.
// Sobreescribible en smoke con: k6 run --vus 2 --duration 30s
const baseLoadScenario = {
  scenarios: {
    load: {
      executor:         'ramping-vus',
      startVUs:         0,
      stages: [
        { duration: '2m', target: 50 },  // ramp-up
        { duration: '5m', target: 50 },  // hold
        { duration: '2m', target: 0  },  // ramp-down
      ],
      gracefulRampDown: '30s',
      gracefulStop:     '30s',
    },
  },
};

export const authLoadOptions     = baseLoadScenario;
export const productsLoadOptions = baseLoadScenario;
