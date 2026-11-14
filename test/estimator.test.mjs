import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearFit, estimate, pickTemp, formatDuration } from '../js/estimator.js';

const MIN = 60_000;
const q = (v) => Math.round(v * 2) / 2; // quantification 0,5 °C comme le BMS

function ramp({ start = 20, rate = 0.8, minutes = 10, everySec = 30, quantize = true } = {}) {
  const out = [];
  for (let s = 0; s <= minutes * 60; s += everySec) {
    const v = start + rate * (s / 60);
    const y = quantize ? q(v) : v;
    out.push({ t: s * 1000, tempMin: y, tempMax: y + 1 });
  }
  return out;
}

test('linearFit retrouve une pente exacte', () => {
  const fit = linearFit([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 1);
  assert.equal(fit.r2, 1);
});

test('linearFit refuse les données dégénérées', () => {
  assert.equal(linearFit([{ x: 1, y: 1 }]), null);
  assert.equal(linearFit([{ x: 1, y: 1 }, { x: 1, y: 2 }]), null);
});

test('pickTemp selon la métrique', () => {
  const s = { tempMin: 20, tempMax: 24 };
  assert.equal(pickTemp(s, 'min'), 20);
  assert.equal(pickTemp(s, 'max'), 24);
  assert.equal(pickTemp(s, 'avg'), 22);
  assert.equal(pickTemp({ tempMax: 24 }, 'min'), 24);
  assert.equal(pickTemp({}, 'min'), null);
});

test('ETA juste malgré la quantification 0,5 °C', () => {
  // 20 °C → 0,8 °C/min. Après 10 min ≈ 28 °C ; cible 40 → ≈ 15 min.
  const r = estimate(ramp(), { target: 40 });
  assert.equal(r.status, 'heating');
  assert.ok(Math.abs(r.rate - 0.8) < 0.05, `pente ${r.rate}`);
  assert.ok(Math.abs(r.etaMs / MIN - 15) < 1.5, `eta ${r.etaMs / MIN}`);
  assert.ok(r.etaLowMs <= r.etaMs && r.etaMs <= r.etaHighMs);
});

test('cible atteinte', () => {
  const r = estimate(ramp(), { target: 25 });
  assert.equal(r.status, 'reached');
  assert.equal(r.etaMs, 0);
});

test('pas assez de données', () => {
  const r = estimate(ramp({ minutes: 0.5 }), { target: 40 });
  assert.equal(r.status, 'insufficient');
});

test('température stable ou en baisse → pas d\'ETA', () => {
  assert.equal(estimate(ramp({ rate: 0 }), { target: 40 }).status, 'stable');
  const c = estimate(ramp({ rate: -0.5, start: 30 }), { target: 40 });
  assert.equal(c.status, 'cooling');
  assert.equal(c.etaMs, null);
});

test('le lissage EMA amortit un changement brusque', () => {
  const r = estimate(ramp(), { target: 40, alpha: 0.4 }, 0.2);
  assert.ok(r.rateSmoothed > 0.2 && r.rateSmoothed < r.rate);
});

test('ignore les échantillons sans température', () => {
  const s = ramp();
  s.push({ t: s.at(-1).t + 30_000 });
  assert.equal(estimate(s, { target: 40 }).status, 'heating');
});

test('formatDuration', () => {
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(12 * MIN), '12 min');
  assert.equal(formatDuration(65 * MIN), '1 h 05');
  assert.equal(formatDuration(Infinity), '—');
  assert.equal(formatDuration(null), '—');
});
