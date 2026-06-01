import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { StatementsService } from './statements.service';
import type { UploadStatementMeta } from './statements.service';
import {
  MAX_STATEMENT_FILE_SIZE,
  ALLOWED_STATEMENT_MIME_TYPES,
} from './statements.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
import type { JwtUser } from '../auth/role.enum';

const multerStorage = diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(process.cwd(), 'uploads'));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = crypto.randomBytes(12).toString('hex');
    cb(null, `stmt-${Date.now()}-${id}${ext}`);
  },
});

@Controller('statements')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StatementsController {
  constructor(private statementsService: StatementsService) {}

  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.statementsService.list(user);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.statementsService.getById(id, user);
  }

  // Stream the original PDF/CSV back to the browser. Browsers display
  // PDFs inline; CSVs trigger a download. Used by the "View PDF" button
  // on the Reports > Statements tab.
  @Get(':id/file')
  async getFile(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const { absolutePath, mimeType, originalName } =
      await this.statementsService.getFilePath(id, user);
    res.setHeader('Content-Type', mimeType);
    // ASCII-safe filename for the Content-Disposition header — same
    // pattern we use on the recon-report download.
    const safeName = originalName.replace(/[\/\\"]/g, '_').replace(/[^\x20-\x7E]/g, '-');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    fs.createReadStream(absolutePath).pipe(res);
  }

  @Post('upload')
  @Roles(Role.ADMIN, Role.REPORTING)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multerStorage,
      limits: { fileSize: MAX_STATEMENT_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_STATEMENT_MIME_TYPES.includes(file.mimetype)) {
          cb(
            new BadRequestException(
              `Unsupported file type: ${file.mimetype}. Expected CSV or PDF.`,
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
    @Body() meta: UploadStatementMeta,
    @CurrentUser() user: JwtUser,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded');
    return this.statementsService.createFromUpload(file, meta, user.sub);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.statementsService.delete(id);
  }
}
