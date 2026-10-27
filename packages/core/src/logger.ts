import { pino, type Logger } from 'pino';

const SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/** JSON logs in the shape Cloud Logging parses natively (severity, message). */
export function createLogger(service: string, level: string): Logger {
  return pino({
    level,
    messageKey: 'message',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.apiKey',
        '*.key',
      ],
      censor: '[REDACTED]',
    },
    formatters: { level: (label) => ({ severity: SEVERITY[label] ?? 'DEFAULT' }) },
  });
}

/** Correlates request logs with Cloud Trace using the header Cloud Run injects. */
export function traceBindings(
  header: string | string[] | undefined,
  projectId: string,
): Record<string, string> {
  const value = Array.isArray(header) ? header[0] : header;
  const traceId = value?.split('/')[0];
  return traceId ? { 'logging.googleapis.com/trace': `projects/${projectId}/traces/${traceId}` } : {};
}

export type { Logger } from 'pino';
