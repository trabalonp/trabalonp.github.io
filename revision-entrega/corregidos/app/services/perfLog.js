// services/perfLog.js
// Contadores de instrumentación EN MEMORIA, sin dependencias y sin red.
// Sirven para medir cuántas lecturas/bytes/puntos hace cada camino de cálculo
// (legacy vs digest de curvas) y para compararlos en Node (tests) y en __DEV__.
// Activo solo si __DEV__ (Metro/RN) o si PERF_LOG=1 (Node/tests).
// NUNCA lanza: las utilidades son no-op cuando está desactivado.
// `process` NO está garantizado en Hermes: sin la guarda, en una build de
// release este módulo podía lanzar ReferenceError al importarse. Igual que
// __DEV__, se comprueba que exista antes de leerlo.
const ENV = typeof process !== 'undefined' && process && process.env ? process.env : {};
const ACTIVO = ENV.PERF_LOG === '1' || (typeof __DEV__ !== 'undefined' && __DEV__);

const contadores = new Map(); // etiqueta -> { n, docs, bytes }
const tiempos = new Map();    // etiqueta -> { n, ms, max }
const caches = {              // hit/miss de las cachés de lectura
  streamMem: { hit: 0, miss: 0 },
  storage: { hit: 0, miss: 0 },
};

// Cuenta UNA operación de lectura: nº de documentos y bytes aproximados.
export function contar(etiqueta, nDocs = 1, bytesAprox = 0) {
  if (!ACTIVO || !etiqueta) return;
  let c = contadores.get(etiqueta);
  if (!c) { c = { n: 0, docs: 0, bytes: 0 }; contadores.set(etiqueta, c); }
  c.n++;
  c.docs += Number(nDocs) || 0;
  c.bytes += Number(bytesAprox) || 0;
}

// Mide el tiempo de una función (síncrona o async) y lo acumula por etiqueta.
export function medir(etiqueta, fn) {
  if (!ACTIVO || !etiqueta) return fn ? fn() : undefined;
  const t0 = Date.now();
  const reg = () => {
    const ms = Date.now() - t0;
    let t = tiempos.get(etiqueta);
    if (!t) { t = { n: 0, ms: 0, max: 0 }; tiempos.set(etiqueta, t); }
    t.n++;
    t.ms += ms;
    if (ms > t.max) t.max = ms;
  };
  let r;
  try { r = fn ? fn() : undefined; } catch (e) { reg(); throw e; }
  if (r && typeof r.then === 'function') {
    return r.then((v) => { reg(); return v; }, (e) => { reg(); throw e; });
  }
  reg();
  return r;
}

export function cacheHit(origen) { if (ACTIVO && caches[origen]) caches[origen].hit++; }
export function cacheMiss(origen) { if (ACTIVO && caches[origen]) caches[origen].miss++; }

// Tamaño aproximado en bytes de un objeto plano (heurística JSON).
export function bytesDe(obj) {
  if (obj == null) return 0;
  try {
    const s = JSON.stringify(obj);
    return s ? s.length : 0;
  } catch (e) { return 0; }
}

export function resumen() {
  const out = { contadores: {}, tiempos: {}, caches: {} };
  contadores.forEach((v, k) => { out.contadores[k] = { ...v }; });
  tiempos.forEach((v, k) => { out.tiempos[k] = { ...v }; });
  Object.keys(caches).forEach((k) => { out.caches[k] = { ...caches[k] }; });
  return out;
}

// Solo para tests: vacía todos los contadores.
export function reiniciar() {
  contadores.clear();
  tiempos.clear();
  Object.keys(caches).forEach((k) => { caches[k].hit = 0; caches[k].miss = 0; });
}

export function activo() { return ACTIVO; }
