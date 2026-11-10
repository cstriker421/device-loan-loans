import type { Loan } from './loan';
import type { Versioned } from './persistence';

/** Port: how the application stores and retrieves loans. */
export interface LoanRepo {
  /**
   * Stores a new loan. Rejects with DuplicateError if this student has already used
   * the loan's idempotency key (or the id already exists).
   */
  create(loan: Loan): Promise<void>;

  /** Returns one loan with its version, or undefined if there isn't one. */
  get(studentId: string, id: string): Promise<Versioned<Loan> | undefined>;

  /** Returns the loan this student created with this idempotency key, if any. */
  findByIdempotencyKey(studentId: string, idempotencyKey: string): Promise<Loan | undefined>;

  /**
   * Overwrites a loan only if its stored version still equals `expectedVersion`.
   * Returns the new version. Rejects with ConcurrencyError or NotFoundError.
   */
  replace(loan: Loan, expectedVersion: string): Promise<string>;
}
