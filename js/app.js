import { TessieClient, ApiError } from './tessie.js?v=23';
import { Simulator } from './simulator.js?v=23';
import { estimate, pickTemp, formatDuration } from './estimator.js?v=23';
import { settings as settingsStore, history, observations, appendSample } from './store.js?v=23';
import { createCharts } from './charts.js?v=23';
import { Gauges } from './gauges.js?v=23';
import { summarize, formatReport, statesToSamples, mergeSamples, shape, findRecords } from './history.js?v=23';
import { DRIVE_FIELDS, configuredFields, withStatorField, driveFieldsStatus, findDriveValues, streamProbe, configFlags, LiveStream, attachMotor, applyPatch } from './telemetry.js?v=23';
import { SessionsView, demoHistory } from './sessionsView.js?v=23';
import { LayoutManager, BLOCKS } from './layout.js?v=23';
import { detectHeatingEnd } from './events.js?v=23';
import { cleanSample, FieldClock, heatingZones, isActive, streamSilent, heatingPowerKw, isNight, autoWindowStart } from './quality.js?v=23';

// Version de l'app. Le même numéro est ajouté à l'adresse de chaque fichier (?v=…)
// pour forcer les navigateurs (Chrome iPhone, auto) à charger la nouvelle version.
// À augmenter à chaque mise en ligne ; test/version.test.mjs vérifie la cohérence.
export const APP_VERSION = '23';

const DEFAULTS = {
  vin: '',
  baseUrl: 'https://api.tessie.com',
  interval: 30,        // s
  target: 50,          // °C — LFP, à calibrer avec les coupures observées
  metric: 'min',
  windowMin: 5,
  rememberToken: false,
  rangeMin: 60,
  ranges: {},          // fenêtre de temps par disposition : minutes ou 'auto' (défaut : Auto en Tableau de bord)
  telInterval: 30,     // s, cadence demandée pour les champs du moteur (télémétrie de l'auto)
  telFields: false,    // champs du moteur ajoutés par ce dashboard : on vérifie qu'ils restent
  demo: false,
  view: 'live',        // 'live' | 'sessions'
  theme: 'system',     // 'system' | 'sun' (selon le soleil) | 'dark' | 'light'
};
const DEMO_INTERVAL_S = 5;
const STALE_MS = 5 * 60000;
const MAX_BACKOFF_MS = 5 * 60000;
const FIELD_STALE_MS = 3 * 60000;   // jauge atténuée au-delà
const FAST_POLL_S = 15;             // sondage quand le flux en direct est coupé
const WATCHDOG_MS = 30000;
// Au plus un rendu par seconde : avec le Profiler, le flux peut envoyer plusieurs messages
// par seconde, et tout redessiner à chacun saturait le navigateur de l'auto (page figée).
const RENDER_MIN_MS = 1000;

const $ = (id) => document.getElementById(id);
const dig = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const clock = (t) => new Date(t).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });

const state = {
  s: settingsStore.load(DEFAULTS),
  samples: [],
  obs: [],
  est: null,
  sim: null,
  timer: null,
  errors: 0,
  gen: 0,             // incrémenté à chaque changement de mode → ignore les réponses périmées
  inFlight: null,
  lastOkAt: null,
  motor: null,        // dernières températures du moteur arrière (flux en direct)
  stream: null,
  streamState: 'off', // 'off' | 'connecting' | 'open' | 'closed'
  streamRestarts: 0,  // reconnexions forcées (flux muet)
  watchdog: null,
  live: {},           // dernières valeurs reçues du flux : { champ: { v, t } } (source prioritaire)
  fields: new FieldClock(), // âge de chaque valeur
  rejected: 0,        // valeurs écartées (hors plage, saut impossible)
  rejectStreak: {},   // écarts consécutifs par champ
  pos: null,          // { lat, lon } pour le thème selon le soleil (jamais enregistré)
  wakeLock: null,
  wakePending: false,
};

let charts;
let sessions;
let layout;

// ───────────────────────── Démarrage ─────────────────────────

const IS_CAR = document.documentElement.classList.contains('car');

function init() {
  window.__appStarted = true;
  importSetupFromHash();
  charts = createCharts({ tempEl: $('chartTemp'), motorEl: $('chartMotor') });
  buildGauges();
  // Après buildGauges : les jauges doivent exister pour être placées.
  layout = new LayoutManager({ root: $('layout'), colA: $('colA'), colB: $('colB'), pool: $('blockPool'), onChange: syncLayoutUi });
  layout.apply();
  sessions = new SessionsView({
    fetchStates: (q) => {
      if (!state.s.token || !state.s.vin) return Promise.reject(new Error('token ou VIN manquant (Réglages)'));
      return new TessieClient({ token: state.s.token, baseUrl: state.s.baseUrl || DEFAULTS.baseUrl, timeoutMs: 45000 }).states(state.s.vin, q);
    },
    demoSamples: () => (state.sim ? (state.demoHist || (state.demoHist = demoHistory())) : null),
    getTarget: () => +state.s.target,
    onUseTarget: (t) => { state.s.target = t; settingsStore.save(state.s); render(true); },
  });
  bindUi();
  syncRangeButtons();
  if (state.s.demo) startDemo();
  else startLive();
  applyView();
}

function client() {
  return new TessieClient({ token: state.s.token, baseUrl: state.s.baseUrl || DEFAULTS.baseUrl });
}

function startLive() {
  stop();
  state.sim = null;
  $('btnDemo').setAttribute('aria-pressed', 'false');
  if (!state.s.token || !state.s.vin) {
    state.samples = [];
    setStatus('idle', 'Non configuré');
    banner('info', 'Entre ton token Tessie et ton VIN dans <b>Réglages</b>, ou clique sur <b>Démo</b> pour voir le dashboard avec des données simulées.');
    render(true);
    return;
  }
  state.samples = history.load(state.s.vin);
  state.obs = observations.load(state.s.vin);
  state.fields.reset();
  state.rejected = 0;
  state.rejectStreak = {};
  banner(null);
  render(true);
  poll();
  backfill();
  startStream();
  state.telTimer = setTimeout(watchTelemetryFields, 20000);
  if (state.s.view === 'sessions') sessions.show(`live:${state.s.vin}`);
}

function startDemo() {
  stop();
  state.sim = new Simulator();
  state.samples = state.sim.history();
  state.obs = [];
  state.fields.reset();
  $('btnDemo').setAttribute('aria-pressed', 'true');
  banner('info', 'Mode démo : préconditionnement simulé d’un pack LFP par −5 °C. Aucune donnée réelle.');
  render(true);
  poll();
  if (state.s.view === 'sessions') sessions.show('demo');
}

function stop() {
  clearTimeout(state.timer);
  clearTimeout(state.telTimer);
  state.timer = null;
  state.gen++;
  if (state.stream) { state.stream.stop(); state.stream = null; }
  clearInterval(state.watchdog);
  state.watchdog = null;
  state.streamState = 'off';
}

/**
 * Flux en direct de Tessie : apporte les températures du moteur arrière quand le
 * Profiler de Tessie est activé (elles ne sont ni dans /state ni dans l'historique).
 */
function startStream() {
  state.motor = null;
  state.live = {};
  state.streamState = 'connecting';
  state.streamRestarts = 0;
  let lastSave = 0;
  state.stream = new LiveStream({
    vin: state.s.vin,
    token: state.s.token,
    // Flux en direct : batterie (cellules, tension, courant, SOC…) et moteur arrière.
    // Seuls les champs qui changent arrivent ; les autres sont repris de la mesure précédente.
    onPatch: (raw) => {
      const p = cleanPatch(raw);
      if (!p) return;
      state.fields.note(p.patch, p.t);
      const motor = {};
      for (const k of ['statorTemp', 'heatsinkTemp']) if (p.patch[k] != null) motor[k] = p.patch[k];
      if (Object.keys(motor).length) state.motor = Object.assign({}, state.motor || {}, motor, { t: p.t });
      const prev = state.samples[state.samples.length - 1];
      const { sample, added } = applyPatch(state.samples, p);
      if (added) {
        recordHeatingEnd(prev, sample);
        // Sauvegarde locale au plus une fois par minute (le flux peut être rapide).
        if (Date.now() - lastSave > 60000) { history.save(state.s.vin, state.samples); lastSave = Date.now(); }
      }
      state.streamAt = Date.now();
      render();
    },
    onErrors: (errs) => {
      // Ex. « unsupported_field (DiStatorTempR) » : l'auto ne prend pas ce champ en charge.
      // Seulement les champs utilisés ici (pas l'unité avant d'une propulsion, par exemple).
      const used = errs.filter((e) => USED_STREAM_FIELDS.some((f) => e.indexOf(`(${f})`) >= 0));
      if (used.length) banner('error', `Flux Tessie : ${used.map(escapeHtml).join(', ')}`);
    },
    onState: (st) => {
      state.streamState = st;
      // Flux coupé : sondage plus rapide ; rétabli : retour à l'intervalle normal.
      if (state.timer) schedule();
      renderStatus(state.samples[state.samples.length - 1]);
    },
  });
  state.stream.start();
  // Chien de garde : un flux « ouvert » peut ne plus rien transmettre (changement
  // d'antenne LTE…). Si l'auto est active et que rien n'arrive, on force la reconnexion.
  state.watchdog = setInterval(() => {
    const st = state.stream;
    if (!st) return;
    const silent = streamSilent({ open: st.open, openAt: st.openAt, lastMsgAt: st.lastMsgAt, now: Date.now(),
      active: isActive(state.samples[state.samples.length - 1]) });
    if (silent) { state.streamRestarts++; st.reconnect(); }
  }, WATCHDOG_MS);
}

/**
 * Écarte d'un patch du flux les valeurs impossibles et les valeurs plus vieilles que la
 * dernière reçue pour le même champ (messages renvoyés après une reconnexion) ; garde
 * le reste comme « dernière valeur du flux ». null s'il ne reste rien.
 * Le saut de température est comparé à la dernière valeur DU FLUX, jamais au cache de
 * Tessie (sondage) : sinon une vraie valeur pouvait être rejetée contre une valeur périmée,
 * et comme le flux ne la renvoie que si elle change, l'affichage restait figé.
 */
function cleanPatch(p) {
  const live = state.live;
  const prev = live.tempMin || live.tempMax
    ? { t: (live.tempMin || live.tempMax).t, tempMin: live.tempMin ? live.tempMin.v : null, tempMax: live.tempMax ? live.tempMax.v : null }
    : null;
  const c = cleanData(prev, Object.assign({ t: p.t }, p.patch));
  const patch = {};
  for (const k of Object.keys(p.patch)) {
    if (c[k] == null) continue;
    if (live[k] && p.t < live[k].t) continue; // renvoi plus ancien que ce qu'on a déjà
    patch[k] = c[k];
    live[k] = { v: c[k], t: p.t };
  }
  return Object.keys(patch).length ? { t: p.t, patch } : null;
}

/** Flux connecté : ses valeurs sont à jour (il n'envoie un champ que lorsqu'il change). */
function streamFresh() {
  return !state.sim && state.streamState === 'open' && Object.keys(state.live).length > 0;
}

/** cleanSample + compteur d'écarts ; un champ écarté 3 fois de suite est ensuite accepté. */
function cleanData(prev, s) {
  const trust = Object.keys(state.rejectStreak).filter((k) => state.rejectStreak[k] >= 3);
  const r = cleanSample(prev, s, { trust });
  for (const k of Object.keys(s)) {
    if (r.rejected.indexOf(k) >= 0) state.rejectStreak[k] = (state.rejectStreak[k] || 0) + 1;
    else if (s[k] != null) state.rejectStreak[k] = 0;
  }
  state.rejected += r.rejected.length;
  return r.sample;
}

/**
 * Lien de configuration : #setup=<base64 JSON {token, vin}>.
 * Le fragment (#) n'est jamais envoyé au serveur ; on l'efface tout de suite de l'URL.
 */
function importSetupFromHash() {
  const m = /[#&]setup=([^&]+)/.exec(location.hash);
  if (!m) return;
  // window.history : « history » désigne ici le stockage local (store.js).
  try { window.history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    if (data.token) state.s.token = String(data.token).trim();
    if (data.vin) state.s.vin = String(data.vin).trim().toUpperCase();
    if (data.target) state.s.target = Number(data.target) || state.s.target;
    state.s.rememberToken = true;
    state.s.demo = false;
    settingsStore.save(state.s);
    setTimeout(() => banner('info', 'Configuration importée et enregistrée sur cet appareil.'), 0);
  } catch (e) {
    setTimeout(() => banner('error', 'Lien de configuration invalide.'), 0);
  }
}

function buildSetupLink(token, vin, target) {
  const json = JSON.stringify({ token, vin, target });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `${location.origin}${location.pathname}#setup=${encodeURIComponent(b64)}`;
}

// ───────────────────────── Vues et historique ─────────────────────────

/** Affiche la vue Direct ou Sessions. */
function applyView() {
  const v = state.s.view === 'sessions' ? 'sessions' : 'live';
  if (v === 'sessions' && layout && layout.editing) layout.setEditing(false);
  document.documentElement.classList.toggle('view-sessions', v === 'sessions');
  $('viewSessions').hidden = v !== 'sessions';
  for (const b of $('viewSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  if (v === 'sessions') sessions.show(state.sim ? 'demo' : `live:${state.s.vin}`);
  else render(true);
}

/**
 * Remplit le graphique avec les dernières heures enregistrées par Tessie,
 * pour ne pas partir de zéro à l'ouverture. Silencieux en cas d'échec.
 */
async function backfill() {
  const gen = state.gen;
  const now = Math.floor(Date.now() / 1000);
  const r = currentRange();
  const hours = r === 'auto' ? 4 : Math.min(12, Math.max(1, Math.ceil(r / 60)));
  try {
    const json = await new TessieClient({ token: state.s.token, baseUrl: state.s.baseUrl || DEFAULTS.baseUrl, timeoutMs: 30000 })
      .states(state.s.vin, `from=${now - hours * 3600}&to=${now}&interval=1`);
    if (gen !== state.gen) return; // mode changé entretemps
    const remote = statesToSamples(json).filter((x) => x.tempMin != null || x.voltage != null);
    if (!remote.length) return;
    state.samples = mergeSamples(state.samples, remote);
    history.save(state.s.vin, state.samples);
    render();
  } catch (e) {
    // L'historique est un plus : le direct continue sans lui.
  }
}

// ───────────────────────── Boucle de lecture ─────────────────────────

async function poll() {
  clearTimeout(state.timer);
  state.timer = null; // aucun sondage prévu (ex. token refusé) tant que schedule() n'est pas rappelé
  const gen = state.gen;
  if (state.inFlight === gen) return; // déjà une requête pour ce mode
  state.inFlight = gen;
  const demo = !!state.sim;
  try {
    const sample = demo ? state.sim.step() : await client().sample(state.s.vin);
    if (gen !== state.gen) return; // le mode a changé pendant la requête
    onSample(sample);
    state.errors = 0;
    state.lastOkAt = Date.now();
    if (!demo && $('banner').dataset.kind === 'error') banner(null);
  } catch (e) {
    if (gen !== state.gen) return;
    state.errors++;
    const msg = e instanceof ApiError ? e.message : `Erreur : ${e.message}`;
    setStatus('error', 'Erreur');
    banner('error', `${msg}${state.errors > 1 ? ` (essai ${state.errors})` : ''}`);
    if (e instanceof ApiError && e.kind === 'auth') {
      openSettings('Le token a été refusé. Vérifie-le dans Tessie → Settings → API.');
      return; // inutile de réessayer avec un mauvais token
    }
  } finally {
    if (state.inFlight === gen) state.inFlight = null;
  }
  schedule();
}

function schedule() {
  clearTimeout(state.timer);
  const setting = Math.max(10, Number(state.s.interval) || 30);
  const live = state.sim ? DEMO_INTERVAL_S : state.streamState === 'open' ? setting : Math.min(setting, FAST_POLL_S);
  const base = live * 1000;
  const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(state.errors, 4));
  state.timer = setTimeout(poll, delay);
}

function onSample(raw) {
  const prev = state.samples[state.samples.length - 1];
  // Position : seulement pour le thème selon le soleil, jamais enregistrée.
  if (raw.latitude != null && raw.longitude != null) state.pos = { lat: raw.latitude, lon: raw.longitude };
  delete raw.latitude; delete raw.longitude;
  if (streamFresh()) {
    // Flux connecté : il fait foi pour tous les champs qu'il a déjà envoyés. Le cache de
    // Tessie (ce sondage) peut être en retard ; sans cela il écrasait la vraie valeur, et le
    // flux ne la renvoyant que si elle change, l'affichage restait figé sur la valeur périmée.
    // Ce sondage sert alors de « battement » : une mesure à l'heure actuelle, valeurs du flux
    // reprises, plus ce que seul /state fournit (préconditionnement, recharge…).
    const now = Date.now();
    const fresh = {};
    for (const k of Object.keys(state.live)) { raw[k] = state.live[k].v; fresh[k] = true; }
    if (raw.voltage != null && raw.current != null) raw.powerKw = (raw.voltage * raw.current) / 1000;
    raw.t = Math.max(raw.t || 0, now);
    state.fields.note(fresh, now);
  }
  const sample = state.sim ? raw : cleanData(prev && prev.t <= raw.t ? prev : null, raw);
  state.fields.note(sample, sample.t);
  attachMotor(sample, state.motor);
  const added = appendSample(state.samples, sample);
  if (added) {
    recordHeatingEnd(prev, sample);
    if (!state.sim) history.save(state.s.vin, state.samples);
  } else if (prev && sample.t < prev.t) {
    // Le flux en direct a déjà une mesure plus récente : on garde quand même les états
    // que seul /state fournit (préconditionnement, recharge, rapport…).
    for (const k of STATE_ONLY) if (sample[k] != null) prev[k] = sample[k];
  }
  render();
}

/** Champs du flux en direct lus par le dashboard. */
const USED_STREAM_FIELDS = DRIVE_FIELDS.concat(['ModuleTempMin', 'ModuleTempMax', 'PackVoltage', 'PackCurrent', 'Soc']);

/** Champs fournis par /state mais pas par le flux en direct. */
const STATE_ONLY = ['preconditioning', 'chargingState', 'fastCharger', 'fastChargerType', 'chargeLimit',
  'minutesToFull', 'vehicleState', 'shiftState', 'chargerVoltage', 'chargerCurrent'];

/** Fin de chauffe détectée → on note la température : indice de la vraie cible du BMS. */
function recordHeatingEnd(prev, cur) {
  const obs = detectHeatingEnd(prev, cur, state.obs[state.obs.length - 1] || null);
  if (!obs) return;
  state.obs = state.sim ? [...state.obs, obs] : observations.add(state.s.vin, obs);
}

// ───────────────────────── Calcul ─────────────────────────

/** Rejoue l'EMA sur les derniers échantillons : résultat déterministe, sans dérive d'état. */
function computeEstimate() {
  const opts = { target: +state.s.target, metric: state.s.metric, windowMin: +state.s.windowMin };
  const n = state.samples.length;
  let smoothed = null;
  let est = estimate([], opts);
  for (let i = Math.max(0, n - 20); i < n; i++) {
    est = estimate(state.samples.slice(0, i + 1), opts, smoothed);
    smoothed = est.rateSmoothed;
  }
  return est;
}

// ───────────────────────── Affichage ─────────────────────────

let renderTimer = null;
let lastRenderAt = 0;

/**
 * Demande un rendu. Les rendus rapprochés sont regroupés (au plus un par seconde) ;
 * `now` = tout de suite (action de l'utilisateur).
 */
function render(now) {
  if (now) {
    clearTimeout(renderTimer); renderTimer = null;
    lastRenderAt = Date.now();
    renderNow();
    return;
  }
  if (renderTimer) return;
  const wait = Math.max(0, lastRenderAt + RENDER_MIN_MS - Date.now());
  renderTimer = setTimeout(() => { renderTimer = null; lastRenderAt = Date.now(); renderNow(); }, wait);
}

function renderNow() {
  applyTheme();
  const est = (state.est = computeEstimate());
  const last = state.samples[state.samples.length - 1];
  updateWakeLock(est, last);
  renderStatus(last);
  renderHero(est, last);
  renderGauges(last);
  renderCharts(est, last);
  renderObs();
}

function renderStatus(last) {
  if (state.sim) { setStatus('demo', 'Démo'); return; }
  if (!state.s.token || !state.s.vin) return;
  if (state.errors) return;
  if (!last) { setStatus('live', 'Connexion…'); return; }
  const age = Date.now() - last.t;
  if (age > STALE_MS) setStatus('stale', `Données d’il y a ${formatDuration(age)}`);
  else setStatus('live', state.streamState === 'open' ? 'En direct · flux' : `En direct · sondage ${pollSeconds()} s`);
  $('status').dataset.source = state.streamState === 'open' ? 'stream' : 'poll';
  const st = state.stream;
  $('lastUpdate').textContent = [
    state.lastOkAt ? `Dernière lecture : ${clock(state.lastOkAt)}.` : '',
    st ? `Flux : ${{ open: 'connecté', closed: 'coupé, reconnexion…', connecting: 'connexion…' }[state.streamState] || '—'}`
      + `${st.open && st.openAt && Date.now() - st.openAt > 60000 ? `, ${Math.round(st.msgCount / ((Date.now() - st.openAt) / 60000))} msg/min` : ''}`
      + `${st.lastMsgAt ? `, dernier message ${clock(st.lastMsgAt)}` : ''}${state.streamRestarts ? `, ${state.streamRestarts} reconnexion(s) forcée(s)` : ''}.` : '',
    state.rejected ? `${state.rejected} valeur(s) aberrante(s) écartée(s).` : '',
  ].filter(Boolean).join(' ');
}

function pollSeconds() {
  const setting = Math.max(10, Number(state.s.interval) || 30);
  return state.streamState === 'open' ? setting : Math.min(setting, FAST_POLL_S);
}

function renderHero(est, last) {
  const target = +state.s.target;
  $('tTarget').textContent = fmt(target, target % 1 ? 1 : 0);
  $('tTargetSub').textContent = `LFP · ${metricLabel()}`;
  $('rateSub').textContent = `fenêtre ${state.s.windowMin} min${est.r2 != null ? ` · R² ${est.r2.toFixed(2)}` : ''}`;

  if (!last) {
    $('tNow').textContent = '—'; $('tRange').textContent = '—'; $('rate').textContent = '—';
    $('etaValue').textContent = '—'; $('etaSub').textContent = 'En attente de données';
    return;
  }
  $('tNow').textContent = `${fmt(last.tempMin)} / ${fmt(last.tempMax)}`;
  const spread = last.tempMin != null && last.tempMax != null ? last.tempMax - last.tempMin : null;
  $('tRange').textContent = spread != null ? `écart ${fmt(spread)} °C` : '—';
  // Écart marqué : chauffe peu uniforme (les modules froids limitent la recharge).
  $('tRange').dataset.level = spread != null && spread >= SPREAD_WARN ? 'warn' : '';
  const r = est.rateSmoothed;
  $('rate').textContent = r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}`;

  const eta = $('etaValue'), sub = $('etaSub');
  eta.dataset.conf = est.confidence || '';
  switch (est.status) {
    case 'heating': {
      const range = est.etaHighMs === Infinity || est.etaLowMs == null
        ? `au moins ${formatDuration(est.etaLowMs != null ? est.etaLowMs : est.etaMs)}`
        : `${formatDuration(est.etaLowMs)} – ${formatDuration(est.etaHighMs)}`;
      if (est.confidence === 'low') {
        // Pas d'heure précise quand la plage est trop large : elle inspirerait trop confiance.
        eta.textContent = `≈ ${formatDuration(est.etaMs)}`;
        sub.textContent = `Estimation incertaine · plage ${range}`;
      } else {
        eta.textContent = formatDuration(est.etaMs);
        sub.textContent = `vers ${clock(est.tLast + est.etaMs)} · plage ${range}`;
      }
      break;
    }
    case 'reached':
      eta.textContent = 'Atteinte';
      sub.textContent = `${metricLabel()} à ${fmt(est.tempNow)} °C`;
      break;
    case 'stable':
      eta.textContent = '—';
      sub.textContent = last.heaterOn ? 'Température stable malgré le chauffage' : 'Température stable, chauffage inactif';
      break;
    case 'cooling':
      eta.textContent = '—';
      sub.textContent = 'La batterie refroidit';
      break;
    default:
      eta.textContent = '…';
      sub.textContent = `Collecte de données (${est.n} pts dans la fenêtre, min 3 sur 1 min)`;
  }
}

function metricLabel() {
  return { min: 'module min', avg: 'moyenne', max: 'module max' }[state.s.metric] || 'module min';
}

// Échelles fixes (pack LFP ~ 350 V). À ajuster au besoin : une valeur hors échelle
// remplit la barre au maximum et s'affiche quand même en texte.
// keys : champs dont dépend la jauge (pour l'âge de la valeur affichée).
const GAUGES = [
  // Module le plus froid (limite la recharge) ; le trait marque la cible : la barre monte vers lui.
  { id: 'battery', label: 'Batterie', unit: '°C', min: -20, max: 60, decimals: 1, get: (s) => s.tempMin,
    marker: () => +state.s.target, keys: ['tempMin'],
    sub: (s) => (s.tempMax != null ? `max ${fmt(s.tempMax)} °C` : '') },
  { id: 'voltage', label: 'Tension', unit: 'V', min: 280, max: 420, get: (s) => s.voltage, keys: ['voltage'] },
  { id: 'current', label: 'Courant', unit: 'A', min: -500, max: 500, signed: true, get: (s) => s.current, keys: ['current'],
    sub: () => '+ décharge' },
  { id: 'power', label: 'Puissance', unit: 'kW', min: -200, max: 200, decimals: 1, signed: true, get: (s) => s.powerKw,
    keys: ['voltage', 'current'],
    // Préconditionnement à l'arrêt : part de la puissance qui sert à chauffer (moins la base).
    sub: () => {
      const h = heatingPowerKw(state.samples);
      return h ? `chauffe ≈ ${fmt(h.kw)} kW` : '+ décharge';
    } },
  { id: 'soc', label: 'Charge', unit: '%', min: 0, max: 100, get: (s) => s.soc, marker: (s) => s.chargeLimit, keys: ['soc'],
    sub: (s) => (s.energyKwh != null ? `${fmt(s.energyKwh)} kWh` : '') },
  { id: 'charger', label: 'Chargeur', unit: 'kW', min: 0, max: 250, get: (s) => s.chargerPowerKw, keys: ['chargerPowerKw'],
    sub: (s) => (s.chargerVoltage || s.chargerCurrent ? `${fmt(s.chargerVoltage, 0)} V · ${fmt(s.chargerCurrent, 0)} A` : '') },
  { id: 'outside', label: 'Extérieur', unit: '°C', min: -30, max: 40, decimals: 1, signed: true, colorBySign: false, get: (s) => s.outsideTemp,
    keys: ['outsideTemp'] },
];
const SPREAD_WARN = 6; // °C entre le module le plus chaud et le plus froid

const CHIPS = [
  { id: 'chgState', label: 'Recharge', text: (s) => chargingLabel(s) + (s.fastCharger ? ' · DC' : ''),
    on: (s) => s.chargingState === 'Charging' },
  { id: 'heater', label: 'Chauffage', on: (s) => s.heaterOn },
  { id: 'precond', label: 'Précond.', on: (s) => s.preconditioning },
  // Stator · échangeur de chaleur de l'unité arrière (Profiler de Tessie).
  { id: 'drive', label: 'Moteur arr.', on: (s) => s.statorTemp != null && s.statorTemp >= 40,
    text: (s) => (s.statorTemp == null && s.heatsinkTemp == null ? '—'
      : `${fmt(s.statorTemp, 0)} · ${fmt(s.heatsinkTemp, 0)} °C`) },
];

function chargingLabel(s) {
  const map = { Charging: 'En charge', Complete: 'Terminée', Stopped: 'Arrêtée', Disconnected: 'Débranchée', Starting: 'Démarrage', NoPower: 'Sans courant' };
  return map[s.chargingState] || s.chargingState || '—';
}

let gauges;

function buildGauges() {
  $('chips').innerHTML = CHIPS.map((c) => `
    <div class="chip" id="chip-${c.id}"><span class="chip-label">${c.label}</span><span class="chip-val" id="chip-${c.id}-val">—</span></div>`).join('');
  gauges = new Gauges($('blockPool'), GAUGES);
}

function renderGauges(s) {
  const now = Date.now();
  const ages = {};
  if (!state.sim) for (const g of GAUGES) ages[g.id] = state.fields.age(g.keys, now);
  gauges.update(s || null, { ages, staleMs: FIELD_STALE_MS });
  for (const c of CHIPS) {
    const on = s ? c.on(s) : null;
    $(`chip-${c.id}`).setAttribute('data-on', String(on === true));
    $(`chip-${c.id}-val`).textContent = !s ? '—' : c.text ? c.text(s) : on == null ? '—' : on ? 'Actif' : 'Inactif';
  }
}

/** Fenêtre de temps de la disposition active : minutes, ou 'auto' (début du trajet → maintenant). */
function currentRange() {
  const key = layout ? layout.active : 'graphs';
  const r = (state.s.ranges || {})[key];
  if (r === 'auto' || Number.isFinite(r)) return r;
  return key === 'dash' ? 'auto' : state.s.rangeMin;
}

function renderCharts(est, last) {
  const now = Math.max(Date.now(), last ? last.t : 0);
  const range = currentRange();
  // Auto : le graphique commence au début du trajet (après la dernière période où l'auto
  // dormait) et s'étire à mesure qu'on roule ; 10 min au départ, 12 h au plus.
  const rangeMs = range === 'auto' ? now - autoWindowStart(state.samples, now) : range * 60000;
  const target = +state.s.target;
  let projection = null;
  let future = 0;
  if (est.status === 'heating' && Number.isFinite(est.etaMs)) {
    future = Math.min(est.etaMs, rangeMs * 0.33);
    projection = [{ t: est.tLast, y: est.tempFit }, { t: est.tLast + est.etaMs, y: target }];
  }
  const domain = [now - rangeMs, now + future];
  // Bandes bleues : chauffe de la batterie (pas le préconditionnement : la cabine peut se
  // préconditionner sans que la batterie chauffe). Calcul mis en cache : il refait une
  // régression par point, inutile tant que les mesures ne changent pas.
  const zones = heatZonesCached(domain[0]).map((z) => ({ t0: z.t0, t1: z.t1, cls: 'heat-zone' }));
  // Repères : fins de chauffe détectées.
  const markers = state.obs.filter((o) => o.t >= domain[0]).map((o) => ({ t: o.t, label: 'fin de chauffe' }));
  // La projection suit la métrique choisie ; la bande montre l'étendue min–max.
  charts.temp.update(state.samples, domain, { band: ['tempMin', 'tempMax'], target, projection, yInclude: [target], zones, markers });
  const hasMotor = state.samples.some((x) => x.statorTemp != null || x.heatsinkTemp != null);
  $('motorEmpty').hidden = hasMotor;
  for (const el of document.querySelectorAll('.legend-heat')) el.hidden = !zones.length;
  charts.motor.update(state.samples, domain, { zones, markers: markers.map((m) => ({ t: m.t })) });
}

let heatCache = { key: '', zones: [] };
function heatZonesCached(from) {
  const n = state.samples.length;
  const last = state.samples[n - 1];
  const key = `${n}:${last ? last.t : 0}:${Math.floor(from / 30000)}:${last ? `${last.tempMin}:${last.powerKw}:${last.preconditioning}` : ''}`;
  if (heatCache.key !== key) {
    heatCache = { key, zones: heatingZones(state.samples.filter((x) => x.t >= from - 10 * 60000)) };
  }
  return heatCache.zones;
}

// ───────────────────────── Thème et écran ─────────────────────────

/** Thème : système, sombre, clair, ou selon le soleil (position de l'auto, sinon 19 h – 7 h). */
function applyTheme() {
  const t = state.s.theme;
  const root = document.documentElement;
  const want = t === 'dark' || t === 'light' ? t
    : t === 'sun' ? (isNight(Date.now(), state.pos && state.pos.lat, state.pos && state.pos.lon) ? 'dark' : 'light')
      : null;
  if (want) { if (root.dataset.theme !== want) root.dataset.theme = want; }
  else if (root.dataset.theme) delete root.dataset.theme;
}

/**
 * Garde l'écran allumé pendant une chauffe, un préconditionnement ou une recharge, si le
 * navigateur le permet (Wake Lock). Sinon, rien ne change.
 */
function updateWakeLock(est, last) {
  if (!('wakeLock' in navigator) || state.wakePending) return;
  const want = document.visibilityState === 'visible' && !!last && (est.status === 'heating'
    || last.preconditioning === true || last.chargingState === 'Charging');
  if (want && !state.wakeLock) {
    state.wakePending = true;
    navigator.wakeLock.request('screen').then((lock) => {
      state.wakeLock = lock;
      lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    }).catch(() => { /* refusé ou non pris en charge */ })
      .then(() => { state.wakePending = false; });
  } else if (!want && state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    lock.release().catch(() => { /* */ });
  }
}

function renderObs() {
  $('obsCard').hidden = !state.obs.length;
  $('obsList').innerHTML = [...state.obs].reverse().slice(0, 8).map((o, i) => `
    <li><span>${new Date(o.t).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })}</span>
    <span>min ${fmt(o.tempMin)} °C · max ${fmt(o.tempMax)} °C${o.reason ? ` · ${o.reason}` : ''}</span>
    <button class="btn" type="button" data-obs="${state.obs.length - 1 - i}">Utiliser comme cible</button></li>`).join('');
}

function setStatus(kind, text) {
  $('status').dataset.state = kind;
  $('statusText').textContent = text;
}

function banner(kind, html) {
  const b = $('banner');
  if (!kind) { b.hidden = true; delete b.dataset.kind; return; }
  b.dataset.kind = kind;
  b.innerHTML = html;
  b.hidden = false;
}

// ───────────────────────── Interface ─────────────────────────

function bindUi() {
  $('btnSettings').addEventListener('click', () => openSettings());
  $('btnTarget').addEventListener('click', () => openSettings(null, 'target'));
  $('btnRefresh').addEventListener('click', () => poll());
  // Disposition : choix (un tap), mode édition, largeur des colonnes, cartes masquées.
  $('layoutSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    layout.setActive(b.dataset.layout);
    syncRangeButtons(); // chaque disposition garde sa fenêtre de temps
    render(true);
  });
  $('btnEdit').addEventListener('click', () => layout.setEditing(!layout.editing));
  $('btnEditDone').addEventListener('click', () => layout.setEditing(false));
  $('btnLayoutReset').addEventListener('click', () => layout.reset());
  $('splitRange').addEventListener('input', (e) => layout.setSplit(+e.target.value));
  $('hiddenList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) layout.showBlock(b.dataset.show);
  });
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.s.view = b.dataset.view;
    settingsStore.save(state.s);
    applyView();
  });
  $('btnDemo').addEventListener('click', () => {
    state.s.demo = !state.sim;
    settingsStore.save(state.s);
    state.errors = 0;
    if (state.s.demo) startDemo(); else startLive();
  });
  $('rangeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const m = btn && btn.dataset.min;
    if (!m) return;
    const v = m === 'auto' ? 'auto' : +m;
    state.s.ranges = Object.assign({}, state.s.ranges);
    state.s.ranges[layout.active] = v;
    if (v !== 'auto') state.s.rangeMin = v;
    settingsStore.save(state.s);
    syncRangeButtons();
    render(true);
  });
  $('obsList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const i = btn ? btn.dataset.obs : null;
    const o = i != null ? state.obs[+i] : null;
    if (!o) return;
    const v = pickTemp(o, state.s.metric);
    if (v == null) return;
    state.s.target = v;
    settingsStore.save(state.s);
    render(true);
  });
  document.addEventListener('visibilitychange', () => {
    // Le verrou d'écran est relâché quand la page est cachée : render() le redemande.
    if (document.visibilityState === 'visible' && (state.sim || (state.s.token && state.s.vin))) poll();
  });
  // Thème selon le soleil : réévalué chaque minute même sans nouvelle donnée.
  setInterval(applyTheme, 60000);
  window.addEventListener('online', () => { if (state.s.token && state.s.vin) poll(); });

  const form = $('settingsForm');
  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue === 'save') saveSettings(new FormData(form));
  });
  $('btnFindVin').addEventListener('click', findVins);
  $('btnCarLink').addEventListener('click', async () => {
    const f = form.elements;
    const token = f.token.value.trim(), vin = f.vin.value.trim().toUpperCase();
    if (!token || !vin) { formMsg('Il faut le token et le VIN pour créer le lien.', 'error'); return; }
    const link = buildSetupLink(token, vin, Number(f.target.value) || state.s.target);
    const out = $('carLink');
    out.value = link; out.hidden = false; $('carLinkHelp').hidden = false;
    out.focus(); out.select();
    try { await navigator.clipboard.writeText(link); formMsg('Lien copié.'); }
    catch (e) { formMsg('Sélectionne et copie le lien ci-dessous.'); }
  });
  $('vinList').addEventListener('change', (e) => { form.elements.vin.value = e.target.value; });
  $('btnHistTest').addEventListener('click', testHistory);
  $('btnTelCheck').addEventListener('click', telCheck);
  $('btnTelEnable').addEventListener('click', telEnable);
  $('btnTelStream').addEventListener('click', telStream);
  $('btnHistCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('histReport').textContent); formMsg('Rapport copié.'); }
    catch (e) { formMsg('Sélectionne le texte du rapport pour le copier.'); }
  });
  $('btnClearHist').addEventListener('click', () => {
    if (!state.s.vin) return;
    history.clear(state.s.vin);
    if (!state.sim) { state.samples = []; render(true); }
    formMsg('Historique effacé.');
  });
}

/** Sélecteur de disposition, barre d'édition et cartes masquées. */
function syncLayoutUi() {
  for (const b of $('layoutSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.layout === layout.active));
  $('btnEdit').setAttribute('aria-pressed', String(layout.editing));
  $('editBar').hidden = !layout.editing;
  $('splitRange').value = layout.layout.split;
  $('hiddenList').innerHTML = layout.layout.hidden.map((id) =>
    `<button class="btn btn-add" type="button" data-show="${id}">+ ${escapeHtml(BLOCKS[id])}</button>`).join('');
}

function syncRangeButtons() {
  const r = String(currentRange());
  for (const b of $('rangeSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.min === r));
}

function openSettings(message, focus) {
  const f = $('settingsForm').elements;
  f.token.value = state.s.token || '';
  f.rememberToken.checked = !!state.s.rememberToken || (IS_CAR && !state.s.token);
  $('uaInfo').textContent = `Version ${APP_VERSION} · Navigateur : ${navigator.userAgent}`;
  $('carLink').hidden = true; $('carLinkHelp').hidden = true;
  f.vin.value = state.s.vin || '';
  f.target.value = state.s.target;
  f.interval.value = state.s.interval;
  f.metric.value = state.s.metric;
  f.windowMin.value = state.s.windowMin;
  $('telInterval').value = String(state.s.telInterval || 30);
  f.theme.value = state.s.theme || 'system';
  f.baseUrl.value = state.s.baseUrl;
  $('vinList').hidden = true;
  formMsg(message || '', message ? 'error' : null);
  if (!$('settings').open) $('settings').showModal();
  if (focus) f[focus].focus();
}

function saveSettings(fd) {
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const prevVin = state.s.vin, prevToken = state.s.token, prevBase = state.s.baseUrl;
  Object.assign(state.s, {
    token: String(fd.get('token') || '').trim(),
    rememberToken: fd.get('rememberToken') === 'on',
    vin: String(fd.get('vin') || '').trim().toUpperCase(),
    target: clamp(fd.get('target'), 0, 70, DEFAULTS.target),
    interval: clamp(fd.get('interval'), 10, 600, DEFAULTS.interval),
    metric: ['min', 'avg', 'max'].includes(fd.get('metric')) ? fd.get('metric') : 'min',
    windowMin: clamp(fd.get('windowMin'), 2, 30, DEFAULTS.windowMin),
    theme: ['system', 'sun', 'dark', 'light'].indexOf(fd.get('theme')) >= 0 ? fd.get('theme') : 'system',
    baseUrl: String(fd.get('baseUrl') || DEFAULTS.baseUrl).trim(),
  });
  settingsStore.save(state.s);
  const connChanged = prevVin !== state.s.vin || prevToken !== state.s.token || prevBase !== state.s.baseUrl;
  if (connChanged && state.s.token && state.s.vin) {
    // Une nouvelle config réelle fait quitter le mode démo.
    state.s.demo = false;
    settingsStore.save(state.s);
    state.errors = 0;
    startLive();
  } else {
    render(true);
    if (!state.sim) schedule();
  }
}

/**
 * Diagnostic : demande 6 h d'historique à Tessie et affiche ce qu'il contient
 * (nombre de points, intervalle réel, champs disponibles). Sert à concevoir la page « Sessions ».
 */
async function testHistory() {
  const f = $('settingsForm').elements;
  const token = f.token.value.trim(), vin = f.vin.value.trim().toUpperCase();
  if (!token || !vin) { formMsg('Il faut le token et le VIN.', 'error'); return; }
  const c = new TessieClient({ token, baseUrl: f.baseUrl.value.trim() || DEFAULTS.baseUrl, timeoutMs: 30000 });
  const now = Math.floor(Date.now() / 1000);
  // Une auto endormie n'ajoute pas de points : on élargit la période jusqu'à en trouver.
  // interval=1 (tous les points) seulement sur la courte période, pour garder la réponse légère.
  const windows = [
    { label: '6 h', sec: 6 * 3600, extras: ['&interval=1', ''] },
    { label: '48 h', sec: 48 * 3600, extras: ['', '&condense=false'] },
    { label: '7 jours', sec: 7 * 86400, extras: [''] },
  ];
  const out = $('histReport');
  out.hidden = false; $('btnHistCopy').hidden = true;
  const log = [];
  const hide = (q) => q.replace(/\d{9,}/g, '…');
  let found = null, last = null;
  outer:
  for (const w of windows) {
    for (const extra of w.extras) {
      const q = `from=${now - w.sec}&to=${now}${extra}`;
      out.textContent = `Lecture de l’historique (${w.label})…`;
      try {
        const json = await c.states(vin, q);
        const sum = summarize(json);
        log.push(`${w.label} ${hide(extra) || '(intervalle par défaut)'} → ${sum.count} points`);
        last = { sum, q, w };
        if (sum.count > 0) { found = last; break outer; }
      } catch (e) {
        log.push(`${w.label} ${hide(extra)} → ${e.message}`);
        if (e instanceof ApiError && (e.kind === 'auth' || e.kind === 'network')) break outer;
      }
    }
  }
  // État actuel (en cache, ne réveille pas l'auto) : aide à expliquer un historique vide.
  let stateLine = '';
  try {
    const st = await c.state(vin);
    const cs = (st && st.charge_state) || {};
    const ts = cs.timestamp || (st && st.timestamp);
    const ms = ts ? (ts < 1e12 ? ts * 1000 : ts) : null;
    stateLine = `\nÉtat actuel : ${(st && st.state) || '—'}`
      + (ms ? ` · dernière donnée il y a ${formatDuration(Date.now() - ms)}` : '');
  } catch (e) { stateLine = `\nÉtat actuel : illisible (${e.message})`; }

  const r = found || last;
  if (!r) {
    out.textContent = `Échec :\n${log.join('\n')}${stateLine}`;
    formMsg('L’historique n’a pas pu être lu.', 'error');
    return;
  }
  out.textContent = formatReport(r.sum, { requested: `/states?${hide(r.q)} (${r.w.label})`, version: APP_VERSION })
    + `\n\nEssais : ${log.join(' ; ')}${stateLine}`
    + `\nNavigateur : ${navigator.userAgent}`;
  $('btnHistCopy').hidden = false;
  formMsg(found ? 'Rapport prêt. Copie-le et envoie-le à Claude.' : 'Aucun point trouvé sur 7 jours. Copie quand même le rapport.');
}

// ───────────────────────── Télémétrie : stator du moteur arrière ─────────────────────────

function telContext() {
  const f = $('settingsForm').elements;
  const token = f.token.value.trim(), vin = f.vin.value.trim().toUpperCase();
  if (!token || !vin) { formMsg('Il faut le token et le VIN.', 'error'); return null; }
  const c = new TessieClient({ token, baseUrl: f.baseUrl.value.trim() || DEFAULTS.baseUrl, timeoutMs: 30000 });
  return { c, vin, token };
}
function telOut(text) {
  const out = $('telReport');
  out.hidden = false;
  out.textContent = text;
}

/** Lecture seule : champs configurés, valeur « stator » dans l'état et dans l'historique. */
async function telCheck() {
  const ctx = telContext();
  if (!ctx) return;
  const { c, vin } = ctx;
  telOut('Vérification…');
  const lines = [`TÉLÉMÉTRIE STATOR (version ${APP_VERSION})`];
  try {
    const cfg = await c.telemetryConfig(vin);
    const fields = configuredFields(cfg);
    for (const fld of DRIVE_FIELDS) lines.push(`${fld} : ${fields.includes(fld) ? 'configuré ✓' : 'absent de la configuration ✗'}`);
    lines.push(`Champs configurés (${fields.length}) : ${fields.join(', ') || '—'}`);
    const flags = configFlags(cfg);
    lines.push(`Indicateurs : ${Object.keys(flags).map((k) => `${k} = ${flags[k]}`).join(' · ') || '—'}`);
    lines.push(`Structure de la configuration : ${shape(cfg, 3)}`);
  } catch (e) { lines.push(`Configuration illisible : ${e.message}`); }
  try {
    const vals = findDriveValues(await c.state(vin));
    lines.push(vals.length ? `Dans /state : ${vals.map((v) => `${v.path} = ${v.value}`).join(' ; ')}` : 'Dans /state : aucune valeur stator / échangeur de chaleur.');
  } catch (e) { lines.push(`/state illisible : ${e.message}`); }
  try {
    const now = Math.floor(Date.now() / 1000);
    const json = await c.states(vin, `from=${now - 3600}&to=${now}&interval=1`);
    const recs = findRecords(json);
    const cols = recs[0] ? Object.keys(recs[0]).filter((k) => /stator|inverter|heatsink/i.test(k)) : [];
    const n = statesToSamples(json).filter((x) => x.statorTemp != null).length;
    lines.push(`Historique (1 h) : ${cols.length ? cols.join(', ') : 'aucune colonne stator / échangeur de chaleur'} · ${n} point(s) avec une température de stator.`);
  } catch (e) { lines.push(`Historique illisible : ${e.message}`); }
  telOut(lines.join('\n'));
}

/** Ajoute DiStatorTempR à la configuration existante (sans retirer d'autres champs), après confirmation. */
async function telEnable() {
  const ctx = telContext();
  if (!ctx) return;
  const { c, vin } = ctx;
  const interval = Math.max(1, Number($('telInterval').value) || 30);
  if (!window.confirm(`Ajouter ${DRIVE_FIELDS.join(', ')} à la télémétrie de l’auto, un point aux ${interval} s au plus ?\n`
    + 'Les autres champs et réglages ne sont pas modifiés. Les températures du moteur arriveront alors sans le Profiler.')) return;
  telOut('Lecture de la configuration actuelle…');
  try {
    const cfg = await c.telemetryConfig(vin);
    if (driveFieldsStatus(cfg, interval).ok) {
      telOut(`${DRIVE_FIELDS.join(', ')} : déjà configurés aux ${interval} s. Rien envoyé.`);
      state.s.telFields = true; state.s.telInterval = interval; settingsStore.save(state.s);
      return;
    }
    const body = withStatorField(cfg, DRIVE_FIELDS, interval, { force: true });
    if (!body) {
      telOut(`Configuration actuelle illisible ou vide : rien envoyé, pour ne pas remplacer celle de Tessie.\nStructure reçue : ${shape(cfg, 3)}`);
      return;
    }
    if (configFlags(cfg).limit_reached === true) {
      telOut('Tessie indique limit_reached = true : la limite de télémétrie semble atteinte. Rien envoyé.');
      return;
    }
    const res = await c.setTelemetryConfig(vin, body);
    state.s.telFields = true; state.s.telInterval = interval; settingsStore.save(state.s);
    telOut(`Envoyé : { fields } avec ${Object.keys(body.fields).length} champs (les ${configuredFields(cfg).length} actuels + ${DRIVE_FIELDS.join(', ')} aux ${interval} s).\n`
      + `Réponse : ${shape(res, 3)}\nVérification dans 5 s…`);
    // Relecture : Tessie a-t-elle gardé les champs et l'intervalle ?
    await new Promise((ok) => setTimeout(ok, 5000));
    const after = await c.telemetryConfig(vin);
    const st = driveFieldsStatus(after, interval);
    const flags = configFlags(after);
    telOut(`${$('telReport').textContent}\n`
      + (st.ok ? `Relu : les champs sont dans la configuration, aux ${interval} s.` : st.missing.length
        ? `Relu : ${st.missing.join(', ')} ABSENT(S) de la configuration. Tessie ne les a pas gardés.`
        : `Relu : présents, mais avec un autre intervalle que ${interval} s (${st.otherInterval.join(', ')}) : Tessie ou l’auto l’a ajusté.`)
      + `\nsynced = ${flags.synced} (l’auto applique la configuration à son prochain réveil ; « Vérifier » dans quelques minutes).`
      + '\nTest : arrête le Profiler, verrouille le téléphone, et regarde si le graphique « Moteur arrière » continue.');
  } catch (e) {
    telOut(`Échec : ${e.message}`);
  }
}

/**
 * Champs du moteur ajoutés par ce dashboard : vérifie (au démarrage, puis toutes les 30 min)
 * qu'ils sont encore dans la configuration de l'auto. Tessie gère cette configuration et
 * pourrait la remplacer (ex. le Profiler) : on le signale plutôt que de le découvrir en roulant.
 */
async function watchTelemetryFields() {
  clearTimeout(state.telTimer);
  if (state.sim || !state.s.telFields || !state.s.token || !state.s.vin) return;
  const gen = state.gen;
  try {
    const cfg = await client().telemetryConfig(state.s.vin);
    if (gen !== state.gen) return;
    const st = driveFieldsStatus(cfg);
    if (st.missing.length) {
      banner('error', `Les températures du moteur (${st.missing.map(escapeHtml).join(', ')}) ont été retirées de la télémétrie de l’auto, probablement par Tessie. `
        + 'Réglages → Avancé → « Activer ces 2 champs » pour les remettre.');
    }
  } catch (e) { /* vérification facultative : on réessaiera */ }
  if (gen === state.gen) state.telTimer = setTimeout(watchTelemetryFields, 30 * 60000);
}

/** Écoute le flux en direct de Tessie 60 s et rapporte les champs reçus. */
async function telStream() {
  const ctx = telContext();
  if (!ctx) return;
  telOut('Connexion au flux en direct…');
  const r = await streamProbe({
    vin: ctx.vin, token: ctx.token, ms: 60000,
    onTick: (x) => telOut(`Écoute du flux (60 s)… ${x.opened ? 'connecté' : 'connexion'} · ${x.messages} message(s)`),
  });
  telOut([
    `FLUX EN DIRECT (version ${APP_VERSION})`,
    `Connexion : ${r.opened ? 'établie' : 'échec'}${r.error ? ` (${r.error})` : ''}${r.closeCode != null ? ` · fermée, code ${r.closeCode}` : ''}`,
    `Messages reçus : ${r.messages}`,
    `Moteur arrière : ${r.stator.length ? r.stator.slice(-6).join(' ; ') : 'aucune valeur'}`,
    `Erreurs du flux : ${r.errors.length ? Array.from(new Set(r.errors)).join(' ; ') : 'aucune'}`,
    `Connectivité : ${r.status.length ? r.status.join(' → ') : '—'}`,
    `Champs vus (${r.keys.length}) : ${r.keys.slice(0, 80).join(', ') || '—'}`,
  ].join('\n'));
}

async function findVins() {
  const f = $('settingsForm').elements;
  const token = f.token.value.trim();
  if (!token) { formMsg('Entre d’abord ton token.', 'error'); return; }
  formMsg('Recherche…');
  try {
    const c = new TessieClient({ token, baseUrl: f.baseUrl.value.trim() || DEFAULTS.baseUrl });
    const res = await c.vehicles();
    const list = ((res && res.results) || []).map((v) => ({
      vin: v.vin,
      name: dig(v, 'last_state.vehicle_state.vehicle_name') || dig(v, 'last_state.display_name') || v.vin,
    })).filter((v) => v.vin);
    if (!list.length) { formMsg('Aucun véhicule actif trouvé sur ce compte.', 'error'); return; }
    const sel = $('vinList');
    sel.innerHTML = list.map((v) => `<option value="${v.vin}">${escapeHtml(v.name)} · ${v.vin}</option>`).join('');
    sel.hidden = list.length < 2;
    f.vin.value = list[0].vin;
    formMsg(`${list.length} véhicule(s) trouvé(s).`);
  } catch (e) {
    formMsg(e.message, 'error');
  }
}

function formMsg(text, kind) {
  const m = $('formMsg');
  m.textContent = text;
  if (kind) m.dataset.kind = kind; else delete m.dataset.kind;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

init();
