import { cn } from '@/lib/utils';

// T6.4.7 — POSTA.md §1/§8.4: the "% humano" badge. The colour/background/
// border tint is `.badge-humano` in _tokens.scss (color-mix survival,
// see that file's own comment); this component owns only the layout,
// typography classes and the guard against a non-finite or out-of-range
// percentage rendering as literal "NaN% humano" or ">100% humano".
export interface BadgeHumanoProps {
  /** 0-100 already-computed share of human clicks. */
  percent: number;
  className?: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function BadgeHumano({ percent, className }: BadgeHumanoProps) {
  const clamped = clampPercent(percent);

  return (
    <span className={cn('badge-humano inline-flex items-center font-mono text-sm', className)}>
      {clamped}% humano
    </span>
  );
}
