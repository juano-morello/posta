import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HumanoBar } from './humano-bar';

// T6.4.3 — POSTA.md §1: humans in lime, bots/unfurlers/prefetch across the
// n1/n2/n3 gray ramp, 16px bar, 2px gaps, radius-badge (the honesty
// primitives' signature component).
describe('HumanoBar segment widths', () => {
  it('renders four segments proportional to their counts', () => {
    render(<HumanoBar humano={60} bot={20} unfurler={12} prefetch={8} />);
    const bar = screen.getByTestId('humano-bar');
    expect(bar.className).toMatch(/\bh-4\b/);
    expect(bar.className).toMatch(/rounded-badge/);

    const humano = screen.getByTestId('humano-bar-segment-humano');
    const bot = screen.getByTestId('humano-bar-segment-bot');
    const unfurler = screen.getByTestId('humano-bar-segment-unfurler');
    const prefetch = screen.getByTestId('humano-bar-segment-prefetch');

    expect(humano.style.width).toBe('60%');
    expect(bot.style.width).toBe('20%');
    expect(unfurler.style.width).toBe('12%');
    expect(prefetch.style.width).toBe('8%');

    expect(humano.className).toMatch(/\bbg-primary\b/);
    expect(bot.className).toMatch(/\bbg-n1\b/);
    expect(unfurler.className).toMatch(/\bbg-n2\b/);
    expect(prefetch.className).toMatch(/\bbg-n3\b/);
  });
});

// T6.4.4 — three edge cases that collapse the naive `count / total`
// division: a total of 0 (nothing has happened yet — no clicks at all),
// 100% human (no bots ever), and 0% human (every click filtered). None of
// them may divide by zero into NaN, and the track's 16px height must not
// visually collapse in any of them — an inert empty bar still needs to
// look like a bar, not vanish.
describe('HumanoBar edge cases', () => {
  it('renders an inert empty track for zero clicks — no NaN width', () => {
    render(<HumanoBar humano={0} bot={0} unfurler={0} prefetch={0} />);
    const bar = screen.getByTestId('humano-bar');
    expect(bar.className).toMatch(/\bh-4\b/);
    for (const key of ['humano', 'bot', 'unfurler', 'prefetch']) {
      const segment = screen.getByTestId(`humano-bar-segment-${key}`);
      expect(segment.style.width).not.toBe('NaN%');
      expect(segment.style.width).toBe('0%');
    }
  });

  it('renders one full lime segment for 100% human', () => {
    render(<HumanoBar humano={100} bot={0} unfurler={0} prefetch={0} />);
    const bar = screen.getByTestId('humano-bar');
    expect(bar.className).toMatch(/\bh-4\b/);
    expect(screen.getByTestId('humano-bar-segment-humano').style.width).toBe('100%');
    expect(screen.getByTestId('humano-bar-segment-bot').style.width).toBe('0%');
  });

  it('renders the full gray ramp with no lime for 0% human', () => {
    render(<HumanoBar humano={0} bot={50} unfurler={30} prefetch={20} />);
    const bar = screen.getByTestId('humano-bar');
    expect(bar.className).toMatch(/\bh-4\b/);
    expect(screen.getByTestId('humano-bar-segment-humano').style.width).toBe('0%');
    expect(screen.getByTestId('humano-bar-segment-bot').style.width).toBe('50%');
    expect(screen.getByTestId('humano-bar-segment-unfurler').style.width).toBe('30%');
    expect(screen.getByTestId('humano-bar-segment-prefetch').style.width).toBe('20%');
  });
});

// T6.4.5 — a segment that rounds away to a sliver of a pixel is a
// rounded-away LIE, not a rendering nicety: the whole point of the
// honesty primitives is that a single filtered click stays visible. The
// floored segment's width is asserted with a tolerance (not an exact
// literal) since the exact minimum is an implementation constant, not a
// contract; what's load-bearing is (a) it clears some real visible floor
// and (b) the total still sums to 100 — the floor must come FROM the
// larger segments shrinking, never from thin air.
describe('HumanoBar sub-1% segment visibility', () => {
  function widthPct(testId: string): number {
    const style = screen.getByTestId(testId).style.width;
    expect(style.endsWith('%')).toBe(true);
    return parseFloat(style);
  }

  it('keeps a 1-in-10000 segment visible and widths summing to 100%', () => {
    render(<HumanoBar humano={9999} bot={1} unfurler={0} prefetch={0} />);

    const botPct = widthPct('humano-bar-segment-bot');
    // 1/10000 = 0.01% raw — must be floored well above that.
    expect(botPct).toBeGreaterThanOrEqual(1);

    const humanoPct = widthPct('humano-bar-segment-humano');
    const unfurlerPct = widthPct('humano-bar-segment-unfurler');
    const prefetchPct = widthPct('humano-bar-segment-prefetch');
    expect(humanoPct + botPct + unfurlerPct + prefetchPct).toBeCloseTo(100, 5);

    // The floor came from humano shrinking, not from nowhere.
    expect(humanoPct).toBeLessThan(100);
  });

  it('never floors a genuinely zero segment', () => {
    render(<HumanoBar humano={9999} bot={1} unfurler={0} prefetch={0} />);
    expect(widthPct('humano-bar-segment-unfurler')).toBe(0);
    expect(widthPct('humano-bar-segment-prefetch')).toBe(0);
  });
});
