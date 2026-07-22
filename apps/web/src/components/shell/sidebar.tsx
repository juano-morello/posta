import Link from 'next/link';
import { Globe, Link2, Settings, User } from 'lucide-react';

// T6.3.1 — POSTA.md §3: desktop (>=800px) sidebar, 220px, v1 route list
// (Links / Bio / Ajustes / Pública). Structure only — active-item styling
// (indicator, tint, aria-current) lands in T6.3.2.
const ROUTES = [
  { href: '/', label: 'Links', icon: Link2 },
  { href: '/bio', label: 'Bio', icon: User },
  { href: '/ajustes', label: 'Ajustes', icon: Settings },
  { href: '/publica', label: 'Pública', icon: Globe },
] as const;

export function Sidebar() {
  return (
    <nav
      aria-label="Principal"
      className="flex w-[220px] shrink-0 flex-col border-r border-border-subtle bg-surface"
    >
      <ul className="flex flex-col gap-1 p-3">
        {ROUTES.map((route) => {
          const Icon = route.icon;
          return (
            <li key={route.href}>
              <Link
                href={route.href}
                className="flex items-center gap-3 rounded border-l-2 border-l-transparent px-3 py-2 font-sans text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
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
