import { describe, expect, it } from 'vitest';
import { zClasificacion } from './classification';

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
