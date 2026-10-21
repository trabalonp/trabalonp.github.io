/* Verifica la lógica PURA del borrado de media en Cloudflare R2
   (workspace-anterior/.../lib/socialMedia.js, CommonJS real del servidor):
   · claveR2DeUrl  → solo claves del bucket del chat y del prefijo social/
   · mediaUrlsDe   → urls (original + miniatura) sin duplicados
   · sigueReferenciada → protección de reenvíos (no borrar nada vivo)
   Uso: node tests/delete-media-test.js */
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

let fallos = 0;
const ok = (cond, msg) => {
  if (cond) console.log('ok   ' + msg);
  else { fallos++; console.log('FALLO: ' + msg); }
};

const LIB = path.join(require('./server-ruta')(), 'lib', 'socialMedia.js');
const { claveR2DeUrl, mediaUrlsDe, sigueReferenciada } = require(LIB);

const BASE = 'https://cdn.midominio.com';

// Claves válidas del chat
ok(claveR2DeUrl(BASE + '/social/u1/123-abc.jpg', BASE) === 'social/u1/123-abc.jpg', 'URL del chat → clave R2');
ok(claveR2DeUrl(BASE + '/social/u1/thumb-1.png', BASE) === 'social/u1/thumb-1.png', 'miniatura → clave R2');

// Fuera del prefijo social/: NUNCA se borra (defensa en profundidad)
ok(claveR2DeUrl(BASE + '/workouts/u1/x.fit', BASE) === null, 'clave fuera de social/ rechazada');
ok(claveR2DeUrl(BASE + '/otra/cosa.jpg', BASE) === null, 'clave ajena rechazada');

// URLs ajenas al bucket
ok(claveR2DeUrl('https://otro-cdn.com/social/u1/x.jpg', BASE) === null, 'URL de otro dominio rechazada');
ok(claveR2DeUrl('data:image/jpeg;base64,AAA', BASE) === null, 'data-URI rechazada');

// Casos límite
ok(claveR2DeUrl(null, BASE) === null, 'null rechazado');
ok(claveR2DeUrl('', BASE) === null, 'cadena vacía rechazada');
ok(claveR2DeUrl(123, BASE) === null, 'no-string rechazado');
ok(claveR2DeUrl(BASE + '/social/../secreto', BASE) === null, 'traversal ".." rechazado');
ok(claveR2DeUrl(BASE + '/social/u1/x.jpg', BASE + '/') === 'social/u1/x.jpg', 'base con barra final tolerada');
ok(claveR2DeUrl(BASE + '/social/u1/x.jpg', '') === null, 'sin base configurada: null');

// mediaUrlsDe: original + miniatura, sin duplicados, tolerante
const post = { media: [{ tipo: 'imagen', url: 'u1', thumbUrl: 't1' }, { url: 'u1' }, { url: 'u2' }, null, 'basura', {}] };
const urls = mediaUrlsDe(post);
ok(JSON.stringify(urls) === '["u1","t1","u2"]', 'mediaUrlsDe: todas, sin duplicados, tolerante a basura');
ok(JSON.stringify(mediaUrlsDe(null)) === '[]', 'mediaUrlsDe(null) = []');
ok(JSON.stringify(mediaUrlsDe({})) === '[]', 'mediaUrlsDe({}) = []');
ok(JSON.stringify(mediaUrlsDe({ media: 'no-array' })) === '[]', 'media no-array tolerado');

// sigueReferenciada: protección de REENVÍOS (comparten la misma URL de R2)
ok(sigueReferenciada([{ id: 'P1', eliminado: false }, { id: 'P2', eliminado: false }], 'P1') === true,
  'otro mensaje vivo con la misma URL → NO borrar');
ok(sigueReferenciada([{ id: 'P1', eliminado: false }], 'P1') === false,
  'solo el propio mensaje la referencia → borrar');
ok(sigueReferenciada([{ id: 'P1', eliminado: true }, { id: 'P2', eliminado: true }], 'P1') === false,
  'el resto ya están eliminados → borrar');
ok(sigueReferenciada([], 'P1') === false, 'sin referencias → borrar');
ok(sigueReferenciada(null, 'P1') === false, 'referencias null → borrar');

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
