import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Posta',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <head>
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
      <body>{children}</body>
    </html>
  );
}
