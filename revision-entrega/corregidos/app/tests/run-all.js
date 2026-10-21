/* tests/run-all.js — ejecuta toda la batería de la app (revisión 2026-10-21).
   Uso:  npm test        (o: node tests/run-all.js)
         node tests/run-all.js --verbose    muestra la salida completa de cada test

   Reglas:
     · Recorre tests/*.js ignorando los helpers (_*.js, server-ruta.js, run-all.js).
     · Cada test que necesite el servidor y no lo encuentre imprime SKIP y sale
       con 0 (los propios tests llevan el guard), así que la batería nunca se
       rompe por tener el backend en otro sitio.
     · tests/rules/ NO se incluye: necesita el emulador de Firestore
       (npm run test:rules).
     · Código de salida 1 si algún test falla. */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose');
const IGNORAR = new Set(['server-ruta.js', 'run-all.js']);

const ficheros = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => !f.startsWith('_'))
  .filter((f) => !IGNORAR.has(f))
  .sort();

const resultados = [];
let fallos = 0;

for (const f of ficheros) {
  const ruta = path.join(__dirname, f);
  const r = spawnSync(process.execPath, [ruta], { encoding: 'utf8', timeout: 300000 });
  const salida = `${r.stdout || ''}${r.stderr || ''}`;
  const skip = /^SKIP/m.test(salida.trim().split('\n').pop() || '') || /^SKIP/m.test(salida);
  const estado = r.status === 0 ? (skip ? 'SKIP' : 'PASS') : 'FAIL';

  if (estado === 'FAIL') fallos++;

  resultados.push({ fichero: f, estado, resumen: (salida.match(/(\d+) comprobaciones OK|(\d+) aserciones pasadas|TODO OK|PASS|FALLOS: \d+/) || [''])[0] });

  if (VERBOSE || estado === 'FAIL') {
    console.log(`\n──────── ${f} ────────\n${salida.trim()}\n`);
  } else {
    console.log(`${estado.padEnd(4)} ${f}`);
  }
}

console.log('\n──────────────────────────────────────────────');
console.log(`Resumen: ${resultados.filter((x) => x.estado === 'PASS').length} OK · ${resultados.filter((x) => x.estado === 'SKIP').length} SKIP · ${fallos} FALLOS`);
console.log('(las reglas de Firestore se prueban aparte: npm run test:rules, con el emulador arrancado)');

process.exit(fallos ? 1 : 0);
