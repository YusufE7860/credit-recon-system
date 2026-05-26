import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    PassportModule,

    // We use registerAsync (instead of register) because we need to
    // inject ConfigService to read JWT_SECRET from the .env file.
    // useFactory runs at module init and returns the JwtModule options.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          // Cast needed because @nestjs/jwt's signOptions.expiresIn uses
          // a strict template-literal type from the `ms` package (e.g.
          // `'1d'`, `'2 days'`) and won't accept a generic `string` from
          // ConfigService. The runtime value is still validated by
          // jsonwebtoken itself, so this cast is safe.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '1d') as any,
        },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
})
export class AuthModule {}
