import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cluster } from '../clusters/entities/cluster.entity';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';

@Module({
  imports: [TypeOrmModule.forFeature([Cluster])],
  providers: [AgentGateway, AgentService],
  exports: [AgentService],
})
export class AgentModule {}
