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
