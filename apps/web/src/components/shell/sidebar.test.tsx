import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar';

// T6.3.1/T6.3.2 — POSTA.md §3: desktop sidebar, 220px, v1 route list
// (Links / Bio / Ajustes / Pública). `usePathname` needs a Next.js router
// context RTL doesn't provide on its own, so it's mocked per-test to
// control which route is "current".
const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: usePathnameMock }));

describe('Sidebar', () => {
  it('renders as a 220px navigation rail with the four v1 routes', () => {
    usePathnameMock.mockReturnValue('/');
    render(<Sidebar />);

    const nav = screen.getByRole('navigation');
    expect(nav.className).toMatch(/w-\[220px\]/);

    for (const label of ['Links', 'Bio', 'Ajustes', 'Pública']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('marks exactly the current route aria-current="page" and reserves the primary colour for it alone', () => {
    usePathnameMock.mockReturnValue('/bio');
    render(<Sidebar />);

    const links = screen.getAllByRole('link');
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Bio');

    // "one lime focus per view" (BRAND.md §0.2 / T6.3.10) — only the
    // active item may use a `primary` colour class anywhere in the rail.
    const primaryUsers = links.filter((link) => /\bprimary\b/.test(link.className));
    expect(primaryUsers).toHaveLength(1);
    expect(primaryUsers[0]).toBe(current[0]);
  });

  it("renders the active item's label in fg, not lime text — lime stays on the indicator/tint only", () => {
    // S6.1's contrast review: regular-weight lime TEXT on bg/surface only
    // clears 3:1 (large-text), not the 4.5:1 normal text needs (light
    // primary/bg = 3.69:1). Sidebar labels are body-scale (15-16px per
    // DESIGN.md §3), never large/bold enough to claim that exception, so
    // the label itself must stay in `fg` — same resolution as Tabs
    // (T6.2.4): lime signals via the indicator bar + tint background, not
    // via the text colour.
    usePathnameMock.mockReturnValue('/bio');
    render(<Sidebar />);
    const active = screen.getByRole('link', { name: 'Bio' });
    expect(active.className).toMatch(/\btext-fg\b/);
    expect(active.className).not.toMatch(/\btext-primary\b/);
  });
});
