// Domain layer (a loan of one device to one student, just rules)
// Time is passed in as `now` so the rules are deterministic and easy to test.

import { DomainValidationError, InvalidTransitionError } from './errors';

export const LOAN_PERIOD_DAYS = 2;
export const LOAN_STATUSES = ['reserved', 'collected', 'returned'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export type Loan = Readonly<{
  id: string;
  deviceId: string;
  modelId: string;
  studentId: string;
  /** Client-supplied key that makes retries of the same reserve request safe */
  idempotencyKey: string;
  status: LoanStatus;
  reservedAt: string; // ISO 8601, UTC
  dueAt: string; // ISO 8601, UTC: exactly LOAN_PERIOD_DAYS * 24 hours after reservedAt
  collectedAt?: string;
  collectedBy?: string;
  returnedAt?: string;
  returnedBy?: string;
}>;

/** What callers hand to the factory (untrusted) */
export type NewLoan = {
  id: string;
  deviceId: string;
  modelId: string;
  studentId: string;
  idempotencyKey: string;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Identity-provider subjects look like "auth0|abc123" or "google-oauth2|123".
const ACTOR_PATTERN = /^[A-Za-z0-9_|.:@-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

function assertActor(value: unknown, label: string): asserts value is string {
  if (!matches(value, ACTOR_PATTERN)) {
    throw new DomainValidationError([
      `${label} is required: 1-128 characters, letters, digits and "_ | . : @ -"`,
    ]);
  }
}

function assertNow(now: unknown): asserts now is Date {
  if (!isValidDate(now)) {
    throw new DomainValidationError(['now must be a valid Date']);
  }
}

/** Factory (validates the input and returns a new reserved loan with its due date) */
export function createLoan(input: NewLoan, now: Date): Loan {
  assertNow(now);
  const issues: string[] = [];

  if (!matches(input.id, ID_PATTERN)) {
    issues.push('id is required: 1-64 characters, letters, digits, "-" or "_"');
  }
  if (!matches(input.deviceId, ID_PATTERN)) {
    issues.push('deviceId is required: 1-64 characters, letters, digits, "-" or "_"');
  }
  if (!matches(input.modelId, ID_PATTERN)) {
    issues.push('modelId is required: 1-64 characters, letters, digits, "-" or "_"');
  }
  if (!matches(input.studentId, ACTOR_PATTERN)) {
    issues.push('studentId is required: 1-128 characters, letters, digits and "_ | . : @ -"');
  }
  if (!matches(input.idempotencyKey, IDEMPOTENCY_KEY_PATTERN)) {
    issues.push('idempotencyKey is required: 8-64 characters, letters, digits, "-" or "_"');
  }

  if (issues.length > 0) {
    throw new DomainValidationError(issues);
  }

  return Object.freeze({
    id: input.id,
    deviceId: input.deviceId,
    modelId: input.modelId,
    studentId: input.studentId,
    idempotencyKey: input.idempotencyKey,
    status: 'reserved' as const,
    reservedAt: now.toISOString(),
    dueAt: new Date(now.getTime() + LOAN_PERIOD_DAYS * MS_PER_DAY).toISOString(),
  });
}

/** reserved -> collected. `staffId` is the staff member who hands the device over */
export function collectLoan(loan: Loan, staffId: string, now: Date): Loan {
  assertNow(now);
  assertActor(staffId, 'staffId');
  if (loan.status !== 'reserved') {
    throw new InvalidTransitionError('Loan', loan.status, 'collected');
  }
  return Object.freeze({
    ...loan,
    status: 'collected' as const,
    collectedAt: now.toISOString(),
    collectedBy: staffId,
  });
}

/** collected -> returned. `staffId` is the staff member who receives it back */
export function returnLoan(loan: Loan, staffId: string, now: Date): Loan {
  assertNow(now);
  assertActor(staffId, 'staffId');
  if (loan.status !== 'collected') {
    throw new InvalidTransitionError('Loan', loan.status, 'returned');
  }
  return Object.freeze({
    ...loan,
    status: 'returned' as const,
    returnedAt: now.toISOString(),
    returnedBy: staffId,
  });
}

/** True when a collected loan is past its due date */
export const isOverdue = (loan: Loan, now: Date): boolean =>
  loan.status === 'collected' && now.getTime() > new Date(loan.dueAt).getTime();
