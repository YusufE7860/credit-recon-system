import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { Response } from 'express';

import { InvoicesService } from './invoices.service';
import type {
  UploadInvoiceMeta,
  UpdateInvoiceInput,
} from './invoices.service';
import {
  MAX_INVOICE_FILE_SIZE,
  ALLOWED_INVOICE_MIME_TYPES,
} from './invoices.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/role.enum';
import { ReconStatus } from '@prisma/client';

const multerStorage = diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(process.cwd(), 'uploads'));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ext.length > 0 && ext.length <= 6 ? ext : '';
    const id = crypto.randomBytes(12).toString('hex');
    cb(null, `${Date.now()}-${id}${safeExt}`);
  },
});

@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(private invoicesService: InvoicesService) {}

  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('status') status?: ReconStatus,
    @Query('supplier') supplier?: string,
    @Query('requiresReview') requiresReview?: string,
    @Query('uploaderId') uploaderId?: string,
  ) {
    return this.invoicesService.list(
      {
        status,
        supplier,
        requiresReview:
          requiresReview === undefined
            ? undefined
            : requiresReview === 'true',
        uploaderId,
      },
      user,
    );
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.invoicesService.getById(id, user);
  }

  @Get(':id/file')
  async getFile(
    @Param('id') id: string,
    @Res() res: Response,
    @CurrentUser() user: JwtUser,
  ) {
    const { absolutePath, mimeType } =
      await this.invoicesService.getFilePath(id, user);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(absolutePath).pipe(res);
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multerStorage,
      limits: { fileSize: MAX_INVOICE_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_INVOICE_MIME_TYPES.includes(file.mimetype)) {
          cb(
            new BadRequestException(
              `Unsupported file type: ${file.mimetype}`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadInvoiceMeta,
    @CurrentUser() user: JwtUser,
  ) {
    if (!file) {
      throw new BadRequestException('No file was uploaded');
    }
    return this.invoicesService.createFromUpload(file, meta, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() input: UpdateInvoiceInput,
    @CurrentUser() user: JwtUser,
  ) {
    return this.invoicesService.update(id, input, user);
  }

  @Post(':id/rescan')
  rescan(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.invoicesService.rescan(id, user);
  }

  // Replace all line-item splits on an invoice. Body shape:
  // { splits: [{ category: string, store?: string, amount: number }, ...] }
  // Empty splits array = clear splits and revert to single-category.
  @Put(':id/splits')
  setSplits(
    @Param('id') id: string,
    @Body() body: { splits: Array<{ category: string; store?: string | null; amount: number }> },
    @CurrentUser() user: JwtUser,
  ) {
    return this.invoicesService.setSplits(id, body.splits ?? [], user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.invoicesService.delete(id, user);
  }
}
