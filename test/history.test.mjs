import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecords, findKey, summarize, formatReport, shape, columnarToRecords, singular } from '../js/history.js';

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

test('findRecords cherche dans un objet imbriqué', () => {
  assert.equal(findRecords({ results: { list: [{ a: 1 }, { a: 2 }] } }).length, 2);
  assert.equal(findRecords({ results: [], extra: { list: [{ a: 1 }] } }).length, 1);
});

test('shape décrit la structure sans les valeurs', () => {
  const sh = shape({ results: [{ timestamp: 1, latitude: 45.5, charge_state: { battery_level: 50 } }, {}] });
  assert.equal(sh, '{results: [2 × {timestamp, latitude, charge_state: {battery_level}}]}');
  assert.ok(!sh.includes('45.5'));
  assert.equal(shape({ results: [] }), '{results: [0]}');
});

test('singular', () => {
  assert.equal(singular('battery_levels'), 'battery_level');
  assert.equal(singular('ids'), 'id');
  assert.equal(singular('batteries'), 'battery');
  assert.equal(singular('pack_voltage'), 'pack_voltage');
});

test('format en colonnes de Tessie (réponse réelle observée)', () => {
  const base = 1_794_660_000;
  const json = { results: {
    ids: [1, 2, 3], timestamps: [base, base + 60, base + 120],
    states: ['online', 'online', 'online'], charging_states: ['Disconnected', 'Disconnected', 'Charging'],
    battery_levels: [57, 57, 58], module_temp_mins: [20, 21, 22], outside_temps: [5, 5, 6],
  } };
  const recs = findRecords(json);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs[2], { id: 3, timestamp: base + 120, state: 'online', charging_state: 'Charging', battery_level: 58, module_temp_min: 22, outside_temp: 6 });
  const s = summarize(json);
  assert.equal(s.count, 3);
  assert.equal(s.medianIntervalS, 60);
  const f = Object.fromEntries(s.fields.map((x) => [x.name, x]));
  assert.equal(f['Temp. module min'].filled, 1);
  assert.equal(f['État de recharge'].path, 'charging_state');
  assert.match(formatReport(s), /Colonnes \/ clés \(7\)/);
});

test('columnarToRecords ignore les listes de points et les objets simples', () => {
  assert.equal(columnarToRecords({ a: [{ x: 1 }], b: [{ x: 2 }] }), null);
  assert.equal(columnarToRecords({ a: 1 }), null);
});
