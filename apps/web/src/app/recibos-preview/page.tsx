import { Recibos } from '@/components/honesty/recibos';

// T6.4.10 — a minimal route giving Playwright (e2e/islands.spec.ts,
// e2e/honesty-a11y.spec.ts) something real to navigate to while exercising
// Recibos in isolation, the same pattern shell-preview/page.tsx already
// established for AppShell (T6.3.6). Scaffolding, not a product route —
// expected to be superseded/absorbed once S6.5's /gallery exists.
export default function RecibosPreviewPage() {
  return (
    <div className="p-8">
      <Recibos slug="promo" />
    </div>
  );
}
