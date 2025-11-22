import {
  BadRequestException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginAuthDto } from './dto/login.dto';
import { UpdateAuthDto } from './dto/update.dto';
import { JwtService } from '@nestjs/jwt';
import { RegisterAuthDto } from './dto/register.dto';
import { hashPassword, validatePassword } from '../common/password';
import { AuthRepo } from './repository/auth.repository';
import { GoogleDto } from './dto/google.dto';
import { config } from '../config/config.service';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private readonly authRepo: AuthRepo,
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

  async google(googleDto: GoogleDto) {
    try {
      return { success: true, message: 'Google login successful!' };
      //   const response = await this.authRepo.findOne({ email: googleDto.email, provider: 'google' });
      //   return response;
    } catch (error) {
      console.log(error);
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
