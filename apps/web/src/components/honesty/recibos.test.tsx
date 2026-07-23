import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAX_RECIBOS, Recibos, type Recibo } from './recibos';

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

// T6.4.12 — a busy link streaming for an hour must not grow the DOM
// without bound: Recibos caps to MAX_RECIBOS rows regardless of how many
// receipts it's handed, keeping only the most recent ones, newest first —
// `receipts` is chronological (oldest -> newest, matching how a live
// subscriber would append incoming clicks onto an array over time).
describe('Recibos row-buffer cap (T6.4.12)', () => {
  it('caps to exactly MAX_RECIBOS rows, newest first, out of 5000 pushed receipts', () => {
    const many: Recibo[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `id-${i}`,
      t: `t-${i}`,
      src: 'directo' as const,
      cls: 'humano' as const,
      why: `why-${i}`,
    }));
    render(<Recibos slug="promo" receipts={many} />);

    const rows = screen.getAllByTestId('recibos-row');
    expect(rows).toHaveLength(MAX_RECIBOS);
    // Newest (last pushed, index 4999) first, oldest kept last.
    expect(rows[0]).toHaveTextContent('t-4999');
    expect(rows[rows.length - 1]).toHaveTextContent(`t-${5000 - MAX_RECIBOS}`);
  });

  it('does not truncate when under the cap', () => {
    render(<Recibos slug="promo" receipts={ROWS} />);
    expect(screen.getAllByTestId('recibos-row')).toHaveLength(ROWS.length);
  });
});

// T6.4.13 [security] — `why` is built from raw, attacker-controlled
// user-agent fragments captured at the edge. React already escapes text
// nodes by default (the first test below is a regression guard on that
// default, not new behaviour), but a hostile UA can still smuggle
// invisible control characters or zero-width joiners that corrupt the
// terminal layout without ever being visible in code review — that's the
// genuinely new part.
describe('Recibos why-string hardening (T6.4.13) [security]', () => {
  it('renders a hostile HTML payload as visible text with no img element in the DOM', () => {
    const { container } = render(
      <Recibos
        slug="promo"
        receipts={[
          {
            id: 'x',
            t: '00:00:00',
            src: 'directo',
            cls: 'bot',
            why: '<img src=x onerror=alert(1)>',
          },
        ]}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('strips control characters and zero-width joiners from why', () => {
    // Built from char codes, deliberately: embedding the literal invisible
    // characters directly in this file's source would recreate exactly
    // the "corrupts the layout without being visible in review" problem
    // this task exists to catch, in the one file meant to demonstrate
    // catching it. ZERO_WIDTH_JOINER (U+200D), a control char (BEL,
    // U+0007) and ZERO_WIDTH_SPACE (U+200B) sandwiched inside an
    // otherwise-ordinary UA fragment.
    const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);
    const BEL_CONTROL_CHAR = String.fromCharCode(0x07);
    const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
    const hostile = `python-requests${ZERO_WIDTH_JOINER}${BEL_CONTROL_CHAR}${ZERO_WIDTH_SPACE}/2.31`;

    render(
      <Recibos
        slug="promo"
        receipts={[{ id: 'y', t: '00:00:01', src: 'directo', cls: 'bot', why: hostile }]}
      />,
    );
    expect(screen.getByText('python-requests/2.31')).toBeInTheDocument();
  });

  it('never reaches for dangerouslySetInnerHTML (regression guard on the escaping default)', () => {
    const source = readFileSync(path.resolve(__dirname, 'recibos.tsx'), 'utf-8');
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
