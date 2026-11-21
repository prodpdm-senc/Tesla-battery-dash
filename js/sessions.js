// Détection des sessions dans l'historique : recharges et chauffes de batterie.
// Module pur (aucun DOM), testé. Entrée : échantillons triés (history.statesToSamples).
// Convention : powerKw positif = énergie qui sort de la batterie.

import { linearFit } from './estimator.js?v=25';

const MIN = 60000;

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function isCharging(s) {
  return s.chargingState === 'Charging' || s.chargingState === 'Starting'
    || (finite(s.chargerPowerKw) && s.chargerPowerKw > 0.5);
}
function isMoving(s) {
  return (finite(s.speed) && s.speed > 0) || s.shiftState === 'D' || s.shiftState === 'R';
}
/** Puissance de recharge (kW, positive) : chargeur, sinon puissance du pack en recharge. */
export function chargePowerKw(s) {
  const fromCharger = finite(s.chargerPowerKw) ? s.chargerPowerKw : 0;
  const fromPack = finite(s.powerKw) && s.powerKw < 0 ? -s.powerKw : 0;
  return Math.max(fromCharger, fromPack);
}

/** Intégrale trapézoïdale (kWh) d'une fonction de puissance, en ignorant les trous > maxGapMs. */
function integrateKwh(pts, f, maxGapMs) {
  let kwh = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0 || dt > maxGapMs) continue;
    const a = f(pts[i - 1]), b = f(pts[i]);
    if (finite(a) && finite(b)) kwh += ((a + b) / 2) * (dt / 3600000);
  }
  return kwh;
}

/**
 * Résumé d'une recharge rapide : minutes passées à 100 kW ou plus, et kWh ajoutés après
 * 10, 20 et 30 minutes (comptées à partir du premier point à 5 kW ou plus, pour ignorer
 * la poignée de main avec la borne). null quand la session est plus courte que la durée.
 */
export function fastChargeStats(pts, { maxGapMs = 10 * MIN } = {}) {
  let above = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0 || dt > maxGapMs) continue;
    if ((chargePowerKw(pts[i]) + chargePowerKw(pts[i - 1])) / 2 >= 100) above += dt;
  }
  const kwhAfter = { 10: null, 20: null, 30: null };
  const k0 = pts.findIndex((p) => chargePowerKw(p) >= 5);
  if (k0 >= 0) {
    const ts = pts[k0].t, tEnd = pts[pts.length - 1].t;
    for (const m of [10, 20, 30]) {
      if (tEnd - ts < m * MIN) continue;
      const lim = ts + m * MIN;
      // Intégrale jusqu'à exactement `lim` (interpolation dans le dernier intervalle).
      let kwh = 0;
      for (let i = k0 + 1; i < pts.length && pts[i - 1].t < lim; i++) {
        const a = pts[i - 1], b = pts[i];
        const dt = b.t - a.t;
        if (dt <= 0 || dt > maxGapMs) continue;
        const pa = chargePowerKw(a), pb = chargePowerKw(b);
        const tb = Math.min(b.t, lim);
        const pEnd = pa + (pb - pa) * ((tb - a.t) / dt);
        kwh += ((pa + pEnd) / 2) * ((tb - a.t) / 3600000);
      }
      kwhAfter[m] = kwh;
    }
  }
  return { minAbove100: above / MIN, kwhAfter };
}

/** Regroupe les indices qui satisfont `pred` en suites, coupées par un trou > gapMs. */
function runs(samples, pred, gapMs) {
  const out = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    if (!pred(samples[i], i)) continue;
    if (cur && samples[i].t - samples[cur[cur.length - 1]].t <= gapMs) cur.push(i);
    else { cur = [i]; out.push(cur); }
  }
  return out;
}

/**
 * Sessions de recharge.
 * @returns {{t0,t1,durationMs,socStart,socEnd,energyKwh,peakKw,avgKw,dc,tempStart,tempPeak,outsideTemp,curve:{soc,kw,temp,t}[]}[]}
 */
export function detectChargingSessions(samples, { gapMs = 15 * MIN, minDurMs = 3 * MIN } = {}) {
  const out = [];
  for (const idx of runs(samples, isCharging, gapMs)) {
    const pts = idx.map((i) => samples[i]);
    if (pts.length < 2) continue;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    if (t1 - t0 < minDurMs) continue;
    const powers = pts.map(chargePowerKw);
    const peakKw = Math.max(...powers);
    const added = pts.map((p) => p.chargeEnergyAdded).filter(finite);
    const energyKwh = added.length >= 2 && Math.max(...added) - added[0] > 0
      ? Math.max(...added) - added[0]
      : integrateKwh(pts, chargePowerKw, 10 * MIN);
    const socs = pts.map((p) => p.soc).filter(finite);
    const tmin = pts.map((p) => p.tempMin).filter(finite);
    const tmax = pts.map((p) => p.tempMax).filter(finite);
    const ext = pts.map((p) => p.outsideTemp).filter(finite);
    const fast = fastChargeStats(pts);
    out.push({
      t0, t1, durationMs: t1 - t0,
      minAbove100: fast.minAbove100,
      kwhAfter: fast.kwhAfter,
      socStart: socs.length ? socs[0] : null,
      socEnd: socs.length ? socs[socs.length - 1] : null,
      energyKwh,
      peakKw,
      avgKw: (t1 - t0) > 0 ? energyKwh / ((t1 - t0) / 3600000) : null,
      dc: peakKw >= 25,
      tempStart: tmin.length ? tmin[0] : null,
      tempPeak: tmax.length ? Math.max(...tmax) : null,
      outsideTemp: ext.length ? median(ext) : null,
      // Sans les points à ~0 kW du début et de la fin (sinon traits verticaux jusqu'à 0).
      curve: pts.filter((p) => finite(p.soc) && chargePowerKw(p) >= 0.5)
        .map((p) => ({ t: p.t, soc: p.soc, kw: chargePowerKw(p), temp: p.tempMin })),
    });
  }
  return out;
}

/**
 * Sessions de chauffe de la batterie (préconditionnement, à l'arrêt ou en roulant).
 * Tessie n'enregistre pas l'état « préconditionnement » : on repère une montée de la
 * température du module le plus froid d'au moins `rate` °C/min (régression sur une
 * fenêtre glissante), hors recharge. Une montée lente en roulant n'est pas retenue.
 * @returns {{t0,t1,durationMs,tempStart,tempEnd,rise,ratePerMin,outsideTemp,moving,energyKwh,curve:{min,temp}[]}[]}
 */
export function detectHeatingSessions(samples, {
  rate = 0.25, windowMin = 5, gapMs = 4 * MIN, minDurMs = 4 * MIN, minRise = 2,
} = {}) {
  const pts = samples.filter((s) => finite(s.tempMin));
  if (pts.length < 3) return [];
  const gaps = [];
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i].t - pts[i - 1].t);
  // La fenêtre doit contenir plusieurs points, même avec un historique espacé (ex. 5 min).
  const step = median(gaps) || 0;
  const winMs = Math.max(windowMin * MIN, 3 * step);
  const joinMs = Math.max(gapMs, 1.5 * step); // trou toléré entre deux points « en chauffe »

  const heating = new Array(pts.length).fill(false);
  let lo = 0;
  for (let i = 0; i < pts.length; i++) {
    while (pts[i].t - pts[lo].t > winMs) lo++;
    if (i - lo < 2 || isCharging(pts[i])) continue;
    const fit = linearFit(pts.slice(lo, i + 1).map((p) => ({ x: (p.t - pts[i].t) / MIN, y: p.tempMin })));
    heating[i] = !!fit && fit.slope >= rate;
  }

  const out = [];
  for (const idx of runs(pts, (_, i) => heating[i], joinMs)) {
    // La pente au point i couvre la fenêtre précédente : la chauffe commence au début de celle-ci.
    let first = idx[0];
    while (first > 0 && pts[idx[0]].t - pts[first - 1].t <= winMs && !isCharging(pts[first - 1])) first--;
    // Retire le plat du début (fenêtre remontée avant que la température bouge).
    while (first < idx[0] && pts[first + 1].tempMin <= pts[first].tempMin) first++;
    const seg = pts.slice(first, idx[idx.length - 1] + 1);
    const t0 = seg[0].t, t1 = seg[seg.length - 1].t;
    const tempStart = seg[0].tempMin;
    const tempEnd = Math.max(...seg.map((p) => p.tempMin));
    const rise = tempEnd - tempStart;
    if (t1 - t0 < minDurMs || rise < minRise) continue;
    const ext = seg.map((p) => p.outsideTemp).filter(finite);
    const moving = seg.some(isMoving);
    out.push({
      t0, t1, durationMs: t1 - t0,
      tempStart, tempEnd, rise,
      ratePerMin: rise / ((t1 - t0) / MIN),
      outsideTemp: ext.length ? median(ext) : null,
      moving,
      // En roulant, la consommation mélange chauffe et propulsion : pas d'énergie de chauffe.
      energyKwh: moving ? null : integrateKwh(seg, (p) => (finite(p.powerKw) && p.powerKw > 0 ? p.powerKw : 0), 10 * MIN),
      curve: seg.map((p) => ({ min: (p.t - t0) / MIN, temp: p.tempMin })),
    });
  }
  return out;
}

/** Associe à chaque chauffe la recharge qui commence dans les `withinMs` qui suivent. */
export function linkHeatingToCharging(heats, charges, withinMs = 20 * MIN) {
  for (const h of heats) {
    h.nextCharge = charges.find((c) => c.t0 >= h.t0 && c.t0 - h.t1 <= withinMs) || null;
  }
  return heats;
}
