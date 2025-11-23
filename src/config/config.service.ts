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
    DATABASE_HOST: joi.string().required(),
    DATABASE_PORT: joi.string().required(),
    DATABASE_USERNAME: joi.string().required(),
    DATABASE_PASSWORD: joi.string().required(),
    DATABASE_NAME: joi.string().required(),
    JWTSECRET: joi.string().required(),
    JWT_REFRESH_SECRET: joi.string().optional(),
    JWT_ACCESS_EXPIRATION: joi.string().default('15m'),
    JWT_REFRESH_EXPIRATION: joi.string().default('7d'),
    GOOGLE_CLIENT_ID: joi.string().required(),
    GOOGLE_CLIENT_SECRET: joi.string().required(),
    GOOGLE_REDIRECT_URI: joi.string().required(),
    FRONTEND_URL: joi.string().optional(),
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
    PORT: Number(envVars.DATABASE_PORT),
    HOST: envVars.DATABASE_HOST,
    USER: envVars.DATABASE_USERNAME,
    PASSWORD: envVars.DATABASE_PASSWORD,
    NAME: envVars.DATABASE_NAME,
    TRIPS_NAME: envVars.DATABASE_TRIPS_NAME,
  },
  GOOGLE: {
    CLIENT_ID: envVars.GOOGLE_CLIENT_ID,
    CLIENT_SECRET: envVars.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI: envVars.GOOGLE_REDIRECT_URI,
  },
  FRONTEND_URL: envVars.FRONTEND_URL || 'http://localhost:3000',
};
