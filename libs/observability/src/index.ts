/**
 * Observability (blueprint §5.8, §22). Isomorphic entry point: redaction and the structured logger.
 * Node-only OpenTelemetry/Sentry initialisation lives under `@sol-agent-trader/observability/server`.
 */
export * from './redaction.js';
export * from './logger.js';
