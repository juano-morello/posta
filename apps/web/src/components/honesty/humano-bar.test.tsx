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
