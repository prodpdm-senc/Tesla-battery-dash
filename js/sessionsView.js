// Page « Sessions » : chauffes de batterie et recharges, lues dans l'historique Tessie.
// Liste à gauche, deux graphiques à droite (courbes de chauffe superposées ;
// puissance de recharge selon le % de charge, colorée selon la température de la batterie).

/* global d3 */

import { statesToSamples } from './history.js?v=14';
import { detectChargingSessions, detectHeatingSessions, linkHeatingToCharging } from './sessions.js?v=14';

const MIN = 60000;
// interval = secondes entre deux points demandés à Tessie (réponse plus légère sur de longues périodes).
export const PERIODS = {
  '24h': { label: '24 h', sec: 86400, interval: 1 },
  '7j': { label: '7 jours', sec: 7 * 86400, interval: 60 },
  '30j': { label: '30 jours', sec: 30 * 86400, interval: 300 },
};

const $ = (id) => document.getElementById(id);
const f1 = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const day = (t) => new Date(t).toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' });
const hm = (t) => new Date(t).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });
const dur = (ms) => {
  const m = Math.round(ms / MIN);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class SessionsView {
  /**
   * @param {{ fetchStates:(query:string)=>Promise<object>, demoSamples:()=>object[]|null,
   *   getTarget:()=>number, onUseTarget:(t:number)=>void }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.period = '7j';
    this.cache = {};
    this.sel = null; // { kind: 'heat'|'charge', i }
    this.heats = [];
    this.charges = [];
    this.loadedFor = null;
    this.heatChart = new XYChart($('chartHeat'), { xUnit: 'min', yUnit: '°C', xLabel: (v) => `${Math.round(v)} min` });
    this.chargeChart = new XYChart($('chartCharge'), { xUnit: '%', yUnit: 'kW', xLabel: (v) => `${Math.round(v)} %`, xDomain: [0, 100] });

    $('sessPeriod').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.period = b.dataset.p;
      this.sync();
      this.load();
    });
    $('sessRefresh').addEventListener('click', () => { this.cache = {}; this.load(); });
    for (const id of ['heatList', 'chargeList']) {
      $(id).addEventListener('click', (e) => {
        const tgt = e.target.closest('[data-target]');
        if (tgt) { e.stopPropagation(); this.deps.onUseTarget(+tgt.dataset.target); this.msg(`Cible réglée à ${f1(+tgt.dataset.target)} °C.`); return; }
        const row = e.target.closest('[data-i]');
        if (!row) return;
        this.select({ kind: row.dataset.kind, i: +row.dataset.i });
      });
    }
    this.heatChart.onPick = (i) => this.select({ kind: 'heat', i });
    this.chargeChart.onPick = (i) => this.select({ kind: 'charge', i });
    this.sync();
  }

  sync() {
    for (const b of $('sessPeriod').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.p === this.period));
  }

  msg(text, kind) {
    const m = $('sessMsg');
    m.textContent = text || '';
    if (kind) m.dataset.kind = kind; else delete m.dataset.kind;
  }

  /** Appelé quand la page devient visible, ou que le mode (démo / réel) change. */
  show(modeKey) {
    if (this.loadedFor !== modeKey) { this.cache = {}; this.loadedFor = modeKey; }
    this.load();
  }

  async load() {
    const key = this.period;
    const demo = this.deps.demoSamples();
    if (demo) return this.analyse(demo, 'Démo : trois jours simulés.');
    if (this.cache[key]) return this.analyse(this.cache[key]);
    if (this.loading === key) return; // requête déjà en cours pour cette période
    this.loading = key;
    const p = PERIODS[key];
    const now = Math.floor(Date.now() / 1000);
    this.msg(`Lecture de l’historique Tessie (${p.label})…`);
    try {
      // Tessie refuse (400) les demandes trop denses (ex. 7 jours aux 60 s, ~10 000 points) :
      // on réessaie avec un intervalle 4× plus grand, jusqu'à 3 fois.
      let interval = p.interval, json = null;
      for (let attempt = 0; ; attempt++) {
        try {
          json = await this.deps.fetchStates(`from=${now - p.sec}&to=${now}&interval=${interval}`);
          break;
        } catch (e) {
          if (e.status !== 400 || attempt >= 3) throw e;
          interval *= 4;
          this.msg(`Lecture de l’historique Tessie (${p.label}, un point aux ${interval} s)…`);
        }
      }
      if (key !== this.period) return; // la période a changé pendant la requête
      this.cache[key] = statesToSamples(json);
      this.intervalByKey = this.intervalByKey || {};
      this.intervalByKey[key] = interval;
      this.analyse(this.cache[key]);
    } catch (e) {
      if (key !== this.period) return;
      // Ne pas laisser affichées les sessions d'une autre période sous le message d'erreur.
      this.heats = []; this.charges = []; this.sel = null;
      this.render();
      this.msg(`${p.label} : historique illisible (${e.message}).`, 'error');
    } finally {
      if (this.loading === key) this.loading = null;
    }
  }

  analyse(samples, note) {
    // Recharges rapides (DC) seulement : à la maison (AC, ~7-11 kW), la température de la
    // batterie ne limite pas la puissance, donc rien à analyser.
    const allCharges = detectChargingSessions(samples);
    this.acHidden = allCharges.filter((c) => !c.dc).length;
    this.charges = allCharges.filter((c) => c.dc).reverse();                 // plus récentes d'abord
    this.heats = linkHeatingToCharging(detectHeatingSessions(samples), this.charges).reverse();
    this.sel = this.heats.length ? { kind: 'heat', i: 0 } : this.charges.length ? { kind: 'charge', i: 0 } : null;
    const p = PERIODS[this.period];
    const span = samples.length ? `${samples.length} points` : 'aucun point';
    const iv = this.intervalByKey && this.intervalByKey[this.period];
    const step = iv && iv > 1 ? ` (1 pt / ${iv >= 60 ? `${iv / 60} min` : `${iv} s`} max)` : '';
    const ac = this.acHidden ? ` (${this.acHidden} AC non affichée${this.acHidden > 1 ? 's' : ''})` : '';
    this.msg(note || `${p.label} · ${span}${step} · ${this.heats.length} chauffe(s) · ${this.charges.length} recharge(s) DC${ac}`);
    this.render();
  }

  select(sel) { this.sel = sel; this.render(); }

  render() {
    const sel = this.sel || {};
    $('heatCount').textContent = this.heats.length ? `(${this.heats.length})` : '';
    $('chargeCount').textContent = this.charges.length ? `(${this.charges.length})` : '';
    $('heatList').innerHTML = this.heats.length ? this.heats.map((h, i) => `
      <li class="sess-row" data-kind="heat" data-i="${i}" aria-selected="${sel.kind === 'heat' && sel.i === i}">
        <div class="sess-top"><span>${esc(day(h.t0))} · ${hm(h.t0)}</span><span class="sess-big">${f1(h.tempStart)} → ${f1(h.tempEnd)} °C</span></div>
        <div class="sess-sub">${dur(h.durationMs)} · ${f1(h.ratePerMin, 2)} °C/min · ext. ${f1(h.outsideTemp, 0)} °C · ${h.moving ? 'en roulant' : `${f1(h.energyKwh)} kWh`}</div>
        ${h.nextCharge ? `<div class="sess-sub">→ recharge rapide à ${f1(h.nextCharge.tempStart)} °C, pic ${f1(h.nextCharge.peakKw, 0)} kW</div>` : ''}
        <button class="btn sess-btn" type="button" data-target="${h.tempEnd}">Utiliser ${f1(h.tempEnd)} °C comme cible</button>
      </li>`).join('') : '<li class="sess-empty">Aucune chauffe détectée sur cette période.</li>';
    $('chargeList').innerHTML = this.charges.length ? this.charges.map((c, i) => `
      <li class="sess-row" data-kind="charge" data-i="${i}" aria-selected="${sel.kind === 'charge' && sel.i === i}">
        <div class="sess-top"><span>${esc(day(c.t0))} · ${hm(c.t0)}</span><span class="sess-big">${f1(c.socStart, 0)} → ${f1(c.socEnd, 0)} %</span></div>
        <div class="sess-sub">+${f1(c.energyKwh)} kWh · pic ${f1(c.peakKw, 0)} kW · moy. ${f1(c.avgKw, 0)} kW · ${dur(c.durationMs)}</div>
        <div class="sess-sub">batterie ${f1(c.tempStart)} → ${f1(c.tempPeak)} °C · ext. ${f1(c.outsideTemp, 0)} °C</div>
      </li>`).join('') : '<li class="sess-empty">Aucune recharge rapide (DC) sur cette période.</li>';

    // Chauffes : température du module le plus froid depuis le début de la chauffe.
    const target = this.deps.getTarget();
    this.heatChart.update(this.heats.map((h, i) => ({
      i, label: `${day(h.t0)} ${hm(h.t0)}`,
      pts: h.curve.map((p) => ({ x: p.min, y: p.temp })),
      selected: sel.kind === 'heat' && sel.i === i,
    })), { hLine: Number.isFinite(target) ? { y: target, label: `Cible ${target} °C` } : null, yFmt: (v) => `${f1(v)} °C` });

    // Recharges : couleur selon la température de la batterie au branchement.
    const temps = this.charges.map((c) => c.tempStart).filter(Number.isFinite);
    const lo = temps.length ? Math.min(...temps) : 0, hi = temps.length ? Math.max(...temps) : 1;
    const spread = hi - lo >= 1; // une seule température (ou presque) : pas de dégradé
    const color = (t) => (typeof d3 === 'undefined' || !Number.isFinite(t) ? css('--text-muted')
      : !spread ? css('--series-1') : d3.interpolateRgb(css('--series-1'), css('--series-2'))((t - lo) / (hi - lo)));
    this.chargeChart.update(this.charges.map((c, i) => ({
      i, label: `${day(c.t0)} ${hm(c.t0)} · batt. ${f1(c.tempStart)} °C`,
      pts: c.curve.map((p) => ({ x: p.soc, y: p.kw })),
      color: color(c.tempStart),
      selected: sel.kind === 'charge' && sel.i === i,
    })), { yFmt: (v) => `${f1(v, 0)} kW`, keepColor: true });
    $('chargeLegend').innerHTML = !temps.length ? ''
      : spread ? `<span>batterie au branchement</span><span class="ramp-lbl">${f1(lo)} °C</span><span class="ramp"></span><span class="ramp-lbl">${f1(hi)} °C</span>`
        : `<span>batterie au branchement</span><span class="ramp-lbl">${f1(lo)} °C</span>`;
  }
}

/** Petit graphique XY (plusieurs courbes) : une courbe sélectionnée en évidence, les autres en retrait. */
class XYChart {
  constructor(el, { xUnit, yUnit, xLabel, xDomain = null }) {
    this.el = el;
    this.xLabel = xLabel;
    this.xDomain = xDomain;
    this.series = [];
    this.opts = {};
    this.onPick = null;
    if (typeof d3 === 'undefined') { el.innerHTML = '<p class="muted small">Graphique indisponible.</p>'; return; }
    this.svg = d3.select(el).append('svg').attr('class', 'chart-svg');
    this.gGrid = this.svg.append('g').attr('class', 'grid');
    this.gX = this.svg.append('g').attr('class', 'axis');
    this.gY = this.svg.append('g').attr('class', 'axis');
    this.gExtra = this.svg.append('g');
    this.gLines = this.svg.append('g');
    this.unitY = this.svg.append('text').attr('class', 'unit-label').attr('text-anchor', 'end').text(yUnit);
    this.unitX = this.svg.append('text').attr('class', 'unit-label').attr('text-anchor', 'end').text(xUnit);
    this.hover = this.svg.append('circle').attr('r', 5).attr('class', 'end-dot').style('display', 'none');
    this.tip = d3.select(el).append('div').attr('class', 'tooltip').attr('hidden', true);
    this.overlay = this.svg.append('rect').attr('class', 'overlay');
    this.overlay.on('pointermove', (e) => this._hover(e)).on('pointerdown', (e) => this._hover(e, true))
      .on('pointerleave', (e) => { if (e.pointerType === 'mouse') this._hide(); });
    let raf = 0;
    const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.render()); };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(el);
  }

  update(series, opts = {}) { this.series = series; this.opts = opts; this.render(); }

  render() {
    if (!this.svg) return;
    const w = Math.max(200, this.el.clientWidth), h = Math.max(80, this.el.clientHeight || 200);
    const M = { top: 24, right: 62, bottom: 24, left: 40 };
    const iw = w - M.left - M.right, ih = h - M.top - M.bottom;
    this.svg.attr('viewBox', `0 0 ${w} ${h}`);
    const all = this.series.flatMap((s) => s.pts).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const ys = all.map((p) => p.y);
    if (this.opts.hLine) ys.push(this.opts.hLine.y);
    let [y0, y1] = ys.length ? d3.extent(ys) : [0, 1];
    if (y1 - y0 < 5) { y0 -= 2.5; y1 += 2.5; }
    const x = d3.scaleLinear().domain(this.xDomain || [0, Math.max(10, d3.max(all, (p) => p.x) || 10)]).range([M.left, M.left + iw]);
    const y = d3.scaleLinear().domain([Math.min(0, y0), y1]).nice().range([M.top + ih, M.top]);
    if (y0 > 0 && this.opts.hLine) y.domain([y0 - (y1 - y0) * 0.08, y1 + (y1 - y0) * 0.05]).nice();
    this.x = x; this.y = y;
    const ty = Math.max(2, Math.min(5, Math.floor(ih / 36)));
    this.gX.attr('transform', `translate(0,${M.top + ih})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(iw / 80))).tickSize(0).tickPadding(8));
    this.gY.attr('transform', `translate(${M.left},0)`).call(d3.axisLeft(y).ticks(ty).tickSize(0).tickPadding(6));
    this.gGrid.attr('transform', `translate(${M.left},0)`).call(d3.axisLeft(y).ticks(ty).tickSize(-iw).tickFormat(''));
    this.gGrid.select('.domain').remove();
    this.unitY.attr('x', M.left - 6).attr('y', M.top - 13);
    this.unitX.attr('x', M.left + iw + 30).attr('y', M.top + ih + 17);

    this.gExtra.selectAll('*').remove();
    if (this.opts.hLine && this.opts.hLine.y >= y.domain()[0] && this.opts.hLine.y <= y.domain()[1]) {
      const yy = y(this.opts.hLine.y);
      this.gExtra.append('line').attr('class', 'target-line').attr('x1', M.left).attr('x2', M.left + iw).attr('y1', yy).attr('y2', yy);
      this.gExtra.append('text').attr('class', 'target-label').attr('x', M.left + iw + 4).attr('y', yy).attr('dy', '0.32em').text(this.opts.hLine.label);
    }
    const line = d3.line().defined((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).x((p) => x(p.x)).y((p) => y(p.y));
    // La courbe sélectionnée est dessinée en dernier (au-dessus des autres).
    const ordered = this.series.slice().sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));
    const anySel = this.series.some((s) => s.selected);
    this.gLines.selectAll('path').data(ordered, (s) => s.i).join('path')
      .attr('class', 'series')
      .attr('d', (s) => line(s.pts))
      .attr('stroke', (s) => (s.color && (this.opts.keepColor || s.selected) ? s.color : s.selected ? css('--series-1') : css('--text-muted')))
      .attr('stroke-width', (s) => (s.selected ? 3 : 1.5))
      .attr('opacity', (s) => (!anySel || s.selected ? 1 : this.opts.keepColor ? 0.45 : 0.35));
    this.overlay.attr('x', M.left).attr('y', M.top).attr('width', iw).attr('height', ih);
  }

  _nearest(e) {
    const [mx, my] = d3.pointer(e, this.svg.node());
    let best = null;
    for (const s of this.series) {
      for (const p of s.pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const d = (this.x(p.x) - mx) ** 2 + (this.y(p.y) - my) ** 2;
        if (!best || d < best.d) best = { d, s, p };
      }
    }
    return best;
  }

  _hover(e, pick) {
    const n = this._nearest(e);
    if (!n) return;
    if (pick && n.d < 40 * 40 && this.onPick) { this.onPick(n.s.i); }
    const cx = this.x(n.p.x), cy = this.y(n.p.y);
    this.hover.style('display', null).attr('cx', cx).attr('cy', cy).attr('fill', n.s.color || css('--series-1'));
    const yf = this.opts.yFmt || ((v) => v.toFixed(1));
    this.tip.html(`<div class="tip-time">${esc(n.s.label)}</div><div class="tip-row"><span class="tip-label">${esc(this.xLabel(n.p.x))}</span><span class="tip-val">${esc(yf(n.p.y))}</span></div>`)
      .attr('hidden', null);
    const tw = this.tip.node().offsetWidth;
    const left = cx + 12 + tw > this.el.clientWidth ? cx - tw - 12 : cx + 12;
    this.tip.style('left', `${Math.max(0, left)}px`).style('top', `${Math.max(0, cy - 40)}px`);
  }

  _hide() { this.hover.style('display', 'none'); this.tip.attr('hidden', true); }
}

/** Historique simulé (3 jours) pour le mode démo : chauffes à différentes températures extérieures + recharges DC. */
export function demoHistory(now = Date.now()) {
  const out = [];
  const days = [
    { ago: 2, ext: -12, start: 2, heat: 0.7, chargeKw: 150 },
    { ago: 1, ext: -3, start: 9, heat: 0.95, chargeKw: 165 },
    { ago: 0, ext: 4, start: 15, heat: 1.1, chargeKw: 170 },
  ];
  for (const d of days) {
    const base = now - d.ago * 86400000 - 3 * 3600000;
    let T = d.start, soc = 25;
    for (let sec = 0; sec <= 95 * 60; sec += 30) {
      const m = sec / 60;
      const s = { t: base + sec * 1000, outsideTemp: d.ext, shiftState: 'D', speed: 95, powerKw: 22, chargingState: 'Disconnected', chargerPowerKw: 0, soc };
      if (m < 5) { s.shiftState = 'P'; s.speed = 0; s.powerKw = 0.4; }
      else if (m < 5 + 40 && T < 50) { T += d.heat * 0.5 + (Math.random() - 0.5) * 0.05; }
      else if (m >= 50 && soc < 80) {
        const warm = Math.min(1, Math.max(0.3, (T - 10) / 35));
        const kw = d.chargeKw * warm * (soc < 50 ? 1 : Math.max(0.3, 1 - (soc - 50) / 40));
        soc = Math.min(80, soc + kw / 120); T += 0.05;
        Object.assign(s, { shiftState: 'P', speed: 0, chargingState: 'Charging', chargerPowerKw: kw, powerKw: -kw, soc: Math.round(soc) });
      } else if (m >= 50) { Object.assign(s, { shiftState: 'P', speed: 0, powerKw: 0.3 }); }
      s.tempMin = Math.round(T * 2) / 2;
      s.tempMax = Math.round((T + 1.5) * 2) / 2;
      out.push(s);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
