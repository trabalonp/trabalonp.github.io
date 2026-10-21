// lib/workers.js — cálculo de digests de curvas EN EL SERVIDOR.
//
// Para qué sirve
// --------------
// El bloque C dejaba el cálculo de digests solo en el cliente: el servidor
// marcaba `analyticsCurves/{uid}.pendientes` y el móvil lo procesaba al abrir
// Análisis. Consecuencia: hasta que el usuario abre Análisis, las curvas
// históricas siguen calculándose con el camino legacy (N+1 lecturas de
// `registros/data` en el dispositivo) y, si abre la pantalla justo después de
// una sincronización, ve las curvas sin el entreno nuevo.
//
// Este worker cierra ese hueco sin depender del móvil:
//   · `procesarPendientes(uid)` vacía la cola `pendientes` calculando el
//     digest de cada entreno y escribiéndolo en su documento mensual.
//   · `enSegundoPlano(res, uid)` lanza ese trabajo con `waitUntil` (Vercel),
//     sin retrasar la respuesta HTTP del endpoint.
//   · `backfillUsuario(uid)` reconstruye todos los meses de un usuario (para
//     `tools/importar-digests.js` y como red de seguridad).
//
// Garantías
// ---------
//   · Es IDEMPOTENTE: el digest se escribe en `analyticsCurves/{uid}/months`
//     con `set(..., {merge:true})` sobre `acts.<id>`; recalcularlo da lo mismo.
//   · Es CONCURRENTE-SEGURO: cada entreno se "reclama" en un mapa
//     `workers.<id>` con marca de tiempo y TTL de 120 s. Si dos invocaciones
//     coinciden, solo una calcula (la otra lo deja pasar). Si un worker muere a
//     medias, el TTL libera el entreno para el siguiente intento.
//   · NUNCA LANZA hacia el endpoint: todos los caminos públicos capturan sus
//     errores (un fallo de curvas no puede tumbar una sincronización).
//   · Guarda de tamaño: si un documento mensual se acercara a 1 MiB se marca
//     `oversize` y el motor del cliente usa el cálculo legacy para ese mes.
//
// Nota sobre zonas: el digest NO contiene zonas (se aplican al leer en el
// cliente), así que cambiar zonas no invalida nada aquí.
'use strict';

const admin = require('./firebase');
const { calcularDigest, mesKeyDe, redondearDigest } = require('./curvasDigest');

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const COL = 'entrenamientos';
const META = 'analyticsCurves';
const TOPE_BYTES_MES = 900 * 1024; // margen sobre el límite de 1 MiB por documento
const CLAIM_TTL_MS = 120 * 1000;
const CONCURRENCIA = 4;

// ── Utilidades ──────────────────────────────────────────────────────────────
const bytesDe = (obj) => {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch (e) {
    return 0;
  }
};

function fechaMsDe(fecha) {
  if (fecha == null) return 0;
  if (typeof fecha.toMillis === 'function') return fecha.toMillis();
  if (fecha instanceof Date) return fecha.getTime();

  const ms = new Date(fecha).getTime();

  return Number.isFinite(ms) ? ms : 0;
}

// Un id de documento válido para usarlo como clave de mapa (`workers`) y como
// campo de `acts`: sin '/', '~', '*' y con longitud razonable.
const idValido = (id) => typeof id === 'string' && id.length > 0 && id.length < 200 && !/[\/~*[\]]/.test(id);

function chunks(arr, n) {
  const out = [];

  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));

  return out;
}

function esActividadDeCurvas(w) {
  return !!w && (w.estado === 'completo' || (w.duracion || 0) > 0);
}

// ── Caché en proceso de la meta (evita releer en cada entreno) ──────────────
const metaCache = new Map(); // uid -> { ts, val }
const META_TTL_MS = 30 * 1000;

async function leerMeta(uid, { forzar = false } = {}) {
  const cc = metaCache.get(uid);

  if (!forzar && cc && Date.now() - cc.ts < META_TTL_MS) return cc.val;

  const snap = await db.collection(META).doc(uid).get();
  const val = snap.exists ? snap.data() || {} : {};

  metaCache.set(uid, { ts: Date.now(), val });

  return val;
}

function invalidarMeta(uid) {
  metaCache.delete(uid);
}

// ── Reclamo (claim) de un entreno para que solo un proceso lo calcule ───────
async function reclamar(uid, id) {
  const ref = db.collection(META).doc(uid);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      const workers = data.workers || {};
      const ts = Number(workers[id]) || 0;

      if (ts && Date.now() - ts < CLAIM_TTL_MS) return false; // en curso por otro

      // OJO: en set() una clave con puntos sería un CAMPO literal, no una ruta.
      // Por eso se usa el mapa anidado (merge profundo) y no 'workers.<id>'.
      tx.set(ref, { v: 1, workers: { [id]: Date.now() } }, { merge: true });

      return true;
    });
  } catch (e) {
    // Si la transacción falla (documento bloqueado, red…), se intenta igual:
    // el coste de duplicar un cálculo idempotente es bajo.
    console.warn('[workers] reclamo falló para', id, ':', e.message);
    return true;
  }
}

// ── Cálculo y escritura de UN digest ───────────────────────────────────────
/**
 * Calcula (si hace falta) el digest del entreno `id` y lo guarda en el
 * documento mensual que le corresponde.
 *
 * @returns {Promise<{ok:boolean, motivo?:string, escrito?:boolean}>}
 */
async function procesarDigest(uid, id, { forzar = false, reclamado = false } = {}) {
  if (!uid || !idValido(id)) return { ok: false, motivo: 'idInvalido' };

  if (!reclamado && !(await reclamar(uid, id))) {
    return { ok: false, motivo: 'enCurso' };
  }

  try {
    const wSnap = await db.collection(COL).doc(id).get();

    if (!wSnap.exists) return { ok: true, motivo: 'noExiste' };

    const w = wSnap.data() || {};

    if (w.userId && w.userId !== uid) return { ok: true, motivo: 'otroUsuario' };

    const fechaMs = fechaMsDe(w.fecha);

    if (!esActividadDeCurvas(w) || !fechaMs) return { ok: true, motivo: 'fueraDeCurvas' };

    const rSnap = await db.collection(COL).doc(id).collection('registros').doc('data').get();
    const pts = rSnap.exists ? (rSnap.data() || {}).puntos || [] : [];

    if (!Array.isArray(pts) || !pts.length) return { ok: true, motivo: 'sinPuntos' };

    const mes = mesKeyDe(fechaMs);
    const mesRef = db.collection(META).doc(uid).collection('months').doc(mes);

    // Una sola lectura del mes: sirve para comprobar si ya está al día y para
    // la guarda de tamaño.
    const mesSnap = await mesRef.get();
    const mesData = mesSnap.exists ? mesSnap.data() || {} : {};

    if (mesData.oversize) return { ok: true, motivo: 'mesOversize' };

    const acts = mesData.acts || {};
    const previo = acts[id];

    if (!forzar && previo && previo.tipo === w.tipo && previo.f === fechaMs) {
      // Ya hay digest de este entreno. Solo se recalcula si los PUNTOS han
      // cambiado: para eso está la firma `sig` (nº de puntos + primer y último
      // timestamp), que el cliente guardaba pero no comparaba.
      const sigActual = `${pts.length}|${pts[0].timestamp}|${pts[pts.length - 1].timestamp}`;

      if (previo.sig === sigActual) return { ok: true, motivo: 'alDia', escrito: false };
    }

    const digest = redondearDigest(calcularDigest(pts, w.tipo, fechaMs));

    const actsNuevo = { ...acts, [id]: digest };

    if (bytesDe(actsNuevo) > TOPE_BYTES_MES) {
      await mesRef.set({ v: 1, oversize: true }, { merge: true });
      console.warn(`[workers] mes ${mes} de ${uid} supera ~900 KB: se marca oversize (legacy)`);
      return { ok: false, motivo: 'tamano' };
    }

    await mesRef.set({ v: 1, acts: { [id]: digest }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return { ok: true, escrito: true, motivo: 'escrito' };
  } catch (e) {
    console.warn('[workers] procesarDigest falló para', id, ':', e.message);
    return { ok: false, motivo: 'error' };
  } finally {
    // Se libera el reclamo SIEMPRE (haya escrito o no): el estado deseado ya
    // está reflejado y un claim colgado solo estorbaría 120 s.
    try {
      await db.collection(META).doc(uid).set({ workers: { [id]: FieldValue.delete() } }, { merge: true });
    } catch (e) { /* el TTL lo libera igualmente */ }
  }
}

// ── Cola de pendientes ────────────────────────────────────────────────────
/**
 * Procesa hasta `max` entrenos de `analyticsCurves/{uid}.pendientes`.
 * Los que no se pueden calcular (sin puntos, sin registros, marcados oversize)
 * salen de la cola; los que fallan por error transitorio SE QUEDAN.
 */
async function procesarPendientes(uid, { max = 25 } = {}) {
  const vacio = { procesados: 0, escritos: 0, quitados: 0, pendientes: 0 };

  if (!uid) return vacio;

  try {
    const ref = db.collection(META).doc(uid);
    const snap = await ref.get();

    if (!snap.exists) return vacio;

    const pend = Array.isArray((snap.data() || {}).pendientes) ? snap.data().pendientes : [];

    if (!pend.length) return vacio;

    const lote = pend.filter(idValido).slice(0, Math.max(1, Number(max) || 25));
    let procesados = 0;
    let escritos = 0;
    const quitar = [];

    for (const grupo of chunks(lote, CONCURRENCIA)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await Promise.all(grupo.map((id) => procesarDigest(uid, id)));

      res.forEach((r, i) => {
        const id = grupo[i];

        procesados++;
        if (r.escrito) escritos++;

        // Se quita de la cola cuando el estado deseado ya está (incluye
        // "sin puntos"/"no existe"/"no es de curvas"), no cuando hay error.
        if (r.ok || r.motivo === 'tamano') quitar.push(id);
      });
    }

    if (quitar.length) {
      await ref.set({ pendientes: FieldValue.arrayRemove(...quitar) }, { merge: true });
      invalidarMeta(uid);
    }

    console.log(`[workers] ${uid}: ${procesados} pendientes, ${escritos} escritos, ${quitar.length} fuera de la cola`);

    return { procesados, escritos, quitados: quitar.length, pendientes: pend.length - quitar.length };
  } catch (e) {
    console.warn('[workers] procesarPendientes falló:', e.message);
    return vacio;
  }
}

/**
 * Engancha una promesa a la vida de la respuesta sin retrasarla.
 * Vercel expone `res.waitUntil()` en el runtime Node (y `req.waitUntil` en
 * algunos entornos); si no existe, la promesa se deja correr igualmente.
 * Nunca lanza.
 */
function lanzarEnSegundoPlano(res, tarea) {
  if (!tarea) return null;

  try {
    if (res && typeof res.waitUntil === 'function') {
      res.waitUntil(tarea);
    } else if (res && typeof res.locals?.waitUntil === 'function') {
      res.locals.waitUntil(tarea);
    }
  } catch (e) {
    console.warn('[workers] waitUntil no disponible:', e.message);
  }

  return tarea;
}

/**
 * Lanza `procesarPendientes` en segundo plano (ver lanzarEnSegundoPlano).
 * Se llama al final de /api/sync-intervals y /api/sync-fitness: así las curvas
 * se generan aunque el usuario no abra Análisis en el móvil.
 */
function enSegundoPlano(res, uid, opts = {}) {
  if (!uid) return null;

  return lanzarEnSegundoPlano(res, procesarPendientes(uid, opts).catch(() => {}));
}

// ── Backfill de un usuario (herramienta y red de seguridad) ───────────────
/**
 * Reconstruye los digests de TODOS los entrenos de un usuario.
 *
 * @param {string} uid
 * @param {object} opts
 * @param {boolean} opts.forzar   recalcula aunque el `sig` coincida
 * @param {number}  opts.limite   máximo de entrenos a procesar (0 = todos)
 * @param {(s:string)=>void} opts.onProgreso
 */
async function backfillUsuario(uid, { forzar = false, limite = 0, onProgreso } = {}) {
  const resumen = { uid, resumenes: 0, validos: 0, escritos: 0, alDia: 0, sinPuntos: 0, errores: 0, meses: 0, bytes: 0 };

  if (!uid) return resumen;

  const progreso = (s) => {
    try {
      if (typeof onProgreso === 'function') onProgreso(s);
    } catch (e) { /* el log nunca rompe el backfill */ }
  };

  progreso(`leyendo resúmenes de ${uid}…`);

  // 1) Resúmenes (paginado por id de documento para no depender de índices).
  const resumenes = [];
  let ultimo = null;

  for (;;) {
    let q = db.collection(COL).where('userId', '==', uid).orderBy('__name__').limit(300);

    if (ultimo) q = q.startAfter(ultimo);

    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();

    snap.forEach((d) => resumenes.push({ id: d.id, ...(d.data() || {}) }));
    resumen.resumenes += snap.size;

    if (limite && resumenes.length >= limite) break;
    if (snap.size < 300) break;

    ultimo = snap.docs[snap.docs.length - 1];
  }

  const validos = resumenes
    .filter((w) => esActividadDeCurvas(w) && fechaMsDe(w.fecha))
    .slice(0, limite || undefined);

  resumen.validos = validos.length;
  progreso(`${resumen.resumenes} resúmenes, ${validos.length} con curvas`);

  // 2) Agrupar por mes para leer/escribir cada documento mensual UNA vez.
  const porMes = {};

  for (const w of validos) {
    const mes = mesKeyDe(fechaMsDe(w.fecha));

    (porMes[mes] || (porMes[mes] = [])).push(w);
  }

  resumen.meses = Object.keys(porMes).length;

  // 3) Mes a mes.
  for (const mes of Object.keys(porMes).sort()) {
    const mesRef = db.collection(META).doc(uid).collection('months').doc(mes);
    // eslint-disable-next-line no-await-in-loop
    const mesSnap = await mesRef.get();
    const mesData = mesSnap.exists ? mesSnap.data() || {} : {};

    if (mesData.oversize) {
      progreso(`  ${mes}: marcado oversize, se salta (el cliente usará legacy)`);
      continue;
    }

    const acts = mesData.acts || {};
    const aEscribir = {};

    for (const grupo of chunks(porMes[mes], CONCURRENCIA)) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        grupo.map(async (w) => {
          try {
            const previo = acts[w.id];
            const fechaMs = fechaMsDe(w.fecha);

            // eslint-disable-next-line no-await-in-loop
            const rSnap = await db.collection(COL).doc(w.id).collection('registros').doc('data').get();
            const pts = rSnap.exists ? (rSnap.data() || {}).puntos || [] : [];

            if (!Array.isArray(pts) || !pts.length) {
              resumen.sinPuntos++;
              return;
            }

            if (!forzar && previo && previo.tipo === w.tipo && previo.f === fechaMs) {
              const sig = `${pts.length}|${pts[0].timestamp}|${pts[pts.length - 1].timestamp}`;

              if (previo.sig === sig) {
                resumen.alDia++;
                return;
              }
            }

            aEscribir[w.id] = redondearDigest(calcularDigest(pts, w.tipo, fechaMs));
          } catch (e) {
            resumen.errores++;
            console.warn('[workers] backfill', w.id, ':', e.message);
          }
        })
      );
    }

    const n = Object.keys(aEscribir).length;

    if (!n) {
      progreso(`  ${mes}: al día (${porMes[mes].length} entrenos)`);
      continue;
    }

    const actsNuevo = { ...acts, ...aEscribir };

    if (bytesDe(actsNuevo) > TOPE_BYTES_MES) {
      // eslint-disable-next-line no-await-in-loop
      await mesRef.set({ v: 1, oversize: true }, { merge: true });
      progreso(`  ${mes}: superaría ~900 KB, se marca oversize`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await mesRef.set({ v: 1, acts: aEscribir, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    resumen.escritos += n;
    resumen.bytes += bytesDe(aEscribir);
    progreso(`  ${mes}: ${n} digests escritos (${(bytesDe(aEscribir) / 1024).toFixed(1)} KB)`);
  }

  // 4) Meta: primer mes conocido (lo usa el cliente para "Todo") y versión.
  const primerMs = validos.reduce((min, w) => {
    const f = fechaMsDe(w.fecha);

    return f > 0 && (min === 0 || f < min) ? f : min;
  }, 0);

  const metaUpd = { v: 1, backfillV: 1, actualizadoPor: 'servidor' };

  if (primerMs > 0) metaUpd.primerMes = mesKeyDe(primerMs);

  await db.collection(META).doc(uid).set(metaUpd, { merge: true });
  invalidarMeta(uid);

  progreso(`listo: ${resumen.escritos} escritos, ${resumen.alDia} al día, ${resumen.sinPuntos} sin puntos, ${resumen.errores} errores`);

  return resumen;
}

module.exports = {
  procesarDigest,
  procesarPendientes,
  enSegundoPlano,
  lanzarEnSegundoPlano,
  backfillUsuario,
  leerMeta,
  invalidarMeta,
  TOPE_BYTES_MES,
  esActividadDeCurvas,
};
