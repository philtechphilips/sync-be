import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClustersService } from './clusters.service';
import { ClustersController } from './clusters.controller';
import { Cluster } from './entities/cluster.entity';
import { QueryLog } from './entities/query-log.entity';
import { CryptographyService } from '../common/services/cryptography.service';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [TypeOrmModule.forFeature([Cluster, QueryLog]), AgentModule],
  controllers: [ClustersController],
  providers: [ClustersService, CryptographyService],
  exports: [ClustersService],
})
export class ClustersModule {}
