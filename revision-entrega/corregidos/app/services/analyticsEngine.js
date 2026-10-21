// services/analyticsEngine.js
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, where } from 'firebase/firestore';
import { db, auth } from '../firebaseConfig';
import { resolverPlanReal } from './planReal';
import * as perfLog from './perfLog';
import { CURVAS_DIGEST_ENABLED } from './appSettings';
// Importaciones de espacio de nombres: curvasDigest reutiliza helpers de ESTE
// módulo (ciclo benigno); los accesos se resuelven en tiempo de llamada.
import * as CD from './curvasDigest';
import * as CS from './curvasStore';

const mem = {};
const streamMem = {};
const inflightStreams = {};    // clave uid:period:zonaAct -> promesa (A3)
const inflightLegacy = {};     // clave uid:period:zonaAct -> promesa legacy (A3)
const MEM_TTL = 5 * 60 * 1000;
const WINDOW_DAYS = 60;
const STREAM_ACT_LIMIT = 20;
const MAX_BUCKETS = 160;

// Incrementar esta versión invalida automáticamente las cachés antiguas.
const CACHE_V = 6; // v6: curvas por digest (CURVAS_DIGEST_ENABLED) + firma de la sync incremental (A4)

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const STREAM_SIZES = [60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];
export const STREAM_LABELS = ['1m', '2m', '5m', '10m', '20m', '30m', '1h', '1h30', '2h'];

const chunksOf = (arr, n) => {
  const out = [];

  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }

  return out;
};

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;

  date.setUTCDate(date.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export function groupKey(d, group) {
  if (group === 'diario') return dayKey(d);
  if (group === 'semanal') return isoWeekKey(d);
  if (group === 'mensual') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

  return `${d.getFullYear()}`;
}

export function periodStart(period) {
  const now = new Date();

  if (period === '30d') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  }

  if (period === '3m') {
    return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
  }

  if (period === '6m') {
    return new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  }

  if (period === '1y') {
    return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  }

  if (period === '2y') {
    return new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  }

  return null;
}

export function paceToSec(v) {
  if (v == null || v === '') return null;

  if (typeof v === 'number') return v;

  const m = String(v).trim().match(/^(\d+):(\d{1,2})$/);

  if (m) {
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  const n = Number(v);

  return Number.isFinite(n) && n > 0 ? n : null;
}

// Zonas FC/ritmo del perfil en forma { lo, hi, label } (misma lógica que
// usaba el motor). Se extrae aquí para que el camino digest (fusionarDigests)
// reutilice EXACTAMENTE las mismas condiciones sin duplicar la lógica.
export function parseStreamZones(profile) {
  const fcZ = (profile?.zonasFC || [])
    .map((z) => ({
      label: z.titulo || z.label || 'Z',
      lo: Number(z.min),
      hi: Number(z.max),
    }))
    .filter((b) => Number.isFinite(b.lo) && Number.isFinite(b.hi));

  const rtZ = (profile?.zonasRitmo || [])
    .map((z) => {
      const a = paceToSec(z.min);
      const b = paceToSec(z.max);

      if (a == null || b == null) {
        return null;
      }

      return {
        label: z.titulo || z.label || 'R',
        lo: Math.min(a, b),
        hi: Math.max(a, b),
      };
    })
    .filter(Boolean);

  return { fcZ, rtZ };
}

// Hash corto (djb2 → base36) para meter la firma de zonas en las claves de
// caché sin alargarlas.
function hashCorto(txt) {
  let h = 5381;

  for (let i = 0; i < txt.length; i++) {
    h = ((h << 5) + h + txt.charCodeAt(i)) | 0;
  }

  return (h >>> 0).toString(36);
}

/* Firma de las zonas que REALMENTE cambian el resultado (FC y ritmo resueltos
   con las mismas condiciones que usa el cálculo). Va en la clave de las cachés
   de curvas: si el usuario cambia una zona o un umbral en Zonas, la clave
   cambia y el motor recalcula. Antes, el snapshot cacheado se seguía sirviendo
   con las zonas nuevas aplicadas a segundos calculados con las viejas (las
   etiquetas cambiaban, el reparto no) hasta pulsar refrescar. */
export function firmaZonasDe(profile) {
  try {
    const { fcZ, rtZ } = parseStreamZones(profile || null);
    const norm = (arr) => arr.map((b) => `${b.label}:${b.lo}:${b.hi}`).join('|');

    return hashCorto(`${norm(fcZ)}#${norm(rtZ)}`);
  } catch (e) {
    return 'sz';
  }
}

function normalizeUmbral(v) {
  if (v == null) return null;

  if (typeof v === 'string') {
    return paceToSec(v);
  }

  const n = Number(v);

  if (!Number.isFinite(n) || n <= 0) return null;

  return n < 20 ? 1000 / n : n;
}

export function fmtBucketLabel(k, group) {
  if (group === 'diario') {
    return k.slice(5).replace('-', '/');
  }

  if (group === 'semanal') {
    return k.slice(5);
  }

  if (group === 'mensual') {
    const [y, m] = k.split('-');
    return `${['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][+m - 1]}${y.slice(2)}`;
  }

  return k;
}

export function effectiveGroupFor(group, period) {
  const order = ['diario', 'semanal', 'mensual', 'anio'];
  const sizes = {
    diario: 1,
    semanal: 7,
    mensual: 30,
    anio: 365,
  };

  const start = periodStart(period);
  const span = start
    ? Math.max(1, Math.round((Date.now() - start.getTime()) / 86400000))
    : 1095;

  let idx = Math.max(0, order.indexOf(group));
  let count = span / sizes[order[idx]];

  while (count > MAX_BUCKETS && idx < order.length - 1) {
    idx++;
    count = span / sizes[order[idx]];
  }

  return {
    group: order[idx],
    upgraded: order[idx] !== group,
    label: order[idx],
  };
}

function emptyDay() {
  return {
    dist: 0,
    dur: 0,
    count: 0,
    planDist: 0,
    planDur: 0,
    load: 0,
    efort: 0,
    kcal: 0,
    steps: 0,

    sleep: null,
    rhr: null,
    fcMax: null,
    avgHr: null,
    vo2: null,
    hrv: null,
    weight: null,
    spo2: null,
    score: null,
    bf: null,
    bw: null,
    ftp: null,
    lthr: null,
    umbral: null,

    fcMS: 0,
    fcMN: 0,
    maxDist: 0,
    maxDur: 0,
    bestPace: null,
    elev: 0,
    potS: 0,
    potT: 0,
    iDist: 0,
    iDur: 0,
  };
}

function resetWorkoutFields(d) {
  d.dist = 0;
  d.dur = 0;
  d.count = 0;
  d.planDist = 0;
  d.planDur = 0;
  d.maxDist = 0;
  d.maxDur = 0;
  d.bestPace = null;
  d.fcMS = 0;
  d.fcMN = 0;
  d.elev = 0;
  d.potS = 0;
  d.potT = 0;
  d.iDist = 0;
  d.iDur = 0;
}

function planOf(pasos) {
  let sec = 0;
  let km = 0;

  const walk = (list) => (list || []).forEach((p) => {
    const reps = Number(p.repeticiones) || 1;
    const val = Number(p.durValor ?? p.valor);

    let s = 0;
    let k = 0;

    if (Number.isFinite(val) && val > 0) {
      const isDist =
        p.durTipo === 'Distancia' ||
        (
          p.durTipo !== 'Tiempo' &&
          ['km', 'm', 'mi', 'yd'].includes(p.durUnidad || p.unidad)
        );

      if (isDist) {
        const u = p.durUnidad || p.unidad || 'km';

        k =
          u === 'mi'
            ? val * 1.609344
            : u === 'm'
              ? val / 1000
              : u === 'yd'
                ? val * 0.0009144
                : val;
      } else {
        s = val * 60;
      }
    }

    let pace = null;

    if (p.objetivo === 'Ritmo' || p.objetivo === 'Zona ritmo') {
      const a = paceToSec(p.objMin);
      const b = paceToSec(p.objMax);

      if (a != null && b != null) {
        pace = (a + b) / 2;
      }
    }

    if (k === 0 && s > 0 && pace) {
      k = s / pace;
    }

    if (s === 0 && k > 0 && pace) {
      s = k * pace;
    }

    sec += s * reps;
    km += k * reps;

    walk(p.hijos);
  });

  walk(pasos);

  return { sec, km };
}

function mergeWorkout(days, w) {
  if (!w.fecha || w.tipo === 'Descanso' || w.tipo === 'Evento') {
    return;
  }

  const f = w.fecha.toDate ? w.fecha.toDate() : new Date(w.fecha);
  const k = dayKey(f);
  const d = days[k] || (days[k] = emptyDay());

  const real = (w.duracion > 0) || w.estado === 'completo';

  if (real) {
    d.dist += w.distancia || 0;
    d.dur += w.duracion || 0;
    d.count++;

    // Esfuerzo (TSS) por entreno, guardado en el documento principal por la
    // sincronización. Alimentará la gráfica "Esfuerzo" de Análisis.
    const esf = Number(w.esfuerzo);
    if (Number.isFinite(esf) && esf > 0) {
      d.efort = (d.efort || 0) + esf;
    }

    const fcM = Number(w['fc-media']);

    if (Number.isFinite(fcM) && fcM > 0) {
      d.fcMS += fcM;
      d.fcMN++;
    }

    if ((w.distancia || 0) > d.maxDist) {
      d.maxDist = w.distancia;
    }

    if ((w.duracion || 0) > d.maxDur) {
      d.maxDur = w.duracion;
    }

    if ((w.distancia || 0) >= 1 && (w.duracion || 0) > 0) {
      const p = w.duracion / w.distancia;

      if (d.bestPace == null || p < d.bestPace) {
        d.bestPace = p;
      }
    }
  }

  // Planificado del día: el plan RESUELTO (planDist/planDur de la fusión y, si
  // faltan, los pasos) — el mismo número que se ve en la tarjeta del entreno y
  // en el resumen semanal. Las zonas de ritmo no están disponibles aquí (el
  // motor trabaja sin perfil), pero resolverPlanReal ya prioriza lo guardado.
  const pl = resolverPlanReal(w);

  if (pl.dist > 0) d.planDist += pl.dist;
  else if (Array.isArray(w.pasos) && w.pasos.length) d.planDist += planOf(w.pasos).km;

  if (pl.dur > 0) d.planDur += pl.dur;
  else if (Array.isArray(w.pasos) && w.pasos.length) d.planDur += planOf(w.pasos).sec;
}

// Construye el historial a partir de la misma lista que ya utiliza la home.
// Sirve como fuente de verdad local cuando la consulta/persistencia del análisis
// no está disponible o contiene una caché antigua.
export function buildDaysFromWorkouts(workouts) {
  const days = {};
  (workouts || []).forEach((workout) => mergeWorkout(days, workout));
  return days;
}

async function fetchWorkouts(uid, days, { from, to }) {
  try {
    let last = null;
    let total = 0;

    for (;;) {
      const cs = [
        where('userId', '==', uid),
        orderBy('fecha', 'desc'),
        limit(300),
      ];

      if (from) {
        cs.push(where('fecha', '>=', from));
      }

      if (to) {
        cs.push(where('fecha', '<=', to));
      }

      if (last) {
        cs.push(startAfter(last));
      }

      const snap = await getDocs(
        query(collection(db, 'entrenamientos'), ...cs)
      );

      if (snap.empty) {
        break;
      }

      let bytes = 0;
      snap.forEach((ds) => {
        const data = ds.data();
        bytes += perfLog.bytesDe(data);
        mergeWorkout(days, data);
      });

      perfLog.contar('fetchWorkouts.entrenamientos', snap.size, bytes);

      total += snap.size;
      last = snap.docs[snap.docs.length - 1];

      if (snap.size < 300) {
        break;
      }
    }

    return total;
  } catch (e) {
    console.warn('[analytics] fetchWorkouts(order) falló:', e.message);
  }

  try {
    const cs = [
      where('userId', '==', uid),
      limit(1000),
    ];

    if (from) {
      cs.push(where('fecha', '>=', from));
    }

    if (to) {
      cs.push(where('fecha', '<=', to));
    }

    const snap = await getDocs(
      query(collection(db, 'entrenamientos'), ...cs)
    );

    let bytes = 0;
    snap.forEach((ds) => {
      const data = ds.data();
      bytes += perfLog.bytesDe(data);
      mergeWorkout(days, data);
    });

    perfLog.contar('fetchWorkouts.entrenamientos', snap.size, bytes);

    return snap.size;
  } catch (e) {
    console.warn('[analytics] fetchWorkouts falló:', e.message);
    return 0;
  }
}

async function mergeWellness(uid, days) {
  try {
    const s = await getDoc(doc(db, 'wellness', uid));

    if (!s.exists()) {
      console.warn('[analytics] wellness sin documento para', uid);
      return;
    }

    const wd = s.data().days || {};
    perfLog.contar('wellness', 1, perfLog.bytesDe(wd));

    for (const [k, v] of Object.entries(wd)) {
      const d = days[k] || (days[k] = emptyDay());

      if (v.load != null) d.load = v.load;
      if (v.kcal != null) d.kcal = v.kcal;
      if (v.steps != null) d.steps = v.steps;
      if (v.sleep != null) d.sleep = v.sleep / 3600;
      if (v.rhr != null) d.rhr = v.rhr;
      if (v.fcMax != null) d.fcMax = v.fcMax;
      if (v.avgHr != null) d.avgHr = v.avgHr;

      const vo2 = v.vo2_est ?? v.vo2;

      if (vo2 != null) d.vo2 = vo2;
      if (v.hrv != null) d.hrv = v.hrv;
      if (v.weight != null) d.weight = v.weight;
      if (v.spo2 != null) d.spo2 = v.spo2;
      if (v.score != null) d.score = v.score;
      if (v.bf != null) d.bf = v.bf;

      if (v.bw != null && v.bw <= 100) {
        d.bw = v.bw;
      }

      if (v.ftp != null) d.ftp = v.ftp;
      if (v.lthr != null) d.lthr = v.lthr;
      if (v.umbral != null) d.umbral = normalizeUmbral(v.umbral);

      if (v.elev != null) {
        d.elev = (d.elev || 0) + v.elev;
      }

      if (v.potS != null) {
        d.potS = (d.potS || 0) + v.potS;
      }

      if (v.potT != null) {
        d.potT = (d.potT || 0) + v.potT;
      }

      if (v.iDist != null) d.iDist = v.iDist;
      if (v.iDur != null) d.iDur = v.iDur;
    }
  } catch (e) {
    console.warn('[analytics] mergeWellness falló:', e.message);
  }
}

function hasUsableAnalyticsCache(cache) {
  if (!cache || typeof cache !== 'object') {
    return false;
  }

  if (cache.v !== CACHE_V) {
    return false;
  }

  if (!cache.days || typeof cache.days !== 'object') {
    return false;
  }

  return Object.keys(cache.days).length > 0;
}

export async function getAnalyticsDays(uid, { force = false } = {}) {
  if (!uid) {
    return {};
  }

  const cachedMem = mem[uid];

  if (
    !force &&
    cachedMem &&
    Date.now() - cachedMem.ts < MEM_TTL &&
    cachedMem.days &&
    Object.keys(cachedMem.days).length > 0
  ) {
    return cachedMem.days;
  }

  const key = `analyticsCache_v${CACHE_V}_${uid}`;

  let cache = null;

  if (force) {
    // Refresco: se elimina la caché persistida ANTES de recalcular, para que
    // nunca pueda resurgir datos antiguos si el guardado posterior fallara.
    try { await AsyncStorage.removeItem(key); } catch (e) {}
  }

  if (!force) {
    try {
      const raw = await AsyncStorage.getItem(key);

      if (raw) {
        const parsed = JSON.parse(raw);

        if (hasUsableAnalyticsCache(parsed)) {
          cache = parsed;
        } else {
          // Elimina una caché antigua, vacía o incompatible.
          await AsyncStorage.removeItem(key);
        }
      }
    } catch (e) {
      console.warn('[analytics] caché local inválida:', e.message);
      cache = null;
    }
  }

  // El análisis funciona como un snapshot persistente: si ya existe, no se
  // vuelve a consultar Firestore hasta que el usuario pulse refrescar.
  if (!force && cache?.days) {
    mem[uid] = { days: cache.days, ts: Date.now() };
    return cache.days;
  }

  const days = cache?.days || {};

  const winStart = new Date();
  winStart.setDate(winStart.getDate() - WINDOW_DAYS);

  const winKey = dayKey(winStart);

  for (const k of Object.keys(days)) {
    if (k >= winKey) {
      resetWorkoutFields(days[k]);
    }
  }

  const nWin = await fetchWorkouts(uid, days, {
    from: winStart,
  });

  let nOld = 0;

  if (force || !cache?.oldDone || Object.keys(days).length === 0) {
    const to = new Date(winStart);
    to.setDate(to.getDate() - 1);

    nOld = await fetchWorkouts(uid, days, {
      to,
    });
  }

  await mergeWellness(uid, days);

  try {
    await AsyncStorage.setItem(
      key,
      JSON.stringify({
        v: CACHE_V,
        oldDone: true,
        days,
      })
    );
  } catch (e) {
    console.warn('[analytics] no se pudo guardar la caché:', e.message);
    // Reintento con payload reducido (solo ventana reciente) por cuota:
    try {
      const winOnly = {};
      const corte = dayKey(new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000));
      for (const k of Object.keys(days)) if (k >= corte) winOnly[k] = days[k];
      await AsyncStorage.setItem(
        key,
        JSON.stringify({ v: CACHE_V, oldDone: false, days: winOnly })
      );
    } catch (e2) {
      console.warn('[analytics] caché reducida también falló:', e2.message);
    }
  }

  mem[uid] = {
    days,
    ts: Date.now(),
  };

  console.log(
    `[analytics] days listos: ventana=${nWin} historial=${nOld} claves=${Object.keys(days).length}`
  );

  return days;
}

/* ═══ SINCRONIZACIÓN INCREMENTAL (patrón chat de Social) ═══
   Trae SOLO los entrenamientos posteriores a la última sincronización
   (con solape de 3 días por si una edición movió fechas), re-agrega los
   días tocados (reset + merge, sin doble conteo) y fusiona el wellness
   (1 lectura). NO relee el historial completo: el resto sale del snapshot
   persistido. Devuelve { n, streamsChanged }: n = nº de docs traídos,
   streamsChanged = si la FIRMA de entrenos completados cambió y hay que
   invalidar las cachés de zonas/curvas (A4: antes se invalidaba en CADA
   sincronización con tocados > 0, aunque nada hubiera cambiado). */
export function firmaStreamsDe(tocados) {
  const relevantes = (tocados || [])
    .filter((w) => w.estado === 'completo' || (w.duracion || 0) > 0)
    .map((w) => {
      const fechaMs = w.fecha?.toMillis
        ? w.fecha.toMillis()
        : (w.fecha instanceof Date ? w.fecha.getTime() : new Date(w.fecha).getTime());

      return `${w.id}|${Number.isFinite(fechaMs) ? fechaMs : 0}|${w.tipo}|${w.estado}|${w.duracion}`;
    })
    .sort()
    .join(';');

  // Hash simple (djb2) determinista entre dispositivos.
  let h = 5381;

  for (let i = 0; i < relevantes.length; i++) {
    h = ((h << 5) + h + relevantes.charCodeAt(i)) | 0;
  }

  return String(h >>> 0);
}

export async function syncAnalyticsDays(uid, days) {
  if (!uid || !days) return { n: 0, streamsChanged: false };
  try {
    const key = `analyticsCache_v${CACHE_V}_${uid}`;

    let lastSyncAt = mem[uid]?.lastSyncAt || 0;
    try {
      const raw = await AsyncStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.lastSyncAt && parsed.lastSyncAt > lastSyncAt) lastSyncAt = parsed.lastSyncAt;
    } catch (e) {}

    if (!lastSyncAt) {
      // Primera marca base tras construir el snapshot: no trae nada.
      mem[uid] = { ...(mem[uid] || {}), days, lastSyncAt: Date.now() };
      try {
        await AsyncStorage.setItem(key, JSON.stringify({ v: CACHE_V, oldDone: true, days, lastSyncAt: Date.now() }));
      } catch (e) {}
      return { n: 0, streamsChanged: false };
    }

    const desde = new Date(lastSyncAt - 3 * 24 * 3600 * 1000);

    // Trae TODO lo entrenado desde el corte (paginado, igual que fetchWorkouts)
    const tocados = [];
    let last = null;
    for (;;) {
      const cs = [where('userId', '==', uid), where('fecha', '>=', desde), limit(300)];
      if (last) cs.push(startAfter(last));
      const snap = await getDocs(query(collection(db, 'entrenamientos'), ...cs));
      if (snap.empty) break;
      let bytes = 0;
      snap.forEach((ds) => {
        const data = ds.data();
        bytes += perfLog.bytesDe(data);
        // Con el id del documento: la FIRMA necesita ids estables (mergeWorkout
        // sigue funcionando igual con el campo `id` extra).
        tocados.push({ id: ds.id, ...data });
      });
      perfLog.contar('syncAnalyticsDays.entrenamientos', snap.size, bytes);
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < 300) break;
    }

    if (tocados.length) {
      // Re-agrega limpio: reset de los días tocados y merge de sus docs
      for (const w of tocados) {
        const f = w.fecha?.toDate ? w.fecha.toDate() : new Date(w.fecha);
        const k = dayKey(f);
        if (!days[k]) days[k] = emptyDay();
        else resetWorkoutFields(days[k]);
      }
      for (const w of tocados) mergeWorkout(days, w);
      await mergeWellness(uid, days);
    }

    // A4: la caché de zonas/curvas SOLO se invalida si cambió la firma del
    // conjunto de entrenos completados (antes se invalidaba siempre que
    // tocados.length > 0, es decir, en CADA sincronización).
    const firma = firmaStreamsDe(tocados);
    const sigKey = `analyticsStreamsSig_v${CACHE_V}_${uid}`;
    let anterior = null;
    try {
      anterior = await AsyncStorage.getItem(sigKey);
    } catch (e) {}

    let streamsChanged = false;

    if (tocados.length > 0 && anterior !== firma) {
      invalidateStreamsCache(uid);   // zonas/curvas reflotan con los nuevos datos
      streamsChanged = true;
    }

    if (tocados.length > 0) {
      try {
        await AsyncStorage.setItem(sigKey, firma);
      } catch (e) {}
    }

    mem[uid] = { ...(mem[uid] || {}), days, lastSyncAt: Date.now() };
    try {
      await AsyncStorage.setItem(
        key,
        JSON.stringify({ v: CACHE_V, oldDone: true, days, lastSyncAt: Date.now() })
      );
    } catch (e) {}

    console.log(`[analytics] sync incremental: ${tocados.length} docs (streamsChanged=${streamsChanged})`);
    return { n: tocados.length, streamsChanged };
  } catch (e) {
    console.warn('[analytics] sync incremental falló:', e.message);
    return { n: 0, streamsChanged: false };
  }
}

export function invalidateAnalytics(uid) {
  if (uid) {
    delete mem[uid];
    Object.keys(streamMem)
      .filter((key) => key.startsWith(`${uid}:`))
      .forEach((key) => delete streamMem[key]);
  }
}

/* Invalida los snapshots de zonas/curvas del usuario (memoria + AsyncStorage).
   La llama la sincronización incremental cuando la FIRMA de entrenos cambia,
   para que las gráficas de zonas/curvas refloten con los datos actualizados. */
export function invalidateStreamsCache(uid) {
  if (!uid) return;
  Object.keys(streamMem)
    .filter((key) => key.startsWith(`${uid}:`))
    .forEach((key) => delete streamMem[key]);

  // Se borran TODAS las claves del usuario por prefijo (antes eran 6 períodos
  // × 4 actividades fijas: cualquier combinación nueva —o la firma de zonas
  // añadida a la clave— quedaba fuera y el snapshot viejo sobrevivía).
  const prefijo = `analyticsStreams_v${CACHE_V}_${uid}_`;
  const borrarPorPrefijo = async () => {
    try {
      if (typeof AsyncStorage.getAllKeys === 'function') {
        const keys = await AsyncStorage.getAllKeys();
        const propias = keys.filter((k) => k.startsWith(prefijo));

        if (propias.length) {
          if (typeof AsyncStorage.multiRemove === 'function') {
            await AsyncStorage.multiRemove(propias);
          } else {
            await Promise.all(propias.map((k) => AsyncStorage.removeItem(k)));
          }
        }

        return;
      }
    } catch (e) {
      console.warn('[analytics] barrido de cachés de streams falló:', e.message);
    }

    // Respaldo si AsyncStorage no expone getAllKeys.
    for (const p of ['30d', '3m', '6m', '1y', '2y', 'todo']) {
      for (const za of ['General', 'Running', 'Ciclismo', 'Natación']) {
        AsyncStorage.removeItem(`${prefijo}${p}_${za}`).catch(() => {});
      }
    }
  };

  borrarPorPrefijo();
}

/* A5: invalidación al editar/borrar un entreno (fecha/tipo/estado/duración/
   distancia). Resetea las cachés de streams (memoria + AsyncStorage) y la
   caché en memoria de los meses de digest. Nunca lanza. */
export function invalidarCurvasEntreno(uid) {
  if (!uid) return;

  try {
    invalidateStreamsCache(uid);
    Object.keys(streamMem)
      .filter((key) => key.startsWith(`${uid}:`))
      .forEach((key) => delete streamMem[key]);
    CS.invalidarCacheMeses(uid);
  } catch (e) {
    console.warn('[analytics] invalidarCurvasEntreno falló:', e.message);
  }
}

/* Cálculo LEGACY de zonas/curvas: el código original, conservado como
   respaldo (regla 2). Cambios respecto al original: A2 (condición de caché
   duplicada eliminada), A3 (coalescencia de peticiones simultáneas con la
   misma clave) e instrumentación perfLog (A1). La lógica numérica NO cambia. */
export async function getStreamsStatsLegacy(uid, period, profile, { force = false, zonaAct = 'General' } = {}) {
  // A3: dos llamadas concurrentes con la misma clave comparten la promesa.
  const key = `${uid}:${period}:${zonaAct}`;

  if (inflightLegacy[key]) {
    return inflightLegacy[key];
  }

  const p = computeStreamsStatsLegacy(uid, period, profile, { force, zonaAct }).finally(() => {
    delete inflightLegacy[key];
  });

  inflightLegacy[key] = p;
  return p;
}

async function computeStreamsStatsLegacy(uid, period, profile, { force = false, zonaAct = 'General' } = {}) {
  // zonaAct + firma de zonas en la clave: cambiar la actividad de las zonas de
  // ritmo o una zona/umbral debe recalcular, no servir un snapshot viejo.
  const key = `${uid}:${period}:${zonaAct}:${firmaZonasDe(profile)}`;
  const c = streamMem[key];

  // MEM_TTL ya existía pero no se aplicaba a la caché de curvas: una entrada
  // vivía hasta la siguiente invalidación. Ahora caduca sola (5 min).
  if (!force && c && Date.now() - c.ts < MEM_TTL) {
    perfLog.cacheHit('streamMem');
    return c.val;
  }

  const storageKey = `analyticsStreams_v${CACHE_V}_${uid}_${period}_${zonaAct}_${firmaZonasDe(profile)}`;
  if (force) {
    try { await AsyncStorage.removeItem(storageKey); } catch (e) {}
  }
  if (!force) {
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.v === CACHE_V && parsed.val) {
          perfLog.cacheHit('storage');
          streamMem[key] = { val: parsed.val, ts: Date.now() };
          return parsed.val;
        }
      }
    } catch (e) {
      console.warn('[analytics] caché persistente de streams inválida:', e.message);
    }
    perfLog.cacheMiss('storage');
  }

  const { fcZ, rtZ } = parseStreamZones(profile);

  const zoneFc = fcZ.map((b) => ({
    label: b.label,
    sec: 0,
  }));
  if (fcZ.length) zoneFc.push({ label: 'Fuera', sec: 0 });

  const zoneRt = rtZ.map((b) => ({
    label: b.label,
    sec: 0,
  }));
  if (rtZ.length) zoneRt.push({ label: 'Fuera', sec: 0 });

  const zoneFcDays = {};
  const zoneRtDays = {};

  const curveRitmo = STREAM_SIZES.map(() => null);
  const curveVel = STREAM_SIZES.map(() => null); // Ciclismo: mejor km/h por ventana
  const curveFc = STREAM_SIZES.map(() => null);
  const curvePot = STREAM_SIZES.map(() => null);
  const curveCad = STREAM_SIZES.map(() => null);

  let ok = true;

  try {
    const start = periodStart(period);

    // No limitar a los 20 últimos entrenamientos: un periodo de 3 meses o
    // "Todo" debe incluir todos los registros disponibles.
    const acts = [];
    let last = null;
    for (;;) {
      const cs = [
        where('userId', '==', uid),
        orderBy('fecha', 'desc'),
        limit(100),
      ];

      if (start) cs.push(where('fecha', '>=', start));
      if (last) cs.push(startAfter(last));

      const snap = await getDocs(query(collection(db, 'entrenamientos'), ...cs));
      perfLog.contar('streams.resumenes', snap.size, perfLog.bytesDe(snap.docs.map((d) => d.data())));
      acts.push(
        ...snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((w) => w.estado === 'completo' || (w.duracion || 0) > 0)
      );

      if (snap.size < 100) break;
      last = snap.docs[snap.docs.length - 1];
    }

    // A1: tiempo de procesamiento JS del bucle de puntos/ventanas.
    await perfLog.medir('streams.procesoJs', async () => {
      for (const chunk of chunksOf(acts, 4)) {
        await Promise.all(
          chunk.map(async (w) => {
            try {
              const rs = await getDoc(
                doc(db, 'entrenamientos', w.id, 'registros', 'data')
              );

            if (!rs.exists()) {
              return;
            }

            perfLog.contar('streams.registros', 1, perfLog.bytesDe(rs.data()));

            const pts = rs.data().puntos || [];

            if (!pts.length) {
              return;
            }

            perfLog.contar('streams.puntos', pts.length);

            const t0 = new Date(pts[0].timestamp).getTime();
            const chunks = STREAM_SIZES.map(() => ({}));

            for (let i = 1; i < pts.length; i++) {
              const dt =
                (
                  new Date(pts[i].timestamp) -
                  new Date(pts[i - 1].timestamp)
                ) / 1000;

              if (dt <= 0 || dt > 120) {
                continue;
              }

              const hr = Number(pts[i].frecuencia) || 0;
              const v = Number(pts[i].velocidad) || 0;
              const pot = Number(pts[i].potencia) || 0;
              const cad = Number(pts[i].cadencia) || 0;
              const dk = dayKey(new Date(pts[i].timestamp));

              if (hr > 0) {
                let matchedFc = false;
                for (let zi = 0; zi < fcZ.length; zi++) {
                  if (hr >= fcZ[zi].lo && hr <= fcZ[zi].hi) {
                    zoneFc[zi].sec += dt;

                    (
                      zoneFcDays[dk] ||
                      (zoneFcDays[dk] = new Array(fcZ.length).fill(0))
                    )[zi] += dt;

                    matchedFc = true;
                    break;
                  }
                }
                if (!matchedFc && fcZ.length) zoneFc[fcZ.length].sec += dt;
              }

              if (v > 0 && w.tipo === 'Ciclismo') {
                // Ciclismo: el ritmo se mide en km/h → no aporta a zonas de
                // ritmo ni a la curva de pace (usa curveVel en el bucle de ventanas).
              } else if (v > 0) {
                // `velocidad` se guarda en km/h; el ritmo debe expresarse en s/km.
                const pace = 3600 / v;

                let matchedRt = false;
                for (let zi = 0; zi < rtZ.length; zi++) {
                  if (pace >= rtZ[zi].lo && pace <= rtZ[zi].hi) {
                    zoneRt[zi].sec += dt;

                    (
                      zoneRtDays[dk] ||
                      (zoneRtDays[dk] = new Array(rtZ.length).fill(0))
                    )[zi] += dt;

                    matchedRt = true;
                    break;
                  }
                }
                if (!matchedRt && rtZ.length) zoneRt[rtZ.length].sec += dt;
              }

              const elapsed =
                (
                  new Date(pts[i].timestamp).getTime() - t0
                ) / 1000;

              for (let si = 0; si < STREAM_SIZES.length; si++) {
                const idx = Math.floor(elapsed / STREAM_SIZES[si]);

                const ck =
                  chunks[si][idx] ||
                  (chunks[si][idx] = {
                    t: 0,
                    d: 0,
                    hrS: 0,
                    hrT: 0,
                    pS: 0,
                    pT: 0,
                    cS: 0,
                    cT: 0,
                  });

                ck.t += dt;

                if (v > 0) {
                  // velocidad está en km/h; ck.d se acumula en metros.
                  ck.d += (v * dt) / 3.6;
                }

                if (hr > 0) {
                  ck.hrS += hr * dt;
                  ck.hrT += dt;
                }

                if (pot > 0) {
                  ck.pS += pot * dt;
                  ck.pT += dt;
                }

                if (cad > 0) {
                  ck.cS += cad * dt;
                  ck.cT += dt;
                }
              }
            }

            for (let si = 0; si < STREAM_SIZES.length; si++) {
              for (const idx of Object.keys(chunks[si])) {
                const ck = chunks[si][idx];

                if (ck.d > 0 && ck.t > 0) {
                  if (w.tipo === 'Ciclismo') {
                    const speedKmh = (3.6 * ck.d) / ck.t;
                    if (curveVel[si] == null || speedKmh > curveVel[si]) curveVel[si] = speedKmh;
                  } else {
                    const pace = ck.t / (ck.d / 1000);
                    if (curveRitmo[si] == null || pace < curveRitmo[si]) curveRitmo[si] = pace;
                  }
                }

                if (ck.hrT > 0) {
                  const avg = ck.hrS / ck.hrT;

                  if (
                    curveFc[si] == null ||
                    avg > curveFc[si]
                  ) {
                    curveFc[si] = avg;
                  }
                }

                if (ck.pT > 0) {
                  const avg = ck.pS / ck.pT;

                  if (
                    curvePot[si] == null ||
                    avg > curvePot[si]
                  ) {
                    curvePot[si] = avg;
                  }
                }

                if (ck.cT > 0) {
                  const avg = ck.cS / ck.cT;

                  if (
                    curveCad[si] == null ||
                    avg > curveCad[si]
                  ) {
                    curveCad[si] = avg;
                  }
                }
              }
            }
          } catch (e) {
            console.warn(
              '[analytics] error procesando registros:',
              e.message
            );
          }
        })
      );
    }
    });
  } catch (e) {
    ok = false;
    console.warn('[analytics] getStreamsStatsLegacy falló:', e.message);
  }

  const val = {
    zoneFc,
    zoneRt,
    zoneFcDays,
    zoneRtDays,
    curveRitmo,
    curveVel,
    curveFc,
    curvePot,
    curveCad,
    hasAny:
      zoneFc.some((z) => z.sec > 0) ||
      zoneRt.some((z) => z.sec > 0) ||
      curveRitmo.some((v) => v != null) ||
      curveVel.some((v) => v != null) ||
      curveFc.some((v) => v != null),
    ok,
  };

  streamMem[key] = {
    val,
    ts: Date.now(),
  };

  try {
    await AsyncStorage.setItem(storageKey, JSON.stringify({ v: CACHE_V, val }));
  } catch (e) {
    console.warn('[analytics] no se pudo guardar el snapshot de streams:', e.message);
  }

  return val;
}

/* ═══ CURVAS POR DIGEST (Bloque C, 4.4) ═══
   Si CURVAS_DIGEST_ENABLED y no es force → leerMeses + fusionarDigests.
   Si el backfill del usuario no está completo (backfillV !== 1) se lanza en
   segundo plano y, MIENTRAS se completa, se devuelve el resultado legacy.
   Cualquier error del camino digest cae al legacy sin romper la pantalla.
   force === true (botón de refrescar) ejecuta backfill({ force: true })
   (reconciliación completa) antes de calcular: la válvula de escape manual.
   Mantiene la caché streamMem + AsyncStorage con la MISMA forma (CACHE_V=6)
   y zonaAct en la clave. */
export async function getStreamsStats(uid, period, profile, { force = false, zonaAct = 'General' } = {}) {
  // A3: dos llamadas concurrentes con la misma clave comparten la promesa.
  const key = `${uid}:${period}:${zonaAct}`;

  if (inflightStreams[key]) {
    return inflightStreams[key];
  }

  const p = computeStreamsStats(uid, period, profile, { force, zonaAct }).finally(() => {
    delete inflightStreams[key];
  });

  inflightStreams[key] = p;
  return p;
}

async function computeStreamsStats(uid, period, profile, { force = false, zonaAct = 'General' } = {}) {
  // zonaAct + firma de zonas en la clave (ver computeStreamsStatsLegacy).
  const key = `${uid}:${period}:${zonaAct}:${firmaZonasDe(profile)}`;
  const c = streamMem[key];

  // MEM_TTL ya existía pero no se aplicaba a la caché de curvas: una entrada
  // vivía hasta la siguiente invalidación. Ahora caduca sola (5 min).
  if (!force && c && Date.now() - c.ts < MEM_TTL) {
    perfLog.cacheHit('streamMem');
    return c.val;
  }

  const storageKey = `analyticsStreams_v${CACHE_V}_${uid}_${period}_${zonaAct}_${firmaZonasDe(profile)}`;
  if (force) {
    try { await AsyncStorage.removeItem(storageKey); } catch (e) {}
  }
  if (!force) {
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.v === CACHE_V && parsed.val) {
          perfLog.cacheHit('storage');
          streamMem[key] = { val: parsed.val, ts: Date.now() };
          return parsed.val;
        }
      }
    } catch (e) {
      console.warn('[analytics] caché persistente de streams inválida:', e.message);
    }
    perfLog.cacheMiss('storage');
  }

  if (!CURVAS_DIGEST_ENABLED) {
    return getStreamsStatsLegacy(uid, period, profile, { force, zonaAct });
  }

  if (auth?.currentUser?.uid !== uid) {
    // Un entrenador viendo a un atleta: cálculo legacy en memoria y SIN
    // escribir digests (solo el propietario escribe).
    return getStreamsStatsLegacy(uid, period, profile, { force, zonaAct });
  }

  try {
    if (force) {
      // Válvula de escape manual: reconciliación completa antes de calcular.
      const bf = await CS.backfill(uid, { force: true });
      if (!bf?.ok) throw new Error('backfill force falló');
    }

    const meta = await CS.leerMeta(uid);

    if (meta?.backfillV !== 1) {
      // Backfill aún sin completar: se lanza en segundo plano y, mientras
      // se completa, se sirve el cálculo legacy (resultado válido).
      CS.backfill(uid, { force: false }).catch(() => {});
      return getStreamsStatsLegacy(uid, period, profile, { force: false, zonaAct });
    }

    // Consistencia: si el servidor (o una edición) dejó entrenos pendientes,
    // se procesan ANTES de leer los meses. Si no, la primera visita tras una
    // sincronización de Intervals podría pintar curvas sin el entreno nuevo
    // (procesarPendientes se lanzaba en paralelo desde AnalysisScreen).
    // Acotado a 40 por pasada y solo cuando hay pendientes: 0 lecturas si no hay.
    if (Array.isArray(meta?.pendientes) && meta.pendientes.length) {
      await CS.procesarPendientes(uid, { max: 40 }).catch(() => {});
    }

    const start = periodStart(period);
    const desdeMs = start ? start.getTime() : null;
    const digests = await CS.leerMeses(uid, desdeMs);
    const val = CD.fusionarDigests(digests, profile, desdeMs);

    streamMem[key] = {
      val,
      ts: Date.now(),
    };

    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify({ v: CACHE_V, val }));
    } catch (e) {
      console.warn('[analytics] no se pudo guardar el snapshot de streams:', e.message);
    }

    return val;
  } catch (e) {
    console.warn('[analytics] camino digest falló, uso legacy:', e.message);
    return getStreamsStatsLegacy(uid, period, profile, { force, zonaAct });
  }
}

export function buildZoneSeries(zoneDays, group, period, zoneLabels) {
  const start = periodStart(period);
  const buckets = new Map();

  for (const [k, arr] of Object.entries(zoneDays || {})) {
    const [y, m, dd] = k.split('-').map(Number);
    const date = new Date(y, m - 1, dd);

    if (start && date < start) {
      continue;
    }

    const gk = groupKey(date, group);

    if (!buckets.has(gk)) {
      buckets.set(gk, new Array(zoneLabels.length).fill(0));
    }

    const row = buckets.get(gk);

    for (let zi = 0; zi < Math.min(arr.length, row.length); zi++) {
      row[zi] += arr[zi];
    }
  }

  const keys = [...buckets.keys()].sort();

  return {
    labels: keys.map((k) => fmtBucketLabel(k, group)),
    matrix: keys.map((k) => buckets.get(k)),
  };
}

export function buildSeries(days, tipo, group, period, profile) {
  const start = periodStart(period);
  const buckets = new Map();

  const newB = () => ({
    rd: 0,
    pd: 0,
    rt: 0,
    pt: 0,
    load: 0,
    efort: 0,
    kcal: 0,
    steps: 0,
    sleepS: 0,
    sleepN: 0,
    rhrS: 0,
    rhrN: 0,
    fcMS: 0,
    fcMN: 0,
    fcMaxS: 0,
    fcMaxN: 0,
    hrAvgS: 0,
    hrAvgN: 0,
    vo2S: 0,
    vo2N: 0,
    hrvS: 0,
    hrvN: 0,
    wS: 0,
    wN: 0,
    spo2S: 0,
    spo2N: 0,
    scoreS: 0,
    scoreN: 0,
    maxDist: 0,
    maxDur: 0,
    bestPace: null,
    elevS: 0,
    potS: 0,
    potT: 0,
    bfS: 0,
    bfN: 0,
    bwS: 0,
    bwN: 0,
    ftpS: 0,
    ftpN: 0,
    lthrS: 0,
    lthrN: 0,
    umS: 0,
    umN: 0,
  });

  for (const [k, d] of Object.entries(days || {})) {
    const [y, m, dd] = k.split('-').map(Number);
    const date = new Date(y, m - 1, dd);

    if (start && date < start) {
      continue;
    }

    const gk = groupKey(date, group);
    let b = buckets.get(gk);

    if (!b) {
      b = newB();
      buckets.set(gk, b);
    }

    const eDist = d.count > 0 ? d.dist : (d.iDist || 0);
    const eDur = d.count > 0 ? d.dur : (d.iDur || 0);

    b.rd += eDist;
    b.rt += eDur;
    b.pd += d.planDist;
    b.pt += d.planDur;
    b.load += d.load;
    b.efort += d.efort || 0;
    b.kcal += d.kcal;
    b.steps += d.steps;

    b.elevS += d.elev || 0;
    b.potS += d.potS || 0;
    b.potT += d.potT || 0;

    if (eDist > b.maxDist) {
      b.maxDist = eDist;
    }

    if (eDur > b.maxDur) {
      b.maxDur = eDur;
    }

    if (eDist >= 1 && eDur > 0) {
      const p = eDur / eDist;

      if (b.bestPace == null || p < b.bestPace) {
        b.bestPace = p;
      }
    }

    if (d.sleep != null) {
      b.sleepS += d.sleep;
      b.sleepN++;
    }

    if (d.rhr != null) {
      b.rhrS += d.rhr;
      b.rhrN++;
    }

    if (d.fcMax != null) {
      b.fcMaxS += d.fcMax;
      b.fcMaxN++;
    }

    if (d.avgHr != null) {
      b.hrAvgS += d.avgHr;
      b.hrAvgN++;
    }

    if (d.vo2 != null) {
      b.vo2S += d.vo2;
      b.vo2N++;
    }

    if (d.hrv != null) {
      b.hrvS += d.hrv;
      b.hrvN++;
    }

    if (d.weight != null) {
      b.wS += d.weight;
      b.wN++;
    }

    if (d.spo2 != null) {
      b.spo2S += d.spo2;
      b.spo2N++;
    }

    if (d.score != null) {
      b.scoreS += d.score;
      b.scoreN++;
    }

    if (d.bf != null) {
      b.bfS += d.bf;
      b.bfN++;
    }

    if (d.bw != null) {
      b.bwS += d.bw;
      b.bwN++;
    }

    if (d.ftp != null) {
      b.ftpS += d.ftp;
      b.ftpN++;
    }

    if (d.lthr != null) {
      b.lthrS += d.lthr;
      b.lthrN++;
    }

    if (d.umbral != null) {
      b.umS += d.umbral;
      b.umN++;
    }

    if (d.fcMN > 0) {
      b.fmS = (b.fmS || 0) + d.fcMS;
      b.fmN = (b.fmN || 0) + d.fcMN;
    }
  }

  const keys = [...buckets.keys()].sort();
  const avg = (s, n) => (n > 0 ? s / n : null);

  const heightM = profile?.altura
    ? profile.altura > 3
      ? profile.altura / 100
      : profile.altura
    : null;

  const values = [];
  const values2 = [];

  for (const k of keys) {
    const b = buckets.get(k);

    let v = null;
    let v2 = null;

    switch (tipo) {
      case 'distancia':
        v = b.rd;
        v2 = b.pd;
        break;

      case 'duracion':
        v = b.rt / 3600;
        v2 = b.pt / 3600;
        break;

      case 'rendimiento':
        v =
          b.pt > 0
            ? (b.rt / b.pt) * 100
            : b.pd > 0
              ? (b.rd / b.pd) * 100
              : null;
        break;

      case 'esfuerzo':
        // Prioriza el esfuerzo real por entreno (suma diaria de TSS);
        // como respaldo usa la carga procedente de wellness.
        v = b.efort > 0 ? b.efort : b.load;
        break;

      case 'calorias':
        v = b.kcal;
        break;

      case 'pasos':
        v = b.steps;
        break;

      case 'elevacion':
        v = b.elevS;
        break;

      case 'potencia':
        v = b.potT > 0 ? b.potS / b.potT : null;
        break;

      case 'sueno':
        v = avg(b.sleepS, b.sleepN);
        break;

      case 'score':
        v = avg(b.scoreS, b.scoreN);
        break;

      case 'spo2':
        v = avg(b.spo2S, b.spo2N);
        break;

      case 'fcreposo':
        v = avg(b.rhrS, b.rhrN);
        break;

      case 'fcmax':
        v = avg(b.fcMaxS, b.fcMaxN);
        break;

      case 'fcmedia':
        v =
          b.fmN > 0
            ? b.fmS / b.fmN
            : b.hrAvgN > 0
              ? b.hrAvgS / b.hrAvgN
              : null;
        break;

      case 'vo2':
        v = avg(b.vo2S, b.vo2N);
        break;

      case 'vfc':
        v = avg(b.hrvS, b.hrvN);
        break;

      case 'peso':
        v = avg(b.wS, b.wN);
        break;

      case 'imc': {
        const w = avg(b.wS, b.wN);
        v = w != null && heightM
          ? w / (heightM * heightM)
          : null;
        break;
      }

      case 'masagrasa':
        v = avg(b.bfS, b.bfN);
        break;

      case 'masamuscular':
        v = null;
        break;

      case 'agua':
        v = avg(b.bwS, b.bwN);
        break;

      case 'ftp':
        v = avg(b.ftpS, b.ftpN);
        break;

      case 'lthr':
        v = avg(b.lthrS, b.lthrN);
        break;

      case 'ritmoumbral':
        v = avg(b.umS, b.umN);
        break;

      case 'records':
        v = b.maxDist;
        break;

      default:
        v = null;
    }

    values.push(v);
    values2.push(v2);
  }

  const labels = keys.map((k) => fmtBucketLabel(k, group));

  const hasData =
    values.some((v) => v != null && v > 0) ||
    values2.some((v) => v != null && v > 0);

  return {
    labels,
    values,
    values2,
    hasData,
  };
}

export function buildRecords(days) {
  let maxDist = 0;
  let maxDur = 0;
  let bestPace = null;

  const weekLoad = {};

  for (const [k, d] of Object.entries(days || {})) {
    const eDist = d.count > 0 ? d.dist : (d.iDist || 0);
    const eDur = d.count > 0 ? d.dur : (d.iDur || 0);

    if (eDist > maxDist) {
      maxDist = eDist;
    }

    if (eDur > maxDur) {
      maxDur = eDur;
    }

    if (eDist >= 1 && eDur > 0) {
      const p = eDur / eDist;

      if (bestPace == null || p < bestPace) {
        bestPace = p;
      }
    }

    const [y, m, dd] = k.split('-').map(Number);
    const wk = isoWeekKey(new Date(y, m - 1, dd));

    weekLoad[wk] = (weekLoad[wk] || 0) + ((d.efort || 0) > 0 ? d.efort : d.load);
  }

  const maxWeekLoad = Math.max(0, ...Object.values(weekLoad));

  const fmtPace = (s) => {
    if (s == null) return '—';

    return `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}/km`;
  };

  const fmtDur = (s) => {
    if (s <= 0) return '—';

    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };

  return [
    {
      icon: 'route-outline',
      label: 'Mayor distancia',
      value: maxDist > 0 ? `${maxDist.toFixed(2)} km` : '—',
    },
    {
      icon: 'time-outline',
      label: 'Entreno más largo',
      value: maxDur > 0 ? fmtDur(maxDur) : '—',
    },
    {
      icon: 'speedometer-outline',
      label: 'Mejor ritmo medio (≥1 km)',
      value: fmtPace(bestPace),
    },
    {
      icon: 'flame-outline',
      label: 'Mayor carga semanal',
      value: maxWeekLoad > 0 ? `${Math.round(maxWeekLoad)}` : '—',
    },
  ];
}
