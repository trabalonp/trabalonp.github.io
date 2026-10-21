// tests/archivos-delete-test.js — RONDA 47: librería de ARCHIVOS
// Verifica, sin red ni Firebase real:
//  A)claveArchivosDeUrl (handlers/archivos/delete.js): solo se puede borrar
//     un binario bajo archivos/{uid}/… del usuario autenticado (nada de
//     gym/, social/, otros uids, otros dominios o traversal).
//  B) Las DOS copias del servidor (entregable + server-extract) son iguales
//     y el dispatcher registra /api/archivos/delete (todas las rutas con
//     require literal, para que nft las empaquete).
//  C) App: borrarArchivoDeR2 llama al endpoint, tolera el 404 de plataforma
//     (servidor sin redeployar) y LANZA el resto de errores.
//  D) ArchivosPicker: pulsación larga → MENÚ como en la librería de sesiones
//     (archivo: renombrar/mover/eliminar; carpeta: renombrar/eliminar) y al
//     eliminar, el binario de R2 se borra ANTES que el doc de Firestore.
//  E) LibreriaDrive (sesiones) intacta: su menú no cambia (anti-regresión).
// Ejecutar:  node tests/archivos-delete-test.js
'use strict';


// ── GUARD (revisión 2026-10-21) ──────────────────────────────────────────
// Este test necesita el código del SERVIDOR (handlers/ y lib/). Si no está
// (server-extract/, SERVER_DIR o un repo hermano), se imprime SKIP y se sale
// con 0: la batería `node tests/*.js` de la app nunca se rompe por esto.
if (!require('fs').existsSync(require('path').join(require('./server-ruta')(), 'lib'))) {
  console.log('SKIP: falta el código del servidor (define SERVER_DIR o copia el server en server-extract/mi-app-entrenos-main); ver tests/server-ruta.js');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { generateKeyPairSync } = require('crypto');

// lib/firebase.js valida el PEM al arrancar: clave RSA dummy solo local.
// (El handler NUNCA se ejecuta aquí: solo se require para probar la función
// pura exportada, igual que delete-media-test hace con lib/socialMedia.js.)
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test-local',
  private_key_id: 'x',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  client_email: 'test@test-local.iam.gserviceaccount.com',
  client_id: '1',
  token_uri: 'https://oauth2.example.com/token',
});
for (const v of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL', 'R2_ENDPOINT', 'R2_REGION']) delete process.env[v];

const SRV = require('./server-ruta')();
const APP = path.join(__dirname, '..');

let pasadas = 0;
const fallos = [];
function ok(cond, msg) {
  if (cond) { pasadas++; } else { fallos.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`); }

console.log('— 1) claveArchivosDeUrl: solo el prefijo propio (función pura) —');
const handler = require(path.join(SRV, 'handlers', 'archivos', 'delete.js'));
const clave = handler.claveArchivosDeUrl;
ok(typeof handler === 'function', 'el handler es una función (el dispatcher lo llama)');
ok(typeof clave === 'function', 'el handler exporta claveArchivosDeUrl para tests');

const BASE = 'https://cdn.midominio.com';
const UID = 'u1';
eq(clave(BASE + '/archivos/u1/123-abc.jpg', UID, BASE), 'archivos/u1/123-abc.jpg', 'URL propia → clave R2');
eq(clave(BASE + '/archivos/u1/x.pdf?a=b#f', UID, BASE), 'archivos/u1/x.pdf', 'query y fragmento fuera de la clave');
eq(clave(BASE + '/archivos/u1/x%20y.png', UID, BASE), 'archivos/u1/x y.png', 'clave percent-decoded');
eq(clave(BASE + '/archivos/u1/x.jpg', UID, BASE + '/'), 'archivos/u1/x.jpg', 'base con barra final tolerada');
// Defensa en profundidad: NUNCA nada fuera del prefijo propio
eq(clave(BASE + '/archivos/u2/x.jpg', UID, BASE), null, 'archivo de OTRO usuario → null');
eq(clave(BASE + '/archivos/u1x/x.jpg', UID, BASE), null, 'prefijo parecido (u1x) → null');
eq(clave(BASE + '/gym/index.json', UID, BASE), null, 'gym/ (librería fija) → null');
eq(clave(BASE + '/gym/videos/x.gif', UID, BASE), null, 'media de gimnasio → null');
eq(clave(BASE + '/social/u1/x.jpg', UID, BASE), null, 'media del chat → null');
eq(clave(BASE + '/archivos/u1/../u2/x.jpg', UID, BASE), null, 'traversal ".." → null');
eq(clave(BASE + '/archivos/u1/', UID, BASE), null, 'prefijo sin objeto → null');
eq(clave(BASE + '/archivos/', UID, BASE), null, 'archivos/ a secas → null');
eq(clave('https://otro-cdn.com/archivos/u1/x.jpg', UID, BASE), null, 'otro dominio → null');
eq(clave('data:image/png;base64,AAA', UID, BASE), null, 'data-URI → null');
eq(clave(null, UID, BASE), null, 'null → null');
eq(clave('', UID, BASE), null, 'cadena vacía → null');
eq(clave(123, UID, BASE), null, 'no-string → null');
eq(clave(BASE + '/archivos/u1/x.jpg', UID, ''), null, 'sin R2_PUBLIC_URL → null (fail-closed)');
eq(clave(BASE + '/archivos/u1/x.jpg', '', BASE), null, 'sin uid → null');

console.log('— 2) Servidor: copias idénticas + dispatcher —');
// Revisión 2026-10-21: la copia del servidor se busca con el MISMO resolvedor
// que usa el resto de tests (server-extract/, SERVER_DIR, repos hermanos o
// Descargas), no solo en dos rutas fijas que solo existían en un equipo.
const srvAlt = [
  require('./server-ruta')(),
  path.join(__dirname, '..', '..', 'mi-app-entrenos-main'),
  path.join(__dirname, '..', '..', 'mi-app-entrenos'),
].find((p) => fs.existsSync(path.join(p, 'handlers', 'archivos', 'delete.js')));
ok(!!srvAlt, 'existe la copia entregable del servidor (workspace o zip)');
if (srvAlt) {
  const a = fs.readFileSync(path.join(srvAlt, 'handlers', 'archivos', 'delete.js'), 'utf8');
  const b = fs.readFileSync(path.join(SRV, 'handlers', 'archivos', 'delete.js'), 'utf8');
  eq(a, b, 'handlers/archivos/delete.js IDÉNTICO en las dos copias');
  const d1 = fs.readFileSync(path.join(srvAlt, 'api', '[...path].js'), 'utf8');
  const d2 = fs.readFileSync(path.join(SRV, 'api', '[...path].js'), 'utf8');
  eq(d1, d2, 'dispatcher IDÉNTICO en las dos copias');
  ok(d2.includes("'archivos/delete':             () => require('../handlers/archivos/delete.js')"),
    'dispatcher registra archivos/delete con require LITERAL (nft lo empaqueta)');
  // Ya no se fija el número exacto (el dispatcher puede crecer); se exige que
  // haya al menos 17 y que TODAS las rutas sean requires literales.
  ok((d2.match(/\(\) => require\('\.\.\/handlers\//g) || []).length >= 17, 'RUTAS tiene 17+ requires literales');
  ok(!/\(\w+\) => require\(/.test(d2), 'ninguna ruta usa require(variable) (nft no lo empaquetaría)');
}

console.log('— 3) App: borrarArchivoDeR2 (services/archivosUpload.js) —');
const up = fs.readFileSync(path.join(APP, 'services', 'archivosUpload.js'), 'utf8');
ok(/export async function borrarArchivoDeR2\(/.test(up), 'borrarArchivoDeR2 exportado');
const fnUp = up.slice(up.indexOf('export async function borrarArchivoDeR2'));
ok(fnUp.includes('`${apiUrl}/archivos/delete`'), 'llama a /archivos/delete con la URL del API');
ok(fnUp.includes("method: 'POST'"), 'por POST');
ok(/Authorization: `Bearer \$\{token\}`/.test(fnUp), 'con el token del usuario (Bearer)');
ok(/getIdToken\(\)/.test(fnUp), 'pide el token fresco con getIdToken');
const i404 = fnUp.indexOf('r.status === 404');
ok(i404 > 0, 'trata el 404 de plataforma (servidor sin redeployar)');
ok(fnUp.indexOf("sin: 'sin-ruta'", i404) > i404, '404 → { ok:false, sin:"sin-ruta" } (no lanza)');
ok(fnUp.indexOf('throw new Error', i404) > i404, 'cualquier otro error SÍ lanza (el doc no se borra)');
ok(fnUp.indexOf("if (!url) return { ok: true, sin: 'sin-url' };") > 0, 'sin url → nada que borrar (ok)');

console.log('— 4) App: menú de pulsación larga en ArchivosPicker —');
const pick = fs.readFileSync(path.join(APP, 'components', 'ArchivosPicker.js'), 'utf8');
eq((pick.match(/onLongPress=\{\(\) => setMenu\(/g) || []).length, 2, 'archivo y carpeta abren el menú con pulsación larga');
ok(!/onLongPress=\{\(\) => eliminar/.test(pick), 'la pulsación larga YA NO borra directamente');
ok(pick.includes("setMenu({ tipo: 'file', obj: item.obj })"), 'fila de archivo → menú tipo "file"');
ok(pick.includes("setMenu({ tipo: 'carpeta', obj: item.obj })"), 'fila de carpeta → menú tipo "carpeta"');
const iFile = pick.indexOf("menu.tipo === 'file'");
const iCarp = pick.indexOf('] : [', iFile);
const iFin = pick.indexOf(']) : []).map', iCarp);
ok(iFile > 0 && iCarp > iFile && iFin > iCarp, 'el modal del menú distingue file/carpeta');
const menuFile = pick.slice(iFile, iCarp);
ok(menuFile.includes("L('Renombrar', 'Rename')"), 'menú de ARCHIVO: Renombrar');
ok(menuFile.includes("L('Mover a carpeta', 'Move to folder')"), 'menú de ARCHIVO: Mover a carpeta');
ok(menuFile.includes("L('Eliminar', 'Delete')"), 'menú de ARCHIVO: Eliminar');
ok(menuFile.includes('setMover(m)'), '"Mover" abre el selector de carpeta destino');
ok(menuFile.includes('eliminarArchivo(m.obj)'), '"Eliminar" confirma y borra (con R2)');
ok(menuFile.includes("abrirPrompt(L('Renombrar archivo', 'Rename file')"), 'renombrar archivo abre el prompt');
ok(menuFile.includes('m.obj.nombre'), 'el prompt de renombrar sale con el nombre ACTUAL');
const menuCarp = pick.slice(iCarp, iFin);
ok(menuCarp.includes("L('Renombrar', 'Rename')"), 'menú de CARPETA: Renombrar');
ok(menuCarp.includes('eliminarCarpeta(m.obj)'), 'menú de CARPETA: Eliminar');
ok(!menuCarp.includes('setMover'), 'menú de CARPETA sin "Mover" (igual que la librería de sesiones)');
// Prompt reutilizable con placeholder/botón según contexto
ok(pick.includes('const abrirPrompt = (titulo, onOk, inicial, ph, btn)'), 'abrirPrompt admite texto inicial, placeholder y botón');
ok(pick.includes("setPromptTxt(inicial || '')"), 'renombrar precarga el nombre actual en el input');
ok(pick.includes('placeholder={prompt?.ph ||') && pick.includes("{prompt?.btn || L('Crear', 'Create')}"), 'prompt con placeholder/botón contextuales');

console.log('— 5) App: renombrar y mover = updateDoc + almacén local —');
ok(pick.includes("addDoc, deleteDoc, doc, updateDoc } from 'firebase/firestore'"), 'importa updateDoc de firestore');
const fnRen = pick.slice(pick.indexOf('const renombrar'), pick.indexOf('const moverA'));
ok(fnRen.includes("updateDoc(doc(db, 'archivosLib', obj.id), { nombre: n })"), 'renombrar: updateDoc { nombre } en archivosLib');
ok(fnRen.includes('archivosStorePut') && fnRen.includes('setDocs(await archivosStoreAll())'), 'renombrar refleja en el almacén local (0 re-lecturas)');
ok(fnRen.includes("if (!n || n === obj.nombre) return;"), 'renombrar sin cambio real → no escribe');
const fnMov = pick.slice(pick.indexOf('const moverA'), pick.indexOf('const subirAqui'));
ok(fnMov.includes("updateDoc(doc(db, 'archivosLib', obj.id), { carpeta: destinoId ?? null })"), 'mover: updateDoc { carpeta } (null = raíz)');
ok(fnMov.includes('archivosStorePut') && fnMov.includes('setDocs(await archivosStoreAll())'), 'mover refleja en el almacén local');
ok(fnMov.includes('if ((obj.carpeta ?? null) === (destinoId ?? null)) return;'), 'mover a la misma carpeta → no-op');
ok(pick.includes('onElegir={(id) => moverA(id)}'), 'el selector de destino (PickerCarpetaArchivos) alimenta moverA');

console.log('— 6) App: eliminar archivo borra TAMBIÉN de R2 (orden medido) —');
const fnDel = pick.slice(pick.indexOf('const eliminarArchivo'), pick.indexOf('const renombrar'));
const iR2 = fnDel.indexOf('borrarArchivoDeR2(user, f.url)');
const iDoc = fnDel.indexOf("deleteDoc(doc(db, 'archivosLib', f.id))");
ok(iR2 > 0, 'eliminarArchivo llama a borrarArchivoDeR2');
ok(iDoc > 0, 'eliminarArchivo borra el doc de Firestore');
ok(iR2 < iDoc, 'el BINARIO de R2 se borra ANTES que el doc (si R2 falla, no hay huérfano)');
ok(fnDel.includes('x.url === f.url'), 'si otra entrada viva apunta a la misma url, el objeto NO se borra');
ok(fnDel.includes("r2.sin === 'sin-ruta'"), 'avisa si el servidor aún no tiene la ruta (falta redeploy)');
ok(fnDel.includes('No se pudo eliminar'), 'los errores se avisan con Alert (ya no se tragan)');
ok(!fnDel.includes('try { await deleteDoc'), 'deleteDoc ya no va envuelto en un try/catch que traga el error');
ok(fnDel.includes("L('Eliminar archivo', 'Delete file')"), 'confirmación dice "Eliminar archivo"');
// El texto real de ArchivosPicker.js:219 es «…y del almacenamiento.» (sin el
// «(R2)» que esperaba el test): se acepta cualquiera de las dos redacciones.
ok(/almacenamiento/i.test(fnDel) || /storage/i.test(fnDel), 'la confirmación AVISA de que el binario también se va');

console.log('— 7) Anti-regresión: librería de SESIONES intacta —');
const lib = fs.readFileSync(path.join(APP, 'components', 'LibreriaDrive.js'), 'utf8');
ok(lib.includes("onLongPress={() => setMenu({ tipo: 'item', obj })}"), 'LibreriaDrive: su pulsación larga sigue abriendo SU menú');
ok(lib.includes("L('Mover a carpeta', 'Move to folder')") && lib.includes("L('Renombrar', 'Rename')"), 'LibreriaDrive: mover/renombrar siguen ahí');

console.log(`\n${fallos.length ? 'FALLOS: ' + fallos.length : 'TODO OK'} — ${pasadas} aserciones pasadas`);
process.exit(fallos.length ? 1 : 0);
