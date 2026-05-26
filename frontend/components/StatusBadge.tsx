// Small colored pill that visualizes an invoice's reconciliation status.
// Used in the list and detail pages.

const STATUS_STYLES: Record<string, string> = {
  PENDING:   'bg-yellow-100 text-yellow-800 ring-yellow-300/60',
  MATCHED:   'bg-green-100 text-green-800 ring-green-300/60',
  UNMATCHED: 'bg-red-100 text-red-800 ring-red-300/60',
  DISPUTED:  'bg-orange-100 text-orange-800 ring-orange-300/60',
  REJECTED:  'bg-gray-200 text-gray-700 ring-gray-300/60',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-800 ring-gray-300';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {status}
    </span>
  );
}
