import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChargingSessions, detectHeatingSessions, linkHeatingToCharging } from '../js/sessions.js';

const MIN = 60000;
const q = (v) => Math.round(v * 2) / 2;

/** Journée type : arrêt, chauffe en roulant 25 min (+1 °C/min), recharge DC 30 min. */
function day({ everySec = 30 } = {}) {
  const s = [];
  let T = 10;
  for (let sec = 0; sec <= 90 * 60; sec += everySec) {
    const m = sec / 60;
    let o = { t: sec * 1000, soc: 30, shiftState: 'P', speed: 0, chargingState: 'Disconnected', chargerPowerKw: 0, outsideTemp: 2, powerKw: 0.3 };
    if (m >= 10 && m < 35) { T += everySec / 60; o = { ...o, shiftState: 'D', speed: 90, powerKw: 25 }; }   // chauffe en roulant
    if (m >= 35 && m < 40) { o = { ...o, shiftState: 'D', speed: 40, powerKw: 10 }; }
    if (m >= 40 && m < 70) {                                                                          // recharge DC
      const k = m - 40;
      o = { ...o, chargingState: 'Charging', chargerPowerKw: k < 10 ? 160 : 160 - (k - 10) * 4, soc: Math.round(30 + k * 1.6), powerKw: -150, chargeEnergyAdded: k * 1.4 };
    }
    s.push({ ...o, tempMin: q(T), tempMax: q(T + 1) });
  }
  return s;
}

test('recharge DC détectée avec énergie, pic, SOC et courbe', () => {
  const [c, ...rest] = detectChargingSessions(day());
  assert.equal(rest.length, 0);
  assert.equal(c.dc, true);
  assert.equal(c.peakKw, 160);
  assert.equal(c.socStart, 30);
  assert.ok(c.socEnd >= 75);
  assert.ok(Math.abs(c.energyKwh - 29.5 * 1.4) < 1, `énergie ${c.energyKwh}`);
  assert.ok(c.curve.length > 50);
  assert.equal(c.tempStart, 35);
});

test('chauffe en roulant détectée (pas d\'énergie de chauffe quand on roule)', () => {
  const [h, ...rest] = detectHeatingSessions(day());
  assert.equal(rest.length, 0);
  assert.equal(h.moving, true);
  assert.equal(h.energyKwh, null);
  assert.ok(h.tempStart <= 11 && h.tempEnd >= 34, `${h.tempStart} → ${h.tempEnd}`);
  assert.ok(Math.abs(h.ratePerMin - 1) < 0.2, `taux ${h.ratePerMin}`);
});

test('chauffe à l\'arrêt : énergie intégrée', () => {
  const s = [];
  for (let sec = 0; sec <= 20 * 60; sec += 30) s.push({ t: sec * 1000, tempMin: q(10 + sec / 60 * 0.8), powerKw: 7, shiftState: 'P', speed: 0, chargingState: 'Disconnected' });
  const [h] = detectHeatingSessions(s);
  assert.equal(h.moving, false);
  assert.ok(Math.abs(h.energyKwh - 7 * 20 / 60) < 0.3, `énergie ${h.energyKwh}`);
});

test('montée lente en roulant : pas une chauffe', () => {
  const s = [];
  for (let sec = 0; sec <= 40 * 60; sec += 30) s.push({ t: sec * 1000, tempMin: q(15 + sec / 60 * 0.08), speed: 100, shiftState: 'D', powerKw: 20 });
  assert.equal(detectHeatingSessions(s).length, 0);
});

test('historique espacé (5 min) : la fenêtre s\'adapte', () => {
  const s = [];
  for (let m = 0; m <= 60; m += 5) s.push({ t: m * MIN, tempMin: m < 30 ? 10 + m : 40, shiftState: 'P', powerKw: 7 });
  assert.equal(detectHeatingSessions(s).length, 1);
});

test('chauffe reliée à la recharge qui suit', () => {
  const d = day();
  const heats = linkHeatingToCharging(detectHeatingSessions(d), detectChargingSessions(d));
  assert.ok(heats[0].nextCharge);
  assert.equal(heats[0].nextCharge.peakKw, 160);
});

test('rien à détecter sur un historique vide', () => {
  assert.deepEqual(detectChargingSessions([]), []);
  assert.deepEqual(detectHeatingSessions([]), []);
});
