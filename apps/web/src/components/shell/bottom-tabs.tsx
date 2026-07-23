'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Globe, Link2, Settings, User } from 'lucide-react';
import { cn } from '@/lib/utils';

// T6.3.4 — POSTA.md §3: mobile (<800px) fixed bottom tab bar, same four
// v1 routes as the Sidebar, icon-over-label. Active tab marking mirrors
// Sidebar's resolution (T6.3.2): lime lives on the icon + aria-current,
// never on regular-weight label text (S6.1's contrast review — light
// primary/bg is 3.69:1, under the 4.5:1 normal-text floor). Safe-area
// inset and the 44px hit-target floor land in T6.3.5.
const ROUTES = [
  { href: '/', label: 'Links', icon: Link2 },
  { href: '/bio', label: 'Bio', icon: User },
  { href: '/ajustes', label: 'Ajustes', icon: Settings },
  { href: '/publica', label: 'Pública', icon: Globe },
] as const;

export function BottomTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Principal"
      // T6.3.5 [a11y] — iOS home-indicator devices clip content flush to
      // the bottom edge without the safe-area padding below. A React
      // inline style doesn't survive jsdom (its CSSStyleDeclaration
      // setter rejects env() outright), but a plain Tailwind arbitrary-
      // value utility is just a compile-time string — no runtime
      // validation applies. NOTE: never write that utility's own class
      // name inside a comment — Tailwind's content scanner is a plain
      // text regex with no code-vs-comment awareness, and it generated
      // broken CSS from a literal example once already (T6.3.6).
      // T6.3.6 — hidden from the `mobile` (800px) breakpoint up, where
      // AppShell renders the Sidebar instead.
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border-subtle bg-surface pb-[env(safe-area-inset-bottom)] mobile:hidden"
    >
      {ROUTES.map((route) => {
        const isActive = pathname === route.href;
        const Icon = route.icon;
        return (
          <Link
            key={route.href}
            href={route.href}
            aria-current={isActive ? 'page' : undefined}
            // T6.3.5 [a11y] — WCAG 2.5.5/2.5.8 target-size floor: every
            // tab is at least 44x44px regardless of content size.
            className="flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-1 py-2 font-sans text-xs text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <Icon className={cn('h-5 w-5', isActive ? 'text-primary' : 'text-muted')} aria-hidden="true" />
            <span className={cn(isActive && 'text-fg')}>{route.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
