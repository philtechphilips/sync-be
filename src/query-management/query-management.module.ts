import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedQuery } from './entities/saved-query.entity';
import { Collection } from './entities/collection.entity';
import { QueryManagementService } from './query-management.service';
import { QueryManagementController } from './query-management.controller';
import { ClustersModule } from '../clusters/clusters.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SavedQuery, Collection]),
    ClustersModule,
  ],
  controllers: [QueryManagementController],
  providers: [QueryManagementService],
  exports: [QueryManagementService],
})
export class QueryManagementModule {}
