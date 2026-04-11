import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  UseGuards,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
  Request,
  Res,
  Query,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { UpdateAuthDto } from './dto/update.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LocalGuard } from './guards/local.guard';
import { JwtAuthGuard } from './guards/jwt.guard';
import { RegisterAuthDto } from './dto/register.dto';
import { Public } from './decorators/public.decorators';
import { Roles } from './decorators/role.decorators';
import { Role } from '../common/enums/role.enum';
import { LoginAuthDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { config } from '../config/config.service';

@Controller('/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @UseGuards(LocalGuard)
  @UsePipes(ValidationPipe)
  async login(@Body() authDto: LoginAuthDto) {
    try {
      const response = await this.authService.validateUser(authDto);
      return {
        success: true,
        user: {
          id: response.id,
          email: response.email,
          full_name: response.full_name,
          role: response.role,
          profile_picture: response.profile_picture,
          settings: response.settings,
        },
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        message: 'User logged in successfully!',
      };
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }

  @Post('refresh')
  @Public()
  @UsePipes(ValidationPipe)
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    try {
      const response = await this.authService.refreshToken(
        refreshTokenDto.refresh_token,
      );
      return response;
    } catch (error) {
      if (error.status === 401) {
        throw new HttpException(
          { success: false, message: error.message },
          HttpStatus.UNAUTHORIZED,
        );
      }
      console.error('Token refresh error:', error);
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('register')
  @Public()
  @UsePipes(ValidationPipe)
  async create(@Body() registerDto: RegisterAuthDto) {
    try {
      const { password, ...user } = await this.authService.create(registerDto);
      return {
        success: true,
        data: user,
        message: 'Account created successfully!',
      };
    } catch (error) {
      if (error.status === 400) {
        throw new HttpException(
          { success: false, message: error.message },
          HttpStatus.BAD_REQUEST,
        );
      } else {
        console.error('Registration error:', error);
        throw new HttpException(
          { success: false, message: 'Something went wrong!' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
  }

  @Get('oauth/google')
  @Public()
  async initiateGoogleAuth(@Res() res: Response) {
    try {
      const authUrl = this.authService.getGoogleAuthUrl();
      res.redirect(authUrl);
    } catch (error) {
      console.error('Google OAuth initialization error:', error);
      throw new HttpException(
        { success: false, message: 'Failed to initiate Google OAuth' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('oauth/google/callback')
  @Public()
  async googleCallback(@Query('code') code: string, @Res() res: Response) {
    try {
      if (!code) {
        return res.redirect(
          `${config.FRONTEND_URL}/auth/error?message=Authorization code not provided`,
        );
      }

      const response = await this.authService.handleGoogleCallback(code);

      // Redirect to frontend with tokens as query params or use a more secure method
      // For better security, you might want to set tokens in HTTP-only cookies instead
      const redirectUrl = new URL(`${config.FRONTEND_URL}/auth/callback`);
      redirectUrl.searchParams.set('access_token', response.access_token);
      redirectUrl.searchParams.set('refresh_token', response.refresh_token);
      redirectUrl.searchParams.set('user_id', response.id);

      res.redirect(redirectUrl.toString());
    } catch (error) {
      console.error('Google OAuth callback error:', error);
      const errorMessage = encodeURIComponent(
        error.message || 'Failed to authenticate with Google',
      );
      return res.redirect(
        `${config.FRONTEND_URL}/auth/error?message=${errorMessage}`,
      );
    }
  }

  @Get('status')
  @Roles(Role.User)
  @UseGuards(JwtAuthGuard)
  status(@Request() req: any) {
    return this.authService.update(req.user.id, {}); // re-fetch fresh user
  }

  @Patch('/')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  update(@Request() req: any, @Body() updateAuthDto: UpdateAuthDto) {
    return this.authService.update(req.user.id, updateAuthDto);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  updateProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(req.user.id, dto);
  }

  @Patch('password')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  @Post('forgot-password')
  @Public()
  @UsePipes(ValidationPipe)
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    try {
      return await this.authService.forgotPassword(forgotPasswordDto);
    } catch (error) {
      if (error.status === 400) {
        throw new HttpException(
          { success: false, message: error.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      console.error('Forgot password error:', error);
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('agent-key')
  @UseGuards(JwtAuthGuard)
  getAgentKey(@Request() req: any) {
    return this.authService.getAgentKey(req.user.id);
  }

  @Post('rotate-agent-key')
  @UseGuards(JwtAuthGuard)
  rotateAgentKey(@Request() req: any) {
    return this.authService.rotateAgentKey(req.user.id);
  }

  @Get('agent-status')
  @UseGuards(JwtAuthGuard)
  getAgentStatus(@Request() req: any) {
    return this.authService.getAgentStatus(req.user.id);
  }

  @Post('reset-password')
  @Public()
  @UsePipes(ValidationPipe)
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    try {
      return await this.authService.resetPassword(resetPasswordDto);
    } catch (error) {
      if (error.status === 400) {
        throw new HttpException(
          { success: false, message: error.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      console.error('Reset password error:', error);
      throw new HttpException(
        { success: false, message: 'Something went wrong!' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
