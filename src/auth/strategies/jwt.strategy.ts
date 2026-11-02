import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { config } from '../../config/config.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.JWT.SECRET,
    });
  }

  validate(payload: any) {
    // Only access tokens authenticate requests; reset links and any other
    // token signed with this secret are rejected.
    if (payload?.type !== 'access' || !payload.id) {
      throw new UnauthorizedException('Invalid access token.');
    }
    return {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      full_name: payload.full_name,
    };
  }
}
