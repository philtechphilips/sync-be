import * as dotenv from 'dotenv';
import * as joi from 'joi';

dotenv.config();

const schema = joi
  .object({
    PORT: joi.number().required(),
    ENVIRONMENT: joi.string().valid('development', 'production', 'staging').required(),
    DATABASE_HOST: joi.string().required(),
    DATABASE_PORT: joi.string().required(),
    DATABASE_USERNAME: joi.string().required(),
    DATABASE_PASSWORD: joi.string().required(),
    DATABASE_NAME: joi.string().required(),
    JWTSECRET: joi.string().required(),
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
  JWTSECRET: envVars.JWTSECRET,
  DB: {
    PORT: Number(envVars.DATABASE_PORT),
    HOST: envVars.DATABASE_HOST,
    USER: envVars.DATABASE_USERNAME,
    PASSWORD: envVars.DATABASE_PASSWORD,
    NAME: envVars.DATABASE_NAME,
    TRIPS_NAME: envVars.DATABASE_TRIPS_NAME,
  }
};
