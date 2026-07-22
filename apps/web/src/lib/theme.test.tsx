import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme';
import { THEME_STORAGE_KEY, themeInitScript } from './theme-script';

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

describe('themeInitScript (T6.1.12 — blocks the flash of wrong theme)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('light');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('light');
  });

  function runScript(): void {
    // eslint-disable-next-line no-new-func -- exercising the exact source
    // string that gets inlined into <head>, not a hand-written stand-in.
    new Function(themeInitScript())();
  }

  it('resolves to dark (no .light class) when storage is empty', () => {
    runScript();
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('applies .light before hydration when storage already says light', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runScript();
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('never throws even if localStorage access itself throws (private-mode Safari, etc.)', () => {
    const originalGetItem = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error('storage disabled');
    };
    try {
      expect(runScript).not.toThrow();
      // falls back to dark — the safe default — rather than crashing.
      expect(document.documentElement.classList.contains('light')).toBe(false);
    } finally {
      window.localStorage.getItem = originalGetItem;
    }
  });

  it('persists the theme to localStorage under posta-theme when setTheme runs', () => {
    render(
      <ThemeProvider>
        <ThemeToggleProbe />
      </ThemeProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('go light'));
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it("hydrates its initial state from whatever the blocking script already applied to <html> (no flash)", () => {
    // Simulates what actually happens in the browser: the blocking script
    // runs first and sets the class BEFORE React ever mounts. If
    // ThemeProvider's initial state ignored that and defaulted to 'dark'
    // regardless, its very first effect would immediately rip the class
    // back off — the flash this task exists to prevent.
    document.documentElement.classList.add('light');
    render(
      <ThemeProvider>
        <ThemeToggleProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
