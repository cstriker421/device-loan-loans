// Adapter tests run against FakeContainer: an in-memory stand-in that imitates the
// Cosmos behaviours the adapters rely on (ETags, 409/412 errors, per-partition unique key)
// Doesn't prove the real service behaves identically (we check that against Azure)
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Container } from '@azure/cosmos';
import { CosmosDeviceRepo } from './cosmos-device-repo';
import { CosmosLoanRepo } from './cosmos-loan-repo';
import { collectDevice, createDevice, reserveDevice } from '../domain/device';
import { createLoan } from '../domain/loan';
import { ConcurrencyError, DuplicateError, NotFoundError } from '../domain/persistence';

type Doc = Record<string, unknown> & { id: string };

class FakeContainer {
  private docs = new Map<string, Doc>();
  private counter = 0;
  constructor(private partitionField: string, private uniqueField?: string) {}

  private key = (pk: unknown, id: string) => `${String(pk)}|${id}`;
  private fail = (code: number): never => { throw Object.assign(new Error(`HTTP ${code}`), { code }); };

  items = {
    create: async (doc: Doc) => {
      const pk = doc[this.partitionField];
      if (this.docs.has(this.key(pk, doc.id))) this.fail(409);
      if (this.uniqueField) {
        const clash = [...this.docs.values()].some(
          (d) => d[this.partitionField] === pk && d[this.uniqueField!] === doc[this.uniqueField!],
        );
        if (clash) this.fail(409);
      }
      const stored = { ...doc, _etag: `etag-${++this.counter}` };
      this.docs.set(this.key(pk, doc.id), stored);
      return { resource: stored, etag: stored._etag };
    },
    query: (spec: { parameters: { name: string; value: unknown }[] }, opts: { partitionKey: string }) => ({
      fetchAll: async () => {
        const filters = spec.parameters.filter((p) => p.name !== '@limit');
        const limit = spec.parameters.find((p) => p.name === '@limit')?.value as number | undefined;
        const rows = [...this.docs.values()]
          .filter((d) => d[this.partitionField] === opts.partitionKey)
          .filter((d) => filters.every((p) => d[p.name.slice(1)] === p.value));
        return { resources: (limit ? rows.slice(0, limit) : rows).map((d) => ({ ...d })) };
      },
    }),
  };

  item = (id: string, pk: string) => ({
    read: async () => ({ resource: this.docs.has(this.key(pk, id)) ? { ...this.docs.get(this.key(pk, id))! } : undefined }),
    replace: async (doc: Doc, options: { accessCondition: { condition: string } }) => {
      const current = this.docs.get(this.key(pk, id));
      if (!current) this.fail(404);
      if (current!._etag !== options.accessCondition.condition) this.fail(412);
      const stored = { ...doc, _etag: `etag-${++this.counter}` };
      this.docs.set(this.key(pk, id), stored);
      return { resource: stored, etag: stored._etag };
    },
  });
}

const asContainer = (fake: FakeContainer) => fake as unknown as Container;
const unit = (id: string, modelId = 'dm-001') => createDevice({ id, modelId, assetTag: `TAG-${id}` });
const NOW = new Date('2026-11-10T09:00:00.000Z');
const loan = (id = 'loan-1', studentId = 'auth0|s1', key = 'key-12345678') =>
  createLoan({ id, deviceId: 'dev-1', modelId: 'dm-001', studentId, idempotencyKey: key }, NOW);

test('devices: add, get, and a duplicate id is refused', async () => {
  const repo = new CosmosDeviceRepo(asContainer(new FakeContainer('modelId')));
  await repo.add(unit('dev-1'));
  const found = await repo.get('dm-001', 'dev-1');
  assert.equal(found?.item.status, 'available');
  assert.ok(found?.version);
  assert.equal(await repo.get('dm-001', 'nope'), undefined);
  await assert.rejects(() => repo.add(unit('dev-1')), DuplicateError);
});

test('devices: findAvailable returns only available units of that model, with a limit', async () => {
  const repo = new CosmosDeviceRepo(asContainer(new FakeContainer('modelId')));
  await repo.add(unit('dev-1'));
  await repo.add(unit('dev-2'));
  await repo.add(unit('dev-3'));
  await repo.add(unit('other-1', 'dm-002'));
  const first = await repo.get('dm-001', 'dev-1');
  await repo.replace(reserveDevice(first!.item), first!.version);
  const available = await repo.findAvailable('dm-001', 10);
  assert.deepEqual(available.map((v) => v.item.id).sort(), ['dev-2', 'dev-3']);
  assert.equal((await repo.findAvailable('dm-001', 1)).length, 1);
});

test('devices: replace uses the version, and returns a new one', async () => {
  const repo = new CosmosDeviceRepo(asContainer(new FakeContainer('modelId')));
  await repo.add(unit('dev-1'));
  const v1 = (await repo.get('dm-001', 'dev-1'))!;
  const newVersion = await repo.replace(reserveDevice(v1.item), v1.version);
  assert.notEqual(newVersion, v1.version);
  const v2 = (await repo.get('dm-001', 'dev-1'))!;
  assert.equal(v2.item.status, 'reserved');
  assert.equal(v2.version, newVersion);
  await assert.rejects(() => repo.replace(unit('missing'), 'x'), NotFoundError);
});

test('two students racing for the same unit: only one wins', async () => {
  const repo = new CosmosDeviceRepo(asContainer(new FakeContainer('modelId')));
  await repo.add(unit('dev-1'));
  const readByAlice = (await repo.findAvailable('dm-001', 1))[0];
  const readByBob = (await repo.findAvailable('dm-001', 1))[0];
  await repo.replace(reserveDevice(readByAlice.item), readByAlice.version); // Alice wins
  await assert.rejects(
    () => repo.replace(reserveDevice(readByBob.item), readByBob.version), // Bob used a stale version
    ConcurrencyError,
  );
  assert.equal((await repo.get('dm-001', 'dev-1'))?.item.status, 'reserved');
  assert.deepEqual(await repo.findAvailable('dm-001', 5), []);
});

test('a stale device version cannot overwrite a later change', async () => {
  const repo = new CosmosDeviceRepo(asContainer(new FakeContainer('modelId')));
  await repo.add(unit('dev-1'));
  const v1 = (await repo.get('dm-001', 'dev-1'))!;
  const reservedVersion = await repo.replace(reserveDevice(v1.item), v1.version);
  await repo.replace(collectDevice(reserveDevice(unit('dev-1'))), reservedVersion);
  await assert.rejects(() => repo.replace(reserveDevice(v1.item), v1.version), ConcurrencyError);
});

test('loans: create, get, find by idempotency key', async () => {
  const repo = new CosmosLoanRepo(asContainer(new FakeContainer('studentId', 'idempotencyKey')));
  await repo.create(loan());
  const found = await repo.get('auth0|s1', 'loan-1');
  assert.equal(found?.item.status, 'reserved');
  assert.equal(await repo.get('auth0|s1', 'nope'), undefined);
  assert.equal((await repo.findByIdempotencyKey('auth0|s1', 'key-12345678'))?.id, 'loan-1');
  assert.equal(await repo.findByIdempotencyKey('auth0|s1', 'other-key-1'), undefined);
});

test('loans: a repeated idempotency key is refused for the same student only', async () => {
  const repo = new CosmosLoanRepo(asContainer(new FakeContainer('studentId', 'idempotencyKey')));
  await repo.create(loan('loan-1', 'auth0|s1'));
  await assert.rejects(() => repo.create(loan('loan-2', 'auth0|s1')), DuplicateError);
  await repo.create(loan('loan-3', 'auth0|s2')); // same key, different student: allowed
  assert.equal((await repo.findByIdempotencyKey('auth0|s2', 'key-12345678'))?.id, 'loan-3');
});

test('loans: replace is guarded by the version', async () => {
  const repo = new CosmosLoanRepo(asContainer(new FakeContainer('studentId', 'idempotencyKey')));
  await repo.create(loan());
  const v1 = (await repo.get('auth0|s1', 'loan-1'))!;
  const v2 = await repo.replace(v1.item, v1.version);
  assert.notEqual(v2, v1.version);
  await assert.rejects(() => repo.replace(v1.item, v1.version), ConcurrencyError);
  await assert.rejects(() => repo.replace(loan('ghost'), 'x'), NotFoundError);
});
