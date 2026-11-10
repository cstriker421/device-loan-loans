import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createDevice } from '../domain/device';
import { buildUnits, CATALOGUE_MODEL_IDS } from './units';

test('buildUnits makes the requested number of units per model', () => {
  const units = buildUnits(CATALOGUE_MODEL_IDS, 3);
  assert.equal(units.length, 24);
  assert.equal(units.filter((u) => u.modelId === 'dm-001').length, 3);
});

test('unit ids and asset tags are unique, and every unit is valid', () => {
  const units = buildUnits(CATALOGUE_MODEL_IDS, 3);
  assert.equal(new Set(units.map((u) => u.id)).size, units.length);
  assert.equal(new Set(units.map((u) => u.assetTag)).size, units.length);
  units.forEach((u) => assert.equal(createDevice(u).status, 'available'));
});

test('buildUnits is deterministic, so re-seeding targets the same ids', () => {
  assert.deepEqual(buildUnits(['dm-001'], 2), [
    { id: 'dm-001-u1', modelId: 'dm-001', assetTag: 'TEES-001-1' },
    { id: 'dm-001-u2', modelId: 'dm-001', assetTag: 'TEES-001-2' },
  ]);
});
