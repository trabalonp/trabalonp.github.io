// tests/records-test.js — prueba unitaria PURA de lib/records.js del
// servidor (copia de server-extract): detección de marcas personales al
// sincronizar entrenos, incluida la creación automática de distancias
// clásicas que el atleta no tenía configuradas (p. ej. un 10K).
//
// Ejecutar:  node tests/records-test.js
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
const { comprobarRecords } = require(path.join(
  require('./server-ruta')(), 'lib', 'records.js'));

let pasadas = 0;
const fallos = [];
function assert(cond, msg) {
  if (cond) pasadas++;
  else { fallos.push(msg); console.error('  ✗ ' + msg); }
}

const fecha = new Date('2026-09-20T08:00:00Z');
// Rodaje de 10.2 km en 51:00 (3060 s) → ritmo 5:00/km
const w10k = { id: 'fit_1', tipo: 'Running', distancia: 10.2, duracion: 3060, fecha, titulo: 'Rodaje 10k' };

console.log('— Creación automática de distancias clásicas no configuradas —');
let r = comprobarRecords({ marcasDefs: [], marcasResults: {} }, w10k);
assert((r.defs || []).length === 1, 'un 10.2 km auto-crea SOLO la distancia clásica más larga cubierta (nada de 800 m/1500 m extrapolados)');
const def10k = (r.defs || []).find((d) => d.titulo === '10K');
assert(!!def10k, 'se auto-crea la prueba 10K cuando no estaba en marcasDefs');
assert(!!def10k && def10k.auto === true, 'la prueba auto-creada va marcada auto:true');
const b10k = r.batidos.find((b) => b.titulo === '10K');
assert(!!b10k, 'el 10K cubierto genera su récord');
assert(b10k && b10k.valor === Math.round(3060 * (10 / 10.2)), 'tiempo del 10K extrapolado del ritmo medio (3000 s)');
assert(b10k && b10k.primera === true, 'récord nuevo (sin marca anterior) → primera:true (el push dirá "¡Nuevo récord!")');
assert(!!(r.resultados && def10k && Array.isArray(r.resultados[def10k.id]) && r.resultados[def10k.id].length === 1),
  'el resultado queda guardado en marcasResults[defId]');
assert(!!(r.bests && def10k && r.bests[def10k.id]), 'marcasBest se actualiza con el nuevo récord');
const res10k = r.resultados && def10k && r.resultados[def10k.id][0];
assert(res10k && res10k.workoutId === 'fit_1', 'el resultado guardado referencia el workoutId');

console.log('— No auto-crea distancias que el entreno no cubre —');
r = comprobarRecords({ marcasDefs: [], marcasResults: {} }, { ...w10k, distancia: 6, duracion: 1800 });
assert(!(r.defs || []).some((d) => d.titulo === '10K'), 'un 6 km NO crea la prueba de 10K');
assert((r.defs || []).length === 1 && (r.defs || []).some((d) => d.titulo === '5K'), 'un 6 km crea solo 5K (la más larga cubierta)');

console.log('— Respeto a la mejor marca existente —');
const perfilConBest = {
  marcasDefs: [{ id: 'd1', actividad: 'Running', titulo: '10K', tipo: 'dist', distM: 10000 }],
  marcasBest: { d1: { valor: 2900, fecha: '2026-01-01T00:00:00Z' } },
  marcasResults: { d1: [{ id: 'r1', valor: 2900, fecha: '2026-01-01T00:00:00Z' }] },
};
r = comprobarRecords(perfilConBest, w10k); // 3000 s > 2900 s → más lento
assert(r.batidos.length === 0, 'un tiempo más lento que la mejor marca NO genera récord');
assert(!r.defs, 'sin cambios en defs si la prueba ya existía');
r = comprobarRecords(perfilConBest, { ...w10k, duracion: 2800 }); // ≈ 2745 s → más rápido
assert(r.batidos.some((b) => b.defId === 'd1' && b.titulo === '10K'), 'un tiempo más rápido SÍ genera récord');
assert(r.batidos.some((b) => b.defId === 'd1' && b.primera === false), 'récord sobre marca existente → primera:false ("has batido tu marca")');

console.log('— Resultados manuales sin marcasBest (app) no provocan falsos récords —');
// El usuario añadió a mano 1500 m = 5:00 (300 s) en la app; marcasBest no
// existe porque la app no lo mantiene. Un rodaje a 5:00/km daría 1500 ≈ 450 s
// (PEOR que 300 s): no debe anunciarse como récord.
const perfilManual = {
  marcasDefs: [{ id: 'd1', actividad: 'Running', titulo: '1500 m', tipo: 'dist', distM: 1500 }],
  marcasResults: { d1: [{ id: 'r1', valor: 300, fecha: '2026-02-01T00:00:00Z' }] },
};
// Rodaje de 10 km a 5:00/km → 1500 m extrapolado ≈ 450 s, PEOR que los
// 300 s añadidos a mano. Sin marcasBest, el servidor antiguo lo habría
// anunciado como récord; ahora se compara contra el mejor resultado guardado.
r = comprobarRecords(perfilManual, { id: 'x', tipo: 'Running', distancia: 10, duracion: 3000, fecha, titulo: 'Rodaje' });
assert(!r.batidos.some((b) => b.defId === 'd1'), 'la mejor marca manual en marcasResults evita el falso récord');

console.log('— Robustez —');
r = comprobarRecords(null, w10k);
assert(Array.isArray(r.batidos) && r.batidos.length >= 1, 'perfil null: no rompe y calcula récords con defs automáticas');
r = comprobarRecords(perfilConBest, { ...w10k, tipo: 'Ciclismo' });
assert(!r.batidos.some((b) => b.defId === 'd1'), 'otra actividad no bate las pruebas de Running');
r = comprobarRecords(perfilConBest, { id: 'y', tipo: 'Running', distancia: 0, duracion: 3000, fecha });
assert(r.batidos.length === 0 && !r.defs, 'entreno sin distancia → sin récords ni defs');

console.log('— Distancias de sprint: 200 m, 400 m y Milla —');
// 210 m a tope en 36 s: el entreno ES la propia prueba de 200 m, así que el
// tiempo real (< 60 s) vale. Antes el guard t<=60 lo bloqueaba SIEMPRE y la
// marca de 200 m jamás se habría registrado.
r = comprobarRecords({ marcasDefs: [], marcasResults: {} }, { id: 's1', tipo: 'Running', distancia: 0.21, duracion: 36, fecha, titulo: 'Series 200' });
assert(!!(r.defs || []).find((d) => d.titulo === '200 m'), 'un entreno de 210 m auto-crea la prueba de 200 m (la más larga cubierta)');
const b200 = r.batidos.find((b) => b.titulo === '200 m');
assert(!!b200 && b200.valor === Math.round(36 * (0.2 / 0.21)), 'récord de 200 m con tiempo real < 60 s (34 s)');
assert(!!b200 && b200.primera === true, 'la marca de 200 m nace como primer récord (primera:true)');

// 420 m en 70 s: auto-crea 400 m (la más larga cubierta) y registra 67 s.
r = comprobarRecords({ marcasDefs: [], marcasResults: {} }, { id: 's2', tipo: 'Running', distancia: 0.42, duracion: 70, fecha, titulo: 'Series 400' });
assert(!!(r.defs || []).find((d) => d.titulo === '400 m'), 'un entreno de 420 m auto-crea la prueba de 400 m');
const b400 = r.batidos.find((b) => b.titulo === '400 m');
assert(!!b400 && b400.valor === Math.round(70 * (0.4 / 0.42)), 'récord de 400 m extrapolado del propio entreno (67 s)');

// 1.7 km en 6:30: cubre 200/400/800/1500/Milla → solo la Milla (la más larga).
r = comprobarRecords({ marcasDefs: [], marcasResults: {} }, { id: 's3', tipo: 'Running', distancia: 1.7, duracion: 390, fecha, titulo: 'Milla en pista' });
assert(!!(r.defs || []).find((d) => d.titulo === 'Milla'), 'un entreno de 1.7 km auto-crea la prueba de Milla');
assert(!!r.batidos.find((b) => b.titulo === 'Milla') && r.batidos.find((b) => b.titulo === 'Milla').valor === Math.round(390 * (1.609344 / 1.7)),
  'récord de Milla extrapolado del ritmo medio (369 s ≈ 6:09)');
assert(!r.batidos.some((b) => ['200 m', '400 m', '800 m', '1500 m'].includes(b.titulo)),
  'las distancias menores cubiertas NO se auto-crean ni registran (solo la más larga)');

// Un rodaje largo NO puede "batir" los 200 m con el ritmo medio extrapolado:
// fuera de la propia prueba sigue el guard de 60 s (3000 s → 200 m ≈ 59 s).
const perfil200 = {
  marcasDefs: [{ id: 'd200', actividad: 'Running', titulo: '200 m', tipo: 'dist', distM: 200 }],
  marcasResults: {},
};
r = comprobarRecords(perfil200, w10k);
assert(!r.batidos.some((b) => b.defId === 'd200'), 'un rodaje de 10 km NO registra 200 m extrapolados (guard de 60 s fuera de la prueba)');

console.log('— Paridad de catálogo app ↔ servidor —');
const fs = require('fs');
const srcMarcas = fs.readFileSync(path.join(__dirname, '..', 'screens', 'MarcasScreen.js'), 'utf8');
const srcRecords = fs.readFileSync(path.join(require('./server-ruta')(), 'lib', 'records.js'), 'utf8');
const catalogo = (src, re) => (src.match(re) || []).map((s) => s.replace(/\s+/g, ' ').trim()).sort();
const catApp = catalogo(srcMarcas, /\{ id: 'tp_[a-z0-9]+',\s+titulo: '[^']+',\s+distM: [0-9.]+ \}/g);
const catSrv = catalogo(srcRecords, /\{ id: 'tp_[a-z0-9]+', titulo: '[^']+', distM: [0-9.]+ \}/g);
assert(catApp.length === 11 && catSrv.length === 11, 'los dos catálogos tienen las 11 distancias clásicas');
assert(catApp.length === catSrv.length && catApp.every((s, i) => s === catSrv[i]), 'las distancias clásicas son idénticas en la app y en el servidor (ids, títulos y metros)');

console.log(`\n${fallos.length ? 'FALLOS: ' + fallos.length : 'TODO OK'} — ${pasadas} aserciones pasadas`);
process.exit(fallos.length ? 1 : 0);
