import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { reserveLoan } from './reserve-loan';
import type { ReserveLoanDeps } from './reserve-loan';
import type { Logger } from './logger';
import { createDevice } from '../domain/device';
import type { Device } from '../domain/device';
import type { DeviceRepo } from '../domain/device-repo';
import type { Loan } from '../domain/loan';
import type { LoanRepo } from '../domain/loan-repo';
import { DomainValidationError } from '../domain/errors';
import { ConcurrencyError, DuplicateError, NotFoundError } from '../domain/persistence';
import type { Versioned } from '../domain/persistence';

const NOW = new Date('2026-11-10T09:00:00.000Z');
const tick = () => Promise.resolve();

// In-memory repos that honour the port contracts (versions, conflicts, unique keys).
class MemDevices implements DeviceRepo {
  store = new Map<string, { device: Device; version: number }>();
  calls = 0;
  /** Runs just before a replace is applied, to simulate another request getting in first. */
  beforeReplace?: (device: Device) => Promise<void> | void;
  failReplaceWith?: (device: Device) => Error | undefined;

  seed(...devices: Device[]) { devices.forEach((d) => this.store.set(d.id, { device: d, version: 1 })); }
  statusOf = (id: string) => this.store.get(id)!.device.status;

  async add(device: Device) { this.seed(device); }
  async findAvailable(modelId: string, limit: number): Promise<Versioned<Device>[]> {
    this.calls++; await tick();
    return [...this.store.values()]
      .filter((e) => e.device.modelId === modelId && e.device.status === 'available')
      .slice(0, limit).map((e) => ({ item: e.device, version: String(e.version) }));
  }
  async get(modelId: string, id: string) {
    const e = this.store.get(id);
    return e && e.device.modelId === modelId ? { item: e.device, version: String(e.version) } : undefined;
  }
  async replace(device: Device, expectedVersion: string): Promise<string> {
    this.calls++; await tick();
    if (this.beforeReplace) await this.beforeReplace(device);
    const injected = this.failReplaceWith?.(device); if (injected) throw injected;
    const e = this.store.get(device.id);
    if (!e) throw new NotFoundError('Device', device.id);
    if (String(e.version) !== expectedVersion) throw new ConcurrencyError('Device', device.id);
    e.device = device; e.version++;
    return String(e.version);
  }
}

class MemLoans implements LoanRepo {
  store = new Map<string, Loan>();
  calls = 0;
  failCreateWith?: Error;
  async create(loan: Loan) {
    this.calls++; await tick();
    if (this.failCreateWith) throw this.failCreateWith;
    const clash = [...this.store.values()].some(
      (l) => l.id === loan.id || (l.studentId === loan.studentId && l.idempotencyKey === loan.idempotencyKey));
    if (clash) throw new DuplicateError('Loan', loan.idempotencyKey);
    this.store.set(loan.id, loan);
  }
  async get(studentId: string, id: string) {
    const l = this.store.get(id); return l && l.studentId === studentId ? { item: l, version: '1' } : undefined;
  }
  async findByIdempotencyKey(studentId: string, key: string) {
    this.calls++; await tick();
    return [...this.store.values()].find((l) => l.studentId === studentId && l.idempotencyKey === key);
  }
  async replace(): Promise<string> { return '1'; }
}

const recordingLog = () => {
  const events: { level: string; event: string; data?: unknown }[] = [];
  const log: Logger = {
    info: (event, data) => events.push({ level: 'info', event, data }),
    warn: (event, data) => events.push({ level: 'warn', event, data }),
    error: (event, data) => events.push({ level: 'error', event, data }),
  };
  return { events, log, names: () => events.map((e) => e.event) };
};

const unit = (id: string, modelId = 'dm-001') => createDevice({ id, modelId, assetTag: `TAG-${id}` });
const setup = (...units: Device[]) => {
  const devices = new MemDevices(); devices.seed(...units);
  const loans = new MemLoans();
  const rec = recordingLog();
  let n = 0;
  const deps: ReserveLoanDeps = { devices, loans, log: rec.log, newId: () => `loan-${++n}`, now: () => NOW };
  return { devices, loans, rec, deps };
};
const request = (studentId = 'auth0|alice', key = 'key-alice-0001', modelId = 'dm-001') =>
  ({ studentId, modelId, idempotencyKey: key });

test('reserves an available unit, sets the due date, and logs it', async () => {
  const { devices, loans, rec, deps } = setup(unit('dev-1'));
  const result = await reserveLoan(deps, request());
  assert.equal(result.outcome, 'reserved');
  if (result.outcome !== 'reserved') return;
  assert.equal(result.loan.deviceId, 'dev-1');
  assert.equal(result.loan.dueAt, '2026-11-12T09:00:00.000Z');
  assert.equal(devices.statusOf('dev-1'), 'reserved');
  assert.equal(loans.store.size, 1);
  assert.deepEqual(rec.names(), ['loan.reserved']);
});

test('a retry with the same idempotency key returns the same loan and takes no second unit', async () => {
  const { devices, loans, rec, deps } = setup(unit('dev-1'), unit('dev-2'));
  const first = await reserveLoan(deps, request());
  const second = await reserveLoan(deps, request());
  assert.equal(second.outcome, 'already-reserved');
  assert.equal((second as { loan: Loan }).loan.id, (first as { loan: Loan }).loan.id);
  assert.equal([...devices.store.values()].filter((e) => e.device.status === 'reserved').length, 1);
  assert.equal(loans.store.size, 1);
  assert.ok(rec.names().includes('loan.reserve.replayed'));
});

test('the same key for a different model is rejected', async () => {
  const { deps } = setup(unit('dev-1'), unit('dev-9', 'dm-002'));
  await reserveLoan(deps, request());
  await assert.rejects(() => reserveLoan(deps, request('auth0|alice', 'key-alice-0001', 'dm-002')), DomainValidationError);
});

test('invalid input is rejected before any storage call', async () => {
  const { devices, loans, deps } = setup(unit('dev-1'));
  await assert.rejects(() => reserveLoan(deps, { studentId: '', modelId: 'dm-001', idempotencyKey: 'short' }), DomainValidationError);
  assert.equal(devices.calls, 0);
  assert.equal(loans.calls, 0);
});

test('no available unit gives "unavailable" and creates no loan', async () => {
  const { loans, rec, deps } = setup(unit('dev-1', 'dm-002'));
  const result = await reserveLoan(deps, request());
  assert.deepEqual(result, { outcome: 'unavailable' });
  assert.equal(loans.store.size, 0);
  assert.deepEqual(rec.names(), ['loan.reserve.unavailable']);
});

test('if another request takes the first unit, the next unit is used', async () => {
  const { devices, rec, deps } = setup(unit('dev-1'), unit('dev-2'));
  let stolen = false;
  devices.beforeReplace = async (d) => {
    if (d.id === 'dev-1' && !stolen) {
      stolen = true;
      const e = devices.store.get('dev-1')!; // someone else reserves dev-1 first
      e.device = { ...e.device, status: 'reserved' }; e.version++;
    }
  };
  const result = await reserveLoan(deps, request());
  assert.equal(result.outcome, 'reserved');
  assert.equal((result as { loan: Loan }).loan.deviceId, 'dev-2');
  assert.deepEqual(rec.names(), ['loan.reserve.conflict', 'loan.reserved']);
});

test('if every unit is taken meanwhile, the answer is "unavailable"', async () => {
  const { devices, deps } = setup(unit('dev-1'));
  devices.beforeReplace = async (d) => {
    const e = devices.store.get(d.id)!;
    if (e.device.status === 'available') { e.device = { ...e.device, status: 'reserved' }; e.version++; }
  };
  assert.deepEqual(await reserveLoan(deps, request()), { outcome: 'unavailable' });
});

test('two students racing for the last unit: exactly one wins', async () => {
  const { devices, loans, deps } = setup(unit('dev-1'));
  const [a, b] = await Promise.all([
    reserveLoan(deps, request('auth0|alice', 'key-alice-0001')),
    reserveLoan(deps, request('auth0|bob', 'key-bob-000001')),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['reserved', 'unavailable']);
  assert.equal(loans.store.size, 1);
  assert.equal(devices.statusOf('dev-1'), 'reserved');
});

test('a double-submitted request (same key, two units free) makes one loan and frees the extra unit', async () => {
  const { devices, loans, rec, deps } = setup(unit('dev-1'), unit('dev-2'));
  const [a, b] = await Promise.all([reserveLoan(deps, request()), reserveLoan(deps, request())]);
  const loanIds = new Set([(a as { loan: Loan }).loan.id, (b as { loan: Loan }).loan.id]);
  assert.equal(loanIds.size, 1);
  assert.equal(loans.store.size, 1);
  assert.equal([...devices.store.values()].filter((e) => e.device.status === 'reserved').length, 1);
  assert.ok(rec.names().includes('loan.reserve.compensated'));
});

test('if the loan cannot be saved, the claimed unit is put back and the error surfaces', async () => {
  const { devices, loans, rec, deps } = setup(unit('dev-1'));
  loans.failCreateWith = new Error('database unavailable');
  await assert.rejects(() => reserveLoan(deps, request()), /database unavailable/);
  assert.equal(devices.statusOf('dev-1'), 'available');
  assert.ok(rec.names().includes('loan.reserve.compensated'));
});

test('if putting the unit back also fails, that is logged as an error and the original error still surfaces', async () => {
  const { devices, loans, rec, deps } = setup(unit('dev-1'));
  loans.failCreateWith = new Error('database unavailable');
  let replaces = 0;
  devices.failReplaceWith = () => (++replaces === 2 ? new Error('release failed') : undefined);
  await assert.rejects(() => reserveLoan(deps, request()), /database unavailable/);
  const failure = rec.events.find((e) => e.event === 'loan.reserve.compensation_failed');
  assert.equal(failure?.level, 'error');
  assert.equal(devices.statusOf('dev-1'), 'reserved'); // orphaned: this is what reconciliation must catch
});
