import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User } from './entities/user.entity';
import { AuthRepo } from './repository/auth.repository';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { EmailService } from '../common/services/email.service';
import { config } from '../config/config.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    PassportModule,
    JwtModule.register({
      secret: config.JWT.SECRET,
      signOptions: { expiresIn: config.JWT.ACCESS_EXPIRATION },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepo, LocalStrategy, JwtStrategy, EmailService],
  exports: [AuthService],
})
export class AuthModule {}
