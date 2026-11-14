import { TessieClient, ApiError } from './tessie.js';
import { Simulator } from './simulator.js';
import { estimate, pickTemp, formatDuration } from './estimator.js';
import { settings as settingsStore, history, observations, appendSample } from './store.js';
import { createCharts } from './charts.js';

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
};
const DEMO_INTERVAL_S = 5;
const STALE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

const $ = (id) => document.getElementById(id);
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
};

let charts;

// ───────────────────────── Démarrage ─────────────────────────

function init() {
  charts = createCharts({ tempEl: $('chartTemp'), powerEl: $('chartPower') });
  buildTiles();
  bindUi();
  syncRangeButtons();
  if (state.s.demo) startDemo();
  else startLive();
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
}

function stop() {
  clearTimeout(state.timer);
  state.timer = null;
  state.gen++;
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
  const added = appendSample(state.samples, sample);
  if (added) {
    detectHeaterCutoff(prev, sample);
    if (!state.sim) history.save(state.s.vin, state.samples);
  }
  render();
}

/** Le chauffage passe de ON à OFF → on note la température : indice de la cible du BMS. */
function detectHeaterCutoff(prev, cur) {
  if (!prev || prev.heaterOn !== true || cur.heaterOn !== false) return;
  const obs = { t: cur.t, tempMin: prev.tempMin, tempMax: prev.tempMax };
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
  renderTiles(last);
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
  return { min: 'module min', avg: 'moyenne', max: 'module max' }[state.s.metric] ?? 'module min';
}

const TILES = [
  { id: 'voltage', label: 'Tension pack', unit: 'V', get: (s) => fmt(s.voltage, 1) },
  { id: 'current', label: 'Courant pack', unit: 'A', get: (s) => fmt(s.current, 1) },
  { id: 'power', label: 'Puissance pack', unit: 'kW', get: (s) => fmt(s.powerKw, 1), sub: () => '+ = vers la batterie' },
  { id: 'soc', label: 'Charge', unit: '%', get: (s) => fmt(s.soc, 0),
    sub: (s) => [s.energyKwh != null ? `${fmt(s.energyKwh)} kWh` : null, s.chargeLimit != null ? `limite ${s.chargeLimit} %` : null].filter(Boolean).join(' · ') },
  { id: 'charger', label: 'Chargeur', unit: 'kW', get: (s) => fmt(s.chargerPowerKw, 0),
    sub: (s) => `${fmt(s.chargerVoltage, 0)} V · ${fmt(s.chargerCurrent, 0)} A` },
  { id: 'chgState', label: 'Recharge', get: (s) => chargingLabel(s), sub: (s) => (s.fastCharger ? `DC rapide${s.fastChargerType ? ` · ${s.fastChargerType}` : ''}` : '') },
  { id: 'heater', label: 'Chauffage batterie', pill: (s) => s.heaterOn },
  { id: 'precond', label: 'Préconditionnement', pill: (s) => s.preconditioning },
  { id: 'outside', label: 'Extérieur', unit: '°C', get: (s) => fmt(s.outsideTemp, 1) },
];

function chargingLabel(s) {
  const map = { Charging: 'En charge', Complete: 'Terminée', Stopped: 'Arrêtée', Disconnected: 'Débranchée', Starting: 'Démarrage', NoPower: 'Sans courant' };
  return map[s.chargingState] ?? s.chargingState ?? '—';
}

function buildTiles() {
  $('tiles').innerHTML = TILES.map((t) => `
    <div class="tile">
      <div class="label">${t.label}</div>
      <div class="tile-value" id="tile-${t.id}">—${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="tile-sub" id="tile-${t.id}-sub"></div>
    </div>`).join('');
}

function renderTiles(s) {
  for (const t of TILES) {
    const el = $(`tile-${t.id}`), sub = $(`tile-${t.id}-sub`);
    if (!s) { el.textContent = '—'; sub.textContent = ''; continue; }
    if (t.pill) {
      const on = t.pill(s);
      el.innerHTML = `<span class="pill" data-on="${on === true}">${on == null ? '—' : on ? 'Actif' : 'Inactif'}</span>`;
    } else {
      el.innerHTML = `${t.get(s)}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}`;
    }
    sub.textContent = t.sub ? t.sub(s) : '';
  }
}

function renderCharts(est, last) {
  const rangeMs = state.s.rangeMin * 60_000;
  const now = Math.max(Date.now(), last?.t ?? 0);
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
  charts.power.update(state.samples, domain, { yInclude: [0] });
}

function renderObs() {
  $('obsCard').hidden = !state.obs.length;
  $('obsList').innerHTML = [...state.obs].reverse().slice(0, 8).map((o, i) => `
    <li><span>${new Date(o.t).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })}</span>
    <span>min ${fmt(o.tempMin)} °C · max ${fmt(o.tempMax)} °C</span>
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
  $('btnDemo').addEventListener('click', () => {
    state.s.demo = !state.sim;
    settingsStore.save(state.s);
    state.errors = 0;
    if (state.s.demo) startDemo(); else startLive();
  });
  $('rangeSeg').addEventListener('click', (e) => {
    const m = e.target.closest('button')?.dataset.min;
    if (!m) return;
    state.s.rangeMin = +m;
    settingsStore.save(state.s);
    syncRangeButtons();
    render();
  });
  $('obsList').addEventListener('click', (e) => {
    const i = e.target.closest('button')?.dataset.obs;
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
  $('vinList').addEventListener('change', (e) => { form.elements.vin.value = e.target.value; });
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
  f.token.value = state.s.token ?? '';
  f.rememberToken.checked = !!state.s.rememberToken;
  f.vin.value = state.s.vin ?? '';
  f.target.value = state.s.target;
  f.interval.value = state.s.interval;
  f.metric.value = state.s.metric;
  f.windowMin.value = state.s.windowMin;
  f.baseUrl.value = state.s.baseUrl;
  $('vinList').hidden = true;
  formMsg(message ?? '', message ? 'error' : null);
  if (!$('settings').open) $('settings').showModal();
  if (focus) f[focus].focus();
}

function saveSettings(fd) {
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const prevVin = state.s.vin, prevToken = state.s.token, prevBase = state.s.baseUrl;
  Object.assign(state.s, {
    token: String(fd.get('token') ?? '').trim(),
    rememberToken: fd.get('rememberToken') === 'on',
    vin: String(fd.get('vin') ?? '').trim().toUpperCase(),
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

async function findVins() {
  const f = $('settingsForm').elements;
  const token = f.token.value.trim();
  if (!token) { formMsg('Entre d’abord ton token.', 'error'); return; }
  formMsg('Recherche…');
  try {
    const c = new TessieClient({ token, baseUrl: f.baseUrl.value.trim() || DEFAULTS.baseUrl });
    const res = await c.vehicles();
    const list = (res?.results ?? []).map((v) => ({
      vin: v.vin,
      name: v.last_state?.vehicle_state?.vehicle_name || v.last_state?.display_name || v.vin,
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
