import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';
import { getCorrelationId } from '../correlation/correlation.store';

/**
 * Structured logging with automatic correlation-id injection.
 *
 * An async pipeline is impossible to debug from logs alone unless every line carries the id of
 * the request that started it. The `injectCorrelationId` format below pulls that id out of
 * AsyncLocalStorage, so an HTTP handler and the queue worker it eventually triggers both stamp
 * the same value without anybody passing it around by hand.
 */
const injectCorrelationId = winston.format((info) => {
  const correlationId = getCorrelationId();
  if (correlationId && !info['correlationId']) {
    info['correlationId'] = correlationId;
  }
  return info;
});

const devFormat = winston.format.combine(
  injectCorrelationId(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize({ all: false }),
  winston.format.printf((info) => {
    const { timestamp, level, message, context, correlationId, stack, ...meta } = info;
    const ctx = context ? `[${context as string}] ` : '';
    // Eight characters is enough to eyeball-match a trace without swamping the line.
    const cid = correlationId ? `<${String(correlationId).slice(0, 8)}> ` : '';
    const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const err = stack ? `\n${stack as string}` : '';
    return `${timestamp as string} ${level.padEnd(15)} ${cid}${ctx}${message as string}${rest}${err}`;
  }),
);

const jsonFormat = winston.format.combine(
  injectCorrelationId(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

/** Winston options for WinstonModule.forRoot(). */
export function loggerOptions(level: string, isProduction: boolean): WinstonModuleOptions {
  return {
    level,
    format: isProduction ? jsonFormat : devFormat,
    transports: [new winston.transports.Console()],
    // Never let a logging failure take the process down.
    exitOnError: false,
  };
}
