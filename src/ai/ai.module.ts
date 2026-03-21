import { Module } from '@nestjs/common';
import { AIService } from './ai.service';
import { AIController } from './ai.controller';
import { ClustersModule } from '../clusters/clusters.module';

@Module({
  imports: [ClustersModule],
  controllers: [AIController],
  providers: [AIService],
})
export class AIModule {}
