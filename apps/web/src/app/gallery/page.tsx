'use client';

import { HonestySection } from './sections/honesty-section';
import { ShadcnSection } from './sections/shadcn-section';
import { ShellSection } from './sections/shell-section';

// T6.5.1 — the component gallery: every primitive rendered in isolation
// (POSTA.md/spec §11.1) so E7/E8 assemble known-good parts. A client-only
// page — no `fetch`, no server action, no API call — so it renders while
// E1-E4 (backend) are still being built; it reads only the fixtures
// module (T6.5.2) and the components themselves. 'use client' is needed
// from the start because T6.5.7 wires a stateful theme toggle here.
//
// This file grows task-by-task: T6.5.3 (shadcn primitives), T6.5.4
// (honesty primitives), T6.5.5 (shell frames), T6.5.6 (honesty edge
// cases) and T6.5.7 (theme toggle) all add to the SECTIONS list and the
// section bodies below, per the plan's own file list for each of those
// tasks — one page, not a component-per-file split, so the anchor nav
// and the rendered content can never drift apart.
interface GallerySection {
  id: string;
  label: string;
}

const SECTIONS: GallerySection[] = [
  { id: 'shadcn', label: 'shadcn' },
  { id: 'honesty', label: 'Honesty primitives' },
  { id: 'shell', label: 'App shell' },
];

export default function GalleryPage() {
  return (
    <div className="flex min-h-screen bg-bg text-fg">
      <nav aria-label="Secciones" className="w-48 shrink-0 border-r border-border p-4">
        <ul className="flex flex-col gap-2 font-mono text-sm">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="hover:text-primary hover:underline">
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 p-8">
        <h1 className="mb-8 font-sans text-2xl font-bold">Galería de componentes</h1>

        <section id="shadcn" aria-labelledby="shadcn-heading" className="mb-12">
          <h2 id="shadcn-heading" className="mb-4 font-sans text-lg font-semibold">
            shadcn
          </h2>
          <ShadcnSection />
        </section>

        <section id="honesty" aria-labelledby="honesty-heading" className="mb-12">
          <h2 id="honesty-heading" className="mb-4 font-sans text-lg font-semibold">
            Honesty primitives
          </h2>
          <HonestySection />
        </section>

        <section id="shell" aria-labelledby="shell-heading" className="mb-12">
          <h2 id="shell-heading" className="mb-4 font-sans text-lg font-semibold">
            App shell
          </h2>
          <ShellSection />
        </section>
      </main>
    </div>
  );
}
