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
    private jwtService: JwtService,
    private readonly authRepo: AuthRepo,
    private readonly emailService: EmailService,
  ) {}

  async validateUser({ email, password }: LoginAuthDto) {
    try {
      const findUser = await this.authRepo.findOne({ email });

      if (!findUser) throw new HttpException('Invalid credentials!', 400);
      const decryptPassword = await validatePassword(
        password,
        findUser.password,
      );

      if (!decryptPassword) {
        throw new UnauthorizedException('Invalid credentials!');
      }

      const { password: _, ...user } = findUser;

      // Generate access token
      const accessToken = this.jwtService.sign(
        { id: user.id, email: user.email, role: user.role },
        { expiresIn: config.JWT.ACCESS_EXPIRATION },
      );

      // Generate refresh token
      const refreshToken = this.jwtService.sign(
        { id: user.id, email: user.email, role: user.role },
        {
          secret: config.JWT.REFRESH_SECRET,
          expiresIn: config.JWT.REFRESH_EXPIRATION,
        },
      );

      // Calculate refresh token expiry date from JWT expiration format
      const refreshTokenExpiry = this.calculateTokenExpiry(
        config.JWT.REFRESH_EXPIRATION,
      );

      // Save refresh token to database
      findUser.refresh_token = refreshToken;
      findUser.refresh_token_expiry = refreshTokenExpiry;
      findUser.access_token = accessToken;
      await this.authRepo.save(findUser);

      return {
        ...user,
        access_token: accessToken,
        refresh_token: refreshToken,
      };
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  async refreshToken(refreshToken: string) {
    try {
      // Verify refresh token
      const decoded = this.jwtService.verify(refreshToken, {
        secret: config.JWT.REFRESH_SECRET,
      });

      // Find user by refresh token
      const findUser = await this.authRepo.findOne({
        refresh_token: refreshToken,
      });

      if (!findUser) {
        throw new UnauthorizedException('Invalid refresh token!');
      }

      // Check if refresh token has expired
      if (
        findUser.refresh_token_expiry &&
        findUser.refresh_token_expiry < new Date()
      ) {
        throw new UnauthorizedException('Refresh token has expired!');
      }

      const { password: _, ...user } = findUser;

      // Generate new access token
      const accessToken = this.jwtService.sign(
        { id: user.id, email: user.email, role: user.role },
        { expiresIn: config.JWT.ACCESS_EXPIRATION },
      );

      // Generate new refresh token
      const newRefreshToken = this.jwtService.sign(
        { id: user.id, email: user.email, role: user.role },
        {
          secret: config.JWT.REFRESH_SECRET,
          expiresIn: config.JWT.REFRESH_EXPIRATION,
        },
      );

      // Calculate refresh token expiry date from JWT expiration format
      const refreshTokenExpiry = this.calculateTokenExpiry(
        config.JWT.REFRESH_EXPIRATION,
      );

      // Update both tokens in database
      findUser.access_token = accessToken;
      findUser.refresh_token = newRefreshToken;
      findUser.refresh_token_expiry = refreshTokenExpiry;
      await this.authRepo.save(findUser);

      return {
        ...user,
        access_token: accessToken,
        refresh_token: newRefreshToken,
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token!');
    }
  }

  async create(registerDto: RegisterAuthDto) {
    try {
      const existingUser = await this.authRepo.findOne({
        email: registerDto.email,
      });

      if (existingUser) {
        throw new BadRequestException('Account with this details exist!');
      }
      const password = await hashPassword(registerDto.password);
      registerDto.password = password;
      return await this.authRepo.create(registerDto);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  async update(id: string, updateAuthDto: UpdateAuthDto) {
    let findUser;
    try {
      findUser = await this.authRepo.findOne({ id });
      if (!findUser) {
        throw new BadRequestException('User not found!');
      }

      Object.assign(findUser, updateAuthDto);

      await this.authRepo.save(findUser);

      const {
        password,
        access_token,
        refresh_token,
        refresh_token_expiry,
        ...user
      } = findUser;
      return user;
    } catch (error) {
      throw error;
    }
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
      // Exchange authorization code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: config.GOOGLE.CLIENT_ID,
          client_secret: config.GOOGLE.CLIENT_SECRET,
          redirect_uri: config.GOOGLE.REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json();
        throw new UnauthorizedException(
          errorData.error_description || 'Failed to exchange code for tokens',
        );
      }

      const tokenData = await tokenResponse.json();
      const { access_token } = tokenData;

      // Get user info from Google
      const userInfoResponse = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        },
      );

      if (!userInfoResponse.ok) {
        throw new UnauthorizedException(
          'Failed to fetch user info from Google',
        );
      }

      const googleUserInfo: {
        id: string;
        email: string;
        name?: string;
        picture?: string;
        verified_email?: boolean;
      } = await userInfoResponse.json();

      // Validate email
      if (!googleUserInfo.email) {
        throw new BadRequestException('Email is required from Google account!');
      }

      // Check if user exists by google_id first, then by email
      let existingUser = await this.authRepo.findOne({
        google_id: googleUserInfo.id,
      });

      if (!existingUser) {
        existingUser = await this.authRepo.findOne({
          email: googleUserInfo.email,
        });
      }

      // If user exists but doesn't have google_id, update it
      if (existingUser && !existingUser.google_id) {
        existingUser.google_id = googleUserInfo.id;
        existingUser.provider = 'google';
        if (googleUserInfo.picture && !existingUser.profile_picture) {
          existingUser.profile_picture = googleUserInfo.picture;
        }
        if (googleUserInfo.name && !existingUser.full_name) {
          existingUser.full_name = googleUserInfo.name;
        }
        await this.authRepo.save(existingUser);
      }

      // Update profile picture and name if they've changed
      if (existingUser && existingUser.google_id === googleUserInfo.id) {
        let updated = false;
        if (
          googleUserInfo.picture &&
          existingUser.profile_picture !== googleUserInfo.picture
        ) {
          existingUser.profile_picture = googleUserInfo.picture;
          updated = true;
        }
        if (
          googleUserInfo.name &&
          existingUser.full_name !== googleUserInfo.name
        ) {
          existingUser.full_name = googleUserInfo.name;
          updated = true;
        }
        if (updated) {
          await this.authRepo.save(existingUser);
        }
      }

      // If user doesn't exist, create new user
      if (!existingUser) {
        existingUser = await this.authRepo.create({
          email: googleUserInfo.email,
          full_name: googleUserInfo.name || undefined,
          profile_picture: googleUserInfo.picture || undefined,
          provider: 'google',
          google_id: googleUserInfo.id,
          requires_password: false,
          role: 'user',
        });
      }

      const { password: _, ...user } = existingUser;

      // Generate access token
      const accessToken = this.jwtService.sign(
        { id: user.id, email: user.email, role: user.role },
        { expiresIn: config.JWT.ACCESS_EXPIRATION },
      );

      // Generate refresh token
      const refreshToken = this.jwtService.sign(
        { id: user.id, email: user.email, role: user.role },
        {
          secret: config.JWT.REFRESH_SECRET,
          expiresIn: config.JWT.REFRESH_EXPIRATION,
        },
      );

      // Calculate refresh token expiry date
      const refreshTokenExpiry = this.calculateTokenExpiry(
        config.JWT.REFRESH_EXPIRATION,
      );

      // Save tokens to database
      existingUser.refresh_token = refreshToken;
      existingUser.refresh_token_expiry = refreshTokenExpiry;
      existingUser.access_token = accessToken;
      await this.authRepo.save(existingUser);

      return {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        profile_picture: user.profile_picture,
        access_token: accessToken,
        refresh_token: refreshToken,
      };
    } catch (error) {
      console.log(error);
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new HttpException(
        'Failed to authenticate with Google',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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

  private calculateTokenExpiry(expiration: string): Date {
    const expiryDate = new Date();
    const expirationStr = expiration.toLowerCase().trim();

    // Parse expiration string (e.g., "7d", "7 days", "14d", "30d", "3600s", "1h", etc.)
    if (expirationStr.endsWith('d') || expirationStr.includes('day')) {
      const days = parseInt(expirationStr) || 7;
      expiryDate.setDate(expiryDate.getDate() + days);
    } else if (expirationStr.endsWith('h') || expirationStr.includes('hour')) {
      const hours = parseInt(expirationStr) || 1;
      expiryDate.setHours(expiryDate.getHours() + hours);
    } else if (expirationStr.endsWith('m') || expirationStr.includes('min')) {
      const minutes = parseInt(expirationStr) || 15;
      expiryDate.setMinutes(expiryDate.getMinutes() + minutes);
    } else if (expirationStr.endsWith('s') || expirationStr.includes('sec')) {
      const seconds = parseInt(expirationStr) || 3600;
      expiryDate.setSeconds(expiryDate.getSeconds() + seconds);
    } else {
      // Default to 7 days if format is not recognized
      expiryDate.setDate(expiryDate.getDate() + 7);
    }

    return expiryDate;
  }
}
