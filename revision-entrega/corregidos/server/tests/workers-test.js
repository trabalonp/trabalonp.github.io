/* tests/workers-test.js — prueba services/workers.js SIN Firebase real.
   Sustituye lib/firebase por un Firestore EN MEMORIA que implementa solo lo que
   usa el worker (get/set con merge, subcolecciones, consulta por userId con
   orderBy __name__ y startAfter, transacciones y los sentinelas delete /
   arrayRemove / serverTimestamp).

   Comprueba:
     1) procesarPendientes vacía la cola y escribe cada digest en su mes.
     2) Los entrenos sin puntos salen de la cola sin escribir nada.
     3) Es idempotente: la segunda pasada no escribe (motivo "alDia").
     4) Un cambio de PUNTOS (firma `sig`) obliga a recalcular.
     5) backfillUsuario reconstruye todos los meses y deja backfillV=1.
     6) Un mes que pasaría de ~900 KB se marca oversize (y no se escribe).
     7) procesarDigest ignora entrenos de otro usuario y jobs con id inválido.

   Uso:  node tests/workers-test.js      (desde la raíz del repo del servidor)
   Sale con 1 si algo falla. */
'use strict';

const path = require('path');
const Module = require('module');

// ─────────────────────────── Firestore en memoria ───────────────────────────
function crearFirestoreFake(semilla = {}) {
  const store = new Map(Object.entries(semilla));
  const FIELD_DELETE = { __sent: 'delete' };
  const arrayRemove = (...vals) => ({ __sent: 'arrayRemove', valor: vals });
  const serverTimestamp = () => ({ __sent: 'ts' });
  const FieldValue = { delete: () => FIELD_DELETE, arrayRemove, serverTimestamp };

  // Clon manual: JSON.stringify se comería los objetos con toMillis/toDate
  // (funciones) y el worker vería `fecha: {}` → 0 ms.
  const clon = (v) => {
    if (v == null || typeof v !== 'object') return v;
    if (typeof v.toMillis === 'function') {
      return { toMillis: () => v.toMillis(), toDate: () => new Date(v.toMillis()) };
    }
    if (Array.isArray(v)) return v.map(clon);

    const out = {};

    for (const k of Object.keys(v)) out[k] = clon(v[k]);

    return out;
  };

  function fusionar(dst, src) {
    const out = dst && typeof dst === 'object' && !Array.isArray(dst) ? dst : {};

    for (const k of Object.keys(src)) {
      const v = src[k];

      if (v && v.__sent) {
        if (v.__sent === 'delete') delete out[k];
        else if (v.__sent === 'arrayRemove') out[k] = (Array.isArray(out[k]) ? out[k] : []).filter((x) => !v.valor.includes(x));
        else out[k] = Date.now();
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = fusionar(out[k], v);
      } else {
        out[k] = v;
      }
    }

    return out;
  }

  const snap = (ruta, existe) => ({
    exists: existe,
    id: ruta.split('/').pop(),
    ref: { path: ruta },
    data: () => (existe ? clon(store.get(ruta)) : undefined),
  });

  function refDe(ruta) {
    return {
      path: ruta,
      id: ruta.split('/').pop(),
      get: async () => snap(ruta, store.has(ruta)),
      set: async (data, opts = {}) => {
        store.set(ruta, opts.merge ? fusionar(store.get(ruta), data) : fusionar({}, data));
      },
      update: async (data) => {
        if (!store.has(ruta)) throw new Error('NOT_FOUND: ' + ruta);
        store.set(ruta, fusionar(store.get(ruta), data));
      },
      delete: async () => { store.delete(ruta); },
      collection: (nombre) => coleccion(`${ruta}/${nombre}`),
    };
  }

  function coleccion(ruta) {
    const filtros = [];
    let ordenar = null;
    let tope = null;
    let desde = null;

    const cadena = {
      doc: (id) => refDe(`${ruta}/${id}`),
      where: (campo, op, valor) => {
        filtros.push({ campo, op, valor });

        return cadena;
      },
      orderBy: (campo) => {
        ordenar = campo;

        return cadena;
      },
      limit: (n) => {
        tope = n;

        return cadena;
      },
      startAfter: (x) => {
        desde = x && x.id ? x.id : String(x);

        return cadena;
      },
      get: async () => {
        const pref = ruta + '/';
        let items = [];

        store.forEach((datos, clave) => {
          if (!clave.startsWith(pref)) return;

          const resto = clave.slice(pref.length);

          if (resto.includes('/')) return; // subdocumentos
          items.push({ id: resto, datos });
        });

        for (const f of filtros) {
          items = items.filter((it) => {
            const v = (it.datos || {})[f.campo];

            if (f.op === '==') return v === f.valor;
            throw new Error('op no soportada en el fake: ' + f.op);
          });
        }

        items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        if (desde) items = items.filter((it) => it.id > desde);
        if (tope) items = items.slice(0, tope);

        const docs = items.map((it) => snap(`${ruta}/${it.id}`, true));

        return { size: docs.length, empty: docs.length === 0, docs, forEach: (fn) => docs.forEach(fn) };
      },
    };

    return cadena;
  }

  const db = {
    collection: (nombre) => coleccion(nombre),
    runTransaction: async (fn) => {
      const tx = {
        get: (ref) => snap(ref.path, store.has(ref.path)),
        set: (ref, data, opts = {}) => {
          store.set(ref.path, opts.merge ? fusionar(store.get(ref.path), data) : fusionar({}, data));
        },
      };

      return fn(tx);
    },
  };

  return { db, store, FieldValue, _fusionar: fusionar };
}

// ──────────────────── Carga de workers.js con lib/firebase falso ────────────
function cargarWorkers(fake) {
  const firebaseStub = { firestore: () => Object.assign(fake.db, { FieldValue: fake.FieldValue }) };

  // firebase-admin se usa como función y como namespace: `admin.firestore`
  firebaseStub.firestore.FieldValue = fake.FieldValue;
  firebaseStub.firestore.Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) }) };

  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (request === './firebase' || request.endsWith('lib/firebase') || request === '../lib/firebase') return firebaseStub;
    return origLoad.apply(this, arguments);
  };

  const rutaWorkers = path.join(__dirname, '..', 'lib', 'workers.js');
  const rutaDigest = path.join(__dirname, '..', 'lib', 'curvasDigest.js');

  delete require.cache[require.resolve(rutaWorkers)];
  delete require.cache[require.resolve(rutaDigest)];

  try {
    return { workers: require(rutaWorkers), digest: require(rutaDigest) };
  } finally {
    Module._load = origLoad;
  }
}

// ────────────────────────────────── Utilidades ─────────────────────────────
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

// 120 puntos a 1 Hz: 2 minutos de carrera a ~11-12 km/h.
function puntos(fechaMs, n = 120, factor = 1) {
  const out = [];
  let t = fechaMs;

  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: new Date(t).toISOString(),
      frecuencia: Math.round(150 + 10 * Math.sin(i / 10)),
      velocidad: Number((11 * factor + Math.sin(i / 12)).toFixed(2)),
      cadencia: 170,
    });
    t += 1000;
  }

  return out;
}

function semillaBase() {
  const s = {};
  const f1 = new Date(Date.UTC(2026, 7, 3, 8, 0, 0)).getTime(); // 3 ago 2026
  const f2 = new Date(Date.UTC(2026, 7, 20, 8, 0, 0)).getTime(); // 20 ago 2026
  const f3 = new Date(Date.UTC(2026, 8, 5, 8, 0, 0)).getTime(); // 5 sep 2026

  s['entrenamientos/w1'] = { userId: 'u1', fecha: { toMillis: () => f1, toDate: () => new Date(f1) }, tipo: 'Running', estado: 'completo', duracion: 120 };
  s['entrenamientos/w1/registros/data'] = { puntos: puntos(f1) };
  s['entrenamientos/w2'] = { userId: 'u1', fecha: { toMillis: () => f2, toDate: () => new Date(f2) }, tipo: 'Running', estado: 'completo', duracion: 120 };
  s['entrenamientos/w2/registros/data'] = { puntos: puntos(f2, 120, 1.05) };
  s['entrenamientos/w3'] = { userId: 'u1', fecha: { toMillis: () => f2, toDate: () => new Date(f2) }, tipo: 'Fuerza', estado: 'completo', duracion: 600 };
  // (w3 sin registros/data)
  s['entrenamientos/w4'] = { userId: 'u1', fecha: { toMillis: () => f3, toDate: () => new Date(f3) }, tipo: 'Running', estado: 'completo', duracion: 120 };
  s['entrenamientos/w4/registros/data'] = { puntos: puntos(f3) };
  s['entrenamientos/w5'] = { userId: 'u1', fecha: { toMillis: () => f3, toDate: () => new Date(f3) }, tipo: 'Running', estado: 'planificado', duracion: 0 };
  s['entrenamientos/ajeno'] = { userId: 'OTRO', fecha: { toMillis: () => f1, toDate: () => new Date(f1) }, tipo: 'Running', estado: 'completo', duracion: 120 };
  s['entrenamientos/ajeno/registros/data'] = { puntos: puntos(f1) };
  s['analyticsCurves/u1'] = { v: 1, pendientes: ['w1', 'w2', 'w3', 'ajeno'] };

  return s;
}

const contarEscrituras = (store, prefijo) => {
  let n = 0;

  store.forEach((_v, k) => {
    if (k.startsWith(prefijo)) n++;
  });

  return n;
};

// ─────────────────────────────────── Pruebas ───────────────────────────────
(async () => {
  // 1) procesarPendientes
  console.log('— 1) procesarPendientes vacía la cola y escribe cada digest en su mes —');
  {
    const fake = crearFirestoreFake(semillaBase());
    const { workers } = cargarWorkers(fake);

    const r = await workers.procesarPendientes('u1', { max: 10 });

    ok(r.procesados >= 3, `procesa los pendientes (${r.procesados})`);
    eq(r.escritos, 2, 'escribe 2 digests (w1 y w2; w3 no tiene puntos)');
    eq(r.quitados, 4, 'saca de la cola los 4 resolubles (w1, w2, w3 sin puntos y el entreno de otro usuario)');

    const ago = fake.store.get('analyticsCurves/u1/months/2026-08') || {};
    ok(ago.acts && ago.acts.w1 && ago.acts.w1.win, 'agosto: digest de w1 escrito con estructura `win`');
    ok(ago.acts && ago.acts.w2, 'agosto: digest de w2 escrito');
    eq(ago.acts.w3, undefined, 'agosto: w3 (sin registros) NO tiene digest');
    eq(ago.v, 1, 'el documento de mes lleva v:1');

    const meta = fake.store.get('analyticsCurves/u1') || {};
    eq((meta.pendientes || []).length, 0, 'la cola queda vacía');

    // El digest debe tener la forma exacta que consume el motor del cliente.
    const dg = ago.acts.w1;
    ok(Array.isArray(dg.win.ritmo) && dg.win.ritmo.length === 9, 'win.ritmo tiene los 9 tamaños de ventana');
    ok(Object.keys(dg.dias).length >= 1, 'dias tiene al menos un día');
    ok(typeof dg.sig === 'string' && dg.sig.split('|').length === 3, 'la firma `sig` es nº|primerTs|últimoTs');
  }

  // 2) idempotencia
  console.log('\n— 2) Idempotencia: repetir no reescribe —');
  {
    const fake = crearFirestoreFake(semillaBase());
    const { workers } = cargarWorkers(fake);

    await workers.procesarPendientes('u1', { max: 10 });
    const antes = JSON.stringify([...fake.store.entries()].filter(([k]) => k.includes('/months/')));

    // Se vuelve a encolar lo mismo a mano y se procesa otra vez.
    const meta = fake.store.get('analyticsCurves/u1');

    meta.pendientes = ['w1', 'w2'];
    fake.store.set('analyticsCurves/u1', meta);

    const r = await workers.procesarPendientes('u1', { max: 10 });

    eq(r.escritos, 0, 'segunda pasada: 0 escrituras (ya estaban al día)');
    eq(JSON.stringify([...fake.store.entries()].filter(([k]) => k.includes('/months/'))), antes, 'los documentos de mes no cambian');
    eq((fake.store.get('analyticsCurves/u1').pendientes || []).length, 0, 'la cola se vacía igualmente');
  }

  // 3) cambio de puntos → recalcula
  console.log('\n— 3) Si cambian los PUNTOS, se recalcula (firma sig) —');
  {
    const fake = crearFirestoreFake(semillaBase());
    const { workers } = cargarWorkers(fake);

    await workers.procesarDigest('u1', 'w1');
    const dgAntes = JSON.parse(JSON.stringify(fake.store.get('analyticsCurves/u1/months/2026-08').acts.w1));

    // Se reescriben los puntos (p. ej. el servidor volvió a bajar el detalle).
    const f1 = new Date(Date.UTC(2026, 7, 3, 8, 0, 0)).getTime();

    fake.store.set('entrenamientos/w1/registros/data', { puntos: puntos(f1, 240) });

    const r = await workers.procesarDigest('u1', 'w1');

    ok(r.escrito, 'se reescribe el digest (motivo ' + r.motivo + ')');

    const dgDespues = fake.store.get('analyticsCurves/u1/months/2026-08').acts.w1;

    ok(dgAntes.sig !== dgDespues.sig, 'la firma cambia (nº de puntos distinto)');
  }

  // 4) backfill completo
  console.log('\n— 4) backfillUsuario reconstruye todos los meses —');
  {
    const fake = crearFirestoreFake(semillaBase());
    const { workers } = cargarWorkers(fake);

    const r = await workers.backfillUsuario('u1');

    eq(r.validos, 4, '4 entrenos con curvas (w1, w2, w3 y w4; w3 no tiene registros)');
    eq(r.sinPuntos, 1, 'w3 cuenta como «sin puntos» y no genera digest');
    eq(r.escritos, 3, '3 digests escritos');
    eq(r.meses, 2, '2 documentos de mes (agosto y septiembre)');

    const ago = fake.store.get('analyticsCurves/u1/months/2026-08') || {};
    const sep = fake.store.get('analyticsCurves/u1/months/2026-09') || {};

    ok(ago.acts && ago.acts.w1 && ago.acts.w2, 'agosto tiene w1 y w2');
    ok(sep.acts && sep.acts.w4, 'septiembre tiene w4');
    eq(ago.acts.w3, undefined, 'w3 (Fuerza sin registros) no aparece');

    const meta = fake.store.get('analyticsCurves/u1') || {};

    eq(meta.backfillV, 1, 'meta marca backfillV=1');
    eq(meta.primerMes, '2026-08', 'meta guarda primerMes (para el período «Todo»)');

    const r2 = await workers.backfillUsuario('u1');

    eq(r2.escritos, 0, 'segunda pasada: nada que escribir');
    eq(r2.alDia, 3, 'segunda pasada: los 3 están al día');
  }

  // 5) oversize
  console.log('\n— 5) Un mes que pasaría de ~900 KB se marca oversize —');
  {
    const fake = crearFirestoreFake(semillaBase());

    const { workers } = cargarWorkers(fake);

    // Se infla agosto hasta pasar del TOPE real del módulo (no un número a ojo).
    const acts = {};
    let i = 0;

    while (Buffer.byteLength(JSON.stringify(acts), 'utf8') < workers.TOPE_BYTES_MES + 4096) {
      acts['falso' + i++] = { f: 1, tipo: 'Running', sig: 'x', relleno: 'A'.repeat(4000), dias: {} };
    }

    fake.store.set('analyticsCurves/u1/months/2026-08', { v: 1, acts });

    await workers.procesarPendientes('u1', { max: 10 });

    const ago = fake.store.get('analyticsCurves/u1/months/2026-08');

    eq(ago.oversize, true, 'agosto queda marcado oversize');
    eq(ago.acts.w1, undefined, 'no se ha añadido w1 a un mes sobredimensionado');
    eq((fake.store.get('analyticsCurves/u1').pendientes || []).includes('w1'), false, 'w1 sale de la cola (el motor usará legacy)');
    eq((fake.store.get('analyticsCurves/u1').pendientes || []).includes('w2'), false, 'w2 también sale (mismo mes)');
  }

  // 6) guardas
  console.log('\n— 6) Guardas: usuario ajeno e id inválido —');
  {
    const fake = crearFirestoreFake(semillaBase());
    const { workers } = cargarWorkers(fake);

    const ajeno = await workers.procesarDigest('u1', 'ajeno');

    eq(ajeno.motivo, 'otroUsuario', 'un entreno de otro usuario no se procesa');
    eq((fake.store.get('analyticsCurves/u1/months/2026-08') || {}).acts, undefined, 'y no se escribe nada');

    const invalido = await workers.procesarDigest('u1', 'a/b');

    eq(invalido.ok, false, 'id con «/» rechazado');
    eq(invalido.motivo, 'idInvalido', 'motivo idInvalido');
  }

  console.log(`\n${fallos.length ? 'FALLOS: ' + fallos.length : 'TODO OK'} — ${pasadas} comprobaciones OK`);
  if (fallos.length) process.exit(1);
})().catch((e) => {
  console.error('ERROR FATAL:', e);
  process.exit(2);
});
