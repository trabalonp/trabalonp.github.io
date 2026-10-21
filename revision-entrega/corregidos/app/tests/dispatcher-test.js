// tests/dispatcher-test.js — prueba local del dispatcher api/[...path].js
// Simula el runtime Node de Vercel (req stream + res estilo Express) y
// recorre las rutas SIN tocar red ni Firebase real:
//  - rutas desconocidas → 404
//  - método incorrecto → 405 (como antes)
//  - auth ausente/inválida → 401 propagado por el dispatcher
//  - purge con/sin CRON_SECRET → 401 / 200 disabled
//  - cuerpo JSON vacío, inválido y válido → null / 400 / parseado
//  - SSRF (localhost) en link-preview → 400 "URL no permitida"
//  - req.query.path (array y string) y fallback por req.url
//  - notify-message (B4): respuesta { ok, enviados } SIN uids, lectura de
//    perfiles con .select() y sendPushToUser con perfilPrecargado
//    (runtime con Firestore stub en memoria + source-checks)
//
// Ejecutar:  node tests/dispatcher-test.js
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
const { Readable } = require('stream');

// firebase-admin necesita la variable al inicializar; se genera una clave RSA
// real (dummy, solo local) porque el SDK valida el PEM al arrancar.
// verifyIdToken nunca llega a usarla: el test la stubea más abajo.
const { generateKeyPairSync } = require('crypto');
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test-local',
  private_key_id: 'x',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'test@test-local.iam.gserviceaccount.com',
  client_id: '1',
  token_uri: 'https://oauth2.example.com/token',
});
delete process.env.CRON_SECRET;
delete process.env.RETENTION_DAYS;
for (const v of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','R2_PUBLIC_URL','R2_ENDPOINT','R2_REGION']) delete process.env[v];

const SRV = require('./server-ruta')();

// Stubs SIN red: verifyIdToken no llega a Google y Firestore no abre gRPC.
// (El namespace de firebase-admin expone getters: hay que redefinirlos.)
const admin = require(path.join(SRV, 'lib', 'firebase.js'));
Object.defineProperty(admin, 'auth', {
  configurable: true,
  value: () => ({ verifyIdToken: async (t) => (String(t).length ? { uid: 'test-uid' } : null) }),
});
const falloDb = Object.assign(new Error('db no disponible en test local'), { status: 500 });
Object.defineProperty(admin, 'firestore', {
  configurable: true,
  value: Object.assign(
    () => ({ collection: () => ({ doc: () => ({ get: async () => { throw falloDb; } }) }) }),
    { Timestamp: admin.firestore.Timestamp }
  ),
});

const dispatcher = require(path.join(SRV, 'api', '[...path].js'));

let pasadas = 0;
const fallos = [];
function assert(cond, msg) {
  if (cond) { pasadas++; } else { fallos.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`); }

function fakeReq({ method = 'GET', url = '/', headers = {}, body, query }) {
  const buf = body === undefined ? null
    : (typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body)));
  const req = Readable.from(buf ? [buf] : []);
  req.method = method;
  req.url = url;
  const base = { 'content-type': buf ? 'application/json' : 'text/plain' };
  for (const k of Object.keys(headers)) { base[k.toLowerCase()] = headers[k]; }
  req.headers = base;
  if (query !== undefined) req.query = query;
  return req;
}

function fakeRes() {
  const r = {
    statusCode: 200,
    finished: false,
    _headers: {},
    chunks: [],
    setHeader(k, v) { r._headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return r._headers[String(k).toLowerCase()]; },
    end(d) { r.finished = true; if (d !== undefined) r.chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); return r; },
  };
  return r;
}

async function call(opts) {
  const res = fakeRes();
  await dispatcher(fakeReq(opts), res);
  const raw = Buffer.concat(res.chunks).toString('utf8');
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { /* no-JSON */ }
  return { status: res.statusCode, json, raw };
}

(async () => {
  console.log('— Ruteo —');
  let r = await call({ url: '/api/no-existe', query: { path: ['no-existe'] } });
  eq(r.status, 404, 'ruta desconocida → 404');
  eq(r.json && r.json.error, 'Ruta no encontrada', 'mensaje 404');

  r = await call({ url: '/api/intervals/status', query: { path: 'intervals/status' } });
  eq(r.status, 401, 'intervals/status sin auth → 401 (mapea error.status, como en Vercel)');

  console.log('— Fallback por req.url (sin req.query) —');
  r = await call({ url: '/api/social/presign?x=1' });
  eq(r.status, 405, 'presign por GET (fallback URL) → 405');
  r = await call({ url: '/api/social/purge/' });
  eq(r.status, 401, 'purge sin CRON_SECRET → 401 (fallback URL con barra final)');

  console.log('— Métodos —');
  for (const ruta of ['social/link-preview', 'social/delete-message', 'social/notify-message',
    'notify-athlete', 'sync-fitness',
    'sync-intervals', 'sync-intervals-detail', 'upload-to-intervals', 'intervals/delete-event',
    'intervals/disconnect', 'intervals/save-credentials']) {
    r = await call({ url: '/api/' + ruta, query: { path: ruta.split('/') } });
    eq(r.status, 405, `GET /api/${ruta} → 405`);
  }

  console.log('— Auth —');
  r = await call({ url: '/api/social/link-preview', method: 'POST', query: { path: ['social', 'link-preview'] }, body: { url: 'https://example.com' } });
  eq(r.status, 200, 'link-preview sin token → 200 (nunca bloquea el chat)');
  eq(r.json && r.json.ok, true, 'link-preview ok:true');
  eq(r.json && r.json.preview, null, 'link-preview preview:null');
  assert(/No autorizado/.test((r.json && r.json.error) || ''), 'link-preview propaga "No autorizado" del handler');

  r = await call({ url: '/api/social/presign', method: 'POST', query: { path: ['social', 'presign'] }, body: { filename: 'a.jpg' }, headers: { authorization: 'Bearer ' } });
  eq(r.status, 500, 'presign con token vacío → 500 (su catch no mapea error.status; igual que en Vercel)');
  eq(r.json && r.json.error, 'No autorizado', 'mensaje de auth propagado por presign');

  console.log('— Purge (cron) —');
  r = await call({ url: '/api/social/purge', query: { path: ['social', 'purge'] }, headers: { authorization: 'Bearer SECRETO-MALO' } });
  eq(r.status, 401, 'purge con secreto incorrecto → 401');
  process.env.CRON_SECRET = 'SECRETO-TEST';
  r = await call({ url: '/api/social/purge', query: { path: ['social', 'purge'] }, headers: { authorization: 'Bearer SECRETO-TEST' } });
  eq(r.status, 200, 'purge con secreto correcto → 200');
  eq(r.json && r.json.disabled, true, 'purge desactivado sin RETENTION_DAYS');
  delete process.env.CRON_SECRET;

  console.log('— Cuerpo JSON —');
  r = await call({ url: '/api/social/presign', method: 'POST', query: { path: ['social', 'presign'] }, headers: { authorization: 'Bearer x' } });
  eq(r.status, 400, 'POST sin cuerpo (auth OK) → req.body null y presign responde 400 "Falta filename"');
  eq(r.json && r.json.error, 'Falta filename', 'sin cuerpo no rompe el parseo');
  r = await call({ url: '/api/social/presign', method: 'POST', query: { path: ['social', 'presign'] } });
  eq(r.status, 500, 'POST sin token → auth primero (catch de presign no mapea status; igual que en Vercel)');
  eq(r.json && r.json.error, 'No autorizado', 'mensaje de auth propagado por presign');
  r = await call({ url: '/api/social/presign', method: 'POST', query: { path: ['social', 'presign'] }, body: { filename: 'a.jpg' }, headers: { authorization: 'Bearer ' } });
  eq(r.status, 500, 'token vacío → 500 "No autorizado"');
  eq(r.json && r.json.error, 'No autorizado', 'token vacío propagado');
  r = await call({ url: '/api/social/presign', method: 'POST', query: { path: ['social', 'presign'] }, body: '{roto', headers: { 'content-type': 'application/json', authorization: 'Bearer x' } });
  eq(r.status, 400, 'JSON inválido → 400 del dispatcher');
  assert(/JSON no válido/.test((r.json && r.json.error) || ''), 'mensaje de JSON inválido');
  r = await call({ url: '/api/social/link-preview', method: 'POST', query: { path: ['social', 'link-preview'] }, body: { url: 'http://localhost:3000/x' }, headers: { authorization: 'Bearer x' } });
  eq(r.status, 400, 'link-preview con localhost → 400 (SSRF bloqueado; auth stubbed)');
  eq(r.json && r.json.error, 'URL no permitida', 'mensaje SSRF');

  console.log('— intervals/status con token no vacío —');
  r = await call({ url: '/api/intervals/status', query: { path: ['intervals', 'status'] }, headers: { authorization: 'Bearer x' } });
  eq(r.status, 500, 'status con DB stub que falla → 500 (contrato error.status)');
  assert(/db no disponible/.test((r.json && r.json.error) || ''), 'status propaga el error del handler');

  console.log('— archivos (librería de archivos R2) —');
  r = await call({ url: '/api/archivos/presign', method: 'POST', query: { path: ['archivos', 'presign'] }, body: { filename: 'a.pdf' }, headers: { authorization: 'Bearer ' } });
  eq(r.status, 401, 'archivos/presign con token vacío → 401 (su catch SÍ mapea error.status)');
  r = await call({ url: '/api/archivos/config', query: { path: ['archivos', 'config'] } });
  eq(r.status, 503, 'archivos/config sin R2_PUBLIC_URL → 503');

  console.log('— notify-message (push del chat con la app cerrada) —');
  r = await call({ url: '/api/social/notify-message', method: 'POST', query: { path: ['social', 'notify-message'] }, body: { texto: 'hola' } });
  eq(r.status, 401, 'notify-message sin token → 401 (su catch SÍ mapea error.status)');
  eq(r.json && r.json.error, 'No autorizado', 'notify-message propaga "No autorizado"');

  console.log('— notify-message: contrato nuevo (respuesta sin uids + perfilPrecargado) —');
  // Stub SCOPED de Firestore solo para esta llamada (sin red ni Firebase
  // real). perfiles/{uid} solo responde al REMITENTE: si sendPushToUser
  // volviera a leer el perfil de un destino (regresión), el stub lanza y el
  // contador de lecturas lo detecta.
  const perfilesB4 = {
    'test-uid': { nombre: 'Remitente Prueba', notificacionesActivadas: true },
    'u-sin-token': { notificacionesActivadas: true },                                          // historial sí, push no
    'u-con-token': { notificacionesActivadas: true, expoPushToken: 'ExponentPushToken[test]' },
    'u-off': { notificacionesActivadas: false },                                               // opt-out
  };
  const lecturasDoc = [];
  const historiales = [];
  let llamadasExpo = 0;
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async () => { llamadasExpo++; return { ok: true, text: async () => '{"data":{"status":"ok"}}' }; };
  const firestoreReal = admin.firestore;
  Object.defineProperty(admin, 'firestore', {
    configurable: true,
    value: Object.assign(
      () => ({
        collection: (nombre) => {
          if (nombre !== 'perfiles') throw falloDb;
          return {
            select: () => ({
              get: async () => ({
                forEach: (cb) => Object.keys(perfilesB4).forEach((id) => cb({ id, data: () => perfilesB4[id] })),
              }),
            }),
            doc: (id) => ({
              get: async () => {
                lecturasDoc.push(id);
                if (id === 'test-uid') return { exists: true, data: () => perfilesB4[id] };
                throw falloDb;   // los destinos NO deben releerse (perfilPrecargado)
              },
              collection: () => ({
                where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) }),
                add: async () => { historiales.push(id); return { id: 'notif-b4' }; },
              }),
            }),
          };
        },
      }),
      { FieldValue: { serverTimestamp: () => null, delete: () => null }, Timestamp: { now: () => new Date() } }
    ),
  });
  // notify-message y lib/push.js quedaron cacheados con el stub que falla:
  // se recargan para que tomen ESTE Firestore en memoria.
  delete require.cache[require.resolve(path.join(SRV, 'handlers', 'social', 'notify-message.js'))];
  delete require.cache[require.resolve(path.join(SRV, 'lib', 'push.js'))];
  r = await call({ url: '/api/social/notify-message', method: 'POST', query: { path: ['social', 'notify-message'] }, body: { texto: 'hola', messageId: 'm1' }, headers: { authorization: 'Bearer t' } });
  Object.defineProperty(admin, 'firestore', { configurable: true, value: firestoreReal });
  globalThis.fetch = fetchReal;
  eq(r.status, 200, 'notify-message con auth → 200');
  eq(r.json && r.json.ok, true, 'ok:true');
  eq(r.json && r.json.enviados, 3, 'enviados = 3 (perfiles menos el remitente)');
  eq(r.json && r.json.destinos, undefined, 'la respuesta YA NO incluye destinos');
  eq(r.json && r.json.entrenador, undefined, 'la respuesta YA NO incluye entrenador');
  eq(Object.keys(r.json || {}).sort().join(','), 'enviados,ok', 'respuesta con SOLO { ok, enviados }');
  eq(lecturasDoc.join(','), 'test-uid', 'solo se lee perfiles/{remitente}: sendPushToUser usa perfilPrecargado (0 relecturas)');
  eq(historiales.join(','), 'u-sin-token,u-con-token', 'historial SIEMPRE salvo opt-out (u-off se salta)');
  eq(llamadasExpo, 1, '1 solo push a Expo (u-con-token; sin token → no push)');

  console.log('— notify-message/push: source-check del contrato nuevo —');
  const nmSrc = require('fs').readFileSync(path.join(SRV, 'handlers', 'social', 'notify-message.js'), 'utf8');
  assert(nmSrc.includes(".select('notificacionesActivadas', 'expoPushToken')"), 'perfiles se lee con PROYECCIÓN (.select), no el doc entero');
  assert(nmSrc.includes('perfilPrecargado'), 'notify-message pasa perfilPrecargado a sendPushToUser');
  assert(nmSrc.includes('res.json({ ok: true, enviados: destinos.length })'), 'respuesta { ok, enviados } (uids fuera)');
  assert(!/enviados: destinos\.length,\s*entrenador,\s*destinos/.test(nmSrc), 'entrenador y destinos YA NO van en la respuesta');
  assert(nmSrc.includes('destinos=${destinos.length}'), 'console.log CONSERVA destinos para trazabilidad');
  const pushSrc = require('fs').readFileSync(path.join(SRV, 'lib', 'push.js'), 'utf8');
  assert(/async function sendPushToUser\(userId, title, body, data, perfilPrecargado\)/.test(pushSrc), 'sendPushToUser acepta perfilPrecargado');
  assert(pushSrc.includes('let profile = perfilPrecargado'), 'con precarga NO relee perfiles/{uid}');
  assert(pushSrc.includes("await db.collection('perfiles').doc(userId).get()"), 'sin precarga, el comportamiento por defecto intacto');
  assert(pushSrc.includes('guardarNotificacion(userId, title, body, data, profile)'), 'el historial se guarda SIEMPRE vía guardarNotificacion');
  assert(pushSrc.includes('dedupeKey'), 'dedupeKey (anti-duplicados) intacto');
  assert(pushSrc.includes('profile.notificacionesActivadas === false'), 'opt-out (notificacionesActivadas === false) intacto');

  console.log('— presign con auth correcta (sin R2 configurado) —');
  r = await call({ url: '/api/social/presign', method: 'POST', query: { path: ['social', 'presign'] }, body: { filename: 'foto.jpg', size: 1000 }, headers: { authorization: 'Bearer x' } });
  eq(r.status, 503, 'presign sin variables R2 → 503');
  assert(/R2/.test((r.json && r.json.error) || ''), 'mensaje R2 del presign');

  console.log('— Regressiones del deploy roto (ronda 2): bundle trazable + routing —');
  const fs = require('fs');
  const srcDisp = fs.readFileSync(path.join(SRV, 'api', '[...path].js'), 'utf8');
  const thunks = (srcDisp.match(/\(\) => require\('\.\.\/handlers\//g) || []).length;
  // Antes se exigían exactamente 17. Ahora que el dispatcher puede crecer
  // (/api/curvas/backfill), la condición que importa es que TODAS las entradas
  // sean requires literales (si no, nft no empaqueta handlers/ y todo da 500).
  assert(thunks >= 17, `todos los requires son LITERALES (nft los traza y empaqueta handlers/): ${thunks} rutas`);
  assert(
    thunks === (srcDisp.slice(srcDisp.indexOf('const RUTAS')).match(/^\s+'[^']+':\s*\(\) =>/gm) || []).length,
    'no hay ninguna ruta sin su require literal'
  );
  const codigo = srcDisp.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert(!/require\((?!')/.test(codigo.replace(/require\('\.\.\/handlers\//g, '')), 'ningún require dinámico con variable (invisible para el trazador)');
  const vercelJson = JSON.parse(fs.readFileSync(path.join(SRV, 'vercel.json'), 'utf8'));
  assert(Array.isArray(vercelJson.rewrites) && vercelJson.rewrites.length === 1, 'vercel.json con 1 rewrite');
  eq(vercelJson.rewrites[0].source, '/api/:path*', 'source del rewrite: /api/:path*');
  eq(vercelJson.rewrites[0].destination, '/api/[...path]?path=:path*', 'destination del rewrite (sin él, Vercel solo empareja 1 segmento y /api/social/presign da 404 de plataforma)');

  console.log(`\n${fallos.length ? 'FALLOS: ' + fallos.length : 'TODO OK'} — ${pasadas} aserciones pasadas`);
  process.exit(fallos.length ? 1 : 0);
})().catch((e) => { console.error('ERROR FATAL', e); process.exit(2); });
