import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RegisterAuthDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { hashPassword, validatePassword } from '../common/password';
import { AuthRepo } from './repository/auth.repository';
import { config } from '../config/config.service';
import { EmailService } from '../common/services/email.service';
import { AgentService } from '../agent/agent.service';
import { User } from './entities/user.entity';
import { AuthSession } from './entities/auth-session.entity';
import { CliLoginRequest } from './entities/cli-login-request.entity';

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  user: ReturnType<AuthService['getSafeUser']>;
  access_token: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
const PREVIOUS_TOKEN_GRACE_MS = 2 * 60 * 1000;
const CLI_TOKEN_TTL_MS = 5 * 60 * 1000;
const CLI_MAX_CODE_ATTEMPTS = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function safeEqualHex(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function durationMs(expiration: string): number {
  const m = /^\s*(\d+)\s*(ms|s|m|h|d|w)?\s*$/i.exec(expiration);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const factor: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * factor[unit];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly authRepo: AuthRepo,
    private readonly emailService: EmailService,
    private readonly agentService: AgentService,
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>,
    @InjectRepository(CliLoginRequest)
    private readonly cliLogins: Repository<CliLoginRequest>,
  ) {}

  // ─── Credentials ─────────────────────────────────────────────────────────

  /** Same error for unknown email and wrong password (no account probing). */
  async verifyCredentials(email: string, password: string): Promise<User> {
    const user = await this.authRepo.findOne({
      email: email.trim().toLowerCase(),
    });
    const valid =
      !!user?.password &&
      (await validatePassword(password, user.password).catch(() => false));
    if (!user || !valid)
      throw new UnauthorizedException('Invalid email or password.');
    return user;
  }

  async create(dto: RegisterAuthDto) {
    const email = dto.email.trim().toLowerCase();
    if (await this.authRepo.findOne({ email })) {
      throw new BadRequestException(
        'An account with this email already exists.',
      );
    }
    try {
      const user = await this.authRepo.create({
        email,
        full_name: dto.full_name,
        password: await hashPassword(dto.password),
        requires_password: true,
        email_verified: false,
        provider: 'local',
        role: 'user',
        agentKey: randomUUID(),
      });
      return this.getSafeUser(user);
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new BadRequestException(
          'An account with this email already exists.',
        );
      }
      throw error;
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  private signAccessToken(user: User, sessionId: string) {
    return this.jwtService.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        type: 'access',
        sid: sessionId,
      },
      { expiresIn: config.JWT.ACCESS_EXPIRATION },
    );
  }

  /** Creates a session and returns the access token plus the refresh cookie value. */
  async issueSession(
    user: User,
    meta: SessionMeta = {},
  ): Promise<IssuedSession> {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + durationMs(config.JWT.REFRESH_EXPIRATION),
    );
    const session = await this.sessions.save(
      this.sessions.create({
        userId: user.id,
        tokenHash: sha256(secret),
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        ip: meta.ip?.slice(0, 64) ?? null,
      }),
    );
    void this.sessions
      .delete({ userId: user.id, expiresAt: LessThan(new Date()) })
      .catch(() => undefined);
    return {
      user: this.getSafeUser(user),
      access_token: this.signAccessToken(user, session.id),
      refreshToken: `${session.id}.${secret}`,
      refreshExpiresAt: expiresAt,
    };
  }

  /**
   * Exchanges a refresh token for a new access token. The refresh token is
   * rotated daily; the previous one stays valid for two minutes so tabs
   * refreshing at the same moment don't log each other out. Reusing an
   * older token revokes the session.
   */
  async refresh(
    refreshToken: string | undefined,
  ): Promise<IssuedSession & { rotated: boolean }> {
    const [sessionId, secret] = String(refreshToken ?? '').split('.');
    if (!sessionId || !secret)
      throw new UnauthorizedException('Not signed in.');
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException(
        'Your session has expired. Please sign in again.',
      );
    }

    const hash = sha256(secret);
    const current = safeEqualHex(session.tokenHash, hash);
    const previous =
      !current &&
      safeEqualHex(session.previousTokenHash, hash) &&
      !!session.rotatedAt &&
      Date.now() - session.rotatedAt.getTime() < PREVIOUS_TOKEN_GRACE_MS;
    if (!current && !previous) {
      await this.sessions.delete({ id: session.id });
      throw new UnauthorizedException(
        'Your session is no longer valid. Please sign in again.',
      );
    }

    const user = await this.authRepo.findOne({ id: session.userId });
    if (!user) throw new UnauthorizedException('Not signed in.');

    let token = refreshToken!;
    let rotated = false;
    const lastRotation = (session.rotatedAt ?? session.createdAt).getTime();
    if (current && Date.now() - lastRotation > ROTATE_AFTER_MS) {
      const next = randomBytes(32).toString('base64url');
      session.previousTokenHash = session.tokenHash;
      session.tokenHash = sha256(next);
      session.rotatedAt = new Date();
      session.expiresAt = new Date(
        Date.now() + durationMs(config.JWT.REFRESH_EXPIRATION),
      );
      await this.sessions.save(session);
      token = `${session.id}.${next}`;
      rotated = true;
    }
    return {
      user: this.getSafeUser(user),
      access_token: this.signAccessToken(user, session.id),
      refreshToken: token,
      refreshExpiresAt: session.expiresAt,
      rotated,
    };
  }

  async logout(refreshToken: string | undefined) {
    const [sessionId] = String(refreshToken ?? '').split('.');
    if (sessionId)
      await this.sessions.delete({ id: sessionId }).catch(() => undefined);
  }

  private async revokeAllSessions(userId: string) {
    await this.sessions.delete({ userId });
  }

  // ─── Profile ─────────────────────────────────────────────────────────────

  async getProfile(id: string) {
    return this.getSafeUser(await this.findUserOrThrow(id));
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    const user = await this.findUserOrThrow(id);
    if (dto.full_name !== undefined) user.full_name = dto.full_name;
    if (dto.profile_picture !== undefined)
      user.profile_picture = dto.profile_picture;
    if (dto.settings !== undefined) user.settings = dto.settings;
    await this.authRepo.save(user);
    return this.getSafeUser(user);
  }

  async changePassword(id: string, dto: ChangePasswordDto) {
    const user = await this.findUserOrThrow(id);
    const valid =
      !!user.password &&
      (await validatePassword(dto.current_password, user.password).catch(
        () => false,
      ));
    if (!valid) throw new BadRequestException('Current password is incorrect.');
    user.password = await hashPassword(dto.new_password);
    await this.authRepo.save(user);
    return { success: true, message: 'Password updated successfully.' };
  }

  // ─── Agent key ───────────────────────────────────────────────────────────

  async getAgentKey(userId: string): Promise<{ agentKey: string }> {
    const user = await this.findUserOrThrow(userId);
    if (!user.agentKey) {
      user.agentKey = randomUUID();
      await this.authRepo.save(user);
    }
    return { agentKey: user.agentKey };
  }

  async rotateAgentKey(userId: string): Promise<{ agentKey: string }> {
    const user = await this.findUserOrThrow(userId);
    await this.agentService.deregisterByUserId(userId);
    user.agentKey = randomUUID();
    await this.authRepo.save(user);
    return { agentKey: user.agentKey };
  }

  getAgentStatus(userId: string) {
    return this.agentService.getStatus(userId);
  }

  // ─── Google OAuth ────────────────────────────────────────────────────────

  getGoogleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: config.GOOGLE.CLIENT_ID,
      redirect_uri: config.GOOGLE.REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleGoogleCallback(code: string): Promise<User> {
    try {
      const accessToken = await this.exchangeGoogleCodeForToken(code);
      const info = await this.fetchGoogleUserInfo(accessToken);
      if (!info.email || info.verified_email !== true) {
        throw new BadRequestException(
          'Your Google account email is not verified.',
        );
      }
      return await this.getOrCreateGoogleUser(info);
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      this.logger.error(`Google OAuth failed: ${(error as Error).message}`);
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
    const data: any = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !data.access_token) {
      throw new UnauthorizedException(
        data.error_description || 'Failed to exchange code for tokens',
      );
    }
    return data.access_token as string;
  }

  private async fetchGoogleUserInfo(accessToken: string) {
    const response = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok)
      throw new UnauthorizedException('Failed to fetch user info from Google');
    return (await response.json()) as {
      id: string;
      email: string;
      verified_email?: boolean;
      name?: string;
      picture?: string;
    };
  }

  private async getOrCreateGoogleUser(info: {
    id: string;
    email: string;
    name?: string;
    picture?: string;
  }): Promise<User> {
    const email = info.email.trim().toLowerCase();
    let user = await this.authRepo.findOne({ google_id: info.id });
    user ??= await this.authRepo.findOne({ email });

    if (!user) {
      return this.authRepo.create({
        email,
        full_name: info.name || undefined,
        profile_picture: info.picture || undefined,
        provider: 'google',
        google_id: info.id,
        requires_password: false,
        email_verified: true,
        role: 'user',
        agentKey: randomUUID(),
      });
    }

    if (!user.google_id) {
      // Google has just proven who owns this address. If the existing
      // account's email was never verified, anyone could have registered it,
      // so its password and sessions are discarded before linking.
      if (!user.email_verified) {
        user.password = null;
        await this.revokeAllSessions(user.id);
      }
      user.google_id = info.id;
      user.provider = 'google';
    }
    user.email_verified = true;
    if (info.picture) user.profile_picture = info.picture;
    if (info.name && !user.full_name) user.full_name = info.name;
    await this.authRepo.save(user);
    return user;
  }

  // ─── Password reset ──────────────────────────────────────────────────────

  /** Changes whenever the password does, which makes reset links single-use. */
  private passwordFingerprint(user: User) {
    return sha256(`${user.id}:${user.password ?? ''}`).slice(0, 16);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const generic = {
      success: true,
      message:
        'If an account with that email exists, a password reset link has been sent.',
    };
    const user = await this.authRepo.findOne({
      email: dto.email.trim().toLowerCase(),
    });
    if (!user || !user.requires_password) return generic;

    const token = this.jwtService.sign(
      {
        sub: user.id,
        type: 'password_reset',
        pwf: this.passwordFingerprint(user),
      },
      { secret: config.JWT.RESET_SECRET, expiresIn: '1h' },
    );
    try {
      await this.emailService.sendPasswordResetEmail(user.email, token);
    } catch (error) {
      this.logger.error(
        `Failed to send reset email: ${(error as Error).message}`,
      );
      throw new HttpException(
        'Failed to send the reset email. Please try again.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return generic;
  }

  async resetPassword(dto: ResetPasswordDto) {
    let decoded: { sub?: string; type?: string; pwf?: string };
    try {
      decoded = this.jwtService.verify(dto.token, {
        secret: config.JWT.RESET_SECRET,
      });
    } catch {
      throw new BadRequestException(
        'This reset link is invalid or has expired.',
      );
    }
    if (decoded.type !== 'password_reset' || !decoded.sub) {
      throw new BadRequestException(
        'This reset link is invalid or has expired.',
      );
    }
    const user = await this.authRepo.findOne({ id: decoded.sub });
    if (!user || decoded.pwf !== this.passwordFingerprint(user)) {
      throw new BadRequestException('This reset link has already been used.');
    }
    if (!user.requires_password) {
      throw new BadRequestException(
        'Password reset is not available for this account.',
      );
    }

    user.password = await hashPassword(dto.password);
    user.email_verified = true; // they received the email
    await this.authRepo.save(user);
    await this.revokeAllSessions(user.id);
    return {
      success: true,
      message: 'Password has been reset successfully. Please sign in.',
    };
  }

  // ─── Browser-based CLI auth ──────────────────────────────────────────────
  // Pending logins live in the database so any API instance can serve them.

  private newUserCode() {
    const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
  }

  async createCliLoginToken(hostname?: string, ip?: string) {
    await this.cliLogins.delete({ expiresAt: LessThan(new Date()) });
    const loginToken = randomBytes(24).toString('base64url');
    const userCode = this.newUserCode();
    await this.cliLogins.save(
      this.cliLogins.create({
        id: sha256(loginToken),
        userCode,
        hostname: hostname?.slice(0, 100) || null,
        ip: ip?.slice(0, 64) ?? null,
        status: 'pending',
        expiresAt: new Date(Date.now() + CLI_TOKEN_TTL_MS),
      }),
    );
    return { loginToken, userCode, expiresIn: CLI_TOKEN_TTL_MS / 1000 };
  }

  private async liveCliToken(loginToken: string) {
    const entry = await this.cliLogins.findOne({
      where: { id: sha256(String(loginToken)) },
    });
    if (!entry || entry.expiresAt < new Date()) {
      throw new BadRequestException(
        'This login request is invalid or has expired.',
      );
    }
    return entry;
  }

  /** What the browser shows before approving (never the code itself). */
  async getCliLoginInfo(loginToken: string) {
    const entry = await this.liveCliToken(loginToken);
    if (entry.status !== 'pending') {
      throw new BadRequestException('This login request was already handled.');
    }
    return {
      hostname: entry.hostname,
      ip: entry.ip,
      requestedAt: entry.createdAt.toISOString(),
    };
  }

  async authorizeCliLoginToken(
    userId: string,
    loginToken: string,
    userCode: string,
  ) {
    const entry = await this.liveCliToken(loginToken);
    if (entry.status !== 'pending') {
      throw new BadRequestException('This login request was already handled.');
    }
    const normalize = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalize(userCode) !== normalize(entry.userCode)) {
      // Atomic increment so parallel guesses can't exceed the limit.
      await this.cliLogins.increment({ id: entry.id }, 'attempts', 1);
      if (entry.attempts + 1 >= CLI_MAX_CODE_ATTEMPTS)
        await this.cliLogins.delete({ id: entry.id });
      throw new BadRequestException(
        "That code doesn't match the one shown in your terminal.",
      );
    }
    // Only one approval wins, even if two arrive at once.
    const claimed = await this.cliLogins.update(
      { id: entry.id, status: 'pending' },
      { status: 'authorized', userId },
    );
    if (!claimed.affected)
      throw new BadRequestException('This login request was already handled.');
    return { success: true };
  }

  async denyCliLoginToken(loginToken: string) {
    const entry = await this.liveCliToken(loginToken);
    await this.cliLogins.update(
      { id: entry.id, status: 'pending' },
      { status: 'denied' },
    );
    return { success: true };
  }

  async pollCliLoginToken(loginToken: string) {
    const entry = await this.liveCliToken(loginToken);
    if (entry.status === 'pending') return { status: 'pending' as const };
    await this.cliLogins.delete({ id: entry.id });
    if (entry.status === 'denied' || !entry.userId)
      return { status: 'denied' as const };
    const { agentKey } = await this.getAgentKey(entry.userId);
    return { status: 'authorized' as const, agentKey };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async findUserOrThrow(id: string) {
    const user = await this.authRepo.findOne({ id });
    if (!user) throw new BadRequestException('User not found!');
    return user;
  }

  getSafeUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      profile_picture: user.profile_picture,
      settings: user.settings,
      provider: user.provider,
      has_password: !!user.password,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
