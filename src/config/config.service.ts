import * as dotenv from 'dotenv';
import * as joi from 'joi';

// Tests set SKIP_DOTENV so a developer's real .env is never loaded.
if (process.env.SKIP_DOTENV !== '1') dotenv.config({ quiet: true });

const schema = joi
  .object({
    PORT: joi.number().required(),
    ENVIRONMENT: joi
      .string()
      .valid('development', 'production', 'staging', 'test')
      .required(),
    DB_HOST: joi.string().required(),
    DB_PORT: joi.number().default(3306),
    DB_USERNAME: joi.string().required(),
    DB_PASSWORD: joi.string().allow('').required(),
    DB_NAME: joi.string().required(),
    DB_ENCRYPTION_KEY: joi.string().hex().length(64).required().messages({
      'string.length':
        'DB_ENCRYPTION_KEY must be 64 hex characters (32 bytes).',
      'string.hex': 'DB_ENCRYPTION_KEY must be 64 hex characters (32 bytes).',
    }),
    JWTSECRET: joi.string().required(),
    JWT_RESET_SECRET: joi.string().min(16).optional(),
    JWT_ACCESS_EXPIRATION: joi.string().default('15m'),
    JWT_REFRESH_EXPIRATION: joi.string().default('7d'),
    GOOGLE_CLIENT_ID: joi.string().required(),
    GOOGLE_CLIENT_SECRET: joi.string().required(),
    GOOGLE_REDIRECT_URI: joi.string().required(),
    FRONTEND_URL: joi.string().optional(),
    SMTP_HOST: joi.string().default('smtp.gmail.com'),
    SMTP_PORT: joi.number().default(587),
    SMTP_USER: joi.string().required(),
    SMTP_PASS: joi.string().required(),
    SMTP_FROM: joi.string().optional(),
    OPENAI_API_KEY: joi.string().optional(),
    // Lets cluster hosts resolve to private/loopback addresses. Defaults to
    // true only in development; production should use the local agent.
    ALLOW_PRIVATE_DB_HOSTS: joi.boolean().optional(),
    // Express "trust proxy" setting, so rate limits see the real client IP
    // behind nginx. "loopback" trusts a proxy on the same machine.
    TRUST_PROXY: joi.string().default('loopback'),
    COOKIE_SAMESITE: joi.string().valid('lax', 'strict', 'none').default('lax'),
    COOKIE_DOMAIN: joi.string().optional(),
    // Set when running more than one API instance: agent routing and rate
    // limits are then shared through Redis.
    REDIS_URL: joi
      .string()
      .uri({ scheme: ['redis', 'rediss'] })
      .optional(),
  })
  .unknown()
  .required();

const { error, value: envVars } = schema.validate(process.env);
if (error) {
  throw new Error(`ENV validation error: ${error.message}`);
}

const isDevelopment = envVars.ENVIRONMENT === 'development';

export const configWarnings: string[] = [];
if (String(envVars.JWTSECRET).length < 32) {
  configWarnings.push(
    'JWTSECRET is shorter than 32 characters. Generate a longer random secret (e.g. `openssl rand -hex 32`).',
  );
}

export const config = {
  PORT: {
    APP_PORT: envVars.PORT,
  },
  ENVIRONMENT: envVars.ENVIRONMENT,
  JWT: {
    SECRET: envVars.JWTSECRET,
    RESET_SECRET:
      envVars.JWT_RESET_SECRET || `${envVars.JWTSECRET}:password-reset`,
    ACCESS_EXPIRATION: envVars.JWT_ACCESS_EXPIRATION || '15m',
    REFRESH_EXPIRATION: envVars.JWT_REFRESH_EXPIRATION || '7d',
  },
  DB: {
    HOST: envVars.DB_HOST,
    PORT: envVars.DB_PORT,
    USERNAME: envVars.DB_USERNAME,
    PASSWORD: envVars.DB_PASSWORD,
    NAME: envVars.DB_NAME,
    ENCRYPTION_KEY: envVars.DB_ENCRYPTION_KEY,
  },
  GOOGLE: {
    CLIENT_ID: envVars.GOOGLE_CLIENT_ID,
    CLIENT_SECRET: envVars.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI: envVars.GOOGLE_REDIRECT_URI,
  },
  FRONTEND_URL: envVars.FRONTEND_URL || 'http://localhost:3000',
  SMTP: {
    HOST: envVars.SMTP_HOST || 'smtp.gmail.com',
    PORT: envVars.SMTP_PORT || 587,
    USER: envVars.SMTP_USER,
    PASS: envVars.SMTP_PASS,
    FROM: envVars.SMTP_FROM || envVars.SMTP_USER,
  },
  OPENAI_API_KEY: envVars.OPENAI_API_KEY as string | undefined,
  ALLOW_PRIVATE_DB_HOSTS:
    (envVars.ALLOW_PRIVATE_DB_HOSTS as boolean | undefined) ?? isDevelopment,
  TRUST_PROXY: envVars.TRUST_PROXY as string,
  REDIS_URL: envVars.REDIS_URL as string | undefined,
  COOKIE: {
    SECURE: !isDevelopment && envVars.ENVIRONMENT !== 'test',
    SAMESITE: envVars.COOKIE_SAMESITE as 'lax' | 'strict' | 'none',
    DOMAIN: envVars.COOKIE_DOMAIN as string | undefined,
  },
};
