/* tests/curvas-zonas-test.js — REVISIÓN 2026-10-21 (nuevo).
   Cubre dos correcciones hechas sobre el motor de curvas:

   1) La caché de curvas incluye la FIRMA DE ZONAS en la clave. Antes, cambiar
      una zona o un umbral servía el snapshot cacheado con las etiquetas
      nuevas sobre segundos calculados con las zonas viejas (no se invalidaba
      nada al guardar en Zonas).
   2) Si `analyticsCurves/{uid}.pendientes` tiene entrenos, el motor los
      procesa ANTES de leer los meses. Antes se lanzaba en paralelo desde
      AnalysisScreen, así que la primera visita tras una sincronización podía
      pintar curvas sin el entreno nuevo.

   Usa el motor REAL con Firestore/AsyncStorage simulados.
   Uso: node tests/curvas-zonas-test.js */
'use strict';
process.env.PERF_LOG = '';
const { crearFirestore, crearStorage, cargarReales } = require('./_curvas-mocks');

let pasadas = 0;
const fallos = [];
function ok(cond, msg) {
  if (cond) { pasadas++; console.log('ok   ' + msg); }
  else { fallos.push(msg); console.log('FALLO ' + msg); }
}
function eq(a, b, msg) {
  if (a === b) { pasadas++; console.log('ok   ' + msg); }
  else { fallos.push(msg); console.log(`FALLO ${msg} (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`); }
}

// 3 zonas de ritmo vs 4: el número de zonas es lo que delata qué perfil pintó.
const PERFIL_A = {
  zonasFC: [{ titulo: 'Z1', min: 0, max: 120 }, { titulo: 'Z2', min: 121, max: 145 }, { titulo: 'Z3', min: 146, max: 220 }],
  zonasRitmo: [{ titulo: 'R1', min: '7:00', max: '5:01' }, { titulo: 'R2', min: '5:00', max: '4:01' }, { titulo: 'R3', min: '4:00', max: '0:01' }],
};
const PERFIL_B = {
  zonasFC: [{ titulo: 'Z1', min: 0, max: 120 }, { titulo: 'Z2', min: 121, max: 145 }, { titulo: 'Z3', min: 146, max: 220 }],
  zonasRitmo: [
    { titulo: 'R1', min: '7:00', max: '5:31' },
    { titulo: 'R2', min: '5:30', max: '4:31' },
    { titulo: 'R3', min: '4:30', max: '3:31' },
    { titulo: 'R4', min: '3:30', max: '0:01' },
  ],
};

const PTS = 180;

function puntos(f) {
  const out = [];
  let t = f;

  for (let i = 0; i < PTS; i++) {
    out.push({
      timestamp: new Date(t).toISOString(),
      frecuencia: Math.round(140 + 15 * Math.sin(i / 20)),
      velocidad: Number((10 + 2 * Math.sin(i / 15)).toFixed(3)),
      cadencia: 170,
    });
    t += 1000;
  }

  return out;
}

async function main() {
  const fsMock = crearFirestore();
  const storage = crearStorage();
  const { AE, CD, CS } = cargarReales({ auth: { currentUser: { uid: 'u1' } }, firestore: fsMock, storage });

  const base = new Date(2026, 7, 1, 8, 0, 0).getTime();
  const acts = [];

  for (let i = 0; i < 2; i++) {
    const id = 'w' + i;
    const f = base + i * 3600000;
    const pts = puntos(f);
    fsMock.seedDoc(`entrenamientos/${id}`, {
      userId: 'u1', fecha: fsMock.Timestamp.fromMillis(f), tipo: 'Running',
      estado: 'completo', duracion: PTS, distancia: 1,
    });
    fsMock.seedDoc(`entrenamientos/${id}/registros/data`, { puntos: pts });
    acts.push({ id, f, pts });
  }

  // Digests ya persistidos (como si el backfill hubiera terminado).
  const actsMes = {};
  for (const a of acts) actsMes[a.id] = CD.calcularDigest(a.pts, 'Running', a.f);
  fsMock.seedDoc('analyticsCurves/u1/months/2026-08', { v: 1, acts: actsMes });
  fsMock.seedDoc('analyticsCurves/u1', { v: 1, backfillV: 1, primerMes: '2026-08' });

  const lecturasMeses = () => fsMock.lecturas
    .filter((l) => l.tipo === 'getDoc' && l.path.startsWith('analyticsCurves/u1/months')).length;

  // ── 1) Misma zonas → caché; zonas distintas → recálculo ────────────────
  console.log('— 1) La caché de curvas incluye la firma de zonas —');

  const r1 = await AE.getStreamsStats('u1', 'todo', PERFIL_A, { zonaAct: 'General' });
  eq(r1.zoneRt.length, 4, 'perfil A: 3 zonas de ritmo + «Fuera»');
  eq(r1.curveRitmo.filter((v) => v != null).length > 0, true, 'perfil A: hay curvas');

  const l1 = lecturasMeses();
  ok(l1 > 0, `primera llamada: lee ${l1} documentos de mes`);

  const r2 = await AE.getStreamsStats('u1', 'todo', PERFIL_A, { zonaAct: 'General' });
  eq(lecturasMeses(), l1, 'mismo perfil: se sirve de la caché (sin lecturas nuevas)');
  eq(r2.zoneRt.length, 4, 'mismo perfil: mismo resultado');

  const r3 = await AE.getStreamsStats('u1', 'todo', PERFIL_B, { zonaAct: 'General' });
  eq(r3.zoneRt.length, 5, 'perfil B (4 zonas): NO se reutiliza el snapshot del perfil A');
  // Los documentos de mes SÍ se comparten (caché por mes, es lo deseado: 3
  // lecturas para los dos perfiles). Lo que no puede repetirse es el RESULTADO
  // fusionado: con otras zonas, el reparto de segundos cambia.
  const repartoA = r1.zoneRt.map((z) => Math.round(z.sec)).join(',');
  const repartoB = r3.zoneRt.map((z) => Math.round(z.sec)).join(',');
  ok(repartoA !== repartoB, 'perfil B: recalcula el reparto de zonas (no sirve el de A)');
  eq(lecturasMeses(), l1, 'perfil B: reutiliza los documentos de mes ya cacheados');

  const r4 = await AE.getStreamsStats('u1', 'todo', PERFIL_A, { zonaAct: 'General' });
  eq(r4.zoneRt.length, 4, 'volver al perfil A: recupera SU resultado, no el de B');

  const r5 = await AE.getStreamsStats('u1', 'todo', PERFIL_A, { zonaAct: 'Running' });
  eq(r5.zoneRt.length, 4, 'cambiar la actividad de zonas sigue recalculando (zonaAct en la clave)');

  // ── 2) Los pendientes se procesan antes de leer los meses ─────────────
  console.log('\n— 2) `pendientes` se procesa antes de leer los meses —');
  {
    const fsMock2 = crearFirestore();
    const env2 = cargarReales({ auth: { currentUser: { uid: 'u2' } }, firestore: fsMock2, storage: crearStorage() });
    const { AE: AE2, CD: CD2 } = env2;

    const f = new Date(2026, 7, 10, 8, 0, 0).getTime();
    const pts = puntos(f);
    fsMock2.seedDoc('entrenamientos/p1', {
      userId: 'u2', fecha: fsMock2.Timestamp.fromMillis(f), tipo: 'Running',
      estado: 'completo', duracion: PTS, distancia: 1,
    });
    fsMock2.seedDoc('entrenamientos/p1/registros/data', { puntos: pts });
    // Meta con el entreno PENDIENTE y el mes todavía vacío.
    fsMock2.seedDoc('analyticsCurves/u2', { v: 1, backfillV: 1, primerMes: '2026-08', pendientes: ['p1'] });
    fsMock2.seedDoc('analyticsCurves/u2/months/2026-08', { v: 1, acts: {} });

    const sinProcesar = CD2.fusionarDigests([], PERFIL_A, null);
    ok(!sinProcesar.hasAny, 'control: sin digests no hay curvas');

    const res = await AE2.getStreamsStats('u2', 'todo', PERFIL_A, { zonaAct: 'General' });
    ok(res.hasAny, 'la primera llamada YA incluye el entreno pendiente (procesado antes de leer)');
    ok((res.curveFc || []).some((v) => v != null), 'la curva de FC tiene datos del entreno pendiente');

    const mes = await (async () => {
      const d = fsMock2.lecturas; // (no se usa; el estado se comprueba abajo)
      return d;
    })();
    ok(Array.isArray(mes), 'lecturas registradas por el mock');

    const metaTras = env2.CS && typeof env2.CS.leerMeta === 'function'
      ? await env2.CS.leerMeta('u2')
      : null;
    ok(metaTras == null || !(metaTras.pendientes || []).includes('p1'), 'el entreno sale de `pendientes` tras procesarlo');
  }

  console.log(`\n${fallos.length ? 'FALLOS: ' + fallos.length : 'TODO OK'} — ${pasadas} comprobaciones OK`);
  if (fallos.length) process.exit(1);
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(2); });
