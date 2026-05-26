import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import type { Role, JwtUser } from './role.enum';

// Guard that reads the @Roles() metadata on a route and allows the
// request only if req.user.role is in the list.
//
// IMPORTANT: This guard assumes JwtAuthGuard has already run and
// populated req.user.  In our controllers we apply both:
//   @UseGuards(JwtAuthGuard, RolesGuard)
//
// If a route has no @Roles() metadata, this guard is a no-op (any
// authenticated user is allowed). That keeps @Roles purely additive.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() on the handler or controller → allow.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser | undefined;

    if (!user) {
      // Should never happen if JwtAuthGuard ran first, but defensive.
      throw new ForbiddenException('Not authenticated');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Requires one of: ${requiredRoles.join(', ')}`,
      );
    }
    return true;
  }
}
