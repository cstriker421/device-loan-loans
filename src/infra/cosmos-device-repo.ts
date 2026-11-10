// Infrastructure layer: Cosmos DB adapter for DeviceRepo.
// Container: partition key /modelId. The version token is the document's ETag.

import type { Container } from '@azure/cosmos';
import type { Device } from '../domain/device';
import type { DeviceRepo } from '../domain/device-repo';
import { ConcurrencyError, DuplicateError, NotFoundError } from '../domain/persistence';
import type { Versioned } from '../domain/persistence';
import { restoreDevice } from '../domain/restore';
import { hasStatusCode } from './cosmos-options';

/** The stored shape. Deliberately separate from the domain type. */
type DeviceDocument = {
  id: string;
  modelId: string; // partition key
  assetTag: string;
  status: string;
  _etag?: string;
};

const toDocument = (device: Device): DeviceDocument => ({
  id: device.id,
  modelId: device.modelId,
  assetTag: device.assetTag,
  status: device.status,
});

const toVersioned = (doc: DeviceDocument): Versioned<Device> => ({
  item: restoreDevice(doc),
  version: doc._etag ?? '',
});

export class CosmosDeviceRepo implements DeviceRepo {
  constructor(private readonly container: Container) {}

  async add(device: Device): Promise<void> {
    try {
      await this.container.items.create<DeviceDocument>(toDocument(device));
    } catch (error) {
      if (hasStatusCode(error, 409)) throw new DuplicateError('Device', device.id);
      throw error;
    }
  }

  async findAvailable(modelId: string, limit: number): Promise<Versioned<Device>[]> {
    const { resources } = await this.container.items
      .query<DeviceDocument>(
        {
          query:
            'SELECT * FROM c WHERE c.modelId = @modelId AND c.status = @status OFFSET 0 LIMIT @limit',
          parameters: [
            { name: '@modelId', value: modelId },
            { name: '@status', value: 'available' },
            { name: '@limit', value: limit },
          ],
        },
        { partitionKey: modelId },
      )
      .fetchAll();
    return resources.map(toVersioned);
  }

  async get(modelId: string, id: string): Promise<Versioned<Device> | undefined> {
    try {
      const { resource } = await this.container.item(id, modelId).read<DeviceDocument>();
      return resource ? toVersioned(resource) : undefined;
    } catch (error) {
      if (hasStatusCode(error, 404)) return undefined;
      throw error;
    }
  }

  async replace(device: Device, expectedVersion: string): Promise<string> {
    try {
      const response = await this.container
        .item(device.id, device.modelId)
        .replace<DeviceDocument>(toDocument(device), {
          accessCondition: { type: 'IfMatch', condition: expectedVersion },
        });
      return response.resource?._etag ?? response.etag;
    } catch (error) {
      if (hasStatusCode(error, 412)) throw new ConcurrencyError('Device', device.id);
      if (hasStatusCode(error, 404)) throw new NotFoundError('Device', device.id);
      throw error;
    }
  }
}
