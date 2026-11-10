// Application layer: the logging the use cases need, as a port. No Azure, no console here.
// An adapter (in the HTTP layer) turns each call into one structured log line.

export type LogData = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
}
