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
        {/* T6.3.9 [a11y] — same accessible name as the desktop Topbar's
            CTA (WCAG 3.2.4 Consistent Identification): the same control
            shouldn't have two different names depending on viewport. */}
        <Button variant="primary" size="sm">
          Nuevo link
        </Button>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    // T6.3.9 [a11y] — FOUND during this story's own accessibility review:
    // an earlier flexbox + `order-*` version nested <main> INSIDE the same
    // subtree as Topbar, with Sidebar as a later sibling. CSS `order` only
    // changes paint order, never DOM order — so real focusable content
    // rendered as `{children}` landed in Tab order BETWEEN Topbar and
    // Sidebar, not after both, on every page with anything interactive in
    // it (confirmed empirically with a real Tab walk in a production
    // build). Flexbox `order` cannot fix this: it cannot let one DOM
    // sibling (main) share a visual column with a different, non-adjacent
    // sibling (Topbar) without nesting them, and nesting is exactly what
    // broke Tab order. CSS Grid can: Sidebar, the topbar row, and main are
    // three INDEPENDENT grid items placed by `grid-column`/`grid-row`, so
    // DOM order can be exactly skip-link -> topbar -> sidebar -> main
    // (matching intended Tab order) while 2-D visual placement is fully
    // decoupled from it.
    <div className="grid min-h-screen grid-rows-[auto_1fr] bg-bg mobile:grid-cols-[220px_1fr]">
      {/* First focusable element in the shell: lets a keyboard user skip
          Topbar+Sidebar and land directly on the content, instead of
          tabbing through nav on every single page. Border-only lime (not
          a filled bg-primary/text-primary), same resolution as Sidebar/
          Tabs' active state (T6.3.2/T6.2.4) and for the same reason
          T6.3.10 exists: reserve lime background/text fills for the one
          CTA per view — this is a focus indicator, not a second competing
          CTA. */}
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded focus-visible:border-2 focus-visible:border-primary focus-visible:bg-surface focus-visible:px-4 focus-visible:py-2 focus-visible:font-sans focus-visible:font-semibold focus-visible:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Saltar al contenido
      </a>

      {/* Topbar row: row 1, desktop column 2 (mobile: single implicit
          column, so no explicit column needed below 800px). */}
      <div className="mobile:col-start-2 mobile:row-start-1">
        <div className="hidden mobile:block">
          <Topbar />
        </div>
        <CompactMobileTopbar />
      </div>

      {/* Sidebar: DOM order right after the topbar row and BEFORE <main>
          — this is what fixes Tab order (topbar -> nav -> content).
          Visually spans both rows in column 1 on desktop; `hidden` keeps
          it out of layout (and out of Tab order) entirely below 800px,
          where it occupies no grid cell at all. */}
      <div className="hidden mobile:col-start-1 mobile:row-start-1 mobile:row-span-2 mobile:flex">
        <Sidebar />
      </div>

      {/* T6.3.8 — POSTA.md §3: fluid page padding, no breakpoints.
          tabIndex={-1}: a skip-link target that isn't itself normally
          focusable still needs to be programmatically focusable so the
          skip link's jump actually moves keyboard focus, not just the
          page scroll position. Desktop: row 2/column 2. Mobile: the
          remaining implicit row in the single column. `min-w-0` stops a
          wide child (e.g. a table) from blowing out the grid track. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="min-w-0 p-[var(--pad-page)] pb-16 mobile:col-start-2 mobile:row-start-2 mobile:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {children}
      </main>

      <BottomTabs />
    </div>
  );
}
