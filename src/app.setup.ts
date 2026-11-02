import { Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import cookieParser from 'cookie-parser';
import * as express from 'express';
import { config } from './config/config.service';

/** HTTP setup shared by the server and the e2e tests. */
export function configureApp(app: NestExpressApplication) {
  app.set('trust proxy', config.TRUST_PROXY);

  // Only restores carry large bodies.
  app.use('/v1/clusters/:id/restore', express.json({ limit: '100mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));
  app.use(cookieParser());
  app.use(helmet());

  app.enableCors({
    origin: [config.FRONTEND_URL],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // With several instances, counters must be shared or each one allows the full budget.
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL) : null;
  let limiters = 0;
  const limiter = (windowMinutes: number, max: number, message: string) =>
    rateLimit({
      windowMs: windowMinutes * 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, message },
      ...(redis
        ? {
            store: new RedisStore({
              prefix: `synq:rl:${limiters++}:`,
              sendCommand: (command: string, ...args: string[]) =>
                redis.call(command, ...args) as Promise<any>,
            }),
          }
        : {}),
    });

  app.use(
    limiter(
      15,
      3000,
      'Too many requests from this IP, please try again later.',
    ),
  );
  app.use(
    '/v1/ai',
    limiter(
      15,
      300,
      'AI query limit reached. Please wait before sending more requests.',
    ),
  );
  app.use(
    '/v1/auth',
    limiter(
      15,
      500,
      'Too many authentication requests. Please try again later.',
    ),
  );
  // Credential-guessing endpoints get a much tighter budget.
  for (const path of [
    '/v1/auth/login',
    '/v1/auth/register',
    '/v1/auth/forgot-password',
    '/v1/auth/reset-password',
    '/v1/auth/cli-login/authorize',
  ]) {
    app.use(
      path,
      limiter(
        15,
        20,
        'Too many attempts. Please wait 15 minutes and try again.',
      ),
    );
  }

  // Strip any property a DTO doesn't declare, so request bodies can never
  // set fields like `role`, `userId` or `id`.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
}
