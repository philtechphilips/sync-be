import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminOnboardingController } from './admin-onboarding.controller';
import { AdminOnboardingService } from './admin-onboarding.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { WorkspaceMember } from '../workspace/entities/workspace-member.entity';
import { WorkspaceRepository } from '../workspace/repository/workspace.repository';
import { AuthRepo } from '../auth/repository/auth.repository';
import { User } from '../auth/entities/user.entity';
import { Workspace } from '../workspace/entities/workspace.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkspaceMember, User, Workspace]),
    AuthModule,
    WorkspaceModule,
  ],
  controllers: [AdminOnboardingController],
  providers: [AdminOnboardingService, WorkspaceRepository, AuthRepo],
})
export class AdminOnboardingModule {}
