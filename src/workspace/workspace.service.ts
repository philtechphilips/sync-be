import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { WorkspaceRepository } from './repository/workspace.repository';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { InviteMembersDto } from './dto/invite-member.dto';
import { WorkspaceSettingsDto } from './dto/workspace-settings.dto';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { EmailService } from '../common/services/email.service';
import { AuthRepo } from '../auth/repository/auth.repository';


@Injectable()
export class WorkSpaceService {
  constructor(
    private readonly workspaceRepository: WorkspaceRepository,
    @InjectRepository(WorkspaceMember)
    private readonly workspaceMemberRepository: Repository<WorkspaceMember>,
    private readonly emailService: EmailService,
    private readonly authRepo: AuthRepo,
  ) { }

  /**
   * Create workspace with basic information
   */
  async createWorkspace(
    createWorkspaceDto: CreateWorkspaceDto,
    userId: string,
  ): Promise<{ workspace: Workspace }> {
    // Check if workspace URL is already taken
    const existingWorkspace = await this.workspaceRepository.findOne({
      workspace_url: createWorkspaceDto.workspace_url,
    });

    if (existingWorkspace) {
      throw new BadRequestException(
        'Workspace URL is already taken. Please choose a different one.',
      );
    }

    // Generate unique key for workspace
    const uniqueKey = this.generateUniqueKey();

    // Create workspace
    const workspace = await this.workspaceRepository.create({
      name: createWorkspaceDto.name,
      industry_type: createWorkspaceDto.industry_type,
      workspace_url: createWorkspaceDto.workspace_url,
      description: createWorkspaceDto.description,
      unique_key: uniqueKey,
      created_by: userId,
      default_language: 'en',
      default_currency: 'USD',
      default_timezone: 'UTC',
      theme: 'light',
      can_invite_teammates: false,
      can_manage_settings: false,
      can_view_analytics: false,
    });

    return { workspace };
  }

  /**
   * Invite team members
   */
  async inviteMembers(
    workspaceId: string,
    inviteMembersDto: InviteMembersDto,
    userId: string,
  ): Promise<{ members: WorkspaceMember[] }> {
    // Verify workspace exists and user is the creator
    const workspace = await this.workspaceRepository.findOne({
      id: workspaceId,
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.created_by !== userId) {
      throw new UnauthorizedException(
        'You are not authorized to invite members to this workspace',
      );
    }

    // Get inviter information
    const inviter = await this.authRepo.findOne({ id: userId });
    if (!inviter) {
      throw new NotFoundException('User not found');
    }

    const inviterName = inviter.full_name || inviter.email;

    // Update workspace permissions if provided
    const workspaceUpdateData: any = {};
    if (inviteMembersDto.can_invite_teammates !== undefined) {
      workspaceUpdateData.can_invite_teammates = inviteMembersDto.can_invite_teammates;
    }
    if (inviteMembersDto.can_manage_settings !== undefined) {
      workspaceUpdateData.can_manage_settings = inviteMembersDto.can_manage_settings;
    }
    if (inviteMembersDto.can_view_analytics !== undefined) {
      workspaceUpdateData.can_view_analytics = inviteMembersDto.can_view_analytics;
    }

    // Update workspace if any permissions are provided
    if (Object.keys(workspaceUpdateData).length > 0) {
      await this.workspaceRepository.findOneAndUpdate(
        { id: workspaceId },
        workspaceUpdateData,
      );
    }

    // Create members and send invitations
    const members: WorkspaceMember[] = [];
    const errors: string[] = [];

    for (const memberDto of inviteMembersDto.members) {

      // Check if member already exists for this workspace
      const existingMember = await this.workspaceMemberRepository.findOne({
        where: {
          workspace_id: workspaceId,
          email: memberDto.email,
        },
      });

      if (existingMember) {
        errors.push(
          `Member with email ${memberDto.email} is already invited`,
        );
        continue;
      }

      // Generate invitation token
      const invitationToken = this.generateInvitationToken();
      const invitationExpiresAt = new Date();
      invitationExpiresAt.setDate(invitationExpiresAt.getDate() + 7); // 7 days expiry

      // Create workspace member
      const member = await this.workspaceMemberRepository.save({
        workspace_id: workspaceId,
        email: memberDto.email,
        role: memberDto.role,
        invitation_token: invitationToken,
        invitation_sent_at: new Date(),
        invitation_expires_at: invitationExpiresAt,
      });

      await this.emailService.sendWorkspaceInvitationEmail(
        memberDto.email,
        workspace.name,
        inviterName,
        invitationToken,
      );

      members.push(member);
    }

    if (members.length === 0 && errors.length > 0) {
      throw new BadRequestException(
        `Failed to invite members: ${errors.join(', ')}`,
      );
    }

    return { members };
  }

  /**
   * Set workspace settings (language, currency, timezone, theme)
   */
  async workspaceSettings(
    workspaceId: string,
    workspaceSettingsDto: WorkspaceSettingsDto,
    userId: string,
  ): Promise<{ workspace: Workspace }> {
    // Verify workspace exists and user is the creator
    const workspace = await this.workspaceRepository.findOne({
      id: workspaceId,
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.created_by !== userId) {
      throw new UnauthorizedException(
        'You are not authorized to update this workspace',
      );
    }

    // Update workspace settings
    const updateData: any = {
      default_language: workspaceSettingsDto.default_language,
      default_currency: workspaceSettingsDto.default_currency,
      default_timezone: workspaceSettingsDto.default_timezone,
      theme: workspaceSettingsDto.theme,
    };

    const updatedWorkspace = await this.workspaceRepository.findOneAndUpdate(
      { id: workspaceId },
      updateData,
    );

    if (!updatedWorkspace) {
      throw new NotFoundException('Workspace not found after update');
    }

    return { workspace: updatedWorkspace };
  }

  /**
   * Get workspace by ID
   */
  async getWorkspaceById(workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepository.findOne(
      { id: workspaceId },
      { members: { user: true } },
    );

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  /**
   * Generate unique key for workspace
   */
  private generateUniqueKey(): string {
    const randomBytes = crypto.randomBytes(8).toString('hex');
    return `ws_${randomBytes}`;
  }

  /**
   * Generate invitation token
   */
  private generateInvitationToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
