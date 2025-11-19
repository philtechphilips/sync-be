import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { datasourceOptions } from './database/typeorm.config';

@Module({
  imports: [
     TypeOrmModule.forRoot(datasourceOptions),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
