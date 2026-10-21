/* tests/zonas-editor-test.js — REGRESIÓN RONDA 45 (zonas por actividad en el
   EDITOR de pasos + verificación del lado del entrenador).

   Defecto que se corrige:
     · Al editar un entreno de Running con objetivo "Zona ritmo", el picker de
       zonas del paso seguía leyendo las zonas GENÉRICAS del perfil
       (prof.zonasRitmo). Como el usuario vació las genéricas y se creó sus
       zonas propias por actividad (perfil.zonasActividad.Running.ritmo), el
       picker no ofrecía sus zonas reales.
     · StepEditor ya importaba zonasDeActividad() pero NO lo usaba: ahora
       resuelve FC / Ritmo / Potencia con las zonas de la ACTIVIDAD del
       entreno (con fallback a genéricas y, si no hay nada, a los nombres por
       defecto Z1..Z5 / R1..R5 / Z1..Z7).

   Lado del entrenador (verificado aquí):
     · AddWorkoutModal pasa profileUid={athleteId} al StepEditor: cuando el
       entrenador crea un entreno en el calendario de un atleta, las zonas del
       picker son las DEL ATLETA (y las de la actividad elegida), no las suyas.
     · WorkoutDetailModal ya pasa profileUid={athleteId || uid} al StepEditor
       y a PasosResumen; su lectura de Firestore de respaldo también resuelve
       las zonas por actividad (antes usaba d.zonasFC / d.zonasRitmo).
     · PasosResumen (resumen del plan que ve el entrenador) resuelve rangos
       con zonasDeActividad y, si el perfil del atleta no está en caché, lo
       lee de Firestore en vez de quedarse sin rangos.
     · Coherencia de nombres: el picker guarda tituloZona(z,i,pref) y
       PasosResumen/WorkoutDetailModal buscan por (z.titulo || z.label), así
       que la zona elegida se resuelve al mismo rango en el resumen.

   Uso: node tests/zonas-editor-test.js */
'use strict';

// ── GUARD (revisión 2026-10-21) ──────────────────────────────────────────
// Este test necesita el código del SERVIDOR (handlers/ y lib/). Si no está
// (server-extract/, SERVER_DIR o un repo hermano), se imprime SKIP y se sale
// con 0: la batería `node tests/*.js` de la app nunca se rompe por esto.
if (!require('fs').existsSync(require('path').join(require('./server-ruta')(), 'lib'))) {
  console.log('SKIP: falta el código del servidor (define SERVER_DIR o copia el server en server-extract/mi-app-entrenos-main); ver tests/server-ruta.js');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');

let pasadas = 0;
const fallos = [];
function ok(cond, msg) {
  if (cond) { pasadas++; console.log('ok   ' + msg); }
  else { fallos.push(msg); console.log('FALLO ' + msg); }
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) { pasadas++; console.log('ok   ' + msg); }
  else { fallos.push(msg); console.log(`FALLO ${msg} (esperado ${jb}, obtenido ${ja})`); }
}

const RAIZ = path.join(__dirname, '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const srcStep = leer('components/StepEditor.js');
const srcAdd = leer('screens/AddWorkoutModal.js');
const srcWDM = leer('screens/WorkoutDetailModal.js');
const srcResumen = leer('components/PasosResumen.js');
const srcZonas = leer('services/zonas.js');
// Las métricas del plan (computePlanMetrics) viven ahora en services/planReal.js,
// compartidas por las tarjetas de Home/Calendario y por el modal de detalle.
const srcPlanReal = leer('services/planReal.js');

console.log('— 1) StepEditor: el picker de zonas usa las zonas de la ACTIVIDAD —');
ok(/import \{ tituloZona, zonasDeActividad \} from '\.\.\/services\/zonas';/.test(srcStep), 'importa tituloZona y zonasDeActividad');
ok(/import \{ auth, db \} from '\.\.\/firebaseConfig';/.test(srcStep), 'importa db para el respaldo sin caché');
ok(/import \{ doc, getDoc \} from 'firebase\/firestore';/.test(srcStep), 'importa doc/getDoc');
ok(/const fc = lbl\(zonasDeActividad\(prof, 'FC', actividad\), 'Z'\);/.test(srcStep), 'zonas de FC por actividad');
ok(/const ritmo = lbl\(zonasDeActividad\(prof, 'Ritmo', actividad\), 'R'\);/.test(srcStep), 'zonas de RITMO por actividad (el caso del defecto)');
ok(/const pot = lbl\(zonasDeActividad\(prof, 'Potencia', actividad\), 'Z'\);/.test(srcStep), 'zonas de POTENCIA por actividad');
ok(/const lbl = \(arr, pref\) => \(arr \|\| \[\]\)\.map\(\(z, i\) => tituloZona\(z, i, pref\)\);/.test(srcStep), 'los nombres del picker salen de tituloZona (título editable > label > posición)');
ok(!/prof\.zonasRitmo/.test(srcStep) && !/prof\.zonasFC/.test(srcStep) && !/prof\.zonasPotencia/.test(srcStep), 'ya no lee las zonas genéricas a pelo');
ok(/\}, \[profileUid, actividad\]\);/.test(srcStep), 'el effect depende de actividad: cambiar de actividad recarga sus zonas');
ok(/let prof = await getCachedProfile\(uid\);/.test(srcStep) && /const s = await getDoc\(doc\(db, 'perfiles', uid\)\);/.test(srcStep), 'si no hay caché del perfil, se lee de Firestore');
ok(/if \(!prof\) \{ setZones\(porDefecto\); return; \}/.test(srcStep), 'sin perfil alguno se cae a los nombres por defecto (nunca picker vacío)');
ok(/fc: fc\.length \? fc : porDefecto\.fc,/.test(srcStep) && /ritmo: ritmo\.length \? ritmo : porDefecto\.ritmo,/.test(srcStep) && /pot: pot\.length \? pot : porDefecto\.pot,/.test(srcStep), 'cada métrica tiene su propio respaldo por defecto');
{
  // El setState va SIEMPRE dentro del async del effect (nada de setState síncrono).
  const i0 = srcStep.indexOf('const uid = profileUid || auth.currentUser?.uid;');
  const iAsync = srcStep.indexOf('(async () => {', i0 - 200);
  const iSet = srcStep.indexOf('setZones({', i0);
  ok(i0 > 0 && iAsync > 0 && iSet > iAsync && iSet > i0, 'setZones ocurre dentro del async del effect');
}
{
  // Mapeo objetivo → juego de zonas del picker.
  const cuerpo = srcStep.slice(srcStep.indexOf('const zonaOptions = (tipo) => {'), srcStep.indexOf('const zonaOptions = (tipo) => {') + 300);
  ok(/if \(tipo === 'Zona FC'\) return zones\.fc;/.test(cuerpo), 'objetivo "Zona FC" → zones.fc');
  ok(/if \(tipo === 'Zona ritmo'\) return zones\.ritmo;/.test(cuerpo), 'objetivo "Zona ritmo" → zones.ritmo');
  ok(/if \(tipo === 'Zona potencia'\) return zones\.pot;/.test(cuerpo), 'objetivo "Zona potencia" → zones.pot');
}

console.log('— 2) Entrenador: de quién son las zonas que se ofrecen —');
ok(/<StepEditor pasos=\{pasos\} setPasos=\{setPasos\} profileUid=\{athleteId \|\| undefined\} actividad=\{actividad\} \/>/.test(srcAdd), 'AddWorkoutModal pasa profileUid=athleteId al StepEditor (zonas del atleta)');
ok(/<StepEditor pasos=\{pasos\} setPasos=\{setPasos\} profileUid=\{athleteId \|\| auth\.currentUser\?\.uid\} actividad=\{actividad\} \/>/.test(srcWDM), 'WorkoutDetailModal pasa profileUid=athleteId||uid al StepEditor');
ok(/setFcZones\(zonasDeActividad\(d, 'FC', workout\.tipo\)\); setRitmoZones\(zonasDeActividad\(d, 'Ritmo', workout\.tipo\)\);/.test(srcWDM), 'el respaldo de Firestore del WDM también resuelve por actividad');
ok(!/setFcZones\(d\.zonasFC \|\| \[\]\)/.test(srcWDM), 'el respaldo del WDM ya no usa las genéricas a pelo');
ok(/<PasosResumen/.test(srcWDM) && /profileUid=\{athleteId \|\| auth\.currentUser\?\.uid\}/.test(srcWDM), 'PasosResumen recibe el uid del atleta');
ok(/const uid = profileUid \|\| auth\.currentUser\?\.uid;/.test(srcResumen) && /zonasDeActividad\(prof, 'Ritmo', actividad\)/.test(srcResumen), 'PasosResumen resuelve los rangos por actividad');
ok(/let prof = await getCachedProfile\(uid\);/.test(srcResumen) && /const s = await getDoc\(doc\(db, 'perfiles', uid\)\);/.test(srcResumen), 'PasosResumen lee el perfil de Firestore si no está en caché');
ok(/import \{ doc, getDoc, updateDoc, Timestamp \} from 'firebase\/firestore';/.test(srcResumen), 'PasosResumen importa getDoc');
ok(!/setFinOpen\s*\(/.test(srcResumen), 'sin llamadas a setters inexistentes (ReferenceError al reiniciar un entreno de fuerza)');

console.log('— 3) zonasDeActividad + tituloZona: comportamiento real (eval del fuente) —');
const i0 = srcZonas.indexOf('export function tituloZona');
const i1 = srcZonas.indexOf('const PCT_FC');
ok(i0 > 0 && i1 > i0, 'localiza tituloZona y zonasDeActividad en services/zonas.js');
const codigo = srcZonas.slice(i0, i1).replace(/export function/g, 'function');
const mod = new Function(`${codigo}\nreturn { tituloZona, zonasDeActividad };`)();
const { tituloZona, zonasDeActividad } = mod;

const GEN = [
  { id: 'R0', min: '6:00', max: '5:30' },
  { id: 'R1', min: '5:30', max: '5:00' },
  { id: 'R2', min: '5:00', max: '4:30' },
];
const RUN = [
  { id: 'R1', titulo: 'R1 Ritmo', min: '5:40', max: '5:10' },
  { id: 'R2', titulo: 'R2+', min: '5:10', max: '4:40' },
  { id: 'R3', label: 'R3 Series', min: '4:40', max: '4:10' },
  { id: 'R4', min: '4:10', max: '3:40' },
];
const biciFc = [{ id: '1', min: 100, max: 120 }, { id: '2', min: 120, max: 140 }];
const perfil = {
  zonasRitmo: GEN,
  zonasFC: [{ id: '1', min: 110, max: 130 }],
  zonasActividad: { Running: { ritmo: RUN }, 'Ciclismo': { fc: biciFc, ritmo: [] } },
};

// Nombres que ofrecería el picker (misma expresión que StepEditor)
const lbl = (arr, pref) => (arr || []).map((z, i) => tituloZona(z, i, pref));
const resolver = (prof, actividad) => ({
  fc: lbl(zonasDeActividad(prof, 'FC', actividad), 'Z'),
  ritmo: lbl(zonasDeActividad(prof, 'Ritmo', actividad), 'R'),
  pot: lbl(zonasDeActividad(prof, 'Potencia', actividad), 'Z'),
});

const run = resolver(perfil, 'Running');
eq(run.ritmo, ['R1 Ritmo', 'R2+', 'R3 Series', 'R4'], 'Running → el picker ofrece las zonas de ritmo PROPIAS de Running (títulos editables incluidos)');
eq(run.fc, ['Z1'], 'Running sin zonas de FC propias → FC genéricas');
eq(run.pot, [], 'Running sin zonas de potencia (ni propias ni genéricas) → lista vacía → StepEditor pone Z1..Z7');

const bici = resolver(perfil, 'Ciclismo');
eq(bici.ritmo, ['R1', 'R2', 'R3'], 'Ciclismo con zonas de ritmo propias VACÍAS → cae a las genéricas');
eq(bici.fc, ['Z1', 'Z2'], 'Ciclismo con zonas de FC propias → las suyas');

eq(resolver(perfil, 'Natación').ritmo, ['R1', 'R2', 'R3'], 'Natación sin zonas propias → genéricas');
eq(resolver(perfil, null).ritmo, ['R1', 'R2', 'R3'], 'sin actividad (Genéricas) → genéricas');
eq(resolver(perfil, 'Evento').ritmo, ['R1', 'R2', 'R3'], 'Evento sin zonas propias → genéricas (no rompe)');
eq(resolver(null, 'Running').ritmo, [], 'perfil nulo → sin zonas (StepEditor pondría los nombres por defecto)');

// Zonas de FC/potencia genéricas ausentes: StepEditor respalda por métrica
const sinFc = { zonasActividad: { Running: { ritmo: RUN } } };
eq(resolver(sinFc, 'Running').fc, [], 'sin zonas de FC en ningún sitio → lista vacía (respaldo Z1..Z5 del StepEditor)');
eq(resolver(sinFc, 'Running').ritmo, ['R1 Ritmo', 'R2+', 'R3 Series', 'R4'], '…pero las de ritmo de Running siguen saliendo');

console.log('— 4) Coherencia picker ↔ resumen ↔ plan (mismo nombre, mismo rango) —');
{
  // Lo que guarda el paso al elegir una zona del picker de Running
  const nombreElegido = run.ritmo[1];              // "R2+" (título editable)
  const paso = { objetivo: 'Zona ritmo', objZona: nombreElegido };
  // zonaPorNombre de PasosResumen (misma lógica, replicada del fuente)
  const srcFn = srcResumen.slice(srcResumen.indexOf('function zonaPorNombre'), srcResumen.indexOf('// Valor de la columna Objetivo'));
  ok(/function zonaPorNombre\(lista, nombre, pref\)/.test(srcFn), 'PasosResumen tiene zonaPorNombre');
  const zonaPorNombre = new Function(`${srcFn}\nreturn zonaPorNombre;`)();
  const zonasResumen = { ritmo: zonasDeActividad(perfil, 'Ritmo', 'Running') };
  const z = zonaPorNombre(zonasResumen.ritmo, paso.objZona, 'R');
  ok(!!z, 'el resumen encuentra la zona elegida en el picker por su título');
  eq([z && z.min, z && z.max], ['5:10', '4:40'], '…y pinta el rango de las zonas de Running (no el de las genéricas)');
  // computePlanMetrics (ahora en services/planReal.js, compartido por el WDM y
  // por las tarjetas de Home/Calendario) busca igual: (z.titulo || z.label) === objZona
  ok(/\(z && \(z\.titulo \|\| z\.label\)\) \|\| ''\)\.trim\(\) === nom/.test(srcPlanReal), 'planReal (métricas del plan) busca la zona por titulo/label');
  ok(/computePlanMetrics as metricsPlan/.test(srcWDM) && /=> metricsPlan\(pasos, zonasRitmo\)/.test(srcWDM), 'WorkoutDetailModal delega en el módulo compartido (una sola copia de la lógica)');
  const zi = zonasResumen.ritmo.findIndex((zz) => (zz.titulo || zz.label) === paso.objZona);
  eq(zi, 1, 'el índice que resuelve el plan coincide con la zona elegida');
}

console.log('— 5) StepEditor completo: nombres por defecto cuando no hay nada —');
{
  const porDefecto = {
    fc: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'],
    ritmo: ['R1', 'R2', 'R3', 'R4', 'R5'],
    pot: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'],
  };
  const vacío = resolver({ zonasRitmo: [], zonasFC: [], zonasPotencia: [] }, 'Running');
  eq(vacío.ritmo.length ? vacío.ritmo : porDefecto.ritmo, ['R1', 'R2', 'R3', 'R4', 'R5'], 'perfil sin zonas → el picker sigue ofreciendo R1..R5 (nunca vacío)');
  eq(vacío.fc.length ? vacío.fc : porDefecto.fc, ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'], '…y Z1..Z5 en FC');
  eq(vacío.pot.length ? vacío.pot : porDefecto.pot, ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'], '…y Z1..Z7 en potencia');
}

console.log('— 6) Servidor (Intervals.icu): mismas zonas por actividad en la descripción —');
{
  const lib = require(path.join(require('./server-ruta')(), 'lib', 'uploadWorkouts.js'));
  ok(typeof lib.loadAppZones === 'function', 'loadAppZones está EXPORTADO (handlers/upload-to-intervals.js lo importa: antes llegaba undefined y el endpoint devolvía 500)');
  ok(typeof lib.zonasPara === 'function', 'zonasPara exportado');
  ok(typeof lib.buildPayload === 'function' && typeof lib.buildPlannedPayload === 'function', 'buildPayload/buildPlannedPayload siguen exportados');

  // loadAppZones con una db falsa: perfil con genéricas + zonas por actividad
  const docPerfil = {
    zonasRitmo: [{ id: 'R1', label: 'R1', min: '5:30', max: '5:00' }],
    zonasFC: [{ id: '1', min: 110, max: 130 }],
    zonasPotencia: [],
    zonasActividad: {
      Running: { ritmo: [{ id: 'R2', titulo: 'R2+', min: '5:10', max: '4:40' }], fc: [], potencia: [] },
      'Ciclismo': { ritmo: [], fc: [{ id: '1', min: 100, max: 120 }], potencia: [] },
    },
  };
  const dbFalsa = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => docPerfil }) }) }) };
  (async () => {
    const z = await lib.loadAppZones(dbFalsa, 'uid-falso');
    eq(z.ritmo.length, 1, 'loadAppZones: genéricas de ritmo');
    eq(Object.keys(z.porActividad || {}).sort(), ['Ciclismo', 'Running'], 'loadAppZones: lee zonasActividad (por actividad)');
    eq(z.porActividad.Running.ritmo[0].titulo, 'R2+', 'loadAppZones: conserva los títulos editables');

    const run = lib.zonasPara(z, 'Running');
    eq(run.ritmo.map((x) => x.titulo || x.label), ['R2+'], 'zonasPara(Running) → zonas de ritmo de Running');
    eq(run.fc.length, 1, 'zonasPara(Running) sin FC propias → FC genéricas');
    eq(lib.zonasPara(z, 'Ciclismo').ritmo.map((x) => x.label), ['R1'], 'zonasPara(Ciclismo) con ritmo propio vacío → genéricas');
    eq(lib.zonasPara(z, 'Ciclismo').fc[0].min, 100, 'zonasPara(Ciclismo) → sus zonas de FC');
    eq(lib.zonasPara(z, 'Natación').ritmo.map((x) => x.label), ['R1'], 'zonasPara(Natación) sin zonas propias → genéricas');
    eq(lib.zonasPara(null, 'Running'), { ritmo: [], fc: [], pot: [] }, 'zonasPara(null) no rompe');
    eq(lib.zonasPara({ ritmo: [], fc: [], pot: [] }, undefined).pot, [], 'zonasPara sin tipo ni porActividad no rompe');

    // Descripción de pasos: el rango debe salir de las zonas de la ACTIVIDAD
    const w = {
      tipo: 'Running', titulo: 'Series', fecha: new Date(2026, 8, 30, 7, 0, 0),
      pasos: [{ tipo: 'Intensivo', durTipo: 'Distancia', durValor: '1', durUnidad: 'km', objetivo: 'Zona ritmo', objZona: 'R2+' }],
    };
    const plan = lib.buildPlannedPayload(w, z);
    ok(/4:40\/km-5:10\/km Pace/.test(plan.description || ''), 'buildPlannedPayload pinta el rango de la zona de Running (4:40-5:10, el rápido primero)');
    ok(!/5:00\/km-5:30\/km/.test(plan.description || ''), '…y NO el de las genéricas');
    const sub = lib.buildPayload(w, z, () => {});
    ok(/4:40\/km-5:10\/km Pace/.test(sub.payload.description || ''), 'buildPayload (subida nueva) hace lo mismo');
    // Con zonas genéricas únicamente (perfil antiguo) sigue funcionando igual
    const soloGen = { ritmo: z.ritmo, fc: z.fc, pot: z.pot };
    const planGen = lib.buildPlannedPayload({ ...w, pasos: [{ ...w.pasos[0], objZona: 'R1' }] }, soloGen);
    ok(/5:00\/km-5:30\/km Pace/.test(planGen.description || ''), 'perfil sin zonas por actividad → sigue usando las genéricas');
    // findZone por título editable
    const planTitulo = lib.buildPlannedPayload(w, { ...soloGen, ritmo: [{ id: 'R2', titulo: 'R2+', min: '5:10', max: '4:40' }] });
    ok(/4:40\/km-5:10\/km Pace/.test(planTitulo.description || ''), 'findZone reconoce el título editable (R2+), no solo el label');

    console.log(`\n${pasadas} comprobaciones OK, ${fallos.length} fallos`);
    if (fallos.length) { fallos.forEach((f) => console.log(' · ' + f)); process.exit(1); }
    console.log('✅ zonas-editor-test: TODO VERDE');
  })().catch((e) => { console.log('FALLO excepción en la sección de servidor:', e && e.message); process.exit(1); });
}
