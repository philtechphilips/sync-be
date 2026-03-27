import { NestFactory, Reflector } from '@nestjs/core';
import { Logger, ClassSerializerInterceptor } from '@nestjs/common';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { config } from './config/config.service';

async function bootstrap() {
  const logger = new Logger('Server');

  const app = await NestFactory.create(AppModule);

  const express = require('express');
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  app.use(helmet());

  app.enableCors({
    origin: [config.FRONTEND_URL],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // General rate limit — 300 requests per 15 minutes per IP
  // app.use(
  //   rateLimit({
  //     windowMs: 15 * 60 * 1000,
  //     max: 300,
  //     standardHeaders: true,
  //     legacyHeaders: false,
  //     message: 'Too many requests from this IP, please try again later.',
  //   }),
  // );

  // Stricter limit for AI SQL generation — 30 requests per 15 minutes per IP
  // app.use(
  //   '/v1/ai',
  //   rateLimit({
  //     windowMs: 15 * 60 * 1000,
  //     max: 30,
  //     standardHeaders: true,
  //     legacyHeaders: false,
  //     message:
  //       'AI query limit reached. Please wait before sending more requests.',
  //   }),
  // );

  // Stricter limit for auth endpoints — 20 attempts per 15 minutes per IP
  // app.use(
  //   '/v1/auth',
  //   rateLimit({
  //     windowMs: 15 * 60 * 1000,
  //     max: 20,
  //     standardHeaders: true,
  //     legacyHeaders: false,
  //     message: 'Too many authentication attempts. Please try again later.',
  //   }),
  // );

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  await app.listen(config.PORT.APP_PORT, () => {
    logger.log(`Server started on ${config.PORT.APP_PORT}`);
  });
}
bootstrap();
