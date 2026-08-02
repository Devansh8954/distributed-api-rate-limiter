import winston from 'winston';
import config from '../config';

const isProd = config.nodeEnv === 'production';

// Dev: colorized human-readable output  |  Prod: structured JSON for log aggregators
const devFmt = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `  ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);
const prodFmt = winston.format.combine(winston.format.timestamp(), winston.format.json());

const logger = winston.createLogger({
  level: isProd ? 'warn' : 'info',
  format: isProd ? prodFmt : devFmt,
  transports: [new winston.transports.Console()],
});

export default logger;
