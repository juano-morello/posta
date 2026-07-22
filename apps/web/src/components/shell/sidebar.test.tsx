import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sidebar } from './sidebar';

// T6.3.1 — POSTA.md §3: desktop sidebar, 220px, v1 route list
// (Links / Bio / Ajustes / Pública). Structure only — active-item marking
// (T6.3.2) reads the current route, which needs a router context this
// story doesn't have yet.
describe('Sidebar', () => {
  it('renders as a 220px navigation rail with the four v1 routes', () => {
    render(<Sidebar />);

    const nav = screen.getByRole('navigation');
    expect(nav.className).toMatch(/w-\[220px\]/);

    for (const label of ['Links', 'Bio', 'Ajustes', 'Pública']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});
