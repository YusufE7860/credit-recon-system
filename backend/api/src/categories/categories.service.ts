import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateCategoryInput {
  name: string;
  sortOrder?: number | null;
}

export interface UpdateCategoryInput {
  name?: string;
  active?: boolean;
  sortOrder?: number | null;
}

// FFG expense categories — admin-managed list, used by the invoice
// upload page and the recon pivot. Mirrors StoresService in shape so
// the admin UI looks the same.
@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  // Default to active-only — the upload-page dropdown shouldn't show
  // deactivated categories. Admin page passes includeInactive=true.
  // Sorted by explicit sortOrder first (nulls last), then alphabetical
  // so a partial sortOrder pass still leaves the rest readable.
  async list(opts: { includeInactive?: boolean } = {}) {
    return this.prisma.category.findMany({
      where: opts.includeInactive ? undefined : { active: true },
      orderBy: [
        { sortOrder: { sort: 'asc', nulls: 'last' } },
        { name: 'asc' },
      ],
    });
  }

  async getById(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
    });
    if (!category) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    return category;
  }

  async create(input: CreateCategoryInput) {
    // Duplicate-name check up-front for a clean 409 vs Prisma's P2002.
    const dup = await this.prisma.category.findUnique({
      where: { name: input.name },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException(
        'A category with that name already exists',
      );
    }
    return this.prisma.category.create({
      data: {
        name: input.name.trim(),
        sortOrder: input.sortOrder ?? null,
      },
    });
  }

  async update(id: string, input: UpdateCategoryInput) {
    await this.getById(id);
    if (input.name !== undefined) {
      const collision = await this.prisma.category.findFirst({
        where: { name: input.name, NOT: { id } },
        select: { id: true },
      });
      if (collision) {
        throw new ConflictException(
          'A category with that name already exists',
        );
      }
    }
    return this.prisma.category.update({
      where: { id },
      data: input,
    });
  }

  async delete(id: string) {
    await this.getById(id);
    // Soft delete: many invoices may reference this category. Don't drop
    // the row or those references go orphan.
    return this.prisma.category.update({
      where: { id },
      data: { active: false },
    });
  }

  // Idempotent seeder — called at app boot to ensure the FFG default
  // categories exist. Safe to re-run: skips names that are already there.
  async seedDefaults(names: string[]) {
    let created = 0;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const existing = await this.prisma.category.findUnique({
        where: { name },
        select: { id: true },
      });
      if (!existing) {
        await this.prisma.category.create({
          data: { name, sortOrder: i },
        });
        created++;
      }
    }
    return created;
  }
}
