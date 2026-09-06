import { redact } from './redaction.js';

/**
 * Structured JSON logger (blueprint §22.1). Every line carries the service name, the correlation
 * context (candidate, strategy version, proposal, intent, order, position, provider request) and is
 * redacted before it is written. Sinks are pluggable so tests can capture output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface CorrelationContext {
  correlationId?: string;
  candidateId?: string;
  strategyVersionId?: string;
  proposalId?: string;
  actionCycleId?: string;
  intentId?: string;
  orderId?: string;
  positionId?: string;
  providerRequestId?: string;
  sessionId?: string;
}

export interface LogRecord extends CorrelationContext {
  level: LogLevel;
  service: string;
  event: string;
  at: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export const stdoutSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'fatal') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

export interface Logger {
  readonly service: string;
  readonly context: CorrelationContext;
  child(context: CorrelationContext): Logger;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  fatal(event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

export interface LoggerOptions {
  service: string;
  sink?: LogSink;
  minLevel?: LogLevel;
  now?: () => string;
  context?: CorrelationContext;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? stdoutSink;
  const min = LEVEL_ORDER[options.minLevel ?? 'info'];
  const now = options.now ?? (() => new Date().toISOString());
  const context = options.context ?? {};

  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < min) return;
    const safe = redact({ ...context, ...(fields ?? {}) }) as Record<string, unknown>;
    sink({ ...safe, level, service: options.service, event, at: now() } as LogRecord);
  };

  return {
    service: options.service,
    context,
    child: (extra) => createLogger({ ...options, context: { ...context, ...extra } }),
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    fatal: (e, f) => emit('fatal', e, f),
  };
}
