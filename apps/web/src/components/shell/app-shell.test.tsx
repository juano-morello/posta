import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/lib/theme';
import { AppShell } from './app-shell';

function renderShell(children: ReactNode) {
  return render(<ThemeProvider>{children}</ThemeProvider>);
}

// T6.3.6 — POSTA.md §3: >=800px renders Sidebar + Topbar; <800px renders
// a compact top bar (wordmark + theme toggle + Nuevo) + BottomTabs. The
// swap itself is CSS-driven (Tailwind's `mobile:` screen — a real
// responsive media query), not a JS width listener, so it is SSR-correct
// on first paint and works with JS disabled — that real-browser proof is
// e2e/shell.spec.ts (Playwright); this unit test only confirms the wiring
// (the right wrapper carries the right responsive visibility classes),
// since jsdom has no viewport/media-query engine to verify the swap
// itself against.
const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: usePathnameMock }));

describe('AppShell', () => {
  it('hides the desktop Sidebar/Topbar below the mobile breakpoint, shows them from it up', () => {
    usePathnameMock.mockReturnValue('/');
    renderShell(
      <AppShell>
        <p>contenido</p>
      </AppShell>,
    );
    // Both Sidebar and BottomTabs use aria-label="Principal" — distinguish
    // the desktop one (Sidebar) from BottomTabs (which is `fixed`).
    const navs = screen.getAllByRole('navigation', { name: 'Principal' });
    const desktopNav = navs.find((nav) => !nav.className.includes('fixed'))!;
    const wrapper = desktopNav.parentElement as HTMLElement;
    expect(wrapper.className).toMatch(/\bhidden\b/);
    expect(wrapper.className).toMatch(/mobile:flex|mobile:block/);
  });

  it('shows BottomTabs below the mobile breakpoint, hides it from it up', () => {
    usePathnameMock.mockReturnValue('/');
    renderShell(
      <AppShell>
        <p>contenido</p>
      </AppShell>,
    );
    const navs = screen.getAllByRole('navigation', { name: 'Principal' });
    // BottomTabs is `fixed`; Sidebar is not — distinguish by that.
    const bottomTabs = navs.find((nav) => nav.className.includes('fixed'));
    expect(bottomTabs).toBeDefined();
    expect(bottomTabs!.className).toMatch(/mobile:hidden/);
  });

  it('renders the compact mobile topbar (wordmark, theme toggle, Nuevo) hidden from the mobile breakpoint up', () => {
    usePathnameMock.mockReturnValue('/');
    renderShell(
      <AppShell>
        <p>contenido</p>
      </AppShell>,
    );
    const wordmark = screen.getByText('Posta');
    const compactBar = wordmark.closest('header') as HTMLElement;
    expect(compactBar.className).toMatch(/mobile:hidden/);
    expect(screen.getByRole('button', { name: 'Nuevo' })).toBeInTheDocument();
  });

  it('renders children content', () => {
    usePathnameMock.mockReturnValue('/');
    renderShell(
      <AppShell>
        <p>contenido de ejemplo</p>
      </AppShell>,
    );
    expect(screen.getByText('contenido de ejemplo')).toBeInTheDocument();
  });
});
