import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Switch } from './switch';

// T6.2.2 — the shadcn form primitives, first pass: each must render
// without throwing, reading only token classes (no-hex.test.ts is the
// gate that checks that part). Variant systems and interaction states
// (five Button variants, Input's error treatment) are T6.2.5/T6.2.6's job
// — this is the scaffold they build on.
describe('shadcn form primitives render without throwing', () => {
  it('Button', () => {
    render(<Button>Nuevo link</Button>);
    expect(screen.getByRole('button', { name: 'Nuevo link' })).toBeInTheDocument();
  });

  it('Input', () => {
    render(<Input placeholder="juano.posta.lat/____" />);
    expect(screen.getByPlaceholderText('juano.posta.lat/____')).toBeInTheDocument();
  });

  it('Select', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Elegí un tema" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="terminal">Terminal</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByText('Elegí un tema')).toBeInTheDocument();
  });

  it('Switch', () => {
    render(<Switch aria-label="modo oscuro" />);
    expect(screen.getByRole('switch', { name: 'modo oscuro' })).toBeInTheDocument();
  });
});
