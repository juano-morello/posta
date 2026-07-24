import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// T6.2.5 — DESIGN.md §4's five variants: primary (lime fill, graphite
// text), secondary (surface-2), outline, ghost, destructive. Hover is
// `brightness(1.08)` on every filled variant and a border-color swap on
// outline; disabled drops opacity and blocks the pointer; loading is
// handled by the component body below (swaps in a spinner, sets
// aria-busy, and the click handler itself no-ops rather than firing).
//
// `primary` and `destructive` carry `text-lg font-bold` — not a stylistic
// choice, an accessibility one. S6.1's contrast review found light-mode
// primary-fg/primary is 3.93:1 and dark-mode destructive-foreground/
// destructive is 3.35:1: both clear WCAG 1.4.3's 3:1 large-text floor but
// fail the 4.5:1 normal-text floor. Rendering the label at >=18.66px AND
// bold is what legitimately claims the large-text exception instead of
// silently shipping a real AA failure in the weaker theme. `secondary`/
// `outline`/`ghost` render `fg`-family text on `surface`/`surface-2`/
// transparent, which clears 4.5:1 by a wide margin at any size (S6.1
// measured >=12.88:1), so they stay at normal weight/size.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-sans transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg text-lg font-bold hover:brightness-110',
        secondary: 'bg-surface-2 text-fg font-medium hover:brightness-110',
        outline: 'border border-border bg-transparent text-fg font-medium hover:border-primary',
        ghost: 'bg-transparent text-fg font-medium hover:bg-surface-2',
        destructive:
          'bg-destructive text-destructive-foreground text-lg font-bold hover:brightness-110',
      },
      size: {
        sm: 'h-9 px-3',
        md: 'h-10 px-4 py-2',
        lg: 'h-11 px-8',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Swaps in a spinner, sets aria-busy, and makes clicks a no-op. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, disabled, onClick, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    const isInert = Boolean(disabled) || loading;

    // Loading no-ops the click rather than relying solely on the native
    // `disabled` attribute: `asChild` can render a non-button element
    // (an anchor via next/link, say) where `disabled` has no effect at
    // all, so the guard has to live in the handler itself.
    const handleClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
      if (loading) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    };

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={isInert}
        aria-disabled={isInert || undefined}
        aria-busy={loading || undefined}
        onClick={handleClick}
        {...props}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
