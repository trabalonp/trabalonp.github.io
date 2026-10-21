/* tests/duracion-pausas-test.js — REGRESIÓN: duración de un entreno sin el
   tiempo pausado (mismo criterio que TrainerPlan / cronómetro del reloj).

   Problema que se corrige:
     · La tarjeta (Home/Calendario) mostraba Σ de vueltas, pero el apartado
       General y el campo Medida del detalle mostraban la duración GUARDADA,
       que podía llegar inflada con el tiempo que el reloj estuvo parado.
     · En el sync de intervals.icu las vueltas se mapeaban con elapsed_time
       (pausas incluidas) y la duración inicial del doc era elapsed_time.

   Regla: duración = Σ de vueltas en tiempo SIN PAUSAS (moving/timer), igual
   en tarjeta, Vueltas, General y Medida. Una duración editada a mano en la
   app se respeta (duracionManual).

   Uso: node tests/duracion-pausas-test.js */
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

const APP = path.join(__dirname, '..');
const SRV = require('./server-ruta')();
const leer = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

console.log('— 1) Server: vueltas y duración SIN pausas —');
const srcDet = fs.readFileSync(path.join(SRV, 'lib', 'intervalsDetail.js'), 'utf8');
ok(/lap\.movingTime \?\? lap\.moving_time \?\? lap\.totalTimerTime \?\? lap\.elapsedTime/.test(srcDet), 'mapLap: moving/timer antes que elapsed (las pausas ya no inflan las vueltas)');
ok(/mData\.duracionManual !== true && Math\.abs\(\(Number\(mData\.duracion\) \|\| 0\) - sumaVueltas\) > 5/.test(srcDet), 'fetchAndStoreDetail: realinea la duración con Σ vueltas al guardar el detalle (respeta duracionManual)');

const srcSync = fs.readFileSync(path.join(SRV, 'handlers', 'sync-intervals.js'), 'utf8');
ok(/activity\.moving_time \?\? activity\.elapsed_time \?\? activity\.duration/.test(srcSync), 'duración inicial del doc = moving_time (sin pausas), no elapsed');
ok(/mainBf\.duracionManual !== true/.test(srcSync), 'el pase de reparación no pisa duraciones manuales');

console.log('— 2) App: mismo número en tarjeta, Vueltas, General y Medida —');
const srcWdm = leer('screens/WorkoutDetailModal.js');
ok(/const alinearDuracionConVueltas = \(vs\) =>/.test(srcWdm), 'WorkoutDetailModal tiene el alineador Σ vueltas');
ok(/workout\?\.duracionManual !== true && Math\.abs\(\(Number\(workout\.duracion\) \|\| 0\) - suma\) > 5/.test(srcWdm), 'alinea la duración mostrada con Σ vueltas si no es manual');
ok(/duracionManual: durManual,/.test(srcWdm), 'al guardar la sesión se marca duracionManual si difiere de Σ vueltas');
ok(/setVueltas\(d2\.vueltas \?\? \[\]\); alinearDuracionConVueltas\(d2\.vueltas\)/.test(srcWdm), 'el detalle bajo demanda también alinea');

const srcHome = leer('screens/HomeScreen.js');
ok(/if\(suma>0 && !lote\[k\]\.duracionManual\) lote\[k\]\.duracion=suma/.test(srcHome), 'Home: la tarjeta respeta duracionManual');
const srcCal = leer('screens/CalendarScreen.js');
ok(/if \(suma > 0 && !lote\[k\]\.duracionManual\) lote\[k\]\.duracion = suma/.test(srcCal), 'Calendario: la tarjeta respeta duracionManual');

console.log('');
if (fallos.length) {
  console.log(`✗ ${fallos.length} comprobación(es) fallida(s)`);
  fallos.forEach((f) => console.log(' · ' + f));
  process.exit(1);
}
console.log(`${pasadas} comprobaciones OK`);
console.log('✅ duracion-pausas-test: TODO VERDE');
