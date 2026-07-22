import * as React from 'react';
import { cn } from '@/lib/utils';

// T6.2.2 — first-pass scaffold: base border/focus styling only. The
// `--ring` focus halo and `--error` invalid treatment (T6.2.6) build on
// this same element.
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        'flex h-10 w-full rounded border border-border bg-surface px-3 py-2 font-sans text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
