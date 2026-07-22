import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme';

function ThemeToggleProbe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button onClick={() => setTheme('light')}>go light</button>
    </div>
  );
}

describe('ThemeProvider (T6.1.11 — SSR-safe)', () => {
  it('renders via renderToString with no `window` global in scope', () => {
    // jsdom's test environment always provides `window`, so a naive
    // "renderToString doesn't throw" assertion would pass even if the
    // component carelessly read window/localStorage during render.
    // Deleting the global for the duration of this one assertion makes
    // the test actually meaningful: it fails loudly the moment render
    // touches a DOM global that a real Node SSR pass would not have.
    const realWindow = globalThis.window;
    // @ts-expect-error simulating an SSR environment with no window global
    delete globalThis.window;
    try {
      const html = renderToString(
        <ThemeProvider>
          <p>hola</p>
        </ThemeProvider>,
      );
      expect(html).toContain('hola');
    } finally {
      globalThis.window = realWindow;
    }
  });

  it("defaults to dark and toggles the .light class on <html> when setTheme('light') runs", () => {
    document.documentElement.classList.remove('light');
    render(
      <ThemeProvider>
        <ThemeToggleProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);

    act(() => {
      fireEvent.click(screen.getByText('go light'));
    });

    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('throws a clear error when useTheme is called outside a ThemeProvider', () => {
    function Orphan() {
      useTheme();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/ThemeProvider/);
  });
});
