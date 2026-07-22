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
});
