'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { THEME_STORAGE_KEY } from './theme-script';

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// T6.1.11 — dark-first, SSR-safe by construction: the lazy useState
// initializer only touches `document` when `window` exists, so it
// evaluates to a static 'dark' on the server (identical markup every
// render) and, on the client, reads back whatever the blocking script
// above already applied to <html> BEFORE hydration — never the other way
// around. Skipping a "sync from storage" effect on top of this is
// deliberate: an effect runs after mount (and after paint), so using one
// here would let the initial 'dark' state briefly re-assert itself and
// tear the class back off between the blocking script and the effect —
// exactly the flash this task exists to prevent. The class-toggle effect
// below still exists for user-driven changes (setTheme) and now also
// persists — every commit (including the first, a harmless rewrite of the
// same value) writes the current theme back to storage.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }
    return document.documentElement.classList.contains('light') ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
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
