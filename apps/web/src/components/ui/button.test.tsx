import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';

// T6.2.5 — DESIGN.md §4's five variants, each still bound only to token
// classes (no-hex.test.ts is the gate for that). The a11y-carry-forward
// from S6.1's review is enforced here too: `primary` and `destructive`
// render their label on a colour fill that only clears AA at large/bold
// text size in the weaker theme (light primary-fg/primary = 3.93:1, dark
// destructive-foreground/destructive = 3.35:1) — both need text-lg
// (18px) + font-bold to legitimately claim the WCAG 1.4.3 large-text 3:1
// exception rather than silently failing real AA.
const VARIANTS = ['primary', 'secondary', 'outline', 'ghost', 'destructive'] as const;

describe('Button variants', () => {
  it.each(VARIANTS)('renders the %s variant', (variant) => {
    render(<Button variant={variant}>Nuevo link</Button>);
    expect(screen.getByRole('button', { name: 'Nuevo link' })).toBeInTheDocument();
  });

  it.each(['primary', 'destructive'] as const)(
    'renders the %s variant label as large/bold text (WCAG 1.4.3 large-text exception)',
    (variant) => {
      render(<Button variant={variant}>Nuevo link</Button>);
      const button = screen.getByRole('button', { name: 'Nuevo link' });
      expect(button.className).toMatch(/text-lg/);
      expect(button.className).toMatch(/font-bold/);
    },
  );

  it('renders sm/md/lg sizes', () => {
    const { rerender } = render(<Button size="sm">chico</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
    rerender(<Button size="md">medio</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
    rerender(<Button size="lg">grande</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});

describe('Button states', () => {
  it('disabled sets both the native disabled state and aria-disabled', () => {
    render(<Button disabled>Nuevo link</Button>);
    const button = screen.getByRole('button', { name: 'Nuevo link' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('loading sets aria-busy and blocks the click handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Nuevo link
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Nuevo link' });
    expect(button).toHaveAttribute('aria-busy', 'true');

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a non-loading, non-disabled button still calls the click handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Nuevo link</Button>);
    await user.click(screen.getByRole('button', { name: 'Nuevo link' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
