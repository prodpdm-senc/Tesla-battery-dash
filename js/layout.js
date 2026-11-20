// Disposition configurable de la vue Direct : deux colonnes de cartes que l'on réordonne
// au doigt (mode édition), et plusieurs dispositions enregistrées (Graphiques, Tableau de bord).
// La partie « modèle » (presets, déplacement, masquage, rangées de jauges) est pure et testée ;
// la classe LayoutManager s'occupe du DOM et du glisser-déposer tactile.

export const BLOCKS = {
  hero: 'Résumé',
  temp: 'Graphique · batterie',
  motor: 'Graphique · moteur',
  chips: 'Pastilles',
  'g-voltage': 'Tension',
  'g-current': 'Courant',
  'g-power': 'Puissance',
  'g-soc': 'Charge',
  'g-charger': 'Chargeur',
  'g-outside': 'Extérieur',
};
const GAUGES = ['g-voltage', 'g-current', 'g-power', 'g-soc', 'g-charger', 'g-outside'];

export const isGauge = (id) => id.indexOf('g-') === 0;

/** Dispositions de départ. split = largeur de la colonne de gauche (%). */
export const PRESETS = {
  graphs: { label: 'Graphiques', split: 68, cols: [['hero', 'temp', 'motor'], ['chips'].concat(GAUGES)], hidden: [] },
  dash: { label: 'Tableau de bord', split: 58, cols: [['chips'].concat(GAUGES), ['hero', 'temp', 'motor']], hidden: [] },
};

const clone = (l) => ({ split: l.split, cols: [l.cols[0].slice(), l.cols[1].slice()], hidden: l.hidden.slice() });

/**
 * Remet une disposition en ordre : chaque carte connue apparaît exactement une fois
 * (dans une colonne ou parmi les masquées), les inconnues sont retirées, et une carte
 * nouvelle (version future) est ajoutée à la fin de la colonne de droite.
 */
export function normalize(l, preset = PRESETS.graphs) {
  const src = l && Array.isArray(l.cols) && l.cols.length === 2 ? l : preset;
  const seen = {};
  const keep = (list) => (Array.isArray(list) ? list : []).filter((id) => {
    if (!(id in BLOCKS) || seen[id]) return false;
    seen[id] = true;
    return true;
  });
  const out = {
    split: Number.isFinite(+src.split) ? Math.min(80, Math.max(20, +src.split)) : preset.split,
    cols: [keep(src.cols[0]), keep(src.cols[1])],
    hidden: keep(src.hidden),
  };
  for (const id of Object.keys(BLOCKS)) if (!seen[id]) out.cols[1].push(id);
  return out;
}

/**
 * Déplace une carte : dans la colonne `col`, avant (ou après) la carte `ref`, ou à la fin
 * si `ref` est absent. Une carte masquée redevient visible. Retourne une nouvelle disposition.
 */
export function moveBlock(l, id, { col, ref = null, after = false }) {
  const n = clone(l);
  n.cols = n.cols.map((c) => c.filter((x) => x !== id));
  n.hidden = n.hidden.filter((x) => x !== id);
  const list = n.cols[col];
  let i = ref && ref !== id ? list.indexOf(ref) : -1;
  if (i < 0) list.push(id);
  else list.splice(after ? i + 1 : i, 0, id);
  return n;
}

/** Masque une carte. */
export function hideBlock(l, id) {
  const n = clone(l);
  n.cols = n.cols.map((c) => c.filter((x) => x !== id));
  if (n.hidden.indexOf(id) < 0) n.hidden.push(id);
  return n;
}

/** Réaffiche une carte masquée, à la fin de la colonne la moins remplie. */
export function showBlock(l, id) {
  const col = l.cols[0].length <= l.cols[1].length ? 0 : 1;
  return moveBlock(l, id, { col });
}

/**
 * Découpe une colonne en rangées : une carte large (résumé, graphique, pastilles) par
 * rangée ; les jauges consécutives partagent des rangées équilibrées d'au plus `maxPerRow`.
 * Ex. 6 jauges, 4 au plus par rangée → 2 rangées de 3.
 * @returns {{ ids:string[], gauges:boolean, n:number }[]}
 */
export function packRows(ids, maxPerRow) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const max = Math.max(1, maxPerRow);
    const rows = Math.ceil(run.length / max);
    const n = Math.ceil(run.length / rows);
    for (let i = 0; i < run.length; i += n) out.push({ ids: run.slice(i, i + n), gauges: true, n });
    run = [];
  };
  for (const id of ids) {
    if (isGauge(id)) { run.push(id); continue; }
    flush();
    out.push({ ids: [id], gauges: false, n: 1 });
  }
  flush();
  return out;
}

// ───────────────────────── Stockage ─────────────────────────

const KEY = 'tbd:layouts';
function readStore() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
}
function writeStore(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* stockage bloqué : la disposition vaut pour la session */ }
}

// ───────────────────────── DOM ─────────────────────────

const GAUGE_MIN_W = 100;   // largeur minimale d'une jauge (px) → nombre de jauges par rangée
const GAUGE_MIN_W_TIGHT = 62; // largeur minimale quand la hauteur manque
const ROW_MIN_H = 110;     // hauteur sous laquelle une rangée de jauges est trop écrasée
const SVG_GRIP = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="currentColor"><circle cx="8" cy="6" r="2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/><circle cx="16" cy="18" r="2"/></g></svg>';
const SVG_HIDE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

export class LayoutManager {
  /**
   * @param {{ root:HTMLElement, colA:HTMLElement, colB:HTMLElement, pool:HTMLElement,
   *   onChange?:()=>void }} o  pool = conteneur caché des cartes masquées
   */
  constructor({ root, colA, colB, pool, onChange }) {
    this.root = root;
    this.colEls = [colA, colB];
    this.pool = pool;
    this.onChange = onChange || (() => {});
    this.editing = false;
    const st = readStore();
    this.active = st.active in PRESETS ? st.active : 'graphs';
    this.layouts = {};
    for (const k of Object.keys(PRESETS)) this.layouts[k] = normalize(st[k], PRESETS[k]);
    this.blocks = {};
    for (const el of document.querySelectorAll('[data-block]')) this.blocks[el.dataset.block] = el;
    for (const id of Object.keys(this.blocks)) this._addTools(this.blocks[id], id);
    this.indicator = document.createElement('div');
    this.indicator.className = 'drop-indicator';
    this.indicator.hidden = true;
    document.body.appendChild(this.indicator);
    let raf = 0;
    let lastSize = '';
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // La largeur ET la hauteur comptent : moins de hauteur → plus de jauges par rangée.
        const size = `${root.clientWidth}x${root.clientHeight}`;
        if (size !== lastSize) { lastSize = size; this.apply(); }
      });
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(root);
    window.addEventListener('resize', onResize);
  }

  get layout() { return this.layouts[this.active]; }

  setActive(key) {
    if (!(key in PRESETS)) return;
    this.active = key;
    this._save();
    this.apply();
  }

  reset() {
    this.layouts[this.active] = normalize(PRESETS[this.active], PRESETS[this.active]);
    this._save();
    this.apply();
  }

  showBlock(id) { this._commit(showBlock(this.layout, id)); }

  setSplit(pct) {
    this.layouts[this.active] = Object.assign(clone(this.layout), { split: Math.min(80, Math.max(20, pct)) });
    this._save();
    this._applySplit();
  }

  setEditing(on) {
    this.editing = !!on;
    document.documentElement.classList.toggle('editing', this.editing);
    this.apply();
  }

  _commit(l) {
    this.layouts[this.active] = normalize(l, PRESETS[this.active]);
    this._save();
    this.apply();
  }

  _save() {
    const s = { active: this.active };
    for (const k of Object.keys(this.layouts)) s[k] = this.layouts[k];
    writeStore(s);
  }

  /** Nombre maximal de jauges par rangée dans chaque colonne (selon sa largeur). */
  _perRow() {
    return this.colEls.map((c) => Math.max(1, Math.min(6, Math.floor((c.clientWidth || 300) / GAUGE_MIN_W))));
  }

  _applySplit() {
    const l = this.layout;
    const empty = [!l.cols[0].length, !l.cols[1].length];
    // Hors édition, une colonne vide disparaît et l'autre prend toute la largeur.
    let tpl;
    if (!this.editing && empty[0]) tpl = '0 minmax(0, 1fr)';
    else if (!this.editing && empty[1]) tpl = 'minmax(0, 1fr) 0';
    else tpl = `minmax(0, ${l.split}fr) minmax(0, ${100 - l.split}fr)`;
    this.root.style.gridTemplateColumns = tpl;
    this.root.dataset.empty = empty[0] ? 'a' : empty[1] ? 'b' : '';
  }

  /** Place les cartes selon la disposition active. */
  apply() {
    const l = this.layout;
    this._applySplit();
    const per = this._perRow();
    for (const id of l.hidden) this.pool.appendChild(this.blocks[id]);
    l.cols.forEach((ids, ci) => {
      this._buildCol(ci, ids, per[ci]);
      // Rangées trop basses pour la fenêtre : plus de jauges par rangée (donc moins de rangées).
      const gauges = ids.filter(isGauge).length;
      // … mais jamais plus étroites que GAUGE_MIN_W_TIGHT : au-delà, le mode compact prend le relais.
      const cap = Math.min(6, gauges, Math.max(per[ci], Math.floor((this.colEls[ci].clientWidth || 300) / GAUGE_MIN_W_TIGHT)));
      for (let n = per[ci]; n < cap && this._minRowH(ci) < ROW_MIN_H; ) {
        n++;
        this._buildCol(ci, ids, n);
      }
    });
    this._sizeClasses();
    this.onChange();
  }

  _buildCol(ci, ids, perRow) {
    const col = this.colEls[ci];
    const frag = document.createDocumentFragment();
    for (const r of packRows(ids, perRow)) {
      if (!r.gauges) { frag.appendChild(this.blocks[r.ids[0]]); continue; }
      const row = document.createElement('div');
      row.className = 'g-row';
      row.style.gridTemplateColumns = `repeat(${r.n}, minmax(0, 1fr))`;
      for (const id of r.ids) row.appendChild(this.blocks[id]);
      frag.appendChild(row);
    }
    col.textContent = '';
    col.appendChild(frag);
    col.classList.toggle('lcol-empty', !ids.length);
  }

  /** Hauteur de la plus basse rangée de jauges d'une colonne (Infinity s'il n'y en a pas). */
  _minRowH(ci) {
    let h = Infinity;
    for (const r of this.colEls[ci].querySelectorAll('.g-row')) h = Math.min(h, r.clientHeight);
    return h;
  }

  /** Classes selon la taille réelle des cartes (résumé large, pastilles, grandes jauges). */
  _sizeClasses() {
    const w = (id) => (this.blocks[id] ? this.blocks[id].clientWidth : 0);
    if (this.blocks.hero) this.blocks.hero.classList.toggle('wide', w('hero') >= 640);
    if (this.blocks.chips) {
      const cw = w('chips');
      this.blocks.chips.dataset.size = cw >= 640 ? 'row' : cw >= 380 ? 'grid' : 'list';
    }
    for (const row of this.root.querySelectorAll('.g-row')) {
      const h = row.clientHeight, w = row.clientWidth / Math.max(1, row.children.length);
      row.classList.toggle('g-big', h >= 230 && w >= 170);
      // Dernier recours (fenêtre très basse) : jauges compactes, jamais superposées.
      row.classList.toggle('g-compact', h < ROW_MIN_H);
    }
  }

  // ── Édition : poignée et bouton « masquer » sur chaque carte ──

  _addTools(el, id) {
    const tools = document.createElement('div');
    tools.className = 'blk-tools';
    tools.innerHTML = `<button type="button" class="blk-grip" aria-label="Déplacer : ${BLOCKS[id]}">${SVG_GRIP}</button>`
      + `<button type="button" class="blk-hide" aria-label="Masquer : ${BLOCKS[id]}">${SVG_HIDE}</button>`;
    el.appendChild(tools);
    tools.querySelector('.blk-hide').addEventListener('click', (e) => {
      e.stopPropagation();
      this._commit(hideBlock(this.layout, id));
    });
    tools.querySelector('.blk-grip').addEventListener('pointerdown', (e) => this._dragStart(e, id));
  }

  _dragStart(e, id) {
    if (!this.editing) return;
    e.preventDefault();
    const el = this.blocks[id];
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    el.classList.add('dragging');
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const place = (x, y) => { ghost.style.transform = `translate(${x - dx}px, ${y - dy}px)`; };
    place(e.clientX, e.clientY);
    let target = null;
    const move = (ev) => {
      place(ev.clientX, ev.clientY);
      target = this._target(ev.clientX, ev.clientY, id);
      this._showIndicator(target);
    };
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      ghost.remove();
      el.classList.remove('dragging');
      this.indicator.hidden = true;
      if (ev.type === 'pointerup' && target) this._commit(moveBlock(this.layout, id, target));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Où déposer : colonne, carte de référence, avant / après. null hors des colonnes. */
  _target(x, y, dragId) {
    const ci = this.colEls.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 40;
    });
    if (ci < 0) return null;
    const ids = this.layout.cols[ci].filter((b) => b !== dragId);
    let best = null;
    for (const b of ids) {
      const r = this.blocks[b].getBoundingClientRect();
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      const d = inside ? 0 : Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (!best || d < best.d) best = { d, b, r };
    }
    if (!best) return { col: ci, ref: null, after: false, rect: this.colEls[ci].getBoundingClientRect(), horiz: true, empty: true };
    // Jauge : avant / après selon x (rangée) ; carte large : selon y.
    const horiz = !isGauge(best.b);
    const after = horiz ? y > best.r.top + best.r.height / 2 : x > best.r.left + best.r.width / 2;
    return { col: ci, ref: best.b, after, rect: best.r, horiz };
  }

  _showIndicator(t) {
    const ind = this.indicator;
    if (!t) { ind.hidden = true; return; }
    const r = t.rect;
    ind.hidden = false;
    if (t.horiz) {
      const top = t.empty ? r.top + 4 : t.after ? r.bottom + 3 : r.top - 5;
      Object.assign(ind.style, { left: `${r.left}px`, top: `${top}px`, width: `${r.width}px`, height: '4px' });
    } else {
      const left = t.after ? r.right + 2 : r.left - 6;
      Object.assign(ind.style, { left: `${left}px`, top: `${r.top}px`, width: '4px', height: `${r.height}px` });
    }
  }
}
