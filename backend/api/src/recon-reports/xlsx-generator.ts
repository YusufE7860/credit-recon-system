import ExcelJS from 'exceljs';
import { SnapshotData, SnapshotCardSection } from './recon-reports.service';

// Colours pulled to match the FNB layout reference:
//   Bright cyan header banner, yellow Amount column.
const COLOUR_HEADER_BG = 'FF4FD8FF';   // bright cyan
const COLOUR_AMOUNT_BG = 'FFFFFF66';   // pale yellow
const COLOUR_SECTION_BG = 'FFEFEFEF';  // grey for card header rows
const COLOUR_CR_GREEN = 'FF008800';    // green for credits

// Column layout — matches the FFG master sheet exactly.
// "Transaction Details" and "Loc" are now separate columns (merchant vs city).
// "Account" / "Name" / "Department" are populated from the matched invoice.
const COLUMNS: Array<{ key: string; header: string; width: number }> = [
  { key: 'no',         header: 'No',                                          width:  5 },
  { key: 'date',       header: 'Date',                                        width: 10 },
  { key: 'merchant',   header: 'Transaction Details',                         width: 35 },
  { key: 'loc',        header: 'Loc',                                         width: 16 },
  { key: 'amount',     header: 'Amount',                                      width: 14 },
  { key: 'desc',       header: 'FULL DESCRIPTION e.g. Reason, Where & Why',   width: 40 },
  { key: 'voucher',    header: 'VOUCHER ATTACHED Y/N',                        width: 14 },
  { key: 'account',    header: 'Account',                                     width: 22 },
  { key: 'name',       header: 'Name',                                        width: 24 },
  { key: 'department', header: 'Department',                                  width: 24 },
];

// Indexes into COLUMNS (1-based for ExcelJS getCell).
const COL_AMOUNT = 5;
const COL_VOUCHER = 7;

// Pivot table side-columns. Column K is left blank as a spacer between
// the transaction listing (A-J) and the pivot (L-M), matching the
// master sheet's layout.
const COL_PIVOT_LABEL = 12;   // L
const COL_PIVOT_AMOUNT = 13;  // M

// Build the reconciliation sheet, optionally including the pivot table
// in side-columns L-M on the same worksheet. The monthly download
// passes includePivot=false; the pivot download passes true.
// Sheet name can be overridden so multiple snapshots can coexist in a
// single workbook (used by the admin "combined" recon generator).
function buildReportSheet(
  workbook: ExcelJS.Workbook,
  snapshot: SnapshotData,
  options: { includePivot: boolean; sheetName?: string } = {
    includePivot: false,
  },
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(options.sheetName ?? 'Reconciliation', {
    pageSetup: { paperSize: 9, orientation: 'landscape' },
  });

  // ---- Title row (merged across the transaction columns A-J) ----
  const titleRow = sheet.addRow([snapshot.statementTitle]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, COLUMNS.length);
  styleTitleRow(titleRow);

  // ---- Column headers ----
  const headerRow = sheet.addRow(COLUMNS.map((c) => c.header));
  styleHeaderRow(headerRow);

  // Column widths for the transaction columns.
  sheet.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  // ---- Per-card sections ----
  for (const section of snapshot.cards) {
    writeSection(sheet, section);
  }

  // ---- Footer summary row ----
  sheet.addRow([]);
  const grandTotal = snapshot.cards.reduce(
    (sum, s) => sum + s.balanceTransferred,
    0,
  );
  const totalRow = sheet.addRow(['', '', 'Grand total', '', grandTotal]);
  totalRow.font = { bold: true };
  styleAmountCell(totalRow.getCell(COL_AMOUNT));

  // ---- Pivot block in side-columns (L-M), same sheet ----
  if (options.includePivot) {
    writePivotInSideColumns(sheet, snapshot);
  }

  return sheet;
}

// Write a pivot summary table in columns L-M of an existing sheet.
// Lays out as:
//   L1:M1  → "Pivot Summary" title banner
//   L2:M2  → headers ("Row Labels", "Sum of Amount")
//   L3+    → category total (bold), followed by indented dept sub-rows
//   bottom → grand total
//
// Uses cell-addressing (sheet.getCell(row, col)) so the pivot can sit
// alongside data written via addRow() without colliding.
function writePivotInSideColumns(
  sheet: ExcelJS.Worksheet,
  snapshot: SnapshotData,
) {
  // Set column widths now (these columns weren't in the COLUMNS array).
  sheet.getColumn(COL_PIVOT_LABEL).width = 32;
  sheet.getColumn(COL_PIVOT_AMOUNT).width = 16;

  // ---- Aggregate ----
  const byAccount = new Map<string, { total: number; byDept: Map<string, number> }>();
  let grandTotal = 0;
  for (const section of snapshot.cards) {
    for (const r of section.rows) {
      if (r.amount <= 0) continue; // skip credits
      const acct = r.account ?? 'Unclassified';
      const dept = r.department ?? '(no department)';
      const existing = byAccount.get(acct) ?? {
        total: 0,
        byDept: new Map<string, number>(),
      };
      existing.total += r.amount;
      existing.byDept.set(dept, (existing.byDept.get(dept) ?? 0) + r.amount);
      byAccount.set(acct, existing);
      grandTotal += r.amount;
    }
  }

  // ---- Title row (L1:M1, merged) ----
  const pivotTitle = sheet.getCell(1, COL_PIVOT_LABEL);
  pivotTitle.value = 'Pivot Summary';
  pivotTitle.font = { bold: true, size: 14 };
  pivotTitle.alignment = { horizontal: 'center', vertical: 'middle' };
  setCellFill(pivotTitle, COLOUR_HEADER_BG);
  setCellFill(sheet.getCell(1, COL_PIVOT_AMOUNT), COLOUR_HEADER_BG);
  sheet.mergeCells(1, COL_PIVOT_LABEL, 1, COL_PIVOT_AMOUNT);

  // ---- Header row (L2:M2) ----
  const labelHeader = sheet.getCell(2, COL_PIVOT_LABEL);
  labelHeader.value = 'Row Labels';
  labelHeader.font = { bold: true };
  labelHeader.alignment = { horizontal: 'center', vertical: 'middle' };
  setCellFill(labelHeader, COLOUR_HEADER_BG);

  const amountHeader = sheet.getCell(2, COL_PIVOT_AMOUNT);
  amountHeader.value = 'Sum of Amount';
  amountHeader.font = { bold: true };
  amountHeader.alignment = { horizontal: 'center', vertical: 'middle' };
  setCellFill(amountHeader, COLOUR_AMOUNT_BG);

  // ---- Body — accounts alphabetical, departments by descending amount ----
  let rowIdx = 3;
  const sortedAccounts = Array.from(byAccount.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [account, { total, byDept }] of sortedAccounts) {
    const acctLabel = sheet.getCell(rowIdx, COL_PIVOT_LABEL);
    acctLabel.value = account;
    acctLabel.font = { bold: true };

    const acctAmt = sheet.getCell(rowIdx, COL_PIVOT_AMOUNT);
    acctAmt.value = total;
    styleAmountCell(acctAmt);
    rowIdx++;

    const sortedDepts = Array.from(byDept.entries()).sort(
      ([, a], [, b]) => b - a,
    );
    for (const [dept, amount] of sortedDepts) {
      const deptLabel = sheet.getCell(rowIdx, COL_PIVOT_LABEL);
      deptLabel.value = `    ${dept}`;
      deptLabel.font = { italic: true };

      const deptAmt = sheet.getCell(rowIdx, COL_PIVOT_AMOUNT);
      deptAmt.value = amount;
      styleAmountCell(deptAmt);
      rowIdx++;
    }
  }

  // ---- Grand total ----
  rowIdx++; // spacer
  const grandLabel = sheet.getCell(rowIdx, COL_PIVOT_LABEL);
  grandLabel.value = 'Grand Total';
  grandLabel.font = { bold: true, size: 12 };
  setCellFill(grandLabel, COLOUR_HEADER_BG);

  const grandAmt = sheet.getCell(rowIdx, COL_PIVOT_AMOUNT);
  grandAmt.value = grandTotal;
  grandAmt.font = { bold: true };
  styleAmountCell(grandAmt);
  setCellFill(grandAmt, COLOUR_AMOUNT_BG);
}

// Build an XLSX buffer with just the transactions listing.
// The "Monthly" download button on the Reports page calls this.
export async function generateReconReportXlsx(
  snapshot: SnapshotData,
  reportName: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FFG Recon System';
  workbook.created = new Date();

  buildReportSheet(workbook, snapshot, { includePivot: false });

  // Output.
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

// ---------- Section helpers ----------

function writeSection(sheet: ExcelJS.Worksheet, section: SnapshotCardSection) {
  // Blank spacer.
  sheet.addRow([]);

  // Card-number row.
  const cardLine = section.maskedNumber
    ? `${section.maskedNumber}  - Limits`
    : `Card ${section.cardLast4 || '(unknown)'} - Limits`;
  const cardRow = sheet.addRow(['', '', cardLine]);
  cardRow.font = { bold: true };
  fillRange(cardRow, 1, COLUMNS.length, COLOUR_SECTION_BG);

  // Cardholder name row.
  if (section.cardholderName) {
    const holderRow = sheet.addRow(['', '', section.cardholderName]);
    holderRow.font = { bold: true };
    fillRange(holderRow, 1, COLUMNS.length, COLOUR_SECTION_BG);
  }

  // Balance brought forward.
  // Pad with empty strings so the amount lands in the right column index.
  const bbfRow = sheet.addRow([
    '', '', 'Balance Brought Forward', '', section.balanceBroughtForward,
  ]);
  bbfRow.font = { bold: true };
  styleAmountCell(bbfRow.getCell(COL_AMOUNT));

  // Transaction rows.
  for (const r of section.rows) {
    // FULL DESCRIPTION priority — what the accountant wants to see:
    //   1. The uploader's typed reason (invoice.notes — "TAAHIR GEMINI",
    //      "STORE TILLS Empangeni", "Cape Town site visit", etc.)
    //   2. Fall back to transaction.description (which is the location
    //      parsed off the bank statement — better than nothing).
    //   3. Fall back to the matched invoice's supplier name.
    //   4. Fall back to the category. Blank only when truly nothing.
    const fullDesc =
      r.userNotes ??
      r.description ??
      r.matchedInvoice?.supplier ??
      r.category ??
      '';

    const row = sheet.addRow([
      r.no,
      formatDateShort(r.date),
      r.merchant,
      r.location ?? '',
      r.amount,
      fullDesc,
      r.hasVoucher ? 'Y' : 'N',
      r.account ?? '',
      r.cardholderName ?? '',
      r.department ?? '',
    ]);

    styleAmountCell(row.getCell(COL_AMOUNT));

    if (r.amount < 0) {
      row.getCell(COL_AMOUNT).font = { color: { argb: COLOUR_CR_GREEN } };
    }

    // Y/N column — centre + bold + light tint based on value
    // so the eye picks up unvouchered rows immediately.
    const voucherCell = row.getCell(COL_VOUCHER);
    voucherCell.alignment = { horizontal: 'center' };
    voucherCell.font = { bold: true };
    if (!r.hasVoucher) {
      voucherCell.font = { bold: true, color: { argb: 'FFCC0000' } };
    }

    // Detail sub-rows below the main transaction — one per invoice
    // split (multi-store/category on one invoice) AND one per
    // additional attached invoice (split-receipt case). Indented
    // visually (italic + grey + no row number) so they're clearly a
    // breakdown of the parent, not a separate transaction.
    if (r.subRows && r.subRows.length > 0) {
      for (const sub of r.subRows) {
        const subRow = sheet.addRow([
          '',                     // No (intentionally blank)
          '',                     // Date
          `   ${sub.label}`,       // indented label in "Transaction Details"
          '',                     // Loc
          sub.amount ?? '',        // Amount
          sub.notes ?? '',         // Description
          '',                     // Voucher Y/N — empty on sub-rows
          sub.account ?? '',
          '',                     // Name — left blank on sub-rows
          sub.department ?? '',
        ]);
        subRow.font = { italic: true, color: { argb: 'FF666666' } };
        if (sub.amount != null) {
          styleAmountCell(subRow.getCell(COL_AMOUNT));
          if (sub.amount < 0) {
            subRow.getCell(COL_AMOUNT).font = {
              italic: true,
              color: { argb: COLOUR_CR_GREEN },
            };
          }
        }
      }
    }
  }

  // Balance transferred (section total).
  const btRow = sheet.addRow([
    '', '', 'Balance Transferred', '', section.balanceTransferred,
  ]);
  btRow.font = { bold: true };
  styleAmountCell(btRow.getCell(COL_AMOUNT));

  // Card total row to wrap the section (mirrors FNB layout).
  const totalRow = sheet.addRow([
    '', '', 'Card Total', '', section.balanceTransferred,
  ]);
  totalRow.font = { bold: true };
  fillRange(totalRow, 1, COLUMNS.length, COLOUR_SECTION_BG);
  styleAmountCell(totalRow.getCell(COL_AMOUNT));
}

// ---------- Cell-level styling primitives ----------

function styleTitleRow(row: ExcelJS.Row) {
  row.height = 28;
  row.font = { bold: true, size: 14 };
  row.alignment = { horizontal: 'center', vertical: 'middle' };
  fillRange(row, 1, COLUMNS.length, COLOUR_HEADER_BG);
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.height = 36;
  row.font = { bold: true };
  row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  fillRange(row, 1, COLUMNS.length, COLOUR_HEADER_BG);
  // The Amount column header gets yellow (matches the FNB reference).
  setCellFill(row.getCell(4), COLOUR_AMOUNT_BG);
}

function styleAmountCell(cell: ExcelJS.Cell) {
  cell.numFmt = '#,##0.00;[Red]-#,##0.00';
  cell.alignment = { horizontal: 'right' };
  setCellFill(cell, COLOUR_AMOUNT_BG);
}

function fillRange(row: ExcelJS.Row, from: number, to: number, argb: string) {
  for (let c = from; c <= to; c++) {
    setCellFill(row.getCell(c), argb);
  }
}

function setCellFill(cell: ExcelJS.Cell, argb: string) {
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb },
  };
  cell.border = {
    top:    { style: 'thin', color: { argb: 'FF999999' } },
    left:   { style: 'thin', color: { argb: 'FF999999' } },
    bottom: { style: 'thin', color: { argb: 'FF999999' } },
    right:  { style: 'thin', color: { argb: 'FF999999' } },
  };
}

// Build the same workbook as `generateReconReportXlsx` but with the
// pivot table written in side-columns L-M of the same worksheet —
// matching the layout of the FFG master sheet exactly.
export async function generateReconPivotXlsx(
  snapshot: SnapshotData,
  reportName: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FFG Recon System';
  workbook.created = new Date();

  buildReportSheet(workbook, snapshot, { includePivot: true });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// "15 Apr" — matches the FNB convention.
function formatDateShort(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ][d.getMonth()];
  return `${day} ${month}`;
}

// Excel limits sheet names to 31 chars and forbids these characters:
//   :  \  /  ?  *  [  ]
// Cardholder names usually fit fine but we sanitize defensively so a
// long or punctuation-heavy name doesn't crash the workbook write.
// Suffixes a counter when collisions appear within one workbook.
function sanitizeSheetName(name: string, taken: Set<string>): string {
  let cleaned = name.replace(/[:\\\/\?\*\[\]]/g, ' ').trim();
  if (cleaned.length > 31) cleaned = cleaned.slice(0, 31).trim();
  if (cleaned.length === 0) cleaned = 'Sheet';

  // Collision-bust by suffixing " 2", " 3", ... but keep total ≤ 31.
  let candidate = cleaned;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` ${n}`;
    candidate =
      cleaned.length + suffix.length > 31
        ? cleaned.slice(0, 31 - suffix.length).trim() + suffix
        : cleaned + suffix;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

// Build a single workbook containing one Reconciliation sheet per user
// PLUS a leading "Combined Pivot" sheet that aggregates across all
// snapshots (category → department → amount). Used by the admin recon
// generator when scope = "combined".
//
// Per-user sheets are NOT given individual pivots — the combined pivot
// at the front covers the whole company. Keeps the workbook focused.
export async function generateCombinedReconXlsx(
  snapshots: SnapshotData[],
  workbookTitle: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FFG Recon System';
  workbook.created = new Date();

  // ---- Front sheet: company-wide pivot ----
  // Walk every row of every snapshot, accumulate into category/department,
  // and emit a Pivot Summary table in columns A-B (rather than the side
  // columns we use on per-user sheets — here it's the main content).
  const pivotSheet = workbook.addWorksheet('Combined Pivot', {
    pageSetup: { paperSize: 9, orientation: 'landscape' },
  });
  pivotSheet.getColumn(1).width = 38;
  pivotSheet.getColumn(2).width = 18;

  // Title row.
  const pivotTitle = pivotSheet.addRow([workbookTitle]);
  pivotSheet.mergeCells(pivotTitle.number, 1, pivotTitle.number, 2);
  pivotTitle.height = 28;
  pivotTitle.font = { bold: true, size: 14 };
  pivotTitle.alignment = { horizontal: 'center', vertical: 'middle' };
  setCellFill(pivotTitle.getCell(1), COLOUR_HEADER_BG);
  setCellFill(pivotTitle.getCell(2), COLOUR_HEADER_BG);

  // Headers.
  const pivotHeader = pivotSheet.addRow(['Row Labels', 'Sum of Amount']);
  pivotHeader.font = { bold: true };
  pivotHeader.alignment = { horizontal: 'center' };
  setCellFill(pivotHeader.getCell(1), COLOUR_HEADER_BG);
  setCellFill(pivotHeader.getCell(2), COLOUR_AMOUNT_BG);

  // Aggregate across snapshots.
  const byAccount = new Map<
    string,
    { total: number; byDept: Map<string, number> }
  >();
  let grandTotal = 0;
  for (const snap of snapshots) {
    for (const card of snap.cards) {
      for (const r of card.rows) {
        if (r.amount <= 0) continue; // skip credits
        const acct = r.account ?? 'Unclassified';
        const dept = r.department ?? '(no department)';
        const existing = byAccount.get(acct) ?? {
          total: 0,
          byDept: new Map<string, number>(),
        };
        existing.total += r.amount;
        existing.byDept.set(
          dept,
          (existing.byDept.get(dept) ?? 0) + r.amount,
        );
        byAccount.set(acct, existing);
        grandTotal += r.amount;
      }
    }
  }

  // Body — accounts alphabetical, departments by descending amount.
  const sortedAccounts = Array.from(byAccount.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [account, { total, byDept }] of sortedAccounts) {
    const acctRow = pivotSheet.addRow([account, total]);
    acctRow.font = { bold: true };
    styleAmountCell(acctRow.getCell(2));

    const sortedDepts = Array.from(byDept.entries()).sort(
      ([, a], [, b]) => b - a,
    );
    for (const [dept, amount] of sortedDepts) {
      const deptRow = pivotSheet.addRow([`    ${dept}`, amount]);
      deptRow.font = { italic: true };
      styleAmountCell(deptRow.getCell(2));
    }
  }

  // Grand total.
  pivotSheet.addRow([]);
  const grandRow = pivotSheet.addRow(['Grand Total', grandTotal]);
  grandRow.font = { bold: true, size: 12 };
  setCellFill(grandRow.getCell(1), COLOUR_HEADER_BG);
  setCellFill(grandRow.getCell(2), COLOUR_AMOUNT_BG);
  styleAmountCell(grandRow.getCell(2));

  // ---- Per-user sheets ----
  const usedNames = new Set<string>(['combined pivot']);
  for (const snap of snapshots) {
    // Prefer the user's name (already on the snapshot) as the sheet
    // name. Falls back to "Sheet N" via the collision-buster.
    const desired = snap.user?.name ?? 'User';
    const sheetName = sanitizeSheetName(desired, usedNames);
    buildReportSheet(workbook, snap, {
      includePivot: false,
      sheetName,
    });
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
