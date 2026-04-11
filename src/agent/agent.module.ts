import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/user.entity';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [AgentGateway, AgentService],
  exports: [AgentService],
})
export class AgentModule {}
