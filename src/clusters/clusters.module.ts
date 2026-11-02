import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClustersService } from './clusters.service';
import { ClustersController } from './clusters.controller';
import { TransferService } from './transfer.service';
import { Cluster } from './entities/cluster.entity';
import { QueryLog } from './entities/query-log.entity';
import { User } from '../auth/entities/user.entity';
import { CryptographyService } from '../common/services/cryptography.service';
import { AgentModule } from '../agent/agent.module';
import { ConnectionManager } from './engine/connection-manager';
import { DbExecutor } from './engine/executor';

@Module({
  imports: [TypeOrmModule.forFeature([Cluster, QueryLog, User]), AgentModule],
  controllers: [ClustersController],
  providers: [
    ClustersService,
    TransferService,
    CryptographyService,
    ConnectionManager,
    DbExecutor,
  ],
  exports: [ClustersService],
})
export class ClustersModule {}
