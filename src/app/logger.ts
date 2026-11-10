// App layer (logging the use cases need but as a port)
// An adapter (HTTP layer) turns each call into one log line
export type LogData = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
}
