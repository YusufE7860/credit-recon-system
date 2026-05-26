import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  // ConfigService is injected by Nest's DI container. Because we set
  // `isGlobal: true` on ConfigModule in app.module.ts, no extra imports
  // are needed here.
  constructor(config: ConfigService) {
    super({
      // Pull the JWT from the `token` cookie (set on login by AuthController).
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.token,
      ]),
      // The "!" tells TS we expect this to be defined. If it's missing,
      // we'd rather crash at startup than run insecurely — see the check
      // below for a friendlier failure.
      secretOrKey: config.get<string>('JWT_SECRET')!,
    });

    // Fail loudly if the secret isn't configured. This catches the
    // common "forgot to set .env in production" mistake.
    if (!config.get<string>('JWT_SECRET')) {
      throw new Error(
        'JWT_SECRET is not set. Add it to backend/api/.env',
      );
    }
  }

  // This runs after passport verifies the JWT signature. Whatever we
  // return becomes `request.user` inside controllers.
  async validate(payload: any) {
    return payload;
  }
}
