// Infrastructure layer: Cosmos DB adapter for LoanRepo.
// Container: partition key /studentId, unique key policy on /idempotencyKey (unique per student).
// The version token is the document's ETag.

import type { Container } from '@azure/cosmos';
import type { Loan } from '../domain/loan';
import type { LoanRepo } from '../domain/loan-repo';
import { ConcurrencyError, DuplicateError, NotFoundError } from '../domain/persistence';
import type { Versioned } from '../domain/persistence';
import { restoreLoan } from '../domain/restore';
import { hasStatusCode } from './cosmos-options';

/** The stored shape. Deliberately separate from the domain type. */
type LoanDocument = {
  id: string;
  studentId: string; // partition key
  deviceId: string;
  modelId: string;
  idempotencyKey: string;
  status: string;
  reservedAt: string;
  dueAt: string;
  collectedAt?: string;
  collectedBy?: string;
  returnedAt?: string;
  returnedBy?: string;
  _etag?: string;
};

const toDocument = (loan: Loan): LoanDocument => ({ ...loan });

const toVersioned = (doc: LoanDocument): Versioned<Loan> => ({
  item: restoreLoan(doc),
  version: doc._etag ?? '',
});

export class CosmosLoanRepo implements LoanRepo {
  constructor(private readonly container: Container) {}

  async create(loan: Loan): Promise<void> {
    try {
      await this.container.items.create<LoanDocument>(toDocument(loan));
    } catch (error) {
      // 409 covers both a repeated id and a repeated idempotency key for this student.
      if (hasStatusCode(error, 409)) throw new DuplicateError('Loan', loan.idempotencyKey);
      throw error;
    }
  }

  async get(studentId: string, id: string): Promise<Versioned<Loan> | undefined> {
    try {
      const { resource } = await this.container.item(id, studentId).read<LoanDocument>();
      return resource ? toVersioned(resource) : undefined;
    } catch (error) {
      if (hasStatusCode(error, 404)) return undefined;
      throw error;
    }
  }

  async findByIdempotencyKey(studentId: string, idempotencyKey: string): Promise<Loan | undefined> {
    const { resources } = await this.container.items
      .query<LoanDocument>(
        {
          query: 'SELECT * FROM c WHERE c.idempotencyKey = @idempotencyKey',
          parameters: [{ name: '@idempotencyKey', value: idempotencyKey }],
        },
        { partitionKey: studentId },
      )
      .fetchAll();
    return resources.length > 0 ? toVersioned(resources[0]).item : undefined;
  }

  async replace(loan: Loan, expectedVersion: string): Promise<string> {
    try {
      const response = await this.container
        .item(loan.id, loan.studentId)
        .replace<LoanDocument>(toDocument(loan), {
          accessCondition: { type: 'IfMatch', condition: expectedVersion },
        });
      return response.resource?._etag ?? response.etag;
    } catch (error) {
      if (hasStatusCode(error, 412)) throw new ConcurrencyError('Loan', loan.id);
      if (hasStatusCode(error, 404)) throw new NotFoundError('Loan', loan.id);
      throw error;
    }
  }
}
