import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, BLOCKS, normalize, moveBlock, hideBlock, showBlock, packRows } from '../js/layout.js';

const all = (l) => l.cols[0].concat(l.cols[1], l.hidden).sort();

test('les dispositions de départ contiennent chaque carte une fois', () => {
  for (const k of Object.keys(PRESETS)) assert.deepEqual(all(normalize(PRESETS[k])), Object.keys(BLOCKS).sort(), k);
});

test('normalize : doublons et inconnues retirés, cartes manquantes ajoutées, split borné', () => {
  const l = normalize({ split: 99, cols: [['hero', 'hero', 'xyz'], ['temp']], hidden: ['temp', 'motor'] });
  assert.deepEqual(l.cols[0], ['hero']);
  assert.deepEqual(l.cols[1].slice(0, 1), ['temp']);
  assert.deepEqual(l.hidden, ['motor']);
  assert.deepEqual(all(l), Object.keys(BLOCKS).sort());
  assert.equal(l.split, 80);
  assert.deepEqual(normalize(null, PRESETS.dash).cols, PRESETS.dash.cols); // stockage vide ou illisible
});

test('moveBlock : avant / après une carte, vers l’autre colonne, à la fin', () => {
  const l = normalize(PRESETS.graphs);
  let m = moveBlock(l, 'g-power', { col: 1, ref: 'g-voltage' });
  assert.deepEqual(m.cols[1].slice(0, 4), ['chips', 'g-battery', 'g-power', 'g-voltage']);
  m = moveBlock(l, 'g-voltage', { col: 1, ref: 'g-soc', after: true });
  assert.deepEqual(m.cols[1], ['chips', 'g-battery', 'g-current', 'g-power', 'g-soc', 'g-voltage', 'g-charger']);
  m = moveBlock(l, 'temp', { col: 1 });
  assert.deepEqual(m.cols[0], ['hero', 'motor']);
  assert.equal(m.cols[1][m.cols[1].length - 1], 'temp');
  m = moveBlock(l, 'chips', { col: 0, ref: 'hero' });
  assert.deepEqual(m.cols[0], ['chips', 'hero', 'temp', 'motor']);
  assert.deepEqual(l.cols[0], ['hero', 'temp', 'motor']); // original intact
});

test('hideBlock / showBlock', () => {
  let l = hideBlock(normalize(PRESETS.graphs), 'g-charger');
  assert.deepEqual(l.hidden, ['g-outside', 'g-charger']);
  assert.equal(l.cols[1].indexOf('g-charger'), -1);
  l = showBlock(l, 'g-charger');
  assert.deepEqual(l.hidden, ['g-outside']);
  assert.equal(l.cols[0][l.cols[0].length - 1], 'g-charger'); // colonne la moins remplie
});

test('migration : la jauge Batterie prend la place d’Extérieur dans une disposition enregistrée', () => {
  const old = { split: 58, cols: [['chips', 'g-voltage', 'g-outside', 'g-soc'], ['hero', 'temp']], hidden: ['motor'] };
  const l = normalize(old, PRESETS.dash);
  assert.deepEqual(l.cols[0], ['chips', 'g-voltage', 'g-battery', 'g-soc']);
  assert.deepEqual(l.hidden.slice(0, 2), ['motor', 'g-outside']);
  // Extérieur déjà masquée : Batterie à la fin de la colonne de droite
  const l2 = normalize({ split: 60, cols: [['hero'], ['g-soc']], hidden: ['g-outside'] });
  assert.equal(l2.cols[1][1], 'g-battery');
  // Disposition qui a déjà la jauge : inchangée
  assert.deepEqual(normalize(l).cols, l.cols);
});

test('packRows : cartes larges seules, jauges en rangées équilibrées', () => {
  const r = packRows(['chips', 'g-battery', 'g-voltage', 'g-current', 'g-power', 'g-soc', 'g-charger', 'hero'], 4);
  assert.deepEqual(r.map((x) => x.ids.length), [1, 3, 3, 1]);
  assert.equal(r[1].n, 3);
  assert.deepEqual(packRows(['g-voltage', 'g-current'], 4).map((x) => x.n), [2]);
  assert.deepEqual(packRows(['g-voltage', 'g-current', 'g-power'], 1).map((x) => x.ids.length), [1, 1, 1]);
  assert.deepEqual(packRows(['g-voltage', 'temp', 'g-power'], 3).map((x) => x.ids), [['g-voltage'], ['temp'], ['g-power']]);
});
