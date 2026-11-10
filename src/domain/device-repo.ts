import type { Device } from './device';
import type { Versioned } from './persistence';

/** Port: how the application stores and retrieves devices. */
export interface DeviceRepo {
  /** Stores a new device. Rejects with DuplicateError if the id already exists. */
  add(device: Device): Promise<void>;

  /** Returns up to `limit` available devices of a model, each with its version. */
  findAvailable(modelId: string, limit: number): Promise<Versioned<Device>[]>;

  /** Returns one device with its version, or undefined if there isn't one. */
  get(modelId: string, id: string): Promise<Versioned<Device> | undefined>;

  /**
   * Overwrites a device only if its stored version still equals `expectedVersion`.
   * Returns the new version. Rejects with ConcurrencyError if someone else changed it first,
   * or NotFoundError if it no longer exists.
   */
  replace(device: Device, expectedVersion: string): Promise<string>;
}
