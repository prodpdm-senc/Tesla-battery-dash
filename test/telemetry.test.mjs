import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredFields, withStatorField, findStatorValues, pickStatorTemp, findDriveValues, configFlags, itemValue } from '../js/telemetry.js';

const tessieConfig = {
  synced: true,
  config: {
    hostname: 'telemetry.example',
    exp: 1800000000,
    fields: { BatteryLevel: { interval_seconds: 60 }, Location: { interval_seconds: 60 } },
    alert_types: ['service'],
  },
};

test('configuredFields lit les champs, où qu\'ils soient', () => {
  assert.deepEqual(configuredFields(tessieConfig), ['BatteryLevel', 'Location']);
  assert.deepEqual(configuredFields({}), []);
});

test('withStatorField ajoute le champ sans rien retirer', () => {
  const body = withStatorField(tessieConfig);
  assert.deepEqual(Object.keys(body.fields), ['BatteryLevel', 'Location', 'DiStatorTempR', 'DiInverterTR', 'DiHeatsinkTR']);
  assert.deepEqual(body.fields.DiStatorTempR, { interval_seconds: 60 });
  // Seulement { fields } : le serveur, le certificat, l'expiration, etc. ne sont jamais renvoyés.
  assert.deepEqual(Object.keys(body), ['fields']);
  assert.equal(tessieConfig.config.fields.DiStatorTempR, undefined); // original intact
});

test('withStatorField refuse une configuration illisible ou vide', () => {
  assert.equal(withStatorField({}), null);
  assert.equal(withStatorField({ config: { fields: {} } }), null);
});

test('withStatorField ne modifie pas un champ déjà présent', () => {
  const cfg = { fields: { DiStatorTempR: { interval_seconds: 300 }, X: {} } };
  assert.deepEqual(withStatorField(cfg).fields.DiStatorTempR, { interval_seconds: 300 });
});

test('findStatorValues et pickStatorTemp (préférence pour l\'arrière)', () => {
  const st = { drive_state: { di_stator_temp_f: 25 }, motor: { DiStatorTempR: 61.5, DiStatorTempREL: 40 } };
  assert.equal(findStatorValues(st).length, 3);
  assert.equal(pickStatorTemp(st), 61.5);
  assert.equal(pickStatorTemp({ di_stator_temp_r: '48' }), 48);
  assert.equal(pickStatorTemp({ stator_temp: 999 }), null); // absurde
  assert.equal(pickStatorTemp({}), null);
});

test('onduleur et dissipateur arrière', () => {
  const st = { DiInverterTF: 20, DiInverterTR: 55, DiInverterTREL: 30, DiHeatsinkTR: 41.5, DiStatorTempR: 70 };
  assert.equal(pickStatorTemp(st, 'inverter'), 55);
  assert.equal(pickStatorTemp(st, 'heatsink'), 41.5);
  assert.equal(pickStatorTemp(st), 70);
  assert.equal(findDriveValues(st).length, 5);
});

test('configFlags : seulement les indicateurs simples', () => {
  const f = configFlags({ synced: true, limit_reached: false, key_paired: true, config: { ca: 'secret' }, last_signal_at: 1794661659 });
  assert.deepEqual(f, { synced: true, limit_reached: false, key_paired: true, last_signal_at: 1794661659 });
});

test('flux en direct : paires { key, value } (format réel observé)', () => {
  const msg = { vin: 'X', createdAt: '2026-11-14T19:20:00Z', isResend: false, data: [
    { key: 'PackCurrent', value: -12 },
    { key: 'DiStatorTempR', value: { doubleValue: 63.5 } },
    { key: 'DiInverterTR', value: '48.25' },
    { key: 'DiHeatsinkTR', value: 40 },
    { key: 'DiStatorTempF', value: 21 },
  ] };
  assert.equal(pickStatorTemp(msg), 63.5);
  assert.equal(pickStatorTemp(msg, 'inverter'), 48.25);
  assert.equal(pickStatorTemp(msg, 'heatsink'), 40);
  assert.equal(findDriveValues(msg).length, 4);
  assert.equal(findStatorValues({ data: [{ key: 'PackCurrent', value: 3 }] }).length, 0);
});

test('itemValue', () => {
  assert.equal(itemValue(5), 5);
  assert.equal(itemValue('5.5'), 5.5);
  assert.equal(itemValue({ floatValue: 7 }), 7);
  assert.equal(itemValue({ invalid: true }), null);
  assert.equal(itemValue(''), null);
});

import { motorFromMessage, attachMotor } from '../js/telemetry.js';

test('motorFromMessage : message du flux → températures du moteur', () => {
  const m = motorFromMessage({ createdAt: '2026-11-14T19:30:00Z', data: [{ key: 'DiStatorTempR', value: 24 }, { key: 'DiInverterTR', value: 25 }] });
  assert.equal(m.statorTemp, 24);
  assert.equal(m.inverterTemp, 25);
  assert.equal(m.heatsinkTemp, null);
  assert.equal(m.t, Date.parse('2026-11-14T19:30:00Z'));
  assert.equal(motorFromMessage({ data: [{ key: 'PackCurrent', value: 3 }] }), null);
});

test('attachMotor : seulement si récent et sans écraser', () => {
  const motor = { t: 100000, statorTemp: 60, inverterTemp: 45, heatsinkTemp: null };
  assert.equal(attachMotor({ t: 130000 }, motor).statorTemp, 60);
  assert.equal(attachMotor({ t: 130000, statorTemp: 55 }, motor).statorTemp, 55);
  assert.equal(attachMotor({ t: 100000 + 10 * 60000 }, motor).statorTemp, undefined);
});
