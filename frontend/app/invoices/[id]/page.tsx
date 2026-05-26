'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import { StatusBadge } from '@/components/StatusBadge';
import { api, apiUpload, fetchFileAsBlobUrl, ApiError } from '@/lib/api';
import { useCurrentUser, hidesAmounts } from '@/lib/user-context';

type Transaction = {
  id: string;
  amount: number;
  merchant: string;
  transactionDate: string;
};

type Invoice = {
  id: string;
  supplier: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  subtotal: number;
  vat: number;
  total: number;
  currency: string;
  totalZAR: number | null;
  exchangeRate: number | null;
  category: string | null;
  storeAllocation: string | null;
  notes: string | null;
  ocrConfidence: number;
  requiresReview: boolean;
  ocrRawText: string | null;
  filePath: string | null;
  fileMimeType: string | null;
  status: string;
  matchedAt: string | null;
  transactionId: string | null;
  transaction: Transaction | null;
  editUnlockedUntil: string | null;
  metadataUnlockedUntil: string | null;
  createdAt: string;
};

export default function InvoiceDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { user } = useCurrentUser();
  // UPLOADERs see the invoice they uploaded but no money figures —
  // we hide Total/VAT inputs, the FX banner, and the matched-transaction
  // amount. They can still edit metadata (category/store/notes).
  const hideMoney = hidesAmounts(user?.role);

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  // Local editable copy of the editable fields.
  const [edits, setEdits] = useState<Partial<Invoice>>({});

  // Edit request state. `requestType` chooses which unlock the modal
  // is asking for — FINANCIAL (default, opens supplier/total/vat) or
  // METADATA (category/store/notes — used by UPLOADERs).
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestType, setRequestType] = useState<'FINANCIAL' | 'METADATA'>(
    'FINANCIAL',
  );
  const [requestReason, setRequestReason] = useState('');
  const [requestFields, setRequestFields] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);

  // Fetch invoice + file blob.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let blobUrl: string | null = null;

    (async () => {
      try {
        const inv = await api<Invoice>(`/invoices/${id}`);
        if (cancelled) return;
        setInvoice(inv);
        setEdits({
          category: inv.category,
          storeAllocation: inv.storeAllocation,
          notes: inv.notes,
          supplier: inv.supplier,
          invoiceNumber: inv.invoiceNumber,
          total: inv.total,
          vat: inv.vat,
        });

        if (inv.filePath) {
          blobUrl = await fetchFileAsBlobUrl(`/invoices/${id}/file`);
          if (!cancelled) setFileUrl(blobUrl);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Revoke the blob URL to free memory.
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [id]);

  async function handleSave() {
    if (!invoice) return;
    setSaving(true);
    setError('');
    setMessage('');

    // Build payload of only changed fields.
    const payload: Record<string, unknown> = {};
    const editable = ['category', 'storeAllocation', 'notes'] as const;
    for (const k of editable) {
      if (edits[k] !== invoice[k]) payload[k] = edits[k];
    }
    // Financial edits only allowed if requiresReview.
    if (invoice.requiresReview) {
      const finFields = [
        'supplier',
        'invoiceNumber',
        'total',
        'vat',
      ] as const;
      for (const k of finFields) {
        if (edits[k] !== invoice[k]) payload[k] = edits[k];
      }
    }

    try {
      const updated = await api<Invoice>(`/invoices/${id}`, {
        method: 'PATCH',
        json: payload,
      });
      setInvoice(updated);
      setEdits({
        category: updated.category,
        storeAllocation: updated.storeAllocation,
        notes: updated.notes,
        supplier: updated.supplier,
        invoiceNumber: updated.invoiceNumber,
        total: updated.total,
        vat: updated.vat,
      });
      setMessage('Saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRescan() {
    if (!invoice) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const updated = await api<Invoice>(`/invoices/${id}/rescan`, {
        method: 'POST',
      });
      setInvoice(updated);
      setMessage('OCR rescan complete.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rescan failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlink() {
    if (!invoice?.transactionId) return;
    try {
      const updated = await api<Invoice>(
        `/reconciliation/unlink/${id}`,
        { method: 'POST' },
      );
      setInvoice({ ...updated, transaction: null });
      setMessage('Unlinked from transaction.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this invoice? This cannot be undone.')) return;
    try {
      await api(`/invoices/${id}`, { method: 'DELETE' });
      router.push('/invoices');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen bg-gray-100">
        <Sidebar />
        <section className="flex-1 p-8">Loading...</section>
      </main>
    );
  }

  if (!invoice) {
    return (
      <main className="flex min-h-screen bg-gray-100">
        <Sidebar />
        <section className="flex-1 p-8">
          <p className="text-red-600">{error || 'Invoice not found'}</p>
        </section>
      </main>
    );
  }

  const isPdf = invoice.fileMimeType === 'application/pdf';
  const unlockActive =
    invoice.editUnlockedUntil != null &&
    new Date(invoice.editUnlockedUntil) > new Date();
  // Metadata unlock — separate window granted by a METADATA edit request.
  // Lets an UPLOADER (or, in theory, a USER with locked metadata) save
  // category/store/notes changes after admin approval.
  const metaUnlockActive =
    invoice.metadataUnlockedUntil != null &&
    new Date(invoice.metadataUnlockedUntil) > new Date();
  // Financial fields are editable when either OCR flagged the invoice
  // for review, or an admin has approved an unlock request.
  const financialsLocked = !invoice.requiresReview && !unlockActive;

  async function submitEditRequest(
    type: 'FINANCIAL' | 'METADATA' = 'FINANCIAL',
  ) {
    if (!requestReason.trim()) return;
    setRequestBusy(true);
    setError('');
    setMessage('');
    try {
      await api('/edit-requests', {
        method: 'POST',
        json: {
          invoiceId: invoice.id,
          reason: requestReason,
          fieldsToEdit: requestFields || undefined,
          type,
        },
      });
      setMessage('Edit request submitted. You will be notified when an admin reviews it.');
      setRequestOpen(false);
      setRequestReason('');
      setRequestFields('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setRequestBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 p-8">
        <button
          onClick={() => router.push('/invoices')}
          className="text-sm text-gray-600 hover:text-black mb-3"
        >
          ← Back to invoices
        </button>

        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-3xl font-bold">{invoice.supplier}</h1>
            <div className="flex items-center gap-3 mt-2">
              <StatusBadge status={invoice.status} />
              {invoice.requiresReview && (
                <span className="text-orange-600 text-sm font-medium">
                  Needs review · OCR {(invoice.ocrConfidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            {invoice.filePath && (
              <button
                onClick={handleRescan}
                disabled={saving}
                className="bg-white border border-gray-300 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                {saving ? 'Working...' : 'Re-run OCR'}
              </button>
            )}
            <button
              onClick={handleDelete}
              className="bg-white border border-red-300 text-red-600 px-3 py-2 rounded-lg text-sm hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
            {error}
          </p>
        )}
        {message && (
          <p className="text-sm text-green-700 bg-green-50 p-3 rounded mb-4">
            {message}
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LEFT: File preview */}
          <div className="bg-white rounded-xl shadow p-4">
            <h2 className="text-sm font-semibold text-gray-600 mb-3 uppercase tracking-wider">
              File
            </h2>
            {fileUrl ? (
              isPdf ? (
                <iframe
                  src={fileUrl}
                  className="w-full h-[600px] rounded border"
                />
              ) : (
                <img
                  src={fileUrl}
                  alt="Invoice"
                  className="w-full rounded border"
                />
              )
            ) : (
              <p className="text-gray-400 text-sm">No file attached.</p>
            )}

            {invoice.ocrRawText && (
              <div className="mt-4">
                <button
                  onClick={() => setShowRaw(!showRaw)}
                  className="text-xs text-gray-600 hover:text-black"
                >
                  {showRaw ? 'Hide' : 'Show'} raw OCR text
                </button>
                {showRaw && (
                  <pre className="mt-2 bg-gray-50 p-3 rounded text-xs whitespace-pre-wrap text-gray-700 max-h-64 overflow-auto">
                    {invoice.ocrRawText}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* RIGHT: Fields */}
          <div className="space-y-6">
            {/* OCR fields */}
            <div className="bg-white rounded-xl shadow p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                  Extracted fields
                </h2>
                {unlockActive ? (
                  <span className="text-xs text-green-700 font-medium">
                    Unlocked until{' '}
                    {new Date(invoice.editUnlockedUntil!).toLocaleString()}
                  </span>
                ) : financialsLocked ? (
                  <button
                    onClick={() => {
                      setRequestType('FINANCIAL');
                      setRequestOpen(true);
                    }}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Sealed — Request edit access
                  </button>
                ) : (
                  <span className="text-xs text-orange-600 font-medium">
                    Editable (OCR flagged for review)
                  </span>
                )}
              </div>

              <DetailField
                label="Supplier"
                value={edits.supplier ?? ''}
                onChange={(v) => setEdits({ ...edits, supplier: v })}
                readOnly={financialsLocked}
              />
              <DetailField
                label="Invoice #"
                value={edits.invoiceNumber ?? ''}
                onChange={(v) =>
                  setEdits({ ...edits, invoiceNumber: v })
                }
                readOnly={financialsLocked}
              />
              <DetailField
                label="Invoice date"
                value={new Date(invoice.invoiceDate).toLocaleDateString()}
                readOnly
              />
              {!hideMoney && (
                <div className="grid grid-cols-2 gap-3">
                  <DetailField
                    label={`Total (${invoice.currency})`}
                    value={String(edits.total ?? 0)}
                    onChange={(v) =>
                      setEdits({ ...edits, total: parseFloat(v) || 0 })
                    }
                    readOnly={financialsLocked}
                  />
                  <DetailField
                    label={`VAT (${invoice.currency})`}
                    value={String(edits.vat ?? 0)}
                    onChange={(v) =>
                      setEdits({ ...edits, vat: parseFloat(v) || 0 })
                    }
                    readOnly={financialsLocked}
                  />
                </div>
              )}

              {/* Conversion banner — only shown when currency is not ZAR.
                  Also hidden for UPLOADER (it's a monetary figure). */}
              {!hideMoney &&
                invoice.currency !== 'ZAR' &&
                invoice.totalZAR != null && (
                  <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs">
                    <p className="text-blue-900">
                      <strong>For matching: R {invoice.totalZAR.toFixed(2)}</strong>
                      {invoice.exchangeRate && (
                        <span className="text-blue-700">
                          {' '}
                          (rate {invoice.exchangeRate.toFixed(4)} ZAR per{' '}
                          {invoice.currency})
                        </span>
                      )}
                    </p>
                    <p className="text-blue-700 mt-1">
                      Reconciliation compares this ZAR figure against your bank statement.
                    </p>
                  </div>
                )}
            </div>

            {/* Metadata fields — UPLOADERs are locked out of editing
                here unless they have an approved METADATA unlock window. */}
            <div className="bg-white rounded-xl shadow p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                  Metadata
                </h2>
                {hideMoney && metaUnlockActive ? (
                  <span className="text-xs text-green-700 font-medium">
                    Unlocked until{' '}
                    {new Date(invoice.metadataUnlockedUntil!).toLocaleString()}
                  </span>
                ) : hideMoney ? (
                  <button
                    onClick={() => {
                      setRequestType('METADATA');
                      setRequestOpen(true);
                    }}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Sealed — Request edit access
                  </button>
                ) : null}
              </div>
              <DetailField
                label="Category"
                value={edits.category ?? ''}
                onChange={(v) => setEdits({ ...edits, category: v })}
                readOnly={hideMoney && !metaUnlockActive}
              />
              <DetailField
                label="Cost center / allocation"
                value={edits.storeAllocation ?? ''}
                onChange={(v) =>
                  setEdits({ ...edits, storeAllocation: v })
                }
                readOnly={hideMoney && !metaUnlockActive}
              />
              <DetailField
                label="Notes"
                value={edits.notes ?? ''}
                onChange={(v) => setEdits({ ...edits, notes: v })}
                multiline
                readOnly={hideMoney && !metaUnlockActive}
              />

              {/* Hide Save button for UPLOADERs while metadata is sealed. */}
              {(!hideMoney || metaUnlockActive) && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="mt-4 bg-black text-white px-4 py-2 rounded-lg font-medium hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? 'Saving...' : 'Save changes'}
                </button>
              )}
            </div>

            {/* Reconciliation panel — hidden entirely for UPLOADER
                since the matched-transaction line shows the bank-side
                amount, and the unlink/manual-link affordances are part
                of the accountant workflow they shouldn't touch. */}
            {!hideMoney && (
              <div className="bg-white rounded-xl shadow p-6">
                <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">
                  Reconciliation
                </h2>
                {invoice.transaction ? (
                  <div>
                    <p className="text-sm text-gray-600 mb-2">
                      Matched to transaction:
                    </p>
                    <div className="bg-green-50 p-3 rounded border border-green-200">
                      <p className="font-medium">
                        {invoice.transaction.merchant}
                      </p>
                      <p className="text-sm text-gray-600">
                        R {invoice.transaction.amount.toFixed(2)} ·{' '}
                        {new Date(
                          invoice.transaction.transactionDate,
                        ).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={handleUnlink}
                      className="mt-3 text-sm text-red-600 hover:text-red-800"
                    >
                      Unlink
                    </button>
                  </div>
                ) : (
                  <p className="text-gray-400 text-sm">
                    Not matched to any transaction yet. Run reconciliation
                    from the dashboard, or manually link from the
                    transactions page.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Edit request modal */}
        {requestOpen && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => !requestBusy && setRequestOpen(false)}
          >
            <div
              className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-1">
                Request{' '}
                {requestType === 'METADATA' ? 'metadata' : 'financial'} edit
                access
              </h3>
              <p className="text-sm text-gray-600 mb-4">
                An admin will review your request. If approved, you&apos;ll have
                24 hours to edit{' '}
                {requestType === 'METADATA'
                  ? 'category, cost center and notes'
                  : 'supplier, total and VAT'}{' '}
                on this invoice.
              </p>

              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason
              </label>
              <textarea
                value={requestReason}
                onChange={(e) => setRequestReason(e.target.value)}
                placeholder={
                  requestType === 'METADATA'
                    ? 'e.g. category was wrong — should be Travel not Fuel'
                    : 'e.g. OCR captured the wrong total — should be R450 not R45'
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 h-24"
                required
              />

              <label className="block text-sm font-medium text-gray-700 mb-1">
                Fields you want to edit (optional)
              </label>
              <input
                type="text"
                value={requestFields}
                onChange={(e) => setRequestFields(e.target.value)}
                placeholder={
                  requestType === 'METADATA'
                    ? 'e.g. category, storeAllocation'
                    : 'e.g. total, vat'
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4"
              />

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setRequestOpen(false)}
                  disabled={requestBusy}
                  className="px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => submitEditRequest(requestType)}
                  disabled={requestBusy || !requestReason.trim()}
                  className="bg-black text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-40"
                >
                  {requestBusy ? 'Submitting...' : 'Submit request'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

// Small editable/read-only field row.
function DetailField({
  label,
  value,
  onChange,
  readOnly = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  multiline?: boolean;
}) {
  const inputClass = `w-full border rounded-lg px-3 py-2 mb-3 ${
    readOnly
      ? 'bg-gray-50 text-gray-700 cursor-not-allowed'
      : 'border-gray-300 focus:outline-none focus:ring-2 focus:ring-black'
  }`;

  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          className={inputClass + ' h-20'}
        />
      ) : (
        <input
          type="text"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          className={inputClass}
        />
      )}
    </div>
  );
}
