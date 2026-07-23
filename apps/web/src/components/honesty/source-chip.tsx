import type { SourcePlatform } from '@posta/contracts';
import { cn } from '@/lib/utils';

// T6.4.8 — POSTA.md §1/§8.4: a mono chip with a platform-coloured dot for
// the fuentes breakdown and the links list. Dot colours live in
// _tokens.scss's `.source-chip-dot--*` classes (see that file's own
// comment) since they are brand hues with no existing semantic token,
// not values Tailwind's closed palette (T6.1.6) should carry.
const DOT_CLASS: Record<SourcePlatform, string> = {
  Instagram: 'source-chip-dot--instagram',
  WhatsApp: 'source-chip-dot--whatsapp',
  TikTok: 'source-chip-dot--tiktok',
  directo: 'source-chip-dot--directo',
};

export interface SourceChipProps {
  platform: SourcePlatform;
  className?: string;
}

export function SourceChip({ platform, className }: SourceChipProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-xs', className)}>
      <span
        data-testid="source-chip-dot"
        className={cn('source-chip-dot h-2 w-2', DOT_CLASS[platform])}
        aria-hidden="true"
      />
      {platform}
    </span>
  );
}
