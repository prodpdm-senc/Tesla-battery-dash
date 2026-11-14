import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecords, findKey, summarize, formatReport } from '../js/history.js';

test('findRecords trouve le tableau peu importe l\'enveloppe', () => {
  assert.equal(findRecords({ results: [{ a: 1 }] }).length, 1);
  assert.equal(findRecords({ states: [{ a: 1 }, { a: 2 }] }).length, 2);
  assert.equal(findRecords([{ a: 1 }]).length, 1);
  assert.equal(findRecords({ foo: [{ a: 1 }, { a: 2 }, { a: 3 }], bar: [1] }).length, 3);
  assert.equal(findRecords(null).length, 0);
});

test('findKey cherche dans les sous-objets', () => {
  const r = findKey({ charge_state: { charger_power: 120 } }, ['charger_power']);
  assert.deepEqual(r, { path: 'charge_state.charger_power', value: 120 });
  assert.equal(findKey({ a: { b: null } }, ['b']), null);
});

test('summarize : plat, timestamps en secondes', () => {
  const base = 1_700_000_000;
  const json = { results: [0, 30, 60, 90].map((dt, i) => ({
    timestamp: base + dt, module_temp_min: 20 + i, pack_voltage: 350, battery_level: 50,
  })) };
  const s = summarize(json);
  assert.equal(s.count, 4);
  assert.equal(s.medianIntervalS, 30);
  const f = Object.fromEntries(s.fields.map((x) => [x.name, x]));
  assert.equal(f['Temp. module min'].filled, 1);
  assert.equal(f['Courant pack'].path, null);
  assert.match(formatReport(s), /Intervalle médian : 30 s/);
});

test('summarize : imbriqué, timestamps ISO', () => {
  const json = { states: [
    { created_at: '2026-11-14T10:00:00Z', charge_state: { charger_power: 0 } },
    { created_at: '2026-11-14T10:05:00Z', charge_state: { charger_power: 150 } },
  ] };
  const s = summarize(json);
  assert.equal(s.medianIntervalS, 300);
  const f = Object.fromEntries(s.fields.map((x) => [x.name, x]));
  assert.equal(f['Puissance chargeur'].path, 'charge_state.charger_power');
});

test('summarize : réponse vide', () => {
  const s = summarize({});
  assert.equal(s.count, 0);
  assert.match(formatReport(s), /Points : 0/);
});
