'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Globe, Link2, Settings, User } from 'lucide-react';
import { cn } from '@/lib/utils';

// T6.3.1/T6.3.2 — POSTA.md §3: desktop (>=800px) sidebar, 220px, v1 route
// list (Links / Bio / Ajustes / Pública). The active item gets a left
// indicator bar + a lime tint background + aria-current="page" — but NOT
// lime text: S6.1's contrast review found regular-weight lime text on
// bg/surface only clears WCAG 1.4.3's 3:1 large-text floor (light
// primary/bg = 3.69:1), not the 4.5:1 normal text needs, and sidebar
// labels are body-scale (15-16px, DESIGN.md §3) — never large/bold enough
// to legitimately claim that exception. Same resolution as Tabs (T6.2.4):
// lime signals through the indicator + tint, the label stays in `fg`.
const ROUTES = [
  { href: '/', label: 'Links', icon: Link2 },
  { href: '/bio', label: 'Bio', icon: User },
  { href: '/ajustes', label: 'Ajustes', icon: Settings },
  { href: '/publica', label: 'Pública', icon: Globe },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Principal"
      className="flex w-[220px] shrink-0 flex-col border-r border-border-subtle bg-surface"
    >
      <ul className="flex flex-col gap-1 p-3">
        {ROUTES.map((route) => {
          const isActive = pathname === route.href;
          const Icon = route.icon;
          return (
            <li key={route.href}>
              <Link
                href={route.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded border-l-2 border-l-transparent px-3 py-2 font-sans text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg',
                  isActive &&
                    'border-l-primary bg-[color-mix(in_srgb,_var(--primary)_12%,_transparent)] text-fg',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {route.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
