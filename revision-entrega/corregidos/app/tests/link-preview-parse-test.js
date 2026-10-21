/* Verifica la parte PURA del generador de previews de enlaces del servidor
   (workspace-anterior/.../lib/linkPreviewParse.js, CommonJS real):
   · ipPrivada   → protección SSRF (IPv4/IPv6 privadas, metadata de nube)
   · decodar     → entidades HTML
   · metaContent → og:title/og:image/twitter:… en cualquier orden de atributos
   · tituloHtml / absoluta
   Uso: node tests/link-preview-parse-test.js */
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

const LIB = path.join(require('./server-ruta')(), 'lib', 'linkPreviewParse.js');
const { ipPrivada, decodar, metaContent, tituloHtml, absoluta } = require(LIB);

/* ── SSRF: IPs privadas/reservadas ── */
ok(ipPrivada('127.0.0.1') === true, 'loopback rechazada');
ok(ipPrivada('10.1.2.3') === true, '10/8 rechazada');
ok(ipPrivada('172.16.0.1') === true && ipPrivada('172.31.9.9') === true, '172.16/12 rechazada');
ok(ipPrivada('172.15.0.1') === false && ipPrivada('172.32.0.1') === false, '172.15/172.32 son públicas');
ok(ipPrivada('192.168.1.1') === true, '192.168/16 rechazada');
ok(ipPrivada('169.254.169.254') === true, 'metadata de nube rechazada');
ok(ipPrivada('100.64.0.1') === true && ipPrivada('100.127.9.9') === true, 'CGNAT rechazada');
ok(ipPrivada('0.0.0.0') === true, '0.0.0.0 rechazada');
ok(ipPrivada('::1') === true, 'IPv6 loopback rechazada');
ok(ipPrivada('fe80::1') === true, 'IPv6 link-local rechazada');
ok(ipPrivada('fc00::1') === true && ipPrivada('fd12::1') === true, 'IPv6 única-local rechazada');
ok(ipPrivada('::ffff:10.0.0.1') === true, 'IPv4 mapeada privada rechazada');
ok(ipPrivada('8.8.8.8') === false, 'DNS de Google es pública');
ok(ipPrivada('1.1.1.1') === false, '1.1.1.1 es pública');
ok(ipPrivada('93.184.216.34') === false, 'example.com es pública');
ok(ipPrivada('') === true && ipPrivada(null) === true, 'entrada vacía: se trata como no-permitida');

/* ── Entidades HTML ── */
ok(decodar('Hola &amp; adi&oacute;s') === 'Hola & adiós', 'entidades numéricas y &amp;');
ok(decodar('&lt;b&gt;titulo&quot;x&quot;&lt;/b&gt;') === '<b>titulo"x"</b>', 'lt/gt/quot');
ok(decodar('a&#65;b') === 'aAb', 'decimal');
ok(decodar('  varios   espacios \n aquí ') === 'varios espacios aquí', 'colapso de espacios');
ok(decodar(null) === '', 'null tolerado');

/* ── Metadatos Open Graph ── */
const html1 = '<html><head>' +
  '<meta property="og:title" content="Sesión de series 5x400">' +
  '<meta property="og:description" content="Plan de entrenamiento &amp; consejos">' +
  '<meta property="og:image" content="/img/portada.jpg">' +
  '<meta property="og:site_name" content="MiClub">' +
  '<title>título genérico</title></head><body></body></html>';
ok(metaContent(html1, ['og:title', 'twitter:title']) === 'Sesión de series 5x400', 'og:title');
ok(metaContent(html1, ['og:description', 'description']) === 'Plan de entrenamiento & consejos', 'og:description con entidad');
ok(metaContent(html1, ['og:image']) === '/img/portada.jpg', 'og:image relativa');
ok(metaContent(html1, ['og:site_name']) === 'MiClub', 'og:site_name');
ok(metaContent(html1, ['og:video']) === null, 'meta ausente: null');

// Atributos en otro orden (content antes que property) y comillas simples
const html2 = "<meta content='Solo Twitter' name='twitter:title'>" +
  '<META CONTENT="Imagen TW" NAME="twitter:image">';
ok(metaContent(html2, ['og:title', 'twitter:title']) === 'Solo Twitter', 'twitter:title con atributos invertidos');
ok(metaContent(html2, ['twitter:image']) === 'Imagen TW', 'META en mayúsculas');

// Fallbacks: sin og: pero con <title> y meta description
const html3 = '<head><meta name="description" content="Descripción clásica"><title>  Página  vieja  </title></head>';
ok(tituloHtml(html3) === 'Página vieja', 'tituloHtml colapsa espacios');
ok(metaContent(html3, ['og:title', 'twitter:title']) === null && metaContent(html3, ['description']) === 'Descripción clásica', 'meta description clásica');

// Primer valor gana (duplicados)
const html4 = '<meta property="og:title" content="Primero"><meta property="og:title" content="Segundo">';
ok(metaContent(html4, ['og:title']) === 'Primero', 'con duplicados gana el primero');

// Tolerancia
ok(metaContent('', ['og:title']) === null, 'html vacío no lanza');
ok(metaContent(null, null) === null, 'entradas null no lanzan');
ok(tituloHtml('sin title aquí') === null, 'sin <title>: null');

/* ── URLs absolutas ── */
ok(absoluta('https://x.com/a/b', '/img/c.jpg') === 'https://x.com/img/c.jpg', 'relativa de raíz');
ok(absoluta('https://x.com/a/b', 'c.jpg') === 'https://x.com/a/c.jpg', 'relativa de carpeta');
ok(absoluta('https://x.com', 'https://cdn.y.com/i.png') === 'https://cdn.y.com/i.png', 'absoluta intacta');
ok(absoluta('https://x.com', 'ftp://mal.com') === null, 'protocolo raro: null');
ok(absoluta('https://x.com', null) === null && absoluta(null, 'x') === null, 'null tolerado');

console.log(fallos === 0 ? '\nTODO OK' : '\n' + fallos + ' FALLOS');
process.exit(fallos === 0 ? 0 : 1);
