// HTTP edge for POST /loans that translates a request into the use case and the outcome into a
// response (no business rules here) kept outside src/functions so it can be tested without
// registering a function

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { reserveLoan } from '../app/reserve-loan';
import type { ReserveLoanDeps } from '../app/reserve-loan';
import type { Logger } from '../app/logger';
import { DomainValidationError } from '../domain/errors';
import { createFunctionLogger } from './function-logger';

export type BuildDeps = (log: Logger) => ReserveLoanDeps;

// Flattens an error to one line (message + the top of the stack)
const describeError = (error: unknown) =>
  error instanceof Error
    ? {
        errorName: error.name,
        errorMessage: error.message,
        stack: (error.stack ?? '')
          .split('\n')
          .slice(0, 4)
          .map((line) => line.trim())
          .join(' | '),
      }
    : { errorName: 'NonError', errorMessage: String(error), stack: '' };

const errorBody = (code: string, message: string, issues?: readonly string[]) => ({
  error: { code, message, ...(issues ? { issues } : {}) },
});

export function createReserveLoanHandler(buildDeps: BuildDeps) {
  return async function reserveLoanHttp(
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> {
    const startedAt = Date.now();
    const log = createFunctionLogger(context);
    const done = (status: number, outcome: string, response: HttpResponseInit) => {
      const data = { status, outcome, durationMs: Date.now() - startedAt };
      if (status >= 400) log.warn('http.loans.reserve', data);
      else log.info('http.loans.reserve', data);
      return response;
    };

    try {
      // TEMP: the student id comes from a header until Auth0 token checks replace it
      const studentId = request.headers.get('x-student-id') ?? '';
      const idempotencyKey = request.headers.get('idempotency-key') ?? '';

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return done(400, 'invalid-json', {
          status: 400,
          jsonBody: errorBody('invalid_request', 'The request body must be valid JSON.'),
        });
      }
      const rawModelId = (body as { modelId?: unknown } | null)?.modelId;
      const modelId = typeof rawModelId === 'string' ? rawModelId : '';

      const result = await reserveLoan(buildDeps(log), { studentId, modelId, idempotencyKey });

      switch (result.outcome) {
        case 'reserved':
          return done(201, 'reserved', { status: 201, jsonBody: { loan: result.loan } });
        case 'already-reserved':
          return done(200, 'already-reserved', { status: 200, jsonBody: { loan: result.loan } });
        case 'unavailable':
          return done(409, 'unavailable', {
            status: 409,
            jsonBody: errorBody('no_unit_available', 'No device of that model is available right now.'),
          });
      }
    } catch (error) {
      if (error instanceof DomainValidationError) {
        return done(400, 'invalid-request', {
          status: 400,
          jsonBody: errorBody('invalid_request', 'The request is not valid.', error.issues),
        });
      }
      // Full detail goes to the log (caller only gets a safe and consistent error).
      log.error('http.loans.reserve.failed', {
        durationMs: Date.now() - startedAt,
        ...describeError(error),
      });
      return {
        status: 500,
        jsonBody: errorBody('internal_error', 'Could not reserve the device.'),
      };
    }
  };
}
