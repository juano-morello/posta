import { CLASIFICACION_TOKEN, type Clasificacion, type SourcePlatform } from '@posta/contracts';
import { cn } from '@/lib/utils';

// T6.4.10 — POSTA.md §1/§8.3/§8.4: the recibos terminal log island. Colour
// literals (`.island`, `.recibos-chrome`, `.recibos-live-dot`, `.cls-*`)
// live in _tokens.scss (see that file's own comment) — this component is
// always dark under BOTH themes, so it cannot read the normal
// `t()`-backed tokens the rest of the system uses, and no literal hex may
// live in this .tsx file either way (T6.1.13's grep gate). The empty
// state lands in T6.4.14, why-string hardening in T6.4.13.
export interface Recibo {
  /** ULID (CLAUDE.md convention) — stable React key across the T6.4.12
   * row-buffer prune, where the list shifts as new rows arrive and old
   * ones drop; an index key would misattribute rows across that shift. */
  id: string;
  /** Already-formatted display time — the caller decides precision/locale. */
  t: string;
  src: SourcePlatform;
  cls: Clasificacion;
  why: string;
}

export interface RecibosProps {
  /** The link's slug, interpolated into the terminal prompt line. */
  slug: string;
  receipts?: Recibo[];
  className?: string;
}

function classificationClass(cls: Clasificacion): string {
  return `cls-${CLASIFICACION_TOKEN[cls]}`;
}

// T6.4.12 — a busy link streaming for an hour must not grow the DOM
// without bound. `receipts` is chronological (oldest -> newest, matching
// how a live subscriber appends incoming clicks onto an array over
// time); this keeps only the most recent MAX_RECIBOS and reverses them
// so the newest renders first, matching a `tail -f`-style recent-activity
// feed. A named constant, not a literal, per the task's own requirement.
export const MAX_RECIBOS = 200;

function capReceipts(receipts: Recibo[]): Recibo[] {
  const recent = receipts.length > MAX_RECIBOS ? receipts.slice(receipts.length - MAX_RECIBOS) : receipts;
  return [...recent].reverse();
}

// T6.4.13 [security] — `why` is derived from raw, attacker-controlled
// user-agent fragments captured at the edge. React already escapes text
// nodes by default, so an HTML/script payload renders as inert visible
// text with no injection risk — this function is NOT about that (see
// this file's own regression-guard test for it). It strips what escaping
// alone does not neutralize: C0/C1 control characters and zero-width/
// bidi-override formatting characters a hostile UA can smuggle to corrupt
// the terminal layout (or hide/reorder text) without ever showing up as
// a suspicious diff in code review.
//
// Deliberately expressed as numeric code-point ranges, not a regex
// character class: typing the actual invisible characters into a regex
// literal would recreate, in this exact file, the "corrupts the layout
// without being visible in review" problem this function exists to
// prevent — and a regex escape sequence reads the same to the naked eye
// as any other backslash-digit noise, which is precisely the low-scrutiny
// spot a real mistake could hide.
const CONTROL_AND_INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls (includes BEL, NUL, etc.)
  [0x7f, 0x9f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width space/non-joiner/joiner, LRM, RLM
  [0x202a, 0x202e], // bidi embedding/override: LRE, RLE, PDF, LRO, RLO — the
  // "Trojan Source" reorder characters (CVE-2021-42574's class): an
  // unclosed RLO can visually reverse everything after it in the same
  // block, which for a Recibos row means reversing the `[bot]`/`[humano]`
  // verdict itself. Found by two independent reviewers (security-reviewer
  // + silent-failure-hunter) as a real gap in the first cut of this list.
  [0x2066, 0x2069], // bidi isolates: LRI, RLI, FSI, PDI — same reorder risk
  [0x2028, 0x2029], // line separator, paragraph separator
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isControlOrInvisible(codePoint: number): boolean {
  return CONTROL_AND_INVISIBLE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function sanitizeWhy(why: string): string {
  return Array.from(why)
    .filter((char) => !isControlOrInvisible(char.codePointAt(0)!))
    .join('');
}

// T6.4.14 — POSTA.md's rioplatense, direct voice, in the island's own
// terminal register: no receipts is not an empty box, it's the terminal
// telling you so, with a steady (not blinking — see this file's own
// _tokens.scss comment) cursor block.
function EmptyState() {
  return (
    <div className="flex items-center gap-1">
      <span>~/posta $ todavía no hay clicks</span>
      <span className="recibos-cursor inline-block h-4 w-2" aria-hidden="true" />
    </div>
  );
}

export function Recibos({ slug, receipts = [], className }: RecibosProps) {
  const rows = capReceipts(receipts);
  return (
    <div data-testid="recibos" className={cn('island rounded-lg font-mono text-sm', className)}>
      <div className="recibos-chrome flex items-center gap-2 rounded-t-lg px-4 py-2">
        {/* a11y-architect review (S6.4 story review) — WCAG 2.2.2 (Pause,
            Stop, Hide) requires a mechanism to pause auto-updating content
            that moves/blinks for >5s, UNLESS it is "part of an activity
            where it is essential". This dot's entire purpose is to BE the
            live/streaming status indicator (the same class of exception
            recording/on-air lights are usually treated under) — pausing
            it would remove the one thing it exists to communicate, not
            just its motion. `aria-hidden` because the status itself is
            already conveyed in words by the prompt line beside it; the
            dot is decorative reinforcement, not an independent channel. */}
        <span
          data-testid="recibos-live-dot"
          className="recibos-live-dot h-2 w-2 rounded-full"
          aria-hidden="true"
        />
        <span>
          <span className="lime">~/posta $</span> tail -f recibos --link={slug}
        </span>
      </div>
      {/* a11y-architect review (S6.4 story review) — this IS a log
          (POSTA.md's own "tail -f"), so `role="log"` is the correct
          landmark even though nothing updates it live yet in E6 (a pure
          prop-render today). `aria-live="off"` is explicit rather than
          left to `role="log"`'s own implicit polite default, so that
          whichever future story wires real live updates has to choose
          polite/assertive with intent — not discover after shipping that
          a busy link floods screen reader users by default. */}
      <div
        data-testid="recibos-rows"
        role="log"
        aria-live="off"
        className="flex flex-col gap-1 px-4 py-3"
      >
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          rows.map((row) => (
            <div key={row.id} data-testid="recibos-row" className="flex flex-wrap items-baseline gap-2">
              <span className="muted">{row.t}</span>
              <span className="muted">{row.src}</span>
              <span className={classificationClass(row.cls)}>[{row.cls}]</span>
              {/* T6.5.6 — `min-w-0` is load-bearing, not decoration: `why`
                  is unbounded, attacker-influenced text (T6.4.13) that can
                  contain a long unbroken token (a URL, say). As a flex
                  item in this row, it would otherwise refuse to shrink
                  below that token's own min-content width — the exact
                  same flexbox "automatic minimum size" gotcha as the
                  gallery's shell-preview iframes (T6.5.5/6) — and
                  `break-words` on its own would never even get a chance
                  to run, because the overflow happens one layer up, at
                  the flex-sizing step, before wrapping is considered. */}
              <span className="min-w-0 break-words">{sanitizeWhy(row.why)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
