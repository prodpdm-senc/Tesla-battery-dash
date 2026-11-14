// Estimation du temps restant avant d'atteindre la température cible.
// Module pur (aucune dépendance au DOM) → testable avec `node --test`.
//
// Méthode :
//   1. Régression linéaire (moindres carrés) sur une fenêtre glissante
//      → pente dT/dt en °C/min. Robuste à la quantification 0,5 °C du capteur,
//      contrairement à une différence entre deux points.
//   2. Lissage exponentiel (EMA) de la pente entre deux échantillons.
//   3. ETA = (T_cible − T_ajustée) / pente, avec une plage ± 1 erreur-type.

const MIN = 60000;

/** Température retenue pour un échantillon selon la métrique choisie. */
export function pickTemp(sample, metric = 'min') {
  const lo = sample ? sample.tempMin : undefined;
  const hi = sample ? sample.tempMax : undefined;
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (metric === 'max') return ok(hi) ? hi : ok(lo) ? lo : null;
  if (metric === 'avg') {
    if (ok(lo) && ok(hi)) return (lo + hi) / 2;
    return ok(lo) ? lo : ok(hi) ? hi : null;
  }
  return ok(lo) ? lo : ok(hi) ? hi : null;
}

/**
 * Régression linéaire y = a + b·x.
 * @param {{x:number,y:number}[]} pts
 * @returns {{slope:number, intercept:number, r2:number, se:number, n:number} | null}
 */
export function linearFit(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const ssRes = Math.max(0, syy - slope * sxy);
  const r2 = syy === 0 ? 1 : 1 - ssRes / syy;
  // Erreur-type de la pente ; nécessite n > 2.
  const se = n > 2 ? Math.sqrt(ssRes / (n - 2) / sxx) : Infinity;
  return { slope, intercept, r2, se, n };
}

export const DEFAULTS = Object.freeze({
  target: 50,          // °C
  metric: 'min',       // module le plus froid = limitant pour la recharge
  windowMin: 5,        // largeur de la fenêtre de régression
  minPoints: 3,
  minSpanMin: 1,       // étendue minimale des données dans la fenêtre
  alpha: 0.4,          // poids du nouvel échantillon dans l'EMA
  flatRate: 0.05,      // °C/min sous lequel on considère « stable »
  reachedBand: 0.25,   // °C de tolérance pour « cible atteinte »
});

/**
 * @param {{t:number, tempMin?:number, tempMax?:number}[]} samples triés par t (ms)
 * @param {Partial<typeof DEFAULTS>} opts
 * @param {number|null} prevSmoothed pente lissée précédente (°C/min)
 */
export function estimate(samples, opts = {}, prevSmoothed = null) {
  const o = { ...DEFAULTS, ...opts };
  const base = { status: 'insufficient', rate: null, rateSmoothed: prevSmoothed, tempNow: null,
    tempFit: null, etaMs: null, etaLowMs: null, etaHighMs: null, n: 0, r2: null, tLast: null };

  const valid = samples
    .map((s) => ({ t: s.t, y: pickTemp(s, o.metric) }))
    .filter((p) => Number.isFinite(p.t) && p.y !== null);
  if (!valid.length) return base;

  const last = valid[valid.length - 1];
  base.tempNow = last.y;
  base.tLast = last.t;

  if (last.y >= o.target - o.reachedBand) {
    return { ...base, status: 'reached', tempFit: last.y, etaMs: 0 };
  }

  const from = last.t - o.windowMin * MIN;
  const win = valid.filter((p) => p.t >= from);
  base.n = win.length;
  const span = win.length ? last.t - win[0].t : 0;
  if (win.length < o.minPoints || span < o.minSpanMin * MIN) return base;

  // x en minutes relatives au dernier point → meilleure stabilité numérique.
  const fit = linearFit(win.map((p) => ({ x: (p.t - last.t) / MIN, y: p.y })));
  if (!fit) return base;

  const rate = fit.slope;                              // °C/min
  const rateSmoothed = prevSmoothed == null || !Number.isFinite(prevSmoothed)
    ? rate
    : o.alpha * rate + (1 - o.alpha) * prevSmoothed;
  // Valeur ajustée au dernier instant (x = 0) ; bornée à ± 1 °C du brut.
  const tempFit = Math.min(last.y + 1, Math.max(last.y - 1, fit.intercept));

  const out = { ...base, rate, rateSmoothed, tempFit, r2: fit.r2 };

  if (rateSmoothed <= o.flatRate) {
    out.status = rateSmoothed < -o.flatRate ? 'cooling' : 'stable';
    return out;
  }

  const delta = o.target - tempFit;
  out.status = 'heating';
  out.etaMs = (delta / rateSmoothed) * MIN;
  const hiRate = rateSmoothed + fit.se;
  const loRate = rateSmoothed - fit.se;
  out.etaLowMs = Number.isFinite(hiRate) && hiRate > 0 ? (delta / hiRate) * MIN : null;
  out.etaHighMs = Number.isFinite(loRate) && loRate > o.flatRate ? (delta / loRate) * MIN : Infinity;
  return out;
}

/** Formate une durée en ms : « 12 min », « 1 h 05 », « 45 s ». */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '0 min';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}
