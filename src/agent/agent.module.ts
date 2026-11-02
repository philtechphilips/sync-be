import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/user.entity';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';
import { AgentBus } from './agent-bus';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [AgentGateway, AgentService, AgentBus],
  exports: [AgentService],
})
export class AgentModule {}
