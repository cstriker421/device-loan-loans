import { app } from '@azure/functions';
import { createReserveLoanDeps } from '../config/appServices';
import { createReserveLoanHandler } from '../http/reserve-loan-handler';

// POST /api/loans   headers: Idempotency-Key, x-student-id (temporary)   body: { "modelId": "dm-001" }
app.http('reserve-loan-http', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'loans',
  handler: createReserveLoanHandler(createReserveLoanDeps),
});
