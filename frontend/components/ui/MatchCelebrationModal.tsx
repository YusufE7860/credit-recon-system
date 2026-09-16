'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import Confetti from './Confetti';

// Full-screen celebration overlay for a successful invoice ↔ transaction
// match. Includes confetti, a big happy headline and the matched-to
// transaction details, plus quick actions. Auto-closes when the user
// clicks the backdrop, presses Escape, or clicks Close.

export interface MatchedTransaction {
  id: string;
  merchant: string;
  amount: number;
  transactionDate: string;
  cardLast4: string | null;
}

interface MatchCelebrationModalProps {
  open: boolean;
  supplier: string;
  invoiceId?: string;
  transaction?: MatchedTransaction | null;
  onClose(): void;
}

export default function MatchCelebrationModal({
  open,
  supplier,
  invoiceId,
  transaction,
  onClose,
}: MatchCelebrationModalProps) {
  // Escape-to-close. Only active while open so we don't leak listeners.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <Confetti run={open} pieces={180} />
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        onClick={onClose}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

        {/* Card */}
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="match-celebration-title"
          className="relative bg-surface border border-border rounded-3xl shadow-2xl w-full max-w-md p-6 text-center animate-[matchpop_260ms_cubic-bezier(0.34,1.56,0.64,1)_both]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Sparkle badge */}
          <div className="mx-auto w-16 h-16 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center shadow-lg">
            <svg
              width="34"
              height="34"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <h2
            id="match-celebration-title"
            className="mt-4 text-2xl font-bold text-fg"
          >
            Matched! 🎉
          </h2>
          <p className="text-sm text-fg-muted mt-1">
            Your receipt from <strong>{supplier}</strong> was auto-linked to a
            statement transaction.
          </p>

          {transaction && (
            <div className="mt-5 mx-auto max-w-xs rounded-2xl border border-border bg-surface-2 p-4 text-left">
              <p className="text-[10px] uppercase tracking-widest text-fg-muted">
                Linked to
              </p>
              <p className="mt-1 font-semibold text-fg truncate">
                {transaction.merchant}
              </p>
              <div className="mt-2 flex items-baseline justify-between text-sm">
                <span className="text-fg-muted">
                  {new Date(transaction.transactionDate).toLocaleDateString(
                    'en-ZA',
                    { day: '2-digit', month: 'short', year: 'numeric' },
                  )}
                </span>
                <span className="font-semibold text-fg tabular-nums">
                  R {transaction.amount.toFixed(2)}
                </span>
              </div>
              {transaction.cardLast4 && (
                <p className="text-xs text-fg-subtle mt-1">
                  Card …{transaction.cardLast4}
                </p>
              )}
            </div>
          )}

          <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
            {invoiceId && (
              <Link
                href={`/invoices/${invoiceId}`}
                className="inline-flex justify-center items-center px-4 py-2 rounded-lg bg-brand text-brand-fg font-semibold text-sm hover:bg-brand-hover"
              >
                View invoice
              </Link>
            )}
            <button
              onClick={onClose}
              className="inline-flex justify-center items-center px-4 py-2 rounded-lg bg-surface border border-border text-fg font-medium text-sm hover:bg-surface-2"
            >
              Nice, keep going
            </button>
          </div>
        </div>
      </div>

      {/* Pop-in animation. Kept local so this component is drop-in
          without touching globals.css. */}
      <style jsx>{`
        @keyframes matchpop {
          0%   { transform: scale(0.85); opacity: 0; }
          100% { transform: scale(1);    opacity: 1; }
        }
      `}</style>
    </>
  );
}
