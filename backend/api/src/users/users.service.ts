import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { Role } from '../auth/role.enum';

// Shape returned by public endpoints — NEVER includes the password hash.
const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  managedUserIds: true,
  // Exposed so the frontend knows to force-redirect the user to the
  // change-password page immediately after login. Cleared once they
  // successfully change it themselves.
  mustResetPassword: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role?: Role;
  // For UPLOADER role: which USER ids this assistant uploads invoices for.
  // Ignored (forced empty) for every other role.
  managedUserIds?: string[];
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: Role;
  active?: boolean;
  managedUserIds?: string[];
}

// Email matching is case-insensitive throughout — users typing
// "Foo@Bar.com" vs "foo@bar.com" should resolve to the same account.
// We normalise to lowercase on every write AND use insensitive-mode
// queries for reads so historical mixed-case rows still match.
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async createUser(input: CreateUserInput) {
    if (!input.email || !input.password || !input.name) {
      throw new BadRequestException(
        'name, email, and password are required',
      );
    }
    if (input.password.length < 8) {
      throw new BadRequestException(
        'Password must be at least 8 characters',
      );
    }

    const email = normalizeEmail(input.email);

    // Case-insensitive duplicate check so admin can't accidentally
    // create "John@Example.com" when "john@example.com" already exists.
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'A user with that email already exists',
      );
    }

    const hashed = await bcrypt.hash(input.password, 10);
    const finalRole = input.role ?? Role.USER;
    return this.prisma.user.create({
      data: {
        name: input.name,
        email,
        password: hashed,
        role: finalRole,
        // Force the user to change their password on next login — the
        // one the admin set is a temporary hand-over credential, not
        // something the user should keep using.
        mustResetPassword: true,
        // Only stored when role is UPLOADER — silently dropped otherwise
        // so a misconfigured create can't grant phantom access.
        managedUserIds:
          finalRole === Role.UPLOADER ? input.managedUserIds ?? [] : [],
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  async getUsers() {
    return this.prisma.user.findMany({
      select: PUBLIC_USER_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  async updateUser(id: string, input: UpdateUserInput) {
    await this.getUserById(id);

    if (input.email !== undefined) {
      const normalised = normalizeEmail(input.email);
      // Case-insensitive duplicate check.
      const collision = await this.prisma.user.findFirst({
        where: {
          email: { equals: normalised, mode: 'insensitive' },
          NOT: { id },
        },
        select: { id: true },
      });
      if (collision) {
        throw new ConflictException(
          'A user with that email already exists',
        );
      }
      input.email = normalised;
    }

    // managedUserIds only kept when role stays/becomes UPLOADER. If the
    // role is being changed AWAY from UPLOADER, clear the list so it
    // doesn't sit as orphan data on a USER/ADMIN row.
    let nextManaged = input.managedUserIds;
    if (input.role !== undefined && input.role !== Role.UPLOADER) {
      nextManaged = [];
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        name: input.name,
        email: input.email,
        role: input.role,
        active: input.active,
        managedUserIds: nextManaged,
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  // Soft delete: set active=false. Their data stays for audit.
  async deactivate(id: string) {
    await this.getUserById(id);
    return this.prisma.user.update({
      where: { id },
      data: { active: false },
      select: PUBLIC_USER_SELECT,
    });
  }

  async reactivate(id: string) {
    await this.getUserById(id);
    return this.prisma.user.update({
      where: { id },
      data: { active: true },
      select: PUBLIC_USER_SELECT,
    });
  }

  // Admin directly sets a user's password (bypasses email flow).
  async setPassword(id: string, newPassword: string) {
    if (newPassword.length < 8) {
      throw new BadRequestException(
        'Password must be at least 8 characters',
      );
    }
    await this.getUserById(id);
    const hashed = await bcrypt.hash(newPassword, 10);
    return this.prisma.user.update({
      where: { id },
      data: {
        password: hashed,
        // Admin-issued password is temporary — flag so the user is
        // routed to /change-password on next login.
        mustResetPassword: true,
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  // Self-serve password change. Two allowed paths:
  //   1. currentPassword is supplied and matches → normal change flow
  //   2. mustResetPassword is true on the user  → skip currentPassword
  //      check (they just logged in with an admin-issued temp password
  //      and are being forced to pick a new one).
  // Sets mustResetPassword=false on success either way.
  async changeOwnPassword(
    userId: string,
    input: { currentPassword?: string; newPassword: string },
  ) {
    if (!input.newPassword || input.newPassword.length < 8) {
      throw new BadRequestException(
        'New password must be at least 8 characters',
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    // Skip the current-password check only when the user is under the
    // forced-reset flag. Regular voluntary changes still need proof.
    if (!user.mustResetPassword) {
      if (!input.currentPassword) {
        throw new BadRequestException(
          'Current password is required to change password.',
        );
      }
      const ok = await bcrypt.compare(input.currentPassword, user.password);
      if (!ok) {
        throw new BadRequestException('Current password is incorrect.');
      }
    }

    // Don't allow re-using the same password — the whole point of the
    // reset flow is to move the user OFF the temp credential.
    const isSame = await bcrypt.compare(input.newPassword, user.password);
    if (isSame) {
      throw new BadRequestException(
        'New password must be different from the current password.',
      );
    }

    const hashed = await bcrypt.hash(input.newPassword, 10);
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashed,
        mustResetPassword: false,
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  // Internal — returns password hash. Only used by AuthService.
  // Case-insensitive so users can type "Foo@Bar.com" or "foo@bar.com"
  // and reach the same account. findFirst (not findUnique) because the
  // unique constraint can't be combined with insensitive mode in Prisma.
  async findByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
    });
  }
}
