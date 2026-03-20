import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClustersService } from './clusters.service';
import { ClustersController } from './clusters.controller';
import { Cluster } from './entities/cluster.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Cluster])],
  controllers: [ClustersController],
  providers: [ClustersService],
  exports: [ClustersService],
})
export class ClustersModule {}
