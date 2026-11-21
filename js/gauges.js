// Jauges en barres verticales (HTML/CSS pur) avec la valeur en texte dessous.
// Grandeurs signées (courant, puissance, température) : la barre part de la ligne
// du zéro, vers le haut si positif, vers le bas si négatif.
// Une valeur trop vieille est atténuée et son âge remplace le texte du dessous.

import { formatAge } from './quality.js?v=23';

function clamp01(t) { return Math.max(0, Math.min(1, t)); }

function fmtNum(v, d) {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
}

function div(cls, parent) {
  const n = document.createElement('div');
  n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

/**
 * @typedef {{ id:string, label:string, unit:string, min:number, max:number, decimals?:number,
 *   signed?:boolean, get:(s:object)=>number|null, marker?:(s:object)=>number|null,
 *   sub?:(s:object)=>string }} GaugeDef
 */

export class Gauges {
  /** @param {HTMLElement} root @param {GaugeDef[]} defs */
  constructor(root, defs) {
    this.items = defs.map((d) => this._build(root, d));
  }

  _build(root, d) {
    const box = div('gauge', root);
    box.dataset.block = `g-${d.id}`; // carte déplaçable (js/layout.js)
    box.setAttribute('role', 'meter');
    box.setAttribute('aria-label', d.label);
    box.setAttribute('aria-valuemin', String(d.min));
    box.setAttribute('aria-valuemax', String(d.max));

    div('gauge-label', box).textContent = d.label;

    const body = div('gauge-body', box);
    const scale = div('gauge-scale', body);
    div('gauge-scale-max', scale).textContent = String(d.max);
    div('gauge-scale-min', scale).textContent = String(d.min);

    const track = div('gauge-track', body);
    const zeroT = d.signed ? clamp01((0 - d.min) / (d.max - d.min)) : 0;
    if (d.signed) {
      const z = div('gauge-zero', track);
      z.style.bottom = `${zeroT * 100}%`;
    }
    const fill = div('gauge-fill', track);
    const marker = div('gauge-marker', track);
    marker.hidden = true;

    const value = div('gauge-value', box);
    const sub = div('gauge-sub', box);
    return { d, box, fill, marker, value, sub, zeroT };
  }

  /**
   * @param {object|null} sample
   * @param {{ ages?: Object<string, number|null>, staleMs?: number }} [opt] âge (ms) de la valeur de chaque jauge
   */
  update(sample, opt) {
    const ages = (opt && opt.ages) || {};
    const staleMs = (opt && opt.staleMs) || 3 * 60000;
    for (const it of this.items) {
      const d = it.d;
      const v = sample ? d.get(sample) : null;
      const ok = v != null && Number.isFinite(v);
      const t = ok ? clamp01((v - d.min) / (d.max - d.min)) : it.zeroT;
      const lo = Math.min(it.zeroT, t), hi = Math.max(it.zeroT, t);
      it.fill.style.bottom = `${lo * 100}%`;
      it.fill.style.height = `${(hi - lo) * 100}%`;
      // Vert (recharge) seulement pour les grandeurs électriques ; ailleurs, bleu dans les deux sens.
      it.fill.setAttribute('data-dir', d.signed && d.colorBySign !== false && ok && v < 0 ? 'neg' : 'pos');
      it.box.setAttribute('aria-valuenow', ok ? String(v) : '');
      it.box.toggleAttribute('data-out', ok && (v < d.min || v > d.max));

      const sign = d.signed && ok && v > 0 ? '+' : '';
      it.value.innerHTML = `${sign}${fmtNum(v, d.decimals == null ? 0 : d.decimals)}<span class="unit">${d.unit}</span>`;
      const age = ages[d.id];
      const stale = ok && age != null && age > staleMs;
      it.box.toggleAttribute('data-stale', stale);
      it.sub.textContent = stale ? formatAge(age) : sample && d.sub ? d.sub(sample) : '';

      const m = sample && d.marker ? d.marker(sample) : null;
      it.marker.hidden = !(m != null && Number.isFinite(m));
      if (!it.marker.hidden) it.marker.style.bottom = `${clamp01((m - d.min) / (d.max - d.min)) * 100}%`;
    }
  }
}
