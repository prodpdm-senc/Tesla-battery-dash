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
export function formatReport(sum, { requested } = {}) {
  const d = (t) => (t == null ? '—' : new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  const lines = [
    'RAPPORT HISTORIQUE TESSIE',
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
