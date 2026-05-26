import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateStoreInput {
  name: string;
  code?: string;
  address?: string;
}

export interface UpdateStoreInput {
  name?: string;
  code?: string | null;
  address?: string | null;
  active?: boolean;
}

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  // Default to active-only — the upload-page dropdown shouldn't show
  // deactivated stores. Admin page passes includeInactive=true.
  async list(opts: { includeInactive?: boolean } = {}) {
    return this.prisma.store.findMany({
      where: opts.includeInactive ? undefined : { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException(`Store ${id} not found`);
    return store;
  }

  async create(input: CreateStoreInput) {
    // Duplicate-name check up-front for a clean 409 vs Prisma's P2002.
    const dup = await this.prisma.store.findUnique({
      where: { name: input.name },
      select: { id: true },
    });
    if (dup) throw new ConflictException('A store with that name already exists');

    return this.prisma.store.create({
      data: {
        name: input.name,
        code: input.code ?? null,
        address: input.address ?? null,
      },
    });
  }

  async update(id: string, input: UpdateStoreInput) {
    await this.getById(id);
    if (input.name !== undefined) {
      const collision = await this.prisma.store.findFirst({
        where: { name: input.name, NOT: { id } },
        select: { id: true },
      });
      if (collision) {
        throw new ConflictException('A store with that name already exists');
      }
    }
    return this.prisma.store.update({
      where: { id },
      data: input,
    });
  }

  async delete(id: string) {
    await this.getById(id);
    // Soft delete: many invoices may reference store names. Don't drop the row.
    return this.prisma.store.update({
      where: { id },
      data: { active: false },
    });
  }
}
