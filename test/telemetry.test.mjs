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
  assert.deepEqual(Object.keys(body.fields), ['BatteryLevel', 'Location', 'DiStatorTempR', 'DiHeatsinkTR']);
  assert.deepEqual(body.fields.DiStatorTempR, { interval_seconds: 30 });
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
  const m = motorFromMessage({ createdAt: '2026-11-14T19:30:00Z', data: [{ key: 'DiStatorTempR', value: 24 }, { key: 'DiInverterTR', value: 25 }, { key: 'DiHeatsinkTR', value: 23 }] });
  assert.equal(m.statorTemp, 24);
  assert.equal(m.heatsinkTemp, 23);
  assert.equal('inverterTemp' in m, false); // onduleur plus lu
  assert.equal(motorFromMessage({ data: [{ key: 'DiInverterTR', value: 25 }] }), null);
  assert.equal(m.t, Date.parse('2026-11-14T19:30:00Z'));
  assert.equal(motorFromMessage({ data: [{ key: 'PackCurrent', value: 3 }] }), null);
});

test('attachMotor : seulement si récent et sans écraser', () => {
  const motor = { t: 100000, statorTemp: 60, heatsinkTemp: null };
  assert.equal(attachMotor({ t: 130000 }, motor).statorTemp, 60);
  assert.equal(attachMotor({ t: 130000, statorTemp: 55 }, motor).statorTemp, 55);
  assert.equal(attachMotor({ t: 100000 + 10 * 60000 }, motor).statorTemp, undefined);
});

import { streamPatch, streamErrors, applyPatch, itemBool } from '../js/telemetry.js';

// Exemple tiré de la documentation de Tessie (Access Tesla Fleet Telemetry).
const docMsg = { data: [
  { key: 'IdealBatteryRange', value: { stringValue: '171.833' } },
  { key: 'ModuleTempMax', value: { stringValue: '41.500' } },
  { key: 'EnergyRemaining', value: { stringValue: '42.880' } },
  { key: 'Location', value: { locationValue: { latitude: 37.49, longitude: -121.94 } } },
  { key: 'PackVoltage', value: { stringValue: '367.950' } },
  { key: 'ACChargingPower', value: { stringValue: '0.000' } },
  { key: 'PackCurrent', value: { stringValue: '-0.600' } },
  { key: 'ModuleTempMin', value: { stringValue: '41.000' } },
  { key: 'Soc', value: { stringValue: '54.987' } },
], createdAt: '2024-08-01T00:44:39.138713677Z', vin: 'X' };

test('streamPatch : exemple de la doc Tessie', () => {
  const p = streamPatch(docMsg);
  assert.equal(p.t, Date.parse('2024-08-01T00:44:39.138Z'));
  assert.deepEqual(p.patch, { tempMin: 41, tempMax: 41.5, voltage: 367.95, current: 0.6, soc: 54.987, energyKwh: 42.88, chargerPowerKw: 0 });
  assert.equal(streamPatch({ alerts: [] }), null);
  assert.equal(streamPatch({ data: [{ key: 'Location', value: { locationValue: {} } }] }), null);
});

test('streamPatch : moteur et chauffage', () => {
  const p = streamPatch({ createdAt: '2026-11-14T20:00:00Z', data: [
    { key: 'DiStatorTempR', value: { stringValue: '70.0' } }, { key: 'BatteryHeaterOn', value: { booleanValue: true } }] });
  assert.equal(p.patch.statorTemp, 70);
  assert.equal(p.patch.heaterOn, true);
  assert.equal(itemBool({ booleanValue: false }), false);
});

test('streamErrors', () => {
  assert.deepEqual(streamErrors({ errors: [{ name: 'unsupported_field', tags: { field_name: 'DiStatorTempR' } }] }), ['unsupported_field (DiStatorTempR)']);
  assert.deepEqual(streamErrors(docMsg), []);
});

test('applyPatch : complète la dernière mesure, une nouvelle au plus toutes les 10 s', () => {
  const s = [{ t: 0, tempMin: 20, tempMax: 21, voltage: 350, current: 10, powerKw: 3.5, preconditioning: true, fromHistory: true }];
  let r = applyPatch(s, { t: 5000, patch: { tempMin: 20.5 } });
  assert.equal(r.added, false);
  assert.equal(s.length, 1);
  assert.equal(s[0].tempMin, 20.5);
  r = applyPatch(s, { t: 15000, patch: { current: 20 } });
  assert.equal(r.added, true);
  assert.equal(s.length, 2);
  assert.equal(s[1].tempMax, 21);              // repris de la mesure précédente
  assert.equal(s[1].preconditioning, true);
  assert.equal(s[1].powerKw, 7);               // 350 V × 20 A
  assert.equal(s[1].fromHistory, undefined);
});

import { driveFieldsStatus } from '../js/telemetry.js';

test('withStatorField force : intervalle choisi, champs existants gardés', () => {
  const cfg = { config: { fields: { BatteryLevel: { interval_seconds: 60 }, DiStatorTempR: { interval_seconds: 60, foo: 1 } } } };
  const body = withStatorField(cfg, ['DiStatorTempR', 'DiHeatsinkTR'], 10, { force: true });
  assert.deepEqual(body.fields.DiStatorTempR, { interval_seconds: 10, foo: 1 });
  assert.deepEqual(body.fields.DiHeatsinkTR, { interval_seconds: 10 });
  assert.deepEqual(body.fields.BatteryLevel, { interval_seconds: 60 });
  assert.deepEqual(withStatorField(cfg, ['DiStatorTempR'], 10).fields.DiStatorTempR, { interval_seconds: 60, foo: 1 }); // sans force : inchangé
});

test('driveFieldsStatus : absents, autre intervalle, ok', () => {
  const cfg = { config: { fields: { DiStatorTempR: { interval_seconds: 30 } } } };
  assert.deepEqual(driveFieldsStatus(cfg).missing, ['DiHeatsinkTR']);
  const both = { config: { fields: { DiStatorTempR: { interval_seconds: 30 }, DiHeatsinkTR: { interval_seconds: 60 } } } };
  assert.equal(driveFieldsStatus(both).ok, true);
  assert.deepEqual(driveFieldsStatus(both, 30).otherInterval, ['DiHeatsinkTR']);
  assert.equal(driveFieldsStatus({}).missing.length, 2);
});

import { signalRate } from '../js/telemetry.js';
import { errorDetail } from '../js/tessie.js';

test('signalRate : somme de 1 / intervalle', () => {
  const r = signalRate({ config: { fields: { A: { interval_seconds: 10 }, B: { interval_seconds: 60 }, C: {} } } });
  assert.ok(Math.abs(r.rate - (0.1 + 1 / 60)) < 1e-12);
  assert.equal(r.n, 3);
  assert.deepEqual(r.noInterval, ['C']);
  assert.equal(signalRate({ fields: { A: { interval_seconds: 1 } } }).rate, 1); // corps envoyé { fields }
});

test('errorDetail : explication courte de Tessie', () => {
  assert.equal(errorDetail('{"error":"Rate limit exceeded: max 1 signal per second"}'), 'Rate limit exceeded: max 1 signal per second');
  assert.equal(errorDetail('<html><body>Bad  Request</body></html>'), 'Bad Request');
  assert.equal(errorDetail(''), '');
  assert.equal(errorDetail('x'.repeat(300)).length, 241);
});
