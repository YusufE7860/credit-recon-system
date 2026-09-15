import type { ReactNode } from 'react';

// Friendly zero-state block. Every list / table should render one of
// these when it has no rows, instead of the old bare "No data" text.
// A single ReactNode `action` slot lets the caller drop in a Button
// or ButtonLink so users have a next step.

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center text-center py-10 px-4 ${className}`}
    >
      {icon && (
        <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center text-fg-muted mb-3">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {description && (
        <p className="text-sm text-fg-muted mt-1 max-w-sm">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
