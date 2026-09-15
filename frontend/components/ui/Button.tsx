'use client';

import Link from 'next/link';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

// Shared button primitive. Variants map to semantic roles rather than
// colours so callers don't need to remember which orange to use.
//
//   primary   — brand-orange CTA. One per screen ideally.
//   secondary — neutral white / dark surface with border. Everything else.
//   ghost     — no fill, no border. For low-visual-weight actions.
//   danger    — destructive. Red.
//   link      — inline text-link style (rare — usually just use <Link>).

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-brand text-brand-fg hover:bg-brand-hover shadow-sm',
  secondary:
    'bg-surface text-fg border border-border hover:bg-surface-2 dark:hover:bg-surface-2',
  ghost:
    'bg-transparent text-fg hover:bg-surface-2',
  danger:
    'bg-[var(--danger)] text-white hover:opacity-90 shadow-sm',
  link:
    'bg-transparent text-brand hover:underline p-0',
};

const SIZE: Record<Size, string> = {
  sm: 'text-xs px-2.5 py-1.5 rounded-md gap-1.5',
  md: 'text-sm px-3.5 py-2 rounded-lg gap-2',
  lg: 'text-base px-5 py-2.5 rounded-lg gap-2',
};

type CommonProps = {
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
};

type ButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

type LinkButtonProps = CommonProps & {
  href: string;
  target?: string;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
};

// A single classname builder used by both button + link variants.
function classes(v: Variant, s: Size, fullWidth: boolean, extra: string) {
  return [
    'inline-flex items-center justify-center font-medium',
    'transition-colors disabled:opacity-50 disabled:pointer-events-none',
    'select-none whitespace-nowrap',
    VARIANT[v],
    v === 'link' ? '' : SIZE[s],
    fullWidth ? 'w-full' : '',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      leftIcon,
      rightIcon,
      loading,
      fullWidth,
      children,
      className = '',
      disabled,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={classes(variant, size, !!fullWidth, className)}
        {...rest}
      >
        {loading && <Spinner />}
        {!loading && leftIcon}
        {children}
        {!loading && rightIcon}
      </button>
    );
  },
);

/** Link that looks and acts like a button. Uses next/link under the hood. */
export function ButtonLink({
  href,
  target,
  variant = 'primary',
  size = 'md',
  leftIcon,
  rightIcon,
  fullWidth,
  children,
  className = '',
  onClick,
}: LinkButtonProps) {
  return (
    <Link
      href={href}
      target={target}
      onClick={onClick}
      className={classes(variant, size, !!fullWidth, className)}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="4"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
