import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { config, configWarnings } from './config/config.service';

async function bootstrap() {
  const logger = new Logger('Server');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureApp(app);
  app.enableShutdownHooks();

  for (const warning of configWarnings) logger.warn(warning);
  await app.listen(config.PORT.APP_PORT, () => {
    logger.log(`Server started on ${config.PORT.APP_PORT}`);
  });
}
void bootstrap();
