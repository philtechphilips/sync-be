import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkSpaceController } from './workspace.controller';
import { WorkSpaceService } from './workspace.service';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { WorkspaceRepository } from './repository/workspace.repository';
import { EmailService } from '../common/services/email.service';
import { AuthRepo } from '../auth/repository/auth.repository';
import { User } from '../auth/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Workspace, WorkspaceMember, User])],
  controllers: [WorkSpaceController],
  providers: [WorkSpaceService, WorkspaceRepository, EmailService, AuthRepo],
  exports: [WorkSpaceService],
})
export class WorkspaceModule {}
