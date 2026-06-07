// tests/products/products.test.js
// ─────────────────────────────────────────────────────────────────────────────
// DEV-20 — Load Test · Catálogo de productos
// Servicio: products-service :3002
// Tipo: Load Test — carga normal sostenida (baseline de producción)
// SLA (DEV-13): P95 < 300ms · Error rate < 0.5%
// Volumen: 70% del tráfico total de la plataforma
// Flujo: listado → selección → detalle (navegación realista de usuario)
// Resultado: results/2026-06-04_load_products/report.html
// ─────────────────────────────────────────────────────────────────────────────

// Imports — siempre primero
import http                    from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray }         from 'k6/data';
import { htmlReport }          from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary }         from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { productsLoadOptions, THRESHOLDS } from '../../config/options.js';
import { jsonHeaders }                     from '../../lib/http.js';
import { newSessionId }                    from '../../lib/session.js';

// ─── Block 1: Options ────────────────────────────────────────────────────────
// Threshold products: P95 < 300ms · error rate < 0.5% (DEV-13)
// abortOnFail: aborta si error rate > 50% antes de los 90s (regla de corte CLAUDE.md)
// Para smoke test: k6 run --vus 2 --duration 30s --env BASE_URL=http://localhost:3002 tests/products/products.test.js
export const options = {
  ...productsLoadOptions,
  thresholds: {
    ...THRESHOLDS.products,
    'http_req_failed': [
      { threshold: 'rate<0.005', abortOnFail: true, delayAbortEval: '90s' },
    ],
  },
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
export function setup() {
  console.log(`[DEV-20] LOAD TEST — products-service :3002`);
  console.log(`[DEV-20] Target: ${BASE_URL}/api/products`);
  console.log(`[DEV-20] SLA: P95 < 300ms · Error rate < 0.5% (DEV-13)`);
  console.log(`[DEV-20] Dataset: ${slugs.length} slugs de fallback`);
}

// ─── Block 4: Default (workload por VU) ──────────────────────────────────────
export default function () {
  const sessionId = newSessionId();

  group('Explorar Catálogo', () => {

    // ── Paso 1: Listado de productos ───────────────────────────────────────
    let listRes;
    group('GET /api/products', () => {
      listRes = http.get(`${BASE_URL}/api/products?limit=12`, {
        headers: jsonHeaders({ 'X-Session-ID': sessionId }),
        tags:    { service: 'products', endpoint: 'GET /api/products' },
      });

      // Respuesta real: { status, code, data: [...] }
      // Campos: base_price · variants_in_stock · available_colors · available_sizes
      check(listRes, {
        '[products] listado: status 200':      (r) => r.status === 200,
        '[products] listado: array no vacío':  (r) => {
          try { return Array.isArray(r.json().data) && r.json().data.length > 0; }
          catch (_) { return false; }
        },
        '[products] listado: tiene precio':    (r) => {
          try { return r.json().data[0].base_price !== undefined; }
          catch (_) { return false; }
        },
        '[products] listado: tiene stock':     (r) => {
          try { return r.json().data[0].variants_in_stock !== undefined; }
          catch (_) { return false; }
        },
        '[products] listado: tiene variantes': (r) => {
          try {
            const p = r.json().data[0];
            return Array.isArray(p.available_colors) && p.available_colors.length > 0;
          } catch (_) { return false; }
        },
        '[products] listado: tiempo < 300ms':  (r) => r.timings.duration < 300,
      });
    });

    sleep(Math.random() * 2 + 1);  // think time: usuario revisa el listado (1–3s)

    // ── Paso 2: Detalle de producto ────────────────────────────────────────
    // Elige slug desde data[] de la respuesta del listado (realista).
    // Fallback al SharedArray si el listado no devuelve data válida.
    let slug;
    try {
      const products = listRes.json().data;
      if (Array.isArray(products) && products.length > 0) {
        slug = products[Math.floor(Math.random() * products.length)].slug;
      }
    } catch (_) { /* fallback a continuación */ }

    if (!slug) {
      slug = slugs[Math.floor(Math.random() * slugs.length)];
    }

    group('GET /api/products/:slug', () => {
      const detailRes = http.get(`${BASE_URL}/api/products/${slug}`, {
        headers: jsonHeaders({ 'X-Session-ID': sessionId }),
        tags:    { service: 'products', endpoint: 'GET /api/products/:slug' },
      });

      // Respuesta real: { status, code, data: { base_price, variants: [{size, color, stock}] } }
      check(detailRes, {
        '[products] detalle: status 200':     (r) => r.status === 200,
        '[products] detalle: tiene precio':   (r) => {
          try { return r.json().data.base_price !== undefined; }
          catch (_) { return false; }
        },
        '[products] detalle: tiene tallas':   (r) => {
          try {
            const variants = r.json().data.variants;
            return Array.isArray(variants) && variants.some((v) => v.size);
          } catch (_) { return false; }
        },
        '[products] detalle: tiene colores':  (r) => {
          try {
            const variants = r.json().data.variants;
            return Array.isArray(variants) && variants.some((v) => v.color);
          } catch (_) { return false; }
        },
        '[products] detalle: tiempo < 300ms': (r) => r.timings.duration < 300,
      });
    });

    sleep(Math.random() * 2 + 1);  // think time: usuario revisa el detalle (1–3s)
  });
}

// ─── Block 5: Summary ────────────────────────────────────────────────────────
// Convención de carpeta: results/YYYY-MM-DD_<tipo-prueba>_<servicio>/
export function handleSummary(data) {
  return {
    'results/2026-06-04_load_products/report.html': htmlReport(data),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
