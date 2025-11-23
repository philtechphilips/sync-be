import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { datasourceOptions } from './config/typeorm.config';
import { AuthModule } from './auth/auth.module';
import { WorkspaceModule } from './workspace/workspace.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(datasourceOptions),
    AuthModule,
    WorkspaceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
