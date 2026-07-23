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

// T6.4.6 [a11y] — the Spanish label each segment gets in the legend.
const SEGMENTS = [
  { key: 'humano', colorClass: 'bg-primary', label: 'humanos' },
  { key: 'bot', colorClass: 'bg-n1', label: 'bots' },
  { key: 'unfurler', colorClass: 'bg-n2', label: 'unfurlers' },
  { key: 'prefetch', colorClass: 'bg-n3', label: 'prefetch' },
] as const satisfies ReadonlyArray<{ key: keyof HumanoBarProps; colorClass: string; label: string }>;

// T6.4.5 — a segment that rounds away to a sliver of a pixel is a
// rounded-away lie: the honest split is the whole point, so any non-zero
// segment is floored at MIN_VISIBLE_PCT. The floor is paid for by
// shrinking the segments ABOVE the floor proportionally to their own
// share of that "donor" pool — never by shrinking another already-tiny
// segment, and never by simply not summing to 100.
const MIN_VISIBLE_PCT = 1.5;

/** Pure and exported for direct testing — the redistribution math is the
 * part worth verifying in isolation from rendering. */
export function computeSegmentWidths(props: HumanoBarProps): Record<keyof HumanoBarProps, number> {
  const keys = SEGMENTS.map((s) => s.key);
  const total = keys.reduce((sum, key) => sum + props[key], 0);

  if (total <= 0) {
    return { humano: 0, bot: 0, unfurler: 0, prefetch: 0 };
  }

  const raw: Record<string, number> = {};
  for (const key of keys) {
    raw[key] = (props[key] / total) * 100;
  }

  const flooredKeys = keys.filter((key) => props[key] > 0 && raw[key]! < MIN_VISIBLE_PCT);
  const deficit = flooredKeys.reduce((sum, key) => sum + (MIN_VISIBLE_PCT - raw[key]!), 0);

  const donorKeys = keys.filter((key) => !flooredKeys.includes(key));
  const donorTotal = donorKeys.reduce((sum, key) => sum + raw[key]!, 0);

  const result: Record<string, number> = {};
  for (const key of keys) {
    if (flooredKeys.includes(key)) {
      result[key] = MIN_VISIBLE_PCT;
    } else if (donorTotal > 0) {
      result[key] = raw[key]! - deficit * (raw[key]! / donorTotal);
    } else {
      result[key] = raw[key]!;
    }
  }
  return result as Record<keyof HumanoBarProps, number>;
}

// T6.4.6 [a11y] — colour is never the only channel: the bar itself carries
// role="img" (it IS a single meaningful graphic, not four decorative
// slivers) with an aria-label stating the whole split in words, and a
// visible legend beneath it repeats every segment's label + raw count so
// a sighted user doesn't have to decode bar-chart hues either.
function buildAriaLabel(props: HumanoBarProps): string {
  return SEGMENTS.map(({ key, label }) => `${props[key]} ${label}`).join(', ');
}

export function HumanoBar(props: HumanoBarProps) {
  const widths = computeSegmentWidths(props);

  return (
    <div>
      <div
        data-testid="humano-bar"
        role="img"
        aria-label={buildAriaLabel(props)}
        className="flex h-4 gap-[2px] overflow-hidden rounded-badge bg-bg"
      >
        {SEGMENTS.map(({ key, colorClass }) => (
          <i
            key={key}
            data-testid={`humano-bar-segment-${key}`}
            className={cn('block h-full', colorClass)}
            style={{ width: `${widths[key]}%` }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
        {SEGMENTS.map(({ key, colorClass, label }) => (
          <li key={key} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full', colorClass)} aria-hidden="true" />
            <span>{label}</span>
            <span className="text-fg">{props[key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
