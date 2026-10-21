# Ficheros corregidos — todo listo para copiar y desplegar

**Fecha:** 21-22 oct 2026 · **Base:** `version22102026.zip` (app) + `mi-app-entrenos-main.zip` (servidor)
**Carpeta:** `revision-entrega/corregidos/`

Esta carpeta contiene **cada fichero que he tocado, ya corregido y probado**, con la misma
estructura que tus repos para que se pueda copiar encima sin pensar. Al lado va
`CAMBIOS-app.diff` y `CAMBIOS-server.diff` si prefieres aplicar un parche y revisar el diff
antes de aceptar nada.

> **No he desplegado nada.** Ni reglas, ni índices, ni Vercel. Todo esto lo aplicas tú,
> como pediste. Nada de esto toca datos: el único trabajo que escribe en Firestore es el
> worker de curvas, y solo escribe `analyticsCurves/*` (documentos que ya existían).

---

## 1. La respuesta corta: ¿falta algún fichero?

**De código, no falta ninguno.** Comprobado con un resolvedor sobre los dos proyectos:

- App: **0** imports relativos sin resolver (`App.js` + `screens/ services/ components/ hooks/ constants/ app/ tools/`).
- Servidor: **0** `require()` relativos sin resolver (`api/ handlers/ lib/ tools/ scripts/`).

Lo que **no venía en los ZIP** y he tenido que escribir yo (por eso no podía "corregirlo"):

| Fichero | Estado en el ZIP | Qué he hecho |
|---|---|---|
| `firebase.json` | **no existía** | Lo he escrito (rules + indexes + emulador, sin hosting). |
| `.firebaserc` | **no existía** | Lo he escrito con `team-jorge-e9d8b` (deducido de `google-services.json` y `firebaseConfig.js`). **Confírmame el alias.** |
| `.gitignore` | **no existía** | Lo he escrito: el ZIP trae `dist/` (75 MB), `.expo/` y `build.pdf`. |
| `firestore.indexes.json` | existía pero **vacío** (`{"indexes": [], "fieldOverrides": []}`) | Lo he rellenado con los 5 índices que las consultas necesitan de verdad. **Antes de desplegar, exporta los de producción** (ver §4). |

Lo que **te pido a ti** (5 minutos):

1. **Confirma el proyecto**: `firebase use` / consola → ¿`team-jorge-e9d8b`? Si tu `.firebaserc`
   tiene un alias distinto, cámbialo en el que te dejo.
2. **Exporta los índices reales** desde la raíz de la app con tu sesión de Firebase:
   ```bash
   npm run indexes:export     # → firestore.indexes.produccion.json
   ```
   y mándamelo. `firebase deploy --only firestore:indexes` funciona como *estado deseado*:
   **borra los índices que no estén en el fichero**. Mi lista son los 5 que usa el código,
   pero si en la consola hay alguno creado a mano que no viene de ahí, lo perderías.
3. *(Opcional)* Si has tocado las reglas desde la consola y no coinciden con el
   `firestore.rules` del ZIP, mándame el volcado de la pestaña **Rules** antes de desplegar.

No falta nada más. `app.config.js` tampoco está y no hace falta: usas `app.json` + `eas.json`,
que sí vienen.

---

## 2. Inventario: qué hay y a dónde va

### App (`mi-app-entrenos/`)

| Fichero del paquete | Destino | Tipo | Qué arregla |
|---|---|---|---|
| `firestore.rules` | raíz | **reemplaza** el actual | Fase 1: cierra escrituras ajenas, lecturas filtradas por dueño y colecciones sin usar. Deployable **hoy**. |
| `firestore.rules.estricto` | raíz | **nuevo** (es tu `firestore.rules.nuevo`) | Fase 2: además cierra la lectura de `entrenamientos`. **No desplegar todavía** (§6). |
| `firebase.json` | raíz | nuevo | No existía. |
| `.firebaserc` | raíz | nuevo | No existía. |
| `firestore.indexes.json` | raíz | **reemplaza** (estaba vacío) | Los 5 índices que usan las consultas. |
| `.gitignore` | raíz | nuevo | Deja fuera `dist/`, `.expo/`, `build.pdf`. |
| `package.json` | raíz | reemplaza | Scripts `test`, `test:rules`, `emu`, `rules:deploy`, `indexes:export/deploy` + `firebase-tools` en dev. |
| `services/analyticsEngine.js` | `services/` | reemplaza | **La firma de zonas entra en la caché** (cambiar una zona ya recalcula), **invalidación por prefijo** (antes eran 6×4 claves fijas), `MEM_TTL` aplicado de verdad, y **los pendientes se procesan antes de leer los meses**. |
| `services/curvasStore.js` | `services/` | reemplaza | Un digest que falla **no se descarta** (rota al final de la cola), se quita el digest del entreno que deja de cualificar, **guarda de tamaño también en `backfill`** (antes solo en el camino normal), y el meta en memoria se actualiza al vaciar `pendientes` (adiós a los "pendientes fantasma" durante 60 s). |
| `services/perfLog.js` | `services/` | reemplaza | `typeof process !== 'undefined'`: en una build de release con Hermes podía lanzar `ReferenceError` al importarse. |
| `screens/AnalysisScreen.js` | `screens/` | reemplaza | Al detectar cambios ya **no** pone `force`: invalida y recalcula. Con `force` se lanzaba un **backfill completo** en cada sincronización. |
| `tests/server-ruta.js` | `tests/` | nuevo | Resolvedor portable del servidor (`SERVER_DIR` → `server-extract/` → repos hermanos → Descargas). |
| `tests/run-all.js` | `tests/` | nuevo | `npm test`: pasa los 27 tests y resume PASS/SKIP/FALLOS. |
| `tests/curvas-zonas-test.js` | `tests/` | nuevo | 15 aserciones sobre la firma de zonas y el orden de `pendientes`. |
| `tests/rules/firestore-rules-test.js` | `tests/rules/` | reemplaza | Tu matriz adaptada a `@firebase/rules-unit-testing@2` y con dos modos: `npm run test:rules` / `npm run test:rules:estricto`. |
| 10 tests (`archivos-delete`, `delete-media`, `dispatcher`, `duracion-pausas`, `link-preview-parse`, `matcher`, `records`, `vueltas-auto`, `zonas-editor`, `zonas-ritmo-upload`) | `tests/` | reemplazan | Los que necesitan el servidor hacen **SKIP** si no está (antes fallaban 9 de 27); y dos asserts dejaban de exigir rutas/números de tu equipo (`../../mi-app-entrenos-main`, "17 rutas"). |

### Servidor (`mi-app-entrenos-main/`)

| Fichero del paquete | Destino | Tipo | Qué hace |
|---|---|---|---|
| `lib/curvasDigest.js` | `lib/` | nuevo | Misma lógica de digest que el cliente, en CommonJS. **Paridad verificada**: mismo JSON de salida que `services/curvasDigest.js` de la app (incluido el día local). |
| `lib/workers.js` | `lib/` | nuevo | Vacía `pendientes` desde el servidor: cálculo por entreno, reclamo con TTL de 120 s (dos invocaciones no duplican), `oversize` a ~900 KB, `backfillUsuario()` y `enSegundoPlano(res, uid)` con `waitUntil`. |
| `handlers/curvas/backfill.js` | `handlers/curvas/` | nuevo | `POST /api/curvas/backfill` (solo tus propios datos; ignora cualquier `uid` del cuerpo). |
| `api/[...path].js` | `api/` | reemplaza | Una línea: registra `curvas/backfill`. Sigue con 18 requires **literales** (nft los empaqueta). |
| `handlers/sync-intervals.js` | `handlers/` | reemplaza | Al terminar la sync lanza el worker en segundo plano. Las curvas quedan al día **sin abrir la app**. |
| `tools/importar-digests.js` | `tools/` | nuevo | `node tools/importar-digests.js --uid <UID> [--forzar] [--limite N] [--dry-run]`. Para la primera puesta en marcha (o `--todos`). |
| `tests/workers-test.js` | `tests/` | nuevo | 35 aserciones con un Firestore en memoria: cola, idempotencia, `sig`, backfill, `oversize`, guardas. |

---

## 3. Instalación, paso a paso

### 3.1 App

```bash
cd mi-app-entrenos

# Opción A (recomendada): parche, para que veas cada cambio en el diff
git checkout -b seguridad-y-curvas
patch -p1 --forward < ../corregidos/CAMBIOS-app.diff

# Opción B: copiar los ficheros encima
# cp -r ../corregidos/app/. .

# Ficheros nuevos que el parche NO trae (están en corregidos/app/):
cp ../corregidos/app/firestore.rules \
   ../corregidos/app/firestore.rules.estricto \
   ../corregidos/app/firebase.json \
   ../corregidos/app/.firebaserc \
   ../corregidos/app/firestore.indexes.json \
   ../corregidos/app/.gitignore .

mkdir -p tests/rules
cp ../corregidos/app/tests/rules/firestore-rules-test.js tests/rules/
cp ../corregidos/app/tests/server-ruta.js \
   ../corregidos/app/tests/run-all.js \
   ../corregidos/app/tests/curvas-zonas-test.js tests/

npm install          # añade firebase-tools (dev)
npm test             # 17 OK · 3-10 SKIP · 0 fallos (según si tienes el servidor al lado)
```

Si quieres que los tests del servidor se ejecuten de verdad (no SKIP), deja el repo del
servidor al lado (`../mi-app-entrenos-main`) o copia el código en `server-extract/mi-app-entrenos-main`,
o define `SERVER_DIR=/ruta/al/servidor`. Entonces `npm test` da **27 OK · 0 SKIP**.

### 3.2 Reglas e índices (a mano, cuando decidas)

```bash
firebase login
firebase use team-jorge-e9d8b        # o tu alias
npm run indexes:export               # guarda los índices ACTUALES antes de nada
npm run emu                          # en otra terminal, para probar las reglas
npm run test:rules                   # matriz sobre firestore.rules (Fase 1)
npm run test:rules:estricto          # matriz sobre firestore.rules.estricto (Fase 2)
npm run rules:deploy                 # despliega SOLO reglas
# npm run indexes:deploy             # solo si el export confirma que no falta nada
```

> Las reglas nuevas **cerrarán** cosas: si la app hace una escritura que hoy pasa y con
> ellas no, la verás en los logs de Firestore (`PERMISSION_DENIED`) con la ruta exacta.
> Despliega primero en un proyecto de pruebas (`demo-entrenos`) si quieres ir sobre seguro.

### 3.3 Servidor

```bash
cd mi-app-entrenos-main
patch -p1 --forward < ../corregidos/CAMBIOS-server.diff

cp ../corregidos/server/lib/curvasDigest.js ../corregidos/server/lib/workers.js lib/
mkdir -p handlers/curvas
cp ../corregidos/server/handlers/curvas/backfill.js handlers/curvas/
cp ../corregidos/server/tools/importar-digests.js tools/
cp ../corregidos/server/tests/workers-test.js tests/

npm install          # sin dependencias nuevas
node tests/workers-test.js     # 35 comprobaciones OK
vercel --prod                  # o tu deploy habitual
```

### 3.4 Primera puesta en marcha de las curvas

```bash
# Con la service account de producción en el entorno:
export FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)"

node tools/importar-digests.js --uid TU_UID --dry-run   # ver qué haría
node tools/importar-digests.js --uid TU_UID             # escribirlo
node tools/importar-digests.js --todos                  # todos los usuarios
```

A partir de ahí ya no hace falta: cada `/api/sync-intervals` deja la cola vacía solo.
Los usuarios que no vuelvan a sincronizar siguen funcionando como hoy (el cliente calcula
lo que falte con el camino legacy).

---

## 4. Cómo verifiqué que funciona (y qué NO pude verificar)

| Prueba | Resultado |
|---|---|
| Sintaxis (`node --check`) de todos los `.js` tocados, app y servidor | OK |
| `npm test` **con** el servidor al lado | **27 OK · 0 SKIP · 0 fallos** |
| `npm test` **sin** el servidor | **17 OK · 10 SKIP · 0 fallos** (antes: 9 fallos) |
| `node tests/workers-test.js` (nuevo) | **35 comprobaciones OK** |
| Paridad digest cliente ↔ servidor | **JSON idéntico** (mismas ventanas, mismo reparto por día) |
| Curvas bit a bit frente al cálculo antiguo | desviación máx. **0,599 %** en `zoneRt` (ya medida en la revisión) |
| `CAMBIOS-app.diff` / `CAMBIOS-server.diff` sobre los ZIP limpios | aplican limpios y dejan **exactamente** los ficheros de `corregidos/` |
| Matriz de reglas en el emulador | **NO ejecutada aquí**: en este entorno no hay Java, así que el emulador no arranca. El test imprime `SKIP` y no inventa resultados. Tienes que correrlo tú (§3.2). |

También comprobé los dos `.rules` con un analizador estático propio (llaves/paréntesis
equilibrados, 19 `match`, ninguna función llamada sin definir).

---

## 5. Los cambios, en corto

1. **La caché de curvas ignoraba las zonas.** Cambiabas una zona o el umbral y la app
   seguía sirviendo el reparto viejo (con las etiquetas nuevas) hasta pulsar refrescar.
   Ahora la clave lleva una firma de las zonas resueltas → recálculo automático.
2. **`force` en cada sincronización = backfill completo.** `AnalysisScreen` ponía
   `forceStreams = true` al detectar cambios, y eso dispara `backfill`, que pagina todos
   los resúmenes y relee `registros/data`. Ahora invalida y recalcula normal (≈24 lecturas
   de mes). `force` queda solo para el botón manual.
3. **`MEM_TTL` no se usaba**: entradas de caché de curvas eternas. Ahora caducan a los 5 min.
4. **Los digests que fallaban se perdían.** Se sacaban de `pendientes` aunque la escritura
   no hubiera ido bien. Ahora se reintentan (rotando al final de la cola) y, si un entreno
   deja de cualificar, su digest se elimina del mes.
5. **`backfill` no miraba el tamaño del documento.** Un mes de 1 MiB hace que Firestore
   rechace la escritura: el meta quedaba en `backfillV: 1` y el mes vacío para siempre.
   Ahora se marca `oversize` y ese mes usa el cálculo legacy.
6. **El servidor ya sabe calcular digests.** Antes solo marcaba `pendientes` y el móvil
   tenía que abrir Análisis. Ahora la sync deja las curvas al día, y hay un backfill por
   CLI. El coste está acotado: 1 lectura de `registros/data` por entreno pendiente, 25 por
   sincronización, y un reclamo con TTL evita duplicar trabajo.
7. **`process` en `perfLog.js`** rompía en release con Hermes.
8. **`sig` ya se compara** (cliente legacy aparte: en el servidor, un digest solo se
   recalcula si los puntos cambiaron de verdad).
9. **Tests portables**: 27/27 en verde en cualquier máquina, con SKIP explícito cuando
   falta el backend.
10. **Reglas e índices**: `firestore.rules` cerrado donde se puede cerrar sin romper nada,
    `firestore.rules.estricto` como objetivo, y 5 índices reales en vez de un fichero vacío.

Lo que **no** he tocado, porque en la revisión lo dejamos fuera de alcance hasta tener
mediciones: separar wellness, mover `registros` a R2, y `WeeklyKmChart` (la fórmula de
ritmo es distinta a propósito).

---

## 6. Fase 2 de las reglas: por qué no la puedes desplegar hoy

`firestore.rules.estricto` cierra también la **lectura** de `entrenamientos` a dueño y
entrenador. Y ahí está el problema: el calendario del entrenador consulta

```js
where('userId', '==', atleta)   // HomeScreen.js:414, CalendarScreen.js:420
```

Firestore **no puede demostrar** una regla basada en `get()` para una consulta: la evalúa
contra el documento que pides, no contra los que devolvería la query. Resultado: el
entrenador dejaría de ver el calendario de sus atletas.

Para pasar a Fase 2 hay que elegir una de estas dos (y solo entonces desplegarla):

- **(a) `coachUid` en el documento**: escribir el uid del entrenador en cada entreno
  (`esSuEntrenador` deja de consultar `relaciones` con `get()`), y que la query sea
  `where('coachUid','==',miUid)`. Necesita migración de datos y tocar el cliente.
- **(b) Custom claims**: meter los atletas del entrenador en el token
  (`coach: { atletas: [...] }`) con un endpoint + trigger. La query no cambia, pero el
  token hay que refrescarlo y hay un límite de 1 KB por claim.

Mi recomendación: (a) para el calendario (es una migración de una sola pasada y un campo
en las escrituras), y Fase 2 después de una semana con Fase 1 en producción sin
`PERMISSION_DENIED` en los logs.

---

## 7. Si algo va mal (vuelta atrás)

- **Reglas**: la consola de Firebase guarda el historial; un clic en la versión anterior.
  El fichero antiguo está intacto en tu repo (`git checkout -- firestore.rules`).
- **Índices**: los que borres se pueden recrear; por eso el paso obligatorio es el export
  previo. Si desplegaste sin exportar, la consola los lista en *Indexes* y se recrean a mano.
- **Servidor**: el worker está envuelto en `try/catch` y nunca lanza hacia la respuesta. Si
  quieres desactivarlo sin desplegar, comenta la llamada `enSegundoPlano(res, uid, …)` en
  `sync-intervals.js`: todo lo demás sigue igual.
- **App**: si la firma de zonas te diera algún problema, `git revert` del commit del parche
  y vuelve al comportamiento anterior (solo cambia el rendimiento, no los datos).
