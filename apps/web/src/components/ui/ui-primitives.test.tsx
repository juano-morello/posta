import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { Dialog, DialogContent, DialogTrigger } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Sheet, SheetContent, SheetTrigger } from './sheet';
import { Switch } from './switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

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

// T6.2.3 — the shadcn overlay primitives. "Traps focus" is asserted the
// way it actually matters for a keyboard user: after opening, the
// currently-focused element is somewhere INSIDE the panel, never left
// behind on the page underneath it. Radix's FocusScope (wrapped by
// Dialog/DropdownMenu/Tooltip's Content) is what makes that true; this is
// the regression guard on that behavior, not a reimplementation of it.
describe('shadcn overlay primitives open on trigger and trap focus', () => {
  it('Dialog', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>abrir</DialogTrigger>
        <DialogContent>
          <button>dentro del modal</button>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByText('abrir'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('DropdownMenu', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>opciones</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Editar</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByText('opciones'));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it('Tooltip', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>copiar</TooltipTrigger>
          <TooltipContent>copiado: juano.posta.lat/promo</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await user.hover(screen.getByText('copiar'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('copiado: juano.posta.lat/promo');
  });

  it('Sheet', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>nuevo link</SheetTrigger>
        <SheetContent>
          <button>dentro del sheet</button>
        </SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByText('nuevo link'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
