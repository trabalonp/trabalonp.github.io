// tests/matcher-test.js — puertas duras del matcher plan↔real (servidor).
// Regla del usuario: si un entreno NO cumple, NO se fusiona AUNQUE sea el
// único candidato del día. Ejecutar: node tests/matcher-test.js
'use strict';

// ── GUARD (revisión 2026-10-21) ──────────────────────────────────────────
// Este test necesita el código del SERVIDOR (handlers/ y lib/). Si no está
// (server-extract/, SERVER_DIR o un repo hermano), se imprime SKIP y se sale
// con 0: la batería `node tests/*.js` de la app nunca se rompe por esto.
if (!require('fs').existsSync(require('path').join(require('./server-ruta')(), 'lib'))) {
  console.log('SKIP: falta el código del servidor (define SERVER_DIR o copia el server en server-extract/mi-app-entrenos-main); ver tests/server-ruta.js');
  process.exit(0);
}

const path = require('path');
const { cumpleCondiciones, candidatePorPct, scoreMatch, computePlanMetrics, AUTO_MERGE } = require(path.join(require('./server-ruta')(), 'lib', 'matcher.js'));

let pasadas = 0;
const fallos = [];
function assert(cond, msg) {
  if (cond) pasadas++;
  else { fallos.push(msg); console.error('  ✗ ' + msg); }
}
const T = (h) => new Date(`2026-09-20T${h}:00:00Z`);
const plan = (over = {}) => ({
  id: 'plan1', tipo: 'Running', titulo: 'Series 1500', fecha: T('08'),
  pasos: [{ durTipo: 'Tiempo', durValor: 5, durUnidad: 'min', repeticiones: 6, objetivo: 'Ritmo', objMin: '4:00', objMax: '4:10' }],
  ...over,
});
// plan: 6×5 min = 1800 s (+ sin km)
const real = (over = {}) => ({ id: 'real1', tipo: 'Running', titulo: 'Rodaje', fecha: T('08'), distancia: 10, duracion: 3600, ...over });

console.log('— Puertas duras —');
assert(cumpleCondiciones(real({ duracion: 1900 }), plan()).ok === true, 'mismo tipo/hora y cumplimiento 105% → pasa la puerta');
assert(cumpleCondiciones(real({ tipo: 'Ciclismo' }), plan()).ok === false, 'tipo distinto → NO fusiona');
assert(cumpleCondiciones(real({ fecha: T('18'), duracion: 1900 }), plan()).ok === true, 'la hora ya NO bloquea: mandan los porcentajes (plan 8:00, hecho 18:00 al 105 %)');
assert(cumpleCondiciones(real({ duracion: 600 }), plan()).ok === false, 'cumplimiento 33% (<50%) → NO fusiona');
assert(cumpleCondiciones(real({ duracion: 900 }), plan()).ok === true, 'cumplimiento 50% → pasa (límite)');
assert(cumpleCondiciones(real({ duracion: 2600 }), plan()).ok === true, 'cumplimiento 144% → pasa');
assert(cumpleCondiciones(real({ duracion: 2800 }), plan()).ok === false, 'cumplimiento 155% (>150%) → NO fusiona');
assert(cumpleCondiciones(real({ duracion: 8000 }), plan()).ok === false, 'duracion >2x el plan → NO fusiona');
// plan sin métricas calculables → la puerta de métricas no bloquea
assert(cumpleCondiciones(real(), { ...plan(), pasos: [] }).ok === true, 'plan sin pasos → puerta de métricas neutra');

console.log('— El único candidato ya no regala fusiones —');
// Caso del bug: único plan del día, rodaje de 10 km/1 h vs series de 30 min.
// Antes: contextScore=1 + orden=0.5 empujaban por encima del umbral.
const S = real();
const P = plan();
const gate = cumpleCondiciones(S, P);
const sc = scoreMatch(S, P, 1, { completedSeq: [S], plannedSeq: [P] });
assert(!gate.ok || sc < AUTO_MERGE, 'candidato único que no cumple → sin fusión (gate o score)');
// Y un par coherente sí supera el umbral con candidato único:
const S2 = real({ titulo: 'Series 1500', duracion: 1900 });
const sc2 = scoreMatch(S2, P, 1, { completedSeq: [S2], plannedSeq: [P] });
assert(cumpleCondiciones(S2, P).ok && sc2 >= AUTO_MERGE, 'candidato único coherente → sí fusiona');

console.log('— Regla de porcentajes (vinculación) —');
const P10k = { ...plan(), pasos: [{ durTipo: 'Distancia', durValor: 10, durUnidad: 'km', repeticiones: 1 }] };   // 10 km
const P5k  = { ...plan(), id: 'plan5k', pasos: [{ durTipo: 'Distancia', durValor: 5, durUnidad: 'km', repeticiones: 1 }] };  // 5 km
const S98 = real({ distancia: 9.8, duracion: 3500 });   // 98 % del plan de 10 km
let eleccion = candidatePorPct(S98, [P5k, P10k]);
assert(eleccion && eleccion.P.id === 'plan1', 'con dos candidatos, vincula el más cercano al 100 % (10K al 98 %, no 5K al 196 %)');
assert(eleccion && Math.round(eleccion.pct) === 98, 'el pct devuelto es el cumplimiento real (98 %)');
eleccion = candidatePorPct(real({ distancia: 20, duracion: 7000 }), [P10k]);
assert(eleccion === null, '200 % del plan → fuera de rango: no vincula');
eleccion = candidatePorPct(real({ distancia: 2, duracion: 800 }), [P10k]);
assert(eleccion === null, '20 % del plan → fuera de rango: no vincula');
eleccion = candidatePorPct(S98, [{ ...plan(), pasos: [] }]);
assert(eleccion === null, 'plan sin pasos medibles → sin candidato por porcentaje (usa el score clásico)');
eleccion = candidatePorPct({ ...S98, tipo: 'Ciclismo' }, [P10k]);
assert(eleccion === null, 'actividad distinta → no vincula');

console.log('— Zonas de ritmo en el cálculo del plan (rodaje por tiempo) —');
{
  // El caso del atleta: rodaje de 70 min a "Zona ritmo R2" SIN ritmos
  // manuales. Sin resolver la zona, el plan salía ~1.5 km para ~19 reales.
  const zonas = [
    { titulo: 'R0', min: '6:30', max: '7:30' },
    { titulo: 'R1', min: '5:30', max: '6:30' },
    { titulo: 'R2', min: '4:30', max: '5:30' },
  ];
  const pasos = [
    { tipo: 'Calentamiento', durTipo: 'Tiempo', durValor: '15', repeticiones: '1', hijos: [] },
    { tipo: 'Extensivo', durTipo: 'Tiempo', durValor: '70', objetivo: 'Zona ritmo', objZona: 'R2', repeticiones: '1', hijos: [] },
    { tipo: 'Enfriarse', durTipo: 'Tiempo', durValor: '10', repeticiones: '1', hijos: [] },
  ];
  const plan = computePlanMetrics(pasos, zonas);
  assert(plan.km > 13.5 && plan.km < 14.5, `plan con zona resuelta = 14 km (70 min a 5:00; obtenido ${plan.km && plan.km.toFixed(1)})`);
  assert(plan.sec > 0, 'el tiempo del plan se mantiene');

  const sinZonas = computePlanMetrics(pasos, []);
  assert(sinZonas.km === 0, 'sin zonas y sin ritmos manuales → 0 km (el fallo que tenía el matcher)');

  // Serie con hijos: los hijos heredan las repeticiones de la serie
  const serie = [{ tipo: 'Intensivo', durTipo: 'Distancia', durValor: '1', durUnidad: 'km', repeticiones: '5',
    hijos: [{ tipo: 'Recuperación', durTipo: 'Tiempo', durValor: '1', durUnidad: 'min', repeticiones: '1', hijos: [] }] }];
  const planSerie = computePlanMetrics(serie, []);
  assert(planSerie.km > 4.9 && planSerie.km < 5.1, 'la serie 5x1 km suma 5 km');
  assert(planSerie.sec === 300, 'la recuperación (hijo) se multiplica por las 5 repeticiones (300 s)');
}

console.log(`\n${fallos.length ? 'FALLOS: ' + fallos.length : 'TODO OK'} — ${pasadas} aserciones pasadas`);
process.exit(fallos.length ? 1 : 0);
