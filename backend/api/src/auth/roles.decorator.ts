import { SetMetadata } from '@nestjs/common';
import { Role } from './role.enum';

// Metadata key used by RolesGuard to read the list of required roles.
export const ROLES_KEY = 'roles';

// Usage:
//   @Roles(Role.ADMIN)
//   @Roles(Role.ADMIN, Role.REPORTING)
//
// Attaches the role list as metadata on the route handler. RolesGuard
// picks it up via Reflector at request time.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
