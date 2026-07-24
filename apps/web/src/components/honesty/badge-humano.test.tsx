import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compileTokensCss } from '@/styles/compile-tokens';
import { BadgeHumano } from './badge-humano';

// T6.4.7 — POSTA.md §8.4's `.badge-humano`: "% humano", mono 600, lime
// text on a color-mix(in srgb, var(--primary) 16%, transparent) tint with
// a 40%-tint border. The class lives in _tokens.scss (not a Tailwind
// arbitrary-value bracket, unlike Badge's own `primary` variant, T6.2.4)
// specifically so color-mix() survives real Sass compilation — verified
// against the ACTUAL compiled output below, not just a className string.
describe('BadgeHumano', () => {
  it('renders the rounded percentage with the "humano" label', () => {
    render(<BadgeHumano percent={87.3} />);
    expect(screen.getByText('87% humano')).toBeInTheDocument();
  });

  it('applies the badge-humano class carrying the color-mix tint', () => {
    render(<BadgeHumano percent={50} />);
    expect(screen.getByText('50% humano').className).toMatch(/\bbadge-humano\b/);
  });

  it('clamps a non-finite percentage to 0 rather than rendering NaN', () => {
    render(<BadgeHumano percent={NaN} />);
    expect(screen.getByText('0% humano')).toBeInTheDocument();
  });

  it('clamps out-of-range percentages into 0-100', () => {
    render(<BadgeHumano percent={142} />);
    expect(screen.getByText('100% humano')).toBeInTheDocument();
  });
});

describe('badge-humano compiled CSS (T6.4.7)', () => {
  it('keeps color-mix(in srgb, var(--primary) 16%, transparent) literal in the emitted stylesheet', () => {
    const css = compileTokensCss();
    expect(css).toContain('color-mix(in srgb, var(--primary) 16%');
  });

  it('keeps the 40%-tint border literal in the emitted stylesheet', () => {
    const css = compileTokensCss();
    expect(css).toContain('color-mix(in srgb, var(--primary) 40%');
  });
});
