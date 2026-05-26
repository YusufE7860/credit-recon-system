import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { PrismaModule } from '../prisma/prisma.module';

// FFG official chart-of-accounts categories. Used as the initial seed
// the first time the app boots against an empty Category table — admin
// can edit/deactivate/add to them afterwards. Order here drives the
// initial sortOrder on the upload dropdown.
const FFG_DEFAULT_CATEGORIES = [
  'Sales',
  'Samples',
  'Advertising & Promotions',
  'Bank Charges - FNB',
  'Cleaning',
  'Computer Expenses',
  'Courier',
  'Electricity & Water',
  'Insurance',
  'Interest Paid',
  'Leasing Charges',
  'Motor Vehicle Expenses',
  'Printing & Stationery',
  'Packaging Costs',
  'Repairs & Maintenance',
  'AOD',
  'Security Costs',
  'Staff Welfare',
  'Subscriptions',
  'Telephone & Fax',
  'Cellular',
  'Travel & Accomodation - Local',
  'Travel & Accomodation - Foreign',
  'Set Up Costs',
  'Directors',
];

@Module({
  imports: [PrismaModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule implements OnModuleInit {
  private readonly logger = new Logger(CategoriesModule.name);

  constructor(private categories: CategoriesService) {}

  // Idempotent seed at boot. Adds any FFG default categories that
  // aren't already in the DB. Existing rows aren't touched.
  async onModuleInit() {
    try {
      const added = await this.categories.seedDefaults(
        FFG_DEFAULT_CATEGORIES,
      );
      if (added > 0) {
        this.logger.log(
          `Seeded ${added} default FFG categor${added === 1 ? 'y' : 'ies'}.`,
        );
      }
    } catch (err) {
      // Swallow — boot mustn't fail if seed has a race or the table
      // hasn't been migrated yet. Logged for the operator.
      this.logger.warn(
        `Category seed skipped: ${(err as Error).message}`,
      );
    }
  }
}
