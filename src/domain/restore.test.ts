import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { restoreDevice, restoreLoan } from './restore';
import { DomainValidationError } from './errors';

const storedLoan = {
  id: 'loan-1',
  deviceId: 'dev-1',
  modelId: 'dm-001',
  studentId: 'auth0|student1',
  idempotencyKey: 'key-12345678',
  status: 'reserved',
  reservedAt: '2026-11-10T09:00:00.000Z',
  dueAt: '2026-11-12T09:00:00.000Z',
};

test('restoreDevice accepts any valid stored status', () => {
  const d = restoreDevice({ id: 'dev-1', modelId: 'dm-001', assetTag: 'T1', status: 'on-loan' });
  assert.equal(d.status, 'on-loan');
  assert.ok(Object.isFrozen(d));
});

test('restoreDevice rejects bad stored data, naming every problem', () => {
  assert.throws(
    () => restoreDevice({ id: 'bad id', modelId: 'dm-001', assetTag: 'T1', status: 'broken' }),
    (e: unknown) => e instanceof DomainValidationError && e.issues.length === 2,
  );
});

test('restoreLoan rebuilds reserved, collected and returned loans', () => {
  assert.equal(restoreLoan(storedLoan).status, 'reserved');
  const collected = restoreLoan({
    ...storedLoan, status: 'collected',
    collectedAt: '2026-11-10T10:00:00.000Z', collectedBy: 'auth0|staff1',
  });
  assert.equal(collected.collectedBy, 'auth0|staff1');
  const returned = restoreLoan({
    ...storedLoan, status: 'returned',
    collectedAt: '2026-11-10T10:00:00.000Z', collectedBy: 'auth0|staff1',
    returnedAt: '2026-11-11T10:00:00.000Z', returnedBy: 'auth0|staff2',
  });
  assert.equal(returned.returnedBy, 'auth0|staff2');
});

test('restoreLoan rejects inconsistent stored loans', () => {
  assert.throws(() => restoreLoan({ ...storedLoan, status: 'collected' }), DomainValidationError);
  assert.throws(
    () => restoreLoan({ ...storedLoan, status: 'returned', collectedAt: '2026-11-10T10:00:00.000Z', collectedBy: 's1' }),
    DomainValidationError,
  );
  assert.throws(
    () => restoreLoan({ ...storedLoan, collectedAt: '2026-11-10T10:00:00.000Z', collectedBy: 's1' }),
    DomainValidationError,
  );
  assert.throws(() => restoreLoan({ ...storedLoan, status: 'lost' }), DomainValidationError);
  assert.throws(() => restoreLoan({ ...storedLoan, reservedAt: 'yesterday' }), DomainValidationError);
});
