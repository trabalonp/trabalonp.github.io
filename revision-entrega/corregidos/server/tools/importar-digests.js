// tools/importar-digests.js — reconstruye los digests de curvas de UNO o TODOS
// los usuarios desde la máquina local (o desde CI), sin depender del móvil.
//
// Cuándo usarlo
// -------------
//   · Primera puesta en marcha del bloque C/D: en lugar de esperar a que cada
//     usuario abra Análisis (y a que su móvil pague el backfill completo), se
//     generan aquí todos los meses y el cliente arranca ya "al día".
//   · Reparación: si un mes quedó a medias, `oversize` mal puesto, etc.
//
// Uso
// ---
//   node tools/importar-digests.js --uid <UID> [--forzar] [--limite N]
//   node tools/importar-digests.js --uid <UID> --dry-run
//   node tools/importar-digests.js --todos [--forzar] [--limite N]
//
// Variables de entorno
// --------------------
//   FIREBASE_SERVICE_ACCOUNT   JSON de la service account (obligatorio; es la
//                              misma variable que usan los handlers).
//   APP_TZ                     Zona horaria para el reparto POR DÍA
//                              (por defecto Europe/Madrid, igual que la app).
//
// Notas
// -----
//   · Es IDEMPOTENTE: solo escribe los digests que faltan o cuyo `sig` cambió.
//     Con --forzar recalcula todo (útil tras cambiar el algoritmo de digest).
//   · Marca `oversize: true` en los meses que superarían ~900 KB; el motor del
//     cliente usa el cálculo legacy para esos meses (nunca se pierden datos).
//   · --dry-run no escribe: informa de lo que haría (usa el mismo código con un
//     Firestore envuelto que descarta escrituras).
'use strict';

const admin = require('../lib/firebase');
const workers = require('../lib/workers');

function arg(nombre, def = null) {
  const i = process.argv.indexOf(nombre);

  if (i === -1) return def;

  const v = process.argv[i + 1];

  return v && !v.startsWith('--') ? v : true;
}

function bool(nombre) {
  return process.argv.includes(nombre);
}

const log = (...a) => console.log(...a);
const hhmmss = () => new Date().toISOString().slice(11, 19);

async function main() {
  const uid = arg('--uid');
  const todos = bool('--todos');
  const forzar = bool('--forzar');
  const dryRun = bool('--dry-run');
  const limite = Number(arg('--limite', 0)) || 0;

  if (!uid && !todos) {
    log('Uso: node tools/importar-digests.js --uid <UID> [--forzar] [--limite N] [--dry-run]');
    log('     node tools/importar-digests.js --todos [--forzar] [--limite N] [--dry-run]');
    process.exit(2);
  }

  if (dryRun) {
    // Se envuelve el Firestore del worker para descartar TODAS las escrituras
    // (incluidas las de los meses). El resto del código no cambia.
    const db = admin.firestore();
    const original = db.collection.bind(db);

    db.collection = (nombre) => {
      const col = original(nombre);

      return new Proxy(col, {
        get(target, prop) {
          if (prop === 'doc') {
            return (id) => {
              const doc = target.doc(id);

              return new Proxy(doc, {
                get(dtarget, dprop) {
                  if (dprop === 'set' || dprop === 'update' || dprop === 'delete') {
                    return async () => {
                      log(`   [dry-run] se habría escrito ${dtarget.path}`);
                    };
                  }

                  if (dprop === 'collection') {
                    return (sub) => db.collection(`${dtarget.path}/${sub}`);
                  }

                  const v = dtarget[dprop];

                  return typeof v === 'function' ? v.bind(dtarget) : v;
                },
              });
            };
          }

          const v = target[prop];

          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    };

    db.runTransaction = async () => false;
    log('*** MODO --dry-run: no se escribe nada ***');
  }

  const t0 = Date.now();
  const uids = [];

  if (uid) {
    uids.push(String(uid));
  } else {
    log('Leyendo la lista de usuarios (perfiles)…');

    const snap = await admin.firestore().collection('perfiles').limit(5000).get();

    snap.forEach((d) => uids.push(d.id));
    log(`${uids.length} usuarios`);
  }

  const resumenes = [];
  let errores = 0;

  for (const u of uids) {
    log(`\n═══ ${u} ═══`);

    try {
      const r = await workers.backfillUsuario(u, {
        forzar,
        limite,
        onProgreso: (s) => log(`  ${hhmmss()} ${s}`),
      });

      resumenes.push(r);
    } catch (e) {
      errores++;
      console.error(`  ERROR con ${u}:`, e.message);
    }
  }

  log('\n──────────── RESUMEN ────────────');

  for (const r of resumenes) {
    log(
      `${r.uid}: ${r.resumenes} resúmenes · ${r.validos} con curvas · ${r.escritos} digests escritos · ` +
        `${r.alDia} al día · ${r.sinPuntos} sin puntos · ${r.errores} errores · ${r.meses} meses · ` +
        `${(r.bytes / 1024).toFixed(1)} KB escritos`
    );
  }

  const total = resumenes.reduce((a, r) => a + r.escritos, 0);

  log(`\nTotal: ${total} digests en ${((Date.now() - t0) / 1000).toFixed(1)} s · ${errores} usuarios con error`);

  if (dryRun) log('(dry-run: nada de esto se ha escrito)');

  process.exit(errores ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR FATAL:', e);
  process.exit(1);
});
