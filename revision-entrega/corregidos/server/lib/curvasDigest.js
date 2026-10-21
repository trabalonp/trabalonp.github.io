// lib/curvasDigest.js — versión SERVIDOR (CommonJS) del cálculo de digests.
//
// Es la MISMA lógica que `mi-app-entrenos/services/curvasDigest.js` (la del
// cliente), portada a CommonJS y sin dependencias de React Native para poder
// ejecutarla en Vercel y en los scripts de `tools/`.
//
// Diferencias deliberadas con el cliente (y por qué):
//   · `dayKey` usa la zona horaria de la app (APP_TZ, por defecto Europe/Madrid)
//     en lugar de la zona del dispositivo. El autor del bloque C no quiso
//     calcular digests en el servidor porque "el día local del dispositivo y el
//     UTC del servidor no coinciden": con Intl y APP_TZ SÍ coinciden para los
//     usuarios de esa zona. Solo afecta al reparto POR DÍA de las zonas
//     (`dias.fc` / `dias.rt`); las curvas por ventana (`win`) no dependen del día.
//   · Si una zona horaria distinta cambiara el día de un entreno que cruza
//     medianoche, el cliente lo corrige al recalcular (editando el entreno o
//     con el backfill forzado). El resultado es idempotente.
//
// Lo que produce es EXACTAMENTE lo que el motor del cliente espera:
//   { f, tipo, sig, win: {ritmo,vel,fc,pot,cad}, dias: { 'yyyy-mm-dd': {fc,rt} } }
'use strict';

const STREAM_SIZES = [60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];

const TZ = process.env.APP_TZ || 'Europe/Madrid';

// Caché de formateadores por zona (Intl.DateTimeFormat es caro de construir).
const formateadores = {};

function partesFecha(fecha, tz) {
  const zona = tz || TZ;

  if (!formateadores[zona]) {
    formateadores[zona] = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  const out = {};

  for (const p of formateadores[zona].formatToParts(fecha)) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') out[p.type] = p.value;
  }

  return out;
}

// Día local (zona de la app) de un timestamp: 'yyyy-mm-dd'.
function dayKey(fecha, tz) {
  const p = partesFecha(fecha instanceof Date ? fecha : new Date(fecha), tz);

  return `${p.year}-${p.month}-${p.day}`;
}

// Mes local (zona de la app) de una fecha en ms: 'yyyy-mm'.
function mesKeyDe(fechaMs, tz) {
  const p = partesFecha(new Date(Number(fechaMs) || Date.now()), tz);

  return `${p.year}-${p.month}`;
}

function calcularDigest(puntos, tipo, fechaMs, tz) {
  const win = {
    ritmo: STREAM_SIZES.map(() => null),
    vel: STREAM_SIZES.map(() => null),
    fc: STREAM_SIZES.map(() => null),
    pot: STREAM_SIZES.map(() => null),
    cad: STREAM_SIZES.map(() => null),
  };
  const dias = {};
  const pts = Array.isArray(puntos) ? puntos : [];
  const sig = pts.length
    ? `${pts.length}|${pts[0].timestamp}|${pts[pts.length - 1].timestamp}`
    : '0||';
  const digest = {
    f: Number(fechaMs) || 0,
    tipo: tipo ?? '',
    sig,
    win,
    dias,
  };

  if (pts.length < 2) return digest;

  const t0 = new Date(pts[0].timestamp).getTime();
  const chunks = STREAM_SIZES.map(() => ({}));

  const acumDia = (dk, mapa, clave, dt) => {
    const d = dias[dk] || (dias[dk] = { fc: {}, rt: {} });

    d[mapa][clave] = (d[mapa][clave] || 0) + dt;
  };

  for (let i = 1; i < pts.length; i++) {
    const dt = (new Date(pts[i].timestamp) - new Date(pts[i - 1].timestamp)) / 1000;

    if (dt <= 0 || dt > 120) {
      continue;
    }

    const hr = Number(pts[i].frecuencia) || 0;
    const v = Number(pts[i].velocidad) || 0;
    const pot = Number(pts[i].potencia) || 0;
    const cad = Number(pts[i].cadencia) || 0;
    const dk = dayKey(new Date(pts[i].timestamp), tz);

    if (hr > 0) {
      acumDia(dk, 'fc', String(hr), dt);
    }

    if (v > 0 && tipo !== 'Ciclismo') {
      const pace = 3600 / v;
      let k = Math.floor(pace);

      if (k > 3600) k = 3600;
      acumDia(dk, 'rt', String(k), dt);
    }

    const elapsed = (new Date(pts[i].timestamp).getTime() - t0) / 1000;

    for (let si = 0; si < STREAM_SIZES.length; si++) {
      const idx = Math.floor(elapsed / STREAM_SIZES[si]);

      const ck =
        chunks[si][idx] ||
        (chunks[si][idx] = { t: 0, d: 0, hrS: 0, hrT: 0, pS: 0, pT: 0, cS: 0, cT: 0 });

      ck.t += dt;

      if (v > 0) {
        ck.d += (v * dt) / 3.6;
      }

      if (hr > 0) {
        ck.hrS += hr * dt;
        ck.hrT += dt;
      }

      if (pot > 0) {
        ck.pS += pot * dt;
        ck.pT += dt;
      }

      if (cad > 0) {
        ck.cS += cad * dt;
        ck.cT += dt;
      }
    }
  }

  for (let si = 0; si < STREAM_SIZES.length; si++) {
    let rV = null;
    let vV = null;
    let fV = null;
    let pV = null;
    let cV = null;

    for (const idx of Object.keys(chunks[si])) {
      const ck = chunks[si][idx];

      if (ck.d > 0 && ck.t > 0) {
        if (tipo === 'Ciclismo') {
          const speedKmh = (3.6 * ck.d) / ck.t;

          if (vV == null || speedKmh > vV) vV = speedKmh;
        } else {
          const pace = ck.t / (ck.d / 1000);

          if (rV == null || pace < rV) rV = pace;
        }
      }

      if (ck.hrT > 0) {
        const avg = ck.hrS / ck.hrT;

        if (fV == null || avg > fV) fV = avg;
      }

      if (ck.pT > 0) {
        const avg = ck.pS / ck.pT;

        if (pV == null || avg > pV) pV = avg;
      }

      if (ck.cT > 0) {
        const avg = ck.cS / ck.cT;

        if (cV == null || avg > cV) cV = avg;
      }
    }

    win.ritmo[si] = rV;
    win.vel[si] = vV;
    win.fc[si] = fV;
    win.pot[si] = pV;
    win.cad[si] = cV;
  }

  return digest;
}

// Los segundos se redondean a 2 decimales AL GUARDAR (igual que el cliente).
function redondearDigest(dg) {
  const out = { ...dg, dias: {} };

  for (const dk of Object.keys(dg.dias || {})) {
    const dd = dg.dias[dk] || {};

    out.dias[dk] = { fc: {}, rt: {} };

    for (const k of Object.keys(dd.fc || {})) {
      out.dias[dk].fc[k] = Math.round((dd.fc[k] || 0) * 100) / 100;
    }

    for (const k of Object.keys(dd.rt || {})) {
      out.dias[dk].rt[k] = Math.round((dd.rt[k] || 0) * 100) / 100;
    }
  }

  return out;
}

module.exports = {
  STREAM_SIZES,
  TZ,
  dayKey,
  mesKeyDe,
  calcularDigest,
  redondearDigest,
};
