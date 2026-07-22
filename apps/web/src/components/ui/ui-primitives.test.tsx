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
import { Badge } from './badge';
import { Sheet, SheetContent, SheetTrigger } from './sheet';
import { Skeleton } from './skeleton';
import { Switch } from './switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { Toast, ToastProvider, ToastTitle, ToastViewport } from './toast';
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

// T6.2.4 — the shadcn feedback primitives.
describe('shadcn feedback primitives', () => {
  it('Toast renders without throwing', () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastTitle>link creado: juano.posta.lat/promo</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    expect(screen.getByText('link creado: juano.posta.lat/promo')).toBeInTheDocument();
  });

  it('Skeleton renders without throwing', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('Badge renders without throwing', () => {
    render(<Badge>% humano</Badge>);
    expect(screen.getByText('% humano')).toBeInTheDocument();
  });

  it('Tabs marks only the active tab with the lime border-bottom underline', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="dia">
        <TabsList>
          <TabsTrigger value="dia">7d</TabsTrigger>
          <TabsTrigger value="mes">30d</TabsTrigger>
        </TabsList>
        <TabsContent value="dia">siete días</TabsContent>
        <TabsContent value="mes">treinta días</TabsContent>
      </Tabs>,
    );

    // The `data-[state=active]:border-primary` class is a Tailwind
    // ATTRIBUTE-VARIANT — it is present in every trigger's static
    // className string regardless of which tab is selected; the browser's
    // CSS engine (not React, and not jsdom, which doesn't evaluate the
    // cascade) decides whether it actually applies, based on the
    // `data-state` attribute at render time. So the meaningful assertions
    // here are: (1) the rule referencing `border-primary` is wired up on
    // every trigger, and (2) Radix's own `data-state` — the actual source
    // of truth for which tab is active — updates correctly on click.
    const dayTab = screen.getByRole('tab', { name: '7d' });
    const monthTab = screen.getByRole('tab', { name: '30d' });
    for (const tab of [dayTab, monthTab]) {
      expect(tab.className).toMatch(/data-\[state=active\]:border-primary/);
    }

    expect(dayTab).toHaveAttribute('data-state', 'active');
    expect(monthTab).toHaveAttribute('data-state', 'inactive');

    await user.click(monthTab);
    expect(monthTab).toHaveAttribute('data-state', 'active');
    expect(dayTab).toHaveAttribute('data-state', 'inactive');
  });
});
