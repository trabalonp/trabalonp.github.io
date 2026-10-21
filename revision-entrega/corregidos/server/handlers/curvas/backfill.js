// handlers/curvas/backfill.js — POST /api/curvas/backfill
//
// Reconstruye los digests de curvas del usuario AUTENTICADO en segundo plano.
// No hace falta para el día a día (el worker de /api/sync-intervals ya procesa
// la cola de pendientes), pero sirve para:
//   · terminar un backfill que se cortó (función de Vercel con tiempo agotado),
//   · forzar el recálculo tras cambiar el algoritmo de digest,
//   · reparar un usuario sin tocar la base de datos a mano.
//
// Contrato
// --------
//   POST /api/curvas/backfill
//   Authorization: Bearer <idToken>
//   Body (opcional): { "forzar": true, "limite": 200 }
//   200 { ok: true, lanzado: true }                 ← el trabajo sigue en segundo plano
//   401 sin token · 405 método · 500 error
//
// Detalles
//   · `waitUntil` mantiene la función viva después de responder. Aun así, el
//     presupuesto de una función de Vercel es limitado: para cuentas grandes
//     conviene usar `node tools/importar-digests.js --uid <UID>` desde local.
//   · Es idempotente: si se corta o se llama dos veces, sigue donde lo dejó.
//   · Solo toca los datos del usuario del token (nunca acepta un uid del body).
'use strict';

const { getUid } = require('../../lib/auth');
const { backfillUsuario, lanzarEnSegundoPlano } = require('../../lib/workers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  let uid;

  try {
    uid = await getUid(req);
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || 'No autorizado' });
  }

  // Un uid del cuerpo se IGNORA a propósito: sería un agujero para tocar los
  // datos de otros usuarios.
  if (req.body && req.body.uid && req.body.uid !== uid) {
    return res.status(403).json({ error: 'Solo puedes reconstruir tus propias curvas' });
  }

  const forzar = req.body && req.body.forzar === true;
  const limite = Number(req.body && req.body.limite) || 0;

  const tarea = backfillUsuario(uid, { forzar, limite }).catch((e) => {
    console.warn('[curvas/backfill] falló:', e.message);

    return null;
  });

  lanzarEnSegundoPlano(res, tarea);

  return res.status(200).json({ ok: true, lanzado: true, forzar, limite });
};
