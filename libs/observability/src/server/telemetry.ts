import { context, propagation, trace, type Span, type Tracer } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import { createLogger, type Logger, type LogSink } from '../logger.js';
import { redact } from '../redaction.js';

/**
 * Node service telemetry (blueprint §5.8): OpenTelemetry as the instrumentation contract, Sentry
 * for errors, structured logs on stdout. Correlation ids traverse services through the OTel
 * context. Sentry is optional (no DSN, no client) and every event is redacted before send.
 */

export interface TelemetryOptions {
  service: 'worker' | 'risk-authorizer' | 'execution-service';
  deploymentProfile: string;
  sentryDsn?: string;
  release?: string;
  instanceId?: string;
  logSink?: LogSink;
}

export interface Telemetry {
  logger: Logger;
  tracer: Tracer;
  captureException(err: unknown, extra?: Record<string, unknown>): void;
  /** Runs `fn` inside a span; the span records only redacted, non-financial attributes. */
  withSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T>;
  /** Carrier headers to propagate the current trace/correlation context to another service. */
  propagationHeaders(): Record<string, string>;
  shutdown(): Promise<void>;
}

export function initTelemetry(options: TelemetryOptions): Telemetry {
  const logger = createLogger({ service: options.service, sink: options.logSink, context: options.instanceId ? { correlationId: undefined } : undefined });
  if (options.sentryDsn) {
    Sentry.init({
      dsn: options.sentryDsn,
      environment: options.deploymentProfile,
      release: options.release,
      sendDefaultPii: false,
      beforeSend(event) {
        return redact(event) as typeof event;
      },
      beforeBreadcrumb(breadcrumb) {
        return redact(breadcrumb) as typeof breadcrumb;
      },
    });
  }
  const tracer = trace.getTracer(`sol-agent-trader.${options.service}`);
  return {
    logger,
    tracer,
    captureException(err, extra) {
      logger.error('exception', { error: err, ...(extra ?? {}) });
      if (options.sentryDsn) Sentry.captureException(err, { extra: redact(extra ?? {}) as Record<string, unknown> });
    },
    withSpan(name, attributes, fn) {
      const safe = redact(attributes) as Record<string, string | number | boolean>;
      return tracer.startActiveSpan(name, { attributes: safe }, async (span) => {
        try {
          return await fn(span);
        } catch (err) {
          span.recordException(err instanceof Error ? { name: err.name, message: redact(err.message) as string } : String(err));
          throw err;
        } finally {
          span.end();
        }
      });
    },
    propagationHeaders() {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
    async shutdown() {
      if (options.sentryDsn) await Sentry.close(2000);
    },
  };
}
