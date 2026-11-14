// Température du stator (moteur) via Fleet Telemetry de Tesla, à travers Tessie.
// Sur une Model 3 LFP à propulsion, la batterie est surtout chauffée par le moteur arrière
// (fonctionnement volontairement inefficace qui chauffe le glycol) : DiStatorTempR.
// Module pur (sauf streamProbe), testé.

export const STATOR_FIELD = 'DiStatorTempR';
export const STATOR_INTERVAL_S = 60; // minimum permis par Tesla pour ces champs
/** Unité d'entraînement arrière : stator, onduleur, dissipateur (champs Fleet Telemetry). */
export const DRIVE_FIELDS = ['DiStatorTempR', 'DiInverterTR', 'DiHeatsinkTR'];

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Cherche, en profondeur, l'objet qui porte une clé « fields » (configuration de télémétrie). */
export function findFieldsHolder(json, depth = 5) {
  if (!json || typeof json !== 'object' || depth < 0) return null;
  if (json.fields && typeof json.fields === 'object' && !Array.isArray(json.fields)) return json;
  for (const k of Object.keys(json)) {
    const r = findFieldsHolder(json[k], depth - 1);
    if (r) return r;
  }
  return null;
}

/** Noms des champs configurés. */
export function configuredFields(json) {
  const h = findFieldsHolder(json);
  return h ? Object.keys(h.fields) : [];
}

/**
 * Corps à envoyer pour AJOUTER le champ du stator à la configuration existante,
 * sans retirer ni modifier les autres champs ni réglages.
 * Retourne null si la configuration actuelle est illisible (on n'envoie alors rien :
 * envoyer seulement notre champ pourrait remplacer la configuration de Tessie).
 */
export function withStatorField(json, fields = DRIVE_FIELDS, interval = STATOR_INTERVAL_S) {
  const h = findFieldsHolder(json);
  if (!h || !Object.keys(h.fields).length) return null;
  const body = JSON.parse(JSON.stringify(h));
  for (const f of [].concat(fields)) if (!body.fields[f]) body.fields[f] = { interval_seconds: interval };
  return body;
}

const KIND_RE = { stator: /stator/i, inverter: /inverter/i, heatsink: /heatsink/i };

/** Valeurs dont la clé mentionne le composant (« stator » par défaut), avec leur chemin. */
export function findStatorValues(obj, kind = 'stator', depth = 6, prefix = '') {
  const re = KIND_RE[kind] || KIND_RE.stator;
  const out = [];
  if (!obj || typeof obj !== 'object' || depth < 0) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (re.test(k) && v != null && typeof v !== 'object') out.push({ path, key: k, value: v });
    else if (v && typeof v === 'object') out.push(...findStatorValues(v, kind, depth - 1, path));
  }
  return out;
}

/** Toutes les valeurs de l'unité d'entraînement (stator, onduleur, dissipateur). */
export function findDriveValues(obj) {
  return ['stator', 'inverter', 'heatsink'].flatMap((k) => findStatorValues(obj, k));
}

/**
 * Température du stator ARRIÈRE (°C) dans un objet quelconque (état Tessie, point
 * d'historique, message du flux). Préfère une clé qui désigne l'arrière (…TempR, rear).
 */
export function pickStatorTemp(obj, kind = 'stator') {
  const vals = findStatorValues(obj, kind)
    .map((x) => ({ ...x, n: Number(x.value) }))
    .filter((x) => Number.isFinite(x.n) && x.n > -40 && x.n < 200);
  if (!vals.length) return null;
  // Arrière : clé finissant par « R » (DiStatorTempR, DiInverterTR, di_heatsink_t_r), pas REL / RER.
  const rear = vals.find((x) => /(tempr|tr|rear)$/.test(norm(x.key)) && !/r(el|er)$/.test(norm(x.key)));
  return (rear || vals[0]).n;
}

/**
 * Écoute le flux en direct de Tessie pendant `ms` et rapporte ce qui arrive.
 * L'authentification du flux depuis un navigateur n'est pas documentée publiquement :
 * on passe le token en paramètre d'adresse (access_token), le seul moyen possible
 * avec un WebSocket de navigateur.
 */
export function streamProbe({ vin, token, ms = 60000, onTick }) {
  return new Promise((resolve) => {
    const res = { opened: false, messages: 0, keys: new Set(), stator: [], error: null, closeCode: null };
    let ws;
    const done = () => {
      clearTimeout(timer);
      try { ws && ws.close(); } catch (e) { /* */ }
      resolve({ ...res, keys: Array.from(res.keys).sort() });
    };
    const timer = setTimeout(done, ms);
    try {
      ws = new WebSocket(`wss://streaming.tessie.com/${encodeURIComponent(vin)}?access_token=${encodeURIComponent(token)}`);
    } catch (e) { res.error = e.message; done(); return; }
    ws.onopen = () => { res.opened = true; if (onTick) onTick(res); };
    ws.onerror = () => { res.error = res.error || 'erreur WebSocket'; };
    ws.onclose = (e) => { res.closeCode = e.code; done(); };
    ws.onmessage = (e) => {
      res.messages++;
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      collectKeys(data, res.keys);
      for (const s of findDriveValues(data)) res.stator.push(`${s.path} = ${s.value}`);
      if (onTick) onTick(res);
    };
  });
}

function collectKeys(obj, set, depth = 4, prefix = '') {
  if (!obj || typeof obj !== 'object' || depth < 0) return;
  for (const k of Object.keys(obj)) {
    // Les tableaux de données (ex. data: [{key, value}]) : on retient aussi les noms de champs.
    const v = obj[k];
    if (Array.isArray(v)) {
      for (const it of v.slice(0, 50)) {
        if (it && typeof it === 'object' && typeof it.key === 'string') set.add(`${prefix}${k}[].${it.key}`);
        else collectKeys(it, set, depth - 1, `${prefix}${k}[].`);
      }
    } else if (v && typeof v === 'object') collectKeys(v, set, depth - 1, `${prefix}${k}.`);
    else set.add(prefix + k);
  }
}
