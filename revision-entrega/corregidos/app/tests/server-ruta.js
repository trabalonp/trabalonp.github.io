// tests/server-ruta.js — localiza el código del server para los tests.
// REVISIÓN 2026-10-21: sin rutas hardcodeadas ni usuarios concretos.
//
// Orden de búsqueda:
//   1) SERVER_DIR (variable de entorno: úsala en CI o si el server está en otro sitio)
//   2) server-extract/mi-app-entrenos-main   (copia dentro del repo de la app)
//   3) ../mi-app-entrenos-main               (repo del server, hermano de este)
//   4) ../mi-app-entrenos                    (zip entregable descomprimido al lado)
//   5) <Descargas del usuario>/mi-app-entrenos-main… (compatibilidad con el setup
//      antiguo; se resuelve desde USERPROFILE/HOME, sin nombre de usuario fijo)
//
// Si no encuentra ninguno devuelve la ruta local (la de CI) para que el test dé
// un mensaje claro o haga SKIP. Los tests que necesitan el server llevan un
// guard: sin código, imprimen SKIP y salen con 0 (nunca rompen la batería).
'use strict';
const fs = require('fs');
const path = require('path');

function candidatos() {
  const out = [];

  if (process.env.SERVER_DIR) out.push(process.env.SERVER_DIR);
  out.push(path.join(__dirname, '..', 'server-extract', 'mi-app-entrenos-main'));
  out.push(path.join(__dirname, '..', '..', 'mi-app-entrenos-main'));
  out.push(path.join(__dirname, '..', '..', 'mi-app-entrenos'));

  const home = process.env.USERPROFILE || process.env.HOME;

  if (home) {
    out.push(path.join(home, 'Downloads', 'mi-app-entrenos-main (3)', 'mi-app-entrenos-main'));
    out.push(path.join(home, 'Downloads', 'mi-app-entrenos-main (2)', 'mi-app-entrenos-main'));
    out.push(path.join(home, 'Downloads', 'mi-app-entrenos-main', 'mi-app-entrenos-main'));
    out.push(path.join(home, 'Descargas', 'mi-app-entrenos-main (3)', 'mi-app-entrenos-main'));
    out.push(path.join(home, 'Descargas', 'mi-app-entrenos-main', 'mi-app-entrenos-main'));
  }

  return out;
}

function rutaServer() {
  for (const p of candidatos()) {
    try {
      if (p && fs.existsSync(path.join(p, 'lib', 'firebase.js'))) return p;
    } catch (e) { /* ruta inválida: se ignora */ }
  }

  return path.join(__dirname, '..', 'server-extract', 'mi-app-entrenos-main');
}

module.exports = rutaServer;
