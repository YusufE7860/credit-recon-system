'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { SearchableSelect } from '@/components/SearchableSelect';
import { api, apiUpload, ApiError } from '@/lib/api';
import { useCurrentUser, isPrivileged } from '@/lib/user-context';

type StoreOption = { id: string; name: string };
type CategoryOption = { id: string; name: string };

type UploadKind = 'invoice' | 'statement';

// Status of one file in the upload queue.
type QueueItemStatus = 'pending' | 'uploading' | 'success' | 'error';

interface QueueItem {
  id: string;          // local-only uuid
  file: File;
  previewUrl: string;  // blob URL for thumbnail
  status: QueueItemStatus;
  error?: string;
  resultId?: string;   // backend invoice id after success
  resultSupplier?: string;
  // Per-file reason — what the transaction was for. Flows through to
  // invoice.notes and lands in the FULL DESCRIPTION column on the
  // recon XLSX. Required before upload.
  reason: string;
  // Per-file category + store. Initialised from the batch defaults
  // when the file is added to the queue, but the user can change them
  // inline before clicking Upload (handy when one invoice in a batch
  // of 10 belongs to a different cost centre). Empty string falls back
  // to the batch default at upload time.
  category: string;
  storeAllocation: string;
  // Optional per-invoice line splits — when the receipt covers spend
  // across multiple stores or categories. When `splits` is non-empty,
  // the single category/store fields above are ignored at upload time
  // and the breakdown is applied after OCR runs. Sum should match the
  // OCR'd total; if it doesn't, the invoice gets flagged for review.
  splits: Array<{ category: string; store: string; amount: number }>;
}

// `crypto.randomUUID()` only exists in *secure contexts* (HTTPS or
// `localhost`). On plain HTTP via raw IP — which is exactly the
// IP-only test deployment — the browser doesn't expose it and calling
// it throws TypeError. That kills addFilesToQueue silently, which
// looks like "the upload doesn't work".
//
// This helper tries the native method first (so production HTTPS gets
// proper UUIDs), then a crypto.getRandomValues-based UUID v4 fallback
// (works in non-secure contexts on all modern browsers), then a
// Math.random fallback as the absolute last resort. The ID is only
// used as a React key for the queue row — uniqueness within the
// session is all that matters, not cryptographic strength.
function makeQueueId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      // RFC 4122 v4: 16 random bytes, set version + variant nibbles.
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    /* fall through */
  }
  // Last resort — not RFC-compliant but unique enough for a queue key.
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function UploadPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const canUploadStatements = isPrivileged(user?.role);
  const isUploader = user?.role === 'UPLOADER';
  const [kind, setKind] = useState<UploadKind>('invoice');

  // UPLOADER-only: who they're uploading FOR right now. Required
  // before any upload because the backend rejects an UPLOADER post
  // without a valid managed-user ownerId.
  const [uploadOwnerId, setUploadOwnerId] = useState<string>('');

  // The list of users this UPLOADER is allowed to upload for, with
  // their names so the dropdown shows something meaningful. Loaded
  // once on mount.
  const [managedUsers, setManagedUsers] = useState<
    { id: string; name: string; email: string }[]
  >([]);
  useEffect(() => {
    if (!isUploader || !user?.managedUserIds?.length) return;
    // Fetch every user this assistant manages by id. We call /users
    // and filter client-side — endpoint already strips password hashes,
    // and the list is tiny (usually 1–3 cardholders per assistant).
    api<{ id: string; name: string; email: string }[]>('/users')
      .then((all) => {
        const filtered = all.filter((u) =>
          user.managedUserIds.includes(u.id),
        );
        setManagedUsers(filtered);
        // If they manage exactly one user, pre-select to skip a click.
        if (filtered.length === 1) {
          setUploadOwnerId(filtered[0].id);
        }
      })
      .catch(() => setManagedUsers([]));
  }, [isUploader, user?.managedUserIds]);

  // If a USER somehow landed on statement mode (via a stale state, e.g.
  // after being demoted), force them back to invoice mode.
  useEffect(() => {
    if (!canUploadStatements && kind === 'statement') {
      setKind('invoice');
    }
  }, [canUploadStatements, kind]);

  // Invoice mode: a queue of files (camera + picker can both add to it)
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Shared metadata applied to every file in the queue as a DEFAULT.
  // Each QueueItem also carries its own category/store that start from
  // these values but can be overridden inline before upload (handy when
  // a batch mostly shares a category but has one or two odd files).
  // Currency is dropped entirely — AI OCR auto-detects and the user
  // can correct on the invoice detail page if it picks the wrong one.
  const [batchCategory, setBatchCategory] = useState<string>('');
  const [batchStore, setBatchStore] = useState<string>('');

  // Every transaction in the master sheet has a department, regardless
  // of category. Keeping the dropdown always visible matches that flow.
  const requiresStore = true;

  // Active store list — loaded once and used for the store dropdown.
  const [stores, setStores] = useState<StoreOption[]>([]);
  // Active category list — admin-managed now (was hardcoded). Loaded
  // once at mount; falls back to an empty dropdown on fetch failure
  // rather than blocking the page.
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  useEffect(() => {
    api<StoreOption[]>('/stores')
      .then(setStores)
      .catch(() => setStores([])); // silent: dropdown just stays empty
    api<CategoryOption[]>('/categories')
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  // Statement mode: single file (it's a single CSV/PDF for the whole company)
  const [statementFile, setStatementFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Statement metadata.
  // cardLast4 was removed — PDF statements (FNB-style) auto-detect cards
  // per-section, and CSV statements rarely need a single card label.
  const [statementMeta, setStatementMeta] = useState({
    statementName: '',
    bankName: '',
    periodStart: '',
    periodEnd: '',
  });

  // Hidden file inputs we trigger programmatically so we can show
  // pretty branded buttons instead of the browser default.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  function addFilesToQueue(files: FileList | null) {
    if (!files || files.length === 0) {
      // iOS PWA mode occasionally fires `change` with no files attached
      // — surface a hint rather than silently doing nothing.
      setError(
        'No file was captured. If this keeps happening, try the gallery picker instead.',
      );
      return;
    }
    // Snapshot the current batch defaults into each new item so later
    // changes to the top-of-page dropdowns don't retroactively rewrite
    // earlier files in the queue. Items added with no default selected
    // keep empty strings (resolved as "leave blank" at upload time).
    const newItems: QueueItem[] = [];
    for (const f of Array.from(files)) {
      try {
        newItems.push({
          id: makeQueueId(),
          file: f,
          previewUrl: URL.createObjectURL(f),
          status: 'pending',
          reason: '',
          category: batchCategory,
          storeAllocation: batchStore,
          splits: [], // empty by default; user can open the split editor
        });
      } catch (err) {
        // URL.createObjectURL can throw in some sandboxed contexts.
        // Keep the file but skip the preview — upload still works.
        console.error('Failed to create preview URL:', err);
        newItems.push({
          id: makeQueueId(),
          file: f,
          previewUrl: '',
          status: 'pending',
          reason: '',
          category: batchCategory,
          storeAllocation: batchStore,
          splits: [],
        });
      }
    }
    if (newItems.length > 0) {
      setQueue((q) => [...q, ...newItems]);
      setError('');
    }
  }

  function removeFromQueue(id: string) {
    setQueue((q) => {
      const item = q.find((i) => i.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return q.filter((i) => i.id !== id);
    });
  }

  function clearQueue() {
    queue.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    setQueue([]);
    setError('');
    setSuccessMsg('');
  }

  async function uploadQueue() {
    // Reason is mandatory — accountants need it for the recon sheet's
    // FULL DESCRIPTION column. Block here so users can't silently ship
    // empty descriptions and have to chase them up later.
    const missingReason = queue.filter(
      (i) => i.status !== 'success' && !i.reason.trim(),
    );
    if (missingReason.length > 0) {
      setError(
        `Please type a reason for ${missingReason.length} file${
          missingReason.length === 1 ? '' : 's'
        } before uploading — what was the transaction for?`,
      );
      return;
    }

    // UPLOADERs MUST tell us which cardholder this upload is for —
    // the invoice gets attached to that user's account, not the
    // assistant's. Block client-side so we don't burn an upload only
    // to have the backend reject it.
    if (isUploader && !uploadOwnerId) {
      setError(
        'Pick the cardholder you are uploading for before submitting.',
      );
      return;
    }

    // Category + Store are mandatory so the recon report has somewhere
    // to assign each transaction. A blank category lands the invoice in
    // "Uncategorized" on the dashboard and as "—" on the XLSX, which
    // forces the accountant to fix it row by row.
    //
    // Two ways to satisfy the requirement:
    //   - Set BOTH the per-item Category and Store (or rely on batch
    //     defaults), OR
    //   - Add splits — each split provides its own category + store.
    const pending = queue.filter((i) => i.status !== 'success');
    for (const item of pending) {
      const hasSplits = item.splits.length > 0;
      if (hasSplits) {
        // Splits must be fully filled in (category required per split).
        const bad = item.splits.find(
          (s) => !s.category.trim() || !s.store.trim(),
        );
        if (bad) {
          setError(
            `Every split line on "${item.file.name}" needs both a Category and a Store.`,
          );
          return;
        }
        continue;
      }
      const effectiveCategory = (item.category || batchCategory).trim();
      const effectiveStore = (item.storeAllocation || batchStore).trim();
      if (!effectiveCategory || !effectiveStore) {
        setError(
          `"${item.file.name}" needs a Category and a Store. Pick a default at the top, set them per-item, or split into lines.`,
        );
        return;
      }
    }

    setBusy(true);
    setError('');
    setSuccessMsg('');

    let successCount = 0;
    let failCount = 0;

    // Sequential upload so the user sees clear progress (and so we don't
    // hammer the OCR pipeline with 10 simultaneous requests).
    for (const item of queue) {
      if (item.status === 'success') continue;

      // Mark as uploading.
      setQueue((q) =>
        q.map((i) =>
          i.id === item.id ? { ...i, status: 'uploading', error: undefined } : i,
        ),
      );

      try {
        const fd = new FormData();
        fd.append('file', item.file);
        // Per-item Reason → lands on invoice.notes, then surfaces in
        // the FULL DESCRIPTION column on the recon XLSX.
        if (item.reason.trim()) {
          fd.append('notes', item.reason.trim());
        }
        // Per-item category/store: each QueueItem stores its own copy
        // (initialised from the batch default) so the user can override
        // a single odd file without touching the rest of the queue.
        // Empty string means "leave blank / let OCR auto-fill".
        const effectiveCategory = item.category || batchCategory;
        const effectiveStore = item.storeAllocation || batchStore;
        if (effectiveCategory) fd.append('category', effectiveCategory);
        if (requiresStore && effectiveStore) {
          fd.append('storeAllocation', effectiveStore);
        }
        // UPLOADER-only: tell the backend whose invoice this is. The
        // backend validates ownerId is in this UPLOADER's managedUserIds.
        if (isUploader && uploadOwnerId) {
          fd.append('ownerId', uploadOwnerId);
        }
        // Line splits — multi-category/store breakdown entered by the
        // user before upload. Backend validates the sum against the
        // OCR'd total post-create and flags for review if it doesn't
        // match. Sent as JSON since FormData can't transport arrays.
        if (item.splits.length > 0) {
          const clean = item.splits
            .filter((s) => s.category.trim() && s.amount > 0)
            .map((s) => ({
              category: s.category.trim(),
              store: s.store.trim() || null,
              amount: s.amount,
            }));
          if (clean.length > 0) {
            fd.append('splits', JSON.stringify(clean));
          }
        }
        const result = await apiUpload<{
          id: string;
          supplier: string;
        }>('/invoices/upload', fd);

        setQueue((q) =>
          q.map((i) =>
            i.id === item.id
              ? {
                  ...i,
                  status: 'success',
                  resultId: result.id,
                  resultSupplier: result.supplier,
                }
              : i,
          ),
        );
        successCount++;
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : 'Upload failed';
        setQueue((q) =>
          q.map((i) =>
            i.id === item.id ? { ...i, status: 'error', error: msg } : i,
          ),
        );
        failCount++;
      }
    }

    setBusy(false);

    if (failCount === 0) {
      setSuccessMsg(`${successCount} invoice${successCount === 1 ? '' : 's'} uploaded and scanned.`);
    } else {
      setError(
        `${successCount} succeeded, ${failCount} failed. See each item below for details.`,
      );
    }
  }

  async function uploadStatement() {
    if (!statementFile) {
      setError('Pick a file first');
      return;
    }
    setBusy(true);
    setError('');
    setSuccessMsg('');
    const fd = new FormData();
    fd.append('file', statementFile);
    for (const [k, v] of Object.entries(statementMeta)) {
      if (v) fd.append(k, v);
    }
    try {
      const result = await apiUpload<{
        importedCount: number;
        skippedCount: number;
      }>('/statements/upload', fd);
      setSuccessMsg(
        `Statement uploaded — imported ${result.importedCount} transactions, skipped ${result.skippedCount}.`,
      );
      setStatementFile(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  // ---------- Render ----------

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8 max-w-3xl">
        <h1 className="text-3xl font-bold mb-2">Upload</h1>
        <p className="text-gray-600 mb-6">
          Capture invoice photos with your phone camera, pick multiple
          files from your device, or upload a bank statement.
        </p>

        {/* Mode toggle — Bank Statement button is hidden for plain USERs.
            With only Invoices visible the toggle is decorative, but we
            keep it so the page layout stays consistent across roles. */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setKind('invoice')}
            className={`px-4 py-2 rounded-lg font-medium transition ${
              kind === 'invoice'
                ? 'bg-black text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
            }`}
          >
            Invoices
          </button>
          {canUploadStatements && (
            <button
              onClick={() => setKind('statement')}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                kind === 'statement'
                  ? 'bg-black text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
              }`}
            >
              Bank Statement
            </button>
          )}
        </div>

        {/* ============================================== */}
        {/* INVOICE MODE — camera + multi-file + queue UI  */}
        {/* ============================================== */}
        {kind === 'invoice' && (
          <>
            {/* UPLOADER-only: which cardholder are we uploading for?
                Required before anything else — invoices get attached
                to the chosen user's account, not the assistant's. */}
            {isUploader && (
              <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-4">
                <label className="block text-xs font-medium text-orange-900 uppercase tracking-wider mb-2">
                  Uploading on behalf of *
                </label>
                {managedUsers.length === 0 ? (
                  <p className="text-sm text-orange-800">
                    You aren&apos;t linked to any cardholders yet. Ask an
                    admin to assign you under Admin → Users.
                  </p>
                ) : (
                  <select
                    value={uploadOwnerId}
                    onChange={(e) => setUploadOwnerId(e.target.value)}
                    className="w-full border border-orange-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="">— Select cardholder —</option>
                    {managedUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-orange-800 mt-2">
                  Invoices you upload will appear on this cardholder&apos;s
                  account. You will only see invoices you uploaded yourself.
                </p>
              </div>
            )}

            {/* Batch defaults — applied to NEW files added to the
                queue. Each queued file gets its own category/store
                inputs below that can override these. Changing these
                values doesn't retroactively rewrite earlier files. */}
            <div className="bg-white rounded-xl shadow p-4 mb-4 space-y-3">
              <p className="text-[11px] text-gray-500 uppercase tracking-wider">
                Defaults for new files — override per invoice in the queue below
              </p>
              <p className="text-xs text-gray-600">
                <span className="text-red-600 font-medium">Required</span>{' '}
                — every invoice needs a category and store before upload
                (set defaults here, or per-item, or via line splits).
              </p>
              {/* Category */}
              <div>
                <label className="block text-xs font-medium text-gray-600 uppercase tracking-wider mb-2">
                  Default category <span className="text-red-600">*</span>
                </label>
                <SearchableSelect
                  value={batchCategory}
                  onChange={setBatchCategory}
                  options={categories.map((c) => ({
                    value: c.name,
                    label: c.name,
                  }))}
                  placeholder="— Select category —"
                  allowClear
                />

                {categories.length === 0 && (
                  <p className="text-xs text-orange-600 mt-1">
                    No active categories yet. An admin can add them under Admin → Categories.
                  </p>
                )}
              </div>

              {/* Store / Department — which cost centre this charge
                  is allocated to. Always visible because every transaction
                  needs an owning department per the master sheet. */}
              {requiresStore && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 uppercase tracking-wider mb-2">
                    Default store / department <span className="text-red-600">*</span>
                  </label>
                  <SearchableSelect
                    value={batchStore}
                    onChange={setBatchStore}
                    options={stores.map((s) => ({
                      value: s.name,
                      label: s.name,
                    }))}
                    placeholder="— Select store —"
                    allowClear
                  />

                  {stores.length === 0 && (
                    <p className="text-xs text-orange-600 mt-1">
                      No active stores yet. An admin can add them under Admin → Stores.
                    </p>
                  )}
                </div>
              )}

              {/* Currency dropdown removed — AI OCR auto-detects the
                  currency from the invoice. If it picks the wrong one,
                  the user can override on the invoice detail page. */}
            </div>

            <div className="bg-white rounded-xl shadow p-6 mb-6">
              <div className="grid grid-cols-2 gap-3">
                {/* Camera capture — opens the phone's back camera */}
                <button
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex flex-col items-center justify-center bg-black text-white rounded-xl p-6 hover:opacity-90 transition"
                >
                  <CameraIcon />
                  <span className="mt-2 font-medium">Take photo</span>
                  <span className="text-xs text-gray-400 mt-1">
                    Opens camera on mobile
                  </span>
                </button>

                {/* Multi-file picker — gallery or files */}
                <button
                  onClick={() => galleryInputRef.current?.click()}
                  className="flex flex-col items-center justify-center bg-white text-black border-2 border-dashed border-gray-300 rounded-xl p-6 hover:border-orange-500 transition"
                >
                  <FolderIcon />
                  <span className="mt-2 font-medium">Pick files</span>
                  <span className="text-xs text-gray-500 mt-1">
                    Select one or many
                  </span>
                </button>
              </div>

              {/* Hidden inputs — triggered by the buttons above.
                  HEIC/HEIF added explicitly because iPhones default to
                  those formats and a bare `image/*` filter on some
                  iOS versions silently rejects them. */}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*,image/heic,image/heif"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  addFilesToQueue(e.target.files);
                  // Reset so the same photo can be retaken if needed.
                  e.target.value = '';
                }}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*,image/heic,image/heif,application/pdf"
                multiple
                className="hidden"
                onChange={(e) => {
                  addFilesToQueue(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            {/* Queue */}
            {queue.length > 0 && (
              <div className="bg-white rounded-xl shadow p-6 mb-6">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                    {queue.length} file{queue.length === 1 ? '' : 's'} in queue
                  </h2>
                  <button
                    onClick={clearQueue}
                    disabled={busy}
                    className="text-sm text-gray-600 hover:text-black"
                  >
                    Clear
                  </button>
                </div>

                <ul className="space-y-3">
                  {queue.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg border border-gray-200"
                    >
                      {/* Thumbnail. HEIC images can't be rendered by
                          browsers, so we onError-fallback to a small
                          placeholder rather than showing a broken
                          (invisible) image element. Smaller on mobile
                          so the form area gets more horizontal room. */}
                      {item.file.type.startsWith('image/') && item.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.previewUrl}
                          alt=""
                          className="w-10 h-10 sm:w-14 sm:h-14 flex-shrink-0 object-cover rounded bg-gray-100"
                          onError={(e) => {
                            // Hide the broken image and reveal the
                            // sibling placeholder underneath.
                            const el = e.currentTarget;
                            el.style.display = 'none';
                            const next = el.nextElementSibling as HTMLElement | null;
                            if (next) next.style.display = 'flex';
                          }}
                        />
                      ) : null}
                      {/* Placeholder — shown when the file is non-image
                          (PDF), when no preview URL exists, or when the
                          img above failed to load (HEIC etc). */}
                      <div
                        className="w-10 h-10 sm:w-14 sm:h-14 flex-shrink-0 bg-gray-100 rounded items-center justify-center text-[10px] text-gray-500 uppercase tracking-wider"
                        style={{
                          display:
                            item.file.type.startsWith('image/') && item.previewUrl
                              ? 'none'
                              : 'flex',
                        }}
                      >
                        {item.file.type === 'application/pdf'
                          ? 'PDF'
                          : item.file.type.includes('heic') ||
                              item.file.type.includes('heif')
                            ? 'HEIC'
                            : 'IMG'}
                      </div>

                      {/* Name + reason input + status */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {item.file.name}
                        </p>
                        <p className="text-xs text-gray-500">
                          {(item.file.size / 1024).toFixed(1)} KB
                        </p>

                        {/* Reason input — required pre-upload, locked
                            after upload completes. Shown inline so the
                            user types the "why" before triggering OCR. */}
                        {item.status !== 'success' ? (
                          <input
                            type="text"
                            value={item.reason}
                            onChange={(e) =>
                              setQueue((q) =>
                                q.map((i) =>
                                  i.id === item.id
                                    ? { ...i, reason: e.target.value }
                                    : i,
                                ),
                              )
                            }
                            disabled={item.status === 'uploading' || busy}
                            placeholder="Reason — what was the transaction for? (required)"
                            className="mt-1.5 w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
                          />
                        ) : (
                          <p className="text-xs text-gray-600 mt-1 italic">
                            Reason: {item.reason || '—'}
                          </p>
                        )}

                        {/* Per-item Category + Store. Starts from the
                            batch defaults but the user can override
                            either one for this single file. Hidden after
                            successful upload to keep the success row clean. */}
                        {item.status !== 'success' && (
                          <div className="grid grid-cols-2 gap-2 mt-1.5">
                            <SearchableSelect
                              value={item.category}
                              onChange={(v) =>
                                setQueue((q) =>
                                  q.map((i) =>
                                    i.id === item.id
                                      ? { ...i, category: v }
                                      : i,
                                  ),
                                )
                              }
                              options={categories.map((c) => ({
                                value: c.name,
                                label: c.name,
                              }))}
                              placeholder={
                                batchCategory
                                  ? `Category: ${batchCategory} (default)`
                                  : '— Category —'
                              }
                              disabled={item.status === 'uploading' || busy}
                              size="sm"
                              allowClear
                            />
                            <SearchableSelect
                              value={item.storeAllocation}
                              onChange={(v) =>
                                setQueue((q) =>
                                  q.map((i) =>
                                    i.id === item.id
                                      ? { ...i, storeAllocation: v }
                                      : i,
                                  ),
                                )
                              }
                              options={stores.map((s) => ({
                                value: s.name,
                                label: s.name,
                              }))}
                              placeholder={
                                batchStore
                                  ? `Store: ${batchStore} (default)`
                                  : '— Store —'
                              }
                              disabled={item.status === 'uploading' || busy}
                              size="sm"
                              allowClear
                            />
                          </div>
                        )}

                        {/* Line splits — when this invoice covers
                            multiple stores/categories. Only shown
                            before upload (success rows stay clean).
                            Sum doesn't have to match anything client-
                            side: backend compares against the OCR'd
                            total and flags for review if off. */}
                        {item.status !== 'success' && (
                          <QueueItemSplitEditor
                            item={item}
                            categories={categories}
                            stores={stores}
                            disabled={item.status === 'uploading' || busy}
                            onChange={(splits) =>
                              setQueue((q) =>
                                q.map((i) =>
                                  i.id === item.id ? { ...i, splits } : i,
                                ),
                              )
                            }
                          />
                        )}

                        <QueueItemStatusLine item={item} />
                      </div>

                      {/* Remove button (hidden while uploading) */}
                      {item.status !== 'uploading' && (
                        <button
                          onClick={() => removeFromQueue(item.id)}
                          disabled={busy}
                          className="text-gray-400 hover:text-red-600 px-2"
                          aria-label="Remove"
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={uploadQueue}
                  disabled={
                    busy ||
                    queue.every((i) => i.status === 'success') ||
                    (isUploader && !uploadOwnerId)
                  }
                  className="w-full bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600 disabled:opacity-40 transition mt-5"
                >
                  {busy
                    ? `Uploading... ${queue.filter((i) => i.status === 'success').length}/${queue.length}`
                    : queue.every((i) => i.status === 'success')
                    ? 'All uploaded'
                    : isUploader && !uploadOwnerId
                    ? 'Select a cardholder first'
                    : `Upload all (${queue.filter((i) => i.status !== 'success').length})`}
                </button>
              </div>
            )}

            {error && (
              <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
                {error}
              </p>
            )}
            {successMsg && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                <p className="text-sm text-green-800">{successMsg}</p>
                <Link
                  href="/invoices"
                  className="text-sm text-green-900 underline mt-2 inline-block"
                >
                  Open invoices →
                </Link>
              </div>
            )}

            <p className="text-xs text-gray-600 mt-2">
              OCR runs automatically on each upload — supplier, total,
              VAT, and date are extracted. 5–30s per invoice.
            </p>
          </>
        )}

        {/* ============================================== */}
        {/* STATEMENT MODE — single CSV/PDF                 */}
        {/* ============================================== */}
        {kind === 'statement' && (
          <div className="bg-white rounded-xl shadow p-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                CSV or PDF file
              </label>
              <input
                type="file"
                accept=".csv,text/csv,application/pdf"
                onChange={(e) => setStatementFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-gray-700
                  file:mr-4 file:py-2 file:px-4 file:rounded-lg
                  file:border-0 file:font-medium
                  file:bg-black file:text-white
                  hover:file:opacity-90 file:cursor-pointer"
              />
              {statementFile && (
                <p className="mt-2 text-sm text-gray-600">
                  Selected: {statementFile.name} (
                  {(statementFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>

            {/* All previous manual fields (name / bank / period start /
                period end) are now auto-detected on the backend:
                  - name → cleaned-up filename
                  - period → min/max transaction date (CSV) or PDF header
                  - cards → routed by last-4 in each section
                We surface that here so the user knows what will happen. */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
              <p className="font-medium">Auto-detected on upload</p>
              <ul className="mt-1 space-y-0.5 text-xs text-blue-800">
                <li>
                  <strong>Name</strong> — from the filename
                  {statementFile?.name && (
                    <>
                      {' '}
                      (
                      <span className="font-mono">
                        {statementFile.name.replace(/\.[A-Za-z0-9]+$/, '')}
                      </span>
                      )
                    </>
                  )}
                </li>
                <li>
                  <strong>Period</strong> — pulled from the PDF header or
                  the earliest/latest transaction in the CSV
                </li>
                <li>
                  <strong>Cards</strong> — routed automatically by the
                  last 4 digits in each section
                </li>
              </ul>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 p-3 rounded">
                {error}
              </p>
            )}
            {successMsg && (
              <p className="text-sm text-green-700 bg-green-50 p-3 rounded">
                {successMsg}
              </p>
            )}

            <button
              onClick={uploadStatement}
              disabled={busy || !statementFile}
              className="w-full bg-black text-white py-3 rounded-lg font-medium hover:opacity-90 disabled:opacity-40 transition"
            >
              {busy ? 'Uploading...' : 'Upload statement'}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

// ---------- Sub-components ----------

function QueueItemStatusLine({ item }: { item: QueueItem }) {
  switch (item.status) {
    case 'pending':
      return <p className="text-xs text-gray-500 mt-1">Ready to upload</p>;
    case 'uploading':
      return (
        <p className="text-xs text-orange-600 mt-1 font-medium">
          Uploading + running OCR...
        </p>
      );
    case 'success':
      return (
        <p className="text-xs text-green-700 mt-1">
          ✓ Imported as <strong>{item.resultSupplier}</strong>
          {item.resultId && (
            <>
              {' · '}
              <Link
                href={`/invoices/${item.resultId}`}
                className="underline hover:no-underline"
              >
                view
              </Link>
            </>
          )}
        </p>
      );
    case 'error':
      return (
        <p className="text-xs text-red-600 mt-1">✗ {item.error}</p>
      );
  }
}

// Inline split editor — collapsed by default ("+ Split into multiple
// stores" link), expands to a small table where the user enters
// category/store/amount per line. Splits are stored on the queue item
// and sent in the upload's FormData. Backend validates the sum against
// the OCR'd total post-upload (we don't know the total client-side so
// we can't validate strictly here; we just show the running sum as a
// hint).
function QueueItemSplitEditor({
  item,
  categories,
  stores,
  disabled,
  onChange,
}: {
  item: QueueItem;
  categories: CategoryOption[];
  stores: StoreOption[];
  disabled: boolean;
  onChange: (splits: QueueItem['splits']) => void;
}) {
  const [open, setOpen] = useState(item.splits.length > 0);
  const splits = item.splits;

  function addRow() {
    onChange([...splits, { category: '', store: '', amount: 0 }]);
  }
  function updateRow(idx: number, patch: Partial<QueueItem['splits'][0]>) {
    onChange(splits.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function removeRow(idx: number) {
    onChange(splits.filter((_, i) => i !== idx));
  }

  if (!open && splits.length === 0) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (splits.length === 0) addRow();
        }}
        disabled={disabled}
        className="text-xs text-blue-600 hover:underline mt-1.5 disabled:opacity-40"
      >
        + Split into multiple stores or categories
      </button>
    );
  }

  const sum = splits.reduce((acc, s) => acc + (s.amount || 0), 0);

  return (
    <div className="mt-2 p-2.5 bg-blue-50/60 rounded border border-blue-200">
      <div className="flex justify-between items-center mb-2">
        <p className="text-xs font-medium text-blue-900">
          Line splits ({splits.length})
        </p>
        <button
          type="button"
          onClick={() => {
            onChange([]);
            setOpen(false);
          }}
          disabled={disabled}
          className="text-xs text-red-600 hover:underline"
        >
          Clear splits
        </button>
      </div>

      {/* Stacked-card layout. Each row is its own white card with the
          Category and Store dropdowns stacked vertically on phones (full
          width = touch-friendly), then a horizontal row for Amount + ×
          at the bottom. Way easier to fill in on a phone than a
          three-column table. */}
      <div className="space-y-2">
        {splits.map((s, idx) => (
          <div
            key={idx}
            className="bg-white border border-blue-200 rounded p-2 space-y-1.5"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                Line {idx + 1}
              </span>
              <button
                type="button"
                onClick={() => removeRow(idx)}
                disabled={disabled}
                className="text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                title="Remove line"
                aria-label="Remove line"
              >
                ×
              </button>
            </div>
            <select
              value={s.category}
              onChange={(e) => updateRow(idx, { category: e.target.value })}
              disabled={disabled}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            >
              <option value="">— Category —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={s.store}
              onChange={(e) => updateRow(idx, { store: e.target.value })}
              disabled={disabled}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            >
              <option value="">— Store —</option>
              {stores.map((st) => (
                <option key={st.id} value={st.name}>
                  {st.name}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Amount</span>
              <span className="text-xs text-gray-400">R</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={s.amount}
                onChange={(e) =>
                  updateRow(idx, {
                    amount: parseFloat(e.target.value) || 0,
                  })
                }
                disabled={disabled}
                className="flex-1 text-right border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
                placeholder="0.00"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Add-line + sum hint stacked on mobile (each on its own line),
          inline on sm+ where there's room. Putting the sum on a
          separate line avoids the wrap-into-link mess we had before. */}
      <div className="mt-2.5 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1.5">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="text-xs text-blue-700 hover:underline font-medium text-left"
        >
          + Add another line
        </button>
        <p className="text-xs text-blue-900">
          Sum:{' '}
          <span className="font-semibold">R {sum.toFixed(2)}</span>
          <span className="text-gray-500">
            {' '}— must match invoice total
          </span>
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2
          focus:outline-none focus:ring-2 focus:ring-orange-500"
      />
    </div>
  );
}

// Inline SVG icons so we don't pull in an icon library.
function CameraIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
