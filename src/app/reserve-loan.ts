// Application layer: reserve a device of a given model for a student.
// Coordinates the ports and the domain rules. No SDKs, no I/O of its own.
//
// Flow: validate -> replay if this idempotency key was already used -> claim an available
// unit using its version (moving on if someone else gets there first) -> create the loan ->
// undo the claim if the loan cannot be created.

import { createLoan } from '../domain/loan';
import type { Loan } from '../domain/loan';
import { DomainValidationError } from '../domain/errors';
import { releaseDevice, reserveDevice } from '../domain/device';
import type { Device } from '../domain/device';
import type { DeviceRepo } from '../domain/device-repo';
import type { LoanRepo } from '../domain/loan-repo';
import { ConcurrencyError, DuplicateError, NotFoundError } from '../domain/persistence';
import type { Versioned } from '../domain/persistence';
import type { Logger } from './logger';

export type ReserveLoanDeps = {
  devices: DeviceRepo;
  loans: LoanRepo;
  log: Logger;
  newId: () => string;
  now: () => Date;
};

export type ReserveLoanInput = {
  studentId: string;
  modelId: string;
  idempotencyKey: string;
};

export type ReserveLoanResult =
  | { outcome: 'reserved'; loan: Loan }
  /** This idempotency key was used before: the original loan is returned, nothing new is made. */
  | { outcome: 'already-reserved'; loan: Loan }
  /** No unit of this model could be secured. A normal business outcome, not an error. */
  | { outcome: 'unavailable' };

const BATCH_SIZE = 5; // units fetched per attempt
const MAX_ROUNDS = 3; // re-reads before giving up under heavy contention

type Claim = { device: Device; version: string };

export async function reserveLoan(
  deps: ReserveLoanDeps,
  input: ReserveLoanInput,
): Promise<ReserveLoanResult> {
  const { devices, loans, log, newId, now } = deps;
  const loanId = newId();

  // 1. Validate the request before touching storage ("draft" stands in for the unit).
  createLoan({ id: loanId, deviceId: 'draft', ...input }, now());

  const replay = (existing: Loan): ReserveLoanResult => {
    if (existing.modelId !== input.modelId) {
      throw new DomainValidationError(['idempotencyKey was already used for a different request']);
    }
    log.info('loan.reserve.replayed', { loanId: existing.id, modelId: existing.modelId });
    return { outcome: 'already-reserved', loan: existing };
  };

  // 2. A retry of an earlier request returns the earlier loan.
  const earlier = await loans.findByIdempotencyKey(input.studentId, input.idempotencyKey);
  if (earlier) return replay(earlier);

  // Moves a unit from available to reserved, or reports that someone else got there first.
  const tryClaim = async (candidate: Versioned<Device>): Promise<Claim | undefined> => {
    const reserved = reserveDevice(candidate.item);
    try {
      const version = await devices.replace(reserved, candidate.version);
      return { device: reserved, version };
    } catch (error) {
      if (error instanceof ConcurrencyError || error instanceof NotFoundError) return undefined;
      throw error;
    }
  };

  // Puts a claimed unit back. Never throws, so the original problem is what surfaces.
  const release = async (claim: Claim): Promise<void> => {
    try {
      await devices.replace(releaseDevice(claim.device), claim.version);
      log.info('loan.reserve.compensated', { deviceId: claim.device.id });
    } catch (error) {
      log.error('loan.reserve.compensation_failed', {
        deviceId: claim.device.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const candidates = await devices.findAvailable(input.modelId, BATCH_SIZE);
    if (candidates.length === 0) {
      log.info('loan.reserve.unavailable', { modelId: input.modelId, round });
      return { outcome: 'unavailable' };
    }

    for (const candidate of candidates) {
      const claim = await tryClaim(candidate);
      if (!claim) {
        log.warn('loan.reserve.conflict', { deviceId: candidate.item.id, round });
        continue;
      }

      try {
        // 3. We hold a unit: record the loan.
        const loan = createLoan({ id: loanId, deviceId: claim.device.id, ...input }, now());
        await loans.create(loan);
        log.info('loan.reserved', {
          loanId: loan.id,
          deviceId: loan.deviceId,
          modelId: loan.modelId,
          dueAt: loan.dueAt,
        });
        return { outcome: 'reserved', loan };
      } catch (error) {
        // 4. Could not record it: hand the unit back.
        await release(claim);
        if (error instanceof DuplicateError) {
          // A concurrent request with the same key won; return its loan.
          const winner = await loans.findByIdempotencyKey(input.studentId, input.idempotencyKey);
          if (winner) return replay(winner);
        }
        throw error;
      }
    }
  }

  log.warn('loan.reserve.contention', { modelId: input.modelId, rounds: MAX_ROUNDS });
  return { outcome: 'unavailable' };
}
