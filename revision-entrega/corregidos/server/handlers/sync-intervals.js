// api/sync-intervals.js
const admin = require('../lib/firebase');
const { getUid } = require('../lib/auth');
const {
  getConnection,
  computeEsfuerzoIntervals,
  calcularTrimpDesdeMuestras,
  mapFuenteEsfuerzo,
  fetchActivities,
  mapIntervalsSport,
  paceFromSpeed,
  pickTrainingLoad,
  effortNeedsUpdate,
} = require('../lib/intervals');
const { fetchAndStoreDetail, DETAIL_VERSION } = require('../lib/intervalsDetail');
const { uploadPendingWorkouts, syncPlannedUpdates } = require('../lib/uploadWorkouts');
const { fetchAndStoreWellness } = require('../lib/wellness');
const { sendPushForSync, notifyCoachAfterSync } = require('../lib/push');
const { comprobarRecords, notificarRecords } = require('../lib/records');
// Cálculo de digests de curvas EN EL SERVIDOR (ver lib/workers.js). Antes el
// servidor solo marcaba `analyticsCurves/{uid}.pendientes` y el móvil tenía que
// abrir Análisis para vaciarla; con esto las curvas quedan al día al terminar
// la sincronización, sin depender del dispositivo.
const { enSegundoPlano } = require('../lib/workers');

const db = admin.firestore();
const MAX_DETAIL_OPS = 8;

function toISODate(date) {
  return date.toISOString().split('T')[0];
}

function parseStartDate(activity) {
  const candidates = [
    activity.start_time,
    activity.start_time_local,
    activity.start_date,
    activity.startDate,
    activity.date,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// ── Esfuerzo (TSS) ──
// pickTrainingLoad() y effortNeedsUpdate() viven en lib/intervals.js para que
// sync, detalle y fitness usen SIEMPRE el mismo criterio. Sólo se leen campos
// con escala TSS (icu_training_load / training_load): strain_score (Xert xSS)
// y suffer_score (Strava) son baremos distintos y provocaban que la app
// mostrara 27 donde TrainingPeaks mostraba 83.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const uid = await getUid(req);
    const connection = await getConnection(uid);

    // Perfil del atleta (umbrales/zonas) y wellness del atleta (FC de reposo
    // diaria) para calcular el esfuerzo con el MISMO algoritmo que la app:
    // TRIMP de FC (perfil.fcReposo → wellness.rhr → 60) → rTSS → potencia,
    // antes que icu_training_load.
    let perfil = null;
    let wellnessDays = {};
    try {
      const pSnap = await db.collection('perfiles').doc(uid).get();
      if (pSnap.exists) perfil = pSnap.data();
    } catch (e) {}
    try {
      const wSnap = await db.collection('wellness').doc(uid).get();
      if (wSnap.exists) wellnessDays = wSnap.data().days || {};
    } catch (e) {}

    // La LISTA de Intervals.icu a veces no trae la FC media: si no hay FC ni
    // potencia, se pide la actividad completa (/activity/{id}) para poder
    // calcular hrTSS con la escala TSS correcta en vez de caer a icu_load.
    const icuAuth = 'Basic ' + Buffer.from(`API_KEY:${connection.apiKey}`).toString('base64');
    const numOk = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
    async function enrichActivity(activity, activityId) {
      if (numOk(activity.avg_hr) || numOk(activity.average_heartrate) || numOk(activity.avg_watts)) return activity;
      try {
        const r = await fetch(`https://intervals.icu/api/v1/activity/${activityId}`, { headers: { Authorization: icuAuth } });
        if (!r.ok) return activity;
        const full = await r.json();
        return {
          ...activity,
          avg_hr: full.avg_hr ?? full.average_heartrate ?? activity.avg_hr,
          max_hr: full.max_hr ?? full.max_heart_rate ?? activity.max_hr,
        };
      } catch (e) { return activity; }
    }

    const now = new Date();
    const defaultOldest = new Date(now);
    defaultOldest.setDate(now.getDate() - 30);

    // Ventana con red de seguridad: aunque lastSyncDate sea de hoy, se
    // re-miran SIEMPRE los últimos 3 días (los docs ya existentes se saltan
    // barato en el ramo "skipped"). Así un entreno que sube tarde a
    // intervals.icu, o que falló una vez, no se queda fuera para siempre.
    const minOldest = toISODate(new Date(now.getTime() - 7 * 86400000));   // red de 7 días: borrados/retardados recientes siempre se re-miran
    const baseOldest = connection.lastSyncDate || toISODate(defaultOldest);
    const oldest = req.body?.oldest || (baseOldest < minOldest ? baseOldest : minOldest);
    const newest = req.body?.newest || toISODate(now);

    console.log(`[sync-intervals] uid=${uid} oldest=${oldest} newest=${newest}`);

    // ── 0) Comprobación de despliegue del matcher (solo log) ──
    try {
      require('../lib/matcher');
      console.log('[sync-intervals] matcher v2 cargado');
    } catch (e) {
      console.warn('[sync-intervals] matcher NO disponible:', e.message);
    }

    // ── 1) Subir a Intervals.icu los entrenos de la app pendientes ──
    let uploaded = 0;
    try {
      uploaded = await uploadPendingWorkouts({ admin, db, connection, uid });
      if (uploaded > 0) console.log(`[sync-intervals] Entrenos subidos a Intervals.icu: ${uploaded}`);
      try {
        await syncPlannedUpdates({ admin, db, connection, uid });
      } catch (e) {
        console.warn('[sync-intervals] syncPlannedUpdates:', e.message);
      }
    } catch (e) {
      console.warn('[sync-intervals] Error subiendo pendientes:', e.message);
    }

    // ── 2) Bajar actividades ──
    const activities = await fetchActivities(connection, oldest, newest);

    if (!Array.isArray(activities)) {
      console.error('[sync-intervals] Respuesta no es array:', JSON.stringify(activities).slice(0, 300));
      return res.status(502).json({ error: 'Respuesta inesperada de Intervals.icu' });
    }

    console.log(`[sync-intervals] Actividades recibidas: ${activities.length}`);

    let synced = 0;
    let skipped = 0;
    let detailOps = 0;
    let backfilled = 0;
    let corregidos = 0;
    const errorsList = [];
    const syncedList = [];   // entrenos creados en esta pasada (para el desplegable del push)

    for (const activity of activities) {
      const activityId = activity?.id ?? 'sin-id';

      try {
        const fileId = `intervals_${activityId}`;
        const docRef = db.collection('entrenamientos').doc(fileId);
        const existing = await docRef.get();

        if (existing.exists) {
          skipped++;

          // ── Esfuerzo: alinea/rectifica con el MISMO criterio que la app ──
          // Primero el TRIMP de Banister INTEGRANDO las muestras de FC que el
          // detalle guardó en registros/data: es la MISMA variante que usa el
          // botón «recargar esfuerzo» de la app con los registros cargados, la
          // que coincide con TrainerPlan. Sin eso, cada sync revertía el valor
          // que la app había calculado con la FC completa del entreno y lo
          // dejaba en la aproximación de FC media. Sin muestras aprovechables
          // se cae al criterio de siempre: FC media → rTSS → potencia →
          // icu_training_load. Nunca se pisa un esfuerzo editado a mano
          // (esfuerzoManual === true).
          const actEnr = await enrichActivity(activity, activityId);
          const mainBf = existing.data() || {};
          let loadLista = null;
          try {
            const regSnap = await docRef.collection('registros').doc('data').get();
            const pts = regSnap.exists ? (regSnap.data().puntos || []) : [];
            if (pts.length >= 2) {
              const fechaDoc = mainBf.fecha?.toDate ? mainBf.fecha.toDate() : parseStartDate(activity);
              loadLista = calcularTrimpDesdeMuestras(pts, perfil, fechaDoc, wellnessDays);
            }
          } catch (e) {}
          if (!loadLista) loadLista = computeEsfuerzoIntervals(actEnr, perfil, parseStartDate(activity), wellnessDays) || pickTrainingLoad(activity);
          console.log(`[esfuerzo-rectifica] ${activityId}: ${loadLista ? loadLista.valor : 'null'} (${loadLista ? loadLista.fuente : 'sin-datos'}) guardado=${mainBf.esfuerzo}`);
          // Detalle guardado: una sola lectura para alinear duración (Σ vueltas)
          // y para el esfuerzo manual.
          let detBf = null;
          try {
            const detSnapBf = await docRef.collection('detalles').doc('data').get();
            detBf = detSnapBf.exists ? detSnapBf.data() : null;
          } catch (e) {}
          // Alinear la duración del doc con la SUMA DE VUELTAS del detalle: es
          // el mismo número que muestra la fila Σ del apartado Vueltas, el
          // tiempo bueno del entreno (sin el rato parado para calentar que el
          // elapsed sí cuenta). Sin vueltas guardadas se cae al ELAPSED como
          // red de seguridad (los doc antiguos se crearon con moving_time).
          let durObjetivo = Number(actEnr.elapsed_time ?? actEnr.duration);
          const lapsGuardados = (Array.isArray(detBf?.vueltas) && detBf.vueltas.length)
            ? detBf.vueltas
            : (Array.isArray(mainBf.vueltas) ? mainBf.vueltas : []);
          if (lapsGuardados.length) {
            const sumaVueltasGuardadas = Math.round(lapsGuardados.reduce((a, v) => a + (Number(v && v.tiempo) || 0), 0));
            if (sumaVueltasGuardadas > 0) durObjetivo = sumaVueltasGuardadas;
          }
          if (Number.isFinite(durObjetivo) && durObjetivo > 0 && Math.abs((Number(mainBf.duracion) || 0) - durObjetivo) > 5 && mainBf.duracionManual !== true) {
            try { await docRef.update({ duracion: durObjetivo }); mainBf.duracion = durObjetivo; } catch (e) {}
          }
          if (loadLista) {
            try {
              const manualBf = detBf?.esfuerzoManual === true || mainBf.esfuerzoManual === true;
              const fuenteLista = mapFuenteEsfuerzo(loadLista.fuente);

              if (effortNeedsUpdate(detBf?.esfuerzo, loadLista.valor, manualBf)) {
                await docRef.collection('detalles').doc('data').set({
                  esfuerzo: loadLista.valor,
                  tss: loadLista.valor,
                  esfuerzoFuente: fuenteLista,
                }, { merge: true });
                backfilled++;
              }
              if (effortNeedsUpdate(mainBf.esfuerzo, loadLista.valor, manualBf)) {
                await docRef.update({ esfuerzo: loadLista.valor, esfuerzoFuente: fuenteLista });
                corregidos++;
              }
            } catch (e) {
              console.warn(`[sync-intervals] Esfuerzo ${activityId}:`, e.message);
            }
          }

          if (detailOps < MAX_DETAIL_OPS) {
            const detSnap = await docRef.collection('detalles').doc('data').get();
            const det = detSnap.exists ? detSnap.data() : null;
            // Vueltas vacías = reintento (hasta 3 syncs): antes un fallo
            // puntual dejaba vueltasSource:'ninguna' y NADIE volvía a pedir
            // las vueltas (ni el server ni la app): deadlock "sin vueltas".
            const sinVueltas = !Array.isArray(det.vueltas) || det.vueltas.length === 0;
            const needsDetail =
              !det ||
              det.detailVersion !== DETAIL_VERSION ||
              det.hasRuta !== true ||
              (sinVueltas && (det.vueltasRetries || 0) < 3);
            if (needsDetail) {
              await fetchAndStoreDetail({ admin, db, connection, docRef, activityId });
              detailOps++;
            }
          }
          continue;
        }

        const startDate = parseStartDate(activity);
        if (!startDate) {
          console.error(`[sync-intervals] Actividad ${activityId} sin fecha válida`);
          errorsList.push({ id: activityId, error: 'Sin fecha válida' });
          continue;
        }

        const tipo = mapIntervalsSport(activity.type || activity.sport);
        const titulo = activity.name || activity.title || tipo;

        const distanciaMetros = Number(activity.distance ?? 0);
        const distancia = Number((distanciaMetros / 1000).toFixed(2));
        // Duración inicial = tiempo SIN PAUSAS (moving_time, lo que usa
        // TrainerPlan): el cronómetro parado no cuenta. Sin moving se cae al
        // elapsed como red de seguridad. En cuanto el detalle descargue las
        // vueltas, fetchAndStoreDetail realinea con la Σ de vueltas.
        const duracion = Number(activity.moving_time ?? activity.elapsed_time ?? activity.duration ?? 0);
        const fcMedia = Number(activity.avg_hr ?? activity.average_heartrate ?? 0);
        const fcMax = Number(activity.max_hr ?? activity.max_heart_rate ?? 0);
        const potenciaMedia = Number(activity.avg_watts ?? activity.average_watts ?? 0);
        const elevacion = Number(activity.elevation_gain ?? activity.total_elevation_gain ?? 0);
        const calorias = Number(activity.calories ?? 0);
        const avgSpeed = Number(
          activity.avg_speed ?? activity.average_speed ?? (duracion > 0 ? distanciaMetros / duracion : 0)
        );
        // El cálculo de esfuerzo NUNCA puede tumbar la actividad: si lanzara
        // con una forma de datos rara, el catch por actividad dejaba el
        // entreno SIN CREAR para siempre (y el push solo contaba los otros).
        // Ahora se crea con esfuerzo 0 y se rectifica en syncs posteriores.
        let esfuerzoVal = 0;
        let esfuerzoFuente = null;
        try {
          const actEnrN = await enrichActivity(activity, activityId);
          const esfuerzoLoad = computeEsfuerzoIntervals(actEnrN, perfil, startDate, wellnessDays) || pickTrainingLoad(activity);
          esfuerzoVal = esfuerzoLoad ? esfuerzoLoad.valor : 0;
          console.log(`[esfuerzo] ${activityId}: ${esfuerzoVal} (${esfuerzoLoad ? esfuerzoLoad.fuente : 'sin-datos'})`);
          esfuerzoFuente = esfuerzoLoad ? mapFuenteEsfuerzo(esfuerzoLoad.fuente) : null;
        } catch (eEsf) {
          console.warn(`[sync-intervals] esfuerzo ${activityId} falló (${eEsf.message}); se crea con esfuerzo 0`);
        }

        await docRef.set({
          userId: uid,
          id_archivo: fileId,
          source: 'intervals.icu',
          intervalsId: String(activityId),
          fecha: admin.firestore.Timestamp.fromDate(startDate),
          tipo,
          titulo,
          distancia,
          duracion,
          'fc-media': fcMedia,
          estado: 'completo',
          esfuerzo: esfuerzoVal,
          esfuerzoFuente,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Para el desplegable del push de sincronización: este entreno recién creado
        syncedList.push({
          id: fileId,
          titulo,
          tipo,
          fechaStr: startDate ? startDate.toISOString().slice(0, 10) : '',
        });

        await docRef.collection('detalles').doc('data').set({
          calorias,
          fcMax,
          ritmo: tipo === 'Ciclismo' ? (avgSpeed * 3.6).toFixed(1) : paceFromSpeed(avgSpeed),
          elevacionMin: 0,
          elevacionMax: 0,
          cadencia: Number(activity.avg_cadence ?? activity.cadence ?? 0),
          desnivelPos: elevacion,
          temperatura: Number(activity.avg_temp ?? activity.temperature ?? 0),
          potenciaMedia,
          esfuerzo: esfuerzoVal,
          tss: esfuerzoVal,
          esfuerzoFuente,
          notas: '',
          cargaPercibida: '',
          enlace: '',
          descripcion: activity.description || '',
          pasos: [],
          comentarios: [],
          vueltas: [],
          completado: false,
          garminSynced: false,
        }, { merge: true });

        synced++;

        // ── Marcas personales: ¿el entreno bate alguna marca del atleta? ──
        // Solo para entrenos completados con distancia y duración. Si bate
        // alguna, se etiqueta el doc (records: títulos) para la medalla en
        // las tarjetas, se actualizan las marcas del perfil y se avisa con
        // push + archivo en notificaciones.
        try {
          const resPR = comprobarRecords(perfil, {
            id: fileId, tipo, distancia, duracion,
            fecha: admin.firestore.Timestamp.fromDate(startDate),
          });
          if (resPR.batidos.length || resPR.defs) {
            await docRef.update({ records: resPR.batidos.map((b) => b.titulo) });
            const updPerfil = {};
            if (resPR.defs) updPerfil.marcasDefs = resPR.defs;
            if (resPR.bests) updPerfil.marcasBest = resPR.bests;
            // OJO: set()+merge NO interpreta claves con puntos como rutas de
            // campo (acababan en un campo literal "marcasResults.xxx" y la
            // marca no aparecía en la app): se anida el mapa de verdad.
            for (const b of resPR.batidos) {
              updPerfil.marcasResults = updPerfil.marcasResults || {};
              updPerfil.marcasResults[b.defId] = admin.firestore.FieldValue.arrayUnion({
                id: `r_${b.defId}_${b.fecha.getTime()}`,
                valor: b.valor,
                fecha: admin.firestore.Timestamp.fromDate(b.fecha),
                notas: titulo,
                workoutId: fileId,
              });
            }
            // set+merge (no update): si el doc del perfil no existiera,
            // update lanzaría y se perderían las marcas del entreno.
            if (Object.keys(updPerfil).length) await db.collection('perfiles').doc(uid).set(updPerfil, { merge: true });
            if (resPR.defs) perfil.marcasDefs = resPR.defs;
            if (resPR.bests) perfil.marcasBest = resPR.bests;
            if (resPR.resultados) perfil.marcasResults = resPR.resultados;
            if (resPR.batidos.length) {
              await notificarRecords(require('../lib/push'), uid, perfil, resPR.batidos, titulo, fileId);
              console.log(`[records] ${resPR.batidos.length} marca(s) batida(s) en ${fileId}: ${resPR.batidos.map((b) => b.titulo).join(', ')}`);
            }
          }
        } catch (e) { console.warn('[records] falló la comprobación:', e.message); }

        // ── Fusión con un entreno planificado del mismo día ──
        // Fail-safe: si el matcher fallara por cualquier motivo, se
        // ignora y el sync continúa exactamente igual que antes.
        try {
          const { maybeMergeSyncedWithPlan } = require('../lib/matcher');
          const mres = await maybeMergeSyncedWithPlan({
            admin,
            db,
            uid,
            perfil,
            syncedDocId: fileId,
            syncedData: {
              id: fileId,
              fecha: admin.firestore.Timestamp.fromDate(startDate),
              tipo,
              titulo,
              distancia,
              duracion,
            },
          });
          if (mres && mres.merged) {
            console.log(`[sync-intervals] Fusionado con planificado ${mres.planId} (score ${mres.score.toFixed(2)})`);
          }
        } catch (e) {
          console.warn('[sync-intervals] Matcher ignorado por error:', e.message);
        }

        if (detailOps < MAX_DETAIL_OPS) {
          await fetchAndStoreDetail({ admin, db, connection, docRef, activityId });
          detailOps++;
        }
      } catch (err) {
        console.error(`[sync-intervals] Error en actividad ${activityId}:`, err.message);
        errorsList.push({ id: activityId, error: err.message });
      }
    }

    // ── 2b) Reconciliación: repara pares plan↔real de syncs anteriores ──
    try {
      const { reconcileRange } = require('../lib/matcher');
      const rec = await reconcileRange({
        admin,
        db,
        uid,
        perfil,
        from: new Date(oldest),
        to: new Date(newest + 'T23:59:59'),
        maxOps: 10,
      });
      if (rec && rec.merged) console.log(`[sync-intervals] Reconciliados ${rec.merged} pares plan-real`);
    } catch (e) {
      console.warn('[sync-intervals] reconcile ignorado:', e.message);
    }

    // ── 2b-bis) Reparación de planDist/planDur en doc ya fusionados ──
    // Tres motivos por los que un doc fusionado se queda SIN comparativa de
    // distancia (la app pinta "10.00 km" a secas, sin "/ 12.00 km"):
    //   1) fusiones antiguas, calculadas sin las zonas de ritmo del atleta: los
    //      pasos "Zona ritmo" no aportaban km (p. ej. 1.5 km de un rodaje de 10);
    //   2) este pase de reparación estaba ROTO: pedía zonasRitmoDe al matcher,
    //      que no la exportaba → TypeError silencioso dentro del catch y NUNCA
    //      se reparaba nada;
    //   3) además se exigía perfil.zonasRitmo para entrar, así que los atletas
    //      sin zonas genéricas (o con zonas solo por actividad) no se reparaban.
    // Ahora: entra siempre, usa las zonas de la ACTIVIDAD de cada doc, rellena
    // planDist/planDur cuando faltan y corrige los que difieren. Idempotente y
    // acotado (50 docs por sync) hasta converger.
    try {
      const { computePlanMetrics, zonasRitmoDe } = require('../lib/matcher');
      const hayZonas = !!perfil && (
        (Array.isArray(perfil.zonasRitmo) && perfil.zonasRitmo.length) ||
        (perfil.zonasActividad && typeof perfil.zonasActividad === 'object')
      );
      const snapM = await db.collection('entrenamientos')
        .where('userId', '==', uid)
        .where('mergedFromPlanId', '!=', null)
        .limit(50)
        .get();
      let reparados = 0;
      const writes = [];
      snapM.forEach((d) => {
        const w = d.data() || {};
        const zonas = hayZonas ? zonasRitmoDe(perfil, w.tipo) : [];
        const pasos = Array.isArray(w.pasos) ? w.pasos : [];
        // Se pasa el tipo: en Ciclismo las zonas/objetivos de ritmo van en km/h
        // y sin ese dato los km del plan saldrían disparatados (min/km).
        const plan = pasos.length ? computePlanMetrics(pasos, zonas, w.tipo) : { sec: 0, km: 0 };

        // OJO: w.distancia de un doc fusionado es la distancia REAL (el matcher
        // no guarda la del planificado en ningún otro campo), así que NUNCA se
        // usa como planDist: saldría siempre un 100 % falso. El plan solo sale
        // de los pasos; si los pasos no dan km, se deja como estaba.
        const distVieja = Number(w.planDist) > 0 ? Number(w.planDist) : null;
        const durVieja = Number(w.planDur) > 0 ? Number(w.planDur) : null;
        const distNueva = plan.km > 0 ? Math.round(plan.km * 100) / 100 : distVieja;
        const durNueva = plan.sec > 0 ? Math.round(plan.sec) : durVieja;

        if (distNueva == null && durNueva == null) return;   // nada que reparar
        const difD = Math.abs(distVieja || 0) - Math.abs(distNueva || 0);
        const difT = Math.abs(durVieja || 0) - Math.abs(durNueva || 0);
        if (Math.abs(difD) > 0.05 || Math.abs(difT) > 5) {
          const upd = {};
          if (distNueva != null) upd.planDist = distNueva;
          if (durNueva != null) upd.planDur = durNueva;
          if (Object.keys(upd).length) { writes.push(d.ref.update(upd)); reparados++; }
        }
      });
      if (writes.length) await Promise.all(writes);
      if (reparados) console.log(`[sync-intervals] planDist/planDur reparado en ${reparados} doc(s)`);
    } catch (e) {
      console.warn('[sync-intervals] reparación planDist ignorada:', e.message);
    }

    if (synced > 0 || errorsList.length === 0) {
      await db.collection('intervals_connections').doc(uid).update({
        lastSyncDate: toISODate(now),
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // ── 2c) Corrección histórica de esfuerzo (una sola vez por conexión) ──
    // Recorre TODO el historial con una única llamada HTTP y alinea el esfuerzo
    // de cada documento con el TSS de intervals.icu (icu_training_load). Es lo
    // que repara de golpe los entrenos antiguos cuyo esfuerzo se calculó con
    // strain_score / suffer_score (baremos distintos del TSS: por ejemplo 27 en
    // vez de 83). Límites por pasada (400 inspecciones / 80 escrituras, en
    // paralelo de 20 en 20) para no agotar el tiempo de la función; el resto se
    // completa en syncs sucesivos hasta marcar esfuerzoFixDone.
    let backfillHistorico = 0;
    if (!connection.esfuerzoFixDone) {
      try {
        const bfActs = await fetchActivities(connection, '2015-01-01', toISODate(now));
        if (Array.isArray(bfActs)) {
          const candidatos = bfActs.filter((a) => a && a.id && pickTrainingLoad(a));
          const objetivo = candidatos.slice(0, 400);
          const listaCompleta = candidatos.length <= 400;
          let escritos = 0;
          for (let i = 0; i < objetivo.length && escritos < 80; i += 20) {
            const chunk = objetivo.slice(i, i + 20);
            const results = await Promise.all(chunk.map(async (act) => {
              const ref = db.collection('entrenamientos').doc(`intervals_${act.id}`);
              try {
                const snap = await ref.get();
                if (!snap.exists) return false;
                const mainData = snap.data() || {};
                const detRef = ref.collection('detalles').doc('data');
                const detSnap = await detRef.get();
                const det = detSnap.exists ? detSnap.data() : null;
                // Mismo criterio que el resto del sync: TRIMP con las muestras
                // de FC guardadas (si hay) → FC media → rTSS → potencia →
                // icu_training_load. El backfill antiguo forzaba SIEMPRE el
                // icu_training_load crudo y pisaba valores bien calculados.
                let load = null;
                try {
                  const regSnap = await ref.collection('registros').doc('data').get();
                  const pts = regSnap.exists ? (regSnap.data().puntos || []) : [];
                  if (pts.length >= 2) {
                    load = calcularTrimpDesdeMuestras(pts, perfil, mainData.fecha?.toDate ? mainData.fecha.toDate() : parseStartDate(act), wellnessDays);
                  }
                } catch (e) {}
                if (!load) load = computeEsfuerzoIntervals(act, perfil, parseStartDate(act), wellnessDays) || pickTrainingLoad(act);
                const fuenteBf = mapFuenteEsfuerzo(load.fuente);
                const manual = det?.esfuerzoManual === true || mainData.esfuerzoManual === true;
                const faltaDet = effortNeedsUpdate(det?.esfuerzo, load.valor, manual);
                const faltaMain = effortNeedsUpdate(mainData.esfuerzo, load.valor, manual);
                if (!faltaDet && !faltaMain) return false;
                if (faltaDet) {
                  await detRef.set({
                    esfuerzo: load.valor,
                    tss: load.valor,
                    esfuerzoFuente: fuenteBf,
                  }, { merge: true });
                }
                if (faltaMain) {
                  await ref.update({ esfuerzo: load.valor, esfuerzoFuente: fuenteBf });
                }
                return true;
              } catch (e) {
                return false;
              }
            }));
            escritos += results.filter(Boolean).length;
          }
          backfillHistorico = escritos;
          const done = listaCompleta && escritos < 80;
          if (done) {
            await db.collection('intervals_connections').doc(uid).update({
              esfuerzoFixDone: true,
              esfuerzoFixAt: admin.firestore.FieldValue.serverTimestamp(),
              esfuerzoBackfillDone: true,
            });
          }
          console.log(`[sync-intervals] Corrección histórica de esfuerzo: ${escritos} docs (completo=${done})`);
        }
      } catch (e) {
        console.warn('[sync-intervals] Corrección histórica de esfuerzo, error:', e.message);
      }
    }

    // ── 3) Recalcular serie Fitness/Fatigue/Form ──
    try {
      const { computeAndStoreFitness } = require('../lib/fitness');
      const fit = await computeAndStoreFitness({ admin, db, connection, uid });
      if (fit) console.log(`[sync-intervals] fitness recalculado: ${fit.days} días`);
    } catch (e) {
      console.warn('[sync-intervals] Error calculando fitness:', e.message);
    }

    // ── 4) NUEVO: wellness diario (sueño, FC reposo, VO2max, FC máx., kcal) ──
    let wellnessDiasGuardados = 0;
    try {
      const wres = await fetchAndStoreWellness({ admin, db, connection, uid, activities, oldest, newest });
      wellnessDiasGuardados = wres.days;
      if (wellnessDiasGuardados > 0) console.log(`[sync-intervals] wellness guardado: ${wellnessDiasGuardados} días`);
    } catch (e) {
      console.warn('[sync-intervals] Error wellness:', e.message);
    }

    // Curvas: se procesan en segundo plano DESPUÉS de responder (waitUntil).
    // Nunca puede tumbar la sincronización: la llamada captura sus errores.
    try {
      enSegundoPlano(res, uid, { max: 25 });
    } catch (e) {
      console.warn('[sync-intervals] no se pudo lanzar el cálculo de curvas:', e.message);
    }

    await sendPushForSync(uid, synced, skipped, errorsList.length, activities.length, syncedList);
    await notifyCoachAfterSync(uid, synced, syncedList);

    return res.json({
      synced,
      skipped,
      esfuerzoBackfill: backfilled + backfillHistorico,
      esfuerzoCorregidos: corregidos,
      subidos: uploaded,
      wellnessDays,
      errors: errorsList.length,
      errorDetails: errorsList.slice(0, 5),
      total: activities.length,
      detallesRellenados: detailOps,
      oldest,
      newest,
    });
  } catch (error) {
    console.error('[sync-intervals] Error global:', error);
    const status = error.status || 500;
    return res.status(status).json({
      error: error.message || 'Error sincronizando Intervals.icu',
    });
  }
};
