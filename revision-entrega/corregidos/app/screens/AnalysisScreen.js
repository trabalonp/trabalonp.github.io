// screens/AnalysisScreen.js
/* Pantalla de Análisis: dashboard de gráficas configurables del atleta.

   REDISEÑO "DASHBOARD VIVO" (sin tocar la lógica interna): cada gráfica es
   una tarjeta con acento de color e icono propios según su tipo, entrada
   escalonada, efecto muelle al pulsar, cabecera con título + agrupación/
   período, y modales (añadir / configurar) reestilizados. Nada de
   "recuadro-resumen arriba y lista debajo": aquí cada tarjeta ES el
   protagonista.

   EJE X A 45º: las etiquetas de las barras (días, semanas, meses, ventanas
   de las curvas) se dibujan rotadas -45º y se muestran MUCHAS más que antes
   (antes salía 1 de cada ~6 y se truncaban a "…"). Ahora:
     · ≤ 14 buckets  → TODAS las etiquetas
     · ≤ 30 buckets  → 1 de cada 2
     · más           → 1 de cada ceil(n/12)
   La rotación permite que quepan los nombres completos ("09-30", "S25"…).

   La funcionalidad interna (carga caché→Firestore, sync incremental, zonas
   de ritmo por actividad, curvas, records, mover/borrar/configurar) es la
   misma que antes. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View, Vibration, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SystemBars from '../components/SystemBars';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebaseConfig';
import { getCachedProfile } from '../services/profileCache';
import { bumpRefresh, getEntrenamientos } from '../services/chartCache';
import { getSettingsSnapshot, getThemeColors, useAppSettings } from '../services/appSettings';
import { zonasDeActividad } from '../services/zonas';
import { getAnalyticsDays, syncAnalyticsDays, invalidateAnalytics, invalidateStreamsCache, buildDaysFromWorkouts, buildSeries, buildRecords, getStreamsStats, STREAM_LABELS } from '../services/analyticsEngine';
import { procesarPendientes } from '../services/curvasStore';

const NAVY='#0D1B2A', CARD='#162032', BLUE='#4A90E2', BORDER='#1E3048', WHITE='#E8EDF5', GREEN='#2DB37A';
const STREAM_TYPES = ['zonasfc','zonasritmo','zonaspot','curvaritmo','curvavel','curvafc','curvapot','curvacad'];
const CATALOG = [
  { section: 'Entrenamiento', items: [
    { tipo:'rendimiento', label:'Rendimiento', unit:'%' },
    { tipo:'distancia', label:'Distancia', unit:'km' },
    { tipo:'duracion',   label:'Duración', unit:'h' },
    { tipo:'esfuerzo', label:'Esfuerzo', unit:'carga' },
    { tipo:'fcmedia', label:'FC media', unit:'ppm' },
    { tipo:'elevacion', label:'Elevación', unit:'m' },
    { tipo:'potencia', label:'Potencia', unit:'W' },
  ]},
  { section: 'Zonas', items: [
    { tipo:'zonasfc', label:'Frecuencia cardíaca', unit:'min' },
    { tipo:'zonasritmo', label:'Ritmo', unit:'min' },
    { tipo:'zonaspot', label:'Potencia', unit:'min' },
  ]},
  { section: 'Curvas', items: [
    { tipo:'curvaritmo', label:'Curva de ritmo', unit:'/km' },
    { tipo:'curvavel', label:'Curva de velocidad (bici)', unit:'km/h' },
    { tipo:'curvafc',   label:'Curva de FC', unit:'ppm' },
    { tipo:'curvapot', label:'Curva de potencia', unit:'W' },
    { tipo:'curvacad', label:'Curva de cadencia', unit:'rpm' },
  ]},
  { section: 'Récords',  items: [ { tipo:'records', label:'Mejores marcas', unit:'' } ]},
  { section: 'Métricas corporales', items: [
    { tipo:'sueno',  label:'Sueño', unit:'h' },
    { tipo:'score', label:'Puntuación de sueño', unit:'' },
    { tipo:'fcmax', label:'FC máxima', unit:'ppm' },
    { tipo:'fcreposo', label:'FC en reposo', unit:'ppm' },
    { tipo:'vo2', label:'VO2 máx', unit:'' },
    { tipo:'ftp', label:'FTP', unit:'W' },
    { tipo:'lthr', label:'LTHR', unit:'ppm' },
    { tipo:'ritmoumbral', label:'Ritmo umbral', unit:'/km' },
    { tipo:'calorias', label:'Calorías', unit:'kcal' },
    { tipo:'vfc', label:'VFC', unit:'ms' },
    { tipo:'spo2', label:'SpO2', unit:'%' },
    { tipo:'pasos', label:'Pasos', unit:'' },
  ]},
];
const GROUPS = ['Diario', 'Semanal', 'Mensual', 'Año'];
const GROUP_KEY = { 'Diario':'diario', 'Semanal':'semanal', 'Mensual':'mensual', 'Año':'anio' };
const GROUP_REV = { diario: 'Diario', semanal: 'Semanal', mensual: 'Mensual', anio: 'Año' };
const GROUP_REV_EN = { diario: 'Daily', semanal: 'Weekly', mensual: 'Monthly', anio: 'Year' };
const PERIODS = ['Últimos 30 días', 'Últimos 3 meses', 'Últimos 6 meses', 'Último año', 'Últimos 2 años', 'Todo'];
const PERIOD_KEY = { 'Últimos 30 días':'30d', 'Últimos 3 meses':'3m', 'Últimos 6 meses':'6m', 'Último año':'1y', 'Últimos 2 años':'2y', 'Todo':'todo' };
const PERIOD_REV = { '30d': 'Últimos 30 días', '3m': 'Últimos 3 meses', '6m': 'Últimos 6 meses', '1y': 'Último año', '2y': 'Últimos 2 años', todo: 'Todo' };
const PERIOD_REV_EN = { '30d': 'Last 30 days', '3m': 'Last 3 months', '6m': 'Last 6 months', '1y': 'Last year', '2y': 'Last 2 years', todo: 'All time' };
const AVAILABLE_TYPES = new Set(CATALOG.flatMap((section) => section.items.map((item) => item.tipo)));
const EN_LABELS = {
  rendimiento:'Performance', distancia:'Distance', duracion:'Duration', esfuerzo:'Effort', fcmedia:'Average HR', elevacion:'Elevation', potencia:'Power',
  zonasfc:'Heart-rate zones', zonasritmo:'Pace zones', zonaspot:'Power zones', curvaritmo:'Pace curve', curvavel:'Speed curve (bike)', curvafc:'Heart-rate curve', curvapot:'Power curve', curvacad:'Cadence curve',
  records:'Best marks', sueno:'Sleep', score:'Sleep score', fcmax:'Maximum HR', fcreposo:'Resting HR', vo2:'VO2 max', ftp:'FTP', lthr:'LTHR', ritmoumbral:'Threshold pace', calorias:'Calories', vfc:'HRV', spo2:'SpO2', pasos:'Steps',
};
const EN_SECTIONS = { Entrenamiento:'Training', Zonas:'Zones', Curvas:'Curves', Récords:'Records', 'Métricas corporales':'Body metrics' };
const labelOf = (tipo) => { for (const s of CATALOG) { const it = s.items.find(i => i.tipo === tipo); if (it) return getSettingsSnapshot().language === 'en' ? (EN_LABELS[tipo] || it.label) : it.label; } return tipo; };
const text = (es, en) => getSettingsSnapshot().language === 'en' ? en : es;
const fmtTimeSec = (s) => { if (!s || s <= 0) return '0m'; const mins = Math.floor(s / 60); const sec = Math.round(s % 60); if (mins < 60) return `${mins}m ${sec}s`; return `${Math.floor(mins / 60)}h ${mins % 60}m`; };

// Acento de color e icono de cada tipo de gráfica (la tarjeta entera respira
// el color de su métrica, como el "espectro de intensidad" de Zonas).
const ACCENT = {
  rendimiento:'#2DD4A8', distancia:'#4FC3F7', duracion:'#9A7BEB', esfuerzo:'#F5A623', fcmedia:'#E05252', elevacion:'#4FC3F7', potencia:'#F5A623',
  zonasfc:'#E05252', zonasritmo:'#4A90E2', zonaspot:'#F5A623',
  curvaritmo:'#4A90E2', curvavel:'#4FC3F7', curvafc:'#E05252', curvapot:'#F5A623', curvacad:'#9A7BEB',
  records:'#FFD166', sueno:'#9A7BEB', score:'#9A7BEB', fcmax:'#E05252', fcreposo:'#4FC3F7', vo2:'#2DD4A8', ftp:'#F5A623', lthr:'#E05252', ritmoumbral:'#4A90E2', calorias:'#FF9E80', vfc:'#9A7BEB', spo2:'#2DD4A8', pasos:'#4FC3F7',
};
const ICON = {
  rendimiento:'trending-up', distancia:'map-outline', duracion:'time-outline', esfuerzo:'flame-outline', fcmedia:'heart-outline', elevacion:'trending-up-outline', potencia:'flash-outline',
  zonasfc:'pulse-outline', zonasritmo:'speedometer-outline', zonaspot:'flash-outline',
  curvaritmo:'speedometer-outline', curvavel:'bicycle-outline', curvafc:'heart-outline', curvapot:'flash', curvacad:'sync-outline',
  records:'trophy-outline', sueno:'moon-outline', score:'star-outline', fcmax:'heart', fcreposo:'heart-half-outline', vo2:'fitness-outline', ftp:'flash', lthr:'pulse', ritmoumbral:'speedometer', calorias:'flame', vfc:'analytics-outline', spo2:'water-outline', pasos:'footsteps-outline',
};
const ACT_SEL_ICONS = { General: 'globe-outline', Running: 'walk-outline', Ciclismo: 'bicycle-outline', 'Natación': 'water-outline' };

/* ════════════════════════════════════════════════════════════════════════════
   COMPONENTES VISUALES
   ════════════════════════════════════════════════════════════════════════════ */

// Entrada escalonada: fundido + deslizamiento suave
function FadeIn({ delay = 0, children, style }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 380, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [v, delay]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

// Pulsable con efecto "muelle" (el cuerpo de cada tarjeta)
function Press({ onPress, onLongPress, disabled, style, children }) {
  const sc = useRef(new Animated.Value(1)).current;
  const to = (value) => Animated.spring(sc, { toValue: value, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled} onPressIn={() => to(0.985)} onPressOut={() => to(1)}>
      <Animated.View style={[style, { transform: [{ scale: sc }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

// Hoja inferior: entra deslizándose desde abajo con rebote (para los menús)
function Sheet({ children }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(v, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 7 }).start();
  }, [v]);
  return (
    <Animated.View style={{ transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, 460] }) }] }}>
      {children}
    </Animated.View>
  );
}

/* BarChart: barras con eje Y a la izquierda y etiquetas del eje X ROTADAS
   -45º para que quepan muchos más nombres (días/semanas/meses/ventanas).
   stepLbl ahora es mucho más denso que antes (que enseñaba 1 de cada ~6). */
function BarChart({ labels, values, values2, height = 180, fmt, theme, color = BLUE }) {
  const max = Math.max(...values.map(v => v || 0), ...values2.map(v => v || 0), 0.001);
  const stepLbl = Math.max(1, labels.length <= 14 ? 1 : labels.length <= 30 ? 2 : Math.ceil(labels.length / 12));
  const ticks = [max, (max * 2) / 3, max / 3, 0];
  const fmtTick = (t) => (max >= 100 ? String(Math.round(t)) : String(Math.round(t * 10) / 10));
  return (
    <View>
      <View style={{ flexDirection: 'row' }}>
        <View style={[st.yAxis, { height }]}>
          {ticks.map((t, i) => ( <Text key={i} style={[st.yLabel, { color: theme?.muted }]}>{fmtTick(t)}</Text> ))}
        </View>
        <View style={[{ height, flex: 1 }, st.chartArea]}>
          {ticks.map((v, i) => ( <View key={i} style={[st.gridLine, { top: (i / Math.max(ticks.length - 1, 1)) * height }]} /> ))}
          <View style={st.barsRow}>
            {labels.map((_, i) => (
              <View key={i} style={st.barCol}>
                {(values2[i] || 0) > 0 && <View style={[st.bar, { height: ((values2[i] || 0) / max) * height, backgroundColor: theme?.background === '#F4F7FB' ? '#9AA7B8' : WHITE, opacity: theme?.background === '#F4F7FB' ? 0.78 : 0.5 }]} />}
                {(values[i] || 0) > 0 && <View style={[st.bar, { height: ((values[i] || 0) / max) * height, backgroundColor: color }]} />}
              </View>
            ))}
          </View>
        </View>
      </View>
      {/* Etiquetas del eje X rotadas -45º: cada nombre entero, sin "…" */}
      <View style={[st.labelsRow, { marginLeft: 40 }]}>
        {labels.map((l, i) => (
          <View key={i} style={st.labelCell}>
            {i % stepLbl === 0 && (
              <Text style={[st.labelX, { color: theme?.muted }]} numberOfLines={1}>{l}</Text>
            )}
          </View>
        ))}
      </View>
      {fmt && <Text style={st.fmtHint}>{fmt}</Text>}
    </View>
  );
}
function compactZoneLabel(label, prefix, index) {
  const text = String(label || '').trim();
  const match = text.match(/^([ZR]\d+(?:[A-Z])?(?:\+)?)/i);
  return match ? match[1].toUpperCase() : (text || `${prefix}${index + 1}`);
}

function ZoneRows({ zones, prefix = 'Z', theme, color = GREEN }) {
  const total = zones.reduce((a, z) => a + z.sec, 0);
  if (total <= 0) return <View style={st.noData}><Text style={st.noDataText}>{text('Sin datos de zonas en este período (requiere entrenos completados con registros).', 'No zone data for this period (completed workouts with records are required).')}</Text></View>;
  return (
    <View style={st.recordsBox}>
      {zones.map((z, i) => {
        const p = Math.round((z.sec / total) * 100);
        const outside = z.label === 'Fuera';
        const label = outside ? 'Fuera' : compactZoneLabel(z.label, prefix, i);
        return (
          <View key={i} style={st.recordRow}>
            <Text style={[st.zoneName, { color: theme?.text }]}>{label}</Text>
            <View style={[st.zoneBarBg, { backgroundColor: theme?.input }]}><View style={[st.zoneBar, outside && st.zoneBarOutside, { width: `${Math.min(p, 100)}%`, backgroundColor: outside ? undefined : color }]} /></View>
            <Text style={[st.recordValue, { color: theme?.text }]}>{fmtTimeSec(z.sec)}</Text>
            <Text style={[st.zonePct, { color: theme?.muted }]}>{p}%</Text>
          </View>
        );
      })}
    </View>
  );
}
export default function AnalysisScreen() {
  const insets = useSafeAreaInsets();
  const appSettings = useAppSettings();
  const theme = getThemeColors(appSettings.themeMode, useColorScheme());
  const uid = auth.currentUser?.uid;
  const [charts, setCharts] = useState([]);
  const [days, setDays] = useState(null);
  const [daysError, setDaysError] = useState(false);
  const [profile, setProfile] = useState(null);
  // Actividad cuyas zonas de RITMO se usan en las gráficas (General = las
  // genéricas). Si el perfil no tiene genéricas pero sí de Running, se arranca
  // en Running para que la distribución no salga vacía.
  const [zonaAct, setZonaAct] = useState('General');
  const zonaActTocada = useRef(false);
  const [streams, setStreams] = useState({});
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [moveId, setMoveId] = useState(null);
  const hydrated = useRef(false);
  const lastSavedJson = useRef(null);
  const saveWarned = useRef(false);
  const forceStreamsRef = useRef(false);

  const loadAll = useCallback(async (force = false) => {
    if (!uid) return;
    setLoading(true); setDaysError(false);
    // Bloque C 4.4: procesa los digests pendientes (ediciones/imports) al
    // entrar a Análisis, SIN bloquear el render (fuego y olvido). Nunca lanza.
    procesarPendientes(uid, { max: 40 }).catch(() => {});
    if (force) {
      invalidateAnalytics(uid);
      bumpRefresh(); // tumba también la caché de entrenos: si no, al volver a
                     // la pestaña sus días viejos se mezclan encima de los nuevos
      forceStreamsRef.current = true;
      setStreams({}); // refresca también zonas/curvas
    }
    try {
      let loaded = null;
      try {
        const snap = await getDoc(doc(db, 'analysis', uid));
        if (snap.exists() && Array.isArray(snap.data().charts)) loaded = snap.data().charts;
      } catch (_e) {}
      if (!loaded) {
        const raw = await AsyncStorage.getItem(`analysisCharts_${uid}`);
        if (raw) loaded = JSON.parse(raw);
      }
      const arr = (Array.isArray(loaded) ? loaded : [])
        .filter((chart) => AVAILABLE_TYPES.has(chart.tipo));
      setCharts(arr);
      lastSavedJson.current = JSON.stringify(arr);
      hydrated.current = true;
      const cachedProfile = await getCachedProfile(uid);
      let p = cachedProfile;
      if (force || !cachedProfile) {
        try {
          const profileSnap = await getDoc(doc(db, 'perfiles', uid));
          if (profileSnap.exists()) p = { ...(cachedProfile || {}), ...profileSnap.data() };
        } catch (_e) {
          // Si no hay red, se conserva el perfil cacheado como respaldo.
        }
      }
      setProfile(p);
      // Smart-default de la actividad de zonas de ritmo: si las genéricas
      // están vacías pero Running tiene las suyas, arrancamos en Running.
      // Solo la primera vez: si el usuario ya eligió una actividad a mano,
      // se respeta su elección al refrescar.
      if (p && !zonaActTocada.current && !(Array.isArray(p.zonasRitmo) && p.zonasRitmo.length)) {
        const run = p.zonasActividad?.Running?.ritmo;
        if (Array.isArray(run) && run.length) setZonaAct('Running');
      }
      const fetchedDays = await getAnalyticsDays(uid, { force });
      const sharedWorkouts = force ? null : getEntrenamientos(uid);
      const sharedDays = buildDaysFromWorkouts(sharedWorkouts);
      // Los datos recién consultados mandan sobre los derivados de la caché
      // de entrenos (que puede estar atrasada hasta el siguiente sync).
      const d = Object.keys(sharedDays).length > 0
        ? { ...sharedDays, ...fetchedDays }
        : fetchedDays;
      console.log('[analysis] datos:', {
        uid,
        sharedWorkouts: sharedWorkouts?.length || 0,
        fetchedDays: Object.keys(fetchedDays || {}).length,
        finalDays: Object.keys(d || {}).length,
      });
      setDays(d);

      // SINCRONIZACIÓN INCREMENTAL (patrón chat): en segundo plano trae solo
      // los entrenamientos nuevos desde la última sync y refresca las gráficas
      // si llegó algo. Sin el botón de refrescar ni re-leer el historial.
      if (!force) {
        syncAnalyticsDays(uid, fetchedDays).then((res) => {
          // A4: ahora devuelve { n, streamsChanged } (antes un número n).
          const n = res?.n ?? res;
          if (!n) return;
          // Zonas/curvas: SOLO reflotan si la firma de entrenos cambió
          // (streamsChanged); si no, basta con refrescar los días.
          if (res?.streamsChanged) {
            // A4 (revisado): se tira la caché de zonas/curvas (memoria +
            // AsyncStorage) y se recalcula SIN `force`. Con el camino digest
            // eso son ~24 documentos mensuales; `force` lanzaba un backfill
            // COMPLETO (pagina todos los resúmenes y relee los registros que
            // falten) en cada sincronización con cambios, que era justo lo
            // que se quería evitar. `force` queda solo para el botón manual.
            invalidateStreamsCache(uid);
            setStreams({});
          }
          const shared2 = buildDaysFromWorkouts(getEntrenamientos(uid));
          const d2 = Object.keys(shared2).length > 0 ? { ...shared2, ...fetchedDays } : { ...fetchedDays };
          setDays(d2);
        }).catch(() => {});
      }
      if (!d || Object.keys(d).length === 0) setDaysError(true);
    } catch (e) {
      console.warn('[analysis] loadAll falló:', e.message);
      setDaysError(true);
      hydrated.current = true;
      lastSavedJson.current = null;
    } finally { setLoading(false); }
  }, [uid]);
  useFocusEffect(useCallback(() => { loadAll(false); }, [loadAll]));

  useEffect(() => {
    if (!uid || !hydrated.current) return;
    const json = JSON.stringify(charts);
    if (json === lastSavedJson.current) return;
    lastSavedJson.current = json;
    AsyncStorage.setItem(`analysisCharts_${uid}`, json).catch(() => {});
    setDoc(doc(db, 'analysis', uid), { charts }, { merge: true }).catch(e => {
      console.warn('[analysis] no se pudo guardar en Firestore:', e.message);
      if (!saveWarned.current) {
        saveWarned.current = true;
        Alert.alert('Guardado en la nube no disponible', 'Tus gráficas se guardan solo en este dispositivo: ' + e.message + '\n\nRevisa en Firebase las reglas de Firestore (colección "analysis") y tu conexión.');
      }
    });
  }, [charts, uid]);

  // Perfil con las zonas de RITMO resueltas según la actividad elegida
  // (General = genéricas; Running/Ciclismo/Natación = sus específicas si hay).
  const profileZonas = useMemo(() => (profile
    ? { ...profile, zonasRitmo: zonasDeActividad(profile, 'Ritmo', zonaAct === 'General' ? null : zonaAct) }
    : null), [profile, zonaAct]);

  useEffect(() => {
    if (!uid || loading || !profileZonas || !days) return;
    const forceStreams = forceStreamsRef.current;
    forceStreamsRef.current = false;
    const needed = [...new Set(charts.filter(c => STREAM_TYPES.includes(c.tipo)).map(c => c.period))];
    needed.forEach(period => {
      if (streams[period] !== undefined) return;
      setStreams(s => ({ ...s, [period]: null }));
      getStreamsStats(uid, period, profileZonas, { force: forceStreams, zonaAct })
        .then(val => setStreams(s => ({ ...s, [period]: val })))
        .catch(() => setStreams(s => ({ ...s, [period]: { zoneFc: [], zoneRt: [], zoneFcDays: {}, zoneRtDays: {}, curveRitmo: [null,null,null,null,null,null,null,null,null], curveVel: [null,null,null,null,null,null,null,null,null], curveFc: [null,null,null,null,null,null,null,null,null], curvePot: [null,null,null,null,null,null,null,null,null], curveCad: [null,null,null,null,null,null,null,null,null], hasAny: false, ok: false } })));
    });
  }, [charts, uid, profileZonas, days, streams, zonaAct]);

  const saveConfig = () => {
    if (!config) return;
    if (config.id) setCharts(cs => cs.map(c => (c.id === config.id ? { ...c, group: config.group, period: config.period } : c)));
    else setCharts(cs => [...cs, { id: Date.now(), tipo: config.tipo, group: config.group, period: config.period }]);
    setConfig(null);
  };
  const deleteChart = (id) => setCharts(cs => cs.filter(c => c.id !== id));
  const moveChart = (targetId) => {
    setCharts(cs => {
      const from = cs.findIndex(c => c.id === moveId);
      const target = cs.findIndex(c => c.id === targetId);
      if (from < 0 || target < 0 || from === target) return cs;
      const [item] = cs.splice(from, 1);
      // Si el destino estaba debajo, se inserta después de él; si estaba
      // encima, se inserta antes. Así ambos sentidos cambian de posición.
      const insertAt = target;
      cs.splice(insertAt, 0, item);
      return [...cs];
    });
    setMoveId(null);
  };
  const moveEnd = () => {
    setCharts(cs => {
      const from = cs.findIndex(c => c.id === moveId);
      if (from < 0) return cs;
      const [item] = cs.splice(from, 1);
      return [...cs, item];
    });
    setMoveId(null);
  };

  const renderBody = (c) => {
    if (c.tipo === 'records') {
      return (
        <View style={st.recordsBox}>
          {(days ? buildRecords(days) : []).map((r, i) => (
            <View key={i} style={st.recordRow}>
              <Ionicons name={r.icon} size={16} color={ACCENT.records} />
              <Text style={[st.recordLabel, { color: theme.muted }]}>{r.label}</Text>
              <Text style={[st.recordValue, { color: theme.text }]}>{r.value}</Text>
            </View>
          ))}
        </View>
      );
    }
    if (STREAM_TYPES.includes(c.tipo)) {
      const s = streams[c.period];
      if (s === undefined || s === null) return <View style={st.noData}><ActivityIndicator color={ACCENT[c.tipo] || BLUE} /><Text style={st.noDataText}>Cargando registros…</Text></View>;
      if (s.ok === false) return <View style={st.noData}><Text style={st.noDataText}>{text('Error al cargar registros. Vuelve a entrar o refresca.', 'Error loading records. Re-enter or refresh.')}</Text></View>;
      if (c.tipo === 'zonasfc') return <ZoneRows zones={s.zoneFc} prefix="Z" theme={theme} color={ACCENT.zonasfc} />;
      if (c.tipo === 'zonasritmo') return (
        <View>
          {/* Selector de actividad: de qué zonas de ritmo sale la distribución */}
          <View style={st.actSelector}>
            {['General', 'Running', 'Ciclismo', 'Natación'].map((act) => (
              <TouchableOpacity key={act} onPress={() => { zonaActTocada.current = true; setZonaAct(act); setStreams({}); }}
                style={[st.actChip, { borderColor: zonaAct === act ? ACCENT.zonasritmo : theme.border, backgroundColor: zonaAct === act ? ACCENT.zonasritmo + '26' : 'transparent' }]}>
                <Ionicons name={ACT_SEL_ICONS[act] || 'ellipse-outline'} size={12} color={zonaAct === act ? ACCENT.zonasritmo : theme.muted} />
                <Text style={{ color: zonaAct === act ? theme.text : theme.muted, fontSize: 11, fontWeight: zonaAct === act ? '800' : '600' }}>{act === 'General' ? text('General', 'General') : act}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <ZoneRows zones={s.zoneRt} prefix="R" theme={theme} color={ACCENT.zonasritmo} />
        </View>
      );
      if (c.tipo === 'zonaspot') return <View style={st.noData}><Text style={st.noDataText}>Sin datos de potencia en tus registros.</Text></View>;
      const vals = (c.tipo === 'curvaritmo' ? s.curveRitmo : c.tipo === 'curvavel' ? s.curveVel : c.tipo === 'curvafc' ? s.curveFc : c.tipo === 'curvapot' ? s.curvePot : s.curveCad) || [];
      const clean = vals.map(v => (v == null ? 0 : v));
      if (!clean.some(v => v > 0)) return <View style={st.noData}><Text style={st.noDataText}>{text('Sin registros con esos datos en el período elegido.', 'No records with these data in the selected period.')}</Text></View>;
      return <BarChart labels={STREAM_LABELS} values={clean} values2={[]} theme={theme} color={ACCENT[c.tipo] || BLUE} fmt={c.tipo === 'curvaritmo' ? text('Seg/km por ventana (menor = mejor)', 'Sec/km per window (lower = better)') : c.tipo === 'curvavel' ? text('Km/h por ventana (mayor = mejor)', 'Km/h per window (higher = better)') : undefined} />;
    }
    if (!days) {
      return (
        <View style={st.noData}>
          <Text style={st.noDataText}>{daysError ? text('Error cargando el historial.', 'Error loading history.') : text('Cargando…', 'Loading…')}</Text>
          {daysError && <TouchableOpacity style={st.retryBtn} onPress={() => loadAll(true)}><Text style={st.retryText}>{text('Reintentar', 'Retry')}</Text></TouchableOpacity>}
        </View>
      );
    }
    const series = buildSeries(days, c.tipo, c.group, c.period, profile);
    if (!series.hasData) return <View style={st.noData}><Text style={st.noDataText}>{text('Sin datos disponibles todavía para esta gráfica.', 'No data available for this chart yet.')}</Text></View>;
    return <BarChart labels={series.labels} values={series.values} values2={series.values2} theme={theme} color={ACCENT[c.tipo] || BLUE} />;
  };
  const preview = config ? { tipo: config.tipo, group: config.group, period: config.period } : null;

  return (
    <View style={[st.container, { backgroundColor: theme.background }]}>
      <View style={[st.header, { borderBottomColor: theme.border, paddingTop: insets.top + 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[st.headerTitle, { color: theme.text }]}>{text('Análisis', 'Analysis')}</Text>
          <Text style={[st.headerSub, { color: theme.muted }]}>{text('Tu evolución, métrica a métrica', 'Your evolution, metric by metric')}</Text>
        </View>
        <TouchableOpacity style={[st.circleBtn, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={() => loadAll(true)} hitSlop={8}>
          <Ionicons name="refresh" size={19} color="#8FA8C8" />
        </TouchableOpacity>
        <TouchableOpacity style={[st.circleBtn, { backgroundColor: BLUE, borderColor: BLUE }]} onPress={() => setPickerOpen(true)} hitSlop={8}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
      {moveId != null && (
        <View style={st.moveBanner}>
          <Ionicons name="move-outline" size={16} color="#fff" />
          <Text style={st.moveBannerText} numberOfLines={1}>{text('Moviendo gráfica: toca otra para colocarla ahí o "Mover al final"', 'Moving chart: tap another to place it there, or "Move to end"')}</Text>
          <TouchableOpacity onPress={() => setMoveId(null)}><Text style={st.moveCancel}>{text('Cancelar', 'Cancel')}</Text></TouchableOpacity>
        </View>
      )}
      {loading ? (
        <View style={st.center}>
          <View style={st.loaderCircle}><ActivityIndicator color={BLUE} /></View>
          <Text style={[st.centerText, { color: theme.muted }]}>{text('Cargando historial…', 'Loading history…')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={st.scroll}>
          {charts.length === 0 && moveId == null && (
            <FadeIn>
              <View style={[st.empty, { borderColor: theme.border }]}>
                <View style={st.emptyCircle}>
                  <Ionicons name="bar-chart-outline" size={30} color={BLUE} />
                </View>
                <Text style={[st.emptyText, { color: theme.muted }]}>{text('Aún no tienes gráficas. Pulsa + para añadir la primera.', 'You have no charts yet. Tap + to add the first one.')}</Text>
              </View>
            </FadeIn>
          )}
          {charts.map((c, idx) => {
            const accent = ACCENT[c.tipo] || BLUE;
            const icono = ICON[c.tipo] || 'stats-chart-outline';
            return (
              <FadeIn key={c.id} delay={Math.min(idx * 55, 420)}>
                <View style={[st.card, { backgroundColor: theme.card, borderColor: moveId === c.id ? accent : theme.border }, moveId === c.id && st.cardMoving]}>
                  <View style={st.cardHeader}>
                    <View style={[st.cardIcon, { backgroundColor: accent + '22', borderColor: accent + '55' }]}>
                      <Ionicons name={icono} size={15} color={accent} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[st.cardTitle, { color: theme.text }]}>{labelOf(c.tipo)}</Text>
                      {c.tipo !== 'records' && (
                        <Text style={[st.cardSub, { color: theme.muted }]}>
                          {text(GROUP_REV[c.group] || 'Semanal', GROUP_REV_EN[c.group] || 'Weekly')} · {text(PERIOD_REV[c.period] || '—', PERIOD_REV_EN[c.period] || '—')}
                        </Text>
                      )}
                    </View>
                    {moveId == null && (
                      <TouchableOpacity onPress={() => deleteChart(c.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={st.cardDel}>
                        <Ionicons name="close" size={17} color="#8FA8C8" />
                      </TouchableOpacity>
                    )}
                  </View>
                  <Press
                    onLongPress={() => { Vibration.vibrate(10); setMoveId(c.id); }}
                    onPress={() => { if (moveId != null) { if (moveId !== c.id) moveChart(c.id); } else if (c.tipo !== 'records') setConfig({ id: c.id, tipo: c.tipo, group: c.group, period: c.period }); }}
                    style={st.cardBody}
                  >
                    {renderBody(c)}
                  </Press>
                  {moveId === c.id && (
                    <View style={[st.moveHint, { borderTopColor: theme.border }]}>
                      <Ionicons name="swap-vertical" size={13} color={accent} />
                      <Text style={[st.moveHintText, { color: theme.muted }]}>{text('Mantén pulsada otra gráfica para intercambiar', 'Long-press another chart to swap')}</Text>
                    </View>
                  )}
                </View>
              </FadeIn>
            );
          })}
          <TouchableOpacity style={[st.bottomAdd, { borderColor: theme.border }]} onPress={() => (moveId != null ? moveEnd() : setPickerOpen(true))}>
            <Ionicons name="add" size={20} color={BLUE} />
            <Text style={st.bottomAddText}>{moveId != null ? text('Mover al final', 'Move to end') : text('Añadir Gráfico', 'Add chart')}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <View style={st.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerOpen(false)} />
          <Sheet>
            <View style={[st.sheetBox, { backgroundColor: theme.card, borderColor: theme.border, paddingBottom: insets.bottom + 14 }]}>
              <View style={[st.sheetHandle, { backgroundColor: theme.border }]} />
              <View style={[st.sheetHeader, { borderBottomColor: theme.border }]}>
                <Text style={[st.sheetTitle, { color: theme.text }]}>{text('Añadir gráfica', 'Add chart')}</Text>
                <TouchableOpacity onPress={() => setPickerOpen(false)} hitSlop={8} style={[st.sheetClose, { backgroundColor: theme.input }]}>
                  <Ionicons name="close" size={18} color={theme.muted} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false} contentContainerStyle={st.sheetScroll}>
                {CATALOG.map(s => (
                  <View key={s.section}>
                    <View style={st.sheetSectionRow}>
                      <View style={st.sheetSectionBar} />
                      <Text style={[st.sheetSectionLabel, { color: theme.muted }]}>{getSettingsSnapshot().language === 'en' ? (EN_SECTIONS[s.section] || s.section) : s.section}</Text>
                    </View>
                    {s.items.map(it => {
                      const added = charts.some(c => c.tipo === it.tipo);
                      const accent = ACCENT[it.tipo] || BLUE;
                      return (
                        <TouchableOpacity key={it.tipo} activeOpacity={0.8} style={[st.pickOpt, { backgroundColor: theme.input, borderColor: added ? GREEN + '77' : theme.border }]}
                          onPress={() => {
                            setPickerOpen(false);
                            // Si ya está añadida, se abre SU configuración
                            // (nada de duplicados accidentales).
                            const existente = charts.find(c => c.tipo === it.tipo);
                            if (existente) setConfig({ id: existente.id, tipo: existente.tipo, group: existente.group, period: existente.period });
                            else setConfig({ id: null, tipo: it.tipo, group: 'semanal', period: '3m' });
                          }}>
                          <View style={[st.pickIcon, { backgroundColor: accent + '1F' }]}><Ionicons name={ICON[it.tipo] || 'stats-chart-outline'} size={15} color={accent} /></View>
                          <Text style={[st.pickText, { color: theme.text }]}>{labelOf(it.tipo)}</Text>
                          {added ? (
                            <>
                              <Text style={[st.pickAdded, { color: GREEN }]}>{text('Añadida', 'Added')}</Text>
                              <Ionicons name="checkmark-circle" size={17} color={GREEN} />
                            </>
                          ) : (
                            <Ionicons name="add-circle-outline" size={19} color={accent} />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </ScrollView>
            </View>
          </Sheet>
        </View>
      </Modal>
      <Modal visible={!!config} transparent animationType="slide" onRequestClose={() => setConfig(null)}>
        <View style={[st.configSheet, { backgroundColor: theme.background, paddingBottom: insets.bottom }]}>
          <View style={[st.configHeader, { borderBottomColor: theme.border }]}>
            <TouchableOpacity onPress={() => setConfig(null)} hitSlop={8}><Ionicons name="close" size={24} color="#8FA8C8" /></TouchableOpacity>
            <Text style={[st.configTitle, { color: theme.text }]}>{config ? labelOf(config.tipo) : ''}</Text>
            <TouchableOpacity onPress={saveConfig}><Text style={st.configSave}>{text('Guardar', 'Save')}</Text></TouchableOpacity>
          </View>
          {config && (
            <ScrollView contentContainerStyle={st.configScroll}>
              <View style={[st.card, { backgroundColor: theme.card, borderColor: theme.border }]}>{renderBody(preview)}</View>
              <View style={[st.configRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <View style={[st.configIcon, { backgroundColor: BLUE + '1F' }]}><Ionicons name="calendar-outline" size={15} color={BLUE} /></View>
                <Text style={[st.configLabel, { color: theme.text }]}>{text('Agrupar por', 'Group by')}</Text>
                <View style={{ flex: 1 }} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.chipRow}>
                  {GROUPS.map(g => (
                    <TouchableOpacity key={g} style={[st.chip, { backgroundColor: theme.input, borderColor: theme.border }, config.group === GROUP_KEY[g] && st.chipActive]} onPress={() => setConfig(c => ({ ...c, group: GROUP_KEY[g] }))}>
                      <Text style={[st.chipText, { color: config.group === GROUP_KEY[g] ? theme.text : theme.muted }, config.group === GROUP_KEY[g] && { fontWeight: '700' }]}>{text(g, { Diario:'Daily', Semanal:'Weekly', Mensual:'Monthly', Año:'Year' }[g])}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
              <View style={[st.configRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <View style={[st.configIcon, { backgroundColor: GREEN + '1F' }]}><Ionicons name="calendar-number-outline" size={15} color={GREEN} /></View>
                <Text style={[st.configLabel, { color: theme.text }]}>{text('Período', 'Period')}</Text>
                <View style={{ flex: 1 }} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.chipRow}>
                  {PERIODS.map(p => (
                    <TouchableOpacity key={p} style={[st.chip, { backgroundColor: theme.input, borderColor: theme.border }, config.period === PERIOD_KEY[p] && st.chipActive]} onPress={() => setConfig(c => ({ ...c, period: PERIOD_KEY[p] }))}>
                      <Text style={[st.chipText, { color: config.period === PERIOD_KEY[p] ? theme.text : theme.muted }, config.period === PERIOD_KEY[p] && { fontWeight: '700' }]}>{text(p, { 'Últimos 30 días':'Last 30 days', 'Últimos 3 meses':'Last 3 months', 'Últimos 6 meses':'Last 6 months', 'Último año':'Last year', 'Últimos 2 años':'Last 2 years', Todo:'All time' }[p])}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </ScrollView>
          )}
        </View>
        <SystemBars />
      </Modal>
    </View>
  );
}
const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: NAVY },

  // Cabecera
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  headerSub: { color: '#8FA8C8', fontSize: 11.5, marginTop: 2, fontWeight: '600' },
  circleBtn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },

  // Banner de movimiento
  moveBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: BLUE, paddingHorizontal: 14, paddingVertical: 9 },
  moveBannerText: { color: '#fff', fontSize: 12, fontWeight: '600', flex: 1 },
  moveCancel: { color: '#fff', fontWeight: '800', fontSize: 12 },

  // Carga / vacío
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loaderCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: BLUE + '1A', alignItems: 'center', justifyContent: 'center' },
  centerText: { color: '#8FA8C8', fontSize: 13 },
  scroll: { padding: 16, paddingBottom: 40 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 24, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed', borderColor: BORDER },
  emptyCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: BLUE + '1A', alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#8FA8C8', fontSize: 13.5, textAlign: 'center', lineHeight: 20 },

  // Tarjeta de gráfica
  card: { backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 14, marginBottom: 14 },
  cardMoving: { borderWidth: 1.5 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  cardIcon: { width: 32, height: 32, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  cardSub: { color: '#8FA8C8', fontSize: 11, marginTop: 2, fontWeight: '600' },
  cardDel: { padding: 2 },
  cardBody: { paddingHorizontal: 2 },
  moveHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: BORDER },

  // Gráfica de barras
  yAxis: { justifyContent: 'space-between', alignItems: 'flex-end', width: 36, marginRight: 4, paddingVertical: 0 },
  yLabel: { color: '#5A708C', fontSize: 9 },
  chartArea: { flex: 1, position: 'relative' },
  gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(143,168,200,0.12)' },
  barsRow: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row' },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  bar: { width: '60%', borderRadius: 3, position: 'absolute', bottom: 0 },
  // Eje X: etiquetas rotadas -45º (caben todos los nombres)
  labelsRow: { flexDirection: 'row', marginTop: 10, height: 46, alignItems: 'flex-start' },
  labelCell: { flex: 1, height: 46, alignItems: 'center', overflow: 'visible' },
  labelX: { color: '#5A708C', fontSize: 8.5, position: 'absolute', top: 0, left: 0, right: 0, textAlign: 'center', transform: [{ rotate: '-45deg' }] },
  fmtHint: { color: '#5A708C', fontSize: 10, marginTop: 4 },

  // Zonas / records / sin datos
  noData: { paddingVertical: 30, alignItems: 'center', gap: 8 },
  noDataText: { color: '#4A6080', fontSize: 13, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: BLUE },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  recordsBox: { gap: 10 },
  recordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordLabel: { color: '#8FA8C8', fontSize: 13, flex: 1 },
  recordValue: { color: '#fff', fontSize: 14, fontWeight: '700' },
  zoneName: { color: '#fff', fontSize: 12, fontWeight: '700', width: 34 },
  zoneBarBg: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#0A1220', overflow: 'hidden' },
  zoneBar: { height: 8, borderRadius: 4, backgroundColor: GREEN },
  zoneBarOutside: { backgroundColor: '#E05252' },
  zonePct: { color: '#8FA8C8', fontSize: 11, width: 34, textAlign: 'right' },

  // Selector de actividad (zonas de ritmo)
  actSelector: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  actChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1.5 },

  // Pie de lista
  bottomAdd: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 14, borderWidth: 1.5, borderColor: BORDER, borderStyle: 'dashed', borderRadius: 14 },
  bottomAddText: { color: BLUE, fontWeight: '800', fontSize: 14 },

  // Hoja inferior "Añadir gráfica"
  sheetOverlay: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'flex-end' },
  sheetBox: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, overflow: 'hidden' },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: 10, marginBottom: 4 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1 },
  sheetTitle: { fontSize: 16, fontWeight: '800' },
  sheetClose: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  sheetScroll: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8 },
  sheetSectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 6, paddingHorizontal: 4 },
  sheetSectionBar: { width: 4, height: 14, borderRadius: 2, backgroundColor: BLUE },
  sheetSectionLabel: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  pickOpt: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 14, borderWidth: 1.5, marginBottom: 6 },
  pickIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  pickText: { fontSize: 14, fontWeight: '700', flex: 1 },
  pickAdded: { fontSize: 11, fontWeight: '800' },

  // Modal configurar
  configSheet: { flex: 1, backgroundColor: NAVY, marginTop: 40, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  configHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: BORDER },
  configTitle: { color: '#fff', fontSize: 16, fontWeight: '800', flex: 1, textAlign: 'center' },
  configSave: { color: BLUE, fontWeight: '800', fontSize: 15 },
  configScroll: { padding: 16, gap: 12 },
  configRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: BORDER, padding: 12 },
  configIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  configLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexGrow: 0 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1.5, borderColor: BORDER, marginLeft: 6, backgroundColor: NAVY },
  chipActive: { borderColor: BLUE, backgroundColor: BLUE + '22' },
  chipText: { color: '#8FA8C8', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '800' },
});
