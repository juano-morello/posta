import { BadgeHumano } from '@/components/honesty/badge-humano';
import { HumanoBar } from '@/components/honesty/humano-bar';
import { Recibos } from '@/components/honesty/recibos';
import { SourceChip } from '@/components/honesty/source-chip';
import { GALLERY_LINKS, GALLERY_RECEIPTS, GALLERY_SPLIT } from '../fixtures';

// T6.5.4 — the four honesty primitives (S6.4), rendered from the
// fixtures module (T6.5.2) in their normal state — never a live
// endpoint. Recibos is shown as a LIVE island: the real component, with
// its own prompt line + pulsing dot, not a static screenshot of one.
function Heading({ children }: { children: string }) {
  return <h3 className="mb-3 font-sans text-base font-semibold">{children}</h3>;
}

const SOURCE_CHIP_PLATFORMS = ['Instagram', 'WhatsApp', 'TikTok', 'directo'] as const;

export function HonestySection() {
  return (
    <div className="flex flex-col gap-10">
      <div data-testid="gallery-humano-bar">
        <Heading>HumanoBar</Heading>
        <HumanoBar {...GALLERY_SPLIT} />
      </div>

      <div data-testid="gallery-badge-humano">
        <Heading>BadgeHumano</Heading>
        <BadgeHumano percent={GALLERY_SPLIT.humano} />
      </div>

      <div data-testid="gallery-source-chip">
        <Heading>SourceChip</Heading>
        <div className="flex flex-wrap gap-3">
          {SOURCE_CHIP_PLATFORMS.map((platform) => (
            <SourceChip key={platform} platform={platform} />
          ))}
        </div>
      </div>

      <div data-testid="gallery-recibos">
        <Heading>Recibos</Heading>
        <Recibos slug={GALLERY_LINKS[0]!.slug} receipts={GALLERY_RECEIPTS} />
      </div>
    </div>
  );
}
