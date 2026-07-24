import { BadgeHumano } from '@/components/honesty/badge-humano';
import { HumanoBar } from '@/components/honesty/humano-bar';
import { Recibos } from '@/components/honesty/recibos';
import { SourceChip } from '@/components/honesty/source-chip';
import {
  EDGE_CASE_HUMANO_BAR_SPLITS,
  EDGE_CASE_RECEIPTS,
  GALLERY_LINKS,
  GALLERY_RECEIPTS,
  GALLERY_SPLIT,
} from '../fixtures';
import { SectionHeading } from '../section-heading';

// T6.5.4 — the four honesty primitives (S6.4), rendered from the
// fixtures module (T6.5.2) in their normal state — never a live
// endpoint. Recibos is shown as a LIVE island: the real component, with
// its own prompt line + pulsing dot, not a static screenshot of one.
const SOURCE_CHIP_PLATFORMS = ['Instagram', 'WhatsApp', 'TikTok', 'directo'] as const;

export function HonestySection() {
  return (
    <div className="flex flex-col gap-10">
      <div data-testid="gallery-humano-bar">
        <SectionHeading>HumanoBar</SectionHeading>
        <HumanoBar {...GALLERY_SPLIT} />
      </div>

      <div data-testid="gallery-badge-humano">
        <SectionHeading>BadgeHumano</SectionHeading>
        <BadgeHumano percent={GALLERY_SPLIT.humano} />
      </div>

      <div data-testid="gallery-source-chip">
        <SectionHeading>SourceChip</SectionHeading>
        <div className="flex flex-wrap gap-3">
          {SOURCE_CHIP_PLATFORMS.map((platform) => (
            <SourceChip key={platform} platform={platform} />
          ))}
        </div>
      </div>

      <div data-testid="gallery-recibos">
        <SectionHeading>Recibos</SectionHeading>
        <Recibos slug={GALLERY_LINKS[0]!.slug} receipts={GALLERY_RECEIPTS} />
      </div>

      {/* T6.5.6 — the cases the primitives are most likely to break on:
          each already has its own unit test (T6.4.4/T6.4.5/T6.4.13), but
          those never prove a human can actually LOOK at the result. */}
      <div data-testid="gallery-honesty-edge-cases">
        <SectionHeading>Casos límite</SectionHeading>
        <div className="flex flex-col gap-6">
          <div data-testid="edge-case-zero-clicks">
            <p className="mb-2 font-mono text-xs text-muted">0 clicks</p>
            <HumanoBar {...EDGE_CASE_HUMANO_BAR_SPLITS.zeroClicks!} />
          </div>
          <div data-testid="edge-case-all-human">
            <p className="mb-2 font-mono text-xs text-muted">100% humano</p>
            <HumanoBar {...EDGE_CASE_HUMANO_BAR_SPLITS.allHuman!} />
          </div>
          <div data-testid="edge-case-no-human">
            <p className="mb-2 font-mono text-xs text-muted">0% humano</p>
            <HumanoBar {...EDGE_CASE_HUMANO_BAR_SPLITS.noHuman!} />
          </div>
          <div data-testid="edge-case-tiny-segment">
            <p className="mb-2 font-mono text-xs text-muted">1 en 10.000</p>
            <HumanoBar {...EDGE_CASE_HUMANO_BAR_SPLITS.tinySegment!} />
          </div>
          <div>
            <p className="mb-2 font-mono text-xs text-muted">why largo / payload hostil</p>
            <Recibos slug="edge" receipts={EDGE_CASE_RECEIPTS} />
          </div>
        </div>
      </div>
    </div>
  );
}
