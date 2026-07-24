import { BadgeHumano } from '@/components/honesty/badge-humano';
import { HumanoBar } from '@/components/honesty/humano-bar';
import { Recibos, type Recibo } from '@/components/honesty/recibos';
import { SourceChip } from '@/components/honesty/source-chip';

// T6.4.15 [a11y] — a minimal route giving Playwright (e2e/honesty-a11y.spec.ts)
// something real to navigate to while running axe over all four honesty
// primitives together, the same pattern shell-preview/page.tsx (T6.3.6)
// and recibos-preview/page.tsx (T6.4.10) already established. Scaffolding,
// not a product route — expected to be superseded/absorbed once S6.5's
// /gallery exists.
const RECEIPTS: Recibo[] = [
  { id: '01J000000000000000000001', t: '14:32:01', src: 'Instagram', cls: 'bot', why: "user-agent 'python-requests'" },
  { id: '01J000000000000000000002', t: '14:31:47', src: 'directo', cls: 'prefetch', why: 'preview de link · dwell 0 ms' },
  { id: '01J000000000000000000003', t: '14:31:20', src: 'WhatsApp', cls: 'unfurler', why: 'facebookexternalhit' },
  { id: '01J000000000000000000004', t: '14:30:58', src: 'TikTok', cls: 'humano', why: '—' },
];

export default function HonestyPreviewPage() {
  return (
    <main className="flex flex-col gap-8 bg-bg p-8 text-fg">
      <h1 className="font-sans text-2xl font-bold">Honesty primitives</h1>

      <section aria-labelledby="humano-bar-heading">
        <h2 id="humano-bar-heading" className="mb-2 font-sans text-lg font-semibold">
          HumanoBar
        </h2>
        <HumanoBar humano={60} bot={20} unfurler={12} prefetch={8} />
      </section>

      <section aria-labelledby="badge-humano-heading">
        <h2 id="badge-humano-heading" className="mb-2 font-sans text-lg font-semibold">
          BadgeHumano
        </h2>
        <BadgeHumano percent={87} />
      </section>

      <section aria-labelledby="source-chip-heading">
        <h2 id="source-chip-heading" className="mb-2 font-sans text-lg font-semibold">
          SourceChip
        </h2>
        <div className="flex gap-3">
          <SourceChip platform="Instagram" />
          <SourceChip platform="WhatsApp" />
          <SourceChip platform="TikTok" />
          <SourceChip platform="directo" />
        </div>
      </section>

      <section aria-labelledby="recibos-heading">
        <h2 id="recibos-heading" className="mb-2 font-sans text-lg font-semibold">
          Recibos
        </h2>
        <Recibos slug="promo" receipts={RECEIPTS} />
      </section>
    </main>
  );
}
