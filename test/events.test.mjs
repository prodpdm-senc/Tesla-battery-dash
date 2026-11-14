import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHeatingEnd } from '../js/events.js';

const base = { t: 0, tempMin: 48, tempMax: 49, heaterOn: false, preconditioning: true, powerKw: 12.9, shiftState: 'P', speed: null };
const next = (o) => ({ ...base, t: 30000, tempMin: 48.5, tempMax: 49.5, ...o });

test('chute de puissance pendant le préconditionnement (drapeau chauffage toujours faux)', () => {
  const r = detectHeatingEnd(base, next({ powerKw: 0.9 }));
  assert.equal(r.reason, 'chute de puissance');
  assert.equal(r.tempMin, 48); // température du dernier point en chauffe
});

test('fin du drapeau de préconditionnement', () => {
  const r = detectHeatingEnd(base, next({ preconditioning: false, powerKw: 0.4 }));
  assert.equal(r.reason, 'fin du préconditionnement');
});

test('fin du drapeau de chauffage', () => {
  const r = detectHeatingEnd({ ...base, heaterOn: true, preconditioning: false }, next({ heaterOn: false, preconditioning: false }));
  assert.equal(r.reason, 'chauffage arrêté');
});

test('pas de détection en roulant (la puissance de conduite fausse le critère)', () => {
  assert.equal(detectHeatingEnd({ ...base, shiftState: 'D', speed: 80 }, next({ powerKw: 0.5, shiftState: 'D', speed: 60 })), null);
});

test('pas de détection pendant une recharge', () => {
  assert.equal(detectHeatingEnd(base, next({ powerKw: -150, chargingState: 'Charging' })), null);
});

test('petite variation de puissance : rien', () => {
  assert.equal(detectHeatingEnd(base, next({ powerKw: 9 })), null);
});

test('anti-doublon : pas deux détections en 10 min', () => {
  assert.equal(detectHeatingEnd(base, next({ powerKw: 0.9 }), { t: 0 }), null);
  assert.ok(detectHeatingEnd(base, next({ powerKw: 0.9, t: 11 * 60000 }), { t: 0 }));
});
