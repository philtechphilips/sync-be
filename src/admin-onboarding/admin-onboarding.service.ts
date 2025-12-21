import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { WorkSpaceService } from '../workspace/workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { RegisterAuthDto } from '../auth/dto/register.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkspaceMember } from '../workspace/entities/workspace-member.entity';
import { WorkspaceRepository } from '../workspace/repository/workspace.repository';
import { AuthRepo } from '../auth/repository/auth.repository';

@Injectable()
export class AdminOnboardingService {
  constructor(
    private readonly authService: AuthService,
    private readonly workspaceService: WorkSpaceService,
    private readonly workspaceRepository: WorkspaceRepository,
    private readonly authRepo: AuthRepo,
    @InjectRepository(WorkspaceMember)
    private readonly workspaceMemberRepository: Repository<WorkspaceMember>,
  ) {}

  async createWorkspaceAndUser(createWorkspaceDto: CreateWorkspaceDto) {
    try {
      // Check if user already exists
      const existingUser = await this.authRepo.findOne({
        email: createWorkspaceDto.admin_email,
      });

      if (existingUser) {
        throw new ConflictException('User with this email already exists');
      }

      // Check if workspace URL is already taken
      const existingWorkspace = await this.workspaceRepository.findOne({
        workspace_url: createWorkspaceDto.workspace_url,
      });

      if (existingWorkspace) {
        throw new ConflictException(
          'Workspace URL is already taken. Please choose a different one.',
        );
      }

      // Create user account
      const registerDto: RegisterAuthDto = {
        email: createWorkspaceDto.admin_email,
        password: createWorkspaceDto.admin_password,
        full_name: createWorkspaceDto.admin_full_name,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      };

      const user = await this.authService.create(registerDto);

      // Create workspace
      const workspaceDto = {
        name: createWorkspaceDto.workspace_name,
        industry_type: createWorkspaceDto.industry_type,
        workspace_url: createWorkspaceDto.workspace_url,
        description: `Workspace for ${createWorkspaceDto.company_name}`,
      };

      const { workspace } = await this.workspaceService.createWorkspace(
        workspaceDto,
        user.id,
      );

      // Update workspace with onboarding plan
      const updatedWorkspace = await this.workspaceRepository.findOneAndUpdate(
        { id: workspace.id },
        { onboarding_plan: createWorkspaceDto.onboarding_plan },
      );

      // Create workspace member entry for the admin user
      const workspaceMember = await this.workspaceMemberRepository.save({
        workspace_id: workspace.id,
        user_id: user.id,
        email: user.email,
        role: 'user',
        invitation_accepted_at: new Date(),
      });

      // Remove sensitive information from user object
      const { password: _, ...userWithoutPassword } = user;

      return {
        user: userWithoutPassword,
        workspace: updatedWorkspace || {
          ...workspace,
          onboarding_plan: createWorkspaceDto.onboarding_plan,
        },
        workspaceMember,
      };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      console.error('Error creating workspace and user:', error);
      throw error;
    }
  }
}
