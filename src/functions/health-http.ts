import { app } from '@azure/functions';
import type { HttpResponseInit } from '@azure/functions';

// GET /api/health: the process is up
app.http('health-http', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async (): Promise<HttpResponseInit> => ({
    status: 200,
    jsonBody: { status: 'ok', service: 'loan-service' },
  }),
});
