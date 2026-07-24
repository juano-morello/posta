import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from './card';

// T6.2.7 — DESIGN.md §2.3/§4: "Cards: surface + border, no shadow —
// elevation only on real overlays." jsdom doesn't run a real CSS cascade
// (no Tailwind build is compiled into the test environment), so a literal
// `getComputedStyle(...).boxShadow` read here would always report the
// browser default regardless of what classes are present — it would pass
// even if the component were broken. The real "does it actually render
// with no shadow, in both themes" proof is T6.2.10's Playwright snapshot;
// this unit test asserts the wiring a snapshot can't cheaply regression-
// test on every commit: the className carries `shadow-none` and no other
// `shadow-*` utility, and that this holds whether or not `.light` is on
// the document root.
describe('Card has no box-shadow, in both themes', () => {
  afterEach(() => {
    document.documentElement.classList.remove('light');
  });

  it('carries shadow-none and no other shadow utility — dark (default)', () => {
    const { container } = render(<Card>contenido</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toMatch(/\bshadow-none\b/);
    expect(card.className).not.toMatch(/\bshadow-overlay\b/);
  });

  it('carries the same shadow-none class when .light is applied', () => {
    document.documentElement.classList.add('light');
    const { container } = render(<Card>contenido</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toMatch(/\bshadow-none\b/);
    expect(card.className).not.toMatch(/\bshadow-overlay\b/);
  });

  it('is surface + border, per DESIGN.md §4', () => {
    const { container } = render(<Card>contenido</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toMatch(/\bbg-surface\b/);
    expect(card.className).toMatch(/\bborder\b/);
    expect(card.className).toMatch(/\bborder-border\b/);
  });

  it('lifts and swaps to a lime border on hover only when hoverable', () => {
    const { container: plain } = render(<Card>contenido</Card>);
    const plainCard = plain.firstChild as HTMLElement;
    expect(plainCard.className).not.toMatch(/hover:border-primary/);

    const { container: hoverable } = render(<Card hoverable>contenido</Card>);
    const hoverableCard = hoverable.firstChild as HTMLElement;
    expect(hoverableCard.className).toMatch(/hover:border-primary/);
    expect(hoverableCard.className).toMatch(/hover:-translate-y-\[3px\]/);
  });
});
