/**
 * Minimal structured JSON logger. Every line carries the base context
 * (request id, job id, article id) so operations can be correlated in
 * Workers Logs. Sensitive keys are redacted defensively.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const SENSITIVE_KEY = /(token|cookie|password|secret|authorization|session|set-cookie)/i;

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
    } else if (typeof value === 'string' && value.length > 2000) {
      out[key] = `${value.slice(0, 2000)}…[truncated]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(
  base: LogFields = {},
  sink: (line: string, level: LogLevel) => void = defaultSink,
): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...redact(base),
      ...redact(fields),
    };
    sink(JSON.stringify(record), level);
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Generates a short, URL-safe random identifier. */
export function newId(): string {
  return crypto.randomUUID();
}

export function newRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
