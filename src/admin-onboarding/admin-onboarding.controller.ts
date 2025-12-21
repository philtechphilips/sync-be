import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorators';
import { AdminOnboardingService } from './admin-onboarding.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';

@Controller('/v1/admin/onboarding')
export class AdminOnboardingController {
  constructor(
    private readonly adminOnboardingService: AdminOnboardingService,
  ) {}

  @Post('/')
  @Public()
  async createWorkspace(
    @Body(ValidationPipe) createWorkspaceDto: CreateWorkspaceDto,
  ) {
    try {
      const result =
        await this.adminOnboardingService.createWorkspaceAndUser(
          createWorkspaceDto,
        );
      return {
        success: true,
        message: 'Workspace and admin user created successfully',
        data: result,
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
