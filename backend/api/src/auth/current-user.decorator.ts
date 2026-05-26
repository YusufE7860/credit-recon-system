import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtUser } from './role.enum';

// Inject the authenticated user into a controller method:
//
//   @Get()
//   list(@CurrentUser() user: JwtUser) { ... }
//
// Reads what JwtAuthGuard put into req.user (the JWT payload).
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as JwtUser;
  },
);
