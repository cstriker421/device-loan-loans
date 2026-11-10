// Types and errors shared by the repository ports (no Azure nor I/O)

/** A stored entity plus an opaque token identifying the exact stored version */
export type Versioned<T> = Readonly<{ item: T; version: string }>;

/** The stored version changed since it was read, so the write is refused */
export class ConcurrencyError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} "${id}" was changed by someone else`);
    this.name = 'ConcurrencyError';
    this.entity = entity;
    this.id = id;
  }
}

/** An entity with the same identity (or the same idempotency key) already exists */
export class DuplicateError extends Error {
  readonly entity: string;
  readonly key: string;

  constructor(entity: string, key: string) {
    super(`${entity} "${key}" already exists`);
    this.name = 'DuplicateError';
    this.entity = entity;
    this.key = key;
  }
}

/** The entity to update doesn't exist */
export class NotFoundError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} "${id}" was not found`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.id = id;
  }
}
