// Skeleton loaders. Use in place of "Loading..." text to give users
// a hint of the layout they're about to see. Backed by the
// .skeleton class in globals.css (shimmer keyframe).

export function Skeleton({
  className = '',
  width,
  height,
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
}) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height ?? '1em',
      }}
    />
  );
}

/** Pre-baked shapes for common cases. */
export function SkeletonText({
  lines = 3,
  className = '',
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={12}
          width={i === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div
      className={`bg-surface border border-border rounded-2xl p-4 shadow-sm ${className}`}
    >
      <Skeleton width={90} height={10} className="mb-3" />
      <Skeleton width={140} height={28} className="mb-2" />
      <Skeleton width="70%" height={10} />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 py-2">
      <Skeleton width={80} height={12} />
      <Skeleton width={200} height={12} className="flex-1" />
      <Skeleton width={80} height={12} />
    </div>
  );
}
