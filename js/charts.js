// Graphiques D3 (chargé globalement via <script>). Un axe Y par graphique :
// température et puissance sont dans deux graphiques séparés (jamais de double axe).

/* global d3 */

// Marges identiques pour les deux graphiques : les axes de temps s'alignent.
const M = { top: 24, right: 62, bottom: 22, left: 40 };
const fmtTime = (d) => d3.timeFormat('%H:%M')(d);

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

class TimeChart {
  /**
   * @param {HTMLElement} el
   * @param {{key:string,label:string,color:string,unit:string,fmt?:(v:number)=>string}[]} series
   */
  constructor(el, { series, unit, height = 220, yMinSpan = 5, showX = true, area = null, zero = false, valueLabels = true }) {
    this.el = el;
    this.showX = showX;       // le graphique du haut cache ses heures (même axe que celui du bas)
    this.areaKey = area;      // série remplie jusqu'à zéro
    this.zero = zero;         // ligne du zéro marquée
    this.valueLabels = valueLabels;
    this.series = series;
    this.unit = unit;
    this.height = height;
    this.yMinSpan = yMinSpan;
    this.extras = {};
    this.svg = d3.select(el).append('svg').attr('class', 'chart-svg').attr('role', 'img');
    this.gGrid = this.svg.append('g').attr('class', 'grid');
    this.gGridX = this.svg.append('g').attr('class', 'grid-x');
    this.unitLabel = this.svg.append('text').attr('class', 'unit-label').attr('text-anchor', 'end').text(unit);
    this.gX = this.svg.append('g').attr('class', 'axis axis-x');
    this.gY = this.svg.append('g').attr('class', 'axis axis-y');
    this.gExtra = this.svg.append('g');
    this.gLines = this.svg.append('g');
    this.gLabels = this.svg.append('g');
    this.gHover = this.svg.append('g').attr('class', 'hover').style('display', 'none');
    this.gHover.append('line').attr('class', 'crosshair');
    this.tip = d3.select(el).append('div').attr('class', 'tooltip').attr('hidden', true);
    this.overlay = this.svg.append('rect').attr('class', 'overlay');
    this.overlay
      .on('pointermove', (e) => this._hover(e))
      .on('pointerdown', (e) => this._hover(e)) // écran tactile : un toucher affiche les valeurs
      .on('pointerleave', (e) => { if (e.pointerType === 'mouse') this._hideHover(); });
    // Sur écran tactile, toucher ailleurs masque l'infobulle.
    document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) this._hideHover(); });
    // Redessine au redimensionnement (fenêtre, rotation, changement de mise en page), une fois par image.
    let raf = 0;
    const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.render()); };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(el);
    window.addEventListener('resize', onResize);
  }

  update(data, domain, extras = {}) {
    this.data = data;
    this.domain = domain;
    this.extras = extras;
    this.render();
  }

  render() {
    if (!this.data) return;
    // Taille lue sur le conteneur (fixée par le CSS) : le SVG suit la fenêtre sans jamais l'élargir.
    const w = Math.max(200, this.el.clientWidth);
    const h = Math.max(80, this.el.clientHeight || this.height);
    const mb = this.showX ? M.bottom : 6;
    const iw = w - M.left - M.right, ih = h - M.top - mb;
    this.svg.attr('viewBox', `0 0 ${w} ${h}`);

    const data = this.data.filter((d) => d.t >= this.domain[0]);
    const x = d3.scaleTime().domain(this.domain).range([M.left, M.left + iw]);

    const vals = [];
    for (const d of data) for (const s of this.series) if (d[s.key] != null) vals.push(d[s.key]);
    for (const v of this.extras.yInclude || []) if (v != null) vals.push(v);
    let [lo, hi] = vals.length ? d3.extent(vals) : [0, 1];
    if (hi - lo < this.yMinSpan) { const c = (hi + lo) / 2; lo = c - this.yMinSpan / 2; hi = c + this.yMinSpan / 2; }
    const pad = (hi - lo) * 0.08;
    const y = d3.scaleLinear().domain([lo - pad, hi + pad]).nice().range([M.top + ih, M.top]);
    this.x = x; this.y = y; this.visible = data;

    const ticksX = Math.max(2, Math.floor(iw / 90));
    const ticksY = Math.max(2, Math.min(5, Math.floor(ih / 36)));
    this.gX.attr('transform', `translate(0,${M.top + ih})`)
      .call(d3.axisBottom(x).ticks(ticksX).tickFormat(fmtTime).tickSize(0).tickPadding(8));
    this.gX.style('display', this.showX ? null : 'none');
    this.gGridX.attr('transform', `translate(0,${M.top + ih})`)
      .call(d3.axisBottom(x).ticks(ticksX).tickSize(-ih).tickFormat(''));
    this.gGridX.select('.domain').remove();
    this.unitLabel.attr('x', M.left - 6).attr('y', M.top - 13);
    this.gY.attr('transform', `translate(${M.left},0)`)
      .call(d3.axisLeft(y).ticks(ticksY).tickSize(0).tickPadding(6));
    this.gY.select('.domain').remove();
    this.gGrid.attr('transform', `translate(${M.left},0)`)
      .call(d3.axisLeft(y).ticks(ticksY).tickSize(-iw).tickFormat(''));
    this.gGrid.select('.domain').remove();

    this.gExtra.selectAll('*').remove();
    // Ligne du zéro (puissance : séparation décharge / recharge).
    if (this.zero && y.domain()[0] < 0 && y.domain()[1] > 0) {
      this.gExtra.append('line').attr('class', 'zero-line')
        .attr('x1', M.left).attr('x2', M.left + iw).attr('y1', y(0)).attr('y2', y(0));
    }
    // Surface remplie jusqu'à zéro sous la série principale.
    if (this.areaKey) {
      const s0 = this.series.find((s) => s.key === this.areaKey);
      const base = y(Math.max(y.domain()[0], Math.min(y.domain()[1], 0)));
      const area = d3.area().defined((d) => d[this.areaKey] != null).curve(d3.curveMonotoneX)
        .x((d) => x(d.t)).y0(base).y1((d) => y(d[this.areaKey]));
      this.gExtra.append('path').datum(data).attr('class', 'area').attr('fill', css(s0.color)).attr('d', area);
    }
    // Zone min–max (bande) si demandée.
    if (this.extras.band) {
      const [a, b] = this.extras.band;
      const area = d3.area().defined((d) => d[a] != null && d[b] != null)
        .x((d) => x(d.t)).y0((d) => y(d[a])).y1((d) => y(d[b]));
      this.gExtra.append('path').datum(data).attr('class', 'band').attr('d', area);
    }
    // Ligne de cible horizontale.
    if (this.extras.target != null) {
      const ty = y(this.extras.target);
      this.gExtra.append('line').attr('class', 'target-line')
        .attr('x1', M.left).attr('x2', M.left + iw).attr('y1', ty).attr('y2', ty);
      this.gExtra.append('text').attr('class', 'target-label')
        .attr('x', M.left + iw + 4).attr('y', ty).attr('dy', '0.32em')
        .text(`Cible ${this.extras.target} °C`);
    }
    // Projection pointillée vers la cible.
    if (this.extras.projection) {
      const [p0, p1] = this.extras.projection;
      const x1 = Math.min(x(p1.t), M.left + iw);
      const frac = (x1 - x(p0.t)) / Math.max(1, x(p1.t) - x(p0.t));
      const y1 = p0.y + (p1.y - p0.y) * frac;
      this.gExtra.append('line').attr('class', 'projection')
        .attr('x1', x(p0.t)).attr('y1', y(p0.y)).attr('x2', x1).attr('y2', y(y1));
      if (x(p1.t) <= M.left + iw) {
        this.gExtra.append('circle').attr('class', 'projection-dot')
          .attr('cx', x(p1.t)).attr('cy', y(p1.y)).attr('r', 4);
      }
    }

    // Séries.
    const lines = this.gLines.selectAll('path.series').data(this.series, (s) => s.key);
    lines.join('path').attr('class', 'series').attr('stroke', (s) => css(s.color))
      .attr('d', (s) => d3.line().defined((d) => d[s.key] != null)
        .x((d) => x(d.t)).y((d) => y(d[s.key])).curve(d3.curveMonotoneX)(data));

    // Point à la fin de chaque série + valeur actuelle à droite.
    const last = data[data.length - 1];
    const ends = this.series.filter((s) => last && last[s.key] != null)
      .map((s) => ({ s, cy: y(last[s.key]), y: y(last[s.key]) }));
    this.gLabels.selectAll('circle').data(ends, (d) => d.s.key).join('circle')
      .attr('class', 'end-dot').attr('r', 4).attr('cx', last ? x(last.t) : 0).attr('cy', (d) => d.cy)
      .attr('fill', (d) => css(d.s.color));
    // Valeurs masquées quand la projection part du même point (elles sont dans le résumé).
    const labels = this.valueLabels && !this.extras.projection ? ends.slice().sort((a, b) => a.y - b.y) : [];
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    }
    this.gLabels.selectAll('text').data(labels, (d) => d.s.key).join('text')
      .attr('class', 'value-label')
      .attr('x', last ? Math.min(x(last.t) + 9, M.left + iw + 6) : 0).attr('y', (d) => d.y).attr('dy', '0.32em')
      .text((d) => (d.s.fmt ? d.s.fmt(last[d.s.key]) : last[d.s.key].toFixed(1)));

    this.overlay.attr('x', M.left).attr('y', M.top).attr('width', iw).attr('height', ih);
    this.gHover.select('line.crosshair').attr('y1', M.top).attr('y2', M.top + ih);
    this.svg.attr('aria-label', this.el.dataset.label || '');
  }

  _hideHover() {
    this.gHover.style('display', 'none');
    this.tip.attr('hidden', true);
  }

  _hover(e) {
    if (!this.visible || !this.visible.length) return;
    const [mx] = d3.pointer(e, this.svg.node());
    const t = this.x.invert(mx).getTime();
    const i = d3.bisector((d) => d.t).center(this.visible, t);
    const d = this.visible[i];
    if (!d) return;
    const px = this.x(d.t);
    this.gHover.style('display', null);
    this.gHover.select('line.crosshair').attr('x1', px).attr('x2', px);
    const dots = this.gHover.selectAll('circle').data(this.series.filter((s) => d[s.key] != null), (s) => s.key);
    dots.join('circle').attr('r', 4).attr('cx', px).attr('cy', (s) => this.y(d[s.key]))
      .attr('fill', (s) => css(s.color));

    const rows = this.series.map((s) => {
      const v = d[s.key];
      const txt = v == null ? '—' : (s.fmt ? s.fmt(v) : v.toFixed(1));
      return `<div class="tip-row"><span class="swatch" style="background:${css(s.color)}"></span>`
        + `<span class="tip-label">${s.label}</span><span class="tip-val">${txt} ${s.unit}</span></div>`;
    }).join('');
    this.tip.html(`<div class="tip-time">${d3.timeFormat('%H:%M:%S')(d.t)}</div>${rows}`)
      .attr('hidden', null);
    const box = this.el.getBoundingClientRect();
    const tw = this.tip.node().offsetWidth;
    const left = px + 12 + tw > box.width ? px - tw - 12 : px + 12;
    this.tip.style('left', `${Math.max(0, left)}px`).style('top', `${M.top}px`);
  }
}

export function createCharts({ tempEl, powerEl }) {
  // Si le CDN de D3 est inaccessible, le reste du dashboard fonctionne quand même.
  if (typeof d3 === 'undefined') {
    for (const el of [tempEl, powerEl]) {
      el.innerHTML = '<p class="muted small">Graphique indisponible (la librairie D3 n’a pas pu être chargée).</p>';
    }
    const noop = { update() {} };
    return { temp: noop, power: noop };
  }
  const temp = new TimeChart(tempEl, {
    unit: '°C', height: 260, yMinSpan: 10, showX: false,
    series: [
      { key: 'tempMax', label: 'Module max', short: 'max', color: '--series-2', unit: '°C' },
      { key: 'tempMin', label: 'Module min', short: 'min', color: '--series-1', unit: '°C' },
    ],
  });
  const power = new TimeChart(powerEl, {
    unit: 'kW', height: 180, yMinSpan: 10, area: 'powerKw', zero: true,
    series: [
      { key: 'powerKw', label: 'Pack (V × I)', short: 'pack', color: '--series-1', unit: 'kW' },
      { key: 'chargerPowerKw', label: 'Chargeur', short: 'chargeur', color: '--series-3', unit: 'kW', fmt: (v) => v.toFixed(0) },
    ],
  });
  return { temp, power };
}
