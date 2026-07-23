import { cn } from '@/lib/utils';

// T6.4.10 — POSTA.md §1/§8.3/§8.4: the recibos terminal log island. Colour
// literals (`.island`, `.recibos-chrome`, `.recibos-live-dot`) live in
// _tokens.scss (see that file's own comment) — this component is always
// dark under BOTH themes, so it cannot read the normal `t()`-backed
// tokens the rest of the system uses, and no literal hex may live in this
// .tsx file either way (T6.1.13's grep gate). Rows land in T6.4.11, the
// empty state in T6.4.14.
export interface RecibosProps {
  /** The link's slug, interpolated into the terminal prompt line. */
  slug: string;
  className?: string;
}

export function Recibos({ slug, className }: RecibosProps) {
  return (
    <div data-testid="recibos" className={cn('island rounded-lg font-mono text-sm', className)}>
      <div className="recibos-chrome flex items-center gap-2 rounded-t-lg px-4 py-2">
        <span
          data-testid="recibos-live-dot"
          className="recibos-live-dot h-2 w-2 rounded-full"
          aria-hidden="true"
        />
        <span>
          <span className="lime">~/posta $</span> tail -f recibos --link={slug}
        </span>
      </div>
      <div data-testid="recibos-rows" className="px-4 py-3" />
    </div>
  );
}
