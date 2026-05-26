import { Module } from '@nestjs/common';
import { EditRequestsController } from './edit-requests.controller';
import { EditRequestsService } from './edit-requests.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EditRequestsController],
  providers: [EditRequestsService],
  exports: [EditRequestsService],
})
export class EditRequestsModule {}
