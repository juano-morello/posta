import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from './input';

// T6.2.6 — DESIGN.md §4: "focus = --ring + halo 0 0 0 3px ring/25%. Error =
// borde --error + halo." The error state must be perceivable by more than
// colour alone (an AT user never sees the red border) — that's what
// aria-invalid + aria-describedby linking the mono message actually buys,
// and is the part this test holds to a real assertion rather than a
// visual-only claim.
describe('Input error treatment', () => {
  it('has no aria-invalid/aria-describedby when there is no error', () => {
    render(<Input placeholder="juano.example.test/____" />);
    const input = screen.getByPlaceholderText('juano.example.test/____');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('sets aria-invalid="true" and links the message via aria-describedby', () => {
    render(<Input placeholder="slug" error="ese slug ya existe — probá otro" />);
    const input = screen.getByPlaceholderText('slug');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const message = document.getElementById(describedBy!);
    expect(message).not.toBeNull();
    expect(message).toHaveTextContent('ese slug ya existe — probá otro');
  });

  it('applies the error border/halo classes only when in error', () => {
    const { rerender } = render(<Input placeholder="slug" />);
    let input = screen.getByPlaceholderText('slug');
    expect(input.className).toMatch(/border-border/);
    expect(input.className).not.toMatch(/border-error/);

    rerender(<Input placeholder="slug" error="ese slug ya existe" />);
    input = screen.getByPlaceholderText('slug');
    expect(input.className).toMatch(/border-error/);
  });
});
