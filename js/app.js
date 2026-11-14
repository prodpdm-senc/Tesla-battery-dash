import { TessieClient, ApiError } from './tessie.js';
import { Simulator } from './simulator.js';
import { estimate, pickTemp, formatDuration } from './estimator.js';
import { settings as settingsStore, history, observations, appendSample } from './store.js';
import { createCharts } from './charts.js';
import { Gauges } from './gauges.js';

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
};

let charts;

// ───────────────────────── Démarrage ─────────────────────────

const IS_CAR = document.documentElement.classList.contains('car');

function init() {
  window.__appStarted = true;
  importSetupFromHash();
  charts = createCharts({ tempEl: $('chartTemp'), powerEl: $('chartPower') });
  buildGauges();
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

/**
 * Lien de configuration : #setup=<base64 JSON {token, vin}>.
 * Le fragment (#) n'est jamais envoyé au serveur ; on l'efface tout de suite de l'URL.
 */
function importSetupFromHash() {
  const m = /[#&]setup=([^&]+)/.exec(location.hash);
  if (!m) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
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
  { id: 'current', label: 'Courant', unit: 'A', min: -500, max: 500, signed: true, get: (s) => s.current },
  { id: 'power', label: 'Puissance', unit: 'kW', min: -200, max: 200, decimals: 1, signed: true, get: (s) => s.powerKw,
    sub: () => '+ charge' },
  { id: 'soc', label: 'Charge', unit: '%', min: 0, max: 100, get: (s) => s.soc, marker: (s) => s.chargeLimit,
    sub: (s) => (s.energyKwh != null ? `${fmt(s.energyKwh)} kWh` : '') },
  { id: 'charger', label: 'Chargeur', unit: 'kW', min: 0, max: 250, get: (s) => s.chargerPowerKw,
    sub: (s) => (s.chargerVoltage || s.chargerCurrent ? `${fmt(s.chargerVoltage, 0)} V · ${fmt(s.chargerCurrent, 0)} A` : '') },
  { id: 'outside', label: 'Extérieur', unit: '°C', min: -30, max: 40, decimals: 1, signed: true, get: (s) => s.outsideTemp },
];

const CHIPS = [
  { id: 'chgState', label: 'Recharge', text: (s) => chargingLabel(s) + (s.fastCharger ? ' · DC' : ''),
    on: (s) => s.chargingState === 'Charging' },
  { id: 'heater', label: 'Chauffage', on: (s) => s.heaterOn },
  { id: 'precond', label: 'Précond.', on: (s) => s.preconditioning },
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
  $('uaInfo').textContent = `Navigateur : ${navigator.userAgent}`;
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
