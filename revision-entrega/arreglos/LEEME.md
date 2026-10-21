# Arreglos listos para copiar (revisión del 21/10/2026)

Estos ficheros **no** se han aplicado sobre tu proyecto: están preparados para que
los copies tú, porque el código de la app no vive en este repositorio (aquí solo
están los ZIP que subiste). Todo lo de esta carpeta está explicado con detalle en
`../REVISION-TECNICA-ENTREGA.md`.

| Fichero | Dónde va | Para qué |
|---|---|---|
| `firebase.json` | raíz del repo de la app (`mi-app-entrenos/`) | Sin él, `firebase emulators:start`, `firebase deploy --only firestore:rules` y `firebase firestore:indexes` fallan con «Could not find a firebase.json». |
| `firestore.indexes.json` | raíz del repo de la app (sustituye al actual) | El actual está vacío (`{"indexes": [], "fieldOverrides": []}`); desplegarlo sincroniza el estado y **elimina los índices compuestos** que hoy usan las consultas. Este fichero lista los índices que el código necesita de verdad. **Léelo antes de desplegar (ver aviso abajo).** |
| `tests/rules/firestore-rules-test.js` | `tests/rules/` del repo de la app (sustituye al actual) | El original usa la API v1 de `@firebase/rules-unit-testing` y con la dependencia declarada (`^2.0.4`) muere con `TypeError: initializeAdminApp is not a function`. Este conserva la matriz entera y le pone una capa de compatibilidad v1→v2. |
| `parches/curvas-pendientes-y-tamano.patch` | raíz del repo de la app | Tres correcciones de robustez en `services/curvasStore.js` y `services/perfLog.js`. |

## 1. Reglas y emulador

```bash
cd mi-app-entrenos
cp /ruta/a/estos/arreglos/firebase.json .
cp /ruta/a/estos/arreglos/tests/rules/firestore-rules-test.js tests/rules/
npm install                     # instala @firebase/rules-unit-testing ^2.0.4
npx firebase-tools emulators:start --only firestore --project demo-entrenos
# en otra terminal:
node tests/rules/firestore-rules-test.js
```

`--project demo-entrenos` hace que el emulador use un proyecto ficticio: no toca
tu proyecto real ni pide credenciales. Si prefieres fijarlo, crea un `.firebaserc`
**aparte** (no lo he incluido para no apuntar a tu proyecto de producción por
error):

```json
{ "projects": { "default": "demo-entrenos" } }
```

Cuando la matriz salga en verde, despliega las reglas **a mano**:

```bash
# revisa primero firestore.rules.nuevo y decide (opción A: apuntar firebase.json al nuevo)
#   "firestore": { "rules": "firestore.rules.nuevo", ... }
# o (opción B: renombrar)
mv firestore.rules firestore.rules.abierto.antiguo
cp firestore.rules.nuevo firestore.rules
firebase deploy --only firestore:rules
```

> Lo he verificado hasta donde se puede sin emulador: con la librería instalada,
> el test original termina en `TypeError` (exit 1) y el adaptado imprime
> `SKIP ...` y sale con 0 cuando no hay emulador. La matriz en sí no la he podido
> ejecutar aquí (este entorno no tiene Java ni el emulador de Firestore).

## 2. Índices: aviso importante

Antes de desplegar, exporta los índices reales de tu proyecto y **fusiona**:

```bash
firebase firestore:indexes > firestore.indexes.produccion.json
# compara con el firestore.indexes.json de esta carpeta y une los que falten
firebase deploy --only firestore:indexes
```

El despliegue aplica el fichero como *estado deseado*: los índices compuestos que
no aparezcan en él se eliminan. Los cinco que incluyo salen de leer las consultas
reales del código (no de una plantilla aproximada):

1. `entrenamientos`: `userId` ASC + `fecha` DESC — Home, Calendario, motor de
   analíticas (`fetchWorkouts`, `getStreamsStats`), backfill de curvas, modal.
2. `entrenamientos`: `userId` ASC + `mergedFromPlanId` ASC — consulta del
   servidor en `handlers/sync-intervals.js` (paso 2b).
3. `libreria`: `userId` ASC + `workoutId` ASC — `WorkoutDetailModal.js:670`.
4. `libreria`: `userId` ASC + `titulo` ASC + `tipo` ASC — `WorkoutDetailModal.js:673`.
5. `libreria`: `userId` ASC + `esCarpeta` ASC — `components/LibreriaDrive.js:471-475`.

No hace falta índice para `posts`/`notificaciones` (ordenan por `createdAt`, un
solo campo) ni para `perfiles where entrenador ==` / `asignados array-contains`
(un solo campo). El índice `analyticsCurves: userId + updatedAt DESC` que sugiere
el README **no lo usa ninguna consulta**: `leerMes` hace `getDoc` por id.

## 3. Parche de curvas

```bash
cd mi-app-entrenos
git apply --check /ruta/a/estos/arreglos/parches/curvas-pendientes-y-tamano.patch
git apply          /ruta/a/estos/arreglos/parches/curvas-pendientes-y-tamano.patch
node tests/curvas-digest-test.js
node tests/curvas-invalidacion-test.js
node tests/perf-contadores-test.js
```

Lo he aplicado sobre una copia de tus ficheros y **las seis baterías afectadas
siguen en verde** (digest 44, invalidación 64, contadores 36, duplicados 21,
coste 149, TRIMP 57). El parche hace tres cosas:

1. `procesarPendientes` ya no borra de `pendientes` un entreno cuyo digest no se
   pudo guardar (antes se perdía el digest hasta pulsar refrescar), y quita el
   digest de un entreno que deja de cumplir el filtro (p. ej. duración a 0).
2. `backfill` comprueba el tamaño del mes antes de escribirlo y lo marca
   `oversize` en vez de perderlo silenciosamente si Firestore rechazara la
   escritura por pasar de 1 MiB.
3. `perfLog` deja de leer `process.env` sin comprobar que `process` exista (en
   una build de release con Hermes eso puede lanzar `ReferenceError` al importar
   el módulo, y lo importan `SyncService`, `analyticsEngine` y el modal).
