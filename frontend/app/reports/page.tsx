'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend,
} from 'recharts';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';
import { rowsToCsv, downloadCsv } from '@/lib/csv';
import { useCurrentUser, canSeeAllInvoices } from '@/lib/user-context';

// ---------- Types matching backend ----------

type Summary = {
  totalSpend: number;
  totalRefunds: number;
  netSpend: number;
  transactionCount: number;
  invoiceCount: number;
  vatTotal: number;
  matchedInvoices: number;
  unmatchedInvoices: number;
  matchedRate: number;
};
type CategoryRow = { category: string; total: number; count: number };
type CardholderRow = {
  cardLast4: string;
  cardholderName: string | null;
  assignedUserName: string | null;
  // Null when the card has no user assigned yet. We need this to drive
  // the per-cardholder XLSX export (the endpoint takes a userId).
  assignedUserId: string | null;
  total: number;
  count: number;
};
type UnmatchedRow = {
  id: string;
  transactionDate: string;
  merchant: string;
  amount: number;
  cardLast4: string | null;
  cardholderName: string | null;
};
type ReportData = {
  range: { from: string; to: string };
  summary: Summary;
  byCategory: CategoryRow[];
  byCardholder: CardholderRow[];
  unmatched: UnmatchedRow[];
};

type Tab = 'summary' | 'category' | 'cardholder' | 'unmatched' | 'statements' | 'recon';

type StatementRow = {
  id: string;
  statementName: string;
  bankName: string | null;
  cardLast4: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  importedCount: number;
  skippedCount: number;
  userId: string;
  createdAt: string;
  _count: { transactions: number };
};

type ReconReportRow = {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  userId: string;
  runByName: string;
  totalSpend: number;
  matchedCount: number;
  unmatchedCount: number;
  cardCount: number;
  createdAt: string;
};

const PIE_COLORS = [
  '#0f172a', '#1e293b', '#475569', '#64748b',
  '#94a3b8', '#f97316', '#ef4444', '#10b981',
  '#3b82f6', '#a855f7',
];

const fmtZAR = (n: number) =>
  'R ' +
  n.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// ---------- Date helpers ----------

// All preset ranges return [from, to] as ISO YYYY-MM-DD strings.
function isoDate(d: Date): string {
  // Build YYYY-MM-DD without timezone surprises.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function presetThisMonth(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return [isoDate(start), isoDate(now)];
}
function presetLastMonth(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return [isoDate(start), isoDate(end)];
}
function presetLast3Months(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return [isoDate(start), isoDate(now)];
}
function presetYTD(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return [isoDate(start), isoDate(now)];
}

// ---------- Page ----------

export default function ReportsPage() {
  const { user } = useCurrentUser();
  const isAdminLike = canSeeAllInvoices(user?.role);

  // Default: This Month.
  const [from, setFrom] = useState<string>(() => presetThisMonth()[0]);
  const [to, setTo] = useState<string>(() => presetThisMonth()[1]);
  const [tab, setTab] = useState<Tab>('summary');

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Statements tab — separate from the date-ranged report data because
  // we want every uploaded statement listed, not just those in range.
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [statementsLoading, setStatementsLoading] = useState(false);
  // Which statement row is currently being deleted/viewed — used to
  // disable its buttons + dim the row.
  const [statementBusyId, setStatementBusyId] = useState<string | null>(null);

  // Open the original PDF / CSV in a new tab. Uses fetch + blob URL so
  // the auth cookie travels — a plain anchor link would skip credentials.
  async function viewStatementFile(s: StatementRow) {
    setStatementBusyId(s.id);
    setError('');
    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const res = await fetch(`${apiUrl}/statements/${s.id}/file`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Open in a new tab. We don't revoke the blob URL immediately
      // because the new tab still needs it — browsers GC it on tab close.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError((err as Error).message || 'Failed to load statement file');
    } finally {
      setStatementBusyId(null);
    }
  }

  // Delete a statement AND every transaction it imported. The backend
  // unlinks any matched invoices first. Asks for confirmation because
  // this is destructive and not undoable.
  async function deleteStatement(s: StatementRow) {
    if (
      !confirm(
        `Delete "${s.statementName}"?\n\n` +
          `This removes the statement, its ${s.importedCount} transaction${s.importedCount === 1 ? '' : 's'}, ` +
          `and unlinks any matched invoices (those invoices go back to UNMATCHED). ` +
          `This cannot be undone.`,
      )
    ) {
      return;
    }
    setStatementBusyId(s.id);
    setError('');
    try {
      await api(`/statements/${s.id}`, { method: 'DELETE' });
      // Refresh the table from the server so the count is authoritative.
      const fresh = await api<StatementRow[]>('/statements');
      setStatements(fresh);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed');
    } finally {
      setStatementBusyId(null);
    }
  }

  // Recon snapshots tab.
  const [reconReports, setReconReports] = useState<ReconReportRow[]>([]);
  const [reconReportsLoading, setReconReportsLoading] = useState(false);

  // Admin recon generator state. Lives at page level so opening another
  // tab and coming back doesn't blow away the operator's choices.
  const [genSource, setGenSource] = useState<'statement' | 'range'>('range');
  const [genStatementId, setGenStatementId] = useState<string>('');
  const [genFrom, setGenFrom] = useState<string>(() => presetLastMonth()[0]);
  const [genTo, setGenTo] = useState<string>(() => presetLastMonth()[1]);
  const [genScope, setGenScope] = useState<'per-user' | 'combined'>(
    'combined',
  );
  const [genUserId, setGenUserId] = useState<string>('');
  const [genBusy, setGenBusy] = useState(false);
  // Pulled lazily when the admin first opens the recon tab — feeds
  // the "Per user" picker.
  const [genUsers, setGenUsers] = useState<
    { id: string; name: string; email: string }[]
  >([]);

  async function fetchReport() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from, to });
      const result = await api<ReportData>(`/reports?${params.toString()}`);
      setData(result);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to load report',
      );
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch when date range changes.
  useEffect(() => {
    fetchReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  // Lazy-load the statements list when the user first opens that tab.
  useEffect(() => {
    if (tab !== 'statements' || statements.length > 0) return;
    setStatementsLoading(true);
    api<StatementRow[]>('/statements')
      .then(setStatements)
      .catch((err) => setError((err as Error).message))
      .finally(() => setStatementsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Lazy-load recon snapshots on first open of the recon tab.
  useEffect(() => {
    if (tab !== 'recon' || reconReports.length > 0) return;
    setReconReportsLoading(true);
    api<ReconReportRow[]>('/recon-reports')
      .then(setReconReports)
      .catch((err) => setError((err as Error).message))
      .finally(() => setReconReportsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // For the admin generator: when an admin first opens the recon tab,
  // pre-load the users + statements pickers. Plain USERs never see
  // the generator at all so they don't trigger these fetches.
  useEffect(() => {
    if (tab !== 'recon' || !isAdminLike) return;
    if (genUsers.length === 0) {
      api<{ id: string; name: string; email: string }[]>('/users')
        .then(setGenUsers)
        .catch(() => setGenUsers([]));
    }
    if (statements.length === 0) {
      setStatementsLoading(true);
      api<StatementRow[]>('/statements')
        .then(setStatements)
        .catch(() => setStatements([]))
        .finally(() => setStatementsLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isAdminLike]);

  // One-click "create a recon snapshot per cardholder" — no file
  // download, just persist rows and refresh the table so each person
  // appears with their own Monthly / Pivot buttons.
  const [genEachBusy, setGenEachBusy] = useState(false);
  async function runGenerateForEachCardholder() {
    if (genSource === 'statement' && !genStatementId) {
      setError('Pick a statement when generating from a statement.');
      return;
    }
    setGenEachBusy(true);
    setError('');
    try {
      const result = await api<{
        created: number;
        periodStart: string;
        periodEnd: string;
      }>('/recon-reports/generate-snapshots', {
        method: 'POST',
        json: {
          source: genSource,
          statementId:
            genSource === 'statement' ? genStatementId : undefined,
          from: genSource === 'range' ? genFrom : undefined,
          to: genSource === 'range' ? genTo : undefined,
        },
      });
      // Refresh the table — the new snapshots are persisted and the
      // /recon-reports list will now include them.
      const fresh = await api<ReconReportRow[]>('/recon-reports');
      setReconReports(fresh);
      if (result.created === 0) {
        setError(
          'No cardholders had activity in this period — nothing generated.',
        );
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generate failed');
    } finally {
      setGenEachBusy(false);
    }
  }

  // POST to the admin generator endpoint and stream the XLSX back as a
  // file download. Re-uses the credentials-include pattern so the auth
  // cookie travels with the request.
  async function runAdminGenerator() {
    if (genScope === 'per-user' && !genUserId) {
      setError('Pick a user when generating a per-user recon.');
      return;
    }
    if (genSource === 'statement' && !genStatementId) {
      setError('Pick a statement when generating from a statement.');
      return;
    }
    setGenBusy(true);
    setError('');
    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const res = await fetch(`${apiUrl}/recon-reports/generate-admin`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: genSource,
          statementId:
            genSource === 'statement' ? genStatementId : undefined,
          from: genSource === 'range' ? genFrom : undefined,
          to: genSource === 'range' ? genTo : undefined,
          scope: genScope,
          userId: genScope === 'per-user' ? genUserId : undefined,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Generate failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Try to honour the server's filename header, else fall back.
      const disp = res.headers.get('Content-Disposition') ?? '';
      const match = disp.match(/filename="([^"]+)"/);
      a.download = match
        ? match[1]
        : genScope === 'combined'
        ? 'Combined Recon.xlsx'
        : 'Recon.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // Refresh the recon report list so the new snapshots show up
      // in the table below.
      const fresh = await api<ReconReportRow[]>('/recon-reports');
      setReconReports(fresh);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenBusy(false);
    }
  }

  // Trigger an XLSX download for a single recon report.
  // We use a blob fetch so the auth cookie travels with the request —
  // a plain <a href> would skip credentials on cross-origin requests.
  // `variant` chooses which sheet to fetch: the full per-card listing
  // ("monthly") or the category → department pivot ("pivot").
  async function downloadReconReport(
    report: ReconReportRow,
    variant: 'monthly' | 'pivot' = 'monthly',
  ) {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const path = variant === 'pivot' ? 'pivot' : 'download';
      const res = await fetch(
        `${apiUrl}/recon-reports/${report.id}/${path}`,
        { credentials: 'include' },
      );
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = report.name.replace(/[\/\\"]/g, '_');
      a.download = variant === 'pivot'
        ? `${safeName} — Pivot.xlsx`
        : `${safeName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function applyPreset(getRange: () => [string, string]) {
    const [f, t] = getRange();
    setFrom(f);
    setTo(t);
  }

  // Per-cardholder FNB-style XLSX export. Hits the admin generator
  // endpoint with scope=per-user + the row's assignedUserId + the
  // currently-selected report date range. Reuses the same workbook
  // format accountants already use for monthly recons.
  const [exportingUserId, setExportingUserId] = useState<string | null>(null);

  // Track which unmatched-row notify call is in-flight so we can disable
  // the button + show a small spinner inline. Also remember which rows
  // we already notified this session so admins don't accidentally spam.
  const [notifyingId, setNotifyingId] = useState<string | null>(null);
  const [notifiedIds, setNotifiedIds] = useState<Set<string>>(
    () => new Set(),
  );
  async function notifyOwnerOfUnmatched(row: UnmatchedRow) {
    setNotifyingId(row.id);
    setError('');
    try {
      await api(`/transactions/${row.id}/notify-owner`, { method: 'POST' });
      setNotifiedIds((prev) => new Set(prev).add(row.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Notify failed');
    } finally {
      setNotifyingId(null);
    }
  }
  async function exportCardholderXlsx(row: CardholderRow) {
    if (!row.assignedUserId) {
      setError(
        `Card …${row.cardLast4} isn't assigned to a user yet. Assign it on the Cards page first.`,
      );
      return;
    }
    setExportingUserId(row.assignedUserId);
    setError('');
    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const res = await fetch(`${apiUrl}/recon-reports/generate-admin`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'range',
          from,
          to,
          scope: 'per-user',
          userId: row.assignedUserId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disp = res.headers.get('Content-Disposition') ?? '';
      const match = disp.match(/filename="([^"]+)"/);
      const safeName =
        (row.assignedUserName ?? row.cardholderName ?? 'User').replace(
          /[\/\\"]/g,
          '_',
        );
      a.download = match ? match[1] : `${safeName} - ${from} to ${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExportingUserId(null);
    }
  }

  // CSV exports — generated from current state, not re-fetched.
  function exportCategory() {
    if (!data) return;
    const csv = rowsToCsv(data.byCategory, [
      { key: 'category', header: 'Category' },
      { key: 'count',    header: 'Transactions' },
      { key: 'total',    header: 'Total (ZAR)' },
    ]);
    downloadCsv(`report-by-category-${from}-to-${to}.csv`, csv);
  }
  function exportCardholder() {
    if (!data) return;
    const csv = rowsToCsv(data.byCardholder, [
      { key: 'cardLast4',        header: 'Card last4' },
      { key: 'cardholderName',   header: 'Cardholder' },
      { key: 'assignedUserName', header: 'Assigned user' },
      { key: 'count',            header: 'Transactions' },
      { key: 'total',            header: 'Total (ZAR)' },
    ]);
    downloadCsv(`report-by-cardholder-${from}-to-${to}.csv`, csv);
  }
  function exportUnmatched() {
    if (!data) return;
    const csv = rowsToCsv(data.unmatched, [
      { key: 'transactionDate', header: 'Date' },
      { key: 'merchant',        header: 'Merchant' },
      { key: 'amount',          header: 'Amount' },
      { key: 'cardLast4',       header: 'Card last4' },
      { key: 'cardholderName',  header: 'Cardholder' },
    ]);
    downloadCsv(`report-unmatched-${from}-to-${to}.csv`, csv);
  }
  function exportSummary() {
    if (!data) return;
    const s = data.summary;
    const rows = [
      { metric: 'Date range',        value: `${from} to ${to}` },
      { metric: 'Total spend',       value: s.totalSpend },
      { metric: 'Total refunds',     value: s.totalRefunds },
      { metric: 'Net spend',         value: s.netSpend },
      { metric: 'Transactions',      value: s.transactionCount },
      { metric: 'Invoices',          value: s.invoiceCount },
      { metric: 'VAT total',         value: s.vatTotal },
      { metric: 'Matched invoices',  value: s.matchedInvoices },
      { metric: 'Unmatched invoices', value: s.unmatchedInvoices },
      { metric: 'Matched rate',      value: (s.matchedRate * 100).toFixed(1) + '%' },
    ];
    const csv = rowsToCsv(rows, [
      { key: 'metric', header: 'Metric' },
      { key: 'value',  header: 'Value' },
    ]);
    downloadCsv(`report-summary-${from}-to-${to}.csv`, csv);
  }

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 p-4 pt-16 md:p-8">
        <h1 className="text-3xl font-bold">Reports</h1>
        <p className="text-gray-600 mt-1 mb-6">
          Spend reports, VAT summary, and audit views
        </p>

        {/* Date range bar */}
        <div className="bg-white rounded-xl shadow p-4 mb-6">
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-sm font-medium text-gray-700">From:</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <label className="text-sm font-medium text-gray-700 ml-2">To:</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />

            <div className="flex gap-1 ml-auto">
              <PresetButton onClick={() => applyPreset(presetThisMonth)}>This month</PresetButton>
              <PresetButton onClick={() => applyPreset(presetLastMonth)}>Last month</PresetButton>
              <PresetButton onClick={() => applyPreset(presetLast3Months)}>Last 3</PresetButton>
              <PresetButton onClick={() => applyPreset(presetYTD)}>YTD</PresetButton>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 border-b border-gray-300 overflow-x-auto">
          <TabButton active={tab === 'summary'}    onClick={() => setTab('summary')}>Summary</TabButton>
          <TabButton active={tab === 'category'}   onClick={() => setTab('category')}>By category</TabButton>
          <TabButton active={tab === 'cardholder'} onClick={() => setTab('cardholder')}>By cardholder</TabButton>
          <TabButton active={tab === 'unmatched'}  onClick={() => setTab('unmatched')}>Unmatched</TabButton>
          <TabButton active={tab === 'statements'} onClick={() => setTab('statements')}>Statements</TabButton>
          <TabButton active={tab === 'recon'}      onClick={() => setTab('recon')}>Recon reports</TabButton>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
            {error}
          </p>
        )}
        {loading && (
          <p className="text-sm text-gray-600 mb-4">Loading...</p>
        )}

        {data && !loading && (
          <>
            {tab === 'summary' && (
              <SummaryView
                summary={data.summary}
                from={from}
                to={to}
                onExport={exportSummary}
              />
            )}
            {tab === 'category' && (
              <CategoryView rows={data.byCategory} onExport={exportCategory} />
            )}
            {tab === 'cardholder' && (
              <CardholderView
                rows={data.byCardholder}
                onExport={exportCardholder}
                isAdminLike={isAdminLike}
                onExportXlsx={exportCardholderXlsx}
                exportingUserId={exportingUserId}
              />
            )}
            {tab === 'unmatched' && (
              <UnmatchedView
                rows={data.unmatched}
                onExport={exportUnmatched}
                isAdminLike={isAdminLike}
                onNotify={notifyOwnerOfUnmatched}
                notifyingId={notifyingId}
                notifiedIds={notifiedIds}
              />
            )}
          </>
        )}

        {/* Statements tab is independent of the date range — every
            uploaded statement is listed. */}
        {tab === 'statements' && (
          <StatementsView
            rows={statements}
            loading={statementsLoading}
            isAdminLike={isAdminLike}
            onView={viewStatementFile}
            onDelete={deleteStatement}
            busyId={statementBusyId}
          />
        )}

        {tab === 'recon' && (
          <>
            {isAdminLike && (
              <AdminReconGenerator
                source={genSource} setSource={setGenSource}
                statementId={genStatementId} setStatementId={setGenStatementId}
                statements={statements}
                from={genFrom} setFrom={setGenFrom}
                to={genTo} setTo={setGenTo}
                scope={genScope} setScope={setGenScope}
                userId={genUserId} setUserId={setGenUserId}
                users={genUsers}
                busy={genBusy}
                onRun={runAdminGenerator}
                generateEachBusy={genEachBusy}
                onGenerateForEach={runGenerateForEachCardholder}
              />
            )}
            <ReconReportsView
              rows={reconReports}
              loading={reconReportsLoading}
              onDownload={downloadReconReport}
            />
          </>
        )}
      </section>
    </main>
  );
}

// ---------- Admin recon generator panel ----------
//
// Sits on top of the Recon reports list for admin/REPORTING users.
// Lets the operator pick (a) which transactions to include — by
// statement or date range — and (b) what kind of file to get back —
// one user or every user in one workbook. Both modes always include
// the pivot table per the FFG accountant's brief.
function AdminReconGenerator(props: {
  source: 'statement' | 'range';
  setSource: (v: 'statement' | 'range') => void;
  statementId: string;
  setStatementId: (v: string) => void;
  statements: StatementRow[];
  from: string;
  setFrom: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
  scope: 'per-user' | 'combined';
  setScope: (v: 'per-user' | 'combined') => void;
  userId: string;
  setUserId: (v: string) => void;
  users: { id: string; name: string; email: string }[];
  busy: boolean;
  onRun: () => void;
  // One-click "create a separate recon row per cardholder" — no file
  // download. Populates the table below so each person becomes a row
  // with their own Monthly / Pivot download buttons.
  onGenerateForEach: () => void;
  generateEachBusy: boolean;
}) {
  // Show statements newest-first; the date-range selector defaults to
  // last month which is the most common use case at month-end.
  const sortedStatements = [...props.statements].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="bg-white rounded-xl shadow p-5 mb-6">
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
        Generate recon
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Left: source ------------------------------------------------ */}
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-wider mb-2">
            Source
          </p>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => props.setSource('range')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                props.source === 'range'
                  ? 'bg-black text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Date range
            </button>
            <button
              onClick={() => props.setSource('statement')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                props.source === 'statement'
                  ? 'bg-black text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              By statement
            </button>
          </div>

          {props.source === 'range' ? (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-600 mb-1">From</label>
                <input
                  type="date"
                  value={props.from}
                  onChange={(e) => props.setFrom(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">To</label>
                <input
                  type="date"
                  value={props.to}
                  onChange={(e) => props.setTo(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Statement
              </label>
              <select
                value={props.statementId}
                onChange={(e) => props.setStatementId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="">— Pick a statement —</option>
                {sortedStatements.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.statementName}
                    {s.periodStart && s.periodEnd
                      ? ` (${new Date(s.periodStart).toLocaleDateString()} → ${new Date(s.periodEnd).toLocaleDateString()})`
                      : ''}
                  </option>
                ))}
              </select>
              {sortedStatements.length === 0 && (
                <p className="text-xs text-orange-600 mt-1">
                  No statements uploaded yet.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Right: scope ----------------------------------------------- */}
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-wider mb-2">
            Scope
          </p>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => props.setScope('combined')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                props.scope === 'combined'
                  ? 'bg-black text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              All users (one workbook)
            </button>
            <button
              onClick={() => props.setScope('per-user')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                props.scope === 'per-user'
                  ? 'bg-black text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Per user
            </button>
          </div>

          {props.scope === 'per-user' ? (
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                User
              </label>
              <select
                value={props.userId}
                onChange={(e) => props.setUserId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="">— Pick a user —</option>
                {props.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-xs text-gray-600 leading-relaxed">
              One XLSX with a <strong>Combined Pivot</strong> sheet up front
              (everyone&apos;s spend, category → department) plus one sheet per
              cardholder behind it.
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
        {/* Secondary action: persist a recon snapshot per cardholder
            for the chosen source, no download. Output appears as
            individual rows in the table below — admin picks Monthly /
            Pivot per person from there. */}
        <button
          onClick={props.onGenerateForEach}
          disabled={props.generateEachBusy || props.busy}
          className="bg-white border border-gray-300 text-gray-800 px-4 py-2.5 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-40 transition"
          title="Create one recon row per cardholder in the table below — no file download"
        >
          {props.generateEachBusy
            ? 'Generating each...'
            : 'Generate for each cardholder'}
        </button>
        <button
          onClick={props.onRun}
          disabled={props.busy || props.generateEachBusy}
          className="bg-orange-500 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-orange-600 disabled:opacity-40 transition"
        >
          {props.busy ? 'Generating...' : 'Generate XLSX'}
        </button>
      </div>
    </div>
  );
}

// ---------- Recon reports tab ----------

function ReconReportsView({
  rows, loading, onDownload,
}: {
  rows: ReconReportRow[];
  loading: boolean;
  onDownload: (r: ReconReportRow, variant: 'monthly' | 'pivot') => void;
}) {
  if (loading) {
    return <p className="text-sm text-gray-600">Loading recon reports...</p>;
  }
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow p-12 text-center text-gray-400 text-sm">
        No recon reports yet. Run a reconciliation from the dashboard.
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="w-full">
        <thead className="bg-black text-white">
          <tr>
            <th className="text-left p-3">Name</th>
            <th className="text-left p-3">Period</th>
            <th className="text-right p-3">Cards</th>
            <th className="text-right p-3">Matched / Total</th>
            <th className="text-right p-3">Total spend</th>
            <th className="text-left p-3">Run by</th>
            <th className="text-right p-3">Downloads</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const total = r.matchedCount + r.unmatchedCount;
            return (
              <tr key={r.id} className="border-b">
                <td className="p-3 font-medium">{r.name}</td>
                <td className="p-3 text-gray-700 whitespace-nowrap">
                  {new Date(r.periodStart).toLocaleDateString()} →{' '}
                  {new Date(r.periodEnd).toLocaleDateString()}
                </td>
                <td className="p-3 text-right text-gray-700">
                  {r.cardCount}
                </td>
                <td className="p-3 text-right">
                  <span
                    className={
                      total > 0 && r.matchedCount === total
                        ? 'text-green-700'
                        : r.unmatchedCount > 0
                        ? 'text-orange-700'
                        : 'text-gray-700'
                    }
                  >
                    {r.matchedCount} / {total}
                  </span>
                </td>
                <td className="p-3 text-right font-medium">
                  R{' '}
                  {r.totalSpend.toLocaleString('en-ZA', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </td>
                <td className="p-3 text-gray-700 text-sm">
                  {r.runByName}
                </td>
                <td className="p-3 text-right whitespace-nowrap">
                  {/* Monthly = per-card transaction listing (FNB layout)
                      Pivot   = category → department spend breakdown */}
                  <button
                    onClick={() => onDownload(r, 'monthly')}
                    className="text-xs bg-black text-white px-2.5 py-1.5 rounded hover:opacity-90 mr-2"
                    title="Per-card transaction listing"
                  >
                    Monthly
                  </button>
                  <button
                    onClick={() => onDownload(r, 'pivot')}
                    className="text-xs bg-orange-500 text-white px-2.5 py-1.5 rounded hover:bg-orange-600"
                    title="Category → department pivot summary"
                  >
                    Pivot
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatementsView({
  rows, loading, isAdminLike, onView, onDelete, busyId,
}: {
  rows: StatementRow[];
  loading: boolean;
  isAdminLike: boolean;
  onView: (s: StatementRow) => void;
  onDelete: (s: StatementRow) => void;
  busyId: string | null;
}) {
  if (loading) {
    return <p className="text-sm text-gray-600">Loading statements...</p>;
  }
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow p-12 text-center text-gray-400 text-sm">
        No statements uploaded yet.
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl shadow overflow-x-auto">
      <table className="w-full">
        <thead className="bg-black text-white">
          <tr>
            <th className="text-left p-3">Statement</th>
            <th className="text-left p-3">Bank</th>
            <th className="text-left p-3">Period</th>
            <th className="text-right p-3">Imported</th>
            <th className="text-right p-3">Skipped</th>
            <th className="text-left p-3">Uploaded</th>
            {isAdminLike && (
              <th className="text-right p-3">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              className={`border-b ${busyId === s.id ? 'opacity-40' : ''}`}
            >
              <td className="p-3 font-medium">{s.statementName}</td>
              <td className="p-3 text-gray-700">{s.bankName ?? '—'}</td>
              <td className="p-3 text-gray-700 whitespace-nowrap">
                {s.periodStart
                  ? new Date(s.periodStart).toLocaleDateString()
                  : '—'}
                {s.periodEnd && (
                  <> → {new Date(s.periodEnd).toLocaleDateString()}</>
                )}
              </td>
              <td className="p-3 text-right font-medium">{s.importedCount}</td>
              <td className="p-3 text-right text-gray-700">
                {s.skippedCount > 0 ? (
                  <span className="text-orange-600">{s.skippedCount}</span>
                ) : (
                  '0'
                )}
              </td>
              <td className="p-3 text-gray-700 whitespace-nowrap">
                {new Date(s.createdAt).toLocaleDateString()}
              </td>
              {isAdminLike && (
                <td className="p-3 text-right whitespace-nowrap">
                  <button
                    onClick={() => onView(s)}
                    disabled={busyId === s.id}
                    className="text-xs bg-black text-white px-2.5 py-1.5 rounded hover:opacity-90 mr-2 disabled:opacity-40"
                    title="Open the original PDF / CSV in a new tab"
                  >
                    View
                  </button>
                  <button
                    onClick={() => onDelete(s)}
                    disabled={busyId === s.id}
                    className="text-xs bg-white border border-red-300 text-red-600 px-2.5 py-1.5 rounded hover:bg-red-50 disabled:opacity-40"
                    title="Delete this statement AND every transaction it imported. Unlinks matched invoices first."
                  >
                    {busyId === s.id ? 'Deleting...' : 'Delete'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Tab views ----------

function SummaryView({
  summary, from, to, onExport,
}: {
  summary: Summary; from: string; to: string; onExport: () => void;
}) {
  const matchedPct = (summary.matchedRate * 100).toFixed(0);
  return (
    <div>
      <ExportBar label="Summary" onExport={onExport} />
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Total spend"      value={fmtZAR(summary.totalSpend)}    sub={`${summary.transactionCount} transactions`} />
        <Stat label="Refunds"          value={fmtZAR(summary.totalRefunds)}  sub="signed negative" />
        <Stat label="Net spend"        value={fmtZAR(summary.netSpend)}      sub="spend + refunds" />
        <Stat label="VAT total"        value={fmtZAR(summary.vatTotal)}      sub={`${summary.invoiceCount} invoices`} />
        <Stat label="Matched"          value={String(summary.matchedInvoices)}   sub={`${matchedPct}% match rate`} />
        <Stat label="Unmatched"        value={String(summary.unmatchedInvoices)} sub="need attention" highlight={summary.unmatchedInvoices > 0 ? 'orange' : undefined} />
        <Stat label="Period"           value={`${from}`}                      sub={`to ${to}`} />
        <Stat label="Avg per txn"      value={summary.transactionCount > 0 ? fmtZAR(summary.totalSpend / summary.transactionCount) : '—'} sub="across the period" />
      </div>
    </div>
  );
}

function CategoryView({ rows, onExport }: { rows: CategoryRow[]; onExport: () => void }) {
  const total = useMemo(() => rows.reduce((sum, r) => sum + r.total, 0), [rows]);
  return (
    <div>
      <ExportBar label={`By category (${rows.length})`} onExport={onExport} />
      {rows.length === 0 ? (
        <EmptyState text="No spend in this period." />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl shadow p-6">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={rows} dataKey="total" nameKey="category" cx="50%" cy="50%" outerRadius={110}>
                  {rows.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => fmtZAR(Number(v))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl shadow overflow-x-auto">
            <table className="w-full">
              <thead className="bg-black text-white">
                <tr>
                  <th className="text-left p-3">Category</th>
                  <th className="text-right p-3">Txns</th>
                  <th className="text-right p-3">Total</th>
                  <th className="text-right p-3">%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.category} className="border-b">
                    <td className="p-3">{r.category}</td>
                    <td className="p-3 text-right text-gray-700">{r.count}</td>
                    <td className="p-3 text-right font-medium">{fmtZAR(r.total)}</td>
                    <td className="p-3 text-right text-gray-600">
                      {total > 0 ? ((r.total / total) * 100).toFixed(1) + '%' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function CardholderView({
  rows, onExport, isAdminLike, onExportXlsx, exportingUserId,
}: {
  rows: CardholderRow[];
  onExport: () => void;
  isAdminLike: boolean;
  onExportXlsx: (r: CardholderRow) => void;
  exportingUserId: string | null;
}) {
  return (
    <div>
      <ExportBar label={`By cardholder (${rows.length})`} onExport={onExport} />
      {rows.length === 0 ? (
        <EmptyState text="No spend in this period." />
      ) : (
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-3">Cardholder</th>
                <th className="text-left p-3">Card</th>
                <th className="text-left p-3">Assigned user</th>
                <th className="text-right p-3">Txns</th>
                <th className="text-right p-3">Total</th>
                {isAdminLike && (
                  <th className="text-right p-3">Export</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.cardLast4} className="border-b">
                  <td className="p-3 font-medium">{r.cardholderName ?? '—'}</td>
                  <td className="p-3 text-gray-700">…{r.cardLast4}</td>
                  <td className="p-3 text-gray-700">
                    {r.assignedUserName ?? (
                      <span className="text-orange-600 text-xs">unassigned</span>
                    )}
                  </td>
                  <td className="p-3 text-right text-gray-700">{r.count}</td>
                  <td className="p-3 text-right font-medium">{fmtZAR(r.total)}</td>
                  {isAdminLike && (
                    <td className="p-3 text-right">
                      {/* One click → backend generates the per-user FNB
                          XLSX (with pivot) for the page's date range and
                          streams it back as a download. */}
                      <button
                        onClick={() => onExportXlsx(r)}
                        disabled={
                          !r.assignedUserId ||
                          exportingUserId === r.assignedUserId
                        }
                        title={
                          r.assignedUserId
                            ? 'Download this cardholder\'s recon XLSX for the selected period'
                            : 'Card unassigned — assign a user under Cards first'
                        }
                        className="text-xs bg-orange-500 text-white px-2.5 py-1.5 rounded hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {exportingUserId === r.assignedUserId
                          ? 'Exporting...'
                          : 'XLSX'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnmatchedView({
  rows, onExport, isAdminLike, onNotify, notifyingId, notifiedIds,
}: {
  rows: UnmatchedRow[];
  onExport: () => void;
  isAdminLike: boolean;
  onNotify: (r: UnmatchedRow) => void;
  notifyingId: string | null;
  notifiedIds: Set<string>;
}) {
  return (
    <div>
      <ExportBar label={`Unmatched (${rows.length})`} onExport={onExport} />
      {rows.length === 0 ? (
        <EmptyState text="Nothing unmatched in this period — clean books." />
      ) : (
        <>
          {rows.length === 500 && (
            <p className="text-sm text-orange-700 bg-orange-50 p-3 rounded mb-3">
              Showing first 500 unmatched items. Narrow the date range to see all.
            </p>
          )}
          <div className="bg-white rounded-xl shadow overflow-x-auto">
            <table className="w-full">
              <thead className="bg-black text-white">
                <tr>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Merchant</th>
                  <th className="text-right p-3">Amount</th>
                  <th className="text-left p-3">Card</th>
                  <th className="text-left p-3">Cardholder</th>
                  {isAdminLike && (
                    <th className="text-right p-3">Notify</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const wasNotified = notifiedIds.has(r.id);
                  const isBusy = notifyingId === r.id;
                  return (
                    <tr key={r.id} className="border-b">
                      <td className="p-3 text-gray-700 whitespace-nowrap">
                        {new Date(r.transactionDate).toLocaleDateString()}
                      </td>
                      <td className="p-3">{r.merchant}</td>
                      <td className="p-3 text-right font-medium">{fmtZAR(r.amount)}</td>
                      <td className="p-3 text-gray-700">
                        {r.cardLast4 ? '…' + r.cardLast4 : '—'}
                      </td>
                      <td className="p-3 text-gray-700">{r.cardholderName ?? '—'}</td>
                      {isAdminLike && (
                        <td className="p-3 text-right">
                          <button
                            onClick={() => onNotify(r)}
                            disabled={isBusy || wasNotified}
                            title={
                              wasNotified
                                ? 'Already notified this session'
                                : 'Send the card owner an in-app reminder to upload an invoice'
                            }
                            className={`text-xs px-2.5 py-1.5 rounded transition ${
                              wasNotified
                                ? 'bg-green-100 text-green-800 cursor-default'
                                : 'bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40'
                            }`}
                          >
                            {isBusy
                              ? 'Sending...'
                              : wasNotified
                              ? '✓ Notified'
                              : 'Notify'}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Small reusable bits ----------

function PresetButton({
  onClick, children,
}: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded transition"
    >
      {children}
    </button>
  );
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
        active
          ? 'border-orange-500 text-black'
          : 'border-transparent text-gray-600 hover:text-black'
      }`}
    >
      {children}
    </button>
  );
}

function ExportBar({ label, onExport }: { label: string; onExport: () => void }) {
  return (
    <div className="flex justify-between items-center mb-3">
      <p className="text-sm text-gray-700 font-medium">{label}</p>
      <button
        onClick={onExport}
        className="text-sm bg-white border border-gray-300 px-3 py-1.5 rounded hover:bg-gray-50"
      >
        Export CSV
      </button>
    </div>
  );
}

function Stat({
  label, value, sub, highlight,
}: {
  label: string; value: string; sub?: string; highlight?: 'orange';
}) {
  const cls =
    highlight === 'orange'
      ? 'bg-orange-50 border-orange-300'
      : 'bg-white';
  return (
    <div className={`${cls} rounded-xl shadow p-5 border`}>
      <p className="text-xs text-gray-600 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl shadow p-12 text-center text-gray-400 text-sm">
      {text}
    </div>
  );
}
