/* tests/zonas-ritmo-upload-test.js — REGRESIÓN RONDA 44 (zonas de ritmo por
   actividad + crash de subida de archivos).
   Cubre los dos arreglos de la ronda:
     1) ZONAS DE RITMO POR ACTIVIDAD (tarea quedada a medias por otra IA):
        · El resumen semanal (WeeklyKmChart) resuelve las zonas de ritmo con
          zonasDeActividad(perfil,'Ritmo','Running'): si el perfil tiene zonas
          específicas de Running las usa aunque las genéricas estén vacías.
        · kcal y altura del resumen NO dependen de las zonas: antes, con las
          genéricas vacías, TODO el bloque extra se ponía a 0.
        · La caché del resumen no puede quedarse clavada en los ceros viejos.
        · AnalysisScreen tiene selector de actividad (General/Running/
          Ciclismo/Natación) para la distribución de zonas de ritmo, con
          smart-default a Running y clave de caché del motor por actividad.
        · Sin setState síncronos dentro de effects (renders en cascada).
     2) SUBIDA DE ARCHIVOS DESDE UN ENTRENO (NullPointerException nativo):
        · expo-file-system legacy NO tiene FileSystemUploadType.BINARY_UPLOAD;
          leerlo daba undefined y el módulo nativo crasheaba con
          «NullPointerException: FileSystemUploadType.ordinal()».
        · Ahora se resuelve BINARY_CONTENT con fallbacks (misma protección que
          SocialScreen/avatarCache) y uploadType NUNCA sale null/undefined.
   Uso: node tests/zonas-ritmo-upload-test.js */
'use strict';
const fs = require('fs');
const path = require('path');

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

const RAIZ = path.join(__dirname, '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const srcWeekly = leer('components/WeeklyKmChart.js');
const srcAnalysis = leer('screens/AnalysisScreen.js');
const srcEngine = leer('services/analyticsEngine.js');
const srcUpload = leer('services/archivosUpload.js');
const srcSocial = leer('screens/SocialScreen.js');
const srcAvatar = leer('services/avatarCache.js');
const srcZonas = leer('services/zonas.js');

console.log('— 1) WeeklyKmChart: zonas de ritmo de Running y kcal/altura sin zonas —');
ok(/import \{ zonasDeActividad \} from '\.\.\/services\/zonas';/.test(srcWeekly), 'importa zonasDeActividad');
ok(/zonasDeActividad\(s\.data\(\),'Ritmo','Running'\)/.test(srcWeekly), 'resuelve las zonas de ritmo con las específicas de Running');
ok(!/if\(!zonesRitmo\.length\)\{ setExtra\(\{ zoneSec:\[\], kcal:0, altura:0 \}\); return; \}/.test(srcWeekly), 'ya no existe el corte que ponía kcal/altura a 0 sin zonas genéricas');
ok(/if\(zonesRitmo\.length && w\.tipo==='Running'\)\{/.test(srcWeekly), 'la distribución por zonas se salta si no hay zonas, pero el bucle de kcal/altura sigue');
ok(/if\(cached && \(!zonesRitmo\.length \|\| \(cached\.zoneSec\|\|\[\]\)\.length\)\)/.test(srcWeekly), 'la caché del resumen no congela los ceros anteriores al fix');
{
  // El effect de zonas mete TODO su setState dentro de la función async.
  const i0 = srcWeekly.indexOf('if(!uid) return;');
  const iAsync = srcWeekly.indexOf('(async()=>', i0);
  const iSet = srcWeekly.indexOf('setZonesRitmoState(', i0);
  ok(i0 > 0 && iAsync > 0 && iSet > iAsync, 'el effect de zonas no hace setState síncrono (va dentro del async)');
}
ok(/const \[zonesRitmo,setZonesRitmoState\]=useState/.test(srcWeekly) && !/setZonasRitmoState/.test(srcWeekly), 'el setter se llama setZonesRitmoState en todas partes (errata preexistente corregida)');

console.log('— 2) AnalysisScreen: selector de actividad para las zonas de ritmo —');
ok(/import React, \{ useCallback, useEffect, useMemo, useRef, useState \} from 'react';/.test(srcAnalysis), 'useMemo importado (faltaba y rompía el memo de profileZonas)');
ok(/const \[zonaAct, setZonaAct\] = useState\('General'\);/.test(srcAnalysis), 'estado zonaAct con default General');
ok(/const zonaActTocada = useRef\(false\);/.test(srcAnalysis), 'ref para no pisar la elección manual al refrescar');
ok(/if \(p && !zonaActTocada\.current && !\(Array\.isArray\(p\.zonasRitmo\) && p\.zonasRitmo\.length\)\) \{/.test(srcAnalysis), 'smart-default a Running sólo si el usuario no ha tocado el selector');
ok(/zonasDeActividad\(profile, 'Ritmo', zonaAct === 'General' \? null : zonaAct\)/.test(srcAnalysis), 'profileZonas resuelve las zonas con zonasDeActividad');
ok(/getStreamsStats\(uid, period, profileZonas, \{ force: forceStreams, zonaAct \}\)/.test(srcAnalysis), 'el motor recibe la actividad elegida');
ok(/\['General', 'Running', 'Ciclismo', 'Natación'\]\.map\(\(act\) =>/.test(srcAnalysis), 'el selector ofrece General/Running/Ciclismo/Natación');
ok(/onPress=\{\(\) => \{ zonaActTocada\.current = true; setZonaAct\(act\); setStreams\(\{\}\); \}\}/.test(srcAnalysis), 'al pulsar el selector se vacían los streams (recálculo) sin effect con setState');
ok(!/\}, \[zonaAct\]\);/.test(srcAnalysis), 'sin effect de limpieza con setState síncrono (react-compiler)');

console.log('— 3) analyticsEngine: caché de streams por actividad —');
// Revisión 2026-10-21: la clave lleva ADEMÁS la firma de zonas (cambiar una
// zona o un umbral ya no sirve el snapshot viejo). El grupo es opcional para
// no atar el test a un nombre de función concreto.
ok(/const key = `\$\{uid\}:\$\{period\}:\$\{zonaAct\}(:\$\{firmaZonasDe\(profile\)\})?`;/.test(srcEngine), 'la clave de memoria incluye zonaAct');
ok(/const storageKey = `analyticsStreams_v\$\{CACHE_V\}_\$\{uid\}_\$\{period\}_\$\{zonaAct\}(_\$\{firmaZonasDe\(profile\)\})?`;/.test(srcEngine), 'la clave de AsyncStorage incluye zonaAct');
ok(/export async function getStreamsStats\(uid, period, profile, \{ force = false, zonaAct = 'General' \} = \{\}\)/.test(srcEngine), 'getStreamsStats acepta zonaAct con default General');
ok(/export function invalidateStreamsCache\(uid\)/.test(srcEngine), 'invalidateStreamsCache exportado');
ok(/export function firmaZonasDe\(profile\)/.test(srcEngine), 'firmaZonasDe exportada (firma de zonas para las claves de caché)');
ok((srcEngine.match(/firmaZonasDe\(profile\)/g) || []).length >= 4, 'la firma de zonas se usa en memoria y en AsyncStorage de los dos caminos');
ok(/for \(const za of \['General', 'Running', 'Ciclismo', 'Natación'\]\) \{/.test(srcEngine), 'la invalidación barre los sufijos de actividad');
ok(/invalidateStreamsCache\(uid\);/.test(srcEngine), 'el sync incremental invalida zonas/curvas al traer entrenos nuevos');

console.log('— 4) Subida de archivos: el uploadType NUNCA puede llegar undefined al nativo —');
ok(!/FileSystemUploadType\.BINARY_UPLOAD|M\.BINARY_UPLOAD/.test(srcUpload), 'archivosUpload ya no lee el miembro inexistente BINARY_UPLOAD');
ok(!/BINARY_UPLOAD/.test(srcSocial) && !/BINARY_UPLOAD/.test(srcAvatar), 'SocialScreen y avatarCache tampoco usan BINARY_UPLOAD');
ok(/typeof M\.BINARY_CONTENT === 'number'/.test(srcUpload), 'archivosUpload resuelve BINARY_CONTENT como SocialScreen/avatarCache');
ok(/uploadType: typeof BIN_UPLOAD === 'number' \? BIN_UPLOAD : 0,/.test(srcUpload), 'uploadType con doble seguridad (número o 0)');
{
  // Se extrae el resolver REAL del fuente y se prueba con enums fingidos,
  // incluido el roto de antes (sólo BINARY_UPLOAD) que devolvía undefined.
  const a = srcUpload.indexOf('const BIN_UPLOAD = (() => {');
  const b = srcUpload.indexOf('})();', a);
  ok(a > 0 && b > a, 'se localiza el resolver BIN_UPLOAD en el fuente');
  const codigo = srcUpload.slice(a, b + 5);
  const resolver = new Function('FileSystem', `${codigo}\nreturn BIN_UPLOAD;`);
  const casos = [
    [{ FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 } }, 0, 'enum normal (BINARY_CONTENT=0)'],
    [{ FileSystemUploadType: { BINARY_CONTENT: 1, MULTIPART: 0 } }, 1, 'enum con valores_swap'],
    [{ FileSystemUploadType: { MULTIPART: 1 } }, 0, 'enum sin BINARY_CONTENT'],
    [{ FileSystemUploadType: { BINARY_UPLOAD: 1 } }, 0, 'enum ROTO de antes (sólo BINARY_UPLOAD) → 0, no undefined'],
    [{}, 0, 'sin enums'],
    [undefined, 0, 'FileSystem vacío'],
  ];
  for (const [fake, esp, nom] of casos) {
    const v = resolver(fake);
    eq(v, esp, `resolver ${nom} → ${esp}`);
    ok(typeof v === 'number', `resolver ${nom} devuelve número (nunca undefined/null)`);
  }
}

console.log('— 5) zonasDeActividad: comportamiento real (eval del fuente) —');
{
  const a = srcZonas.indexOf('const METRIC_KEY');
  const b = srcZonas.indexOf('export function zonasDeActividad');
  const c = srcZonas.indexOf('\n}', b);
  const codigo = srcZonas.slice(a, c + 2).replace(/^export\s+/gm, '');
  const zonasDeActividad = new Function(`${codigo}\nreturn zonasDeActividad;`)();
  const G = [{ id: 'g' }], R = [{ id: 'r' }], F = [{ id: 'f' }];
  const perfil = { zonasRitmo: G, zonasFC: F, zonasActividad: { Running: { ritmo: R } } };
  eq(zonasDeActividad(perfil, 'Ritmo', 'Running'), R, 'Running con específicas → específicas');
  eq(zonasDeActividad(perfil, 'Ritmo', null), G, 'General → genéricas');
  eq(zonasDeActividad(perfil, 'Ritmo', 'Ciclismo'), G, 'Ciclismo sin específicas → genéricas');
  eq(zonasDeActividad({ zonasRitmo: G, zonasActividad: { Running: { ritmo: [] } } }, 'Ritmo', 'Running'), G, 'Running con específicas vacías → genéricas');
  const vNulo = zonasDeActividad(null, 'Ritmo', 'Running');
  ok(Array.isArray(vNulo) && vNulo.length === 0, 'perfil nulo → lista vacía (sin crash)');
  eq(zonasDeActividad(perfil, 'FC', 'Running'), F, 'FC con actividad sin específicas de FC → genéricas de FC');
}

console.log(`\n${pasadas} comprobaciones OK, ${fallos.length} fallos.`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach((f) => console.log(' - ' + f)); process.exit(1); }
console.log('TEST ZONAS+SUBIDA: PASS');
