// api/[...path].js — DISPATCHER ÚNICO (1 sola Serverless Function)
//
// MOTIVO: el plan Hobby de Vercel limita cada deployment a 12 Serverless
// Functions y el proyecto ya tenía 13 archivos en /api (al añadir
// link-preview y delete-message el build falló con:
// "No more than 12 Serverless Functions can be added to a Deployment on
// the Hobby plan").
//
// SOLUCIÓN: esta función catch-all recibe TODAS las rutas /api/* y reparte
// cada una al handler correspondiente, que ahora vive en /handlers (fuera
// de /api, por lo que Vercel no lo cuenta como función). Las URLs públicas
// NO cambian: la app sigue llamando exactamente a lo mismo
// (/api/social/presign, /api/social/link-preview, /api/intervals/status…).
//
// El wrapper reproduce el contrato (req, res) del runtime Node de Vercel
// que los handlers ya usaban: req.method, req.headers, req.body (JSON),
// req.query, y res.status().json() / res.json() / res.send() /
// res.setHeader() / res.end(). Los handlers se cargan de forma perezosa:
// una ruta que no se usa nunca paga su coste de arranque.
//
// IMPORTANTE — vercel.json (raíz del repo) es OBLIGATORIO junto a este
// archivo: el builder de Vercel para proyectos sin framework registra el
// catch-all del directorio api/ como ruta de UN SOLO segmento
// (^/api/([^/]+)$) y responde 404 de plataforma al resto de rutas /api/x/y.
// El rewrite de vercel.json (/api/:path* -> /api/[...path]?path=:path*)
// devuelve el emparejamiento completo de varios segmentos ANTES de la
// regla 404. Sin él, /api/social/presign y compañía devuelven
// "The page could not be found NOT_FOUND".
//
// Rutas atendidas (18):
//   /api/notify-athlete            /api/sync-fitness
//   /api/sync-intervals            /api/sync-intervals-detail
//   /api/upload-to-intervals       /api/intervals/delete-event
//   /api/intervals/disconnect      /api/intervals/save-credentials
//   /api/intervals/status          /api/social/delete-message
//   /api/social/link-preview       /api/social/notify-message
//   /api/social/presign            /api/social/purge
//   /api/archivos/presign          /api/archivos/config
//   /api/archivos/delete           /api/curvas/backfill   (nueva, 2026-10-21)

// OJO: los require DEBEN ser literales (thunks) para que el trazador de
// Vercel (nft) los detecte y empaquete handlers/ + lib/ dentro de la
// función. Con `require(variable)` el bundle se desplegaba sin los
// handlers ("Cannot find module '../handlers/...'"). La carga sigue siendo
// perezosa: cada thunk solo se ejecuta cuando llega su primera petición.
const RUTAS = {
  'notify-athlete':              () => require('../handlers/notify-athlete.js'),
  'sync-fitness':                () => require('../handlers/sync-fitness.js'),
  'sync-intervals':              () => require('../handlers/sync-intervals.js'),
  'sync-intervals-detail':       () => require('../handlers/sync-intervals-detail.js'),
  'upload-to-intervals':         () => require('../handlers/upload-to-intervals.js'),
  'intervals/delete-event':      () => require('../handlers/intervals/delete-event.js'),
  'intervals/disconnect':        () => require('../handlers/intervals/disconnect.js'),
  'intervals/save-credentials':  () => require('../handlers/intervals/save-credentials.js'),
  'intervals/status':            () => require('../handlers/intervals/status.js'),
  'social/delete-message':       () => require('../handlers/social/delete-message.js'),
  'social/link-preview':         () => require('../handlers/social/link-preview.js'),
  'social/notify-message':       () => require('../handlers/social/notify-message.js'),
  'social/presign':              () => require('../handlers/social/presign.js'),
  'social/purge':                () => require('../handlers/social/purge.js'),
  'archivos/presign':            () => require('../handlers/archivos/presign.js'),
  'archivos/config':             () => require('../handlers/archivos/config.js'),
  'archivos/delete':             () => require('../handlers/archivos/delete.js'),
  'curvas/backfill':             () => require('../handlers/curvas/backfill.js'),
};

const MAX_BODY_BYTES = 26 * 1024 * 1024; // margen sobre el límite de 25 MB de presign

function rutaDe(req) {
  // En el runtime de Vercel, req.query.path trae los segmentos del catch-all.
  const q = req.query && req.query.path;
  if (Array.isArray(q) && q.length) return q.join('/').toLowerCase();
  if (typeof q === 'string' && q) return q.toLowerCase();
  // Respaldo (p. ej. pruebas locales): se parsea la URL cruda.
  const url = String(req.url || '');
  const sinQuery = url.split('?')[0];
  return sinQuery.replace(/^\/api\//, '').replace(/\/+$/, '').toLowerCase();
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Cuerpo de petición demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      trozos.push(c);
    });
    req.on('end', () => resolve(trozos.length ? Buffer.concat(trozos) : null));
    req.on('error', reject);
  });
}

async function preparar(req) {
  // req.query: el runtime de Vercel ya lo sirve parseado; si no existe
  // (entornos de prueba) se construye desde la URL.
  if (!req.query || typeof req.query !== 'object') {
    const u = new URL(String(req.url || '/'), 'http://local');
    req.query = Object.fromEntries(u.searchParams.entries());
  }
  // req.body: como en Vercel, JSON parseado si el cuerpo lo es; null si vacío.
  if (req.body === undefined) {
    const buf = await leerCuerpo(req);
    if (!buf) {
      req.body = null;
    } else {
      const tipo = String(req.headers['content-type'] || '');
      if (tipo.includes('json')) {
        try {
          req.body = JSON.parse(buf.toString('utf8'));
        } catch (e) {
          const err = new Error('JSON no válido en el cuerpo de la petición');
          err.status = 400;
          throw err;
        }
      } else {
        req.body = buf.toString('utf8');
      }
    }
  }
}

function prepararRes(res) {
  if (typeof res.status !== 'function') {
    res.status = (codigo) => { res.statusCode = codigo; return res; };
  }
  if (typeof res.json !== 'function') {
    res.json = (datos) => {
      if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(datos));
      return res;
    };
  }
  if (typeof res.send !== 'function') {
    res.send = (datos) => {
      if (typeof datos === 'string' || Buffer.isBuffer(datos)) { res.end(datos); return res; }
      return res.json(datos);
    };
  }
}

module.exports = async (req, res) => {
  // OJO al orden: prepararRes va PRIMERO para que la respuesta esté envuelta
  // aunque el parseo del cuerpo falle (si no, el catch no podría responder).
  prepararRes(res);
  try {
    await preparar(req);
    const clave = rutaDe(req);
    const cargar = RUTAS[clave];
    if (!cargar) {
      console.log(`[dispatcher] ruta /api/${clave} no existe`);
      return res.status(404).json({ error: 'Ruta no encontrada' });
    }
    const handler = cargar();
    return await handler(req, res);
  } catch (error) {
    const codigo = Number(error && error.status) || 500;
    console.error('[dispatcher] Error:', error && error.message);
    if (!res.writableEnded) {
      return res.status(codigo).json({ error: (error && error.message) || 'Error interno' });
    }
    return undefined;   // la respuesta ya se había enviado
  }
};
