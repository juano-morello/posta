import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';
import { ThemeProvider } from '@/lib/theme';
import { themeInitScript } from '@/lib/theme-script';

export const metadata: Metadata = {
  title: 'Posta',
};

// T6.3.5 [a11y] — FOUND during this story's a11y review: BottomTabs'
// pb-[env(safe-area-inset-bottom)] compiles to correct CSS, but every
// env(safe-area-inset-*) variable resolves to 0 unless the page's
// viewport declares viewport-fit=cover (CSS Environment Variables spec).
// Without this, the safe-area padding this task shipped was a no-op —
// syntactically present, doing nothing on a real notched device. Next.js
// 13+ splits `viewport` out of `metadata` into its own export.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <head>
        {/* T6.1.12 — must run before the rest of the document paints, so
            it is a plain synchronous script (no `defer`/`async`, no
            React-managed rendering) placed first in <head>. The content
            is themeInitScript()'s own fixed, self-authored source — no
            user/request input ever reaches this string — so inlining it
            is the standard, safe pre-hydration theme-flash guard (the
            same technique next-themes and similar libraries use). */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
        {/* T6.1.9 — preload the 400-weight (latin subset) of each
            self-hosted family so the first paint doesn't wait on font
            discovery; crossOrigin is required for font preloads even
            same-origin (fonts are fetched in "anonymous" CORS mode). */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/space-grotesk-400-latin.woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/jetbrains-mono-400-latin.woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
