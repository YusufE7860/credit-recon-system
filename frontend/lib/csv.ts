// Tiny CSV builder + browser download trigger.
// No external deps — small enough not to warrant Papaparse for our use case.

export function rowsToCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: { key: keyof T; header: string }[],
): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    // Quote if it contains comma, quote, or newline; double-up internal quotes.
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const headerLine = columns.map((c) => escape(c.header)).join(',');
  const dataLines = rows.map((r) =>
    columns.map((c) => escape(r[c.key])).join(','),
  );
  return [headerLine, ...dataLines].join('\n');
}

export function downloadCsv(filename: string, csvText: string) {
  // Prepend BOM so Excel detects UTF-8 properly when opening on Windows.
  const blob = new Blob(['﻿', csvText], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
