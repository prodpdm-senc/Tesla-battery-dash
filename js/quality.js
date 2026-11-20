// Qualité et fraîcheur des données. Module pur (aucun DOM), testé.
//  - cleanSample : écarte les valeurs physiquement impossibles avant qu'elles faussent l'ETA.
//  - splitAtGaps / gapZones : coupe les courbes aux trous de données (pas de fausse pente).
//  - FieldClock : âge de chaque valeur (les mesures sont reprises d'un point à l'autre).
//  - intervals : périodes où une condition est vraie.
//  - heatingZones : périodes de chauffe de la batterie (ombrage bleu des graphiques).
//  - streamSilent : flux « ouvert » qui ne transmet plus rien alors que l'auto est active.
//  - heatingPowerKw : puissance consommée par la chauffe, auto stationnée.
//  - sunTimes / isNight : thème sombre selon le coucher du soleil.

import { detectHeatingSessions } from './sessions.js?v=21';

const MIN = 60000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Plages plausibles (pack LFP d'une Model 3).
const RANGES = {
  tempMin: [-40, 80], tempMax: [-40, 80],
  voltage: [200, 500],
  current: [-1500, 1500],
  soc: [0, 100],
  outsideTemp: [-50, 60],
  statorTemp: [-40, 200], heatsinkTemp: [-40, 150],
};
// Variation maximale crédible d'une température de module : 2 °C/min (la chauffe la
// plus rapide observée est ~1 °C/min), avec un minimum de 3 °C pour la quantification.
const TEMP_RATE = 2;
const TEMP_MIN_JUMP = 3;

/**
 * Retire (met à null) les valeurs hors plage ou les sauts de température impossibles
 * par rapport à la mesure précédente. Retourne { sample, rejected: [clés] }.
 * `trust` : clés dont le saut est accepté quand même (déjà écartées plusieurs fois de
 * suite : c'est alors la valeur précédente qui était fausse, ou un vrai changement).
 * L'échantillon d'origine n'est pas modifié.
 */
export function cleanSample(prev, s, { trust = [] } = {}) {
  const out = Object.assign({}, s);
  const rejected = [];
  for (const k of Object.keys(RANGES)) {
    const v = out[k];
    if (v == null) continue;
    if (!finite(v) || v < RANGES[k][0] || v > RANGES[k][1]) { out[k] = null; rejected.push(k); }
  }
  if (prev && finite(prev.t) && finite(out.t)) {
    const dtMin = Math.abs(out.t - prev.t) / MIN;
    if (dtMin <= 10) {
      const maxJump = Math.max(TEMP_MIN_JUMP, TEMP_RATE * dtMin);
      for (const k of ['tempMin', 'tempMax']) {
        if (trust.indexOf(k) < 0 && finite(out[k]) && finite(prev[k]) && Math.abs(out[k] - prev[k]) > maxJump) { out[k] = null; rejected.push(k); }
      }
    }
  }
  // Min au-dessus du max : incohérent, on garde la paire seulement si elle est ordonnée.
  if (finite(out.tempMin) && finite(out.tempMax) && out.tempMin > out.tempMax + 0.5) {
    out.tempMin = null; out.tempMax = null; rejected.push('tempMin', 'tempMax');
  }
  if (rejected.indexOf('voltage') >= 0 || rejected.indexOf('current') >= 0) {
    out.powerKw = finite(out.voltage) && finite(out.current) ? (out.voltage * out.current) / 1000 : null;
  }
  return { sample: out, rejected };
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Trou maximal toléré : 5 min, ou 4 fois l'espacement habituel des points. */
export function gapThreshold(points, minMs = 5 * MIN) {
  const d = [];
  for (let i = 1; i < points.length; i++) d.push(points[i].t - points[i - 1].t);
  return Math.max(minMs, 4 * (median(d) || 0));
}

/** Coupe une suite de points (triés par t) en segments séparés par des trous > maxGapMs. */
export function splitAtGaps(points, maxGapMs) {
  const out = [];
  let cur = null;
  for (let i = 0; i < points.length; i++) {
    if (!cur || points[i].t - points[i - 1].t > maxGapMs) { cur = []; out.push(cur); }
    cur.push(points[i]);
  }
  return out;
}

/** Zones sans données (trous > maxGapMs) : [{ t0, t1 }]. */
export function gapZones(points, maxGapMs) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > maxGapMs) out.push({ t0: points[i - 1].t, t1: points[i].t });
  }
  return out;
}

/** Périodes où pred(point) est vrai : [{ t0, t1 }] (coupées aux trous > maxGapMs). */
export function intervals(points, pred, maxGapMs = 5 * MIN) {
  const out = [];
  let cur = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const on = !!pred(p);
    if (cur) {
      if (p.t - points[i - 1].t > maxGapMs) cur = null; // trou : la période s'arrête au point précédent
      else { cur.t1 = p.t; if (!on) cur = null; }       // dure jusqu'au point qui la termine
    }
    if (on && !cur) { cur = { t0: p.t, t1: p.t }; out.push(cur); }
  }
  return out.filter((z) => z.t1 > z.t0);
}

/** Fusionne des périodes qui se chevauchent (ou séparées de moins de `joinMs`). */
export function mergeIntervals(list, joinMs = 60000) {
  const sorted = list.filter((z) => z && z.t1 >= z.t0).slice().sort((a, b) => a.t0 - b.t0);
  const out = [];
  for (const z of sorted) {
    const last = out[out.length - 1];
    if (last && z.t0 - last.t1 <= joinMs) last.t1 = Math.max(last.t1, z.t1);
    else out.push({ t0: z.t0, t1: z.t1 });
  }
  return out;
}

const isMoving = (s) => s.shiftState === 'D' || s.shiftState === 'R' || (finite(s.speed) && s.speed > 0);

/**
 * Périodes de chauffe de la batterie (et non de préconditionnement : la cabine peut se
 * préconditionner sans que la batterie chauffe, et la chauffe s'arrête avant la fin du
 * préconditionnement). Réunion de trois indices :
 *  - le drapeau du chauffage (toujours faux sur certaines Model 3 LFP, mais utile ailleurs) ;
 *  - auto stationnée en préconditionnement qui tire au moins `minKw` de la batterie
 *    (le moteur arrière chauffe ; la cabine seule tire ~1 kW) ;
 *  - montée de la température du module le plus froid d'au moins 0,25 °C/min hors
 *    recharge (détection de la page Sessions) : couvre aussi la chauffe en roulant.
 */
export function heatingZones(points, { minKw = 3 } = {}) {
  if (points.length < 2) return [];
  const gap = gapThreshold(points);
  const parked = intervals(points, (s) => s.heaterOn === true
    || (s.preconditioning === true && !isMoving(s) && s.chargingState !== 'Charging' && finite(s.powerKw) && s.powerKw >= minKw), gap);
  const rising = detectHeatingSessions(points).map((h) => ({ t0: h.t0, t1: h.t1 }));
  return mergeIntervals(parked.concat(rising));
}

/**
 * Horodatage de la dernière valeur reçue pour chaque champ. Les mesures sont reprises
 * d'un point à l'autre (le flux n'envoie que ce qui change) : sans cela, une jauge peut
 * afficher une valeur vieille de 10 minutes sans le dire.
 */
export class FieldClock {
  constructor() { this.at = {}; }
  /** Note les champs non nuls de `obj`, reçus à l'instant t (on garde le plus récent). */
  note(obj, t) {
    if (!obj || !finite(t)) return;
    for (const k of Object.keys(obj)) {
      if (k === 't' || obj[k] == null) continue;
      if (!(this.at[k] >= t)) this.at[k] = t;
    }
  }
  /** Âge (ms) du plus vieux des champs demandés ; null si l'un d'eux n'a jamais été reçu. */
  age(keys, now = Date.now()) {
    let oldest = Infinity;
    for (const k of keys) {
      if (!finite(this.at[k])) return null;
      oldest = Math.min(oldest, this.at[k]);
    }
    return keys.length ? Math.max(0, now - oldest) : null;
  }
  reset() { this.at = {}; }
}

/** « à l'instant », « il y a 4 min », « il y a 2 h ». */
export function formatAge(ms) {
  if (ms == null || !finite(ms)) return '';
  if (ms < MIN) return 'à l’instant';
  const m = Math.round(ms / MIN);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
}

/** L'auto fait quelque chose qui devrait faire bouger les mesures (roule, chauffe, recharge). */
export function isActive(s) {
  if (!s) return false;
  return s.shiftState === 'D' || s.shiftState === 'R' || (finite(s.speed) && s.speed > 0)
    || s.preconditioning === true || s.heaterOn === true || s.chargingState === 'Charging';
}

/**
 * Flux ouvert mais muet : l'auto est active et rien n'est arrivé depuis `silentMs`
 * (à compter du dernier message, ou de l'ouverture s'il n'y en a pas eu).
 */
export function streamSilent({ open, openAt, lastMsgAt, now, active, silentMs = 3 * MIN }) {
  if (!open || !active) return false;
  const since = Math.max(finite(openAt) ? openAt : 0, finite(lastMsgAt) ? lastMsgAt : 0);
  return since > 0 && now - since > silentMs;
}

/**
 * Puissance de chauffe estimée (kW) : puissance qui sort de la batterie pendant un
 * préconditionnement à l'arrêt, moins la consommation de base de l'auto stationnée
 * (médiane des 30 min précédentes hors préconditionnement, sinon 0,4 kW).
 * Inclut la climatisation de l'habitacle, qui tourne aussi pendant le préconditionnement.
 * @returns {{ kw:number, baseKw:number } | null}
 */
export function heatingPowerKw(samples, { baseDefault = 0.4, lookbackMs = 30 * MIN } = {}) {
  const last = samples[samples.length - 1];
  if (!last || !last.preconditioning || !finite(last.powerKw) || last.chargingState === 'Charging') return null;
  const moving = (s) => s.shiftState === 'D' || s.shiftState === 'R' || (finite(s.speed) && s.speed > 0);
  if (moving(last)) return null;
  const base = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (last.t - s.t > lookbackMs) break;
    if (!s.preconditioning && !moving(s) && s.chargingState !== 'Charging' && finite(s.powerKw) && s.powerKw >= 0 && s.powerKw < 3) base.push(s.powerKw);
  }
  const baseKw = base.length >= 3 ? median(base) : baseDefault;
  return { kw: Math.max(0, last.powerKw - baseKw), baseKw };
}

// ── Lever / coucher du soleil (algorithme de la NOAA, précision ~ quelques minutes) ──
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Lever et coucher du soleil (ms) pour la date de `t` à (lat, lon) ; null en jour/nuit polaire. */
export function sunTimes(t, lat, lon) {
  if (!finite(lat) || !finite(lon)) return null;
  const date = new Date(t);
  const day0 = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const n = Math.floor((day0 - Date.UTC(2000, 0, 1, 12)) / 86400000) + 1;
  const Jstar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const L = (M + C + 180 + 102.9372) % 360;
  const Jtransit = Jstar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * L));
  const dec = Math.asin(Math.sin(rad(L)) * Math.sin(rad(23.44)));
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(dec)) / (Math.cos(rad(lat)) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null;
  const H = deg(Math.acos(cosH)) / 360;
  const toMs = (j) => Date.UTC(2000, 0, 1, 12) + j * 86400000;
  return { rise: toMs(Jtransit - H), set: toMs(Jtransit + H) };
}

/** Nuit à l'instant t : selon le soleil si la position est connue, sinon entre 19 h et 7 h (heure locale). */
export function isNight(t, lat, lon) {
  if (finite(lat) && finite(lon)) {
    // Jours voisins aussi : la date UTC ne correspond pas toujours à la journée locale.
    let known = false;
    for (const d of [-1, 0, 1]) {
      const s = sunTimes(t + d * 86400000, lat, lon);
      if (!s) continue;
      known = true;
      if (t >= s.rise && t <= s.set) return false;
    }
    if (known) return true;
  }
  const h = new Date(t).getHours();
  return h >= 19 || h < 7;
}
