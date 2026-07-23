import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourceChip } from './source-chip';

// T6.4.8 — POSTA.md §1/§8.4: "Source-platform chips — Instagram / WhatsApp
// / TikTok / directo, mono, each with a colored dot." Four platforms, four
// visually distinct dots, so the fuentes breakdown reads at a glance.
describe('SourceChip', () => {
  it.each([
    ['Instagram', 'source-chip-dot--instagram'],
    ['WhatsApp', 'source-chip-dot--whatsapp'],
    ['TikTok', 'source-chip-dot--tiktok'],
    ['directo', 'source-chip-dot--directo'],
  ] as const)('renders the %s label with its own dot class', (platform, dotClass) => {
    render(<SourceChip platform={platform} />);
    expect(screen.getByText(platform)).toBeInTheDocument();
    const dot = screen.getByTestId('source-chip-dot');
    expect(dot.className).toMatch(new RegExp(`\\b${dotClass}\\b`));
  });

  it('gives every platform a distinct dot class from the others', () => {
    const classes = new Set<string>();
    for (const platform of ['Instagram', 'WhatsApp', 'TikTok', 'directo'] as const) {
      const { unmount } = render(<SourceChip platform={platform} />);
      classes.add(screen.getByTestId('source-chip-dot').className);
      unmount();
    }
    expect(classes.size).toBe(4);
  });
});

// T6.4.9 — source_platform is a free-text column the worker's enrichment
// (E3) writes; the four-member zSourcePlatform enum is what the
// DASHBOARD is prepared to render distinctly, not a runtime constraint
// the database enforces. A referrer shape the worker doesn't recognize
// yet — or none at all — must still render a real chip, never a blank
// one: it falls back to `directo`.
describe('SourceChip unknown-platform fallback', () => {
  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['an unrecognized platform', 'Threads'],
  ])('renders the directo chip for %s', (_label, platform) => {
    render(<SourceChip platform={platform} />);
    expect(screen.getByText('directo')).toBeInTheDocument();
    expect(screen.getByTestId('source-chip-dot').className).toMatch(/\bsource-chip-dot--directo\b/);
  });
});
