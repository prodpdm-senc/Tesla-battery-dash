import { TessieClient, ApiError } from './tessie.js?v=18';
import { Simulator } from './simulator.js?v=18';
import { estimate, pickTemp, formatDuration } from './estimator.js?v=18';
import { settings as settingsStore, history, observations, appendSample } from './store.js?v=18';
import { createCharts } from './charts.js?v=18';
import { Gauges } from './gauges.js?v=18';
import { summarize, formatReport, statesToSamples, mergeSamples, shape, findRecords } from './history.js?v=18';
import { DRIVE_FIELDS, configuredFields, withStatorField, findDriveValues, streamProbe, configFlags, LiveStream, attachMotor, applyPatch } from './telemetry.js?v=18';
import { SessionsView, demoHistory } from './sessionsView.js?v=18';
import { detectHeatingEnd } from './events.js?v=18';

// Version de l'app. Le même numéro est ajouté à l'adresse de chaque fichier (?v=…)
// pour forcer les navigateurs (Chrome iPhone, auto) à charger la nouvelle version.
// À augmenter à chaque mise en ligne ; test/version.test.mjs vérifie la cohérence.
export const APP_VERSION = '18';

const DEFAULTS = {
  vin: '',
  baseUrl: 'https://api.tessie.com',
  interval: 30,        // s
  target: 50,          // °C — LFP, à calibrer avec les coupures observées
  metric: 'min',
  windowMin: 5,
  rememberToken: false,
  rangeMin: 60,
  demo: false,
  view: 'live',        // 'live' | 'sessions'
};
const DEMO_INTERVAL_S = 5;
const STALE_MS = 5 * 60000;
const MAX_BACKOFF_MS = 5 * 60000;

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
};

let charts;
let sessions;

// ───────────────────────── Démarrage ─────────────────────────

const IS_CAR = document.documentElement.classList.contains('car');

function init() {
  window.__appStarted = true;
  importSetupFromHash();
  charts = createCharts({ tempEl: $('chartTemp'), motorEl: $('chartMotor') });
  buildGauges();
  sessions = new SessionsView({
    fetchStates: (q) => {
      if (!state.s.token || !state.s.vin) return Promise.reject(new Error('token ou VIN manquant (Réglages)'));
      return new TessieClient({ token: state.s.token, baseUrl: state.s.baseUrl || DEFAULTS.baseUrl, timeoutMs: 45000 }).states(state.s.vin, q);
    },
    demoSamples: () => (state.sim ? (state.demoHist || (state.demoHist = demoHistory())) : null),
    getTarget: () => +state.s.target,
    onUseTarget: (t) => { state.s.target = t; settingsStore.save(state.s); render(); },
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
    render();
    return;
  }
  state.samples = history.load(state.s.vin);
  state.obs = observations.load(state.s.vin);
  banner(null);
  render();
  poll();
  backfill();
  startStream();
  if (state.s.view === 'sessions') sessions.show(`live:${state.s.vin}`);
}

function startDemo() {
  stop();
  state.sim = new Simulator();
  state.samples = state.sim.history();
  state.obs = [];
  $('btnDemo').setAttribute('aria-pressed', 'true');
  banner('info', 'Mode démo : préconditionnement simulé d’un pack LFP par −5 °C. Aucune donnée réelle.');
  render();
  poll();
  if (state.s.view === 'sessions') sessions.show('demo');
}

function stop() {
  clearTimeout(state.timer);
  state.timer = null;
  state.gen++;
  if (state.stream) { state.stream.stop(); state.stream = null; }
}

/**
 * Flux en direct de Tessie : apporte les températures du moteur arrière quand le
 * Profiler de Tessie est activé (elles ne sont ni dans /state ni dans l'historique).
 */
function startStream() {
  state.motor = null;
  let lastSave = 0;
  state.stream = new LiveStream({
    vin: state.s.vin,
    token: state.s.token,
    // Flux en direct : batterie (cellules, tension, courant, SOC…) et moteur arrière.
    // Seuls les champs qui changent arrivent ; les autres sont repris de la mesure précédente.
    onPatch: (p) => {
      const motor = {};
      for (const k of ['statorTemp', 'inverterTemp', 'heatsinkTemp']) if (p.patch[k] != null) motor[k] = p.patch[k];
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
  });
  state.stream.start();
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
  document.documentElement.classList.toggle('view-sessions', v === 'sessions');
  $('viewSessions').hidden = v !== 'sessions';
  for (const b of $('viewSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  if (v === 'sessions') sessions.show(state.sim ? 'demo' : `live:${state.s.vin}`);
  else render();
}

/**
 * Remplit le graphique avec les dernières heures enregistrées par Tessie,
 * pour ne pas partir de zéro à l'ouverture. Silencieux en cas d'échec.
 */
async function backfill() {
  const gen = state.gen;
  const now = Math.floor(Date.now() / 1000);
  const hours = Math.min(12, Math.max(1, Math.ceil(state.s.rangeMin / 60)));
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
  const base = (state.sim ? DEMO_INTERVAL_S : Math.max(10, Number(state.s.interval) || 30)) * 1000;
  const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(state.errors, 4));
  state.timer = setTimeout(poll, delay);
}

function onSample(sample) {
  const prev = state.samples[state.samples.length - 1];
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

function render() {
  const est = (state.est = computeEstimate());
  const last = state.samples[state.samples.length - 1];
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
  else setStatus('live', 'En direct');
  $('lastUpdate').textContent = state.lastOkAt ? `Dernière lecture : ${clock(state.lastOkAt)}.` : '';
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
  const r = est.rateSmoothed;
  $('rate').textContent = r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}`;

  const eta = $('etaValue'), sub = $('etaSub');
  switch (est.status) {
    case 'heating': {
      eta.textContent = formatDuration(est.etaMs);
      const range = est.etaHighMs === Infinity
        ? `au moins ${formatDuration(est.etaLowMs)}`
        : `${formatDuration(est.etaLowMs)} – ${formatDuration(est.etaHighMs)}`;
      sub.textContent = `vers ${clock(est.tLast + est.etaMs)} · plage ${range}`;
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
const GAUGES = [
  { id: 'voltage', label: 'Tension', unit: 'V', min: 280, max: 420, get: (s) => s.voltage },
  { id: 'current', label: 'Courant', unit: 'A', min: -500, max: 500, signed: true, get: (s) => s.current,
    sub: () => '+ décharge' },
  { id: 'power', label: 'Puissance', unit: 'kW', min: -200, max: 200, decimals: 1, signed: true, get: (s) => s.powerKw,
    sub: () => '+ décharge' },
  { id: 'soc', label: 'Charge', unit: '%', min: 0, max: 100, get: (s) => s.soc, marker: (s) => s.chargeLimit,
    sub: (s) => (s.energyKwh != null ? `${fmt(s.energyKwh)} kWh` : '') },
  { id: 'charger', label: 'Chargeur', unit: 'kW', min: 0, max: 250, get: (s) => s.chargerPowerKw,
    sub: (s) => (s.chargerVoltage || s.chargerCurrent ? `${fmt(s.chargerVoltage, 0)} V · ${fmt(s.chargerCurrent, 0)} A` : '') },
  { id: 'outside', label: 'Extérieur', unit: '°C', min: -30, max: 40, decimals: 1, signed: true, colorBySign: false, get: (s) => s.outsideTemp },
];

const CHIPS = [
  { id: 'chgState', label: 'Recharge', text: (s) => chargingLabel(s) + (s.fastCharger ? ' · DC' : ''),
    on: (s) => s.chargingState === 'Charging' },
  { id: 'heater', label: 'Chauffage', on: (s) => s.heaterOn },
  { id: 'precond', label: 'Précond.', on: (s) => s.preconditioning },
  // Stator / onduleur / dissipateur de l'unité arrière (si la télémétrie les transmet).
  { id: 'drive', label: 'Moteur arr.', on: (s) => s.statorTemp != null && s.statorTemp >= 40,
    text: (s) => (s.statorTemp == null && s.inverterTemp == null ? '—'
      : `${fmt(s.statorTemp, 0)} · ${fmt(s.inverterTemp, 0)} · ${fmt(s.heatsinkTemp, 0)} °C`) },
];

function chargingLabel(s) {
  const map = { Charging: 'En charge', Complete: 'Terminée', Stopped: 'Arrêtée', Disconnected: 'Débranchée', Starting: 'Démarrage', NoPower: 'Sans courant' };
  return map[s.chargingState] || s.chargingState || '—';
}

let gauges;

function buildGauges() {
  $('chips').innerHTML = CHIPS.map((c) => `
    <div class="chip" id="chip-${c.id}"><span class="chip-label">${c.label}</span><span class="chip-val" id="chip-${c.id}-val">—</span></div>`).join('');
  gauges = new Gauges($('gauges'), GAUGES);
}

function renderGauges(s) {
  gauges.update(s || null);
  for (const c of CHIPS) {
    const on = s ? c.on(s) : null;
    $(`chip-${c.id}`).setAttribute('data-on', String(on === true));
    $(`chip-${c.id}-val`).textContent = !s ? '—' : c.text ? c.text(s) : on == null ? '—' : on ? 'Actif' : 'Inactif';
  }
}

function renderCharts(est, last) {
  const rangeMs = state.s.rangeMin * 60000;
  const now = Math.max(Date.now(), last ? last.t : 0);
  const target = +state.s.target;
  let projection = null;
  let future = 0;
  if (est.status === 'heating' && Number.isFinite(est.etaMs)) {
    future = Math.min(est.etaMs, rangeMs * 0.33);
    projection = [{ t: est.tLast, y: est.tempFit }, { t: est.tLast + est.etaMs, y: target }];
  }
  const domain = [now - rangeMs, now + future];
  // La projection suit la métrique choisie ; la bande montre l'étendue min–max.
  charts.temp.update(state.samples, domain, { band: ['tempMin', 'tempMax'], target, projection, yInclude: [target] });
  const hasMotor = state.samples.some((x) => x.statorTemp != null || x.inverterTemp != null || x.heatsinkTemp != null);
  $('motorEmpty').hidden = hasMotor;
  charts.motor.update(state.samples, domain, {});
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
    state.s.rangeMin = +m;
    settingsStore.save(state.s);
    syncRangeButtons();
    render();
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
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.sim || (state.s.token && state.s.vin))) poll();
  });
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
    if (!state.sim) { state.samples = []; render(); }
    formMsg('Historique effacé.');
  });
}

function syncRangeButtons() {
  for (const b of $('rangeSeg').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(+b.dataset.min === +state.s.rangeMin));
  }
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
    render();
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
    lines.push(vals.length ? `Dans /state : ${vals.map((v) => `${v.path} = ${v.value}`).join(' ; ')}` : 'Dans /state : aucune valeur stator / onduleur / dissipateur.');
  } catch (e) { lines.push(`/state illisible : ${e.message}`); }
  try {
    const now = Math.floor(Date.now() / 1000);
    const json = await c.states(vin, `from=${now - 3600}&to=${now}&interval=1`);
    const recs = findRecords(json);
    const cols = recs[0] ? Object.keys(recs[0]).filter((k) => /stator|inverter|heatsink/i.test(k)) : [];
    const n = statesToSamples(json).filter((x) => x.statorTemp != null).length;
    lines.push(`Historique (1 h) : ${cols.length ? cols.join(', ') : 'aucune colonne stator / onduleur / dissipateur'} · ${n} point(s) avec une température de stator.`);
  } catch (e) { lines.push(`Historique illisible : ${e.message}`); }
  telOut(lines.join('\n'));
}

/** Ajoute DiStatorTempR à la configuration existante (sans retirer d'autres champs), après confirmation. */
async function telEnable() {
  const ctx = telContext();
  if (!ctx) return;
  const { c, vin } = ctx;
  if (!window.confirm(`Ajouter ${DRIVE_FIELDS.join(', ')} (1 point / min) à la télémétrie de l’auto ?\nLes autres champs et réglages ne sont pas modifiés.`)) return;
  telOut('Lecture de la configuration actuelle…');
  try {
    const cfg = await c.telemetryConfig(vin);
    const have = configuredFields(cfg);
    if (DRIVE_FIELDS.every((fld) => have.includes(fld))) { telOut(`${DRIVE_FIELDS.join(', ')} : déjà configurés. Rien envoyé.`); return; }
    const body = withStatorField(cfg);
    if (!body) {
      telOut(`Configuration actuelle illisible ou vide : rien envoyé, pour ne pas remplacer celle de Tessie.\nStructure reçue : ${shape(cfg, 3)}`);
      return;
    }
    if (configFlags(cfg).limit_reached === true) {
      telOut('Tessie indique limit_reached = true : la limite de télémétrie semble atteinte. Rien envoyé.');
      return;
    }
    const res = await c.setTelemetryConfig(vin, body);
    telOut(`Envoyé : { fields } avec ${Object.keys(body.fields).length} champs (les ${configuredFields(cfg).length} actuels + ${DRIVE_FIELDS.join(', ')}).\nRéponse : ${shape(res, 3)}\n`
      + 'L’auto applique la nouvelle configuration à son prochain réveil. Clique sur « Vérifier » dans quelques minutes.');
  } catch (e) {
    telOut(`Échec : ${e.message}`);
  }
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
