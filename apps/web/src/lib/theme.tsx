'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// T6.1.11 — dark-first: the initial state is a plain `useState('dark')`,
// never a read of `window`/`localStorage`/`matchMedia` during render. That
// is what makes this SSR-safe by construction: render output is identical
// on the server and the client, and the whole component tree can run
// through `renderToString` with no DOM globals in scope at all. The actual
// `.light` class toggle happens in an effect (runs after mount, never
// during SSR) rather than inside `setTheme` itself, so state and the DOM
// side effect stay decoupled. T6.1.12 layers persistence on top of this
// without touching the render path.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be called within a ThemeProvider');
  }
  return context;
}
