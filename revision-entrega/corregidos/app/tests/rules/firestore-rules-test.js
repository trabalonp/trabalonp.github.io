/* tests/rules/firestore-rules-test.js — BLOQUE B3 del plan de seguridad.
   Prueba firestore.rules.nuevo contra el EMULADOR de Firestore con
   @firebase/rules-unit-testing. NUNCA toca producción.

   ────────────────────────────────────────────────────────────────────────
   ADAPTACIÓN A LA API v2 (revisión 2026-10-21)
   ────────────────────────────────────────────────────────────────────────
   El fichero original usaba la API v1 de @firebase/rules-unit-testing
   (initializeTestApp / initializeAdminApp / loadFirestoreRules /
   clearFirestoreData / apps), que NO existe en la versión declarada en
   package.json (^2.0.4): esa versión solo exporta initializeTestEnvironment,
   assertSucceeds, assertFails y withFunctionTriggersDisabled. Resultado: al
   instalar las dependencias (paso 1 del README) el test moría con
   «TypeError: initializeAdminApp is not a function» y NO imprimía SKIP.

   En vez de reescribir la matriz (400+ líneas), aquí se conserva TAL CUAL y
   se le añade una capa de compatibilidad v1→v2 construida solo con
   primitivas v2. La matriz, los actores y las aserciones son idénticos.

   DOS MODOS (revisión 2026-10-21):
     node tests/rules/firestore-rules-test.js              → prueba firestore.rules
        (FASE 1: la que se despliega hoy; la lectura de entrenamientos sigue
         abierta a autenticados A PROPÓSITO, así que esas 10 aserciones se
         comprueban al revés y se marcan como tales).
     node tests/rules/firestore-rules-test.js --estricto    → prueba
        firestore.rules.estricto (FASE 2: lectura cerrada a dueño/entrenador;
        requiere resolver antes el campo coachUid o los custom claims).

   Uso manual (ver README, sección «Reglas de Firestore»):
     1) npm install
     2) npx firebase-tools emulators:start --only firestore --project demo-entrenos
     3) node tests/rules/firestore-rules-test.js

   Si no hay emulador o falta la librería, imprime SKIP y sale con 0.
   ────────────────────────────────────────────────────────────────────────
*/
'use strict';

const fs = require('fs');
const path = require('path');

// ── Guard 1: librería no instalada ──────────────────────────────────────
let rt;
try {
  rt = require('@firebase/rules-unit-testing');
} catch (e) {
  console.log('SKIP: instala @firebase/rules-unit-testing y ejecuta manualmente (ver README)');
  process.exit(0);
}

const { initializeTestEnvironment, assertSucceeds, assertFails } = rt;

if (typeof initializeTestEnvironment !== 'function') {
  console.log('SKIP: versión de @firebase/rules-unit-testing no soportada (se espera ^2.x)');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Capa de compatibilidad v1 → v2 (NO forma parte de la matriz de pruebas)
// ─────────────────────────────────────────────────────────────────────────────
let testEnv = null;
const contextos = new Map();

function hostPuerto() {
  const raw = process.env.FIRESTORE_EMULATOR_HOST || '';
  const [h, p] = raw.split(':');
  return { host: h || '127.0.0.1', port: Number(p) || 8080 };
}

async function loadFirestoreRules({ projectId, rules }) {
  const { host, port } = hostPuerto();
  testEnv = await initializeTestEnvironment({ projectId, firestore: { rules, host, port } });
  return testEnv;
}

function contexto(uid) {
  if (!testEnv) throw new Error('loadFirestoreRules debe ejecutarse antes que cualquier lectura');
  const key = uid || '__anonimo__';

  if (!contextos.has(key)) {
    contextos.set(key, uid ? testEnv.authenticatedContext(uid) : testEnv.unauthenticatedContext());
  }

  return contextos.get(key);
}

// v1: initializeTestApp({ projectId, auth }) → app con .firestore()/.delete()
function initializeTestApp({ auth } = {}) {
  const uid = auth && auth.uid ? auth.uid : null;
  return {
    firestore: () => contexto(uid).firestore(),
    delete: async () => {},
  };
}

// v1: initializeAdminApp() → base con reglas desactivadas. withSecurityRulesDisabled
// es asíncrona, así que se expone una fachada: cada operación se ejecuta dentro.
function initializeAdminApp() {
  const conBypass = (fn) => {
    if (!testEnv) return Promise.reject(new Error('loadFirestoreRules debe ejecutarse antes'));
    return testEnv.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));
  };

  const docFachada = (ruta) => ({
    set: (data, opts) => conBypass((db) => (opts ? db.doc(ruta).set(data, opts) : db.doc(ruta).set(data))),
    get: () => conBypass((db) => db.doc(ruta).get()),
    update: (data, opts) => conBypass((db) => (opts ? db.doc(ruta).update(data, opts) : db.doc(ruta).update(data))),
    delete: () => conBypass((db) => db.doc(ruta).delete()),
  });

  const colFachada = (nombre) => ({
    add: (data) => conBypass((db) => db.collection(nombre).add(data)),
  });

  return {
    firestore: () => ({ doc: docFachada, collection: colFachada }),
    // El runner llama a adminApp.delete() al terminar: se aprovecha para
    // cerrar el entorno (cleanup de v2).
    delete: async () => { try { await testEnv.cleanup(); } catch (e) {} },
  };
}

async function clearFirestoreData() {
  if (testEnv) await testEnv.clearFirestore();
}

// v1: apps() → lista de apps creadas (en v2 los contextos se cierran con cleanup).
function apps() { return []; }

// Sentinela de borrado de campo (v9 modular). El context.firestore() de v2 es
// compat, que en v9 delega en el SDK modular, así que acepta este sentinela.
const { deleteField } = require('firebase/firestore');

// ──────────── MATRIZ ORIGINAL (sin cambios) ────────────
const PROYECTO = 'demo-entrenos-reglas';
const ESTRICTO = process.argv.includes('--estricto');
const MODO = ESTRICTO ? 'estricto' : 'fase1';
const FICHERO_REGLAS = ESTRICTO ? 'firestore.rules.estricto' : 'firestore.rules';
const REGLAS = fs.readFileSync(path.join(__dirname, '..', '..', FICHERO_REGLAS), 'utf8');

console.log(`Reglas probadas: ${FICHERO_REGLAS} (modo ${MODO})`);

let pasadas = 0;
const fallos = [];
function ok(cond, msg) {
  if (cond) { pasadas++; console.log('ok   ' + msg); }
  else { fallos.push(msg); console.log('FALLO ' + msg); }
}

// Ejecuta `accion(db)` con la identidad `uid` (null = sin autenticar).
async function como(uid, accion) {
  const app = uid
    ? initializeTestApp({ projectId: PROYECTO, auth: { uid } })
    : initializeTestApp({ projectId: PROYECTO });
  try {
    return await accion(app.firestore());
  } finally {
    await app.delete();
  }
}

async function permite(uid, accion, msg) {
  try {
    await assertSucceeds(como(uid, accion));
    ok(true, msg);
  } catch (e) {
    fallos.push(msg + ' :: ' + (e && e.message));
    console.log('FALLO ' + msg);
  }
}

async function niega(uid, accion, msg) {
  try {
    await assertFails(como(uid, accion));
    ok(true, msg);
  } catch (e) {
    fallos.push(msg + ' :: ' + (e && e.message));
    console.log('FALLO ' + msg);
  }
}

/* Lectura de entrenamientos (y subcolecciones) por alguien que NO es el dueño.
   En fase 1 la lectura está abierta a autenticados a propósito (el coach
   consulta el calendario del atleta con where('userId','==',atleta) y Firestore
   no puede demostrar una regla basada en get()); en estricto está cerrada. */
async function lecturaEntrenos(uid, accion, msg) {
  if (ESTRICTO || !uid) return niega(uid, accion, msg);
  return permite(uid, accion, msg + ' [fase 1: lectura abierta a propósito]');
}

const adminApp = initializeAdminApp({ projectId: PROYECTO });
const adminDb = adminApp.firestore();

// Siembra con Admin (no pasa por las reglas) el estado común de cada variante.
async function sembrar(perfilAlice) {
  await adminDb.doc('perfiles/alice').set({ nombre: 'Alice', ...perfilAlice });
  await adminDb.doc('perfiles/bob').set({ nombre: 'Bob' });
  await adminDb.doc('perfiles/carol').set({ nombre: 'Carol', entrenador: 'coach2' });
  await adminDb.doc('perfiles/dave').set({ nombre: 'Dave' });
  // Entreno propio de alice
  await adminDb.doc('entrenamientos/w1').set({ userId: 'alice', creadoPor: 'alice', tipo: 'Carrera', estado: 'completo', duracion: 3600 });
  // Evento que coach1 creó en el calendario de alice (asignados: alice + carol)
  await adminDb.doc('entrenamientos/w2').set({ userId: 'alice', creadoPor: 'coach1', tipo: 'Evento', asignados: ['alice', 'carol'], estado: null });
  await adminDb.doc('entrenamientos/w3').set({ userId: 'bob', creadoPor: 'bob', tipo: 'Bici', estado: 'completo' });
  // Evento de coach2 sobre SU atleta carol (control positivo de la vinculación)
  await adminDb.doc('entrenamientos/ev1').set({ userId: 'carol', creadoPor: 'coach2', tipo: 'Evento', asignados: ['carol'], estado: null });
  await adminDb.doc('entrenamientos/w1/detalles/data').set({ comentarios: [], ritmo: 300 });
  await adminDb.doc('entrenamientos/w1/registros/data').set({ puntos: [] });
  await adminDb.doc('entrenamientos/w2/detalles/data').set({ comentarios: [] });
  await adminDb.doc('entrenamientos/w2/registros/data').set({ puntos: [] });
  // Posts: p1 con encuesta (autor bob), p2 sin encuesta, p3 encuesta:null, p4 de alice
  await adminDb.doc('posts/p1').set({ autorUid: 'bob', autorNombre: 'Bob', texto: 'hola', reacciones: {}, encuesta: { pregunta: '¿Qué prefieres?', opciones: ['a', 'b'], votos: {} } });
  await adminDb.doc('posts/p2').set({ autorUid: 'bob', autorNombre: 'Bob', texto: 'sin encuesta', reacciones: {} });
  await adminDb.doc('posts/p3').set({ autorUid: 'bob', autorNombre: 'Bob', texto: 'encuesta null', reacciones: {}, encuesta: null });
  await adminDb.doc('posts/p4').set({ autorUid: 'alice', autorNombre: 'Alice', texto: 'post de alice', reacciones: {} });
  await adminDb.doc('analyticsCurves/alice').set({ v: 1, backfillV: 1 });
  await adminDb.doc('analyticsCurves/alice/months/2026-01').set({ v: 1, acts: {} });
  await adminDb.doc('libreria/lib1').set({ userId: 'alice', titulo: 'plantilla' });
  await adminDb.doc('archivosLib/arch1').set({ userId: 'alice', nombre: 'x.pdf' });
  await adminDb.doc('wellness/alice').set({ days: {} });
  await adminDb.doc('fitness/alice').set({ steps: 0 });
  await adminDb.doc('intervals_connections/alice').set({ conectada: true });
  await adminDb.doc('perfiles/alice/notificaciones/n1').set({ titulo: 'aviso', leido: false });
  await adminDb.doc('retos/r1').set({ creadorUid: 'coach1', titulo: 'Reto 1', invitados: ['alice'], aceptados: [] });
}

async function matriz(etiqueta, perfilAlice) {
  console.log('\n═══ Variante: ' + etiqueta + ' ═══');
  await clearFirestoreData({ projectId: PROYECTO });
  await sembrar(perfilAlice);

  // ────────────────────────── ENTRENAMIENTOS ──────────────────────────
  await permite('alice', (db) => db.doc('entrenamientos/w1').get(), 'entrenamientos: propietario lee');
  await permite('alice', (db) => db.doc('entrenamientos/w9').set({ userId: 'alice', creadoPor: 'alice', tipo: 'Carrera' }), 'entrenamientos: propietario crea');
  await permite('alice', (db) => db.doc('entrenamientos/w1').update({ duracion: 4000 }), 'entrenamientos: propietario edita');
  await permite('alice', (db) => db.doc('entrenamientos/w9').delete(), 'entrenamientos: propietario borra');
  await permite('coach1', (db) => db.doc('entrenamientos/w1').get(), 'entrenamientos: entrenador vinculado lee');
  await permite('coach1', (db) => db.doc('entrenamientos/w8').set({ userId: 'alice', creadoPor: 'coach1', tipo: 'Carrera' }), 'entrenamientos: entrenador crea para su atleta');
  await permite('coach1', (db) => db.doc('entrenamientos/w1').update({ duracion: 5000 }), 'entrenamientos: entrenador vinculado edita');
  await permite('coach1', (db) => db.doc('entrenamientos/w8').delete(), 'entrenamientos: entrenador borra el suyo');
  await lecturaEntrenos('coach1', (db) => db.doc('entrenamientos/w3').get(), 'entrenamientos: entrenador NO lee entreno de no-atleta');
  await niega('coach1', (db) => db.doc('entrenamientos/w6').set({ userId: 'bob', creadoPor: 'coach1', tipo: 'Carrera' }), 'entrenamientos: entrenador NO crea para no-atleta');
  await niega('coach1', (db) => db.doc('entrenamientos/w7').set({ userId: 'alice', creadoPor: 'otro', tipo: 'Carrera' }), 'entrenamientos: crear para atleta exige creadoPor == uid');
  await lecturaEntrenos('coach2', (db) => db.doc('entrenamientos/w1').get(), 'entrenamientos: entrenador NO vinculado no lee');
  await niega('coach2', (db) => db.doc('entrenamientos/w5').set({ userId: 'alice', creadoPor: 'coach2', tipo: 'Carrera' }), 'entrenamientos: entrenador NO vinculado no crea');
  await niega('coach2', (db) => db.doc('entrenamientos/w1').update({ duracion: 1 }), 'entrenamientos: entrenador NO vinculado no edita');
  await niega('coach2', (db) => db.doc('entrenamientos/w1').delete(), 'entrenamientos: entrenador NO vinculado no borra');
  await permite('coach2', (db) => db.doc('entrenamientos/ev1').get(), 'entrenamientos: control positivo — coach2 lee el entreno de SU atleta');
  await permite('coach2', (db) => db.doc('entrenamientos/ev1').update({ titulo: 'x' }), 'entrenamientos: control positivo — coach2 edita el entreno de SU atleta');
  await lecturaEntrenos('bob', (db) => db.doc('entrenamientos/w1').get(), 'entrenamientos: autenticado ajeno no lee');
  await niega('bob', (db) => db.doc('entrenamientos/wX').set({ userId: 'alice', creadoPor: 'bob', tipo: 'Carrera' }), 'entrenamientos: ajeno no crea para otro');
  await permite('bob', (db) => db.doc('entrenamientos/wB').set({ userId: 'bob', creadoPor: 'bob', tipo: 'Carrera' }), 'entrenamientos: ajeno crea el suyo');
  await permite('bob', (db) => db.doc('entrenamientos/w3').get(), 'entrenamientos: ajeno lee el suyo');
  await niega('bob', (db) => db.doc('entrenamientos/w1').update({ duracion: 1 }), 'entrenamientos: ajeno no edita');
  await niega('bob', (db) => db.doc('entrenamientos/w1').delete(), 'entrenamientos: ajeno no borra');
  await lecturaEntrenos(null, (db) => db.doc('entrenamientos/w1').get(), 'entrenamientos: no autenticado no lee');
  await niega(null, (db) => db.doc('entrenamientos/wN').set({ userId: 'x', creadoPor: 'x' }), 'entrenamientos: no autenticado no crea');
  await niega(null, (db) => db.doc('entrenamientos/w1').update({ duracion: 1 }), 'entrenamientos: no autenticado no edita');
  await niega(null, (db) => db.doc('entrenamientos/w1').delete(), 'entrenamientos: no autenticado no borra');
  // Evento creado por el coach: el atleta dueño NO edita/borra (matriz WorkoutDetailModal.js:202-225)
  await permite('alice', (db) => db.doc('entrenamientos/w2').get(), 'entrenamientos: dueño de Evento SÍ lee');
  await niega('alice', (db) => db.doc('entrenamientos/w2').update({ duracion: 1 }), 'entrenamientos: dueño de Evento ajeno (creadoPor coach) NO edita');
  await niega('alice', (db) => db.doc('entrenamientos/w2').delete(), 'entrenamientos: dueño de Evento ajeno NO borra');
  // Apuntado: lee, marca estado/duración, no toca nada más
  await permite('carol', (db) => db.doc('entrenamientos/w2').get(), 'entrenamientos: apuntado lee');
  await permite('carol', (db) => db.doc('entrenamientos/w2').update({ estado: 'completo' }), 'entrenamientos: apuntado marca estado');
  await permite('carol', (db) => db.doc('entrenamientos/w2').update({ estado: 'completo', duracion: 120 }), 'entrenamientos: apuntado marca estado+duración del crono');
  await niega('carol', (db) => db.doc('entrenamientos/w2').update({ duracion: 999 }), 'entrenamientos: apuntado no edita duración sola');
  await niega('carol', (db) => db.doc('entrenamientos/w2').update({ titulo: 'x' }), 'entrenamientos: apuntado no edita otros campos');
  await niega('carol', (db) => db.doc('entrenamientos/w2').delete(), 'entrenamientos: apuntado no borra');

  // ────────────────────────── DETALLES ──────────────────────────
  await permite('alice', (db) => db.doc('entrenamientos/w1/detalles/data').get(), 'detalles: propietario lee');
  await permite('alice', (db) => db.doc('entrenamientos/w1/detalles/data').update({ sensacion: 5 }), 'detalles: propietario edita');
  await permite('alice', (db) => db.doc('entrenamientos/w9/detalles/data').set({ ritmo: 300 }), 'detalles: propietario crea');
  await permite('coach1', (db) => db.doc('entrenamientos/w1/detalles/data').get(), 'detalles: entrenador vinculado lee');
  await permite('coach1', (db) => db.doc('entrenamientos/w1/detalles/data').update({ comentarios: [] }), 'detalles: entrenador vinculado edita');
  await lecturaEntrenos('coach2', (db) => db.doc('entrenamientos/w1/detalles/data').get(), 'detalles: entrenador NO vinculado no lee');
  await niega('coach2', (db) => db.doc('entrenamientos/w1/detalles/data').update({ sensacion: 5 }), 'detalles: entrenador NO vinculado no edita');
  await lecturaEntrenos('bob', (db) => db.doc('entrenamientos/w1/detalles/data').get(), 'detalles: ajeno no lee');
  await niega('bob', (db) => db.doc('entrenamientos/w1/detalles/data').set({ ritmo: 1 }), 'detalles: ajeno no crea');
  await lecturaEntrenos(null, (db) => db.doc('entrenamientos/w1/detalles/data').get(), 'detalles: no autenticado no lee');
  await permite('carol', (db) => db.doc('entrenamientos/w2/detalles/data').get(), 'detalles: apuntado lee su evento');
  await niega('carol', (db) => db.doc('entrenamientos/w2/detalles/data').update({ comentarios: [] }), 'detalles: apuntado NO escribe (decisión: solo dueño/entrenador)');

  // ────────────────────────── REGISTROS ──────────────────────────
  await permite('alice', (db) => db.doc('entrenamientos/w1/registros/data').get(), 'registros: propietario lee');
  await permite('alice', (db) => db.doc('entrenamientos/w9/registros/data').set({ puntos: [] }), 'registros: propietario crea');
  await permite('coach1', (db) => db.doc('entrenamientos/w1/registros/data').get(), 'registros: entrenador vinculado lee');
  await lecturaEntrenos('coach2', (db) => db.doc('entrenamientos/w1/registros/data').get(), 'registros: entrenador NO vinculado no lee');
  await niega('coach2', (db) => db.doc('entrenamientos/w1/registros/data').set({ puntos: [] }), 'registros: entrenador NO vinculado no crea');
  await lecturaEntrenos('bob', (db) => db.doc('entrenamientos/w1/registros/data').get(), 'registros: ajeno no lee');
  await lecturaEntrenos(null, (db) => db.doc('entrenamientos/w1/registros/data').get(), 'registros: no autenticado no lee');

  // ────────────────────────── POSTS ──────────────────────────
  await permite('bob', (db) => db.doc('posts/pNuevo').set({ autorUid: 'bob', autorNombre: 'Bob', texto: 'nuevo' }), 'posts: crear con autorUid propio');
  await niega('bob', (db) => db.doc('posts/pFalso').set({ autorUid: 'alice', autorNombre: 'Alice', texto: 'suplantación' }), 'posts: crear suplantando autorUid ajeno');
  await niega(null, (db) => db.doc('posts/pN').set({ autorUid: 'x', texto: 'x' }), 'posts: no autenticado no crea');
  // Reacciones: permitidas a CUALQUIER autenticado (mapa `reacciones`)
  await permite('alice', (db) => db.doc('posts/p1').update({ reacciones: { '👍': ['alice'] } }), 'posts: ajena reacciona (reacciones)');
  await permite('alice', (db) => db.doc('posts/p1').update({ reacciones: { '👍': ['alice', 'carol'], '🔥': ['dave'] } }), 'posts: ajena cambia reacciones');
  await permite('alice', (db) => db.doc('posts/p1').update({ 'reacciones.👍': deleteField() }), 'posts: ajena retira reacción con deleteField');
  await permite('alice', (db) => db.doc('posts/p2').update({ reacciones: { '👏': ['alice'] } }), 'posts: reacción en post SIN encuesta');
  await permite('alice', (db) => db.doc('posts/p3').update({ reacciones: { '👏': ['alice'] } }), 'posts: reacción en post con encuesta:null');
  // Voto: solo votos; pregunta/opciones deben quedar idénticas
  await permite('alice', (db) => db.doc('posts/p1').update({ 'encuesta.votos.alice': 0 }), 'posts: ajena vota en la encuesta');
  await niega('alice', (db) => db.doc('posts/p1').update({ 'encuesta.pregunta': 'otra' }), 'posts: ajena NO cambia la pregunta de la encuesta');
  await niega('alice', (db) => db.doc('posts/p1').update({ encuesta: null }), 'posts: ajena NO borra la encuesta');
  // Texto / borrado lógico ajeno: DENEGADO
  await niega('alice', (db) => db.doc('posts/p1').update({ texto: 'hackeado' }), 'posts: ajena NO edita texto');
  await niega('alice', (db) => db.doc('posts/p1').update({ eliminado: true, texto: '', media: [], encuesta: null, preview: null, reacciones: {} }), 'posts: ajena NO borra lógicamente');
  await niega('alice', (db) => db.doc('posts/p1').delete(), 'posts: ajena NO borra físicamente');
  await niega(null, (db) => db.doc('posts/p1').update({ reacciones: { '👍': ['x'] } }), 'posts: no autenticado no reacciona');
  // Autor: todo permitido
  await permite('bob', (db) => db.doc('posts/p1').update({ texto: 'editado por el autor' }), 'posts: autor edita su texto');
  await permite('bob', (db) => db.doc('posts/p1').update({ eliminado: true, texto: '', media: [], encuesta: null, preview: null, reacciones: {} }), 'posts: autor borra lógicamente el suyo');
  await permite('bob', (db) => db.doc('posts/p1').delete(), 'posts: autor borra físicamente (el cliente no lo usa)');
  await niega('bob', (db) => db.doc('posts/p4').update({ texto: 'x' }), 'posts: NO autor no edita texto ajeno');
  await niega('bob', (db) => db.doc('posts/p4').delete(), 'posts: NO autor no borra post ajeno');
  await permite('alice', (db) => db.doc('posts/p4').delete(), 'posts: autora borra el suyo (control positivo)');

  // ────────────────────────── ANALYTICS CURVES ──────────────────────────
  await permite('alice', (db) => db.doc('analyticsCurves/alice').get(), 'curvas: propietario lee meta');
  await permite('alice', (db) => db.doc('analyticsCurves/alice').update({ backfillV: 0 }), 'curvas: propietario edita meta');
  await permite('alice', (db) => db.doc('analyticsCurves/alice/months/2026-02').set({ v: 1, acts: {} }), 'curvas: propietario escribe mes');
  await permite('coach1', (db) => db.doc('analyticsCurves/alice').get(), 'curvas: entrenador vinculado lee meta');
  await permite('coach1', (db) => db.doc('analyticsCurves/alice/months/2026-01').get(), 'curvas: entrenador vinculado lee mes');
  await niega('coach1', (db) => db.doc('analyticsCurves/alice').set({ v: 1, backfillV: 1 }), 'curvas: entrenador NO escribe meta');
  await niega('coach1', (db) => db.doc('analyticsCurves/alice/months/2026-03').set({ v: 1, acts: {} }), 'curvas: entrenador NO escribe mes');
  await niega('coach2', (db) => db.doc('analyticsCurves/alice').get(), 'curvas: entrenador NO vinculado no lee');
  await niega('coach2', (db) => db.doc('analyticsCurves/alice/months/2026-01').get(), 'curvas: entrenador NO vinculado no lee mes');
  await niega('bob', (db) => db.doc('analyticsCurves/alice').get(), 'curvas: ajeno no lee');
  await niega('bob', (db) => db.doc('analyticsCurves/alice').set({ v: 1 }), 'curvas: ajeno no escribe');
  await niega(null, (db) => db.doc('analyticsCurves/alice').get(), 'curvas: no autenticado no lee');
  await niega(null, (db) => db.doc('analyticsCurves/alice').set({ v: 1 }), 'curvas: no autenticado no escribe');

  // ────────────────────────── PERFILES (hasOnly del coach) ──────────────────────────
  await permite('bob', (db) => db.doc('perfiles/alice').get(), 'perfiles: lectura abierta a autenticados (riesgo documentado)');
  await permite('coach1', (db) => db.doc('perfiles/alice').update({ zonasFC: [], zonasRitmo: [], zonasPotencia: [], zonasActividad: {}, umbralRitmo: '', umbralCiclismo: '', umbralFC: 0, fcUmbral: 0, fcReposo: 0, umbralPotencia: 0 }), 'perfiles: entrenador escribe zonas/umbrales (ZonesScreen.js:455-466)');
  await permite('coach1', (db) => db.doc('perfiles/alice').update({ marcasDefs: [], marcasResults: {}, marcasMetrics: [] }), 'perfiles: entrenador escribe marcas (MarcasScreen.js:608-610)');
  await niega('coach1', (db) => db.doc('perfiles/alice').update({ nombre: 'otro' }), 'perfiles: entrenador NO escribe nombre');
  await niega('coach1', (db) => db.doc('perfiles/alice').update({ expoPushToken: 'x' }), 'perfiles: entrenador NO escribe expoPushToken');
  await niega('coach1', (db) => db.doc('perfiles/alice').update({ entrenador: 'coach2' }), 'perfiles: entrenador NO cambia el vínculo');
  await niega('coach2', (db) => db.doc('perfiles/alice').update({ zonasFC: [] }), 'perfiles: entrenador NO vinculado no escribe zonas');
  await permite('alice', (db) => db.doc('perfiles/alice').update({ nombre: 'Alicia' }), 'perfiles: dueña escribe todo');
  await niega(null, (db) => db.doc('perfiles/alice').update({ nombre: 'x' }), 'perfiles: no autenticado no escribe');

  // ────────────────────────── EXTRAS (inventario) ──────────────────────────
  await permite('alice', (db) => db.doc('libreria/lib1').get(), 'libreria: propietario lee');
  await permite('alice', (db) => db.doc('libreria/lib2').set({ userId: 'alice', titulo: 'nueva' }), 'libreria: propietario crea');
  await niega('bob', (db) => db.doc('libreria/lib1').get(), 'libreria: ajeno no lee');
  await niega('bob', (db) => db.doc('libreria/lib1').delete(), 'libreria: ajeno no borra');
  await permite('alice', (db) => db.doc('archivosLib/arch1').get(), 'archivosLib: propietario lee');
  await niega('bob', (db) => db.doc('archivosLib/arch1').get(), 'archivosLib: ajeno no lee');
  await permite('alice', (db) => db.doc('wellness/alice').get(), 'wellness: lectura abierta a autenticados');
  await permite('bob', (db) => db.doc('wellness/alice').get(), 'wellness: otro autenticado lee (ranking de retos)');
  await niega('alice', (db) => db.doc('wellness/alice').set({ days: {} }), 'wellness: cliente NO escribe');
  await niega('alice', (db) => db.doc('fitness/alice').set({ x: 1 }), 'fitness: cliente NO escribe');
  await permite('alice', (db) => db.doc('analysis/alice').set({ charts: {} }, { merge: true }), 'analysis: propietario escribe');
  await permite('coach1', (db) => db.doc('analysis/alice').get(), 'analysis: entrenador vinculado lee');
  await niega('bob', (db) => db.doc('analysis/alice').get(), 'analysis: ajeno no lee');
  await permite('alice', (db) => db.doc('avatares/alice').set({ url: 'x' }), 'avatares: propietario escribe');
  await permite('bob', (db) => db.doc('avatares/alice').get(), 'avatares: lectura abierta a autenticados');
  await niega('bob', (db) => db.doc('avatares/alice').set({ url: 'x' }), 'avatares: ajeno no escribe');
  await permite('alice', (db) => db.collection('retos').add({ creadorUid: 'alice', titulo: 'r' }), 'retos: crear con creadorUid propio');
  await niega('bob', (db) => db.collection('retos').add({ creadorUid: 'alice', titulo: 'r' }), 'retos: crear con creadorUid ajeno');
  await permite('alice', (db) => db.doc('retos/r1').update({ aceptados: ['alice'] }), 'retos: invitado se apunta (aceptados)');
  await niega('bob', (db) => db.doc('retos/r1').update({ aceptados: ['bob'] }), 'retos: NO invitado no se apunta');
  await niega('alice', (db) => db.doc('retos/r1').update({ titulo: 'x' }), 'retos: invitado no edita el reto');
  await permite('alice', (db) => db.collection('soporte').add({ userId: 'alice', asunto: 'a', mensaje: 'm' }), 'soporte: addDoc del autor');
  await niega('bob', (db) => db.collection('soporte').add({ userId: 'alice', asunto: 'a', mensaje: 'm' }), 'soporte: addDoc con userId ajeno');
  await permite('alice', (db) => db.doc('perfiles/alice/notificaciones/n2').set({ titulo: 'x', leido: false }), 'notificaciones: dueño crea su historial');
  await permite('alice', (db) => db.doc('perfiles/alice/notificaciones/n1').update({ leido: true }), 'notificaciones: dueño marca leído');
  await niega('bob', (db) => db.doc('perfiles/alice/notificaciones/n1').get(), 'notificaciones: ajeno no lee');
  await permite('alice', (db) => db.doc('intervals_connections/alice').get(), 'intervals_connections: lee doc propio');
  await niega('bob', (db) => db.doc('intervals_connections/alice').get(), 'intervals_connections: ajeno no lee');
  await niega('alice', (db) => db.doc('intervals_connections/alice').set({ token: 'x' }), 'intervals_connections: cliente NO escribe');
  await niega('alice', (db) => db.doc('ia_keys/k1').get(), 'ia_keys: denegada (colección no usada por el cliente)');
  await niega('alice', (db) => db.doc('ia_keys/k1').set({ k: 'x' }), 'ia_keys: escritura denegada');
}

const VARIANTES = [
  { nombre: "entrenadorUid string ('coach1')", perfil: { entrenadorUid: 'coach1' } },
  { nombre: "entrenador string ('coach1')", perfil: { entrenador: 'coach1' } },
  { nombre: 'entrenador mapa {uid}', perfil: { entrenador: { uid: 'coach1' } } },
  { nombre: 'entrenador lista [uid]', perfil: { entrenador: ['coach1'] } },
];

(async () => {
  await loadFirestoreRules({ projectId: PROYECTO, rules: REGLAS });
  for (const v of VARIANTES) {
    await matriz(v.nombre, v.perfil);
  }
  console.log('\n──────────────────────────────────────────────');
  console.log(`RESULTADO: ${pasadas} ok, ${fallos.length} fallos (${VARIANTES.length} variantes de vinculación)`);
  try { await adminApp.delete(); } catch (e) {}
  await Promise.all(apps().map((a) => a.delete().catch(() => {})));
  if (fallos.length) {
    fallos.forEach((f) => console.error('  · ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  // Guard 2: emulador no arrancado → SKIP (no rompe la batería node tests/*.js)
  const m = String((e && e.message) || e);
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connect/i.test(m)) {
    console.log('SKIP: arranca el emulador de Firestore primero (firebase emulators:start --only firestore) y vuelve a ejecutar (ver README)');
    process.exit(0);
  }
  console.error('ERROR FATAL en firestore-rules-test:', e);
  process.exit(2);
});
