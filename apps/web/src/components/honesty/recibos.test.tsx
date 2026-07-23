import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Recibos, type Recibo } from './recibos';

// T6.4.11 — POSTA.md §5/§8.4: each row is `time · source · [classification]
// · why`, with the bracketed verdict coloured from the T6.4.2 map. Colours
// here are the FIXED dark-mode hex (never a `t()`/var() token): Recibos'
// background never themes (T6.4.10), and light mode's semantic colours
// are tuned for legibility against a LIGHT page — using them unmodified
// here would make e.g. light's error (#CF222E, tuned for white) read as
// low-contrast dark-red-on-near-black the instant a user flips themes.
const ROWS: Recibo[] = [
  { id: '01J000000000000000000001', t: '14:32:01', src: 'Instagram', cls: 'bot', why: "user-agent 'python-requests'" },
  { id: '01J000000000000000000002', t: '14:31:47', src: 'directo', cls: 'prefetch', why: 'preview de link · dwell 0 ms' },
  { id: '01J000000000000000000003', t: '14:31:20', src: 'WhatsApp', cls: 'unfurler', why: 'facebookexternalhit' },
  { id: '01J000000000000000000004', t: '14:30:58', src: 'TikTok', cls: 'humano', why: '—' },
];

describe('Recibos rows (T6.4.11)', () => {
  it('renders time, source, bracketed classification and why for every row', () => {
    render(<Recibos slug="promo" receipts={ROWS} />);

    for (const row of ROWS) {
      expect(screen.getByText(row.t)).toBeInTheDocument();
      expect(screen.getByText(row.src)).toBeInTheDocument();
      expect(screen.getByText(`[${row.cls}]`)).toBeInTheDocument();
      expect(screen.getByText(row.why)).toBeInTheDocument();
    }
  });

  it('colours a bot row with the error token class', () => {
    render(<Recibos slug="promo" receipts={ROWS} />);
    expect(screen.getByText('[bot]').className).toMatch(/\bcls-error\b/);
  });

  it('colours a prefetch row with the warning token class', () => {
    render(<Recibos slug="promo" receipts={ROWS} />);
    expect(screen.getByText('[prefetch]').className).toMatch(/\bcls-warning\b/);
  });

  it('colours an unfurler row with the info token class', () => {
    render(<Recibos slug="promo" receipts={ROWS} />);
    expect(screen.getByText('[unfurler]').className).toMatch(/\bcls-info\b/);
  });

  it('colours a humano row with the primary token class', () => {
    render(<Recibos slug="promo" receipts={ROWS} />);
    expect(screen.getByText('[humano]').className).toMatch(/\bcls-primary\b/);
  });
});
