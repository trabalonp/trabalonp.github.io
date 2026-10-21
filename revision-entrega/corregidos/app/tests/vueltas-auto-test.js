// tests/vueltas-auto-test.js — Vueltas automáticas de 1 km: rodajes sin
// vueltas (o con la vuelta global) se trocean por kilómetro desde los
// registros (distancia acumulada + tiempos), con tiempo ELAPSED por vuelta
// (coincide con la duración del entreno), FC, cadencia y desnivel; la
// última queda con lo que quede.
// Ejecutar:  node tests/vueltas-auto-test.js
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
const { generateKeyPairSync } = require('crypto');

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

process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test-local',
  private_key_id: 'x',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'test@test-local.iam.gserviceaccount.com',
  client_id: '1',
  token_uri: 'https://oauth2.example.com/token',
});

const { vueltasAutoPorKm } = require(path.join(require('./server-ruta')(), 'lib', 'intervalsDetail.js'));

// Rodaje sintético: 5.5 km, una muestra cada 0.1 km / 30 s (ritmo 5:00/km),
// FC 150 constante, cadencia 170, subiendo 20 m por km.
function rodaje(kmTot, { pausaEnLap = -1 } = {}) {
  const pts = [];
  const n = Math.round(kmTot * 10);
  let extra = 0;                          // una pausa desplaza TODO lo posterior
  for (let i = 0; i <= n; i++) {
    const dist = Number((i * 0.1).toFixed(2));
    if (pausaEnLap === Math.floor(dist) && i % 10 === 5) extra += 300;   // para 5 min
    const t = i * 30 + extra;
    pts.push({
      timestamp: new Date(new Date('2026-10-01T08:00:00Z').getTime() + t * 1000).toISOString(),
      distancia: dist,
      altitud: Number((dist * 20).toFixed(1)),   // 20 m de subida por km
      frecuencia: 150,
      cadencia: 170,
      velocidad: 12,                              // 12 km/h = 5:00/km
      lat: null, lon: null,
    });
  }
  return pts;
}

(async () => {
  console.log('— 1) Rodaje de 5.5 km sin vueltas → 6 vueltas automáticas —');
  {
    const v = vueltasAutoPorKm(rodaje(5.5), true, false);
    ok(Array.isArray(v) && v.length === 6, '5 vueltas de 1 km + la última con lo que queda');
    eq(v[0].vuelta, 1, 'numeración desde 1');
    eq(v[0].distancia, 1.0, 'la primera vuelta mide 1 km');
    eq(v[4].distancia, 1.0, 'la quinta vuelta mide 1 km');
    eq(v[5].distancia, 0.5, 'la última queda con lo que quede (0.5 km)');
    eq(v[0].tiempo, 300, 'tiempo de la vuelta: 300 s (5:00/km, huecos ≤ 30 s)');
    eq(v[0].ritmo, '05:00', 'ritmo medio 5:00/km');
    eq(v[0].fcMedia, 150, 'FC media de la vuelta');
    eq(v[0].fcMaxima, 150, 'FC máxima de la vuelta');
    eq(v[0].cadenciaMedia, 170, 'cadencia media de la vuelta');
    eq(v[0].gananciaElev, 20, 'desnivel positivo por vuelta (20 m/km)');
    ok(v[0].inicio.includes('2026-10-01T08:00'), 'inicio de la vuelta = timestamp del primer registro');
  }

  console.log('— 2) Pausa dentro de una vuelta: no suma tiempo —');
  {
    // 5 min de parada dentro de la 2ª vuelta: tiempo ELAPSED, la vuelta
    // marca 600 s de reloj (coincide con la duración que guarda el sync).
    const v = vueltasAutoPorKm(rodaje(3.2, { pausaEnLap: 1 }), true, false);
    ok(Array.isArray(v) && v.length === 4, '3.2 km → 4 vueltas');
    eq(v[1].tiempo, 600, 'la vuelta con la pausa cuenta 600 s de reloj (elapsed)');
    eq(v[0].tiempo, 300, 'las demás vueltas mantienen sus 300 s');
    eq(v[2].tiempo, 300, 'las vueltas tras la pausa también (el desplazamiento no contamina)');
  }

  console.log('— 3) Casos que NO se trocean —');
  eq(vueltasAutoPorKm(rodaje(0.8), true, false), null, 'menos de 1 km → null (se queda como estaba)');
  eq(vueltasAutoPorKm([{ timestamp: '2026-10-01T08:00:00Z', distancia: 0, frecuencia: 0 }], true, false), null, 'registros insuficientes → null');
  eq(vueltasAutoPorKm([{ timestamp: '2026-10-01T08:00:00Z', frecuencia: 0 }, { timestamp: '2026-10-01T08:00:30Z', frecuencia: 0 }], true, false), null, 'sin distancia (fuerza) → null');

  console.log('— 4) Natación/gimnasio: sin GPS pero con distancia funciona —');
  {
    const pts = [];
    for (let i = 0; i <= 25; i++) {
      pts.push({
        timestamp: new Date(new Date('2026-10-01T08:00:00Z').getTime() + i * 60 * 1000).toISOString(),
        distancia: Number((i * 0.1).toFixed(2)),
        altitud: 0, frecuencia: 140, cadencia: 60, velocidad: 6, lat: null, lon: null,
      });
    }
    const v = vueltasAutoPorKm(pts, false, false);
    eq(v && v.length, 3, '2.5 km sin GPS → 3 vueltas (1 + 1 + 0.5)');
    eq(v[0].ritmo, '10:00', 'ritmo por vuelta (1 km en 600 s)');
  }

  console.log('');
  console.log(`VUELTAS AUTO 1KM: ${pasadas} comprobaciones OK, ${fallos.length} fallos`);
  if (fallos.length) { fallos.forEach((f) => console.log('  FALLO: ' + f)); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL', e); process.exit(2); });
