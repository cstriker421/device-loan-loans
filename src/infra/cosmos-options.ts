// Infrastructure layer: shared Cosmos plumbing. Nothing here is read from the environment.

import { CosmosClient } from '@azure/cosmos';
import type { Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

export type CosmosContainerOptions = {
  endpoint: string;
  database: string;
  container: string;
  /** Access key for local development. If omitted, DefaultAzureCredential is used. */
  key?: string;
};

/** Opens one container. Called by the composition root, never by the adapters themselves. */
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
