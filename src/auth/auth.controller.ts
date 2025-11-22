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
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { UpdateAuthDto } from './dto/update.dto';
import { LocalGuard } from './guards/local.guard';
import { JwtAuthGuard } from './guards/jwt.guard';
import { RegisterAuthDto } from './dto/register.dto';
import { Public } from './decorators/public.decorators';
import { Roles } from './decorators/role.decorators';
import { Role } from '../common/enums/role.enum';
import { LoginAuthDto } from './dto/login.dto';
import { GoogleDto } from './dto/google.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

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
        },
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        message: 'User logged in successfully!',
      };
    } catch (error) {
      console.log(error);
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
        throw new HttpException(
          { success: false, message: 'Something went wrong!' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
  }

  @Post('oauth/google')
  @Public()
  @UsePipes(ValidationPipe)
  async google(@Body() googleDto: GoogleDto) {
    try {
      const response = await this.authService.google(googleDto);
      return { success: true, user: response, message: 'User logged in!' };
    } catch (error) {
      console.log(error);
    }
  }

  @Get('status')
  @Roles(Role.User)
  @UseGuards(JwtAuthGuard)
  status(@Request() req) {
    return req.user;
  }

  @Patch('/')
  @UseGuards(JwtAuthGuard)
  @UsePipes(ValidationPipe)
  update(@Request() req, @Body() updateAuthDto: UpdateAuthDto) {
    return this.authService.update(req.user.id, updateAuthDto);
  }
}
