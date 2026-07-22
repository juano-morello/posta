import { AppShell } from '@/components/shell/app-shell';

// T6.3.6 — a minimal route whose sole purpose is giving Playwright
// (e2e/shell.spec.ts, e2e/shell-a11y.spec.ts) something real to navigate
// to while exercising AppShell's responsive breakpoint swap and keyboard
// navigation. E6 builds no real dashboard screens (that's E7); this is
// scaffolding, not a product route, and is expected to be superseded or
// absorbed once E7 has real authenticated screens to mount AppShell on.
export default function ShellPreviewPage() {
  return (
    <AppShell>
      <div className="p-6">
        <h1 className="font-sans text-2xl font-bold text-fg">Contenido de ejemplo</h1>
      </div>
    </AppShell>
  );
}
