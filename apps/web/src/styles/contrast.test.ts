import { describe, expect, it } from 'vitest';
import { contrastRatio } from './color';
import { compileTokensCss, extractBlock, extractValue } from './compile-tokens';

// T6.1.14 [a11y] — WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text
// (>=24px, or >=18.66px bold — the hero numeral and button-fill text both
// clear that bar). This is the executable proof for POSTA.md §8's claim
// that pure lime (#B4FF39) fails AA on white, which is why light mode
// drops `primary` to #3F9142: measured, primary-fg/primary is 3.93:1 and
// primary/bg is 3.69:1 in light — comfortably above the 3:1 large-text
// floor, but well under 4.5:1, so those two pairs are judged as large
// text while the other four (plain body/caption copy) are held to 4.5:1.
const AA_NORMAL_TEXT = 4.5;
const AA_LARGE_TEXT = 3;

interface TextPair {
  name: string;
  fg: string;
  bg: string;
  minRatio: number;
}

function themeTextPairs(themeBlock: string): TextPair[] {
  const fg = extractValue(themeBlock, 'fg');
  const bg = extractValue(themeBlock, 'bg');
  const surface = extractValue(themeBlock, 'surface');
  const muted = extractValue(themeBlock, 'muted');
  const primary = extractValue(themeBlock, 'primary');
  const primaryFg = extractValue(themeBlock, 'primary-fg');

  return [
    { name: 'fg/bg', fg, bg, minRatio: AA_NORMAL_TEXT },
    { name: 'fg/surface', fg, bg: surface, minRatio: AA_NORMAL_TEXT },
    { name: 'muted/bg', fg: muted, bg, minRatio: AA_NORMAL_TEXT },
    { name: 'muted/surface', fg: muted, bg: surface, minRatio: AA_NORMAL_TEXT },
    // Large text: button fill labels and the hero "clicks reales" numeral.
    { name: 'primary-fg/primary', fg: primaryFg, bg: primary, minRatio: AA_LARGE_TEXT },
    { name: 'primary/bg', fg: primary, bg, minRatio: AA_LARGE_TEXT },
  ];
}

describe('AA contrast (T6.1.14)', () => {
  it('clears AA for every text pair in dark', () => {
    const root = extractBlock(compileTokensCss(), ':root');
    for (const pair of themeTextPairs(root)) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(ratio, `dark ${pair.name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.minRatio);
    }
  });

  it('clears AA for every text pair in light', () => {
    const light = extractBlock(compileTokensCss(), '.light');
    for (const pair of themeTextPairs(light)) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(ratio, `light ${pair.name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.minRatio);
    }
  });
});
