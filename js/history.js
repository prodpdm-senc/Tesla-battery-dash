import { pickStatorTemp } from './telemetry.js?v=17';

// Analyse de l'historique Tessie (/{vin}/states). Module pur, testé.
// La forme exacte de la réponse n'est pas documentée publiquement : on cherche
// le tableau d'états et les champs utiles où qu'ils soient dans chaque objet.

/** Champs recherchés : nom affiché → clés possibles dans un état Tessie. */
export const WANTED = {
  'Horodatage': ['timestamp', 'created_at', 'date'],
  'Temp. module min': ['module_temp_min'],
  'Temp. module max': ['module_temp_max'],
  'Tension pack': ['pack_voltage'],
  'Courant pack': ['pack_current'],
  'Charge (%)': ['battery_level', 'usable_battery_level'],
  'Énergie restante': ['energy_remaining'],
  'Puissance chargeur': ['charger_power'],
  'État de recharge': ['charging_state'],
  'Chauffage batterie': ['battery_heater_on', 'battery_heater'],
  'Préconditionnement': ['is_preconditioning', 'preconditioning_enabled'],
  'Temp. extérieure': ['outside_temp'],
  'Superchargeur': ['fast_charger_present'],
};

/** Trouve le tableau d'états dans la réponse, peu importe l'enveloppe. */
/** « battery_levels » → « battery_level », « ids » → « id ». */
export function singular(k) {
  if (/ies$/.test(k)) return k.slice(0, -3) + 'y';
  if (/s$/.test(k) && !/ss$/.test(k)) return k.slice(0, -1);
  return k;
}

/**
 * Format en colonnes de Tessie : { timestamps: [...], battery_levels: [...], ... }
 * (un tableau par mesure, tous de même longueur) → liste de points
 * { timestamp, battery_level, ... }. Retourne null si l'objet n'a pas cette forme.
 */
export function columnarToRecords(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const arrays = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
  if (arrays.length < 2) return null;
  const n = Math.max(...arrays.map((k) => obj[k].length));
  const cols = arrays.filter((k) => obj[k].length === n);
  // Des tableaux d'objets sont des listes de points, pas des colonnes.
  if (!n || cols.length < 2 || cols.some((k) => obj[k][0] !== null && typeof obj[k][0] === 'object')) return null;
  const recs = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {};
    for (const k of cols) r[singular(k)] = obj[k][i];
    recs[i] = r;
  }
  return recs;
}

export function findRecords(json, depth = 3) {
  if (Array.isArray(json)) return json.length && json[0] !== null && typeof json[0] === 'object' ? json : [];
  if (!json || typeof json !== 'object' || depth < 0) return [];
  const cols = columnarToRecords(json);
  if (cols) return cols;
  for (const k of ['results', 'states', 'data', 'items']) {
    const v = json[k];
    if (Array.isArray(v) && v.length && v[0] !== null && typeof v[0] === 'object') return v;
  }
  // Repli : la plus longue liste de points, cherchée aussi dans les sous-objets
  // (ex. { results: { states: [...] } } ou { results: { timestamps: [...], ... } }).
  let best = [];
  for (const k of Object.keys(json)) {
    const v = json[k];
    // Tableau : retenu seulement si c'est une liste d'objets (pas une colonne de valeurs).
    const cand = findRecords(v, depth - 1);
    if (cand.length > best.length) best = cand;
  }
  return best;
}

/**
 * Structure de la réponse, sans aucune valeur (pas de position ni de donnée perso) :
 * types, clés et longueurs des tableaux. Ex. {results: [0]} ou {results: {states: [42 × {timestamp, …}]}}.
 */
export function shape(v, depth = 3) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[0]';
    return `[${v.length} × ${shape(v[0], depth)}]`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth <= 0) return `{${keys.length} clés}`;
    const shown = keys.slice(0, 12).map((k) => {
      const x = v[k];
      const inner = x && typeof x === 'object' ? `: ${shape(x, depth - 1)}` : '';
      return k + inner;
    });
    return `{${shown.join(', ')}${keys.length > 12 ? `, … +${keys.length - 12}` : ''}}`;
  }
  return typeof v;
}

/** Cherche une clé dans un objet (et ses sous-objets, 3 niveaux). Retourne { path, value }. */
export function findKey(obj, keys, depth = 3, prefix = '') {
  if (!obj || typeof obj !== 'object' || depth < 0) return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return { path: prefix + k, value: obj[k] };
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = findKey(v, keys, depth - 1, `${prefix}${k}.`);
      if (r) return r;
    }
  }
  return null;
}

function toMs(v) {
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Résumé lisible de la réponse : nombre de points, période, intervalle,
 * présence (et taux de remplissage) de chaque champ voulu.
 */
export function summarize(json) {
  const recs = findRecords(json);
  const out = {
    envelope: Array.isArray(json) ? '[tableau]' : Object.keys(json || {}).join(', '),
    shape: shape(json, 4),
    count: recs.length,
    firstKeys: recs[0] && typeof recs[0] === 'object' ? Object.keys(recs[0]) : [],
    start: null, end: null, medianIntervalS: null, minIntervalS: null,
    fields: [],
  };
  const times = [];
  for (const r of recs) {
    const f = findKey(r, WANTED['Horodatage']);
    const t = f ? toMs(f.value) : null;
    if (t != null) times.push(t);
  }
  times.sort((a, b) => a - b);
  if (times.length) {
    out.start = times[0];
    out.end = times[times.length - 1];
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
    out.medianIntervalS = median(gaps);
    out.minIntervalS = gaps.length ? Math.min(...gaps) : null;
  }
  for (const name of Object.keys(WANTED)) {
    let path = null, n = 0, sample;
    for (const r of recs) {
      const f = findKey(r, WANTED[name]);
      if (f) { n++; if (!path) { path = f.path; sample = f.value; } }
    }
    out.fields.push({ name, path, filled: recs.length ? n / recs.length : 0, sample });
  }
  return out;
}

/** Rapport texte à copier-coller. */
export function formatReport(sum, opts = {}) {
  const { requested } = opts;
  const d = (t) => (t == null ? '—' : new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  const lines = [
    `RAPPORT HISTORIQUE TESSIE${opts && opts.version ? ` (version ${opts.version})` : ''}`,
    requested ? `Demandé : ${requested}` : null,
    `Enveloppe : ${sum.envelope || '—'}`,
    `Structure : ${sum.shape || '—'}`,
    `Points : ${sum.count}`,
    `Période : ${d(sum.start)} → ${d(sum.end)}`,
    `Intervalle médian : ${sum.medianIntervalS == null ? '—' : sum.medianIntervalS.toFixed(0) + ' s'}`
      + ` (min ${sum.minIntervalS == null ? '—' : sum.minIntervalS.toFixed(0) + ' s'})`,
    '',
    'Champs :',
    ...sum.fields.map((f) => `  ${f.path ? '✓' : '✗'} ${f.name}`
      + (f.path ? ` — ${f.path} — ${(f.filled * 100).toFixed(0)} % des points — ex. ${JSON.stringify(f.sample)}` : '')),
    '',
    `Colonnes / clés (${sum.firstKeys.length}) : ${sum.firstKeys.join(', ') || '—'}`,
  ];
  return lines.filter((l) => l != null).join('\n');
}

// ───────────── Historique → échantillons (même forme que les mesures en direct) ─────────────

function numOrNull(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function boolOrNull(v) {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === 1) return v === 1;
  return null;
}
/** Température plausible d'un module, sinon null (lectures absurdes pendant le sommeil). */
function tempOrNull(v) {
  const n = numOrNull(v);
  return n != null && n > -40 && n < 80 ? n : null;
}

/**
 * Réponse de /{vin}/states (format en colonnes ou liste) → échantillons triés par temps,
 * avec la même convention que le direct (normalize dans tessie.js) :
 * courant et puissance positifs = énergie qui SORT de la batterie.
 * Une tension sous 200 V (ex. 4,68 V observé, auto endormie) est écartée.
 */
export function statesToSamples(json) {
  const out = [];
  for (const r of findRecords(json)) {
    const t = toMs(r.timestamp);
    if (t == null) continue;
    const v = numOrNull(r.pack_voltage);
    const voltage = v != null && v >= 200 ? v : null;
    const raw = numOrNull(r.pack_current);
    const current = voltage != null && raw != null ? -raw : null;
    out.push({
      t,
      tempMin: tempOrNull(r.module_temp_min),
      tempMax: tempOrNull(r.module_temp_max),
      voltage,
      current,
      powerKw: voltage != null && current != null ? (voltage * current) / 1000 : null,
      soc: numOrNull(r.battery_level),
      energyKwh: numOrNull(r.energy_remaining),
      chargerPowerKw: numOrNull(r.charger_power),
      chargerVoltage: numOrNull(r.charger_voltage),
      chargerCurrent: numOrNull(r.charger_actual_current),
      chargeEnergyAdded: numOrNull(r.charge_energy_added),
      chargingState: r.charging_state || null,
      heaterOn: boolOrNull(r.battery_heater_on),
      climateOn: boolOrNull(r.is_climate_on),
      outsideTemp: numOrNull(r.outside_temp),
      speed: numOrNull(r.speed),
      shiftState: r.shift_state || null,
      vehicleState: r.state || null,
      statorTemp: pickStatorTemp(r),
      inverterTemp: pickStatorTemp(r, 'inverter'),
      heatsinkTemp: pickStatorTemp(r, 'heatsink'),
      fromHistory: true,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Fusionne l'historique Tessie avec les échantillons locaux (direct).
 * Un point local garde la priorité s'il tombe à moins de `tolMs` d'un point Tessie.
 */
export function mergeSamples(local, remote, tolMs = 5000) {
  const all = local.map((s) => ({ s, local: true })).concat(remote.map((s) => ({ s, local: false })));
  all.sort((a, b) => a.s.t - b.s.t || (a.local ? -1 : 1));
  const out = [];
  for (const { s, local } of all) {
    const prev = out[out.length - 1];
    if (prev && s.t - prev.s.t < tolMs) {
      if (local && !prev.local) out[out.length - 1] = { s, local };
      continue;
    }
    out.push({ s, local });
  }
  return out.map((x) => x.s);
}
