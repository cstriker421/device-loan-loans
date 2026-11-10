import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { createReserveLoanHandler } from './reserve-loan-handler';
import type { BuildDeps } from './reserve-loan-handler';
import { createDevice } from '../domain/device';
import type { Device } from '../domain/device';
import type { DeviceRepo } from '../domain/device-repo';
import type { Loan } from '../domain/loan';
import type { LoanRepo } from '../domain/loan-repo';
import { DuplicateError } from '../domain/persistence';

const NOW = new Date('2026-11-10T09:00:00.000Z');

class FakeDevices implements DeviceRepo {
  calls = 0;
  failWith?: Error;
  constructor(private units: Device[]) {}
  async add() {}
  async get() { return undefined; }
  async findAvailable(modelId: string, limit: number) {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.units.filter((u) => u.modelId === modelId).slice(0, limit).map((u) => ({ item: u, version: '1' }));
  }
  async replace() { return '2'; }
}

class FakeLoans implements LoanRepo {
  store = new Map<string, Loan>();
  async create(loan: Loan) {
    const clash = [...this.store.values()].some((l) => l.studentId === loan.studentId && l.idempotencyKey === loan.idempotencyKey);
    if (clash) throw new DuplicateError('Loan', loan.idempotencyKey);
    this.store.set(loan.id, loan);
  }
  async get() { return undefined; }
  async findByIdempotencyKey(studentId: string, key: string) {
    return [...this.store.values()].find((l) => l.studentId === studentId && l.idempotencyKey === key);
  }
  async replace() { return '1'; }
}

const unit = (id: string, modelId = 'dm-001') => createDevice({ id, modelId, assetTag: `TAG-${id}` });

const setup = (...units: Device[]) => {
  const devices = new FakeDevices(units);
  const loans = new FakeLoans();
  const lines: { level: string; line: string }[] = [];
  const context = {
    info: (m: string) => lines.push({ level: 'info', line: m }),
    warn: (m: string) => lines.push({ level: 'warn', line: m }),
    error: (m: string) => lines.push({ level: 'error', line: m }),
  } as unknown as InvocationContext;
  let n = 0;
  const buildDeps: BuildDeps = (log) => ({ devices, loans, log, newId: () => `loan-${++n}`, now: () => NOW });
  return { devices, loans, lines, context, handler: createReserveLoanHandler(buildDeps) };
};

const req = (opts: { headers?: Record<string, string>; body?: unknown; rawJsonError?: boolean }) =>
  ({
    headers: new Headers(opts.headers ?? {}),
    json: async () => { if (opts.rawJsonError) throw new SyntaxError('Unexpected token'); return opts.body; },
  }) as unknown as HttpRequest;

const good = { 'x-student-id': 'auth0|alice', 'idempotency-key': 'key-alice-0001' };
type Body = { loan?: Loan; error?: { code: string; message: string; issues?: string[] } };

test('201 with the loan when a unit is reserved, and one JSON summary line is logged', async () => {
  const { handler, context, lines } = setup(unit('dev-1'));
  const res = await handler(req({ headers: good, body: { modelId: 'dm-001' } }), context);
  assert.equal(res.status, 201);
  const body = res.jsonBody as Body;
  assert.equal(body.loan?.status, 'reserved');
  assert.equal(body.loan?.dueAt, '2026-11-12T09:00:00.000Z');
  const summary = lines.map((l) => JSON.parse(l.line)).find((l) => l.event === 'http.loans.reserve');
  assert.equal(summary.status, 201);
  assert.equal(summary.outcome, 'reserved');
  assert.equal(typeof summary.durationMs, 'number');
});

test('200 with the same loan when the request is retried with the same key', async () => {
  const { handler, context, loans } = setup(unit('dev-1'), unit('dev-2'));
  const first = await handler(req({ headers: good, body: { modelId: 'dm-001' } }), context);
  const second = await handler(req({ headers: good, body: { modelId: 'dm-001' } }), context);
  assert.equal(second.status, 200);
  assert.equal((second.jsonBody as Body).loan?.id, (first.jsonBody as Body).loan?.id);
  assert.equal(loans.store.size, 1);
});

test('409 with a clear code when no unit of the model is available', async () => {
  const { handler, context } = setup(unit('dev-1', 'dm-002'));
  const res = await handler(req({ headers: good, body: { modelId: 'dm-001' } }), context);
  assert.equal(res.status, 409);
  assert.equal((res.jsonBody as Body).error?.code, 'no_unit_available');
});

test('400 listing every problem when headers are missing, with no storage call', async () => {
  const { handler, context, devices } = setup(unit('dev-1'));
  const res = await handler(req({ body: { modelId: 'dm-001' } }), context);
  assert.equal(res.status, 400);
  const body = res.jsonBody as Body;
  assert.equal(body.error?.code, 'invalid_request');
  assert.ok(body.error?.issues?.some((i) => i.startsWith('studentId')));
  assert.ok(body.error?.issues?.some((i) => i.startsWith('idempotencyKey')));
  assert.equal(devices.calls, 0);
});

test('400 when the body is not valid JSON, or modelId is not text', async () => {
  const { handler, context } = setup(unit('dev-1'));
  const notJson = await handler(req({ headers: good, rawJsonError: true }), context);
  assert.equal(notJson.status, 400);
  const badModel = await handler(req({ headers: good, body: { modelId: 42 } }), context);
  assert.equal(badModel.status, 400);
  assert.ok((badModel.jsonBody as Body).error?.issues?.some((i) => i.startsWith('modelId')));
});

test('500 with a safe body when something unexpected fails, and the cause is logged', async () => {
  const { handler, context, devices, lines } = setup(unit('dev-1'));
  devices.failWith = new Error('connection string leaked: SECRET-123');
  const res = await handler(req({ headers: good, body: { modelId: 'dm-001' } }), context);
  assert.equal(res.status, 500);
  assert.equal((res.jsonBody as Body).error?.code, 'internal_error');
  assert.ok(!JSON.stringify(res.jsonBody).includes('SECRET'));
  const failure = lines.map((l) => ({ level: l.level, ...JSON.parse(l.line) })).find((l) => l.event === 'http.loans.reserve.failed');
  assert.equal(failure?.level, 'error');
  assert.match(failure?.errorMessage, /SECRET-123/); // full detail stays in our logs only
});

test('every log line is one line of valid JSON with an event name', async () => {
  const { handler, context, lines } = setup(unit('dev-1'));
  await handler(req({ headers: good, body: { modelId: 'dm-001' } }), context);
  await handler(req({ body: {} }), context);
  assert.ok(lines.length >= 3);
  for (const { line } of lines) {
    assert.ok(!line.includes('\n'));
    assert.equal(typeof JSON.parse(line).event, 'string');
  }
});
