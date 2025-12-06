import * as dotenv from 'dotenv';
import * as joi from 'joi';

dotenv.config();

const schema = joi
  .object({
    PORT: joi.number().required(),
    ENVIRONMENT: joi
      .string()
      .valid('development', 'production', 'staging')
      .required(),
    DATABASE_URL: joi.string().required(),
    JWTSECRET: joi.string().required(),
    JWT_REFRESH_SECRET: joi.string().optional(),
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
  })
  .unknown()
  .required();

const { error, value: envVars } = schema.validate(process.env);
if (error) {
  throw Error(`ENV validation error: ${error.message}`);
}

export const config = {
  PORT: {
    APP_PORT: envVars.PORT,
  },
  ENVIRONMENT: envVars.ENVIRONMENT,
  JWT: {
    SECRET: envVars.JWTSECRET,
    REFRESH_SECRET: envVars.JWT_REFRESH_SECRET || envVars.JWTSECRET,
    ACCESS_EXPIRATION: envVars.JWT_ACCESS_EXPIRATION || '15m',
    REFRESH_EXPIRATION: envVars.JWT_REFRESH_EXPIRATION || '7d',
  },
  DB: {
    URL: envVars.DATABASE_URL,
    TRIPS_NAME: envVars.DATABASE_TRIPS_NAME,
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
};
