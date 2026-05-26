import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReconReportsService, SnapshotData } from './recon-reports.service';
import {
  generateReconReportXlsx,
  generateReconPivotXlsx,
  generateCombinedReconXlsx,
} from './xlsx-generator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { Role } from '../auth/role.enum';
import type { JwtUser } from '../auth/role.enum';

// HTTP headers must be ASCII-only. Cardholder names ("Mahalingam Chinasamy"
// is fine, but accents or em-dashes are not), em-dashes from us, or any
// other Unicode would crash res.setHeader. This function returns a name
// safe for filename="..." while still being human-readable.
function asciiSafeFilename(s: string): string {
  return s
    // Strip path-trouble characters first.
    .replace(/[\/\\"]/g, '_')
    // Replace any non-ASCII character (em-dash, accents, etc.) with '-'.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '-')
    .trim()
    || 'report';
}

@Controller('recon-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReconReportsController {
  constructor(private reconReportsService: ReconReportsService) {}

  // GET /recon-reports — list (auto-scoped by role).
  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.reconReportsService.list(user);
  }

  // GET /recon-reports/:id — full report (rows JSON).
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.reconReportsService.getById(id, user);
  }

  // GET /recon-reports/:id/download — XLSX file stream.
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const report = await this.reconReportsService.getById(id, user);
    const snapshot = report.rows as unknown as SnapshotData;
    const buffer = await generateReconReportXlsx(snapshot, report.name);

    const safeName = asciiSafeFilename(report.name);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}.xlsx"`,
    );
    res.send(buffer);
  }

  // POST /recon-reports/generate-admin
  // Admin/Reporting only. Builds (and persists) per-user snapshots for
  // the chosen source + scope, then streams the resulting workbook.
  // Body shape:
  //   { source: 'statement' | 'range',
  //     statementId?: string,
  //     from?: ISO date string,
  //     to?: ISO date string,
  //     scope: 'per-user' | 'combined',
  //     userId?: string }   // when scope=per-user
  @Post('generate-admin')
  @Roles(Role.ADMIN, Role.REPORTING)
  async generateAdmin(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      source?: 'statement' | 'range';
      statementId?: string;
      from?: string;
      to?: string;
      scope?: 'per-user' | 'combined';
      userId?: string;
    } = {},
    @Res() res: Response,
  ) {
    if (body.source !== 'statement' && body.source !== 'range') {
      throw new BadRequestException(
        "source must be 'statement' or 'range'",
      );
    }
    if (body.scope !== 'per-user' && body.scope !== 'combined') {
      throw new BadRequestException(
        "scope must be 'per-user' or 'combined'",
      );
    }
    if (body.scope === 'per-user' && !body.userId) {
      throw new BadRequestException(
        "userId is required when scope='per-user'",
      );
    }

    const { snapshots, workbookTitle, periodStart } =
      await this.reconReportsService.generateAdminRecon({
        source: body.source,
        statementId: body.statementId,
        from: body.from ? new Date(body.from) : undefined,
        to: body.to ? new Date(body.to) : undefined,
        // per-user → restrict to that one user; combined → null = everyone
        userId: body.scope === 'per-user' ? body.userId ?? null : null,
        currentUser: user,
      });

    if (snapshots.length === 0) {
      throw new BadRequestException(
        'No transactions in this period — nothing to reconcile.',
      );
    }

    // Build the workbook. Per-user mode reuses the existing single-user
    // generator (so the file looks identical to the dashboard download
    // for that user); combined mode produces a multi-sheet workbook
    // with a leading pivot sheet aggregating everyone.
    let buffer: Buffer;
    let filename: string;
    if (body.scope === 'per-user') {
      const snap = snapshots[0];
      // Include the side-column pivot on per-user mode (admin asked for
      // the pivot table to always be included).
      buffer = await generateReconPivotXlsx(snap, workbookTitle);
      filename = `${asciiSafeFilename(snap.user?.name ?? 'User')} - ${periodStart.toISOString().slice(0, 7)}.xlsx`;
    } else {
      buffer = await generateCombinedReconXlsx(snapshots, workbookTitle);
      filename = `Combined Recon - ${periodStart.toISOString().slice(0, 7)}.xlsx`;
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiSafeFilename(filename)}"`,
    );
    res.send(buffer);
  }

  // POST /recon-reports/generate-snapshots
  // Same source/scope as generate-admin but returns JSON instead of a
  // file — used by the "Generate for each cardholder" button on the
  // Reports → Recon tab. Persists a ReconReport per affected user;
  // the frontend then refreshes the list table so each cardholder
  // appears as a separate row with their own download buttons.
  @Post('generate-snapshots')
  @Roles(Role.ADMIN, Role.REPORTING)
  async generateSnapshots(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      source?: 'statement' | 'range';
      statementId?: string;
      from?: string;
      to?: string;
    } = {},
  ) {
    if (body.source !== 'statement' && body.source !== 'range') {
      throw new BadRequestException(
        "source must be 'statement' or 'range'",
      );
    }
    const { snapshots, periodStart, periodEnd } =
      await this.reconReportsService.generateAdminRecon({
        source: body.source,
        statementId: body.statementId,
        from: body.from ? new Date(body.from) : undefined,
        to: body.to ? new Date(body.to) : undefined,
        // Always company-wide for this flow — one row per cardholder.
        userId: null,
        currentUser: user,
      });
    return {
      created: snapshots.length,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };
  }

  // GET /recon-reports/:id/pivot — pivot summary XLSX
  // (category → department breakdown of spend).
  @Get(':id/pivot')
  async pivot(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Res() res: Response,
  ) {
    const report = await this.reconReportsService.getById(id, user);
    const snapshot = report.rows as unknown as SnapshotData;
    const buffer = await generateReconPivotXlsx(snapshot, report.name);

    const safeName = asciiSafeFilename(report.name);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // Use ASCII hyphen, not em-dash — HTTP header values must be ASCII.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName} - Pivot.xlsx"`,
    );
    res.send(buffer);
  }
}
