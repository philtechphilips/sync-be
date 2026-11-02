import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Request,
  Res,
  Query,
  HttpCode,
} from '@nestjs/common';
import type {
  CookieOptions,
  Request as ExpressRequest,
  Response,
} from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { AuthService, IssuedSession } from './auth.service';
import { UpdateAuthDto } from './dto/update.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LocalGuard } from './guards/local.guard';
import { JwtAuthGuard } from './guards/jwt.guard';
import { RegisterAuthDto } from './dto/register.dto';
import { Public } from './decorators/public.decorators';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  CliLoginAuthorizeDto,
  CliLoginDenyDto,
  CliLoginInitDto,
} from './dto/cli-login.dto';
import { config } from '../config/config.service';
import { User } from './entities/user.entity';

export const REFRESH_COOKIE = 'synq_rt';
const STATE_COOKIE = 'synq_oauth_state';

function cookieOptions(path: string, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE.SECURE || config.COOKIE.SAMESITE === 'none',
    sameSite: config.COOKIE.SAMESITE,
    domain: config.COOKIE.DOMAIN,
    path,
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

function meta(req: ExpressRequest) {
  return { userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null };
}

@Controller('/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setRefreshCookie(
    res: Response,
    session: Pick<IssuedSession, 'refreshToken' | 'refreshExpiresAt'>,
  ) {
    res.cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      cookieOptions(
        '/v1/auth',
        session.refreshExpiresAt.getTime() - Date.now(),
      ),
    );
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @UseGuards(LocalGuard)
  async login(
    @Request() req: ExpressRequest & { user: User },
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.issueSession(req.user, meta(req));
    this.setRefreshCookie(res, session);
    return {
      success: true,
      user: session.user,
      access_token: session.access_token,
      message: 'User logged in successfully!',
    };
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(
    @Request() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.authService.refresh(
      req.cookies?.[REFRESH_COOKIE],
    );
    if (session.rotated) this.setRefreshCookie(res, session);
    return { access_token: session.access_token, user: session.user };
  }

  @Post('logout')
  @Public()
  @HttpCode(200)
  async logout(
    @Request() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, cookieOptions('/v1/auth'));
    return { success: true };
  }

  @Post('register')
  @Public()
  async create(@Body() dto: RegisterAuthDto) {
    const user = await this.authService.create(dto);
    return {
      success: true,
      data: user,
      message: 'Account created successfully!',
    };
  }

  @Get('oauth/google')
  @Public()
  initiateGoogleAuth(@Res() res: Response) {
    // `state` ties the callback to this browser (prevents login CSRF).
    const state = randomBytes(24).toString('base64url');
    res.cookie(
      STATE_COOKIE,
      state,
      cookieOptions('/v1/auth/oauth', 10 * 60 * 1000),
    );
    res.redirect(this.authService.getGoogleAuthUrl(state));
  }

  @Get('oauth/google/callback')
  @Public()
  async googleCallback(
    @Request() req: ExpressRequest,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const fail = (message: string) =>
      res.redirect(
        `${config.FRONTEND_URL}/auth/login?error=${encodeURIComponent(message)}`,
      );

    const expected = String(req.cookies?.[STATE_COOKIE] ?? '');
    res.clearCookie(STATE_COOKIE, cookieOptions('/v1/auth/oauth'));
    const stateOk =
      !!state &&
      expected.length === state.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(state));
    if (!code || !stateOk)
      return fail('Google sign-in could not be verified. Please try again.');

    try {
      const user = await this.authService.handleGoogleCallback(code);
      const session = await this.authService.issueSession(user, meta(req));
      // Tokens never go in the URL: the refresh cookie is set here and the
      // frontend exchanges it for an access token on /auth/callback.
      this.setRefreshCookie(res, session);
      return res.redirect(`${config.FRONTEND_URL}/auth/callback`);
    } catch (error) {
      return fail(
        (error as Error).message || 'Failed to authenticate with Google',
      );
    }
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Request() req: any) {
    return this.authService.getProfile(req.user.id);
  }

  @Patch('/')
  @UseGuards(JwtAuthGuard)
  update(@Request() req: any, @Body() dto: UpdateAuthDto) {
    return this.authService.updateProfile(req.user.id, dto);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(req.user.id, dto);
  }

  @Patch('password')
  @UseGuards(JwtAuthGuard)
  changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
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

  // ─── Browser-based CLI auth ─────────────────────────────────────────────

  @Post('cli-login/init')
  @Public()
  initCliLogin(@Request() req: ExpressRequest, @Body() dto: CliLoginInitDto) {
    return this.authService.createCliLoginToken(dto?.hostname, req.ip);
  }

  @Get('cli-login/poll/:token')
  @Public()
  pollCliLogin(@Param('token') token: string) {
    return this.authService.pollCliLoginToken(token);
  }

  @Get('cli-login/info/:token')
  @UseGuards(JwtAuthGuard)
  cliLoginInfo(@Param('token') token: string) {
    return this.authService.getCliLoginInfo(token);
  }

  @Post('cli-login/authorize')
  @UseGuards(JwtAuthGuard)
  authorizeCliLogin(@Request() req: any, @Body() dto: CliLoginAuthorizeDto) {
    return this.authService.authorizeCliLoginToken(
      req.user.id,
      dto.loginToken,
      dto.userCode,
    );
  }

  @Post('cli-login/deny')
  @UseGuards(JwtAuthGuard)
  denyCliLogin(@Body() dto: CliLoginDenyDto) {
    return this.authService.denyCliLoginToken(dto.loginToken);
  }
}
