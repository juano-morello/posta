import { render } from '@testing-library/react';
import resolveConfig from 'tailwindcss/resolveConfig';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config';
import RootLayout from './layout';

describe('RootLayout', () => {
  it('preloads exactly the Space Grotesk 400 and JetBrains Mono 400 subsets', () => {
    render(
      <RootLayout>
        <p>content</p>
      </RootLayout>,
    );
    // React 19 hoists <link>/<meta> "resource" tags to the real
    // document.head wherever they're rendered in the tree — even though
    // layout.tsx nests them in an explicit <head>, they land on the
    // document's actual head, not inside the render container.
    const preloads = document.head.querySelectorAll('link[rel="preload"][as="font"]');
    expect(preloads).toHaveLength(2);

    const hrefs = [...preloads].map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/fonts/space-grotesk-400-latin.woff2');
    expect(hrefs).toContain('/fonts/jetbrains-mono-400-latin.woff2');

    for (const link of preloads) {
      expect(link.getAttribute('type')).toBe('font/woff2');
      expect(link.getAttribute('crossorigin')).toBe('anonymous');
    }
  });
});

describe('tailwind.config.ts font stacks', () => {
  it('resolves font-mono to the JetBrains Mono stack', () => {
    const resolved = resolveConfig(tailwindConfig);
    const mono = resolved.theme.fontFamily?.mono as string[] | undefined;
    expect(mono?.[0]).toBe('JetBrains Mono');
  });

  it('resolves font-sans to the Space Grotesk stack', () => {
    const resolved = resolveConfig(tailwindConfig);
    const sans = resolved.theme.fontFamily?.sans as string[] | undefined;
    expect(sans?.[0]).toBe('Space Grotesk');
  });
});
