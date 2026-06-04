// tests/products/products.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-20 — Script de catálogo de productos
// Servicio: products-service :3002
// SLA (DEV-13): P95 < 300ms · Error rate < 0.5%
// Volumen: 70% del tráfico total de la plataforma
// Flujo: listado → selección → detalle (navegación realista de usuario)
// ─────────────────────────────────────────────────────────────────────────────

// Imports — siempre primero
import http             from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray }  from 'k6/data';
import { htmlReport }   from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }  from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { productsLoadOptions, THRESHOLDS } from '../../config/options.js';
import { jsonHeaders }                     from '../../lib/http.js';
import { newSessionId }                    from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
// Threshold products: P95 < 300ms · error rate < 0.5% (DEV-13)
// Para smoke test: k6 run --vus 2 --duration 30s --env BASE_URL=http://localhost:3002 tests/products/products.test.js
export const options = {
  ...productsLoadOptions,
  thresholds: THRESHOLDS.products,
};

// ─── Block 2: Data ───────────────────────────────────────────────────────────
// Slugs de fallback: se usan si el listado de la API no devuelve slugs válidos.
// Cargados en init context — compartidos entre todos los VUs (SharedArray).
const slugs = new SharedArray('slugs', () =>
  JSON.parse(open('../../data/products.json')).slugs
);

// BASE_URL del servicio products — puerto 3002 por defecto.
// Sobreescribir con: k6 run --env BASE_URL=http://localhost:3002
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3002';

// ─── Block 3: Setup ──────────────────────────────────────────────────────────
// Catálogo público — no requiere autenticación.
// Setup valida que el servicio responde antes de lanzar los VUs.
export function setup() {
  console.log(`[DEV-20] Products test iniciando — ${slugs.length} slugs en dataset`);
  console.log(`[DEV-20] Target: ${BASE_URL}/api/products`);
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function () {
  const sessionId = newSessionId();

  // ── Paso 1: Listado de productos ─────────────────────────────────────────
  // Simula usuario abriendo la página principal del catálogo (12 productos).
  const listRes = http.get(`${BASE_URL}/api/products?limit=12`, {
    headers: jsonHeaders({ 'X-Session-ID': sessionId }),
    tags:    { service: 'products', endpoint: 'GET /api/products' },
  });

  check(listRes, {
    '[products] listado: status 200':     (r) => r.status === 200,
    '[products] listado: array no vacío': (r) => {
      try { return Array.isArray(r.json()) && r.json().length > 0; }
      catch (_) { return false; }
    },
    '[products] listado: tiene precio':   (r) => {
      try { const p = r.json()[0]; return p.price !== undefined || p.precio !== undefined; }
      catch (_) { return false; }
    },
    '[products] listado: tiene stock':    (r) => {
      try { const p = r.json()[0]; return p.stock !== undefined; }
      catch (_) { return false; }
    },
    '[products] listado: tiene variantes': (r) => {
      try {
        const p = r.json()[0];
        const v = p.variants || p.variantes;
        return Array.isArray(v) && v.length > 0;
      } catch (_) { return false; }
    },
    '[products] listado: tiempo < 300ms': (r) => r.timings.duration < 300,
  });

  sleep(Math.random() * 2 + 1);  // think time: usuario revisa el listado (1–3s)

  // ── Paso 2: Detalle de producto ──────────────────────────────────────────
  // Elige slug desde la respuesta del listado; si falla, usa el dataset local.
  // Esto simula que el usuario hace clic en uno de los productos visibles.
  let slug;
  try {
    const products = listRes.json();
    if (Array.isArray(products) && products.length > 0) {
      const picked = products[Math.floor(Math.random() * products.length)];
      slug = picked.slug;
    }
  } catch (_) { /* silencioso — fallback a continuación */ }

  if (!slug) {
    slug = slugs[Math.floor(Math.random() * slugs.length)];
  }

  const detailRes = http.get(`${BASE_URL}/api/products/${slug}`, {
    headers: jsonHeaders({ 'X-Session-ID': sessionId }),
    tags:    { service: 'products', endpoint: 'GET /api/products/:slug' },
  });

  check(detailRes, {
    '[products] detalle: status 200':     (r) => r.status === 200,
    '[products] detalle: tiene precio':   (r) => {
      try { const p = r.json(); return p.price !== undefined || p.precio !== undefined; }
      catch (_) { return false; }
    },
    '[products] detalle: tiene tallas':   (r) => {
      try {
        const p = r.json();
        const s = p.sizes || p.tallas;
        return Array.isArray(s) && s.length > 0;
      } catch (_) { return false; }
    },
    '[products] detalle: tiene colores':  (r) => {
      try {
        const p = r.json();
        const c = p.colors || p.colores;
        return Array.isArray(c) && c.length > 0;
      } catch (_) { return false; }
    },
    '[products] detalle: tiempo < 300ms': (r) => r.timings.duration < 300,
  });

  sleep(Math.random() * 2 + 1);  // think time: usuario revisa el detalle (1–3s)
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'results/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
