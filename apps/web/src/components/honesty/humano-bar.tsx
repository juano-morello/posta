import { cn } from '@/lib/utils';

// T6.4.3 — POSTA.md §1: the honesty primitives' signature component. A
// segmented bar, 16px tall, 2px gaps, radius-badge (--radius-badge, the
// same named 6px badges/chips use — never a bare 6px). Humans paint on
// --primary (lime); bots/unfurlers/prefetch paint across the --n1/n2/n3
// no-humano gray ramp, in that order, so the ramp reads as a visual
// hierarchy (bot = most prominent/darkest gray, prefetch = least). Zero/
// all-human/no-human handling (T6.4.4), the sub-1% visibility floor
// (T6.4.5), and the legend (T6.4.6) build on this base.
export interface HumanoBarProps {
  humano: number;
  bot: number;
  unfurler: number;
  prefetch: number;
}

const SEGMENTS = [
  { key: 'humano', colorClass: 'bg-primary' },
  { key: 'bot', colorClass: 'bg-n1' },
  { key: 'unfurler', colorClass: 'bg-n2' },
  { key: 'prefetch', colorClass: 'bg-n3' },
] as const satisfies ReadonlyArray<{ key: keyof HumanoBarProps; colorClass: string }>;

export function HumanoBar(props: HumanoBarProps) {
  const total = props.humano + props.bot + props.unfurler + props.prefetch;

  return (
    <div
      data-testid="humano-bar"
      className="flex h-4 gap-[2px] overflow-hidden rounded-badge bg-bg"
    >
      {SEGMENTS.map(({ key, colorClass }) => {
        const count = props[key];
        const pct = total > 0 ? (count / total) * 100 : 0;
        return (
          <i
            key={key}
            data-testid={`humano-bar-segment-${key}`}
            className={cn('block h-full', colorClass)}
            style={{ width: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}
