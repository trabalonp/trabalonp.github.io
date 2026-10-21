# Revisión de la entrega «optimización + seguridad» de Mi App Entrenos

**Fecha:** 21 de octubre de 2026
**Qué reviso:** `mi-app-entrenos-main.zip` (backend), `version22102026.zip` (app) e `INFORME TÉCNICO APP.zip` (auditoría previa), contrastados con el encargo (bloques A–D) y con la auditoría técnica ya entregada.
**Cómo lo he revisado:** lectura del código real, **ejecución de la batería de tests** (27 ficheros), consulta del paquete npm declarado, y mediciones propias (tamaño real del digest, número de lecturas). No he podido arrancar el emulador de Firestore ni un dispositivo en este entorno; lo indico en cada punto donde importa.
**Arreglos listos para copiar:** carpeta **`corregidos/`** → `corregidos/LEEME.md` (paquete completo: cada fichero corregido, `firebase.json`, `.firebaserc`, índices, reglas Fase 1 y Fase 2, worker de curvas en el servidor, tests portables y los dos `.diff`).
`arreglos/` queda como estaba (primera pasada, octubre 21); **está superado por `corregidos/`**.

---

## 0. Entrega de ficheros corregidos (22 oct 2026)

Pedido: «dámelos corregidos para que funcione todo; si falta un fichero, dime cuál».
La respuesta completa está en **`corregidos/LEEME.md`**; en corto:

- **No falta ningún fichero de código**: 0 imports relativos sin resolver en la app y 0 `require` sin resolver en el servidor.
- **Sí faltaban en los ZIP** `firebase.json`, `.firebaserc` y `.gitignore` (escritos), y el `firestore.indexes.json` venía **vacío** (rellenado con los 5 índices reales).
- **Te pido tres cosas**: confirmar el proyecto (`team-jorge-e9d8b`), exportar los índices de producción antes de desplegarlos (`npm run indexes:export`, el deploy es estado deseado y borra lo que no esté en el fichero) y, si has tocado reglas por consola, el volcado de la pestaña Rules.
- **Verificado ejecutando**: `npm test` 27/27 con el servidor y 17 OK + 10 SKIP sin él; 35 aserciones nuevas del worker; paridad exacta del digest cliente↔servidor; los dos `.diff` aplican limpios sobre los ZIP originales.
- **No verificado aquí**: la matriz de reglas, porque este entorno no tiene Java y el emulador no arranca (el test sale `SKIP`, no se inventa el resultado).

---

## 1. Veredicto en una página

**Nota global: 6,5/10.** El trabajo difícil está bien hecho y probado; la parte que
más urgía (seguridad) está escrita pero **no es ejecutable tal como se entrega** y
**no está desplegada**, así que hoy sigue exactamente igual de abierta que antes.
La optimización de curvas es sólida, medida y con pruebas que comparan contra el
código antiguo de verdad.

| Bloque | Qué pedía el encargo | Estado | Comentario |
|---|---|---|---|
| **A. Mejoras sin cambiar datos** | contadores, invalidación correcta, consulta del modal acotada, menos lecturas en FIT, script de tamaños, plantilla de índices | 🟡 **Parcial** | Todo implementado salvo la invalidación selectiva (sigue borrando 6 períodos × 4 actividades) y los índices (fichero vacío + plantilla errónea). El script de tamaños está bien y es de solo lectura. |
| **B. Seguridad** | reglas nuevas aparte, prueba con emulador, corregir `notify-message` | 🔴 **No utilizable** | `notify-message` corregido ✔. Reglas escritas y coherentes ✔ **pero no desplegadas** ✖. El test de emulador **no arranca** con la dependencia declarada ✖. Faltan `firebase.json`/`.firebaserc`, así que los comandos del README fallan ✖. |
| **C. Curvas persistentes** | esquema mensual, módulos nuevos, backfill, puntos de escritura/invalidación | 🟢 **Bien** | Diseño correcto y coherente en cliente y servidor (el servidor marca `pendientes`). Tres defectos de robustez, con parche incluido. |
| **D. Pruebas y criterios de aceptación** | equivalencia con tolerancia, medición de lecturas, tabla ítem por ítem | 🟡 **Parcial** | 5 baterías nuevas que pasan de verdad y comparan contra el legacy real. Falta **la tabla ítem por ítem con estado** que exigía el prompt (la incluyo en el §7). |

**Lo que está en riesgo hoy, por orden:**

1. Las reglas de Firestore siguen abiertas en producción (el P0 real no se ha cerrado).
2. El repositorio `trabalonp.github.io` es **público** y contiene los dos ZIP con el
   código del backend y el informe de seguridad (ver §3.5). Esto no es del trabajo
   de DeepSeek, pero es lo más urgente que he visto.
3. Si despliegas las reglas nuevas sin probarlas, es probable que **el calendario y
   el análisis del entrenador dejen de funcionar** (§4.1).
4. Si despliegas el `firestore.indexes.json` vacío, **borras los índices compuestos**
   de producción y las consultas empiezan a fallar (§3.3).

---

## 2. Lo que está bien hecho (y he comprobado ejecutándolo)

### 2.1 El motor de curvas: la parte difícil, bien resuelta

- **Equivalencia real, no supuesta.** `tests/curvas-digest-test.js` carga el
  `getStreamsStatsLegacy` **de verdad** (con Firestore simulado) y compara:
  curvas `curveRitmo/Vel/Fc/Pot/Cad` idénticas bit a bit, zonas de FC idénticas
  (tolerancia 0,01 s) y zonas de ritmo con desviación medida del **0,599 %**
  cuando los límites de zona son fraccionarios (el binning a 1 s/km). Son 44
  comprobaciones, todas en verde. El test cubre pausas `dt > 120`, puntos
  desordenados, cruce de medianoche, ciclismo con potencia y actividades sin FC.
- **Elimina el N+1 de verdad, y está medido.** `tests/perf-contadores-test.js`
  compara los dos caminos con los mismos contadores:

  | N actividades | camino | resúmenes leídos | `registros/data` leídos | puntos procesados | docs de mes | ms (Node) |
  |---:|---|---:|---:|---:|---:|---:|
  | 300 | legacy | 300 | 300 | 36.000 | — | 115 |
  | 300 | digest | **0** | **0** | **0** | 3 | 11 |

  Es exactamente el objetivo del bloque C: la gráfica de 2 años lee ~24 documentos
  en vez de cientos, y los períodos solapados reutilizan los mismos (caché por mes).
- **Las zonas se aplican al leer**, no al calcular, así que cambiar zonas no obliga
  a recalcular los digests. Está bien razonado y probado (sección 3 del test).
- **Fail-safe de verdad**: cualquier error del camino nuevo cae al legacy
  (`analyticsEngine.js:1275-1276`) y la pantalla no se rompe. El backfill inicial
  se lanza en segundo plano y sirve legacy mientras tanto (`:1250-1256`).
- **Migración limpia**: `CACHE_V = 6` invalida las cachés antiguas, y todo el camino
  nuevo está detrás de `CURVAS_DIGEST_ENABLED` (`services/appSettings.js:14`).

### 2.2 Integración con el backend (esto no lo pedía el prompt y está bien pensado)

El servidor participa en el ciclo de vida del digest sin calcularlo (acertado: el
"día local" del servidor no coincide con el del móvil):

- `lib/intervalsDetail.js:496-512` escribe `registros/data` y **marca el entreno
  como pendiente** en `analyticsCurves/{uid}.pendientes`.
- `lib/matcher.js:273-283` marca pendiente cuando la fusión cambia el `tipo`.
- El cliente lo procesa en `procesarPendientes` al entrar en Análisis.

### 2.3 Los otros puntos del bloque A

| Ítem | Evidencia | Valoración |
|---|---|---|
| Contadores de lecturas/bytes/tiempo | `services/perfLog.js`, usado en `analyticsEngine`, `curvasStore`, `SyncService`, `WorkoutDetailModal` | ✔ Bien: en memoria, sin red, activo solo en `__DEV__`/`PERF_LOG=1` |
| Condición de caché duplicada eliminada | test «A2: ya no existe la doble condición» | ✔ |
| Coalescencia de peticiones simultáneas | `inflightStreams`/`inflightLegacy` (`analyticsEngine.js:845-857`, `1183-1197`) | ✔ |
| Consulta del modal acotada | `WorkoutDetailModal.js:462-470`, rango de fechas + `limit(30)` + 12 candidatos | ✔ Resuelve el «modal que consulta todos tus entrenos» |
| Menos lecturas en la importación FIT | índice local en AsyncStorage + perfil/wellness perezosos (`SyncService.js:34-60`) | ✔ 21 comprobaciones en verde (`sync-duplicados-test.js`) |
| Script de tamaños | `tools/medir-documentos.js` (solo lectura, mide resumen/detalles/registros y `registros` embebido) | ✔ Bien hecho; el muestreo es por `limit(N)` sin aleatorizar (menor) |
| Plantilla de índices | README §«Índices de Firestore» + `firestore.indexes.json` | ✖ Ver §3.3 |
| Invalidación selectiva | `analyticsEngine.js:811-825` | 🟡 Se redujo la **frecuencia** (firma), no el **alcance** |

### 2.4 Seguridad: lo que sí está bien

- `firestore.rules.nuevo` es un trabajo serio: cierra `entrenamientos`, `detalles`,
  `registros`, `libreria`, `archivosLib`, `posts`, `analysis`, `avatares`, `retos`,
  `soporte`, `notificaciones`, `intervals_connections` y añade un cierre por
  defecto `match /{document=**} { allow read, write: if false; }`.
- Las colecciones declaradas coinciden **exactamente** con las que usa el cliente:
  lo he comprobado con un grep de `collection(db,'…')`/`doc(db,'…')` en toda la app
  (13 colecciones) y con el inventario `docs/inventario-escrituras.md` (368 líneas,
  con referencias `archivo:línea` verificables). No hay ninguna colección usada por
  el cliente que quede denegada.
- Decisiones peliagudas bien argumentadas: reacciones/votos en `posts`, `hasOnly`
  para que el entrenador solo escriba zonas/marcas, apuntados que solo pueden
  marcar `estado`/`duracion`.
- `handlers/social/notify-message.js` **corregido**: ya no devuelve la lista de
  uids (antes era una fuga de directorio de usuarios), usa `.select()` para traer
  solo `notificacionesActivadas`/`expoPushToken` y pasa el perfil precargado a
  `sendPushToUser` para no releerlo por destinatario.

---

## 3. Problemas bloqueantes (P0)

### 3.1 El test de reglas no se puede ejecutar ✖

`tests/rules/firestore-rules-test.js` usa la **API v1** de
`@firebase/rules-unit-testing` (`initializeTestApp`, `initializeAdminApp`,
`loadFirestoreRules`, `clearFirestoreData`, `apps()`), pero `package.json:73`
declara `"@firebase/rules-unit-testing": "^2.0.4"`. La v2 **eliminó** esa API.

Verificado contra el paquete real de npm (`@firebase/rules-unit-testing@2.0.4`):

```
assertFails, assertSucceeds, initializeTestEnvironment, withFunctionTriggersDisabled
```

Es decir, las cinco funciones que usa el test **no existen**. Lo he reproducido
instalando las dependencias declaradas y ejecutando el fichero:

```
tests/rules/firestore-rules-test.js:98
const adminApp = initializeAdminApp({ projectId: PROYECTO });
                 ^
TypeError: initializeAdminApp is not a function
exit code 1
```

Y no imprime `SKIP`: el `require` de la librería **sí** funciona, así que el guard
del principio no salta y el fallo ocurre en el nivel superior del módulo (fuera
del `try/catch` final). El README promete justo lo contrario («imprime SKIP y sale
con 0: nunca rompe la batería»).

**Consecuencia:** el paso 3 del procedimiento de seguridad que te dio (probar las
reglas en el emulador) no se puede completar, y por tanto el despliegue de reglas
se queda sin red de seguridad.

**Arreglo incluido:** `arreglos/tests/rules/firestore-rules-test.js` conserva la
matriz entera (400+ líneas, idéntica) y le añade una capa de compatibilidad v1→v2
construida solo con primitivas v2 (`initializeTestEnvironment`,
`authenticatedContext`, `unauthenticatedContext`, `withSecurityRulesDisabled`,
`clearFirestore`, `cleanup`). Verificado: con la librería instalada y **sin**
emulador, el original termina en `TypeError` (exit 1) y el adaptado imprime
`SKIP: arranca el emulador…` y sale con 0. **La matriz en sí no la he podido
ejecutar aquí** (sin Java/emulador); hay que correrla en tu máquina.

### 3.2 Faltan `firebase.json`, `.firebaserc` y `firebase-tools` ✖

El README documenta:

```bash
firebase emulators:start --only firestore
firebase deploy --only firestore:rules
firebase firestore:indexes > firestore.indexes.json
```

Pero el ZIP de la app **no contiene `firebase.json` ni `.firebaserc`**, y
`firebase-tools` no está en `devDependencies`. Sin `firebase.json`, la CLI aborta
con «Could not find a firebase.json» antes de hacer nada: ni emulador, ni
despliegue de reglas, ni de índices. El procedimiento entregado, tal cual, no
funciona ni en tu máquina ni en CI.

**Arreglo incluido:** `arreglos/firebase.json` (con el bloque `emulators.firestore`
en el puerto 8080 que espera el test). En `arreglos/LEEME.md` está el `.firebaserc`
de ejemplo con un proyecto `demo-*` para no apuntar a producción por accidente.

### 3.3 `firestore.indexes.json` vacío: una trampa, y la «plantilla» no cuadra ✖

El fichero entregado es:

```json
{ "indexes": [], "fieldOverrides": [] }
```

`firebase deploy --only firestore:indexes` aplica el fichero como **estado
deseado**: lo que no aparezca, se elimina. Con un array vacío, ese comando deja el
proyecto sin índices compuestos y las consultas de calendario/análisis empiezan a
fallar con el enlace de «crea el índice». El propio README dice que el fichero
está «INTENCIONADAMENTE vacío», pero aun así es el fichero que la CLI va a leer.

Además, la plantilla en prosa del README no coincide con las consultas reales:

| README propone | Realidad en el código |
|---|---|
| `analyticsCurves`: `userId` + `updatedAt` DESC | **Ninguna consulta lo usa**: `leerMes` hace `getDoc` por id (`curvasStore.js:99`) |
| `entrenamientos`: `userId` + `fecha` ASC + `createdAt` DESC | La consulta es `orderBy('fecha','desc')` y **no filtra por `createdAt`** (`analyticsEngine.js:392-404`, `curvasStore.js:364-368`) |
| *(falta)* | `entrenamientos`: `userId` + `mergedFromPlanId` (consulta del servidor, `sync-intervals.js:454-458`) |
| *(falta)* | `libreria`: `userId` + `workoutId` y `userId` + `titulo` + `tipo` (`WorkoutDetailModal.js:670,673`) |
| *(falta)* | `libreria`: `userId` + `esCarpeta` (`LibreriaDrive.js:471-475`) |

**Arreglo incluido:** `arreglos/firestore.indexes.json` con los **cinco** índices
que se deducen del código. Aun así: **exporta primero los reales**
(`firebase firestore:indexes`), fusiónalos y luego despliega.

### 3.4 La seguridad sigue sin estar cerrada (por diseño, pero es lo que más importa)

`firestore.rules` (el desplegado) sigue siendo el abierto; las nuevas están en
`firestore.rules.nuevo` y **no se han desplegado**. Es lo que pedía el encargo
(«despliega tú, no DeepSeek»), pero conviene decirlo sin ambigüedad: **a día de
hoy, cualquier usuario autenticado sigue pudiendo leer y escribir los
entrenamientos de cualquier otro conociendo el ID, y editar o borrar posts ajenos.**
El informe de auditoría, además, está publicado (ver §3.5), así que la receta es
pública.

### 3.5 (Fuera del encargo, pero urgente) El repositorio es público y contiene los ZIP

He comprobado `trabalonp/trabalonp.github.io`: `"visibility": "public"`, y en el
commit actual están versionados:

- `version22102026.zip` (28 MB) → código completo de la app, `firebaseConfig.js`,
  `google-services.json`, el bundle y los source maps.
- `mi-app-entrenos-main.zip` → **código del backend** (handlers, `lib/`, presign de
  R2, autenticación) y `tools/medir-documentos.js`.
- `INFORME TÉCNICO APP.zip` → el informe que describe **cómo explotar** las reglas
  abiertas (IDs, colecciones, `notify-message`, etc.).

No hay credenciales de servicio en los ZIP (las claves de R2 y `FIREBASE_SERVICE_ACCOUNT`
van por variables de entorno: bien), pero publicar el código del backend y el
informe de vulnerabilidades de una app en producción es un problema real.

**Recomendación:** poner el repositorio en privado (GitHub Pages puede seguir
sirviendo el sitio si el plan lo permite; si no, mover el sitio a otro repo) y, en
cualquier caso, sacar los ZIP del repositorio y de su historial (`git filter-repo`
o BFG) porque seguirán siendo descargables desde la URL pública y desde la caché
de GitHub. Si quieres, lo preparo.

---

## 4. Problemas de diseño y robustez (P1)

### 4.1 Las reglas nuevas probablemente rompen el calendario del entrenador

Está **documentado** en el propio fichero (líneas 17-27) y en el README, y es
honesto, pero sigue siendo una regresión funcional de una función central:

- El entrenador lee el calendario del atleta con
  `where('userId','==',atleta)` (`HomeScreen.js:414-420`, `CalendarScreen.js:420-436`).
- Firestore solo autoriza una *consulta* si puede demostrar la regla con las
  restricciones de la propia consulta. La rama del entrenador depende de `get()`
  sobre `perfiles`, **no es demostrable**, así que la consulta puede devolver
  `permission-denied`.
- Lo mismo para la lectura de curvas del atleta (`analyticsCurves` con `esSuEntrenador`).

La mitigación propuesta («custom claims de coach o campo `coachUid`») es la
correcta, pero **no está implementada**, y el aviso está enterrado en un README.
Si despliegas hoy, el coach puede perder el calendario y las gráficas de sus
atletas.

**Recomendación (orden):** (a) probar la matriz de consultas en el emulador con un
usuario coach **antes** de desplegar; (b) si falla, escribir `coachUid` en los
documentos del atleta al vincularse y añadir la rama
`resource.data.coachUid == request.auth.uid` (demostrable en consultas con
`where('coachUid','==',uid)`); (c) a futuro, custom claims.

### 4.2 `procesarPendientes` puede perder digests ✖

`curvasStore.js:259-320`: el id se saca de `pendientes` **siempre**, al final del
bucle (`:313`), aunque `guardarDigest` haya fallado (`:308`, que devuelve
`{ok:false}` sin lanzar). Si falla una escritura (sin permisos, cuota, documento
de mes bloqueado), ese entreno **se queda sin digest para siempre** hasta que
alguien pulse el botón de refrescar. Además, si un entreno deja de cumplir el
filtro (`estado`/`duracion`), se descarta de la cola **pero su digest anterior
sigue en el mes**, así que las curvas siguen contando una actividad que el cálculo
antiguo ya no contaría.

**Arreglo incluido en el parche** (probado: las 6 baterías afectadas siguen en
verde).

### 4.3 La guarda de tamaño de 1 MiB está a medias ✖

- `TOPE_BYTES_MES` (900 KB) solo se comprueba en `guardarDigest` y **solo si el mes
  está en la caché en memoria** (`curvasStore.js:180-196`).
- `backfill` **no comprueba nada** (`:458-483`). Si Firestore rechazara la escritura
  por pasar de 1 MiB, el error se registra, el mes se queda sin digests y
  `backfillV` se marca igualmente a 1 (`:518`): no hay reintento ni aviso.
- Si un mes se marca `oversize`, `leerMeses` **lanza** (`:143`) y el motor cae a
  legacy **para todos los períodos**, no solo para ese mes (el comentario dice lo
  contrario).

**¿Es probable que pase?** Lo he medido: un digest realista ocupa **3,7 KB (rodaje
de 1 h), 4,0 KB (tirada de 2 h) y 1,1 KB (bici de 2 h)**, dominado por las claves
de ritmo por día (≈313 claves/actividad). Un mes con 40 actividades ronda los
**160 KB**; uno muy cargado (90 actividades) ~360 KB. El riesgo es bajo, pero el
camino de error está sin cubrir. El parche añade la comprobación en `backfill`.

### 4.4 El botón de refrescar se dispara solo, y es caro

Cuando la firma de entrenos cambia tras una sincronización, `AnalysisScreen`
fuerza `{force:true}` (`screens/AnalysisScreen.js:318-321`,
`352-353`) → `computeStreamsStats` ejecuta **`CS.backfill(uid,{force:true})`**
(`analyticsEngine.js:1243-1247`), que vuelve a paginar **todos** los resúmenes
(`curvasStore.js:364-380`) antes de pintar. Con el diseño de la entrega no hace
falta: los digests ya se escriben en la importación FIT (`SyncService.js:137-141`)
y el servidor marca `pendientes` al traer detalles. Bastaría `backfill()` normal
(que no hace nada si `backfillV === 1`) y dejar el `force` para el botón manual.

### 4.5 La invalidación sigue siendo global 🟡

La firma (`firmaStreamsDe`, `analyticsEngine.js:681-702`) reduce la **frecuencia**
con la que se invalida, que era el síntoma (se borraba en cada sincronización).
Pero cuando invalida, `invalidateStreamsCache` sigue borrando **6 períodos × 4
actividades de zona = 24 claves** (`:811-825`). El encargo pedía invalidar «por
fecha/tipo». Con el digest, además, deberían invalidarse los **meses** afectados
(lo hace `invalidarCurvasEntreno`, pero **no** `syncAnalyticsDays`).

### 4.6 Cambiar las zonas no refresca las curvas (chart con datos viejos)

El diseño acierta en que el digest no depende de las zonas, pero **el resultado
fusionado sí se cachea**, y esa caché no se invalida al cambiar zonas:

- `streamMem[key]` nunca caduca: `MEM_TTL` está declarado pero no se usa
  (`analyticsEngine.js:17` y `:1206-1210`).
- El snapshot de `AsyncStorage` se lee sin comprobar antigüedad (`:1214-1228`).
- Nada llama a `invalidateStreamsCache` al guardar zonas o umbrales
  (`ZonesScreen`, `MarcasScreen`, `SettingsScreen` no lo importan).

Resultado: cambias el umbral en Zonas, vuelves a Análisis y ves **las etiquetas
nuevas con el reparto de segundos calculado con las zonas viejas**, hasta que
pulses refrescar o borres la caché. Es un fallo preexistente, pero el rediseño lo
podría haber resuelto (la fusión es barata: 24 documentos) y no lo ha hecho.

**Arreglo sugerido:** en el camino digest, no cachear el resultado fusionado (o
guardarlo con una firma de zonas en la clave); y en `ZonesScreen`, tras guardar,
`invalidateStreamsCache(uid)` + `CS.invalidarCacheMeses(uid)`.

### 4.7 `perfLog` lee `process.env` sin comprobar `process` (riesgo de crash en release)

```js
const ACTIVO = (typeof __DEV__ !== 'undefined' && __DEV__) || process.env.PERF_LOG === '1';
```

En una build de producción `__DEV__` es `false`, así que se evalúa la parte derecha.
`@react-native/js-polyfills` **no** incluye un polyfill de `process` (lo he
comprobado en el paquete), y Expo solo inserta las variables `EXPO_PUBLIC_*` en
tiempo de compilación. Si Hermes no expone `process` en tu configuración, importar
`perfLog` lanza `ReferenceError` **al arrancar la app** (lo importan `SyncService`,
`analyticsEngine` y `WorkoutDetailModal`). No he podido confirmarlo en dispositivo.

No lo doy por roto, lo doy por **no verificado y trivial de blindar** (línea incluida
en el parche):

```js
const ENV = typeof process !== 'undefined' && process && process.env ? process.env : {};
const ACTIVO = ENV.PERF_LOG === '1' || (typeof __DEV__ !== 'undefined' && __DEV__);
```

---

## 5. Problemas menores (P2/P3)

1. **El campo `sig` del digest se guarda y no se usa.** Está pensado para detectar
   cambios en `puntos`, pero ni `guardarDigest` ni `backfill` lo comparan
   (`curvasStore.js:458` solo compara `tipo` y `f`). Hoy el cliente no reescribe
   `puntos` (solo la importación y el backend), así que no hace daño; pero ocupa
   espacio y da una falsa sensación de frescura.
2. **El día de cada digest queda congelado a la zona horaria del momento del
   cálculo** (`curvasDigest.js:65`, `dayKey` en hora local). Si viajas, el reparto
   diario de un entreno antiguo no se recalcula. Menor, pero conviene documentarlo.
3. **`leerMeses` aborta todo si un mes está `oversize`** (ya comentado en §4.3).
4. **La batería de tests no está en verde tal como se entrega.** Ejecuté los 27
   `tests/*.js`: **18 en verde y 9 en rojo**. Los 9 comparten la misma causa: son
   tests del *servidor* guardados en el repo de la app que resuelven
   `server-extract/mi-app-entrenos-main` o una ruta **hardcodeada de Windows**
   (`C:\Users\FAMILIA\Downloads\mi-app-entrenos-main (3)\…`, `tests/server-ruta.js`).
   Copiando el backend a esa carpeta, **8 de los 9 pasan**; el que queda
   (`archivos-delete-test.js`) falla 2 aserciones por desajuste entre test y código
   (*«la confirmación AVISA de que el binario también se va»*), no por esta entrega.
   Recomendación: mover esos tests al repo del servidor o hacer que impriman `SKIP`.
5. **Falta la tabla ítem por ítem con estado** que exigía el bloque D. La incluyo en §7.
6. **Los diagramas `.mmd` no describen lo implementado**: siguen hablando de
   `analyticsDaily/{uid}/days/{date}`, `analyticsCurves/{uid}/period/activity` y
   `wellnessDaily`, cuando lo construido es `analyticsCurves/{uid}/months/{yyyy-mm}`
   y no hay `analyticsDaily`. Tampoco aparece el papel del servidor marcando
   `pendientes`.
7. **`notify-message`**: la corrección es buena, pero (a) el endpoint no comprueba
   que el `messageId` exista ni que sea del remitente → cualquiera autenticado puede
   hacer fan-out de push a **todos** con el texto que quiera; (b) sigue leyendo la
   colección `perfiles` entera por mensaje (la proyección ahorra bytes, **no
   lecturas**: se factura por documento) y escribe una notificación por destinatario;
   (c) `enviados` devuelve el número de destinos, no de envíos correctos.
8. **Empaquetado**: el ZIP de la app trae `dist/` (~80 MB, con `.hbc.map` de 15 MB),
   `build.pdf` (1 MB), `.expo/dev/logs/export.log` y cuatro `version*.zip` de 22
   bytes. Ruido que dificulta revisar y publicar.
9. **El README mezcla la plantilla de Expo con la documentación del trabajo** y
   afirma dos cosas que no se cumplen: que el test de reglas «nunca rompe la
   batería» (§3.1) y que la plantilla de índices está verificada (§3.3).

---

## 6. Verificaciones que he ejecutado (para que puedas reproducirlas)

| Comprobación | Resultado |
|---|---|
| `node tests/curvas-digest-test.js` | 44 OK — curvas idénticas bit a bit; zonas de ritmo ≤ 1 % (0,599 % medido) |
| `node tests/curvas-invalidacion-test.js` | 64 OK — 6 puntos de edición/borrado, A6, A5, H12 |
| `node tests/perf-contadores-test.js` | 36 OK — ver tabla del §2.1 |
| `node tests/sync-duplicados-test.js` | 21 OK — 1 consulta/archivo, perfil y wellness una vez |
| `node tests/curvas-coste-test.js` / `trimp-esfuerzo-test.js` | 149 y 57 aserciones OK (sin regresiones) |
| Batería completa (27 ficheros) | 18 verdes / 9 rojos; con el backend presente, 26/27 |
| API de `@firebase/rules-unit-testing@2.0.4` | Solo 4 exportaciones; el test usa 5 funciones inexistentes |
| Test de reglas original vs adaptado | `TypeError` exit 1 vs `SKIP` exit 0 |
| Tamaño real de un digest mensual | 3,7 KB / 4,0 KB / 1,1 KB por actividad (medido con los módulos reales) |
| Visibilidad del repo | `public`, con los dos ZIP y el informe en `main` |

**Lo que no he podido verificar:** la matriz de reglas en el emulador, el
comportamiento en dispositivo (Hermes/`process`, rendimiento real), los tamaños de
documento en producción (`tools/medir-documentos.js` hay que ejecutarlo tú) y las
reglas/índices realmente desplegados.

---

## 7. Tabla ítem por ítem (la del bloque D, que faltaba)

Estados: ✅ hecho y verificado · 🟡 parcial · 🔴 roto · ⛔ no hecho.

| Ítem | Qué pedía | Estado | Evidencia / nota |
|---|---|---|---|
| A1 | Contadores de lecturas, bytes, puntos, tiempo, hit/miss | ✅ | `services/perfLog.js` + instrumentación en 5 módulos; test de 36 comprobaciones |
| A2 | Quitar la condición de caché duplicada | ✅ | test «A2» |
| A3 | Coalescencia de peticiones simultáneas | ✅ | `inflightStreams`, `inflightLegacy`, `inflightMeses`, `inflightBackfill` |
| A4 | Invalidación correcta tras sincronización | 🟡 | Firma por entrenos completados; sigue invalidando 24 claves de golpe y no invalida los meses (`syncAnalyticsDays`) |
| A5 | Invalidar al editar/borrar | ✅ | 6 puntos en `WorkoutDetailModal` + drag en `CalendarScreen` |
| A6 | Consulta del modal acotada | ✅ | rango ±N días + `limit(30)` + 12 candidatos |
| A7 | Menos lecturas en importación FIT | ✅ | índice local + perfil/wellness perezosos |
| A8 | Script de medición de tamaños (solo lectura) | ✅ | `tools/medir-documentos.js`; mide también `registros` embebido |
| A9 | Plantilla de índices | 🔴 | Fichero vacío + 3 entradas de las que 1 no se usa y 1 no coincide; faltan 4 reales |
| B1 | Inventario de lecturas/escrituras | ✅ | `docs/inventario-escrituras.md`, 368 líneas con `archivo:línea` |
| B2 | Reglas nuevas en fichero aparte, sin desplegar | ✅ | `firestore.rules.nuevo`, coherente con el inventario y con el código |
| B3 | Pruebas con el emulador | 🔴 | Test incompatible con la dependencia declarada; no arranca (§3.1). Arreglo incluido |
| B4 | Corregir `notify-message` (no devolver uids) | ✅ | `{ ok, enviados }`, `.select()`, perfil precargado |
| B5 | Operativa para probar/desplegar | 🔴 | Faltan `firebase.json`, `.firebaserc`, `firebase-tools` (§3.2) |
| C1 | Esquema `analyticsCurves/{uid}/months/{yyyy-mm}` | ✅ | `curvasStore.js`, `v:1`, `acts.<id>`, guarda de tamaño |
| C2 | Módulos nuevos puros (cálculo) y de almacenamiento | ✅ | `curvasDigest.js` (puro, sin Firebase) + `curvasStore.js` |
| C3 | Backfill inicial, reanudable e idempotente | ✅ | Pagina resúmenes, calcula solo lo que falta, `backfillV` |
| C4 | Escritura del digest en todos los puntos | ✅ | FIT (`SyncService`), servidor (`intervalsDetail`, `matcher`), ediciones (`marcarPendiente`) |
| C5 | Las zonas se aplican al leer | ✅ | `fusionarDigests`; test de cambio de zonas |
| C6 | Cálculo antiguo conservado como respaldo | ✅ | `getStreamsStatsLegacy` + fallback en cualquier error |
| C7 | Invalidación por fecha/actividad | 🟡 | Por entreno (bien), pero global en períodos (§4.5) |
| C8 | Robustez de la cola de pendientes | 🔴 | Pierde digests si falla la escritura (§4.2). Parche incluido |
| C9 | Guarda de tamaño completa | 🔴 | Solo en `guardarDigest` y con caché caliente (§4.3). Parche incluido |
| D1 | Equivalencia numérica con tolerancia documentada | ✅ | Curvas bit a bit; ritmo ≤ 1 % (medido 0,599 %) |
| D2 | Medición de lecturas por camino | ✅ | 300 resúmenes + 300 registros vs 3 documentos |
| D3 | Pruebas de integración de los puntos de escritura | ✅ | `curvas-invalidacion-test.js` (64) |
| D4 | Tabla ítem por ítem con estado | ⛔ | No entregada; esta tabla la sustituye |
| D5 | Criterios de aceptación por fase | 🟡 | Están en el plan de optimización, no en la entrega |

---

## 8. Plan de acción recomendado

**Hoy (30 minutos, sin tocar código de la app)**

1. Repo privado + sacar los ZIP del historial (§3.5).
2. Copiar `arreglos/firebase.json` y `arreglos/firestore.indexes.json`; exportar los
   índices reales y **fusionar** antes de desplegar.
3. Copiar `arreglos/tests/rules/firestore-rules-test.js`; `npm install`; arrancar el
   emulador y ejecutar la matriz. Que salga en verde antes de nada más.

**Esta semana (seguridad de verdad)**

4. Añadir a la matriz una consulta real de coach sobre el calendario del atleta
   (`where('userId','==',atleta)`) y sobre `analyticsCurves`. Si falla (probable),
   implementar la rama `coachUid` o los custom claims antes de desplegar (§4.1).
5. Desplegar reglas en un proyecto de pruebas con datos reales anonimizados, y
   probar los 5 flujos: importar FIT, editar/borrar entreno, reaccionar/votar,
   comentar como apuntado, coach viendo atleta.
6. Solo entonces: `firebase deploy --only firestore:rules`.

**Después (rendimiento y deuda)**

7. Aplicar `arreglos/parches/curvas-pendientes-y-tamano.patch` (§4.2, §4.3, §4.7).
8. Quitar el `force` automático del refresco (§4.4) e invalidar por mes en
   `syncAnalyticsDays` (§4.5).
9. Invalidar la caché de curvas al guardar zonas y no cachear la fusión en el camino
   digest (§4.6).
10. Medir en dispositivo con `PERF_LOG=1` y `tools/medir-documentos.js` para cerrar
    las preguntas que la auditoría dejó abiertas (tamaño real de `registros/data`).
11. Actualizar los `.mmd`, el README (índices y comandos reales) y mover los tests
    del servidor a su repositorio (§5.4, §5.6).

---

## 9. Conclusión

El trabajo de optimización es **bueno y honesto**: resuelve el N+1, elimina el
procesamiento de puntos en cada render, conserva el cálculo antiguo como respaldo y
lo demuestra comparando contra el código real, no contra una reimplementación. La
integración con el backend (marcar `pendientes` desde el servidor) es un detalle de
nivel alto que no estaba en el encargo.

El trabajo de seguridad está **bien pensado y mal entregado**: las reglas son
razonables y están documentadas con referencias verificables, pero el test que
debía probarlas no funciona, faltan los ficheros para ejecutar los comandos que el
propio README indica, el fichero de índices es una trampa y, sobre todo, **nada de
eso está desplegado**. Tal como está, la entrega no reduce el riesgo real: lo deja
preparado para que lo reduzcas tú, y ese paso final es hoy el más urgente.
