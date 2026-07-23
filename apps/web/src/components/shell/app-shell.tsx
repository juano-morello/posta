'use client';

import type { ReactNode } from 'react';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { BottomTabs } from './bottom-tabs';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

// T6.3.6 — POSTA.md §3: >=800px renders Sidebar + Topbar; <800px renders
// a compact top bar (wordmark + theme toggle + Nuevo) + BottomTabs. The
// swap is CSS-driven off the `mobile` Tailwind screen (a real min-width
// media query at 800px — `mobile:` prefixed classes apply FROM 800px up,
// same convention as Tailwind's own sm:/md:/lg:), never a JS width
// listener, so it renders correctly server-side on first paint with no
// hydration-dependent layout shift, and keeps working with JS disabled.
function CompactMobileTopbar() {
  const { theme, setTheme } = useTheme();
  return (
    <header
      data-view="mobile-only"
      className="flex h-14 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 mobile:hidden"
    >
      <span className="font-sans text-lg font-bold text-fg">Posta</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Cambiar tema"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        <Button variant="primary" size="sm">
          Nuevo
        </Button>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg">
      {/* T6.3.9 [a11y] — first focusable element in the shell: lets a
          keyboard user skip Topbar+Sidebar and land directly on the
          content, instead of tabbing through nav on every single page.
          Border-only lime (not a filled bg-primary/text-primary), same
          resolution as Sidebar/Tabs' active state (T6.3.2/T6.2.4) and for
          the same reason T6.3.10 exists: reserve lime background/text
          fills for the one CTA per view — this is a focus indicator, not
          a second competing CTA. */}
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded focus-visible:border-2 focus-visible:border-primary focus-visible:bg-surface focus-visible:px-4 focus-visible:py-2 focus-visible:font-sans focus-visible:font-semibold focus-visible:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Saltar al contenido
      </a>

      {/* T6.3.9 [a11y] — DOM order (and therefore tab order) is
          Topbar-column FIRST, Sidebar SECOND, matching POSTA.md's
          intended traversal (skip link -> topbar -> nav -> content):
          page-level actions before site navigation. `order-*` decouples
          that from VISUAL position, which still needs the sidebar on the
          left — CSS flex order changes paint order, never DOM/tab order. */}
      <div className="order-2 flex min-w-0 flex-1 flex-col">
        <div className="hidden mobile:block">
          <Topbar />
        </div>
        <CompactMobileTopbar />

        {/* T6.3.8 — POSTA.md §3: fluid page padding, no breakpoints.
            tabIndex={-1}: a skip-link target that isn't itself normally
            focusable still needs to be programmatically focusable so the
            skip link's jump actually moves keyboard focus, not just the
            page scroll position. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 p-[var(--pad-page)] pb-16 mobile:pb-0 focus-visible:outline-none"
        >
          {children}
        </main>
      </div>

      <div className="order-1 hidden mobile:flex">
        <Sidebar />
      </div>

      <BottomTabs />
    </div>
  );
}
