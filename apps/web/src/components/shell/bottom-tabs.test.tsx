import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabs } from './bottom-tabs';

// T6.3.4 — POSTA.md §3: mobile (<800px) fixed bottom tab bar, the same
// four v1 routes as the Sidebar (Links / Bio / Ajustes / Pública),
// icon-over-label, active tab in lime.
const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: usePathnameMock }));

describe('BottomTabs', () => {
  it('renders all four v1 tabs and marks exactly the current one aria-current="page"', () => {
    usePathnameMock.mockReturnValue('/ajustes');
    render(<BottomTabs />);

    for (const label of ['Links', 'Bio', 'Ajustes', 'Pública']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }

    const links = screen.getAllByRole('link');
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Ajustes');
  });

  it('pads for env(safe-area-inset-bottom) — iOS home-indicator devices', () => {
    // A Tailwind arbitrary-value class, not a React inline style: jsdom's
    // CSSStyleDeclaration setter (which `style={{...}}` goes through)
    // silently rejects `env(...)` outright — confirmed empirically,
    // neither the property nor the style attribute end up set at all.
    // The class-name string is a plain compile-time value with no such
    // runtime validation, so it survives to be asserted here directly.
    usePathnameMock.mockReturnValue('/');
    const { container } = render(<BottomTabs />);
    const nav = container.querySelector('nav') as HTMLElement;
    expect(nav.className).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
  });

  it('floors every tab at a 44x44px hit target [a11y]', () => {
    // jsdom has no layout engine (getBoundingClientRect is always 0x0
    // here), so this checks the DECLARED min-height/min-width utilities
    // rather than a measured box — the real measured proof is
    // Playwright's job (shell-a11y.spec.ts, T6.3.9).
    usePathnameMock.mockReturnValue('/');
    render(<BottomTabs />);
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toMatch(/min-h-\[44px\]/);
      expect(link.className).toMatch(/min-w-\[44px\]/);
    }
  });
});
