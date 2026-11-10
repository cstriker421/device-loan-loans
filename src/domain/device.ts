// Domain layer (one physical device that can be lent, only rules)

import { DomainValidationError, InvalidTransitionError } from './errors';

export const DEVICE_STATUSES = ['available', 'reserved', 'on-loan'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** A single unit. `modelId` points at a device model in the catalogue service */
export type Device = Readonly<{
  id: string;
  modelId: string;
  assetTag: string;
  status: DeviceStatus;
}>;

/** What callers hand to the factory (untrusted. It may come straight from json) */
export type NewDevice = {
  id: string;
  modelId: string;
  assetTag: string;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_TAG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);

/** Factory (validates the input and returns a new device that's available for loan) */
export function createDevice(input: NewDevice): Device {
  const issues: string[] = [];

  if (!matches(input.id, ID_PATTERN)) {
    issues.push('id is required: 1-64 characters, letters, digits, "-" or "_"');
  }
  if (!matches(input.modelId, ID_PATTERN)) {
    issues.push('modelId is required: 1-64 characters, letters, digits, "-" or "_"');
  }
  if (!matches(input.assetTag, ASSET_TAG_PATTERN)) {
    issues.push('assetTag is required: 1-32 characters, letters, digits, "-" or "_"');
  }

  if (issues.length > 0) {
    throw new DomainValidationError(issues);
  }

  return Object.freeze({
    id: input.id,
    modelId: input.modelId,
    assetTag: input.assetTag,
    status: 'available' as const,
  });
}

function move(device: Device, from: DeviceStatus, to: DeviceStatus): Device {
  if (device.status !== from) {
    throw new InvalidTransitionError('Device', device.status, to);
  }
  return Object.freeze({ ...device, status: to });
}

/** available -> reserved */
export const reserveDevice = (device: Device): Device =>
  move(device, 'available', 'reserved');

/** reserved -> available (a reservation is cancelled or a failed reserve is undone) */
export const releaseDevice = (device: Device): Device =>
  move(device, 'reserved', 'available');

/** reserved -> on-loan (the user collects it) */
export const collectDevice = (device: Device): Device =>
  move(device, 'reserved', 'on-loan');

/** on loan -> available (it is handed back) */
export const returnDevice = (device: Device): Device =>
  move(device, 'on-loan', 'available');
