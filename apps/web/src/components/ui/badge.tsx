import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// T6.2.4 — DESIGN.md §4: "Badges: mono, radius badge (6px), variantes:
// primary, default, outline, success/warning/error (con color-mix al ~15%
// de fondo)." color-mix() must survive into the emitted CSS uninterpreted
// — the arbitrary-value Tailwind classes below pass their contents
// straight through untouched, so no SCSS/PostCSS layer ever gets a chance
// to try (and fail) to evaluate the function itself. NOTE: never restate
// one of those class names inside a comment — Tailwind's content scanner
// is a plain text regex with no code-vs-comment awareness, and a literal
// example once generated broken CSS from it (T6.3.6).
const badgeVariants = cva(
  'inline-flex items-center rounded-badge border px-2.5 py-0.5 font-mono text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-surface-2 text-fg',
        primary:
          'border-transparent bg-[color-mix(in_srgb,_var(--primary)_16%,_transparent)] text-primary',
        outline: 'border-border text-fg',
        success:
          'border-transparent bg-[color-mix(in_srgb,_var(--success)_16%,_transparent)] text-success',
        warning:
          'border-transparent bg-[color-mix(in_srgb,_var(--warning)_16%,_transparent)] text-warning',
        error: 'border-transparent bg-[color-mix(in_srgb,_var(--error)_16%,_transparent)] text-error',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
