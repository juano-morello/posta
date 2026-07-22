import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Toast, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from './toast';

// T6.2.9 — POSTA.md §6: toast copy is mono microcopy. Literal domain
// strings can't live in apps/web source (tests/conventions/
// no-literal-domain.test.ts, an E0 invariant — it scans comments too, not
// just executable code) — "juano.example.test" is this repo's established
// placeholder for "the real host, illustratively" (see T6.2.3/T6.2.4's
// fixtures), standing in for the product's actual link-domain example.
const SAMPLE_COPY = {
  copied: 'copiado: juano.example.test/promo',
  created: 'link creado: juano.example.test/promo',
} as const;

describe('Toast — mono, tight radius, lime accent bar (T6.2.9)', () => {
  it('renders the description in font-mono', () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastTitle>listo</ToastTitle>
          <ToastDescription>{SAMPLE_COPY.copied}</ToastDescription>
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    const description = screen.getByText(SAMPLE_COPY.copied);
    expect(description).toHaveTextContent(SAMPLE_COPY.copied);
    expect(description.className).toMatch(/\bfont-mono\b/);
  });

  it('renders the rioplatense sample copy unchanged', () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastDescription>{SAMPLE_COPY.created}</ToastDescription>
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    expect(screen.getByText(SAMPLE_COPY.created)).toHaveTextContent(
      'link creado: juano.example.test/promo',
    );
  });

  it('default variant carries a lime accent bar and tight radius', () => {
    render(
      <ToastProvider>
        <Toast open data-testid="toast-default">
          <ToastTitle>listo</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    const toast = screen.getByTestId('toast-default');
    expect(toast.className).toMatch(/\brounded-sm\b/);
    expect(toast.className).toMatch(/border-l-primary/);
  });

  it('destructive variant stays on --error, not the lime accent bar', () => {
    render(
      <ToastProvider>
        <Toast open variant="destructive" data-testid="toast-destructive">
          <ToastTitle>error</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    const toast = screen.getByTestId('toast-destructive');
    expect(toast.className).toMatch(/border-l-error/);
    expect(toast.className).not.toMatch(/border-l-primary/);
  });
});
