import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSample, gapThreshold, splitAtGaps, gapZones, intervals, FieldClock, formatAge,
  isActive, streamSilent, heatingPowerKw, sunTimes, isNight } from '../js/quality.js';
import { estimate, confidence } from '../js/estimator.js';
import { fastChargeStats } from '../js/sessions.js';
import { peakTrend } from '../js/sessionsView.js';

const MIN = 60000;

test('cleanSample : valeurs hors plage écartées', () => {
  const r = cleanSample(null, { t: 0, tempMin: 20, tempMax: 21, voltage: 4.68, current: 3, soc: 140, powerKw: 0.01 });
  assert.equal(r.sample.voltage, null);
  assert.equal(r.sample.soc, null);
  assert.equal(r.sample.powerKw, null); // recalculée sans la tension
  assert.equal(r.sample.tempMin, 20);
  assert.deepEqual(r.rejected.sort(), ['soc', 'voltage']);
});

test('cleanSample : saut de température impossible', () => {
  const prev = { t: 0, tempMin: 20, tempMax: 22 };
  assert.equal(cleanSample(prev, { t: 10000, tempMin: 27, tempMax: 22.5 }).sample.tempMin, null); // +7 °C en 10 s
  assert.equal(cleanSample(prev, { t: 10000, tempMin: 21, tempMax: 22.5 }).sample.tempMin, 21);
  assert.equal(cleanSample(prev, { t: 5 * MIN, tempMin: 28, tempMax: 30 }).sample.tempMin, 28);  // 8 °C en 5 min : possible
  assert.equal(cleanSample(prev, { t: 20 * MIN, tempMin: 45, tempMax: 46 }).sample.tempMin, 45); // longue pause : pas de comparaison
  assert.equal(cleanSample(prev, { t: 10000, tempMin: 27, tempMax: 28 }, { trust: ['tempMin', 'tempMax'] }).sample.tempMin, 27);
  // min au-dessus du max : paire écartée
  const r = cleanSample(null, { t: 0, tempMin: 30, tempMax: 20 });
  assert.equal(r.sample.tempMin, null);
  assert.equal(r.sample.tempMax, null);
});

test('splitAtGaps, gapZones, gapThreshold', () => {
  const pts = [0, 30, 60, 90, 1000, 1030].map((s) => ({ t: s * 1000 }));
  assert.equal(gapThreshold(pts), 5 * MIN);
  const segs = splitAtGaps(pts, 5 * MIN);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].length, 4);
  assert.deepEqual(gapZones(pts, 5 * MIN), [{ t0: 90000, t1: 1000000 }]);
  assert.equal(gapThreshold([0, 600, 1200, 1800].map((s) => ({ t: s * 1000 }))), 40 * MIN); // points aux 10 min
});

test('intervals : périodes de préconditionnement', () => {
  const p = (t, on) => ({ t: t * MIN, preconditioning: on });
  const z = intervals([p(0, false), p(1, true), p(2, true), p(3, false), p(4, true), p(20, true), p(21, true)], (s) => s.preconditioning);
  assert.deepEqual(z, [{ t0: 1 * MIN, t1: 3 * MIN }, { t0: 20 * MIN, t1: 21 * MIN }]);
});

test('FieldClock et formatAge', () => {
  const c = new FieldClock();
  c.note({ voltage: 350, current: null }, 1000);
  c.note({ current: 5 }, 5000);
  c.note({ voltage: 351 }, 500); // plus vieux : ignoré
  assert.equal(c.age(['voltage'], 61000), 60000);
  assert.equal(c.age(['voltage', 'current'], 61000), 60000);
  assert.equal(c.age(['soc'], 61000), null);
  assert.equal(formatAge(30000), 'à l’instant');
  assert.equal(formatAge(4 * MIN), 'il y a 4 min');
  assert.equal(formatAge(3 * 3600000), 'il y a 3 h');
});

test('streamSilent : seulement si l’auto est active', () => {
  const base = { open: true, openAt: 0, lastMsgAt: 60000, now: 60000 + 4 * MIN };
  assert.equal(streamSilent(Object.assign({}, base, { active: true })), true);
  assert.equal(streamSilent(Object.assign({}, base, { active: false })), false);
  assert.equal(streamSilent(Object.assign({}, base, { active: true, now: 60000 + 2 * MIN })), false);
  assert.equal(streamSilent(Object.assign({}, base, { active: true, open: false })), false);
  assert.equal(isActive({ shiftState: 'D' }), true);
  assert.equal(isActive({ preconditioning: true }), true);
  assert.equal(isActive({ shiftState: 'P', speed: 0 }), false);
});

test('heatingPowerKw : puissance moins la base stationnée', () => {
  const s = [];
  for (let i = 0; i < 10; i++) s.push({ t: i * MIN, powerKw: 0.5, shiftState: 'P', preconditioning: false });
  s.push({ t: 11 * MIN, powerKw: 7.5, shiftState: 'P', preconditioning: true });
  const h = heatingPowerKw(s);
  assert.equal(h.baseKw, 0.5);
  assert.equal(h.kw, 7);
  assert.equal(heatingPowerKw([{ t: 0, powerKw: 7, preconditioning: true, shiftState: 'P' }]).baseKw, 0.4); // base par défaut
  assert.equal(heatingPowerKw([{ t: 0, powerKw: 20, preconditioning: true, shiftState: 'D' }]), null);   // en roulant
  assert.equal(heatingPowerKw([{ t: 0, powerKw: 7, preconditioning: false }]), null);
});

test('sunTimes / isNight (Montréal)', () => {
  const lat = 45.5, lon = -73.57;
  // 21 juin 2026 : lever ~ 9 h 05 UTC, coucher ~ 0 h 45 UTC (le lendemain)
  const s = sunTimes(Date.UTC(2026, 5, 21, 16), lat, lon);
  assert.ok(Math.abs(s.rise - Date.UTC(2026, 5, 21, 9, 5)) < 20 * MIN);
  assert.ok(Math.abs(s.set - Date.UTC(2026, 5, 22, 0, 47)) < 20 * MIN);
  assert.equal(isNight(Date.UTC(2026, 5, 21, 16), lat, lon), false); // midi
  assert.equal(isNight(Date.UTC(2026, 5, 22, 0, 15), lat, lon), false); // 20 h 15 en été : encore jour
  assert.equal(isNight(Date.UTC(2026, 5, 22, 3), lat, lon), true);     // 23 h
  assert.equal(isNight(Date.UTC(2026, 11, 21, 22), lat, lon), true);   // 17 h en hiver : nuit
});

test('estimate : confiance de l’ETA', () => {
  // Chauffe régulière de 0,5 °C/min pendant 8 min : confiance ok.
  const reg = [];
  for (let i = 0; i <= 16; i++) reg.push({ t: i * 30000, tempMin: 10 + i * 0.25 });
  const a = estimate(reg, { target: 30, windowMin: 5 });
  assert.equal(a.status, 'heating');
  assert.equal(a.confidence, 'ok');
  // Seulement 2 min de données : incertaine.
  const b = estimate(reg.slice(0, 5), { target: 30, windowMin: 5 });
  assert.equal(b.confidence, 'low');
  assert.equal(confidence({ status: 'stable' }, 10 * MIN), null);
  assert.equal(confidence({ status: 'heating', r2: 0.9, etaMs: 10 * MIN, etaLowMs: 8 * MIN, etaHighMs: Infinity }, 10 * MIN), 'low');
});

test('fastChargeStats : minutes ≥ 100 kW et kWh après 10/20/30 min', () => {
  const pts = [{ t: 0, chargerPowerKw: 1 }];
  for (let m = 1; m <= 25; m++) pts.push({ t: m * MIN, chargerPowerKw: m <= 15 ? 120 : 60 });
  const f = fastChargeStats(pts);
  // Intervalles entièrement à 120 kW : de 1 à 15 min = 14 min, plus 15→16 (moyenne 90 : non).
  assert.equal(f.minAbove100, 14);
  // Départ au premier point ≥ 5 kW (t = 1 min). 10 min à 120 kW = 20 kWh.
  assert.ok(Math.abs(f.kwhAfter[10] - 20) < 1e-9);
  assert.ok(Math.abs(f.kwhAfter[20] - (14 * 2 + 1.5 + 5 * 1)) < 1e-9); // 14 min à 120, 1 min de 120→60 (moy. 90), 5 min à 60
  assert.equal(f.kwhAfter[30], null);
});

test('peakTrend : kW par °C', () => {
  const c = [{ tempStart: 10, peakKw: 80 }, { tempStart: 20, peakKw: 120 }, { tempStart: 30, peakKw: 160 }];
  const t = peakTrend(c);
  assert.ok(Math.abs(t.slope - 4) < 1e-9);
  assert.equal(t.n, 3);
  assert.equal(peakTrend(c.slice(0, 2)), null);
  assert.equal(peakTrend([{ tempStart: 20, peakKw: 1 }, { tempStart: 21, peakKw: 2 }, { tempStart: 20.5, peakKw: 3 }]), null);
});
