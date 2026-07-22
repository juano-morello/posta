import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTrigger } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Sheet, SheetContent, SheetTrigger } from './sheet';
import { Toast, ToastProvider, ToastTitle, ToastViewport } from './toast';

// T6.2.8 — DESIGN.md §2.3: elevation is reserved for exactly four real
// overlays (dropdown, dialog/modal, drawer/sheet, toast). This is the gate
// on BOTH halves of that claim: the four DO carry the shadow, and nothing
// ELSE under components/ui reaches for it — a flat surface (Card,
// tooltip, select) that started borrowing `shadow-overlay` "just for a
// bit more depth" would be exactly the drift DESIGN.md's "prefer border
// to shadow" rule is meant to prevent.
const UI_DIR = path.resolve(__dirname, '.');
const FILES_ALLOWED_TO_REFERENCE_IT = new Set([
  'dialog.tsx',
  'sheet.tsx',
  'dropdown-menu.tsx',
  'toast.tsx',
]);

describe('shadow-overlay is reserved for the four real overlays', () => {
  it('Dialog content carries shadow-overlay', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>abrir</DialogTrigger>
        <DialogContent>contenido</DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByText('abrir'));
    expect((await screen.findByRole('dialog')).className).toMatch(/\bshadow-overlay\b/);
  });

  it('Sheet content carries shadow-overlay', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>abrir</SheetTrigger>
        <SheetContent>contenido</SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByText('abrir'));
    expect((await screen.findByRole('dialog')).className).toMatch(/\bshadow-overlay\b/);
  });

  it('DropdownMenu content carries shadow-overlay', async () => {
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
    expect((await screen.findByRole('menu')).className).toMatch(/\bshadow-overlay\b/);
  });

  it('Toast carries shadow-overlay', () => {
    render(
      <ToastProvider>
        <Toast open data-testid="toast-root">
          <ToastTitle>listo</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    expect(screen.getByTestId('toast-root').className).toMatch(/\bshadow-overlay\b/);
  });

  it('no other file under components/ui references shadow-overlay', () => {
    const offenders = readdirSync(UI_DIR)
      .filter((entry) => entry.endsWith('.tsx') && !entry.endsWith('.test.tsx'))
      .filter((entry) => !FILES_ALLOWED_TO_REFERENCE_IT.has(entry))
      .filter((entry) => readFileSync(path.join(UI_DIR, entry), 'utf-8').includes('shadow-overlay'));
    expect(offenders).toEqual([]);
  });
});
