import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Topbar } from './topbar';

// T6.3.3 — POSTA.md §3: topbar with ⌘K search, avatar, lime "Nuevo link".
// The ⌘K/Ctrl K hint depends on the platform, which only exists client-
// side (`navigator`) — reading it during render would mismatch server vs.
// client markup, so the component renders the same "⌘K" on first paint
// everywhere (matching SSR) and corrects to "Ctrl K" in an effect after
// mount, exactly like ThemeProvider's SSR-safe pattern (T6.1.11/12). That
// means the non-Mac case only becomes visible after the effect flushes.
function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
}

const REAL_USER_AGENT = window.navigator.userAgent;

describe('Topbar', () => {
  afterEach(() => {
    setUserAgent(REAL_USER_AGENT);
  });

  it('renders the ⌘K hint on Mac', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    render(<Topbar />);
    await waitFor(() => expect(screen.getByText('⌘K')).toBeInTheDocument());
  });

  it('renders the Ctrl K hint on non-Mac', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    render(<Topbar />);
    await waitFor(() => expect(screen.getByText('Ctrl K')).toBeInTheDocument());
  });

  it('renders the lime "Nuevo link" CTA', () => {
    render(<Topbar />);
    expect(screen.getByRole('button', { name: 'Nuevo link' })).toBeInTheDocument();
  });

  it('renders an avatar trigger', () => {
    render(<Topbar />);
    expect(screen.getByRole('button', { name: /cuenta/i })).toBeInTheDocument();
  });
});
