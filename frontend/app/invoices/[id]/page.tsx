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
  // All invoices currently attached to this transaction — populated when
  // multiple invoices share one statement line (split-receipt case).
  // Includes the current invoice; the UI filters it out for display.
  invoices?: Array<{
    id: string;
    supplier: string;
    total: number;
    totalZAR: number | null;
    currency: string;
  }>;
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
  // Optional line-item splits (multi-category invoices).
  splits?: InvoiceSplit[];
  // Refund / credit-note support.
  kind?: 'PURCHASE' | 'REFUND';
  // Wallet/store credit deducted from total before matching against the
  // statement. Common with Takealot wallet refunds applied to next order.
  creditApplied?: number;
};

type InvoiceSplit = {
  id: string;
  category: string;
  store: string | null;
  amount: number;
  sortOrder: number;
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

  // Manual-match modal state. Surfaced from the Reconciliation panel
  // when the invoice is PENDING / UNMATCHED — accountants pick a
  // specific transaction to link the invoice to.
  type UnmatchedCandidate = {
    id: string;
    transactionDate: string;
    merchant: string;
    amount: number;
    cardLast4: string | null;
    category: string | null;
    description: string | null;
    // Populated by the new partial-match logic. claimedAmount = sum of
    // invoices already attached; remainingAmount = txn amount - claimed.
    // When matchedInvoices.length > 0 the picker shows a "partially
    // matched" badge so users see what they're stacking onto.
    claimedAmount?: number;
    remainingAmount?: number;
    matchedInvoices?: Array<{ id: string; supplier: string; amount: number }>;
  };
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchCandidates, setMatchCandidates] = useState<UnmatchedCandidate[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);

  // Splits state — line-item breakdown when one invoice covers multiple
  // categories/stores. Editable draft; only saved when the user clicks
  // "Save splits". `splitDraft` is null when not editing (closed UI).
  const [splitDraft, setSplitDraft] = useState<
    Array<{ category: string; store: string; amount: number }> | null
  >(null);
  const [splitSaving, setSplitSaving] = useState(false);

  // Begin editing splits. Pre-seeds from existing splits if any,
  // otherwise starts with a single line at the full invoice total so
  // the user can immediately split it.
  function openSplitEditor() {
    if (!invoice) return;
    if (invoice.splits && invoice.splits.length > 0) {
      setSplitDraft(
        invoice.splits.map((s) => ({
          category: s.category,
          store: s.store ?? '',
          amount: s.amount,
        })),
      );
    } else {
      setSplitDraft([
        {
          category: invoice.category ?? '',
          store: invoice.storeAllocation ?? '',
          amount: invoice.total,
        },
      ]);
    }
  }

  // Persist the splits. Backend validates that the sum matches invoice
  // total; we mirror the check client-side for instant feedback.
  async function saveSplits() {
    if (!invoice || !splitDraft) return;
    const sum = splitDraft.reduce((acc, s) => acc + (s.amount || 0), 0);
    if (Math.abs(sum - invoice.total) > 0.01) {
      setError(
        `Split lines must sum to invoice total. Total = R ${invoice.total.toFixed(2)}, splits = R ${sum.toFixed(2)}.`,
      );
      return;
    }
    setSplitSaving(true);
    setError('');
    setMessage('');
    try {
      await api(`/invoices/${invoice.id}/splits`, {
        method: 'PUT',
        json: {
          splits: splitDraft.map((s) => ({
            category: s.category.trim(),
            store: s.store.trim() || null,
            amount: s.amount,
          })),
        },
      });
      const updated = await api<Invoice>(`/invoices/${invoice.id}`);
      setInvoice(updated);
      setSplitDraft(null);
      setMessage('Splits saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save splits');
    } finally {
      setSplitSaving(false);
    }
  }

  async function clearSplits() {
    if (!invoice) return;
    if (!confirm('Remove all splits and revert to a single category?')) return;
    setSplitSaving(true);
    setError('');
    try {
      await api(`/invoices/${invoice.id}/splits`, {
        method: 'PUT',
        json: { splits: [] },
      });
      const updated = await api<Invoice>(`/invoices/${invoice.id}`);
      setInvoice(updated);
      setSplitDraft(null);
      setMessage('Splits cleared.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to clear splits');
    } finally {
      setSplitSaving(false);
    }
  }

  // Fetch unmatched transactions visible to this user.
  // Called every time the modal opens so the list is fresh (avoids
  // showing a transaction that someone else just matched).
  async function loadUnmatchedCandidates() {
    if (!id) return;
    setMatchLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ invoiceId: id });
      const data = await api<UnmatchedCandidate[]>(
        `/reconciliation/unmatched-transactions?${params}`,
      );
      setMatchCandidates(data);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to load transactions',
      );
    } finally {
      setMatchLoading(false);
    }
  }

  // Confirm the match. Backend rejects if either side is already
  // matched, so we surface that as an error and refresh the list.
  async function confirmManualMatch(transactionId: string) {
    if (!invoice) return;
    setMatchBusyId(transactionId);
    setError('');
    setMessage('');
    try {
      await api('/reconciliation/match', {
        method: 'POST',
        json: { invoiceId: invoice.id, transactionId },
      });
      // Refresh the whole invoice so the Reconciliation panel flips to
      // the matched-state UI with the linked transaction details.
      const updated = await api<Invoice>(`/invoices/${invoice.id}`);
      setInvoice(updated);
      setMatchOpen(false);
      setMessage('Matched to transaction.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Match failed');
      // Reload candidates — the transaction might have been taken since
      // the modal opened.
      await loadUnmatchedCandidates();
    } finally {
      setMatchBusyId(null);
    }
  }

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
          kind: inv.kind ?? 'PURCHASE',
          creditApplied: inv.creditApplied ?? 0,
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
    //
    // Amount fields (total/vat/subtotal) are NEVER sent — they're
    // locked everywhere and the backend rejects them anyway. The
    // remaining "financial" text fields (supplier/invoiceNumber) only
    // go when the invoice is flagged for review (OCR-confidence path).
    const payload: Record<string, unknown> = {};
    const editable = [
      'category',
      'storeAllocation',
      'notes',
      // kind + creditApplied flow through the metadata-edit code path
      // on the backend (they don't change the printed total).
      'kind',
      'creditApplied',
    ] as const;
    for (const k of editable) {
      if (edits[k] !== (invoice[k] ?? (k === 'creditApplied' ? 0 : k === 'kind' ? 'PURCHASE' : null))) {
        payload[k] = edits[k];
      }
    }
    if (invoice.requiresReview) {
      const finFields = ['supplier', 'invoiceNumber'] as const;
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
        kind: updated.kind ?? 'PURCHASE',
        creditApplied: updated.creditApplied ?? 0,
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
        <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">Loading...</section>
      </main>
    );
  }

  if (!invoice) {
    return (
      <main className="flex min-h-screen bg-gray-100">
        <Sidebar />
        <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
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
    // TypeScript can't carry the early-return narrowing into this
    // nested closure — explicit guard so `invoice.id` below is safe
    // and we cleanly bail if Submit fires on a still-loading page.
    if (!invoice || !requestReason.trim()) return;
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

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
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
                <>
                  <div className="grid grid-cols-2 gap-3">
                    {/* Amounts are LOCKED for everyone, no matter their
                        role or any unlock state. They must match the
                        original invoice. Backend rejects any PATCH that
                        tries to change them — the readOnly here matches
                        that contract. */}
                    <DetailField
                      label={`Total (${invoice.currency})`}
                      value={String(edits.total ?? 0)}
                      readOnly
                    />
                    <DetailField
                      label={`VAT (${invoice.currency})`}
                      value={String(edits.vat ?? 0)}
                      readOnly
                    />
                  </div>
                  <p className="text-xs text-gray-500 -mt-2 mb-3">
                    Amounts can&apos;t be edited — they must match the
                    original invoice. If they&apos;re wrong, delete and re-upload.
                  </p>
                </>
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
              {/* Invoice kind toggle: PURCHASE vs REFUND (credit note).
                  Hidden from UPLOADERs since they can't see money fields
                  at all — kind doesn't make sense in isolation for them.
                  REFUND invoices match against negative-amount statement
                  lines (money coming back to the card). */}
              {!hideMoney && (
                <div className="mb-4">
                  <label className="block text-xs font-medium text-gray-600 uppercase tracking-wider mb-2">
                    Kind
                  </label>
                  <div className="flex gap-2">
                    {(['PURCHASE', 'REFUND'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setEdits({ ...edits, kind: k })}
                        className={`px-3 py-1.5 text-sm rounded-lg border ${
                          (edits.kind ?? 'PURCHASE') === k
                            ? k === 'REFUND'
                              ? 'bg-red-50 border-red-300 text-red-700 font-medium'
                              : 'bg-orange-50 border-orange-300 text-orange-700 font-medium'
                            : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {k === 'PURCHASE' ? 'Purchase' : 'Refund / credit note'}
                      </button>
                    ))}
                  </div>
                  {edits.kind === 'REFUND' && (
                    <p className="text-xs text-red-700 mt-2">
                      This invoice will match a NEGATIVE-amount line on
                      the statement (money refunded back to the card).
                    </p>
                  )}
                </div>
              )}

              {/* Credit applied — wallet/store credit deducted from the
                  printed total before matching. The card only saw the
                  difference, so the matcher uses (total - creditApplied). */}
              {!hideMoney && (
                <div className="mb-4">
                  <label className="block text-xs font-medium text-gray-600 uppercase tracking-wider mb-2">
                    Wallet / store credit applied
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-sm">R</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={edits.creditApplied ?? 0}
                      onChange={(e) =>
                        setEdits({
                          ...edits,
                          creditApplied: parseFloat(e.target.value) || 0,
                        })
                      }
                      className="w-32 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                      placeholder="0.00"
                    />
                    {(edits.creditApplied ?? 0) > 0 && invoice && (
                      <span className="text-xs text-gray-600">
                        → effective R{' '}
                        {(
                          (invoice.totalZAR ?? invoice.total) -
                          (edits.creditApplied ?? 0)
                        ).toFixed(2)}{' '}
                        will match
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    For purchases partly paid by wallet credit (e.g.
                    Takealot wallet refund used on a new order).
                  </p>
                </div>
              )}

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

            {/* Line-item splits — for invoices covering multiple
                categories or stores. Hidden for UPLOADERs (it edits the
                financial breakdown which is locked behind admin
                approval for them). */}
            {!hideMoney && invoice && (
              <div className="bg-white rounded-xl shadow p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                    Line splits
                  </h2>
                  {(invoice.splits?.length ?? 0) > 0 && !splitDraft && (
                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                      {invoice.splits!.length} lines
                    </span>
                  )}
                </div>

                {/* View mode: existing splits in read-only summary */}
                {!splitDraft && (invoice.splits?.length ?? 0) > 0 && (
                  <div className="space-y-2 mb-4">
                    {invoice.splits!.map((s) => (
                      <div
                        key={s.id}
                        className="flex justify-between items-center text-sm border-b border-gray-100 pb-2"
                      >
                        <div>
                          <p className="font-medium">{s.category}</p>
                          {s.store && (
                            <p className="text-xs text-gray-500">{s.store}</p>
                          )}
                        </div>
                        <p className="font-medium">R {s.amount.toFixed(2)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* View mode: no splits yet */}
                {!splitDraft && (invoice.splits?.length ?? 0) === 0 && (
                  <p className="text-sm text-gray-500 mb-4">
                    This invoice uses a single category. Add splits if it
                    covers spend across multiple categories or stores.
                  </p>
                )}

                {/* Action buttons in view mode */}
                {!splitDraft && (
                  <div className="flex gap-2">
                    <button
                      onClick={openSplitEditor}
                      className="text-sm bg-black text-white px-3 py-1.5 rounded hover:opacity-90"
                    >
                      {(invoice.splits?.length ?? 0) > 0
                        ? 'Edit splits'
                        : 'Split into lines'}
                    </button>
                    {(invoice.splits?.length ?? 0) > 0 && (
                      <button
                        onClick={clearSplits}
                        disabled={splitSaving}
                        className="text-sm text-red-600 px-3 py-1.5 rounded hover:bg-red-50"
                      >
                        Clear splits
                      </button>
                    )}
                  </div>
                )}

                {/* Edit mode: draft table */}
                {splitDraft && (
                  <div>
                    <table className="w-full text-sm mb-3">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 uppercase">
                          <th className="pb-2">Category</th>
                          <th className="pb-2">Store</th>
                          <th className="pb-2 text-right">Amount</th>
                          <th className="pb-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {splitDraft.map((s, idx) => (
                          <tr key={idx} className="border-b border-gray-100">
                            <td className="py-2 pr-2">
                              <input
                                value={s.category}
                                onChange={(e) => {
                                  const next = [...splitDraft];
                                  next[idx] = {
                                    ...next[idx],
                                    category: e.target.value,
                                  };
                                  setSplitDraft(next);
                                }}
                                placeholder="Category"
                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                              />
                            </td>
                            <td className="py-2 pr-2">
                              <input
                                value={s.store}
                                onChange={(e) => {
                                  const next = [...splitDraft];
                                  next[idx] = {
                                    ...next[idx],
                                    store: e.target.value,
                                  };
                                  setSplitDraft(next);
                                }}
                                placeholder="(optional)"
                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                              />
                            </td>
                            <td className="py-2 pr-2">
                              <input
                                type="number"
                                step="0.01"
                                value={s.amount}
                                onChange={(e) => {
                                  const next = [...splitDraft];
                                  next[idx] = {
                                    ...next[idx],
                                    amount: parseFloat(e.target.value) || 0,
                                  };
                                  setSplitDraft(next);
                                }}
                                className="w-24 text-right border border-gray-300 rounded px-2 py-1 text-sm"
                              />
                            </td>
                            <td className="py-2 text-right">
                              <button
                                onClick={() =>
                                  setSplitDraft(
                                    splitDraft.filter((_, i) => i !== idx),
                                  )
                                }
                                className="text-gray-400 hover:text-red-600 text-lg"
                                title="Remove line"
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Sum hint */}
                    {(() => {
                      const sum = splitDraft.reduce(
                        (acc, s) => acc + (s.amount || 0),
                        0,
                      );
                      const diff = invoice.total - sum;
                      const ok = Math.abs(diff) < 0.01;
                      return (
                        <p
                          className={`text-xs mb-3 ${ok ? 'text-green-700' : 'text-orange-700'}`}
                        >
                          Sum: R {sum.toFixed(2)} of R{' '}
                          {invoice.total.toFixed(2)}{' '}
                          {ok ? '✓' : `(${diff > 0 ? '+' : ''}${diff.toFixed(2)})`}
                        </p>
                      );
                    })()}

                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() =>
                          setSplitDraft([
                            ...splitDraft,
                            { category: '', store: '', amount: 0 },
                          ])
                        }
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded hover:bg-gray-50"
                      >
                        + Add line
                      </button>
                      <button
                        onClick={saveSplits}
                        disabled={splitSaving}
                        className="text-sm bg-black text-white px-3 py-1.5 rounded hover:opacity-90 disabled:opacity-40"
                      >
                        {splitSaving ? 'Saving...' : 'Save splits'}
                      </button>
                      <button
                        onClick={() => setSplitDraft(null)}
                        disabled={splitSaving}
                        className="text-sm text-gray-700 px-3 py-1.5 rounded hover:bg-gray-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

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
                  <div>
                    <p className="text-gray-500 text-sm mb-3">
                      Not matched to any transaction yet.
                      {invoice.status === 'UNMATCHED' &&
                        ' Auto-matching ran but found no candidate.'}
                      {invoice.status === 'PENDING' &&
                        ' Reconciliation hasn’t been run on this period yet.'}
                    </p>
                    <button
                      onClick={() => {
                        setMatchOpen(true);
                        loadUnmatchedCandidates();
                      }}
                      className="bg-orange-500 text-white text-sm px-4 py-2 rounded-lg hover:bg-orange-600"
                    >
                      Match to a transaction
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Manual-match picker modal — lets the user pick a specific
            transaction to link this invoice to. Only opened from the
            Reconciliation panel, which itself only shows the button
            when the invoice is PENDING / UNMATCHED. */}
        {matchOpen && (
          <div
            className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-2 sm:p-4"
            onClick={() => matchBusyId === null && setMatchOpen(false)}
          >
            <div
              className="bg-white rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-5 border-b border-gray-200 flex-shrink-0">
                <h3 className="text-lg font-semibold">
                  Match to a transaction
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  Pick the bank transaction that pays for{' '}
                  <strong>{invoice.supplier}</strong>
                  {invoice.totalZAR != null && (
                    <>
                      {' '}— invoice is{' '}
                      <strong>R {invoice.totalZAR.toFixed(2)}</strong> on{' '}
                      {new Date(invoice.invoiceDate).toLocaleDateString()}
                    </>
                  )}
                  . Only unmatched transactions are shown.
                </p>
                <input
                  type="text"
                  value={matchSearch}
                  onChange={(e) => setMatchSearch(e.target.value)}
                  placeholder="Filter by merchant or amount..."
                  className="mt-3 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              {/* Scrollable list — height-capped so on phones the
                  modal doesn't blow past the viewport. */}
              <div className="flex-1 overflow-y-auto">
                {matchLoading ? (
                  <p className="p-6 text-sm text-gray-500">Loading...</p>
                ) : matchCandidates.length === 0 ? (
                  <p className="p-6 text-sm text-gray-400 text-center">
                    No unmatched transactions visible. Upload a bank
                    statement covering this period, or check that the
                    cardholder is the same on both sides.
                  </p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {matchCandidates
                      .filter((t) => {
                        if (!matchSearch.trim()) return true;
                        const needle = matchSearch.trim().toLowerCase();
                        return (
                          t.merchant.toLowerCase().includes(needle) ||
                          t.amount.toFixed(2).includes(needle) ||
                          (t.description ?? '')
                            .toLowerCase()
                            .includes(needle)
                        );
                      })
                      .map((t) => {
                        const isBusy = matchBusyId === t.id;
                        // For partial-match candidates, we compare the
                        // invoice amount against the REMAINING amount on
                        // the transaction (txn total - already claimed)
                        // rather than the full txn total. Otherwise a
                        // R 500 invoice would never look "likely" against
                        // a R 1044 transaction that already has R 500
                        // attached.
                        const compareAgainst =
                          t.remainingAmount ?? t.amount;
                        const amtClose =
                          invoice.totalZAR != null &&
                          Math.abs(invoice.totalZAR - compareAgainst) /
                            Math.max(invoice.totalZAR, compareAgainst) <
                            0.05;
                        const dayMs = 24 * 60 * 60 * 1000;
                        const dateClose =
                          Math.abs(
                            new Date(t.transactionDate).getTime() -
                              new Date(invoice.invoiceDate).getTime(),
                          ) <=
                          7 * dayMs;
                        const likely = amtClose && dateClose;
                        const isPartial =
                          (t.matchedInvoices?.length ?? 0) > 0;
                        return (
                          <li key={t.id}>
                            <button
                              onClick={() => confirmManualMatch(t.id)}
                              disabled={isBusy || matchBusyId !== null}
                              className={`w-full text-left p-4 flex items-start gap-3 hover:bg-gray-50 disabled:opacity-40 ${
                                likely ? 'bg-orange-50/40' : ''
                              }`}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="font-medium truncate">
                                    {t.merchant}
                                  </p>
                                  {likely && (
                                    <span className="text-[10px] uppercase tracking-wider bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">
                                      likely
                                    </span>
                                  )}
                                  {isPartial && (
                                    <span className="text-[10px] uppercase tracking-wider bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                                      partial · {t.matchedInvoices!.length} attached
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5">
                                  {new Date(
                                    t.transactionDate,
                                  ).toLocaleDateString()}
                                  {t.cardLast4 && (
                                    <> · card …{t.cardLast4}</>
                                  )}
                                  {t.category && (
                                    <> · {t.category}</>
                                  )}
                                </p>
                                {t.description && (
                                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                                    {t.description}
                                  </p>
                                )}
                                {isPartial && (
                                  <p className="text-xs text-purple-700 mt-1">
                                    R {(t.claimedAmount ?? 0).toFixed(2)} of R{' '}
                                    {t.amount.toFixed(2)} already attached
                                    {t.matchedInvoices!.slice(0, 2).map((mi) => (
                                      <span key={mi.id}> · {mi.supplier}</span>
                                    ))}
                                  </p>
                                )}
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="font-semibold">
                                  R {t.amount.toFixed(2)}
                                </p>
                                {isPartial && (
                                  <p className="text-xs text-purple-700 mt-1">
                                    R {(t.remainingAmount ?? 0).toFixed(2)} left
                                  </p>
                                )}
                                {isBusy && (
                                  <p className="text-xs text-orange-600 mt-1">
                                    Matching...
                                  </p>
                                )}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>

              <div className="p-4 border-t border-gray-200 flex justify-between items-center flex-shrink-0">
                <p className="text-xs text-gray-500">
                  {matchCandidates.length} unmatched
                  {matchSearch.trim() && ' (filtered)'}
                </p>
                <button
                  onClick={() => setMatchOpen(false)}
                  disabled={matchBusyId !== null}
                  className="px-4 py-2 text-sm rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

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
