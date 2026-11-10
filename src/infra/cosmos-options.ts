// Infra layer (shared Cosmos plumbing, no reading from env)
import { CosmosClient } from '@azure/cosmos';
import type { Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

export type CosmosContainerOptions = {
  endpoint: string;
  database: string;
  container: string;
  /** Access key for local devving (if omitted, uses DefaultAzureCredential instead) */
  key?: string;
};

/** Opens one container (called by the composition root and not by the adapters) */
export function openContainer(options: CosmosContainerOptions): Container {
  const client = new CosmosClient(
    options.key
      ? { endpoint: options.endpoint, key: options.key }
      : { endpoint: options.endpoint, aadCredentials: new DefaultAzureCredential() },
  );
  return client.database(options.database).container(options.container);
}

export const hasStatusCode = (error: unknown, code: number): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === code;
