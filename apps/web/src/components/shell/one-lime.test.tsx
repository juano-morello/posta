import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/lib/theme';
import { AppShell } from './app-shell';

// T6.3.10 — BRAND.md §0.2 / T6.3.6's own acceptance criterion: "the shell
// reserves [lime] for the active nav item, so screens must not add a
// second." Scoped to navigation landmarks specifically (<nav> elements),
// matching that literal framing — the always-present "Nuevo link" CTA
// button is a structurally-fixed, exactly-one-instance part of the shell
// (DESIGN.md/POSTA.md require it unconditionally, repeatedly, as ITS OWN
// element, not something a screen adds), not a competing "focus"; this
// gate is about nav highlighting not multiplying, not about the CTA.
//
// AppShell renders BOTH the desktop nav (Sidebar) and the mobile nav
// (BottomTabs) simultaneously in jsdom (no real CSS media-query
// evaluation) — they're marked `data-view="mobile-only"` /
// `hidden mobile:flex` respectively so this test can scope to one view
// (desktop) the same way a real browser's cascade would.
const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: usePathnameMock }));

function renderShell() {
  return render(
    <ThemeProvider>
      <AppShell>
        <p>contenido</p>
      </AppShell>
    </ThemeProvider>,
  );
}

/** Exact-token match — excludes `text-primary-fg` (a different, non-lime
 * token) and variant-prefixed occurrences like `hover:bg-primary` or
 * `focus-visible:border-primary` (conditionally applied, not a
 * statically-always-visible lime fill). Arbitrary-value backgrounds that
 * reference the `--primary` custom property (the tinted active-nav
 * background) count too — they render as lime just as much as a literal
 * `bg-primary` would. */
function usesPrimaryFill(className: string): boolean {
  return className.split(/\s+/).some((token) => {
    if (token.includes(':')) return false;
    if (token === 'bg-primary' || token === 'text-primary') return true;
    if (token.startsWith('bg-[') && token.includes('var(--primary)')) return true;
    return false;
  });
}

function countPrimaryFillsInNav(container: HTMLElement): number {
  const navs = [...container.querySelectorAll('nav')].filter(
    (nav) => nav.getAttribute('data-view') !== 'mobile-only',
  );
  let count = 0;
  for (const nav of navs) {
    for (const el of nav.querySelectorAll<HTMLElement>('*')) {
      // `.className` on an SVG element is an SVGAnimatedString, not a
      // plain string (lucide-react icons render <svg>) — getAttribute
      // returns a plain string uniformly for any element type.
      if (usesPrimaryFill(el.getAttribute('class') ?? '')) {
        count += 1;
      }
    }
  }
  return count;
}

describe('one lime focus per view (T6.3.10)', () => {
  it('the desktop nav has exactly one element using a primary background/text class', () => {
    usePathnameMock.mockReturnValue('/');
    const { container } = renderShell();
    expect(countPrimaryFillsInNav(container)).toBe(1);
  });

  it('fails if a second lime element is added to the nav', () => {
    usePathnameMock.mockReturnValue('/');
    const { container } = renderShell();
    const nav = container.querySelector('nav:not([data-view="mobile-only"])')!;
    const intruder = document.createElement('span');
    intruder.className = 'bg-primary';
    nav.appendChild(intruder);
    expect(countPrimaryFillsInNav(container)).toBe(2);
  });
});
