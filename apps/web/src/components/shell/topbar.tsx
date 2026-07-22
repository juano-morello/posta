'use client';

import { useEffect, useState } from 'react';
import { Search, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// T6.3.3 — POSTA.md §3: topbar with ⌘K search affordance, avatar dropdown,
// lime "Nuevo link" CTA. The search opens nothing yet (S7.1 wires the
// command palette).
function useKeyboardHint(): string {
  // SSR-safe the same way ThemeProvider is (T6.1.11): `navigator` doesn't
  // exist on the server, and reading it during the initial CLIENT render
  // would render different text than the server did, mismatching
  // hydration. Rendering the same default everywhere on first paint and
  // correcting in an effect (after hydration) avoids that entirely — the
  // cost is a same-tick correction on non-Mac rather than a mismatch
  // warning.
  const [hint, setHint] = useState('⌘K');

  useEffect(() => {
    const isMac = /Mac|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
    if (!isMac) {
      setHint('Ctrl K');
    }
  }, []);

  return hint;
}

export function Topbar() {
  const keyboardHint = useKeyboardHint();

  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b border-border-subtle bg-surface px-6">
      <button
        type="button"
        className="flex w-full max-w-xs items-center gap-2 rounded border border-border bg-bg px-3 py-2 font-sans text-sm text-muted transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        <span className="flex-1 text-left">Buscar</span>
        <kbd className="rounded-badge border border-border px-1.5 py-0.5 font-mono text-xs text-muted">
          {keyboardHint}
        </kbd>
      </button>

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm">
          Nuevo link
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Cuenta"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-fg transition-colors hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <User className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem>Ajustes</DropdownMenuItem>
            <DropdownMenuItem>Salir</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
