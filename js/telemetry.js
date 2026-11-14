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
 * Corps à envoyer pour AJOUTER les champs du moteur à la configuration existante :
 * seulement { fields } (forme documentée par Tessie), avec TOUS les champs actuels
 * inchangés plus les nouveaux. Le reste de la configuration (serveur, certificat,
 * expiration, identifiants) appartient à Tessie et n'est jamais renvoyé.
 * Retourne null si la configuration actuelle est illisible ou vide (on n'envoie alors
 * rien : envoyer seulement nos champs pourrait remplacer ceux de Tessie).
 */
export function withStatorField(json, fields = DRIVE_FIELDS, interval = STATOR_INTERVAL_S) {
  const h = findFieldsHolder(json);
  if (!h || !Object.keys(h.fields).length) return null;
  const merged = JSON.parse(JSON.stringify(h.fields));
  for (const f of [].concat(fields)) if (!merged[f]) merged[f] = { interval_seconds: interval };
  return { fields: merged };
}

/** Indicateurs d'état de la configuration (booléens et dates seulement, rien de sensible). */
export function configFlags(json) {
  const out = {};
  if (!json || typeof json !== 'object') return out;
  for (const k of ['synced', 'limit_reached', 'key_paired', 'update_available', 'last_signal_at']) {
    if (k in json && (json[k] === null || typeof json[k] !== 'object')) out[k] = json[k];
  }
  return out;
}

const KIND_RE = { stator: /stator/i, inverter: /inverter/i, heatsink: /heatsink/i };

/**
 * Valeur d'un champ du flux : nombre, texte numérique, ou objet typé façon Fleet Telemetry
 * ({ doubleValue: 61.2 }, { stringValue: "61.2" }, …). null si rien de numérique.
 */
export function itemValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const n = itemValue(v[k]);
      if (n != null) return n;
    }
  }
  return null;
}

/**
 * Valeurs dont le nom mentionne le composant (« stator » par défaut), avec leur chemin.
 * Gère les deux formes : propriété nommée ({ DiStatorTempR: 61 }) et paires du flux
 * en direct de Tessie ({ data: [{ key: 'DiStatorTempR', value: … }] }).
 */
export function findStatorValues(obj, kind = 'stator', depth = 6, prefix = '') {
  const re = KIND_RE[kind] || KIND_RE.stator;
  const out = [];
  if (!obj || typeof obj !== 'object' || depth < 0) return out;
  if (typeof obj.key === 'string' && 'value' in obj) {
    if (re.test(obj.key)) {
      const n = itemValue(obj.value);
      if (n != null) out.push({ path: prefix ? `${prefix}.${obj.key}` : obj.key, key: obj.key, value: n });
    }
    return out;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (re.test(k) && v != null && typeof v !== 'object') out.push({ path, key: k, value: v });
    else if (v && typeof v === 'object') out.push(...findStatorValues(v, kind, depth - 1, Array.isArray(obj) ? prefix : path));
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
    const res = { opened: false, messages: 0, keys: new Set(), stator: [], errors: [], status: [], error: null, closeCode: null };
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
      for (const e of streamErrors(data)) res.errors.push(e);
      if (data && typeof data.status === 'string') res.status.push(data.status);
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

/**
 * Connexion permanente au flux en direct de Tessie (mode Direct) : transmet les
 * températures du moteur arrière dès qu'elles arrivent (Profiler de Tessie activé).
 * Se reconnecte seule (5 s, puis jusqu'à 5 min entre deux essais).
 */
export class LiveStream {
  constructor({ vin, token, onPatch, onState, onErrors }) {
    this.vin = vin;
    this.token = token;
    this.onPatch = onPatch;
    this.onErrors = onErrors || (() => {});
    this.onState = onState || (() => {});
    this.delay = 5000;
    this.stopped = true;
    this.ws = null;
    this.timer = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* */ } }
    this.ws = null;
  }

  _connect() {
    if (this.stopped || typeof WebSocket === 'undefined') return;
    let ws;
    try {
      ws = new WebSocket(`wss://streaming.tessie.com/${encodeURIComponent(this.vin)}?access_token=${encodeURIComponent(this.token)}`);
    } catch (e) { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.delay = 5000; this.onState('open'); };
    ws.onclose = () => { this.onState('closed'); this._retry(); };
    ws.onerror = () => { /* onclose suit */ };
    ws.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      const errs = streamErrors(d);
      if (errs.length) this.onErrors(errs);
      const p = streamPatch(d);
      if (p) this.onPatch(p);
    };
  }

  _retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), this.delay);
    this.delay = Math.min(this.delay * 2, 300000);
  }
}

/** Températures du moteur arrière contenues dans un message du flux (null si aucune). */
export function motorFromMessage(d) {
  const m = {
    statorTemp: pickStatorTemp(d),
    inverterTemp: pickStatorTemp(d, 'inverter'),
    heatsinkTemp: pickStatorTemp(d, 'heatsink'),
  };
  if (m.statorTemp == null && m.inverterTemp == null && m.heatsinkTemp == null) return null;
  const t = d && d.createdAt ? Date.parse(d.createdAt) : NaN;
  m.t = Number.isFinite(t) ? t : Date.now();
  return m;
}

/** Applique les dernières températures du moteur à un échantillon (si récentes et absentes). */
export function attachMotor(sample, motor, maxAgeMs = 3 * 60000) {
  if (!sample || !motor || !Number.isFinite(motor.t) || Math.abs(sample.t - motor.t) > maxAgeMs) return sample;
  for (const k of ['statorTemp', 'inverterTemp', 'heatsinkTemp']) {
    if (sample[k] == null && motor[k] != null) sample[k] = motor[k];
  }
  return sample;
}

/** Booléen d'un champ du flux ({ booleanValue: true }, "true", 1…). */
export function itemBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') return v === 'true' ? true : v === 'false' ? false : null;
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const b = itemBool(v[k]);
      if (b != null) return b;
    }
  }
  return null;
}

/**
 * Message de données du flux → mesures au format du dashboard (seulement les champs
 * présents : le flux n'envoie que ce qui a changé). Même convention que normalize() :
 * courant et puissance positifs = énergie qui SORT de la batterie.
 * @returns {{ t:number, patch:object } | null}
 */
export function streamPatch(d) {
  if (!d || !Array.isArray(d.data)) return null;
  const items = {};
  for (const it of d.data) if (it && typeof it.key === 'string') items[it.key] = it.value;
  const n = (k) => (k in items ? itemValue(items[k]) : null);
  const patch = {};
  const set = (k, v) => { if (v != null) patch[k] = v; };
  const tMin = n('ModuleTempMin'), tMax = n('ModuleTempMax');
  set('tempMin', tMin != null && tMin > -40 && tMin < 80 ? tMin : null);
  set('tempMax', tMax != null && tMax > -40 && tMax < 80 ? tMax : null);
  const v = n('PackVoltage');
  set('voltage', v != null && v >= 200 ? v : null);
  const i = n('PackCurrent');
  set('current', i != null ? -i : null);
  set('soc', n('Soc'));
  set('energyKwh', n('EnergyRemaining'));
  const dc = n('DCChargingPower'), ac = n('ACChargingPower');
  if (dc != null || ac != null) patch.chargerPowerKw = Math.max(dc || 0, ac || 0);
  set('outsideTemp', n('OutsideTemp'));
  set('speed', n('VehicleSpeed'));
  if ('BatteryHeaterOn' in items) set('heaterOn', itemBool(items.BatteryHeaterOn));
  const m = motorFromMessage(d);
  if (m) for (const k of ['statorTemp', 'inverterTemp', 'heatsinkTemp']) set(k, m[k]);
  if (!Object.keys(patch).length) return null;
  const t = Date.parse(d.createdAt);
  return { t: Number.isFinite(t) ? t : Date.now(), patch };
}

/** Message d'erreurs du flux → textes lisibles (ex. « unsupported_field (DiStatorTempR) »). */
export function streamErrors(d) {
  if (!d || !Array.isArray(d.errors)) return [];
  return d.errors.map((e) => {
    const field = e && e.tags && e.tags.field_name;
    return `${(e && e.name) || 'erreur'}${field ? ` (${field})` : ''}`;
  });
}

/**
 * Applique un patch du flux aux mesures : nouvelle mesure (valeurs manquantes reprises
 * de la précédente) au plus toutes les `minGapMs`, sinon mise à jour de la dernière.
 * Retourne { sample, added } ; la puissance est recalculée (V × I).
 */
export function applyPatch(samples, p, minGapMs = 10000) {
  const last = samples[samples.length - 1];
  let sample, added = false;
  if (!last || p.t - last.t >= minGapMs) {
    sample = Object.assign({}, last || {}, p.patch, { t: Math.max(p.t, last ? last.t + 1 : p.t), fromStream: true });
    delete sample.fromHistory;
    samples.push(sample);
    added = true;
  } else {
    sample = last;
    Object.assign(sample, p.patch);
  }
  if (sample.voltage != null && sample.current != null) sample.powerKw = (sample.voltage * sample.current) / 1000;
  return { sample, added };
}
