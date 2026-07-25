import winston from 'winston';
import config from '../config';

/**
 * Structured JSON logger using Winston.
 *
 * Development: pretty colored output for readability
 * Production:  JSON format — easy to parse by Datadog, CloudWatch, etc.
 */
const logger = winston.createLogger({
  level: config.nodeEnv === 'production' ? 'warn' : 'info',

  format:
    config.nodeEnv === 'production'
      ? winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.printf(({ level, message, timestamp, ...meta }) => {
            const metaStr = Object.keys(meta).length
              ? `  ${JSON.stringify(meta)}`
              : '';
            return `${timestamp} [${level}]: ${message}${metaStr}`;
          })
        ),

  transports: [new winston.transports.Console()],
});

export default logger;
