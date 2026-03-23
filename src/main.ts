import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
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

  // app.use(
  //   rateLimit({
  //     windowMs: 15 * 60 * 1000,
  //     max: 10000,
  //     standardHeaders: true,
  //     legacyHeaders: false,
  //     message: 'Too many requests from this IP, please try again later.',
  //   }),
  // );

  await app.listen(config.PORT.APP_PORT, () => {
    logger.log(`Server started on ${config.PORT.APP_PORT}`);
  });
}
bootstrap();
