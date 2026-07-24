import { describe, expect, it } from 'vitest';
import { CLASIFICACION_TOKEN, zClasificacion } from './classification';

// T6.4.1 — the classification vocabulary lives here so the UI and the
// events_classified SQL view (E4) cannot drift: both read the exact same
// four verdicts, in the same order the view's rule table (spec §7.1)
// resolves them.
describe('Clasificacion', () => {
  it('has exactly the four verdicts events_classified emits', () => {
    expect(zClasificacion.options).toEqual(['humano', 'bot', 'unfurler', 'prefetch']);
  });

  it('rejects a verdict the view does not emit', () => {
    expect(zClasificacion.safeParse('robot').success).toBe(false);
  });
});

// T6.4.2 — humano→primary, bot→error, unfurler→info, prefetch→warning
// (POSTA.md §1). A typed Record<Clasificacion, string> already makes
// forgetting a verdict a compile error; this test proves the SAME thing
// at runtime (so a future refactor that widens the type via `as` or
// similar can't silently drop a key) and that every value is a semantic
// TOKEN NAME, never a hex literal — a verdict's colour must come from
// _tokens.scss like everything else, not be hardcoded at the call site.
describe('CLASIFICACION_TOKEN', () => {
  it('is total over Clasificacion', () => {
    for (const verdict of zClasificacion.options) {
      expect(CLASIFICACION_TOKEN[verdict]).toBeDefined();
    }
    expect(Object.keys(CLASIFICACION_TOKEN).sort()).toEqual([...zClasificacion.options].sort());
  });

  it('maps each verdict to its DESIGN.md/POSTA.md token, never a hex literal', () => {
    expect(CLASIFICACION_TOKEN).toEqual({
      humano: 'primary',
      bot: 'error',
      unfurler: 'info',
      prefetch: 'warning',
    });
    for (const token of Object.values(CLASIFICACION_TOKEN)) {
      expect(token).not.toMatch(/^#/);
    }
  });
});
