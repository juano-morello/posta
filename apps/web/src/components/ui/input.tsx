import * as React from 'react';
import { cn } from '@/lib/utils';

// T6.2.6 — DESIGN.md §4: focus is `--ring` + a 3px halo; error swaps the
// border to `--error` with the matching halo, and wires aria-invalid +
// aria-describedby so the invalid state is perceivable by more than the
// red border colour alone — an AT user is told "this field is invalid,
// here's why" instead of just seeing a color no screen reader announces.
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Validation message. Presence alone marks the field invalid. */
  error?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, id, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const errorId = error ? `${inputId}-error` : undefined;

    return (
      <div className="w-full">
        <input
          id={inputId}
          type={type}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          className={cn(
            'flex h-10 w-full rounded border bg-surface px-3 py-2 font-sans text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-50',
            error ? 'border-error focus-visible:ring-error' : 'border-border focus-visible:ring-ring',
            className,
          )}
          ref={ref}
          {...props}
        />
        {error ? (
          <p id={errorId} className="mt-1.5 font-mono text-sm text-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
