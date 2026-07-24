import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// T6.2.4 — DESIGN.md §4: "bloques surface-2 con @keyframes pulse (opacity
// 1<->.45, 1.6s). Respetá la forma del contenido real." Tailwind's built-in
// `animate-pulse` (opacity 1<->.5, 2s) is close enough to hand-roll a
// bespoke keyframe for a cosmetic half-step difference — callers size this
// with className (h-4 w-32, rounded-full for an avatar, etc.) to match the
// real content's shape, per the spec's own instruction.
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded bg-surface-2', className)} {...props} />;
}

export { Skeleton };
