// Rebuilds domain objects from stored data. Unlike the factories (which start a new
// lifecycle), these accept any valid status, and they re-check everything that was stored.

import { DomainValidationError } from './errors';
import { createDevice, DEVICE_STATUSES } from './device';
import type { Device, DeviceStatus } from './device';
import { createLoan, LOAN_STATUSES } from './loan';
import type { Loan, LoanStatus } from './loan';

export type StoredDevice = {
  id: string;
  modelId: string;
  assetTag: string;
  status: string;
};

export type StoredLoan = {
  id: string;
  deviceId: string;
  modelId: string;
  studentId: string;
  idempotencyKey: string;
  status: string;
  reservedAt: string;
  dueAt: string;
  collectedAt?: string;
  collectedBy?: string;
  returnedAt?: string;
  returnedBy?: string;
};

const issuesFrom = (check: () => unknown): string[] => {
  try {
    check();
    return [];
  } catch (error) {
    if (error instanceof DomainValidationError) return [...error.issues];
    throw error;
  }
};

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  !Number.isNaN(new Date(value).getTime()) &&
  new Date(value).toISOString() === value;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function restoreDevice(raw: StoredDevice): Device {
  const issues = issuesFrom(() => createDevice(raw));
  if (!DEVICE_STATUSES.includes(raw.status as DeviceStatus)) {
    issues.push(`status must be one of: ${DEVICE_STATUSES.join(', ')}`);
  }
  if (issues.length > 0) throw new DomainValidationError(issues);

  return Object.freeze({
    id: raw.id,
    modelId: raw.modelId,
    assetTag: raw.assetTag,
    status: raw.status as DeviceStatus,
  });
}

export function restoreLoan(raw: StoredLoan): Loan {
  const issues: string[] = [];

  if (!isIsoDate(raw.reservedAt)) {
    issues.push('reservedAt must be an ISO 8601 UTC date');
  } else {
    issues.push(...issuesFrom(() => createLoan(raw, new Date(raw.reservedAt))));
  }
  if (!isIsoDate(raw.dueAt)) issues.push('dueAt must be an ISO 8601 UTC date');
  if (!LOAN_STATUSES.includes(raw.status as LoanStatus)) {
    issues.push(`status must be one of: ${LOAN_STATUSES.join(', ')}`);
  }

  const collected = raw.status === 'collected' || raw.status === 'returned';
  const returned = raw.status === 'returned';
  if (collected && !(isIsoDate(raw.collectedAt) && isText(raw.collectedBy))) {
    issues.push('a collected or returned loan needs collectedAt and collectedBy');
  }
  if (returned && !(isIsoDate(raw.returnedAt) && isText(raw.returnedBy))) {
    issues.push('a returned loan needs returnedAt and returnedBy');
  }
  if (raw.status === 'reserved' && (raw.collectedAt || raw.returnedAt)) {
    issues.push('a reserved loan cannot have collection or return details');
  }

  if (issues.length > 0) throw new DomainValidationError(issues);

  return Object.freeze({
    id: raw.id,
    deviceId: raw.deviceId,
    modelId: raw.modelId,
    studentId: raw.studentId,
    idempotencyKey: raw.idempotencyKey,
    status: raw.status as LoanStatus,
    reservedAt: raw.reservedAt,
    dueAt: raw.dueAt,
    ...(raw.collectedAt ? { collectedAt: raw.collectedAt, collectedBy: raw.collectedBy } : {}),
    ...(raw.returnedAt ? { returnedAt: raw.returnedAt, returnedBy: raw.returnedBy } : {}),
  });
}
