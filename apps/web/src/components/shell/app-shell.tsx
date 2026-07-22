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
    <header className="flex h-14 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 mobile:hidden">
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
      <div className="hidden mobile:flex">
        <Sidebar />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="hidden mobile:block">
          <Topbar />
        </div>
        <CompactMobileTopbar />

        {/* T6.3.8 — POSTA.md §3: fluid page padding, no breakpoints. */}
        <main className="flex-1 p-[var(--pad-page)] pb-16 mobile:pb-0">{children}</main>
      </div>

      <BottomTabs />
    </div>
  );
}
