import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  collectDevice,
  createDevice,
  releaseDevice,
  reserveDevice,
  returnDevice,
} from './device';
import {
  collectLoan,
  createLoan,
  isOverdue,
  LOAN_PERIOD_DAYS,
  returnLoan,
} from './loan';
import { DomainValidationError, InvalidTransitionError } from './errors';

const NOW = new Date('2026-11-10T09:00:00.000Z');
const newLoan = () =>
  createLoan(
    {
      id: 'loan-1',
      deviceId: 'dev-1',
      modelId: 'dm-001',
      studentId: 'auth0|student1',
      idempotencyKey: 'key-12345678',
    },
    NOW,
  );

test('createDevice returns an available, frozen device', () => {
  const d = createDevice({ id: 'dev-1', modelId: 'dm-001', assetTag: 'TEES-0001' });
  assert.equal(d.status, 'available');
  assert.ok(Object.isFrozen(d));
});

test('createDevice reports every problem at once', () => {
  assert.throws(
    () => createDevice({ id: 'bad id', modelId: '', assetTag: 'x'.repeat(40) }),
    (e: unknown) => e instanceof DomainValidationError && e.issues.length === 3,
  );
});

test('device follows reserve -> collect -> return -> reserve again', () => {
  let d = createDevice({ id: 'dev-1', modelId: 'dm-001', assetTag: 'T1' });
  d = reserveDevice(d);
  assert.equal(d.status, 'reserved');
  d = collectDevice(d);
  assert.equal(d.status, 'on-loan');
  d = returnDevice(d);
  assert.equal(d.status, 'available');
  assert.equal(reserveDevice(d).status, 'reserved');
});

test('a reservation can be released', () => {
  const d = reserveDevice(createDevice({ id: 'dev-1', modelId: 'dm-001', assetTag: 'T1' }));
  assert.equal(releaseDevice(d).status, 'available');
});

test('device rejects out-of-order transitions', () => {
  const d = createDevice({ id: 'dev-1', modelId: 'dm-001', assetTag: 'T1' });
  assert.throws(() => reserveDevice(reserveDevice(d)), InvalidTransitionError);
  assert.throws(() => collectDevice(d), InvalidTransitionError);
  assert.throws(() => returnDevice(d), InvalidTransitionError);
  assert.throws(() => releaseDevice(d), InvalidTransitionError);
});

test('transitions return a new object and leave the original unchanged', () => {
  const d = createDevice({ id: 'dev-1', modelId: 'dm-001', assetTag: 'T1' });
  const reserved = reserveDevice(d);
  assert.equal(d.status, 'available');
  assert.notEqual(d, reserved);
});

test('createLoan is reserved and due exactly 48 hours after reservation', () => {
  const l = newLoan();
  assert.equal(l.status, 'reserved');
  assert.equal(l.reservedAt, '2026-11-10T09:00:00.000Z');
  assert.equal(l.dueAt, '2026-11-12T09:00:00.000Z');
  assert.equal(LOAN_PERIOD_DAYS, 2);
  assert.equal(l.collectedAt, undefined);
});

test('createLoan validates input and the clock', () => {
  assert.throws(
    () => createLoan({ id: 'l', deviceId: 'd', modelId: 'm', studentId: '', idempotencyKey: 'short' }, NOW),
    (e: unknown) => e instanceof DomainValidationError && e.issues.length === 2,
  );
  assert.throws(
    () => createLoan({ id: 'l', deviceId: 'd', modelId: 'm', studentId: 's', idempotencyKey: 'key-12345678' }, new Date('nope')),
    DomainValidationError,
  );
});

test('a loan is collected then returned, recording who and when', () => {
  const collected = collectLoan(newLoan(), 'auth0|staff1', new Date('2026-11-10T10:00:00.000Z'));
  assert.equal(collected.status, 'collected');
  assert.equal(collected.collectedBy, 'auth0|staff1');
  assert.equal(collected.collectedAt, '2026-11-10T10:00:00.000Z');
  const returned = returnLoan(collected, 'auth0|staff2', new Date('2026-11-11T10:00:00.000Z'));
  assert.equal(returned.status, 'returned');
  assert.equal(returned.returnedBy, 'auth0|staff2');
  assert.equal(returned.collectedBy, 'auth0|staff1');
});

test('loan rejects out-of-order and repeated transitions', () => {
  const reserved = newLoan();
  assert.throws(() => returnLoan(reserved, 'staff-1', NOW), InvalidTransitionError);
  const collected = collectLoan(reserved, 'staff-1', NOW);
  assert.throws(() => collectLoan(collected, 'staff-1', NOW), InvalidTransitionError);
  const returned = returnLoan(collected, 'staff-1', NOW);
  assert.throws(() => returnLoan(returned, 'staff-1', NOW), InvalidTransitionError);
});

test('collect and return need a valid staff id', () => {
  assert.throws(() => collectLoan(newLoan(), '', NOW), DomainValidationError);
  assert.throws(() => collectLoan(newLoan(), 'bad id', NOW), DomainValidationError);
});

test('only a collected loan past its due date is overdue', () => {
  const collected = collectLoan(newLoan(), 'staff-1', NOW);
  assert.equal(isOverdue(newLoan(), new Date('2027-01-01T00:00:00Z')), false);
  assert.equal(isOverdue(collected, new Date('2026-11-12T08:59:59Z')), false);
  assert.equal(isOverdue(collected, new Date('2026-11-12T09:00:01Z')), true);
  assert.equal(isOverdue(returnLoan(collected, 'staff-1', NOW), new Date('2027-01-01T00:00:00Z')), false);
});
