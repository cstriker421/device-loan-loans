// Composition root (the place that decides which adapters the app uses)
// Cosmos settings come from env vars, so each env (dev on work machine, test in Azure)
// can point at its own db

import { randomUUID } from 'node:crypto';
import type { Logger } from '../app/logger';
import type { ReserveLoanDeps } from '../app/reserve-loan';
import type { DeviceRepo } from '../domain/device-repo';
import type { LoanRepo } from '../domain/loan-repo';
import { CosmosDeviceRepo } from '../infra/cosmos-device-repo';
import { CosmosLoanRepo } from '../infra/cosmos-loan-repo';
import { openContainer } from '../infra/cosmos-options';

// Reads a required setting when it's needed (not at import time)
// The error names the var but never echoes any val
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} must be set to a non-empty value.`);
  }
  return value.trim();
}

function openConfiguredContainer(containerVariable: string) {
  const endpoint = requireEnv('COSMOS_ENDPOINT');
  const database = requireEnv('COSMOS_DATABASE_ID');
  const container = requireEnv(containerVariable);
  const key = requireEnv('COSMOS_KEY');

  // One line saying which db this instance talks to (never log key)
  console.info(
    JSON.stringify({
      event: 'repo.created',
      cosmosHost: new URL(endpoint).host,
      database,
      container,
    }),
  );
  return openContainer({ endpoint, database, container, key });
}

let deviceRepo: DeviceRepo | undefined;
let loanRepo: LoanRepo | undefined;

/** Lazy singleton (built on first use then reused for every later call) */
export function getDeviceRepo(): DeviceRepo {
  deviceRepo ??= new CosmosDeviceRepo(openConfiguredContainer('COSMOS_DEVICES_CONTAINER_ID'));
  return deviceRepo;
}

export function getLoanRepo(): LoanRepo {
  loanRepo ??= new CosmosLoanRepo(openConfiguredContainer('COSMOS_LOANS_CONTAINER_ID'));
  return loanRepo;
}

export function createReserveLoanDeps(log: Logger): ReserveLoanDeps {
  return {
    devices: getDeviceRepo(),
    loans: getLoanRepo(),
    log,
    newId: () => randomUUID(),
    now: () => new Date(),
  };
}
