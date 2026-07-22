import { AppShell } from '@/components/shell/app-shell';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

// T6.3.6 — a minimal route whose sole purpose is giving Playwright
// (e2e/shell.spec.ts, e2e/shell-a11y.spec.ts) something real to navigate
// to while exercising AppShell's responsive breakpoint swap and keyboard
// navigation. E6 builds no real dashboard screens (that's E7); this is
// scaffolding, not a product route, and is expected to be superseded or
// absorbed once E7 has real authenticated screens to mount AppShell on.
//
// T6.3.7 — four stat cards in the .grid-cards utility, so shell.spec.ts
// can assert the 4/2/1 column wrap at 1280/700/390px against something
// real.
const STAT_CARDS = ['clicks reales', '% no humano', 'mejor link', 'top fuente'];

export default function ShellPreviewPage() {
  return (
    <AppShell>
      {/* T6.3.8 — AppShell's <main> already applies --pad-page; no
          redundant padding here. */}
      <h1 className="font-sans text-2xl font-bold text-fg">Contenido de ejemplo</h1>
      <div className="grid-cards mt-6" data-testid="stat-card-grid">
        {STAT_CARDS.map((label) => (
          <Card key={label} data-testid="stat-card">
            <CardHeader>
              <CardTitle>{label}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
