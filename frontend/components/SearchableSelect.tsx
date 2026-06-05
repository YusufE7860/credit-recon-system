'use client';

import { useEffect, useRef, useState } from 'react';

// A type-to-filter dropdown. Replaces native <select> when the list of
// options is long enough that scrolling is annoying (categories, stores).
// Click the field → input + filtered popup appears. Click an option →
// selects + closes. Click outside → closes without changing the value.
//
// Behaviourally identical to <select> from the parent's perspective —
// just pass `value` + `onChange` and a flat list of options.

export type Option = {
  value: string;
  label: string;
};

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  // When true, shows a "— Clear —" option at the top of the dropdown.
  // Useful when the field is optional and the user wants to unset it
  // after picking something.
  allowClear?: boolean;
  // Visual size override. "sm" for tight inline cells (per-item
  // dropdowns inside the upload queue), default for the batch-default
  // cards at the top of the page.
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = '— Select —',
  allowClear = false,
  size = 'md',
  disabled = false,
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close the dropdown when clicking anywhere outside it. The mouseup
  // listener is on document so it catches clicks on any other widget,
  // not just within this component's parent.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Auto-focus the search input when the dropdown opens. Otherwise the
  // user has to click it manually which defeats the purpose.
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Filter the options. Case-insensitive substring on `label`.
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  // The currently-selected label, for display when the popup is closed.
  const selectedLabel =
    options.find((o) => o.value === value)?.label ?? '';

  // Tailwind size tokens — kept compact so the per-item dropdowns
  // inside the upload queue stay one-row-high.
  const heightClass = size === 'sm' ? 'py-1.5 text-sm' : 'py-2';

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      {/* Closed state: looks like a normal select trigger */}
      {!open && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className={`w-full text-left border border-gray-300 rounded-lg px-3 ${heightClass} bg-white hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed flex items-center justify-between gap-2`}
        >
          <span className={selectedLabel ? '' : 'text-gray-400'}>
            {selectedLabel || placeholder}
          </span>
          <span className="text-gray-400 text-xs">▾</span>
        </button>
      )}

      {/* Open state: input + filtered list */}
      {open && (
        <div className="border border-orange-500 rounded-lg bg-white shadow-lg">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false);
                setQuery('');
              } else if (e.key === 'Enter' && filtered.length > 0) {
                onChange(filtered[0].value);
                setOpen(false);
                setQuery('');
              }
            }}
            placeholder="Type to filter..."
            className={`w-full px-3 ${heightClass} rounded-t-lg focus:outline-none border-b border-gray-200`}
          />
          <ul className="max-h-64 overflow-y-auto">
            {allowClear && value && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onChange('');
                    setOpen(false);
                    setQuery('');
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-500 italic hover:bg-gray-50"
                >
                  — Clear selection —
                </button>
              </li>
            )}
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-400 italic">
                No matches for "{query}"
              </li>
            ) : (
              filtered.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                      setQuery('');
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-orange-50 ${
                      o.value === value
                        ? 'bg-orange-100 font-medium'
                        : ''
                    }`}
                  >
                    {o.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
