// Turns the application's Logger port into Azure Functions logging:
// one structured JSON line per event, so each one stays a single row in Log Analytics.

import type { InvocationContext } from '@azure/functions';
import type { LogData, Logger } from '../app/logger';

export function createFunctionLogger(context: InvocationContext): Logger {
  const line = (event: string, data?: LogData) => JSON.stringify({ event, ...data });
  return {
    info: (event, data) => context.info(line(event, data)),
    warn: (event, data) => context.warn(line(event, data)),
    error: (event, data) => context.error(line(event, data)),
  };
}
