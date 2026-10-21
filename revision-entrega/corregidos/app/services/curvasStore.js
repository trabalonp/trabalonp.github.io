// services/curvasStore.js
// Persistencia CLIENTE del digest de curvas (Bloque C): documentos mensuales
// analyticsCurves/{uid}/months/{yyyy-mm} con { v: 1, acts: { "<id>": <digest> } }
// y meta analyticsCurves/{uid} con { v: 1, backfillV, pendientes, primerMes }.
//   · Caché en memoria por uid:mes + coalescencia de peticiones: los períodos
//     solapados reutilizan los mismos documentos (H2).
//   · TODAS las funciones capturan errores y devuelven un resultado
//     utilizable; NUNCA lanzan hacia la UI (el motor cae a legacy).
//   · Solo el PROPIETARIO escribe digests: si auth.currentUser.uid !== uid
//     (entrenador viendo a un atleta) no se escribe nada.
import { arrayRemove, arrayUnion, collection, deleteField, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, startAfter, updateDoc, where } from 'firebase/firestore';
import { auth, db } from '../firebaseConfig';
import * as perfLog from './perfLog';
import { calcularDigest, mesKeyDe, redondearDigest } from './curvasDigest';

const MES_TTL = 5 * 60 * 1000;
const META_TTL = 60 * 1000;
const TOPE_BYTES_MES = 900 * 1024; // ~900 KB por documento mensual (guarda del spec)

const mesCache = {};            // `${uid}:${mes}` -> { ts, acts, oversize }
const metaCache = {};           // uid -> { ts, val }
const inflightMeses = {};       // `${uid}:${mes}` -> promise
const inflightBackfill = {};    // uid -> promise
const inflightPendientes = {};  // uid -> promise

const esPropietario = (uid) => auth?.currentUser?.uid === uid;

const chunksOf = (arr, n) => {
  const out = [];

  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }

  return out;
};

function fechaMsDe(fecha) {
  if (fecha == null) return 0;
  if (typeof fecha.toMillis === 'function') return fecha.toMillis();
  if (fecha instanceof Date) return fecha.getTime();
  const ms = new Date(fecha).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function mesesEntre(desdeMs, hastaMs) {
  const out = [];
  const ini = new Date(desdeMs);
  const fin = new Date(hastaMs);
  const pad = (n) => String(n).padStart(2, '0');
  let y = ini.getFullYear();
  let m = ini.getMonth();

  for (;;) {
    if (y > fin.getFullYear() || (y === fin.getFullYear() && m > fin.getMonth())) break;
    out.push(`${y}-${pad(m + 1)}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }

  return out;
}

/* ── Meta ── */
export async function leerMeta(uid) {
  if (!uid) return null;
  const cc = metaCache[uid];

  if (cc && Date.now() - cc.ts < META_TTL) {
    return cc.val;
  }

  try {
    const ms = await getDoc(doc(db, 'analyticsCurves', uid));
    const val = ms.exists() ? ms.data() : null;
    metaCache[uid] = { ts: Date.now(), val };
    perfLog.contar('curvas.meta', 1, perfLog.bytesDe(val));
    return val;
  } catch (e) {
    console.warn('[curvasStore] leerMeta falló:', e.message);
    return null;
  }
}

/* ── Meses ── */
async function leerMes(uid, mes) {
  const key = `${uid}:${mes}`;
  const cc = mesCache[key];

  if (cc && Date.now() - cc.ts < MES_TTL) {
    perfLog.cacheHit('storage');
    return cc;
  }

  if (inflightMeses[key]) return inflightMeses[key];

  const p = (async () => {
    perfLog.cacheMiss('storage');
    const ms = await getDoc(doc(db, 'analyticsCurves', uid, 'months', mes));
    const data = ms.exists() ? ms.data() : {};
    const val = { ts: Date.now(), acts: data.acts || {}, oversize: !!data.oversize };
    mesCache[key] = val;
    perfLog.contar('curvas.meses', 1, perfLog.bytesDe(data));
    return val;
  })();

  inflightMeses[key] = p;
  p.finally(() => { if (inflightMeses[key] === p) delete inflightMeses[key]; });
  return p;
}

// Lee los documentos mensuales que cubren el período y devuelve la lista
// PLANA de digests. Para 'todo' (desdeMs null) arranca en el mes del primer
// entreno conocido (meta.primerMes, lo fija el backfill) o 24 meses atrás.
export async function leerMeses(uid, desdeMs) {
  if (!uid) return [];
  let desde = desdeMs;

  if (desde == null) {
    let primerMes = null;

    try {
      const meta = await leerMeta(uid);
      primerMes = meta?.primerMes || null;
    } catch (e) {}

    if (!primerMes) {
      primerMes = mesKeyDe(Date.now() - 24 * 31 * 24 * 3600 * 1000);
    }

    desde = new Date(Number(primerMes.slice(0, 4)), Number(primerMes.slice(5, 7)) - 1, 1).getTime();
  }

  const meses = mesesEntre(desde, Date.now());
  const leidos = await Promise.all(meses.map((m) => leerMes(uid, m)));
  const digests = [];

  for (const r of leidos) {
    if (!r) continue;

    if (r.oversize) {
      // Mes sobredimensionado: el motor debe usar legacy para él.
      throw new Error('mes de curvas sobredimensionado');
    }

    for (const dg of Object.values(r.acts || {})) {
      digests.push(dg);
    }
  }

  return digests;
}

// Invalida las cachés en memoria de meses/meta de un usuario (se llama al
// editar/borrar entrenos para no servir digests obsoletos).
export function invalidarCacheMeses(uid) {
  if (!uid) return;
  Object.keys(mesCache)
    .filter((k) => k.startsWith(`${uid}:`))
    .forEach((k) => delete mesCache[k]);
  delete metaCache[uid];
}

/* ── Escrituras ── */
export async function guardarDigest(uid, workoutId, digest) {
  if (!uid || !workoutId || !digest) return { ok: false };
  if (!esPropietario(uid)) return { ok: false, motivo: 'noPropietario' };

  const f = Number(digest.f);

  if (!Number.isFinite(f) || f <= 0) return { ok: false };

  const mes = mesKeyDe(f);
  const redondeado = redondearDigest(digest);

  try {
    const cc = mesCache[`${uid}:${mes}`];

    // Guarda de tamaño: si el documento mensual serializado supera ~900 KB,
    // se omite el digest y se marca el mes para que el motor use legacy.
    if (cc && cc.acts) {
      const nuevo = { ...cc.acts, [workoutId]: redondeado };
      const bytes = perfLog.bytesDe(nuevo);

      if (bytes > TOPE_BYTES_MES) {
        console.warn(`[curvasStore] mes ${mes} supera ~900 KB (${bytes} B); se omite el digest`);
        try {
          await setDoc(doc(db, 'analyticsCurves', uid, 'months', mes), { v: 1, oversize: true }, { merge: true });
          cc.oversize = true;
        } catch (e) {}
        return { ok: false, motivo: 'tamano' };
      }
    }

    try {
      // Ruta de campo acts.<id>: idempotente, sin lectura previa.
      await updateDoc(doc(db, 'analyticsCurves', uid, 'months', mes), { [`acts.${workoutId}`]: redondeado, updatedAt: serverTimestamp() });
    } catch (e) {
      // Documento mensual inexistente → se crea con merge. Si el documento
      // EXISTE pero updateDoc falló por otra razón, se reintenta una vez para
      // no pisar los digests ya guardados (setDoc merge sustituiría `acts`).
      try {
        const snap = await getDoc(doc(db, 'analyticsCurves', uid, 'months', mes));

        if (snap.exists()) {
          await updateDoc(doc(db, 'analyticsCurves', uid, 'months', mes), { [`acts.${workoutId}`]: redondeado, updatedAt: serverTimestamp() });
        } else {
          await setDoc(doc(db, 'analyticsCurves', uid, 'months', mes), { v: 1, acts: { [workoutId]: redondeado }, updatedAt: serverTimestamp() }, { merge: true });
        }
      } catch (e2) {
        throw e2;
      }
    }

    if (cc && cc.acts) cc.acts = { ...cc.acts, [workoutId]: redondeado };
    return { ok: true };
  } catch (e) {
    console.warn('[curvasStore] guardarDigest falló:', e.message);
    return { ok: false };
  }
}

export async function quitarDigest(uid, workoutId, fechaMs) {
  if (!uid || !workoutId) return { ok: false };
  if (!esPropietario(uid)) return { ok: false, motivo: 'noPropietario' };

  const mes = mesKeyDe(fechaMs);

  try {
    await updateDoc(doc(db, 'analyticsCurves', uid, 'months', mes), { [`acts.${workoutId}`]: deleteField() });
    const cc = mesCache[`${uid}:${mes}`];

    if (cc && cc.acts) delete cc.acts[workoutId];
    return { ok: true };
  } catch (e) {
    // Documento o campo inexistentes: el estado deseado ya se cumple.
    console.warn('[curvasStore] quitarDigest (tolerado):', e.message);
    return { ok: false };
  }
}

export async function marcarPendiente(uid, workoutId) {
  if (!uid || !workoutId) return { ok: false };
  if (!esPropietario(uid)) return { ok: false, motivo: 'noPropietario' };

  try {
    await setDoc(doc(db, 'analyticsCurves', uid), { v: 1, pendientes: arrayUnion(workoutId) }, { merge: true });
    return { ok: true };
  } catch (e) {
    console.warn('[curvasStore] marcarPendiente falló:', e.message);
    return { ok: false };
  }
}

/* ── Pendientes ── */
// Procesa hasta `max` entrenos pendientes: lee resumen + registros/data,
// recalcula el digest y lo guarda; saca de la lista los procesados, los que
// ya no existen y los que no cumplen el filtro de curvas.
export function procesarPendientes(uid, { max = 40 } = {}) {
  if (!uid) return Promise.resolve({ procesados: 0 });
  if (!esPropietario(uid)) return Promise.resolve({ procesados: 0, motivo: 'noPropietario' });
  if (inflightPendientes[uid]) return inflightPendientes[uid];

  const p = (async () => {
    let procesados = 0;
    const quitados = [];
    const pendientesFallidos = [];

    try {
      const metaSnap = await getDoc(doc(db, 'analyticsCurves', uid));
      const pend = metaSnap.exists() ? (metaSnap.data().pendientes || []) : [];

      if (!pend.length) return { procesados: 0 };

      for (const id of pend.slice(0, Math.max(1, Number(max) || 40))) {
        try {
          const ws = await getDoc(doc(db, 'entrenamientos', id));

          if (!ws.exists()) {
            quitados.push(id);
            continue;
          }

          const w = ws.data();
          const fechaMs = fechaMsDe(w.fecha);

          if (!(w.estado === 'completo' || (w.duracion || 0) > 0)) {
            // Deja de cumplir el filtro de curvas (p. ej. el usuario vació la
            // duración): hay que quitar su digest del mes, o seguiría contando.
            try {
              await quitarDigest(uid, id, fechaMs || Date.now());
            } catch (e) {}
            quitados.push(id);
            continue;
          }

          const rs = await getDoc(doc(db, 'entrenamientos', id, 'registros', 'data'));

          if (!rs.exists()) {
            quitados.push(id);
            continue;
          }

          const pts = rs.data().puntos || [];
          perfLog.contar('curvas.registros', 1, perfLog.bytesDe(rs.data()));

          if (!pts.length) {
            quitados.push(id);
            continue;
          }

          const dg = calcularDigest(pts, w.tipo, fechaMs);
          const res = await guardarDigest(uid, id, dg);

          if (!res || !res.ok) {
            // NO se saca de `pendientes`: si se descartara aquí, el digest se
            // perdería hasta que alguien pulsara refrescar. Se reintenta en la
            // siguiente pasada (rotación: al final de la lista).
            pendientesFallidos.push(id);
            continue;
          }

          procesados++;
        } catch (e) {
          console.warn('[curvasStore] pendiente falló para', id, ':', e.message);
          pendientesFallidos.push(id);
          continue;
        }

        quitados.push(id);
      }

      // Los fallidos se quitan y se vuelven a añadir al final para no bloquear
      // la cola (arrayUnion los añade al final).
      if (pendientesFallidos.length) {
        try {
          await updateDoc(doc(db, 'analyticsCurves', uid), {
            pendientes: arrayRemove(...pendientesFallidos),
          });
          await updateDoc(doc(db, 'analyticsCurves', uid), {
            pendientes: arrayUnion(...pendientesFallidos),
          });
        } catch (e) {
          console.warn('[curvasStore] rotación de pendientes falló:', e.message);
        }
      }

      if (quitados.length) {
        try {
          await updateDoc(doc(db, 'analyticsCurves', uid), { pendientes: arrayRemove(...quitados) });
          // El meta cacheado seguiría mostrando esos ids hasta 60 s: se
          // actualiza en memoria (si no, leerMeta devuelve pendientes fantasma
          // y el motor vuelve a entrar aquí en cada cálculo).
          const mc = metaCache[uid];

          if (mc && mc.val) {
            const vivos = new Set(mc.val.pendientes || []);

            for (const id of quitados) vivos.delete(id);
            mc.val = { ...mc.val, pendientes: [...vivos] };
          }
        } catch (e) {
          console.warn('[curvasStore] arrayRemove de pendientes falló:', e.message);
        }
      }

      return { procesados, quitados: quitados.length };
    } catch (e) {
      console.warn('[curvasStore] procesarPendientes falló:', e.message);
      return { procesados: 0 };
    }
  })();

  inflightPendientes[uid] = p;
  p.finally(() => { if (inflightPendientes[uid] === p) delete inflightPendientes[uid]; });
  return p;
}

/* ── Backfill y reconciliación ── */
// Si meta.backfillV === 1 y no es force, no hace nada. Si no, pagina los
// resúmenes (userId == uid, orderBy fecha desc, limit 100, startAfter),
// filtra estado === 'completo' || duracion > 0, y para cada actividad sin
// digest (o con tipo/f distintos del resumen) lee registros/data con
// concurrencia 4, calcula el digest y guarda TODAS las actividades de un
// mismo mes en UNA sola escritura. Al terminar pone backfillV: 1 en el meta.
// En force elimina además de los meses los digests cuyo workoutId ya no
// existe en los resúmenes. Interrumpible y reanudable (idempotente).
export function backfill(uid, { force = false } = {}) {
  if (!uid) return Promise.resolve({ ok: false });
  if (!esPropietario(uid)) return Promise.resolve({ ok: false, motivo: 'noPropietario' });
  if (inflightBackfill[uid]) return inflightBackfill[uid];

  const p = (async () => {
    let leidos = 0;
    let actas = 0;
    let escritos = 0;

    try {
      const meta = await leerMeta(uid);

      if (meta?.backfillV === 1 && !force) {
        return { ok: true, skip: 'ya' };
      }

      const resumenes = [];
      let last = null;

      for (;;) {
        const cs = [where('userId', '==', uid), orderBy('fecha', 'desc'), limit(100)];
        if (last) cs.push(startAfter(last));
        const snap = await getDocs(query(collection(db, 'entrenamientos'), ...cs));
        leidos += snap.size;

        snap.forEach((ds) => {
          resumenes.push({ id: ds.id, ...ds.data() });
        });

        perfLog.contar('backfill.resumenes', snap.size, perfLog.bytesDe(snap.docs.map((d) => d.data())));

        if (snap.size < 100) break;
        last = snap.docs[snap.docs.length - 1];
      }

      const validos = resumenes
        .filter((w) => w.estado === 'completo' || (w.duracion || 0) > 0)
        .map((w) => ({ ...w, fechaMs: fechaMsDe(w.fecha) }));

      const idsValidos = new Set(validos.map((w) => w.id));

      // Mes del primer entreno conocido (para leerMeses con 'todo').
      let primerMs = 0;

      for (const w of validos) {
        if (w.fechaMs > 0 && (primerMs === 0 || w.fechaMs < primerMs)) primerMs = w.fechaMs;
      }

      const porMes = {};

      for (const w of validos) {
        const mes = mesKeyDe(w.fechaMs);
        (porMes[mes] || (porMes[mes] = [])).push(w);
      }

      for (const mes of Object.keys(porMes)) {
        const mesRef = doc(db, 'analyticsCurves', uid, 'months', mes);
        let acts = {};
        let mesExiste = false;

        try {
          const msnap = await getDoc(mesRef);
          mesExiste = msnap.exists();
          if (mesExiste) acts = msnap.data().acts || {};
        } catch (e) {}

        const aEscribir = {};
        const aQuitar = [];

        if (force) {
          for (const id of Object.keys(acts)) {
            if (!idsValidos.has(id)) aQuitar.push(id);
          }
        }

        const pendBuild = [];

        for (const w of porMes[mes]) {
          const dg = acts[w.id];

          if (dg && dg.tipo === w.tipo && dg.f === w.fechaMs && !aQuitar.includes(w.id)) {
            continue;
          }

          pendBuild.push(w);
        }

        for (const chunk of chunksOf(pendBuild, 4)) {
          await Promise.all(chunk.map(async (w) => {
            try {
              const rs = await getDoc(doc(db, 'entrenamientos', w.id, 'registros', 'data'));
              perfLog.contar('backfill.registros', 1, perfLog.bytesDe(rs.data()));

              if (!rs.exists()) return;
              const pts = rs.data().puntos || [];

              if (!pts.length) return;
              const dg = calcularDigest(pts, w.tipo, w.fechaMs);
              aEscribir[w.id] = dg;
            } catch (e) {
              console.warn('[curvasStore] backfill registros de', w.id, ':', e.message);
            }
          }));
        }

        if (Object.keys(aEscribir).length || aQuitar.length) {
          // Guarda de tamaño TAMBIÉN aquí: si el mes se pasara de ~900 KB,
          // Firestore rechazaría la escritura (>1 MiB) y el mes quedaría sin
          // digests mientras el meta ya marca backfillV=1 (pérdida silenciosa).
          const actsFinal = { ...acts, ...aEscribir };
          for (const id of aQuitar) delete actsFinal[id];

          if (perfLog.bytesDe(actsFinal) > TOPE_BYTES_MES) {
            console.warn(`[curvasStore] mes ${mes} supera ~900 KB en backfill; se marca oversize (se usará legacy para ese mes)`);
            try {
              await setDoc(mesRef, { v: 1, oversize: true }, { merge: true });
              const cco = mesCache[`${uid}:${mes}`];
              if (cco) cco.oversize = true;
            } catch (e) {}
            continue;
          }

          const upd = { v: 1, updatedAt: serverTimestamp() };

          for (const id of Object.keys(aEscribir)) upd[`acts.${id}`] = aEscribir[id];
          for (const id of aQuitar) upd[`acts.${id}`] = deleteField();

          try {
            if (mesExiste) {
              await updateDoc(mesRef, upd);
            } else {
              // setDoc no admite rutas punteadas: se pasa `acts` como objeto
              // (mes nuevo → no hay digests que conservar ni que quitar).
              await setDoc(mesRef, { v: 1, updatedAt: serverTimestamp(), acts: aEscribir }, { merge: true });
            }
          } catch (e) {
            // Reintento con la existencia REAL del documento (pudo crearse
            // mientras tanto); si existe se usa updateDoc para no pisar acts.
            try {
              const snap = await getDoc(mesRef);

              if (snap.exists()) await updateDoc(mesRef, upd);
              else await setDoc(mesRef, { v: 1, updatedAt: serverTimestamp(), acts: aEscribir }, { merge: true });
            } catch (e2) {
              console.warn('[curvasStore] backfill escritura del mes', mes, ':', e2.message);
            }
          }

          const cc = mesCache[`${uid}:${mes}`];

          if (cc && cc.acts) {
            cc.acts = { ...cc.acts, ...aEscribir };

            for (const id of aQuitar) delete cc.acts[id];
          }

          actas += Object.keys(aEscribir).length;
          escritos++;
        }
      }

      // force: limpia también los meses SIN actividades válidas actuales.
      if (force) {
        try {
          const todos = await getDocs(collection(db, 'analyticsCurves', uid, 'months'));

          todos.forEach((ds) => {
            const mes = ds.id;
            const acts = ds.data().acts || {};

            if (porMes[mes]) return; // ya revisado arriba

            const aQuitar = Object.keys(acts).filter((id) => !idsValidos.has(id));

            if (aQuitar.length) {
              const upd = { v: 1, updatedAt: serverTimestamp() };

              for (const id of aQuitar) upd[`acts.${id}`] = deleteField();

              updateDoc(doc(db, 'analyticsCurves', uid, 'months', mes), upd).catch(() => {});
              escritos++;
            }
          });
        } catch (e) {
          console.warn('[curvasStore] backfill force limpieza:', e.message);
        }
      }

      const metaUpd = { v: 1, backfillV: 1 };

      if (primerMs > 0) metaUpd.primerMes = mesKeyDe(primerMs);

      try {
        await setDoc(doc(db, 'analyticsCurves', uid), metaUpd, { merge: true });
        metaCache[uid] = { ts: Date.now(), val: { ...(meta || {}), ...metaUpd } };
      } catch (e) {
        console.warn('[curvasStore] backfill meta:', e.message);
      }

      return { ok: true, actas, escritos, leidos };
    } catch (e) {
      console.warn('[curvasStore] backfill falló:', e.message);
      return { ok: false };
    }
  })();

  inflightBackfill[uid] = p;
  p.finally(() => { if (inflightBackfill[uid] === p) delete inflightBackfill[uid]; });
  return p;
}
