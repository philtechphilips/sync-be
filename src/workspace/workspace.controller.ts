import {
  Controller,
  Post,
  Body,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Request,
  Get,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { WorkSpaceService } from './workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { InviteMembersDto } from './dto/invite-member.dto';
import { WorkspaceSettingsDto } from './dto/workspace-settings.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { Public } from '../auth/decorators/public.decorators';

@Controller('/v1/workspace')
export class WorkSpaceController {
  constructor(private readonly workSpaceService: WorkSpaceService) {}

  /**
   * Create workspace with basic information
   */
  @Post('/')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  async createWorkspace(
    @Request() req: any,
    @Body() createWorkspaceDto: CreateWorkspaceDto,
  ) {
    try {
      const result = await this.workSpaceService.createWorkspace(
        createWorkspaceDto,
        req.user.id,
      );
      return {
        success: true,
        data: result,
        message: 'Workspace created successfully.',
      };
    } catch (error) {
      if (error.status) {
        throw new HttpException(
          { success: false, message: error.message },
          error.status,
        );
      }
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Invite team members
   */
  @Post('invite-members/:workspaceId')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  async inviteMembers(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Body() inviteMembersDto: InviteMembersDto,
  ) {
    try {
      const result = await this.workSpaceService.inviteMembers(
        workspaceId,
        inviteMembersDto,
        req.user.id,
      );
      return {
        success: true,
        data: result,
        message: 'Team members invited successfully.',
      };
    } catch (error) {
      if (error.status) {
        throw new HttpException(
          { success: false, message: error.message },
          error.status,
        );
      }
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Set workspace settings
   */
  @Post('settings/:workspaceId')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  async workspaceSettings(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Body() workspaceSettingsDto: WorkspaceSettingsDto,
  ) {
    try {
      const result = await this.workSpaceService.workspaceSettings(
        workspaceId,
        workspaceSettingsDto,
        req.user.id,
      );
      return {
        success: true,
        data: result,
        message: 'Workspace settings updated successfully!',
      };
    } catch (error) {
      if (error.status) {
        throw new HttpException(
          { success: false, message: error.message },
          error.status,
        );
      }
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Accept workspace invitation
   * If user doesn't exist, they will need to provide password and fullName to create an account
   */
  @Post('accept-invite')
  @Public()
  @UsePipes(ValidationPipe)
  async acceptInvite(@Body() acceptInviteDto: AcceptInviteDto) {
    try {
      const result = await this.workSpaceService.acceptInvite(acceptInviteDto);
      return {
        success: true,
        data: result,
        message: 'Workspace invitation accepted successfully.',
      };
    } catch (error) {
      if (error.status) {
        throw new HttpException(
          { success: false, message: error.message },
          error.status,
        );
      }
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get workspace by ID
   */
  @Get(':workspaceId')
  @UseGuards(JwtAuthGuard)
  async getWorkspace(@Param('workspaceId') workspaceId: string) {
    try {
      const workspace =
        await this.workSpaceService.getWorkspaceById(workspaceId);
      return {
        success: true,
        data: workspace,
        message: 'Workspace retrieved successfully.',
      };
    } catch (error) {
      if (error.status) {
        throw new HttpException(
          { success: false, message: error.message },
          error.status,
        );
      }
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
