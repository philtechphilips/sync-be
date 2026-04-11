import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { datasourceOptions } from './config/typeorm.config';
import { AuthModule } from './auth/auth.module';
import { ClustersModule } from './clusters/clusters.module';
import { AIModule } from './ai/ai.module';
import { QueryManagementModule } from './query-management/query-management.module';
import { AgentModule } from './agent/agent.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(datasourceOptions),
    AuthModule,
    ClustersModule,
    AIModule,
    QueryManagementModule,
    AgentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
