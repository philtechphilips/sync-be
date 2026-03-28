import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { LoginAuthDto } from './dto/login.dto';
import { UpdateAuthDto } from './dto/update.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtService } from '@nestjs/jwt';
import { RegisterAuthDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { hashPassword, validatePassword } from '../common/password';
import { AuthRepo } from './repository/auth.repository';
import { config } from '../config/config.service';
import { EmailService } from '../common/services/email.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authRepo: AuthRepo,
    private readonly emailService: EmailService,
  ) {}

  async validateUser({ email, password }: LoginAuthDto) {
    const findUser = await this.authRepo.findOne({ email });

    if (!findUser) throw new HttpException('Invalid credentials!', 400);

    const isPasswordValid = await validatePassword(password, findUser.password);
    if (!isPasswordValid)
      throw new UnauthorizedException('Invalid credentials!');

    return this.generateAuthResponse(findUser);
  }

  async refreshToken(refreshToken: string) {
    try {
      this.jwtService.verify(refreshToken, {
        secret: config.JWT.REFRESH_SECRET,
      });

      const findUser = await this.authRepo.findOne({
        refresh_token: refreshToken,
      });

      if (!findUser) throw new UnauthorizedException('Invalid refresh token!');

      if (
        findUser.refresh_token_expiry &&
        findUser.refresh_token_expiry < new Date()
      ) {
        throw new UnauthorizedException('Refresh token has expired!');
      }

      return this.generateAuthResponse(findUser);
    } catch (error) {
      console.error('Refresh token error:', error);
      throw new UnauthorizedException('Invalid refresh token!');
    }
  }

  async create(registerDto: RegisterAuthDto) {
    const existingUser = await this.authRepo.findOne({
      email: registerDto.email,
    });

    if (existingUser) {
      throw new BadRequestException('Account with this details exist!');
    }
    const password = await hashPassword(registerDto.password);
    registerDto.password = password;
    return await this.authRepo.create(registerDto);
  }

  async update(id: string, updateAuthDto: UpdateAuthDto) {
    const findUser = await this.findUserOrThrow(id);
    Object.assign(findUser, updateAuthDto);
    await this.authRepo.save(findUser);
    return this.getSafeUser(findUser);
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    const user = await this.findUserOrThrow(id);

    if (dto.full_name !== undefined) user.full_name = dto.full_name;
    if (dto.profile_picture !== undefined)
      user.profile_picture = dto.profile_picture;
    if (dto.settings !== undefined) {
      user.settings = dto.settings;
    }

    await this.authRepo.save(user);
    return this.getSafeUser(user);
  }

  async changePassword(id: string, dto: ChangePasswordDto) {
    const user = await this.findUserOrThrow(id);

    const valid = await validatePassword(dto.current_password, user.password);
    if (!valid) throw new BadRequestException('Current password is incorrect.');

    user.password = await hashPassword(dto.new_password);
    await this.authRepo.save(user);

    return { success: true, message: 'Password updated successfully.' };
  }

  getGoogleAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: config.GOOGLE.CLIENT_ID,
      redirect_uri: config.GOOGLE.REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleGoogleCallback(code: string) {
    try {
      const accessToken = await this.exchangeGoogleCodeForToken(code);
      const googleUserInfo = await this.fetchGoogleUserInfo(accessToken);

      if (!googleUserInfo.email) {
        throw new BadRequestException('Email is required from Google account!');
      }

      const user = await this.getOrCreateGoogleUser(googleUserInfo);
      return this.generateAuthResponse(user);
    } catch (error) {
      console.log(error);
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new HttpException(
        'Failed to authenticate with Google',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async exchangeGoogleCodeForToken(code: string): Promise<string> {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE.CLIENT_ID,
        client_secret: config.GOOGLE.CLIENT_SECRET,
        redirect_uri: config.GOOGLE.REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData: any = await tokenResponse.json();
      throw new UnauthorizedException(
        errorData.error_description || 'Failed to exchange code for tokens',
      );
    }

    const tokenData: any = await tokenResponse.json();
    return tokenData.access_token;
  }

  private async fetchGoogleUserInfo(accessToken: string) {
    const response = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      throw new UnauthorizedException('Failed to fetch user info from Google');
    }

    return (await response.json()) as {
      id: string;
      email: string;
      name?: string;
      picture?: string;
    };
  }

  private async getOrCreateGoogleUser(googleUserInfo: {
    id: string;
    email: string;
    name?: string;
    picture?: string;
  }) {
    let user = await this.authRepo.findOne({ google_id: googleUserInfo.id });

    user ??= await this.authRepo.findOne({ email: googleUserInfo.email });

    if (user) {
      let updated = false;
      if (!user.google_id) {
        user.google_id = googleUserInfo.id;
        user.provider = 'google';
        updated = true;
      }
      if (
        googleUserInfo.picture &&
        user.profile_picture !== googleUserInfo.picture
      ) {
        user.profile_picture = googleUserInfo.picture;
        updated = true;
      }
      if (googleUserInfo.name && user.full_name !== googleUserInfo.name) {
        user.full_name = googleUserInfo.name;
        updated = true;
      }
      if (updated) await this.authRepo.save(user);
      return user;
    }

    return this.authRepo.create({
      email: googleUserInfo.email,
      full_name: googleUserInfo.name || undefined,
      profile_picture: googleUserInfo.picture || undefined,
      provider: 'google',
      google_id: googleUserInfo.id,
      requires_password: false,
      role: 'user',
    });
  }

  private async generateAuthResponse(user: any) {
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      full_name: user.full_name,
      profile_picture: user.profile_picture,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: config.JWT.ACCESS_EXPIRATION,
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: config.JWT.REFRESH_SECRET,
      expiresIn: config.JWT.REFRESH_EXPIRATION,
    });

    const refreshTokenExpiry = this.calculateTokenExpiry(
      config.JWT.REFRESH_EXPIRATION,
    );

    user.refresh_token = refreshToken;
    user.refresh_token_expiry = refreshTokenExpiry;
    user.access_token = accessToken;
    await this.authRepo.save(user);

    const safeUser = this.getSafeUser(user);
    return {
      ...safeUser,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
    try {
      const user = await this.authRepo.findOne({
        email: forgotPasswordDto.email,
      });

      // Don't reveal if user exists or not for security reasons
      if (!user) {
        // Return success even if user doesn't exist to prevent email enumeration
        return {
          success: true,
          message:
            'If an account with that email exists, a password reset link has been sent.',
        };
      }

      // Check if user requires password (not OAuth-only users)
      if (!user.requires_password) {
        return {
          success: true,
          message:
            'If an account with that email exists, a password reset link has been sent.',
        };
      }

      // Generate JWT reset token with user ID, expires in 1 hour
      const resetToken = this.jwtService.sign(
        { id: user.id, email: user.email, type: 'password_reset' },
        { expiresIn: '1h' },
      );

      // Send reset email
      await this.emailService.sendPasswordResetEmail(user.email, resetToken);

      return {
        success: true,
        message:
          'If an account with that email exists, a password reset link has been sent.',
      };
    } catch (error) {
      console.error('Forgot password error:', error);
      throw new HttpException(
        'Failed to process password reset request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    try {
      // Verify and decode the JWT token
      let decoded: any;
      try {
        decoded = this.jwtService.verify(resetPasswordDto.token);
      } catch (error) {
        console.error('JWT verification error during password reset:', error);
        throw new BadRequestException('Invalid or expired reset token');
      }

      // Verify token type
      if (decoded.type !== 'password_reset') {
        throw new BadRequestException('Invalid reset token');
      }

      // Find user by ID from token
      const user = await this.authRepo.findOne({ id: decoded.id });

      if (!user) {
        throw new BadRequestException('User not found');
      }

      // Check if user requires password (not OAuth-only users)
      if (!user.requires_password) {
        throw new BadRequestException(
          'Password reset is not available for this account',
        );
      }

      // Hash new password
      const hashedPassword = await hashPassword(resetPasswordDto.password);

      // Update user password
      user.password = hashedPassword;
      await this.authRepo.save(user);

      return {
        success: true,
        message: 'Password has been reset successfully',
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      console.error('Reset password error:', error);
      throw new HttpException(
        'Failed to reset password',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async findUserOrThrow(id: string) {
    const user = await this.authRepo.findOne({ id });
    if (!user) throw new BadRequestException('User not found!');
    return user;
  }

  private getSafeUser(user: any) {
    const {
      password,
      access_token,
      refresh_token,
      refresh_token_expiry,
      ...safeUser
    } = user;
    return safeUser;
  }

  private calculateTokenExpiry(expiration: string): Date {
    const expiryDate = new Date();
    const expirationStr = expiration.toLowerCase().trim();

    // Parse expiration string (e.g., "7d", "7 days", "14d", "30d", "3600s", "1h", etc.)
    if (expirationStr.endsWith('d') || expirationStr.includes('day')) {
      const days = Number.parseInt(expirationStr) || 7;
      expiryDate.setDate(expiryDate.getDate() + days);
    } else if (expirationStr.endsWith('h') || expirationStr.includes('hour')) {
      const hours = Number.parseInt(expirationStr) || 1;
      expiryDate.setHours(expiryDate.getHours() + hours);
    } else if (expirationStr.endsWith('m') || expirationStr.includes('min')) {
      const minutes = Number.parseInt(expirationStr) || 15;
      expiryDate.setMinutes(expiryDate.getMinutes() + minutes);
    } else if (expirationStr.endsWith('s') || expirationStr.includes('sec')) {
      const seconds = Number.parseInt(expirationStr) || 3600;
      expiryDate.setSeconds(expiryDate.getSeconds() + seconds);
    } else {
      // Default to 7 days if format is not recognized
      expiryDate.setDate(expiryDate.getDate() + 7);
    }

    return expiryDate;
  }
}
